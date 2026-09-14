/**
 * Desktop build hardening: no debugging port in a production launch, and the
 * SevenAI icon actually wired into every packaged artifact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { refusedDebugSwitch, E2E_TEST_ENV } from '../electron/config.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel));

// ------------------------------------------------------------- debugging ----

test('a production launch refuses DevTools and inspector switches', () => {
  for (const argv of [
    ['SevenAI.exe', '--remote-debugging-port=9222'],
    ['SevenAI.exe', '--remote-debugging-port', '9222'],
    ['SevenAI.exe', '--remote-debugging-pipe'],
    ['SevenAI.exe', '--inspect=9229'],
    ['SevenAI.exe', '--inspect-brk'],
  ]) {
    assert.ok(refusedDebugSwitch({ packaged: true, argv, env: {} }), argv.join(' '));
  }
});

test('a normal production launch, development, and the E2E driver are allowed', () => {
  assert.equal(refusedDebugSwitch({ packaged: true, argv: ['SevenAI.exe'], env: {} }), null);
  assert.equal(refusedDebugSwitch({ packaged: true, argv: ['SevenAI.exe', '--remote-debugging-portal'], env: {} }), null, 'no prefix matching');
  assert.equal(refusedDebugSwitch({ packaged: false, argv: ['electron', '--remote-debugging-port=9222'], env: {} }), null);
  assert.equal(refusedDebugSwitch({ packaged: true, argv: ['SevenAI.exe', '--remote-debugging-port=9339'], env: { [E2E_TEST_ENV]: '1' } }), null);
  assert.ok(refusedDebugSwitch({ packaged: true, argv: ['SevenAI.exe', '--remote-debugging-port=9339'], env: { [E2E_TEST_ENV]: 'true' } }), 'only the exact opt-in value');
});

test('main.js refuses before the single-instance lock, the server or the window exist', () => {
  const src = read('electron/main.js').toString();
  const refuse = src.indexOf('refusedDebugSwitch({');
  assert.ok(refuse > 0);
  assert.ok(refuse < src.indexOf('requestSingleInstanceLock'));
  assert.ok(refuse < src.indexOf('async function start()'));
});

test('the packaged-app E2E driver opts in explicitly', () => {
  assert.match(read('scripts/verify-desktop-packaged.js').toString(), /SEVENAI_E2E_TEST: '1'/);
});

// ----------------------------------------------------------------- icons ----

const pkg = JSON.parse(read('package.json'));

test('electron-builder uses the SevenAI icon for the app, installer, uninstaller and DMG', () => {
  const b = pkg.build;
  assert.equal(b.directories.buildResources, 'build');
  assert.equal(b.win.icon, 'build/icon.ico');
  assert.equal(b.nsis.installerIcon, 'build/icon.ico');
  assert.equal(b.nsis.uninstallerIcon, 'build/icon.ico');
  assert.equal(b.nsis.installerHeaderIcon, 'build/icon.ico');
  assert.equal(b.mac.icon, 'build/icon.icns');
  assert.equal(b.dmg.icon, 'build/icon.icns');
});

test('build/icon.ico is a real multi-size icon with a 256px image', () => {
  const ico = read('build/icon.ico');
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, 'type 1 = icon');
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    sizes.push(ico.readUInt8(o) || 256);
    const len = ico.readUInt32LE(o + 8);
    const at = ico.readUInt32LE(o + 12);
    assert.ok(at + len <= ico.length, 'entry inside the file');
    assert.equal(ico.subarray(at, at + 8).toString('hex'), '89504e470d0a1a0a', 'PNG entry');
  }
  for (const s of [16, 32, 48, 256]) assert.ok(sizes.includes(s), `has ${s}px`);
});

test('build/icon.icns is a well-formed icon family up to 1024px', () => {
  const icns = read('build/icon.icns');
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const types = [];
  for (let o = 8; o < icns.length; ) {
    types.push(icns.subarray(o, o + 4).toString('ascii'));
    const len = icns.readUInt32BE(o + 4);
    assert.ok(len > 8);
    o += len;
  }
  for (const t of ['ic07', 'ic08', 'ic09', 'ic10']) assert.ok(types.includes(t), `has ${t}`);
});

test('icons are generated from the supplied source, not drawn', () => {
  const png = (rel) => {
    const b = read(rel);
    assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', rel);
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  };
  const [w, h] = png('build/icon-source.png');
  assert.ok(w === h && w >= 1024, 'source is square and at least 1024px');
  assert.deepEqual(png('build/icon.png'), [1024, 1024]);
  assert.deepEqual(png('electron/assets/icon.png'), [256, 256]);
});
