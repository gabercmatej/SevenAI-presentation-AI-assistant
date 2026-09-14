/**
 * Garbage collection for cache/ - the presentation version cache described in
 * docs/CLOUD-ARCHITECTURE.md §7. A laptop that has run for months can
 * accumulate a dozen old versions of every deck; this reclaims the ones
 * nothing needs any more.
 *
 * SCOPE, ENFORCED BY CONSTRUCTION
 * --------------------------------
 * This module only ever reads/writes paths built from
 * `presentation-store.js`'s cachePaths() (cache/presentations/, cache/blobs/)
 * - it does not import server/paths.js at all, so there is no code path here
 * that could reach presentations/ or sessions/. That is the same guarantee
 * `deleteSession()` gives by validating a session id before touching disk;
 * here it is given by simply never importing the other roots.
 *
 * WHAT "ACTIVE" MEANS TO THIS MODULE
 * -----------------------------------
 * A presentation's active version (cache/presentations/<id>/active.json) is
 * never removed, regardless of how old it is - "newest N" is a preference,
 * not a guarantee, and a deck a presenter pinned to an older version on
 * purpose (a rollback) must survive a GC run exactly as well as the newest
 * one would.
 *
 * ORPHAN BLOBS
 * ------------
 * A version directory does not carry its manifest as a first-class file (that
 * would break "byte-identical in shape" to presentations/<id>/) - it carries
 * it as `_manifest.json`, written by presentation-store.js's materialize()
 * inside the same atomic rename as everything else. That is what lets this
 * module compute "which blobs does any SURVIVING version still need" without
 * contacting the cloud at all.
 */
import fs from 'node:fs';
import path from 'node:path';

import { cachePaths, runtimePinnedVersions } from './presentation-store.js';

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function readManifestSidecar(versionDirPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(versionDirPath, '_manifest.json'), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    // Missing or unreadable - an old cache written before this file existed,
    // or a hand-inspected directory. Reporting zero references is the safe
    // direction: it can only make this version's blobs look orphaned sooner
    // than they might be if this file existed, never the reverse (it never
    // causes a REFERENCED blob to be deleted).
    return [];
  }
}

/**
 * Bytes this version directory's removal actually frees.
 *
 * A file with `nlink > 1` is a hard link shared with blobs/ (or another
 * surviving version) - deleting ONE such link frees nothing while the other
 * link still exists, so it contributes 0 here. Its bytes are counted exactly
 * once, later, only if the orphan-blob pass below finds the blob's last
 * remaining link gone. A file with `nlink === 1` is either the copyFileSync
 * fallback (a real, unshared copy - see presentation-store.js's linkOrCopy)
 * or a plain JSON file materialize() wrote directly; either way deleting it
 * frees exactly its own size, counted here.
 */
function bytesFreedByRemoving(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += bytesFreedByRemoving(full);
      continue;
    }
    const st = statOrNull(full);
    if (st && st.nlink <= 1) total += st.size;
  }
  return total;
}

/**
 * Remove old, inactive presentation versions and the blobs nothing
 * references any more.
 *
 * @param {object} [opts]
 * @param {number} [opts.keepVersionsPerPresentation] how many of the newest
 *   version directories to keep per presentation, on top of whichever one is
 *   active (default 2)
 * @param {number|null} [opts.maxBytes] if the kept set is still over this
 *   many bytes, additionally drop the OLDEST remaining non-active versions
 *   (across every presentation) until it fits or none are left to drop
 * @param {boolean} [opts.dryRun] compute and return what would be removed
 *   without deleting anything (default false)
 * @returns {{removedVersions:Array<{presentationId:string, version:number}>,
 *            removedBlobs:string[], bytesFreed:number, dryRun:boolean}}
 */
