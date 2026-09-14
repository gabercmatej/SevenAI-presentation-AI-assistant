/**
 * Removing downloaded presentations from THIS laptop.
 *
 * Three callers, one set of rules:
 *
 *   clearDownloadedPresentations()   "Odstrani prenesene predstavitve" in
 *                                    Nastavitve - every downloaded deck goes,
 *                                    nothing else does
 *   removeLocalPresentation(id)      after an admin deleted a deck in the cloud
 *   reconcileWithdrawn(rows)         a catalogue refresh no longer lists a deck
 *                                    this laptop has downloaded
 *
 * ONLY cache/presentations/ AND cache/blobs/ ARE EVER TOUCHED. cache/ also
 * holds auth.json (the login), device.json (this laptop's sync identity) and
 * catalogue.json; sessions/ and deck-settings/ live elsewhere. None of them
 * is named anywhere in this file, which is how that is guaranteed.
 *
 * NEVER UNDER A RUNNING MEETING. A deck pinned by a running Session
 * (presentation-store.js runtime pins - the hot-swap guard), a deck an
 * unfinished Session belongs to, and anything while a download is in flight
 * (its blobs are not referenced by any version yet and would look orphaned)
 * are left alone: the full cleanup refuses, a single-deck removal is deferred
 * to the next catalogue refresh.
 */
import fs from 'node:fs';
import path from 'node:path';

import { cachePaths, runtimePinnedVersions, listCached } from './presentation-store.js';
import { prune } from './cache-gc.js';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const BLOB_RE = /^[0-9a-f]{64}(\.part)?$/;

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    const err = new Error('invalid_presentation_id');
    err.code = 'invalid_presentation_id';
    throw err;
  }
}

/** Bytes a removal frees: hard links shared with blobs/ count once, in blobs/. */
function unlinkedBytes(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += unlinkedBytes(full);
    else {
      try {
        const st = fs.statSync(full);
        if (st.nlink <= 1) total += st.size;
      } catch {
        /* vanished */
      }
    }
  }
  return total;
}

function blobNames() {
  try {
    return fs.readdirSync(cachePaths().blobsDir).filter((n) => BLOB_RE.test(n));
  } catch {
    return [];
  }
}

/** Ids a running Session pins, plus ids an unfinished Session belongs to. */
function busyIds(activeDeckIds = []) {
  return new Set([...runtimePinnedVersions().map((p) => p.presentationId), ...activeDeckIds.filter(Boolean)]);
}

/** What "Prenesene predstavitve" shows. Reads only. */
export function downloadedSummary() {
  const decks = listCached().filter((c) => c.versions.length > 0);
  const { presentationsDir, blobsDir } = cachePaths();
  let bytes = unlinkedBytes(presentationsDir);
  for (const name of blobNames()) {
    try {
      bytes += fs.statSync(path.join(blobsDir, name)).size;
    } catch {
      /* vanished */
    }
  }
  return { presentations: decks.map((d) => ({ id: d.presentationId, versions: d.versions })), bytes };
}

/**
 * Remove every downloaded deck and blob. Non-destructive for everything else.
 * @param {{activeSessions?:number, downloading?:boolean}} [state]
 * @returns {{ok:true, removedPresentations:string[], removedBlobs:number, bytesFreed:number}|{ok:false, error:string}}
 */
