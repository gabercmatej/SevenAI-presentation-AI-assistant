/**
 * The three directories the whole application is built on.
 *
 * Everything that is *reusable* lives in knowledge/global.
 * Everything that belongs to ONE meeting lives in presentations/<id>.
 * Nothing else on the server knows a client's name.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const GLOBAL_KNOWLEDGE_DIR = path.join(ROOT, 'knowledge', 'global');

/**
 * The directories that hold DATA rather than code are overridable by
 * environment variable, and everything else here is not.
 *
 * Three reasons, all concrete. A packaged desktop application may not write
 * inside its own installation directory at all - the meetings, the deck cache
 * and the config backups belong in the user's profile, and the path is decided
 * by the OS (Electron's app.getPath('userData')), not by us. A test that synced
 * "every session on disk" would otherwise walk the real sessions/ folder and
 * write into a recording of an actual client meeting, which is not a side
 * effect a test suite gets to have. And the same test, once Electron exists,
 * would be writing into the REAL production userData directory of the app
 * installed on this laptop - a far worse version of the same accident.
 *
 * RESOLVED PER CALL, NOT AT IMPORT TIME. This is the difference between "a
 * test can redirect this" and "a test cannot redirect this". ES module imports
 * are hoisted, so a constant computed while server/paths.js is being evaluated
 * has already been computed by the time the first line of a test file runs -
 * which is exactly why tests/sessions.test.js used to say SESSIONS_DIR "is not
 * injectable" and write into the developer's own sessions/ folder. A function
 * re-reads process.env on every call, so setting the variable at the top of a
 * test file is enough, with ordinary static imports and no reload hook. This is
 * the discipline server/presentation-store.js's cachePaths() already used.
 *
 * Deliberately NOT overridable: PUBLIC_DIR, GLOBAL_KNOWLEDGE_DIR and the
 * wake-word model, which ship with the application and are read-only.
 */
function dataDir(envVar, fallback) {
  const override = process.env[envVar];
  return override ? path.resolve(override) : path.join(ROOT, fallback);
}

/** Where authored decks live. In a packaged app this is read-only. */
export function presentationsDir() {
  return dataDir('SEDEMCEK_PRESENTATIONS_DIR', 'presentations');
}

/**
 * One meeting = one folder in sessions/, exactly as one presentation is one
 * folder in presentations/. Deliberately OUTSIDE presentations/: a deck is
 * something you copy, zip and hand to a colleague, and a recording of a real
 * client meeting must never travel with it by accident.
 */
export function sessionsDir() {
  return dataDir('SEDEMCEK_SESSIONS_DIR', 'sessions');
}

/**
 * Where the cloud layer keeps everything it can re-download: the presentation
 * version cache, the blob store, the refresh token and this laptop's device
 * id. Nothing in here is irreplaceable, which is exactly what separates it
 * from sessions/ - deleting this directory costs a download, deleting
 * sessions/ costs a client meeting.
 */
export function cacheDir() {
  return dataDir('SEDEMCEK_CACHE_DIR', 'cache');
}

/**
 * Where a presentation.json / answers.json goes right before it is
 * overwritten - see backupBeforeWrite (server/util.js) for why this is not
 * optional.
 *
 * In a checkout this is under work/, so it sits next to the other "not source,
 * not a client deliverable" folders rather than inside presentations/, which a
 * presenter might zip up and hand to someone. In a packaged app work/ is
 * inside the installation directory and is not writable, so Electron points
 * this at userData/backups instead.
 */
export function backupDir() {
  return dataDir('SEDEMCEK_BACKUP_DIR', path.join('work', 'backups'));
}

/**
 * Per-deck state a PRESENTER changed, kept apart from the deck itself.
 *
 * A downloaded presentation version is immutable by construction (it is
 * addressed by its content - see server/presentation-store.js), so the
 * settings editor and the scripted-answers editor cannot write into it. They
 * write here instead, and server/presentations.js merges the result back over
 * the version when it loads. See server/deck-overrides.js for the rule that
 * decides which of the two a given deck uses.
 */
export function deckOverridesDir() {
  return dataDir('SEDEMCEK_DECK_SETTINGS_DIR', path.join('work', 'deck-settings'));
}

/**
 * The wake-word model. Read by the server, not downloaded by the browser,
 * which is why it is not in public/.
 *
 * Overridable for ONE reason only: in a packaged Electron app the model files
 * are read by sherpa-onnx's C++ side with plain fopen(), so they have to be
 * unpacked out of the asar archive and live at a different path from the
 * JavaScript that names them. This is not a data directory and nothing ever
 * writes to it.
 */
export function wakewordModelDir() {
  const override = process.env.SEDEMCEK_WAKEWORD_MODEL_DIR;
  return override ? path.resolve(override) : path.join(ROOT, 'models', 'sherpa-wakeword');
}
