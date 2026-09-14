/**
 * The presentation VERSION cache. See docs/CLOUD-ARCHITECTURE.md §7.
 *
 * A presentation used to be one folder, presentations/<id>/. It is now a
 * sequence of immutable, content-addressed VERSIONS, and the folder that
 * `server/presentations.js`, `server/knowledge.js`, `server/cache.js` and the
 * `/media` route read from is resolved HERE, once, by dirFor(). None of those
 * modules learn anything about versions, downloads, or the cloud - they keep
 * reading "a folder", exactly as before. That is the entire point of this
 * module existing separately rather than being folded into presentations.js.
 *
 *   cache/
 *     presentations/<id>/<version>/     an exact reproduction of what
 *                                        presentations/<id>/ looks like today
 *     presentations/<id>/active.json    { version, verifiedAt }
 *     blobs/<sha256>                    downloaded bytes, shared across
 *                                        versions and across presentations
 *
 * THIS MODULE HAS NO NETWORK CODE. download() takes an injected `fetchBlob`
 * function and never imports fetch, http, or any provider SDK. That is what
 * makes tests/presentation-store.test.js run with zero network and what lets
 * a future cloud-sync module be the only place that knows how to reach R2.
 *
 * THE LOCAL-RESILIENCE GUARANTEE (§12 of the architecture doc)
 * --------------------------------------------------------------
 * dirFor() falls back to presentations/<id>/ (via PRESENTATIONS_DIR) when
 * nothing is cached yet. This is NOT a migration shim to delete once the
 * cloud path is "done" - it is the reason a laptop that has never talked to
 * the cloud, or whose cache/ was wiped, can still run a presentation from the
 * folder that shipped with it. Deleting that fallback deletes the guarantee.
 *
 * ATOMICITY
 * ---------
 * materialize() builds a version into `<version>.part/` and only makes it
 * visible as `<version>/` with a directory rename - the same `.tmp` + rename
 * discipline `writeJsonAtomic` uses for a single file, one level up. A reader
 * (dirFor, activeVersion) can therefore never observe a half-written version:
 * either `<version>/` does not exist yet, or it is complete. See materialize()
 * for why a plain `fs.renameSync(part, final)` is not quite enough on Windows
 * when `final` already exists.
 *
 * WHY SIZE, NOT A RE-HASH, GATES EVERY ORDINARY CHECK
 * ----------------------------------------------------
 * verify() only compares byte counts against what is on disk in blobs/. A
 * sha256 is computed exactly once per blob, at the end of its download in
 * download() - never again. Re-hashing a 400 MB cache on every pre-flight
 * would add real seconds in front of a client meeting for content that
 * cannot change under a content-addressed name (§6: the hash IS the object
 * key). A truncated or corrupted file the wrong SIZE is still caught; a file
 * corrupted to the exact same size as the original is not - an acceptable
 * trade given the object is immutable and was hash-verified once already.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { presentationsDir, cacheDir } from './paths.js';

// Mirrors presentations.js's isValidId. Deliberately duplicated rather than
// imported: presentations.js is meant to import FROM this module (see the
// wiring note at the bottom of docs/CLOUD-ARCHITECTURE.md §7), so importing
// the other way would create a cycle. It is eleven characters of regex, not
// worth a shared module.
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function assertValidId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id) || id.includes('..')) {
    const err = new Error('invalid_presentation_id');
    err.code = 'invalid_presentation_id';
    throw err;
  }
  return id;
}

/** @returns {string} a clean decimal version string, never anything path-shaped */
function assertValidVersion(version) {
  const n = Number(version);
  if (!Number.isInteger(n) || n <= 0) {
    const err = new Error('invalid_version');
    err.code = 'invalid_version';
    throw err;
  }
  return String(n);
}

/**
 * A manifest `path` and a knowledge-file NAME both arrive from the cloud, not
 * from anything typed on this laptop - so both are checked before they touch
 * the filesystem, the same way `mergeSettingsUpdate` in presentations.js
 * never trusts a `preview` path outside `/media/<id>/`.
 */
function isSafeFilename(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200 && !/[\\/]/.test(name) && name !== '.' && name !== '..';
}

