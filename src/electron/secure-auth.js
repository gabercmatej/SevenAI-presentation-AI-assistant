/**
 * The OS-backed half of "the refresh token is encrypted at rest".
 *
 * Electron's safeStorage seals data to the current OS user: DPAPI on Windows,
 * a Keychain-held key on macOS. It exists only in the main process, and the
 * server runs in a utility process, so this module seals ONE thing - a random
 * 32-byte data key - and the main process hands that key to the server at
 * startup. server/auth-store.js encrypts auth.json with it (AES-256-GCM).
 *
 *   userData/secure/auth-key.bin    the data key, sealed by safeStorage
 *   userData/cache/auth.json        the refresh token, sealed by the data key
 *
 * Neither file is useful without the OS account that created the first one.
 *
 * FAILURE MODES, AND WHY EACH ONE ENDS AT A LOGIN SCREEN RATHER THAN A CRASH
 *   - no key file yet (first launch): create one.
 *   - the key file cannot be unsealed (the profile was copied to another
 *     machine, the OS credential store was reset): replace it. The old
 *     auth.json can no longer be opened, server/auth-store.js reads that as
 *     "logged out", and the presenter logs in once. Nothing else - no
 *     presentation, no Session - depends on this key.
 *   - safeStorage unavailable (only realistic on Linux without a keyring;
 *     never on the Windows and macOS builds this app ships): return null and
 *     log it loudly. The caller decides - see main.js.
 *
 * No `electron` import: safeStorage is injected so tests can run this in node.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const KEY_FILE = 'auth-key.bin';

/**
 * @param {{safeStorage:{isEncryptionAvailable():boolean, encryptString(s:string):Buffer, decryptString(b:Buffer):string},
 *          secureDir:string, log?:(level:string, msg:string)=>void}} opts
 * @returns {string|null} 64 hex characters, or null when the OS cannot protect a key
 */
export function loadOrCreateAuthKey({ safeStorage, secureDir, log = () => {} }) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    log('error', 'OS secure storage is not available - the refresh token cannot be encrypted at rest');
    return null;
  }

  const file = path.join(secureDir, KEY_FILE);
  try {
    const hex = safeStorage.decryptString(fs.readFileSync(file));
    if (/^[0-9a-f]{64}$/.test(hex)) return hex;
    log('warn', 'auth key file did not contain a usable key - replacing it (login will be required once)');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log('warn', `auth key could not be unsealed (${err.code || 'decrypt_failed'}) - replacing it (login will be required once)`);
    }
  }

  const hex = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(secureDir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, safeStorage.encryptString(hex), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return hex;
}

/** What is protecting the key on this platform, for logs and the report. */
export function protectionName(platform = process.platform) {
  if (platform === 'win32') return 'Windows DPAPI (Electron safeStorage)';
  if (platform === 'darwin') return 'macOS Keychain (Electron safeStorage)';
  return 'Electron safeStorage';
}
