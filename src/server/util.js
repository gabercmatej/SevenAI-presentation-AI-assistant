/**
 * Small shared server helpers: timed fetch, the sentence splitter, the
 * keep-alive agent, and a write-time backup. Deliberately light on
 * dependencies and easy to unit test.
 */
import { Agent, setGlobalDispatcher } from 'undici';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Node's global fetch() (undici under the hood) defaults to a ~4 s keep-alive
 * timeout on its connection pool. A live meeting has minutes of silence
 * between questions, so without this every single question pays a fresh
 * DNS + TLS handshake to api.openai.com / api.anthropic.com - measured at
 * roughly 1.1-1.3 s on a cold socket, versus near-zero once warm.
 *
 * setGlobalDispatcher() replaces the pool for the WHOLE process, so this one
 * call also covers the Anthropic SDK (server/llm.js): it uses the global
 * fetch by default (see node_modules/@anthropic-ai/sdk/internal/shims.mjs),
 * so it is warmed for free without that file needing to know this exists.
 *
 * Call once, at server startup, before the first outbound request.
 */
export function installKeepAliveAgent() {
  setGlobalDispatcher(
    new Agent({
      keepAliveTimeout: 45_000, // stay open through the gaps between questions
      keepAliveMaxTimeout: 70_000, // cap for a provider that sends a long Keep-Alive header
      connections: 8, // TTS + LLM + STT fallback can all be in flight around one question
    })
  );
}

/**
 * fetch() with a hard timeout. Always aborts; never leaves a socket hanging.
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Let callers pass their own signal too (e.g. a client disconnect).
  const external = options.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Abbreviations after which a period does NOT end a sentence (Slovenian + common). */
const ABBREVIATIONS = new Set([
  'npr', 'oz', 'tj', 'itd', 'ipd', 'dr', 'mag', 'prof', 'g', 'ga', 'št', 'str',
  'sl', 'angl', 'cca', 'd.o.o', 'd.d', 'tel', 'ur', 'op', 'gl', 'prim', 'sod',
  'mio', 'mrd', 'min', 'max', 'vs', 'ok',
]);

/**
 * Streaming sentence splitter.
 *
 * The LLM streams tokens; we want to hand a *complete sentence* to TTS as soon
 * as one exists, because that is what turns a 6 s wait into a 1.5 s one.
 *
 * Usage:
 *   const s = createSentenceSplitter();
 *   for (const chunk of tokens) for (const sentence of s.push(chunk)) send(sentence);
 *   for (const sentence of s.flush()) send(sentence);
 *
 * Rules:
 *  - split on . ! ? … : and ; when followed by whitespace or end of buffer
 *  - never split inside a decimal number (12.5) or a known abbreviation (npr.)
 *  - never emit a fragment shorter than MIN_LEN - merge it into the next one,
 *    so "Da." does not become its own TTS request
 *  - hard-split at MAX_LEN so a run-on sentence still starts speaking
 */
const MIN_LEN = 12;
const MAX_LEN = 260;

// The FIRST piece of an answer is allowed to be shorter than the rest. "Seveda."
// or "Dobro vprašanje." spoken on its own is not a stray fragment - it is how a
// person opens an answer, and sending it to TTS immediately is worth about a
// second of silence the room does not have to sit through. Six characters still
// excludes a bare "Da." / "Ne.", which do sound clipped alone.
const FIRST_MIN_LEN = 6;