function isSafeRelativePath(p) {
  if (typeof p !== 'string' || !p) return false;
  const posix = p.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) return false;
  const normalized = path.posix.normalize(posix);
  return !normalized.startsWith('..') && normalized !== '.';
}

/**
 * Cache root, resolved fresh on every call rather than cached at import time.
 * That is what lets tests point SEDEMCEK_CACHE_DIR at a temp directory
 * without the module needing a reset/reload hook - the very first call after
 * `process.env.SEDEMCEK_CACHE_DIR = tmpDir` already sees it.
 *
 * @returns {{root:string, presentationsDir:string, blobsDir:string}}
 */
export function cachePaths() {
  const root = cacheDir();
  return {
    root,
    presentationsDir: path.join(root, 'presentations'),
    blobsDir: path.join(root, 'blobs'),
  };
}

function versionDir(presentationId, version) {
  return path.join(cachePaths().presentationsDir, presentationId, String(version));
}

function activeJsonPath(presentationId) {
  return path.join(cachePaths().presentationsDir, presentationId, 'active.json');
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------- resolution --

/**
 * What is currently active for this presentation.
 *
 * `source: 'cache'` means active.json points at a version directory that
 * really exists. `source: 'legacy'` means there is no cached version at all,
 * but presentations/<id>/ is there - the resilience fallback (see the module
 * comment) is what a caller would actually get from dirFor(). `null` means
 * neither exists: this id is not a real presentation on this laptop.
 *
 * @param {string} presentationId
 * @returns {{presentationId:string, version:number|null, verifiedAt:string|null, source:'cache'|'legacy'}|null}
 */
export function activeVersion(presentationId) {
  assertValidId(presentationId);
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(activeJsonPath(presentationId), 'utf8'));
  } catch {
    raw = null;
  }
  if (raw && Number.isInteger(Number(raw.version)) && Number(raw.version) > 0) {
    const v = Number(raw.version);
    if (fs.existsSync(versionDir(presentationId, v))) {
      return { presentationId, version: v, versionId: raw.versionId || null, verifiedAt: raw.verifiedAt || null, source: 'cache' };
    }
    // active.json points at a version directory that is no longer there
    // (hand-deleted, or pruned out from under it) - fall through exactly as
    // if there were no active.json at all, rather than lying about it.
  }
  if (fs.existsSync(path.join(presentationsDir(), presentationId))) {
    return { presentationId, version: null, versionId: null, verifiedAt: null, source: 'legacy' };
  }
  return null;
}

// ------------------------------------------------------------ runtime pins -
//
// AN OPEN DECK'S VERSION IS IMMUTABLE FOR AS LONG AS IT IS OPEN.
//
// active.json is "the newest version this laptop has verified" - the one the
// NEXT meeting starts from. It can move at any moment: a download finishing,
// or anybody calling POST /api/cloud/presentations/:id/cache on the loopback
// API. Before pins, moving it also moved every read of a deck that was
// already on screen - its video, its slides, its knowledge - underneath a
// running meeting. The dashboard never starts a download while a deck is
// open, but the local API could.
//
// So a running Session PINS the version it started on (in memory: a restart is
// a new runtime, and a pin must never outlive the process that took it).
// While pinned, dirFor()/runtimeVersion() keep answering with that version; a
// newer download is still verified and written to active.json - AVAILABLE -
// and takes over the moment the last holder lets go.

/** presentationId -> { version, versionId, holders:Set<string> } */
const runtimePins = new Map();

/**
 * Pin the version `holder` (a Session id) is running on.
 * The first holder decides the version; later holders of the same deck join
 * the existing pin - they are the same runtime. An authored deck with no
 * cached version has nothing immutable to pin, and pins nothing.
 *
 * @returns {{version:number, versionId:string|null}|null} the pinned version
 */
export function pinRuntime(presentationId, holder) {
  assertValidId(presentationId);
  const key = String(holder || '');
  if (!key) return null;
  const existing = runtimePins.get(presentationId);
  if (existing) {
    existing.holders.add(key);
    return { version: existing.version, versionId: existing.versionId };
  }
  const active = activeVersion(presentationId);
  if (!active || active.source !== 'cache') return null;
  runtimePins.set(presentationId, { version: active.version, versionId: active.versionId, holders: new Set([key]) });
  return { version: active.version, versionId: active.versionId };
}

