/**
 * TTS provider chain.
 *
 * Order: TTS_PRIMARY first if it is configured, then the remaining CONFIGURED
 * providers in preference order, then the unconfigured ones (which fail
 * instantly and cost nothing). That last detail matters right now: TTS_PRIMARY
 * may still say `google` from an earlier plan while Google has no credentials,
 * and the room must not hear a delay because of it.
 *
 * Each provider gets its own timeout; a failure moves to the next one. If every
 * provider fails the caller returns 503 and the browser falls back to
 * speechSynthesis - ugly, but the mascot always speaks.
 */
import * as google from './google.js';
import * as azure from './azure.js';
import * as openai from './openai.js';

const PROVIDERS = { google, azure, openai };
const PREFERENCE = ['google', 'azure', 'openai'];

/**
 * Speaking-rate multiplier window. One definition, shared by every caller that
 * can set a speed: /api/tts's request body AND a presentation's saved
 * `settings.speakingSpeed` (server/presentations.js, normalizeSettings) both
 * clamp through here, so a value good enough to save to disk is always good
 * enough to actually speak, and the two can never quietly disagree.
 *
 * Below 0.5 a sentence takes so long the room starts talking over him; above
 * 2.5 the provider's time-stretch stops sounding like speech at all - both
 * ends are a bug report, not a legitimate preference. 1.0 is a provider's own
 * pace (read as slow for a live meeting); TTS_SPEED defaults to 1.5 (see
 * server/tts/openai.js) for exactly that reason.
 */
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2.5;

/** @param {number} n @returns {number} n forced into [SPEED_MIN, SPEED_MAX] */
export function clampSpeed(n) {
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
}

/** @returns {string[]} provider ids in the order they will be tried */
export function providerOrder(preferred) {
  const first = preferred || process.env.TTS_PRIMARY || '';
  const ranked = [];

  if (PROVIDERS[first] && PROVIDERS[first].isConfigured()) ranked.push(first);
  for (const p of PREFERENCE) {
    if (!ranked.includes(p) && PROVIDERS[p].isConfigured()) ranked.push(p);
  }
  // Unconfigured providers stay in the list so /voice-test and /api/health can
  // show them, but they can never delay a real answer.
  for (const p of PREFERENCE) if (!ranked.includes(p)) ranked.push(p);
  return ranked;
}

/** @returns {Array<{id:string,configured:boolean,voice:string,language:string}>} */
export function describeAll() {
  return providerOrder().map((p) => PROVIDERS[p].describe());
}

/** @returns {boolean} true if at least one provider has credentials */
export function anyConfigured() {
  return PREFERENCE.some((p) => PROVIDERS[p].isConfigured());
}

/** @returns {string|null} the provider a sentence would be sent to right now */
export function activeProvider() {
  return providerOrder().find((p) => PROVIDERS[p].isConfigured()) || null;
}

/**
 * THE production voice: the one provider and the one voice a normal, successful
 * answer is spoken in. Everything else in this file is a fallback.
 *
 * TTS_VOICE overrides the provider's own *_TTS_VOICE, but only for the
 * production provider - voice names are provider-specific, so applying one
 * globally would break the fallbacks it was meant to protect.
 *
 * @returns {{provider:string|null, voice:string|null, pinned:boolean}}
 */
export function productionVoice() {
  const provider = activeProvider();
  if (!provider) return { provider: null, voice: null, pinned: false };
  const override = process.env.TTS_VOICE || '';
  return {
    provider,
    voice: override || PROVIDERS[provider].describe().voice,
    pinned: Boolean(override),
  };
}

/** The voice a given provider should use, honouring TTS_VOICE for the primary. */
function voiceFor(pid, explicit) {
  if (explicit) return explicit;
  if (process.env.TTS_VOICE && pid === activeProvider()) return process.env.TTS_VOICE;
  return undefined; // the adapter falls back to its own env var
}