export function createSentenceSplitter({ minLen = MIN_LEN, maxLen = MAX_LEN, firstMinLen = FIRST_MIN_LEN } = {}) {
  let buffer = '';
  let emitted = 0;

  /** Is the character at index i a real sentence terminator? */
  function isBoundary(text, i) {
    const ch = text[i];
    if (!'.!?…:;'.includes(ch)) return false;

    const next = text[i + 1];
    // Must be followed by whitespace or be the very end of the buffer.
    if (next !== undefined && !/\s/.test(next)) return false;

    if (ch === '.') {
      // Decimal number: 12.5  (digit before AND after the dot)
      if (/\d/.test(text[i - 1] || '') && /\d/.test(next || '')) return false;
      // Known abbreviation: take the word immediately before the dot.
      const before = text.slice(0, i);
      const word = (before.match(/([\p{L}.]+)$/u) || [, ''])[1].toLowerCase();
      if (ABBREVIATIONS.has(word)) return false;
      // Single letter followed by a dot is almost always an initial (J. Novak).
      if (/^\p{L}$/u.test(word)) return false;
    }
    return true;
  }

  /** Pull every complete sentence currently sitting in the buffer. */
  function drain(force) {
    const out = [];
    let searchFrom = 0;

    for (;;) {
      // Only the very first piece of the answer gets the shorter minimum.
      const floor = emitted + out.length === 0 ? Math.min(firstMinLen, minLen) : minLen;
      let cut = -1;
      for (let i = searchFrom; i < buffer.length; i++) {
        if (isBoundary(buffer, i)) {
          // Consume any run of terminators and closing quotes/brackets.
          let end = i + 1;
          while (end < buffer.length && /["'”’)\]}.!?…]/.test(buffer[end])) end++;
          const candidate = buffer.slice(0, end).trim();
          if (candidate.length < floor) {
            // Too short on its own - keep scanning for a later boundary.
            searchFrom = end;
            i = end - 1;
            continue;
          }
          cut = end;
          break;
        }
      }

      if (cut === -1) {
        // No boundary. Hard-split an over-long buffer at the last space.
        if (buffer.length > maxLen) {
          let sp = buffer.lastIndexOf(' ', maxLen);
          if (sp < minLen) sp = maxLen;
          const piece = buffer.slice(0, sp).trim();
          buffer = buffer.slice(sp).trimStart();
          if (piece) out.push(piece);
          searchFrom = 0;
          continue;
        }
        break;
      }

      const piece = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut).trimStart();
      searchFrom = 0;
      if (piece) out.push(piece);
    }

    if (force) {
      const rest = buffer.trim();
      buffer = '';
      if (rest) {
        // A tiny trailing fragment is appended to the previous sentence rather
        // than becoming its own (very short) TTS request.
        if (rest.length < minLen && out.length) out[out.length - 1] += ' ' + rest;
        else out.push(rest);
      }
    }
    return out;
  }

  return {
    /** @param {string} chunk @returns {string[]} complete sentences */
    push(chunk) {
      buffer += chunk;
      const out = drain(false);
      emitted += out.length;
      return out;
    },
    /** @returns {string[]} whatever is left */
    flush() {
      const out = drain(true);
      emitted += out.length;
      return out;
    },
    get pending() {
      return buffer;
    },
  };
}

/** Convenience: split a whole string at once. */
export function splitIntoSentences(text, opts) {
  const s = createSentenceSplitter(opts);
  return [...s.push(text || ''), ...s.flush()];
}

/**
 * Copy `filePath` into `backupDir` before it gets overwritten, timestamped so
 * multiple backups of the same file never collide, then prune that file's own
 * backups down to `keep`.
 *
 * Why this is unconditional rather than a "nice to have": an editor bug once
 * saved a truncated answers list straight over presentations/<deck>/answers.json
 * with nothing anywhere to recover from - twelve hand-written answers, gone,
 * the night before a meeting. A file copy costs nothing; losing hand-edited
 * content the day before a client meeting costs a lot. Every write that can
 * destroy something a person typed now takes a backup FIRST, no exceptions.
 *
 * A no-op - not an error - when there is nothing to back up yet (the very
 * first write for a deck creates the file, so there is nothing worth saving a
 * copy of).
 *
 * @param {string} filePath the file about to be overwritten
 * @param {string} backupDir directory to hold backups of this file (created if missing)
 * @param {number} [keep] how many backups of THIS file to retain; older ones are deleted
 * @returns {string|null} the backup's path, or null if there was nothing to back up
 */
export function backupBeforeWrite(filePath, backupDir, keep = 20) {
  if (!fs.existsSync(filePath)) return null;

  fs.mkdirSync(backupDir, { recursive: true });
  const base = path.basename(filePath);
  // Colons are not valid in a Windows filename, hence the replace - this app
  // runs on the presentation laptop, which is Windows.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${base}.${stamp}.bak`);
  fs.copyFileSync(filePath, backupPath);

  // Prune to the newest `keep`. The ISO stamp sorts lexicographically the same
  // way it sorts chronologically, so a plain name sort is enough - no need to
  // stat() every file just to find the oldest ones.
  const prefix = `${base}.`;
  const existing = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.bak'))
    .sort();
  for (let i = 0; i < existing.length - keep; i++) {
    try {
      fs.unlinkSync(path.join(backupDir, existing[i]));
    } catch {
      /* another process may have already removed it - never let cleanup fail the write */
    }
  }

  return backupPath;
}