/**
 * Release `holder`'s pin.
 * @returns {boolean} true when the deck is no longer pinned at all, so the
 *   caller knows a newer active version may now be read
 */
export function unpinRuntime(presentationId, holder) {
  if (!ID_RE.test(String(presentationId || ''))) return false;
  const pin = runtimePins.get(presentationId);
  if (!pin) return false;
  pin.holders.delete(String(holder || ''));
  if (pin.holders.size > 0) return false;
  runtimePins.delete(presentationId);
  return true;
}

/** Every pinned {presentationId, version} - for cache-gc.js, which must never remove one. */
export function runtimePinnedVersions() {
  return [...runtimePins].map(([presentationId, pin]) => ({ presentationId, version: pin.version }));
}

/**
 * The version this runtime should READ for `presentationId`: the pinned one
 * while a Session holds it (and it is still on disk), otherwise the active one.
 * Same shape as activeVersion(), plus `pinned`.
 */
export function runtimeVersion(presentationId) {
  assertValidId(presentationId);
  const pin = runtimePins.get(presentationId);
  if (pin && fs.existsSync(versionDir(presentationId, pin.version))) {
    return { presentationId, version: pin.version, versionId: pin.versionId, verifiedAt: null, source: 'cache', pinned: true };
  }
  const active = activeVersion(presentationId);
  return active ? { ...active, pinned: false } : null;
}

/**
 * The directory `server/presentations.js` should read `<id>` from.
 *
 * This is the one function the rest of the application needs to learn about.
 * See the module comment for why the legacy fallback is permanent, not a
 * migration step, and the runtime pins above for why it is not simply
 * active.json.
 *
 * @param {string} presentationId
 * @returns {string} absolute path
 */
export function dirFor(presentationId) {
  assertValidId(presentationId);
  const current = runtimeVersion(presentationId);
  if (current && current.source === 'cache') return versionDir(presentationId, current.version);
  return path.join(presentationsDir(), presentationId);
}

/**
 * Every presentation id the cache knows about, and the version directories
 * actually on disk for each - for the diagnostics/settings screen, and for
 * cache-gc.js. Legacy-only presentations (never cached) do not appear here;
 * ask dirFor()/activeVersion() about one id at a time for that.
 *
 * @returns {Array<{presentationId:string, versions:number[], active:object|null}>}
 */
