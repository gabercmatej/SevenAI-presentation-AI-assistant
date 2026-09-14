/**
 * Deleting a presentation from the team catalogue (admin only).
 *
 * TWO OUTCOMES, DECIDED INSIDE ONE TRANSACTION
 * --------------------------------------------
 *   deleted   nothing refers to the deck: no session (any team), no share
 *             link, no share-link visit points at the presentation or any of
 *             its versions. Versions and the presentation row are removed, and
 *             the R2 objects only they used are deleted AFTER the commit.
 *   archived  something does refer to it. `archived_at` is set and every row
 *             stays: sessions.presentation_version_id is ON DELETE SET NULL,
 *             so a hard delete would silently erase which version a past
 *             meeting was presented from. The deck leaves the catalogue
 *             (GET /v1/presentations filters archived rows); a pinned version
 *             stays resolvable by number. No R2 object is touched.
 *
 * R2 SAFETY
 * ---------
 * Objects are content-addressed and may be shared by any version of any
 * presentation (a manifest entry carries an explicit r2Key). A key is only
 * deleted when no REMAINING presentation_versions row references it - checked
 * inside the transaction, and checked again after the commit, right before the
 * delete. The order is DB first, R2 second: a failed R2 delete leaves an orphan
 * object (harmless), never a row pointing at a deleted object.
 * Known limit: a `cloud-import` that reuses an object between the re-check and
 * the R2 delete could still lose it - do not publish while deleting.
 *
 * Pure planning and key collection are exported and tested without Postgres
 * or R2 (tests/presentation-delete-cloud.test.js); the SQL lives in
 * sqlDeleteStore() so the orchestration can run against a fake store.
 */
import { httpError } from './errors.js';

/** Same shape as r2.presentationKey(); duplicated so this file stays SDK-free. */
function derivedKey(presentationId, sha256) {
  return `presentations/${presentationId}/${sha256}`;
}

/**
 * Every R2 key one version row uses: manifest objects plus the preview still.
 * @param {string} presentationId
 * @param {{manifest?:Array, preview_r2_key?:string|null}} versionRow
 * @returns {string[]}
 */
export function versionR2Keys(presentationId, versionRow) {
  const keys = [];
  const manifest = Array.isArray(versionRow?.manifest) ? versionRow.manifest : [];
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object') continue;
    const key = typeof entry.r2Key === 'string' && entry.r2Key ? entry.r2Key : entry.sha256 ? derivedKey(presentationId, entry.sha256) : null;
    if (key) keys.push(key);
  }
  if (typeof versionRow?.preview_r2_key === 'string' && versionRow.preview_r2_key) keys.push(versionRow.preview_r2_key);
  return keys;
}

/** Unique, sorted keys across all versions of one presentation. */
export function collectR2Keys(presentationId, versionRows) {
  const set = new Set();
  for (const row of versionRows || []) for (const key of versionR2Keys(presentationId, row)) set.add(key);
  return [...set].sort();
}

export function isReferenced(references) {
  const r = references || {};
  return (Number(r.sessions) || 0) + (Number(r.shareLinks) || 0) + (Number(r.shareSessions) || 0) > 0;
}

/**
 * The decision, as data. PURE.
 * @param {{presentationId:string, versions:Array<{id:string}>, references:{sessions:number, shareLinks:number, shareSessions:number},
 *          stillReferencedKeys?:string[]}} input stillReferencedKeys = keys some OTHER remaining version still uses
 * @returns {{mode:'deleted'|'archived', removeVersionIds:string[], candidateKeys:string[], deleteKeys:string[], keptKeys:string[]}}
 */
export function planPresentationDelete({ presentationId, versions = [], references, stillReferencedKeys = [] }) {
  const candidateKeys = collectR2Keys(presentationId, versions);
  if (isReferenced(references)) {
    return { mode: 'archived', removeVersionIds: [], candidateKeys, deleteKeys: [], keptKeys: candidateKeys };
  }
  const still = new Set(stillReferencedKeys);
  return {
    mode: 'deleted',
    removeVersionIds: versions.map((v) => v.id),
    candidateKeys,
    deleteKeys: candidateKeys.filter((k) => !still.has(k)),
    keptKeys: candidateKeys.filter((k) => still.has(k)),
  };
}

/**
 * The SQL, bound to one runner `(text, params) => Promise<{rows}>` - a
 * transaction client's query for the delete, the pool's for the re-check.
 */
