/**
 * server/cache-gc.js - pruning old presentation versions and orphan blobs out
 * of the cache described in docs/CLOUD-ARCHITECTURE.md §7.
 *
 * Built entirely on top of presentation-store.js's own download()/
 * materialize()/setActive() (with a fake fetchBlob, no network), pointed at a
 * temp SEDEMCEK_CACHE_DIR removed in test.after() - the same pattern
 * tests/presentation-store.test.js uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import * as store from '../server/presentation-store.js';
import * as gc from '../server/cache-gc.js';

const CACHE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sedemcek-gc-test-'));
process.env.SEDEMCEK_CACHE_DIR = CACHE_ROOT;

test.after(() => {
  delete process.env.SEDEMCEK_CACHE_DIR;
  fs.rmSync(CACHE_ROOT, { recursive: true, force: true });
});

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function freshId(prefix) {
  return `${prefix}${crypto.randomBytes(3).toString('hex')}`;
}

/** Download + materialize one version from a plain {relativePath: content} map. */
async function makeVersion(presentationId, version, files) {
  const manifest = [];
  const bufBySha = new Map();
  for (const [p, content] of Object.entries(files)) {
    const buf = Buffer.from(content);
    const sha = sha256(buf);
    manifest.push({ path: p, sha256: sha, bytes: buf.length });
    bufBySha.set(sha, buf);
  }
  const fetchBlob = async (entry) => bufBySha.get(entry.sha256);
  await store.download(presentationId, version, manifest, { fetchBlob });
  return store.materialize(presentationId, version, {
    config: { version },
    slides: { slides: [] },
    timeline: null,
    answers: { answers: [] },
    knowledge: {},
    manifest,
  });
}

test('prune keeps the newest N versions and never removes the active one, even when the active one is the oldest', async () => {
  const id = freshId('keep');
  await makeVersion(id, 1, { 'media/deck.mp4': 'v1 deck bytes' });
  await makeVersion(id, 2, { 'media/deck.mp4': 'v2 deck bytes' });
  await makeVersion(id, 3, { 'media/deck.mp4': 'v3 deck bytes' });
  store.setActive(id, 1); // deliberately the oldest, to prove active beats "newest N"

  const res = gc.prune({ keepVersionsPerPresentation: 1 });

  const { presentationsDir } = store.cachePaths();
  const remaining = fs
    .readdirSync(path.join(presentationsDir, id))
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .sort();
  assert.deepEqual(remaining, [1, 3], 'v3 survives as newest-1, v1 survives because it is active, v2 is gone');
  assert.ok(res.removedVersions.some((r) => r.presentationId === id && r.version === 2));
  assert.ok(!res.removedVersions.some((r) => r.presentationId === id && r.version === 1), 'the active version is never in the removal list');
  assert.equal(store.activeVersion(id).version, 1, 'active.json itself is untouched');
});

test('orphan blobs are removed once no surviving version references them, but a blob a kept version still uses survives', async () => {
  const id = freshId('orphan');
  const shared = 'identical deck.mp4 bytes in every version';
  await makeVersion(id, 1, { 'media/deck.mp4': shared, 'slides/slide-01.jpg': 'only in v1' });
  await makeVersion(id, 2, { 'media/deck.mp4': shared, 'slides/slide-01.jpg': 'only in v2' });
  store.setActive(id, 2);

  const shaV1Only = sha256(Buffer.from('only in v1'));
  const shaShared = sha256(Buffer.from(shared));

  const res = gc.prune({ keepVersionsPerPresentation: 1 }); // keeps v2 (newest + active); v1 is removed entirely

  const { blobsDir } = store.cachePaths();
  assert.equal(fs.existsSync(path.join(blobsDir, shaV1Only)), false, 'a blob only v1 used is gone once v1 is pruned');
  assert.equal(fs.existsSync(path.join(blobsDir, shaShared)), true, 'the blob v2 still uses must survive');
  assert.ok(res.removedBlobs.includes(shaV1Only));
  assert.ok(!res.removedBlobs.includes(shaShared));
});

test('dryRun reports what would be removed without deleting anything', async () => {
  const id = freshId('dry');
  await makeVersion(id, 1, { 'media/deck.mp4': 'a' });
  await makeVersion(id, 2, { 'media/deck.mp4': 'b' });
  store.setActive(id, 2);

  const res = gc.prune({ keepVersionsPerPresentation: 1, dryRun: true });
  assert.equal(res.dryRun, true);
  assert.ok(res.removedVersions.some((r) => r.presentationId === id && r.version === 1));

  const { presentationsDir, blobsDir } = store.cachePaths();
  assert.ok(fs.existsSync(path.join(presentationsDir, id, '1')), 'dryRun must not actually delete the version directory');
  assert.ok(fs.existsSync(path.join(blobsDir, sha256(Buffer.from('a')))), 'dryRun must not actually delete its blob either');
});

test('a presentation with no active.json still keeps its newest N versions', async () => {
  const id = freshId('noactive');
  await makeVersion(id, 1, { 'media/deck.mp4': 'a' });
  await makeVersion(id, 2, { 'media/deck.mp4': 'b' });
  // No setActive() call at all - materialize() alone never activates anything.

  gc.prune({ keepVersionsPerPresentation: 1 });

  const { presentationsDir } = store.cachePaths();
  const remaining = fs
    .readdirSync(path.join(presentationsDir, id))
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .sort();
  assert.deepEqual(remaining, [2]);
});

test('prune only ever touches cache/ - it has no code path to presentations/ or sessions/', () => {
  // Not a filesystem probe (those directories are shared with every other
  // test file); a structural guarantee instead: cache-gc.js never imports
  // server/paths.js, so PRESENTATIONS_DIR/SESSIONS_DIR are values it simply
  // cannot construct a path from.
  const src = fs.readFileSync(new URL('../server/cache-gc.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from ['"]\.\/paths\.js['"]/, 'cache-gc.js must not import paths.js');
});