export function prune({ keepVersionsPerPresentation = 2, maxBytes = null, dryRun = false } = {}) {
  const keepN = Math.max(0, Math.floor(Number(keepVersionsPerPresentation)) || 0);
  const { presentationsDir, blobsDir } = cachePaths();
  const result = { removedVersions: [], removedBlobs: [], bytesFreed: 0, dryRun: Boolean(dryRun) };

  let presentationIds = [];
  try {
    presentationIds = fs
      .readdirSync(presentationsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return result; // no cache/presentations/ yet - nothing to prune
  }

  const kept = []; // { presentationId, version, dir, isActive }

  for (const presentationId of presentationIds) {
    const presDir = path.join(presentationsDir, presentationId);

    let activeVersionNumber = null;
    try {
      const active = JSON.parse(fs.readFileSync(path.join(presDir, 'active.json'), 'utf8'));
      if (Number.isInteger(Number(active.version))) activeVersionNumber = Number(active.version);
    } catch {
      activeVersionNumber = null;
    }

    let versions = [];
    try {
      versions = fs
        .readdirSync(presDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
        .map((e) => Number(e.name))
        .sort((a, b) => b - a); // newest first
    } catch {
      versions = [];
    }

    const keepSet = new Set(versions.slice(0, keepN));
    if (activeVersionNumber != null) keepSet.add(activeVersionNumber);
    // A version an open deck is still running on is in use, however old -
    // see presentation-store.js's runtime pins.
    for (const pin of runtimePinnedVersions()) if (pin.presentationId === presentationId) keepSet.add(pin.version);

    for (const v of versions) {
      const vDir = path.join(presDir, String(v));
      if (keepSet.has(v)) {
        kept.push({ presentationId, version: v, dir: vDir, isActive: v === activeVersionNumber });
      } else {
        result.removedVersions.push({ presentationId, version: v });
        result.bytesFreed += bytesFreedByRemoving(vDir);
        if (!dryRun) fs.rmSync(vDir, { recursive: true, force: true });
      }
    }
  }

  // maxBytes: if the kept set alone is still over budget, drop the OLDEST
  // remaining non-active versions - "oldest" by the version directory's own
  // mtime, which is when materialize() finished writing it - until it fits
  // or nothing removable (non-active) is left.
  let removedSet = new Set(result.removedVersions.map((r) => `${r.presentationId}/${r.version}`));
  if (Number.isFinite(maxBytes)) {
    let total = kept.reduce((n, k) => n + bytesFreedByRemoving(k.dir), 0);
    const removable = kept
      .filter((k) => !k.isActive)
      .map((k) => ({ ...k, mtimeMs: statOrNull(k.dir)?.mtimeMs ?? 0 }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const k of removable) {
      if (total <= maxBytes) break;
      const freed = bytesFreedByRemoving(k.dir);
      result.removedVersions.push({ presentationId: k.presentationId, version: k.version });
      result.bytesFreed += freed;
      total -= freed;
      removedSet.add(`${k.presentationId}/${k.version}`);
      if (!dryRun) fs.rmSync(k.dir, { recursive: true, force: true });
    }
  }

  // What every SURVIVING version still needs.
  const referenced = new Set();
  for (const k of kept) {
    if (removedSet.has(`${k.presentationId}/${k.version}`)) continue;
    for (const entry of readManifestSidecar(k.dir)) {
      if (entry && entry.sha256) referenced.add(entry.sha256);
    }
  }

  // Orphan blobs: anything in blobs/ no surviving version references.
  //
  // A stray "<sha>.part" is left alone here on purpose - it may belong to a
  // download() in progress right now, and download() always truncates and
  // overwrites a stale .part before trusting it, so an old one left behind is
  // never a correctness risk, only a little disk space until it is reused or
  // this module is extended to age those out separately.
  let blobNames = [];
  try {
    blobNames = fs.readdirSync(blobsDir);
  } catch {
    blobNames = [];
  }
  for (const name of blobNames) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue; // not a finished blob (skips .part and anything stray)
    if (referenced.has(name)) continue;
    const full = path.join(blobsDir, name);
    const st = statOrNull(full);
    result.removedBlobs.push(name);
    result.bytesFreed += st ? st.size : 0;
    if (!dryRun) fs.rmSync(full, { force: true });
  }

  return result;
}
