/**
 * Where the cloud refresh token is kept, and how.
 *
 * This file exists to add ONE property to something server/cloud-client.js
 * was already doing: encryption at rest. Everything else - that there is one
 * file, that it lives under the cache root, that it holds a refresh token and
 * who we are, that logging out deletes it - is unchanged, and cloud-client.js
 * remains the only module in the codebase that reads or writes it.
 *
 * WHY A KEY FROM OUTSIDE, RATHER THAN OS CALLS IN HERE
 * ----------------------------------------------------
 * The OS keychains are reachable from Electron's main process (safeStorage:
 * DPAPI on Windows, the Keychain on macOS) and from nowhere else - not from a
 * plain `node server.js`, and not from the utility process this server runs
 * in. So the Electron host does the OS-backed part: it asks safeStorage to
 * protect a 32-byte data key once, at first launch, and hands that key to this
 * process at startup (SEDEMCEK_AUTH_KEY). Everything here is then ordinary
 * AES-256-GCM against a key it was given.
 *
 * The effect is the one that matters. On disk there is no readable refresh
 * token: the file is ciphertext, and the key that opens it is sealed by the
 * operating system to this user account on this machine. A copy of the file -
 * carried off by a backup, a folder sync, or somebody with the disk - is
 * inert. In memory the token is exactly as exposed as it always was, which is
 * unavoidable: this process has to spend it.
 *
 * NO KEY IS A SUPPORTED MODE, and it is how `npm start` and the test suite
 * run. With SEDEMCEK_AUTH_KEY unset the file is the plain JSON it has always
 * been, mode 0600, and nothing about a developer checkout changes. The
 * packaged application always has a key - see electron/secure-auth.js.
 *
 * READING IS FORMAT-BLIND, deliberately. An envelope is recognised by its own
 * shape, not by whether a key happens to be configured, so a laptop that is
 * launched once without the Electron host (a support session, a developer
 * poking at an installed app) reads an encrypted file as "no credential" and
 * shows a login screen, rather than crashing - and a file written plain by an
 * older build is still readable by the new one and is re-encrypted on the
 * next write.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { cacheDir } from './paths.js';

/** The one file. Same name and same place it has always had. */
export function authFile() {
  return path.join(cacheDir(), 'auth.json');
}

const ALG = 'aes-256-gcm';
const ENVELOPE_VERSION = 1;

/**
 * The data key, as 32 raw bytes, or null when there is none.
 *
 * Read per call rather than captured at import: the Electron host sets it
 * before this process starts, but a test that sets and unsets it around one
 * assertion must be obeyed immediately.
 */
function dataKey() {
  const hex = process.env.SEDEMCEK_AUTH_KEY;
  if (!hex) return null;
  let key;
  try {
    key = Buffer.from(String(hex).trim(), 'hex');
  } catch {
    return null;
  }
  // A wrong-length key is a configuration bug, and silently falling back to
  // plaintext would hide it behind a file that still works.
  if (key.length !== 32) {
    throw new Error('SEDEMCEK_AUTH_KEY must be 32 bytes of hex (64 characters)');
  }
  return key;
}

/** Is this object one of our envelopes rather than a plain auth document? */
function isEnvelope(raw) {
  return Boolean(raw && raw.v === ENVELOPE_VERSION && raw.alg === ALG && typeof raw.data === 'string');
}

function seal(auth, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(auth), 'utf8'), cipher.final()]);
  return {
    v: ENVELOPE_VERSION,
    alg: ALG,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function open(envelope, key) {
  const decipher = crypto.createDecipheriv(ALG, key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * The persisted auth document, or null for "nobody is logged in on this
 * laptop".
 *
 * NEVER THROWS. Every way this can fail - no file, a hand-edit gone wrong, an
 * envelope this machine has no key for, a key that does not open it - means
 * the same thing to every caller: there is no usable credential, so show a
 * login screen. A refresh token is not worth crashing an application over,
 * and the recovery is always the same one click.
 *
 * @returns {object|null}
 */
export function readAuth() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(authFile(), 'utf8'));
  } catch {
    return null; // no file, or unreadable: simply logged out
  }

  if (isEnvelope(raw)) {
    let key;
    try {
      key = dataKey();
    } catch {
      return null;
    }
    if (!key) return null; // encrypted, and this process has no key for it
    try {
      raw = open(raw, key);
    } catch {
      // Wrong key, or a tampered file. Both are "not a credential we can use".
      return null;
    }
  }

  if (raw && typeof raw.refreshToken === 'string' && raw.refreshToken) return raw;
  return null;
}

/**
 * Persist the auth document, encrypted when there is a key.
 *
 * Written to a temporary name and renamed, so a crash mid-write can never
 * leave half an envelope where a credential used to be. The 0600 mode is kept
 * from the plaintext era and still matters: it is the only protection the
 * developer checkout has, and it costs nothing in the packaged app.
 */
export function writeAuth(auth) {
  const file = authFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = dataKey();
  const payload = key ? seal(auth, key) : auth;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  // renameSync does not carry the mode on every platform; set it again on the
  // real path. A refresh token readable by every account on a shared laptop
  // is a login nobody performed.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows ACLs do not map onto POSIX modes; the file is still in the user profile */
  }
}

/** Forget the credential. Touches nothing else. */
export function clearAuth() {
  try {
    fs.rmSync(authFile(), { force: true });
  } catch {
    /* nothing to remove */
  }
}

/**
 * How the credential on this laptop is being protected, for the diagnostics
 * screen and for the packaging tests. Never the credential itself, and never
 * the key.
 *
 * @returns {{present:boolean, encrypted:boolean, method:'os-sealed-key'|'file-permissions'}}
 */
export function describe() {
  let encrypted = false;
  let present = false;
  try {
    const raw = JSON.parse(fs.readFileSync(authFile(), 'utf8'));
    present = true;
    encrypted = isEnvelope(raw);
  } catch {
    present = false;
  }
  let keyed = false;
  try {
    keyed = Boolean(dataKey());
  } catch {
    keyed = false;
  }
  return { present, encrypted, method: keyed ? 'os-sealed-key' : 'file-permissions' };
}
