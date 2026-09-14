/**
 * Presenter edits to a deck that must not be written into the deck.
 *
 * THE PROBLEM
 * -----------
 * Two editors write deck files: the settings panel (presentation.json - mascot
 * size, subtitles, speaking speed, greeting, title...) and the scripted-answers
 * editor (answers.json). Both used to write straight into the folder
 * server/presentation-store.js dirFor() resolved. For an authored deck in
 * presentations/<id>/ that is still exactly right - it is the source a person
 * edits and commits, and nothing here changes it.
 *
 * For a deck downloaded from the cloud it is wrong twice over. The folder is
 * cache/presentations/<id>/<version>/, an IMMUTABLE version: its bytes were
 * verified against a manifest, a Session may be pinned to it, and rewriting it
 * in place silently makes "version 3" mean two different things on two
 * laptops. And in the desktop app nothing else is writable either: there is no
 * presentations/ folder a coworker could edit instead.
 *
 * THE RULE
 * --------
 * A deck served from its authored folder is edited in place, byte for byte as
 * before. A deck served from an immutable cached version is edited HERE, under
 * deckOverridesDir() (userData/deck-settings in the desktop app), and
 * server/presentations.js lays the result back over the version when it loads.
 * The deciding test is the one server.js's /media route already uses: is the
 * resolved directory the authored one or not.
 *
 * WHAT SURVIVES A NEW VERSION, AND WHAT DOES NOT
 * ----------------------------------------------
 *   presentation.json  stored as a PATCH - only the fields the presenter's
 *                      saves actually changed relative to the version. So a
 *                      presenter's mascot size carries over when v2 arrives,
 *                      and v2's corrected title still shows unless the
 *                      presenter had deliberately retitled the deck.
 *   answers.json       stored PER VERSION, whole. The editor replaces the list
 *                      as a unit, so there is no field-level patch to take -
 *                      and a list typed against v1's slides silently hiding
 *                      the answers v2 was published with would be worse than
 *                      starting v2 from what was published.
 *
 * Nothing in here touches the network, and nothing in here is ever on the
 * answer path: it is read once per deck load and written once per save.
 */
import fs from 'node:fs';
import path from 'node:path';

import { presentationsDir, deckOverridesDir } from './paths.js';
import { activeVersion } from './presentation-store.js';

const PATCH_FILE = 'presentation.patch.json';

/**
 * Is `dir` - what dirFor(id) resolved - an immutable cached version rather
 * than the authored folder? Takes the directory the caller already resolved
 * rather than resolving it again, so a download finishing between the two
 * calls cannot make one load read the version and write the override.
 */
export function isImmutableDir(id, dir) {
  return path.resolve(dir) !== path.resolve(path.join(presentationsDir(), id));
}

function deckDir(id) {
  return path.join(deckOverridesDir(), id);
}

export function settingsPatchPath(id) {
  return path.join(deckDir(id), PATCH_FILE);
}

/** Per version: see "WHAT SURVIVES A NEW VERSION" above. */
export function answersPath(id, version = activeVersion(id)?.version) {
  return path.join(deckDir(id), `v${version ?? 'unknown'}`, 'answers.json');
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What `merged` changes relative to `base`, as a patch applyPatch() can lay
 * back over a (possibly newer) base.
 *
 * Two levels, no more. Top-level fields are compared whole, except plain
 * objects (`settings`, `greeting`), whose own fields are compared one by one -
 * which is what lets a new version's `settings.subtitlesEnabled` through while
 * a presenter's `settings.mascotSizePx` still wins. Deeper structure is never
 * edited by either editor, so it is compared whole.
 */
export function diffDoc(base, merged) {
  const from = isPlainObject(base) ? base : {};
  const to = isPlainObject(merged) ? merged : {};
  const patch = {};
  for (const [key, value] of Object.entries(to)) {
    if (same(from[key], value)) continue;
    if (isPlainObject(value) && isPlainObject(from[key])) {
      const sub = {};
      for (const [k, v] of Object.entries(value)) {
        if (!same(from[key][k], v)) sub[k] = v;
      }
      if (Object.keys(sub).length) patch[key] = sub;
    } else {
      patch[key] = value;
    }
  }
  return patch;
}

/** Lay a patch from diffDoc() over a document. Never mutates either argument. */
export function applyPatch(doc, patch) {
  const out = isPlainObject(doc) ? { ...doc } : {};
  if (!isPlainObject(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? { ...out[key], ...value } : value;
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** The saved settings patch for a deck, or {} when the presenter never saved one. */
export function readSettingsPatch(id) {
  const patch = readJson(settingsPatchPath(id));
  return isPlainObject(patch) ? patch : {};
}

export function writeSettingsPatch(id, patch) {
  writeJsonAtomic(settingsPatchPath(id), patch);
}

/** A presenter-saved answers document for this exact version, or null. */
export function readAnswers(id, version) {
  return readJson(answersPath(id, version));
}

export function writeAnswers(id, version, doc) {
  writeJsonAtomic(answersPath(id, version), doc);
}