/**
 * Synthesize text, walking the provider chain.
 *
 * @param {string} text
 * @param {{provider?:string, voice?:string, timeoutMs?:number, signal?:AbortSignal, speed?:number}} opts
 *   `speed` is passed straight through to whichever adapter answers - already
 *   clamped by the caller (server.js /api/tts, via clampSpeed above). Leave it
 *   undefined to get that adapter's own default (TTS_SPEED for openai/google -
 *   see server/tts/openai.js).
 * @returns {Promise<{buffer:Buffer, contentType:string, provider:string, voice:string, attempts:Array}>}
 */
export async function synthesize(text, { provider, voice, timeoutMs, signal, speed } = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('tts_empty_text');

  const perProviderTimeout = Number(timeoutMs || process.env.TTS_TIMEOUT_MS || 6000);
  const attempts = [];

  // An explicit provider means "only this one" (used by /voice-test).
  const order = provider ? [provider] : providerOrder();

  for (const pid of order) {
    const mod = PROVIDERS[pid];
    if (!mod) continue;
    if (!mod.isConfigured()) {
      attempts.push({ provider: pid, ok: false, error: 'not_configured' });
      continue;
    }
    const startedAt = Date.now();
    try {
      const result = await mod.synthesize(clean, {
        timeoutMs: perProviderTimeout,
        signal,
        voice: voiceFor(pid, voice),
        speed,
      });
      attempts.push({ provider: pid, ok: true, ms: Date.now() - startedAt });
      return { ...result, attempts };
    } catch (err) {
      // err.message never contains a key - the adapters only surface status codes.
      attempts.push({
        provider: pid,
        ok: false,
        ms: Date.now() - startedAt,
        error: err.name === 'AbortError' ? 'timeout' : err.message,
      });
      if (signal?.aborted) break;
    }
  }

  const error = new Error('tts_all_providers_failed');
  error.attempts = attempts;
  throw error;
}

/**
 * Same chain as synthesize(), but for providers that can hand back a live
 * stream instead of a finished buffer - today that is openai only. Google and
 * Azure have no `synthesizeStream` export, so they are skipped here (not
 * retried as a failure) rather than counted against the chain; /api/tts falls
 * back to the whole-file synthesize() above when this throws.
 *
 * @param {string} text
 * @param {{provider?:string, voice?:string, timeoutMs?:number, signal?:AbortSignal, speed?:number}} opts
 *   `speed`: see synthesize() above - same clamped value, same fallback rule.
 * @returns {Promise<{stream:ReadableStream, contentType:string, provider:string, voice:string, attempts:Array}>}
 */
export async function synthesizeStream(text, { provider, voice, timeoutMs, signal, speed } = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('tts_empty_text');

  const perProviderTimeout = Number(timeoutMs || process.env.TTS_TIMEOUT_MS || 6000);
  const attempts = [];
  const order = provider ? [provider] : providerOrder();

  for (const pid of order) {
    const mod = PROVIDERS[pid];
    if (!mod?.synthesizeStream) {
      attempts.push({ provider: pid, ok: false, error: 'no_streaming_support' });
      continue;
    }
    if (!mod.isConfigured()) {
      attempts.push({ provider: pid, ok: false, error: 'not_configured' });
      continue;
    }
    const startedAt = Date.now();
    try {
      const result = await mod.synthesizeStream(clean, {
        timeoutMs: perProviderTimeout,
        signal,
        voice: voiceFor(pid, voice),
        speed,
      });
      attempts.push({ provider: pid, ok: true, ms: Date.now() - startedAt });
      return { ...result, attempts };
    } catch (err) {
      attempts.push({
        provider: pid,
        ok: false,
        ms: Date.now() - startedAt,
        error: err.name === 'AbortError' ? 'timeout' : err.message,
      });
      if (signal?.aborted) break;
    }
  }

  const error = new Error('tts_stream_unavailable');
  error.attempts = attempts;
  throw error;
}