export function sqlDeleteStore(run) {
  return {
    async findPresentation({ presentationId, teamId = null, lock = false }) {
      const params = [presentationId];
      let where = 'id = $1';
      if (teamId) {
        params.push(teamId);
        where += ' and team_id = $2';
      }
      const { rows } = await run(
        `select id, team_id, title, archived_at, current_version_id from presentations where ${where}${lock ? ' for update' : ''}`,
        params
      );
      return rows[0] || null;
    },
    async listVersions(presentationId) {
      const { rows } = await run(
        'select id, version, manifest, preview_r2_key from presentation_versions where presentation_id = $1 order by version',
        [presentationId]
      );
      return rows;
    },
    async countReferences(presentationId, versionIds) {
      const { rows } = await run(
        `select
           (select count(*) from sessions where presentation_id = $1 or presentation_version_id = any($2::uuid[]))::int as sessions,
           (select count(*) from share_links where presentation_id = $1 or presentation_version_id = any($2::uuid[]))::int as share_links,
           (select count(*) from share_sessions where presentation_version_id = any($2::uuid[]))::int as share_sessions`,
        [presentationId, versionIds]
      );
      const r = rows[0] || {};
      return { sessions: Number(r.sessions) || 0, shareLinks: Number(r.share_links) || 0, shareSessions: Number(r.share_sessions) || 0 };
    },
    /** Keys among `keys` that a version of ANY OTHER presentation (any team) still uses. */
    async keysReferencedElsewhere(presentationId, keys) {
      if (!keys.length) return [];
      const { rows } = await run(
        `select distinct k.key
           from presentation_versions pv
           cross join lateral (
             select coalesce(e->>'r2Key', 'presentations/' || pv.presentation_id || '/' || (e->>'sha256')) as key
               from jsonb_array_elements(case when jsonb_typeof(pv.manifest) = 'array' then pv.manifest else '[]'::jsonb end) e
             union all
             select pv.preview_r2_key
           ) k
          where pv.presentation_id <> $1
            and k.key = any($2::text[])`,
        [presentationId, keys]
      );
      return rows.map((r) => r.key);
    },
    async archive(presentationId) {
      const { rows } = await run(
        'update presentations set archived_at = coalesce(archived_at, now()) where id = $1 returning archived_at',
        [presentationId]
      );
      return rows[0]?.archived_at ?? null;
    },
    async hardDelete(presentationId) {
      // current_version_id has no ON DELETE action: clear it before the versions go.
      await run('update presentations set current_version_id = null where id = $1', [presentationId]);
      await run('delete from presentation_versions where presentation_id = $1', [presentationId]);
      await run('delete from presentations where id = $1', [presentationId]);
    },
  };
}

/**
 * Read everything the decision needs and plan it. Writes nothing - the
 * dry-run script calls exactly this.
 */
export async function inspectPresentation(store, { presentationId, teamId = null, lock = false }) {
  const presentation = await store.findPresentation({ presentationId, teamId, lock });
  if (!presentation) return null;
  const versions = await store.listVersions(presentationId);
  const references = await store.countReferences(presentationId, versions.map((v) => v.id));
  const candidateKeys = collectR2Keys(presentationId, versions);
  const stillReferencedKeys = isReferenced(references) ? [] : await store.keysReferencedElsewhere(presentationId, candidateKeys);
  const plan = planPresentationDelete({ presentationId, versions, references, stillReferencedKeys });
  return { presentation, versions, references, plan };
}

/**
 * Delete (or archive) one presentation of one team.
 *
 * @param {object} opts
 * @param {string} opts.presentationId
 * @param {string|null} opts.teamId the caller's team; another team's deck is a 404
 * @param {(fn:(run:Function)=>Promise<any>)=>Promise<any>} opts.withTransaction
 * @param {Function} opts.query pool runner used for the post-commit re-check
 * @param {{isConfigured:()=>boolean, removeMany:(keys:string[])=>Promise<number>}} opts.storage
 * @param {(run:Function)=>object} [opts.storeFor] defaults to sqlDeleteStore
 * @returns {Promise<{ok:true, presentationId:string, mode:'deleted'|'archived', removedVersions:number,
 *   r2Deleted:number, r2Kept:number, r2Failed:number, r2Pending:number, references:object, archivedAt:string|null}>}
 */
export async function deletePresentation({ presentationId, teamId, withTransaction, query, storage, storeFor = sqlDeleteStore }) {
  const outcome = await withTransaction(async (run) => {
    const store = storeFor(run);
    const inspected = await inspectPresentation(store, { presentationId, teamId, lock: true });
    if (!inspected) throw httpError(404, 'presentation_not_found');
    const { plan, references } = inspected;
    let archivedAt = null;
    if (plan.mode === 'archived') archivedAt = await store.archive(presentationId);
    else await store.hardDelete(presentationId);
    return { plan, references, archivedAt };
  });

  const { plan, references, archivedAt } = outcome;
  let deleteKeys = plan.deleteKeys;
  let kept = plan.keptKeys.length;
  let r2Deleted = 0;
  let r2Failed = 0;
  let r2Pending = 0;

  if (deleteKeys.length) {
    try {
      // Re-check after the commit: a version published meanwhile may use a key.
      const again = new Set(await storeFor(query).keysReferencedElsewhere(presentationId, deleteKeys));
      kept += deleteKeys.filter((k) => again.has(k)).length;
      deleteKeys = deleteKeys.filter((k) => !again.has(k));
    } catch (err) {
      // Cannot prove the objects are unreferenced: keep them (orphans are safe).
      console.warn('[presentations] delete %s: R2 re-check failed, keeping %d objects: %s', presentationId, deleteKeys.length, err.message);
      r2Pending = deleteKeys.length;
      deleteKeys = [];
    }
  }

  if (deleteKeys.length) {
    if (!storage?.isConfigured?.()) {
      r2Pending += deleteKeys.length;
    } else {
      try {
        await storage.removeMany(deleteKeys);
        r2Deleted = deleteKeys.length;
      } catch (err) {
        console.warn('[presentations] delete %s: R2 delete failed for %d objects (left as orphans): %s', presentationId, deleteKeys.length, err.message);
        r2Failed = deleteKeys.length;
      }
    }
  }

  return {
    ok: true,
    presentationId,
    mode: plan.mode,
    removedVersions: plan.removeVersionIds.length,
    r2Deleted,
    r2Kept: kept,
    r2Failed,
    r2Pending,
    references,
    archivedAt: archivedAt ? new Date(archivedAt).toISOString() : null,
  };
}

export default { versionR2Keys, collectR2Keys, isReferenced, planPresentationDelete, sqlDeleteStore, inspectPresentation, deletePresentation };
