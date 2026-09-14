/**
 * Desktop logs: userData/logs/sevenai.log, rotated, never holding a secret.
 *
 * A coworker's laptop has no terminal, so this file is the ONLY place a
 * server-side warning ever goes. Both the main process and the server's
 * stdout/stderr are written here.
 *
 * ROTATION is size-based and deliberately dumb: past MAX_BYTES the current
 * file becomes .1, .1 becomes .2, and anything past KEEP is deleted. At 5 MB x
 * 4 files the logs can never take more than ~20 MB of someone's disk.
 *
 * REDACTION is a second line of defence, not the first. The server already
 * never logs a credential (see server/cloud-client.js and
 * server/provider-lease.js). This catches the shapes a credential has anyway -
 * provider key prefixes, bearer headers, JWTs, JSON token fields - so a
 * third-party library's debug line cannot put one on disk.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MAX_BYTES = 5 * 1024 * 1024;
export const KEEP = 3;

const REDACTIONS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-[redacted]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, 'sk-[redacted]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt-redacted]'],
  [/("?(?:refresh_?token|access_?token|password|api_?key|secret|authorization)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[redacted]"'],
  [/(SEDEMCEK_AUTH_KEY=)[0-9a-f]+/gi, '$1[redacted]'],
];

export function redact(text) {
  let out = String(text);
  for (const [re, repl] of REDACTIONS) out = out.replace(re, repl);
  return out;
}

export function rotate(file, keep = KEEP) {
  for (let i = keep; i >= 1; i--) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    const to = `${file}.${i}`;
    try {
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch {
      /* a locked file on Windows: carry on writing to the current one */
    }
  }
}

/**
 * @param {{dir:string, name?:string, maxBytes?:number, keep?:number, echo?:boolean}} opts
 */
export function createLogger({ dir, name = 'sevenai', maxBytes = MAX_BYTES, keep = KEEP, echo = false }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.log`);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }
  if (size > maxBytes) {
    rotate(file, keep);
    size = 0;
  }

  function write(level, source, message) {
    const lines = redact(message).split(/\r?\n/).filter((l) => l.length);
    if (!lines.length) return;
    const stamp = new Date().toISOString();
    const text = lines.map((l) => `${stamp} ${level.toUpperCase().padEnd(5)} [${source}] ${l}\n`).join('');
    if (echo) process.stdout.write(text);
    try {
      if (size + text.length > maxBytes) {
        rotate(file, keep);
        size = 0;
      }
      fs.appendFileSync(file, text);
      size += Buffer.byteLength(text);
    } catch {
      /* disk full or the folder vanished: logging must never take the app down */
    }
  }

  return {
    file,
    dir,
    info: (source, msg) => write('info', source, msg),
    warn: (source, msg) => write('warn', source, msg),
    error: (source, msg) => write('error', source, msg),
    /** A sink for a child process stream: buffers partial lines. */
    sink(source, level = 'info') {
      let pending = '';
      return (chunk) => {
        pending += chunk.toString('utf8');
        const parts = pending.split(/\r?\n/);
        pending = parts.pop();
        for (const line of parts) write(level, source, line);
      };
    },
  };
}