export function clearDownloadedPresentations({ activeSessions = 0, downloading = false } = {}) {
  if (runtimePinnedVersions().length) return { ok: false, error: 'presentation_in_use' };
  if (activeSessions > 0) return { ok: false, error: 'session_active' };
  if (downloading) return { ok: false, error: 'download_in_progress' };

  const { presentationsDir, blobsDir } = cachePaths();
  const before = downloadedSummary();
  let ids = [];
  try {
    ids = fs.readdirSync(presentationsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    ids = [];
  }
  for (const id of ids) fs.rmSync(path.join(presentationsDir, id), { recursive: true, force: true });
  const blobs = blobNames();
  for (const name of blobs) fs.rmSync(path.join(blobsDir, name), { force: true });

  return {
    ok: true,
    removedPresentations: before.presentations.map((p) => p.id),
    removedBlobs: blobs.length,
    bytesFreed: before.bytes,
  };
}

/**
 * Remove one downloaded deck and the blobs no other downloaded version uses.
 * @param {string} presentationId
 * @param {{activeDeckIds?:string[], downloading?:boolean}} [state]
 */
export function removeLocalPresentation(presentationId, { activeDeckIds = [], downloading = false } = {}) {
  assertId(presentationId);
  const dir = path.join(cachePaths().presentationsDir, presentationId);
  const existed = fs.existsSync(dir);
  if (!existed) return { presentationId, removed: false, deferred: false, removedBlobs: 0, bytesFreed: 0 };
  if (busyIds(activeDeckIds).has(presentationId)) return { presentationId, removed: false, deferred: true, reason: 'in_use' };
  if (downloading) return { presentationId, removed: false, deferred: true, reason: 'download_in_progress' };

  const bytes = unlinkedBytes(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  // Every remaining version is kept; only blobs nothing references go.
  const gc = prune({ keepVersionsPerPresentation: Number.POSITIVE_INFINITY });
  return { presentationId, removed: true, deferred: false, removedBlobs: gc.removedBlobs.length, bytesFreed: bytes + gc.bytesFreed };
}

/**
 * Downloaded decks the team catalogue no longer lists (deleted or archived in
 * the cloud). PURE.
 * @param {{remoteRows:Array<{id:string, archivedAt?:string|null}>, cached:Array<{presentationId:string, versions:number[]}>}} input
 * @returns {string[]}
 */
export function withdrawnIds({ remoteRows, cached }) {
  if (!Array.isArray(remoteRows)) return [];
  const listed = new Set(remoteRows.filter((r) => r && typeof r.id === 'string' && !r.archivedAt).map((r) => r.id));
  return (cached || []).filter((c) => c.versions?.length > 0 && !listed.has(c.presentationId)).map((c) => c.presentationId);
}

/**
 * Call ONLY with a catalogue the cloud actually returned (never the [] of an
 * offline listRemote()).
 * @returns {{withdrawn:string[], removed:string[], deferred:string[]}}
 */
export function reconcileWithdrawn({ remoteRows, activeDeckIds = [], downloading = false }) {
  // An EMPTY team catalogue is not trusted to remove anything: a misconfigured
  // or half-migrated cloud answering [] would otherwise wipe every download.
  // Removing the team's very last deck therefore waits until another exists.
  if (!Array.isArray(remoteRows) || remoteRows.length === 0) return { withdrawn: [], removed: [], deferred: [] };
  const withdrawn = withdrawnIds({ remoteRows, cached: listCached() });
  const removed = [];
  const deferred = [];
  for (const id of withdrawn) {
    try {
      const r = removeLocalPresentation(id, { activeDeckIds, downloading });
      if (r.removed) removed.push(id);
      else if (r.deferred) deferred.push(id);
    } catch (err) {
      console.warn('[presentations] could not remove withdrawn deck %s: %s', id, err.message);
      deferred.push(id);
    }
  }
  if (removed.length) console.info('[presentations] removed decks no longer in the team catalogue: %s', removed.join(', '));
  return { withdrawn, removed, deferred };
}

/**
 * The local end of "Izbriši" in Upravljanje predstavitev. The cloud decides
 * authorization; the local role check only avoids a pointless round trip.
 *
 * @param {string} presentationId
 * @param {{cloud:{enabled:boolean, status:()=>object, del:(p:string)=>Promise<object>}, activeDeckIds?:string[], downloading?:boolean}} deps
 * @returns {Promise<{status:number, body:object}>}
 */
export async function adminDeletePresentation(presentationId, { cloud, activeDeckIds = [], downloading = false }) {
  if (typeof presentationId !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(presentationId)) {
    return { status: 400, body: { error: 'invalid_presentation_id' } };
  }
  if (!cloud?.enabled) return { status: 503, body: { error: 'cloud_not_configured' } };
  const status = cloud.status();
  if (!status.authenticated) return { status: 401, body: { error: 'not_authenticated' } };
  if (status.user?.role !== 'admin') return { status: 403, body: { error: 'admin_only' } };

  let result;
  try {
    result = await cloud.del(`/v1/presentations/${encodeURIComponent(presentationId)}`);
  } catch (err) {
    const code = err.status >= 400 && err.status < 500 ? err.status : 502;
    return { status: code, body: { error: err.code || 'delete_failed' } };
  }

  let local;
  try {
    local = removeLocalPresentation(presentationId, { activeDeckIds, downloading });
  } catch (err) {
    local = { presentationId, removed: false, deferred: true, reason: err.code || err.message };
  }
  return { status: 200, body: { ...result, local } };
}

export default { downloadedSummary, clearDownloadedPresentations, removeLocalPresentation, withdrawnIds, reconcileWithdrawn, adminDeletePresentation };
