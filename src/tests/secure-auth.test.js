/**
 * electron/secure-auth.js - the data key sealed by the OS.
 *
 * Electron's safeStorage is replaced by a stand-in with the same contract (a
 * reversible transform that is NOT the identity, so a test can tell sealed
 * bytes from plain ones). What is under test is this module's handling of
 * the key file, not DPAPI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadOrCreateAuthKey, KEY_FILE } from '../electron/secure-auth.js';

const MAGIC = Buffer.from('SEALED:');
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.concat([MAGIC, Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)]),
  decryptString: (buf) => {
    if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('decrypt_failed');
    return Buffer.from(buf.subarray(MAGIC.length).map((b) => b ^ 0x5a)).toString('utf8');
  },
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sevenai-secure-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('first launch creates a key, sealed, and later launches get the same key back', () => {
  const dir = tmpDir();
  const first = loadOrCreateAuthKey({ safeStorage: fakeSafeStorage(), secureDir: dir });
  assert.match(first, /^[0-9a-f]{64}$/);
  const onDisk = fs.readFileSync(path.join(dir, KEY_FILE));
  assert.equal(onDisk.includes(Buffer.from(first)), false, 'the key must not be stored in the clear');
  assert.equal(loadOrCreateAuthKey({ safeStorage: fakeSafeStorage(), secureDir: dir }), first);
});

test('a key file this OS account cannot unseal is replaced, which means one fresh login', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, KEY_FILE), 'sealed on some other machine');
  const logs = [];
  const key = loadOrCreateAuthKey({ safeStorage: fakeSafeStorage(), secureDir: dir, log: (l, m) => logs.push([l, m]) });
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(logs.some(([level]) => level === 'warn'));
  assert.equal(loadOrCreateAuthKey({ safeStorage: fakeSafeStorage(), secureDir: dir }), key);
});

test('no OS secure storage means no key - never an unsealed one', () => {
  const dir = tmpDir();
  const logs = [];
  assert.equal(loadOrCreateAuthKey({ safeStorage: fakeSafeStorage(false), secureDir: dir, log: (l, m) => logs.push([l, m]) }), null);
  assert.equal(fs.existsSync(path.join(dir, KEY_FILE)), false);
  assert.ok(logs.some(([level]) => level === 'error'));
});