export function listCached() {
  const { presentationsDir } = cachePaths();
  let ids = [];
  try {
    ids = fs
      .readdirSync(presentationsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return ids.map((id) => {
    const dir = path.join(presentationsDir, id);
    let versions = [];
    try {
      versions = fs
        .readdirSync(dir, { withFileTypes: true })
        // Only real, finished version directories - never a stray "<n>.part"
        // left by an interrupted materialize().
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
        .map((e) => Number(e.name))
        .sort((a, b) => a - b);
    } catch {
      versions = [];
    }
    let active = null;
    try {
      active = JSON.parse(fs.readFileSync(path.join(dir, 'active.json'), 'utf8'));
    } catch {
      active = null;
    }
    return { presentationId: id, versions, active };
  });
}

// ------------------------------------------------------------- verification -

/**
 * Pre-flight check: for each manifest entry, does blobs/<sha256> exist with
 * the right size? See the module comment for why this is size-only.
 *
 * @param {string} presentationId
 * @param {number|string} version
 * @param {Array<{path:string, sha256:string, bytes:number}>} manifest
 * @returns {{ok:boolean, missing:Array, stale:Array, bytesNeeded:number}}
 */
export function verify(presentationId, version, manifest) {
  assertValidId(presentationId);
  const { blobsDir } = cachePaths();
  const entries = Array.isArray(manifest) ? manifest : [];
  const missing = [];
  const stale = [];
  let bytesNeeded = 0;

  for (const entry of entries) {
    if (!entry || !entry.sha256) continue; // nothing to check a malformed entry against
    let stat;
    try {
      stat = fs.statSync(path.join(blobsDir, entry.sha256));
    } catch {
      missing.push(entry);
      bytesNeeded += Number(entry.bytes) || 0;
      continue;
    }
    const expected = Number(entry.bytes);
    if (Number.isFinite(expected) && stat.size !== expected) {
      // Present under the right name, wrong size - a truncated download or a
      // disk that ran out of space mid-write. Re-fetched, never re-hashed
      // first: a full-size wrong file is rare enough that the cheap check
      // (size) catches the failure mode that actually happens.
      stale.push(entry);
      bytesNeeded += Number.isFinite(expected) ? expected : 0;
    }
  }

  return { ok: missing.length === 0 && stale.length === 0, missing, stale, bytesNeeded };
}

// ---------------------------------------------------------------- download -

/**
 * Hard-link `src` into `dest`, falling back to a real copy.
 *
 * The fallback exists for three real cases, not a hypothetical one: linking
 * across a different volume (EXDEV - e.g. SEDEMCEK_CACHE_DIR pointed at a
 * different drive than ROOT), a filesystem that does not support hard links
 * at all (older FAT32 USB media), and a sync client that intercepts file
 * operations on a folder it manages (this very project lives under a
 * cloud-synced folder). A copy costs disk space instead of sharing it -
 * exactly the right trade when the alternative is the meeting not starting.
 */
function linkOrCopy(src, dest) {
  try {
    fs.linkSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
  }
}

async function downloadOne(entry, blobsDir, fetchBlob) {
  const partPath = path.join(blobsDir, `${entry.sha256}.part`);
  const finalPath = path.join(blobsDir, entry.sha256);

  const source = await fetchBlob(entry);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const onChunk = (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buf);
    bytes += buf.length;
  };

  await new Promise((resolve, reject) => {
    // A fresh write every time (default 'w' flag): a stale `<sha>.part` left
    // by a previous interrupted run is truncated and overwritten rather than
    // appended to. Byte-range resume was deliberately not built - see the
    // module comment on "resumable at blob granularity".
    const out = fs.createWriteStream(partPath);
    out.on('error', reject);
    out.on('finish', resolve);

    if (Buffer.isBuffer(source)) {
      onChunk(source);
      out.end(source);
    } else if (source && typeof source.getReader === 'function') {
      // A web ReadableStream, what `fetch()` returns - wrapped rather than
      // required, since fetchBlob is INJECTED and this module must not force
      // a specific network library's stream type on its caller.
      const nodeStream = Readable.fromWeb(source);
      nodeStream.on('error', reject);
      nodeStream.on('data', onChunk);
      nodeStream.pipe(out);
    } else if (source && typeof source.pipe === 'function') {
      source.on('error', reject);
      source.on('data', onChunk);
      source.pipe(out);
    } else {
      reject(new Error('fetchBlob must resolve to a Buffer, a web ReadableStream, or a Node Readable'));
    }
  });

  const digest = hash.digest('hex');
  if (digest !== entry.sha256) {
    fs.rmSync(partPath, { force: true });
    const err = new Error(`sha256 mismatch for ${entry.path || entry.sha256}: expected ${entry.sha256}, got ${digest}`);
    err.code = 'hash_mismatch';
    throw err;
  }
  const expectedBytes = Number(entry.bytes);
  if (Number.isFinite(expectedBytes) && bytes !== expectedBytes) {
    fs.rmSync(partPath, { force: true });
    const err = new Error(`size mismatch for ${entry.path || entry.sha256}: expected ${expectedBytes}, got ${bytes}`);
    err.code = 'size_mismatch';
    throw err;
  }

  // Rename only after the hash is confirmed - this is the line that makes a
  // half-downloaded or corrupted blob unable to ever pass verify() under its
  // final name.
  fs.renameSync(partPath, finalPath);
}

/**
 * Download every blob verify() would report missing or stale, and only
 * those - already-good blobs are never re-fetched or re-hashed.
 *
 * Resumable at blob granularity: if this run is interrupted (process killed,
 * Wi-Fi dies for good), the blobs it had already finished and renamed to
 * their final `<sha256>` name pass verify() on the next call and are skipped;
 * only the blob that was in flight (still `<sha256>.part`, or not started) is
 * fetched again. There is no byte-range resume WITHIN one blob - re-fetching
 * one MP4 from the start is an acceptable cost next to the complexity of
 * partial-content requests against a presigned URL.
 *
 * @param {string} presentationId
 * @param {number|string} version
 * @param {Array<{path:string, sha256:string, bytes:number}>} manifest
 * @param {{fetchBlob: (entry:object) => Promise<ReadableStream|Buffer>, onProgress?: (info:object) => void}} opts
 * @returns {Promise<{downloaded:string[], skipped:number, failed:Array<{entry:object, error:string}>}>}
 */
export async function download(presentationId, version, manifest, { fetchBlob, onProgress } = {}) {
  assertValidId(presentationId);
  assertValidVersion(version);
  if (typeof fetchBlob !== 'function') {
    throw new Error('download: fetchBlob(entry) must be provided - this module has no network code of its own');
  }

  const { blobsDir } = cachePaths();
  fs.mkdirSync(blobsDir, { recursive: true });

  const entries = Array.isArray(manifest) ? manifest.filter((e) => e && e.sha256) : [];
  const { missing, stale } = verify(presentationId, version, entries);
  const need = [...missing, ...stale];

  const result = { downloaded: [], skipped: entries.length - need.length, failed: [] };

  for (let i = 0; i < need.length; i++) {
    const entry = need[i];
    onProgress?.({ presentationId, version, entry, index: i, total: need.length, phase: 'start' });
    try {
      await downloadOne(entry, blobsDir, fetchBlob);
      result.downloaded.push(entry.sha256);
      onProgress?.({ presentationId, version, entry, index: i, total: need.length, phase: 'done' });
    } catch (err) {
      // One bad blob must not take the rest of the batch down with it - the
      // caller (pre-flight) decides whether the result is good enough to
      // offer, exactly as §7 says: "offer the cached one rather than
      // blocking" when a full refresh cannot finish in time.
      result.failed.push({ entry, error: err.message });
      onProgress?.({ presentationId, version, entry, index: i, total: need.length, phase: 'error', error: err.message });
    }
  }

  return result;
}

// -------------------------------------------------------------- materialize -

function writeVersionJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Build `cache/presentations/<id>/<version>/` from a version record already
 * fetched from the cloud, and every blob it needs already sitting in
 * blobs/ (run download() first; this function never fetches anything).
 *
 * Everything is written into `<version>.part/` and only becomes `<version>/`
 * with a directory rename, so a crash mid-materialize leaves, at worst, an
 * abandoned `.part` directory that dirFor()/activeVersion() never look at.
 *
 * If `<version>/` already exists (re-materializing after a repair), it is
 * moved aside and only deleted AFTER the new one is safely in place - a
 * plain "delete old, then rename new in" would leave a window, however
 * short, with no `<version>/` at all, and `fs.renameSync` cannot atomically
 * replace a non-empty directory on Windows the way POSIX rename() can.
 *
 * @param {string} presentationId
 * @param {number|string} version
 * @param {{config:object, slides:object, timeline:object|null, answers:object,
 *          knowledge:Record<string,string>, manifest:Array}} versionRecord
 * @returns {string} the finished version directory
 */
export function materialize(presentationId, version, versionRecord) {
  assertValidId(presentationId);
  const vId = assertValidVersion(version);
  const { presentationsDir, blobsDir } = cachePaths();
  const presDir = path.join(presentationsDir, presentationId);
  const finalDir = path.join(presDir, vId);
  const partDir = path.join(presDir, `${vId}.part`);

  fs.mkdirSync(presDir, { recursive: true });
  // A previous crash mid-materialize can leave a stale .part behind; starting
  // clean means this run can never mix old and new files under one name.
  fs.rmSync(partDir, { recursive: true, force: true });
  fs.mkdirSync(partDir, { recursive: true });

  const record = versionRecord || {};
  writeVersionJson(path.join(partDir, 'presentation.json'), record.config ?? {});
  writeVersionJson(path.join(partDir, 'slides.json'), record.slides ?? { slides: [] });
  if (record.timeline != null) writeVersionJson(path.join(partDir, 'timeline.json'), record.timeline);
  writeVersionJson(path.join(partDir, 'answers.json'), record.answers ?? { answers: [] });

  const knowledge = record.knowledge && typeof record.knowledge === 'object' ? record.knowledge : {};
  for (const [name, content] of Object.entries(knowledge)) {
    if (!isSafeFilename(name)) {
      console.warn(`[presentation-store] ${presentationId}/${vId}: skipping unsafe knowledge filename "${name}"`);
      continue;
    }
    fs.writeFileSync(path.join(partDir, name), String(content ?? ''));
  }

  const manifest = Array.isArray(record.manifest) ? record.manifest : [];
  for (const entry of manifest) {
    if (!entry || !entry.sha256 || !entry.path) continue;
    if (!isSafeRelativePath(entry.path)) {
      console.warn(`[presentation-store] ${presentationId}/${vId}: skipping unsafe manifest path "${entry.path}"`);
      continue;
    }
    const blobPath = path.join(blobsDir, entry.sha256);
    if (!fs.existsSync(blobPath)) {
      // materialize() never downloads - it only links what verify()/download()
      // already confirmed is present. Throwing here, rather than skipping the
      // file, is what stops a meeting from starting one slide short of the
      // deck: the caller must see this and NOT call setActive().
      fs.rmSync(partDir, { recursive: true, force: true });
      const err = new Error(`missing blob for ${entry.path} (${entry.sha256}) - run download() first`);
      err.code = 'blob_missing';
      err.entry = entry;
      throw err;
    }
    const dest = path.join(partDir, entry.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    linkOrCopy(blobPath, dest);
  }

  // Internal bookkeeping, not part of the reproduced presentation folder: the
  // list of blobs THIS version uses, so cache-gc.js can find orphan blobs
  // without re-contacting the cloud. Bundled into the same directory as
  // everything else, so it is covered by the same atomic rename - a version
  // cache-gc can see is a version whose blob references it also knows.
  //
  // This does not break "byte-identical in shape": presentations.js only
  // reads presentation.json/slides.json/timeline.json/answers.json by exact
  // name, knowledge.js's readKnowledgeDir() only reads .md/.txt files, and
  // scanMedia() only looks inside slides/ - none of them ever see a
  // top-level .json file they were not already looking for.
  writeVersionJson(path.join(partDir, '_manifest.json'), manifest);

  if (fs.existsSync(finalDir)) {
    const staleDir = path.join(presDir, `${vId}.stale-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
    fs.renameSync(finalDir, staleDir);
    fs.renameSync(partDir, finalDir);
    fs.rmSync(staleDir, { recursive: true, force: true });
  } else {
    fs.renameSync(partDir, finalDir);
  }

  return finalDir;
}

// ------------------------------------------------------------------ active -

/**
 * Point active.json at `version`. Throws if that version was never
 * materialized - setActive() must never make a directory that does not exist
 * "the" version a new session starts from.
 */
export function setActive(presentationId, version, versionId = null) {
  assertValidId(presentationId);
  const vId = assertValidVersion(version);
  if (!fs.existsSync(versionDir(presentationId, vId))) {
    const err = new Error('version_not_materialized');
    err.code = 'version_not_materialized';
    throw err;
  }
  // `versionId` is the cloud's immutable version UUID, kept here purely so a
  // session started from this cache can be pinned to the exact version it was
  // presented from - editing the deck tomorrow must not move a meeting held
  // today. Local-only presentations have no such id and pin nothing, which is
  // correct: there is no cloud version for them to drift away from.
  const record = { version: Number(vId), versionId: versionId ? String(versionId) : null, verifiedAt: new Date().toISOString() };
  writeJsonAtomic(activeJsonPath(presentationId), record);
  return record;
}

/**
 * Clear the active pointer, but ONLY if it is still pointing at `version`.
 * A caller that raced with a newer setActive() (a repair job finishing after
 * a normal publish already moved the pointer forward) must not blow away the
 * newer pointer just because its own call happened to run last.
 *
 * @returns {boolean} true if the pointer was actually cleared
 */
export function clear(presentationId, version) {
  assertValidId(presentationId);
  const vId = assertValidVersion(version);
  const file = activeJsonPath(presentationId);
  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  if (current && Number(current.version) === Number(vId)) {
    fs.rmSync(file, { force: true });
    return true;
  }
  return false;
}
