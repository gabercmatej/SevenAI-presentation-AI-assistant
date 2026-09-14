/**
 * Everything the desktop host decides about the server's environment, as pure
 * functions with no `electron` import - so the rules that matter most (where
 * data goes, which cloud is used, which credentials may never reach the server
 * process) are unit tested in plain node, not discovered on a coworker's
 * laptop. See tests/desktop-config.test.js.
 */
import path from 'node:path';

/**
 * The SevenAI cloud. Public, non-secret configuration: it is the address the
 * app logs in to, not a credential, and it is shown on the hosting dashboard.
 *
 * BUILT IN, AND WHY THAT IS A SECURITY PROPERTY RATHER THAN A CONVENIENCE.
 * With no cloud URL at all the login gate deliberately opens straight onto the
 * dashboard (public/js/auth-gate.js: "no cloud configured is the pre-cloud
 * local product") - the right call for a developer checkout with no cloud, and
 * an authentication bypass for an installed app. A packaged build therefore
 * can never run without one: see resolveCloudUrl().
 */
export const PRODUCTION_CLOUD_URL = 'https://cloud.example.com';

/**
 * The port the desktop app tries first. Not 3777: a developer running
 * `npm start` and the installed app side by side must not collide, and the
 * packaged app must not depend on this one either - see electron/port.js.
 */
export const PREFERRED_DESKTOP_PORT = 47777;

/** The userData folder name. Matches build.productName in package.json. */
export const APP_DIR_NAME = 'SevenAI';

/**
 * The cloud the server process will talk to.
 *
 *   packaged app   the explicit override if one is set (a staging cloud, a
 *                  controlled fixture for the presentation-update test),
 *                  otherwise PRODUCTION_CLOUD_URL. NEVER null: an empty or
 *                  missing variable is not a request for "no cloud".
 *   development    the override if set, otherwise null - "leave it to .env",
 *                  exactly as `npm start` does.
 *
 * @param {{packaged:boolean, env:Record<string,string|undefined>}} opts
 * @returns {string|null}
 */
export function resolveCloudUrl({ packaged, env }) {
  const override = String(env?.SEDEMCEK_CLOUD_URL ?? '').trim().replace(/\/+$/, '');
  if (override && /^https?:\/\//i.test(override)) return override;
  return packaged ? PRODUCTION_CLOUD_URL : null;
}

/**
 * Where every writable thing lives, under one root the OS chose.
 *
 *   <userData>/
 *     cache/                     cloud cache: presentations/<id>/<version>/,
 *                                blobs/, catalogue.json, device.json, and the
 *                                ENCRYPTED auth.json
 *     sessions/                  one folder per meeting (append-only JSONL)
 *     deck-settings/             presenter edits to downloaded decks
 *     backups/                   config backups before overwrite
 *     local-presentations/       authored decks, if anyone ever drops one in
 *     secure/auth-key.bin        the auth data key, sealed by safeStorage
 *     logs/                      desktop + server logs, rotated
 *
 * @param {string} userDataDir
 */
export function dataPaths(userDataDir) {
  const root = path.resolve(userDataDir);
  const cache = path.join(root, 'cache');
  return {
    root,
    cache,
    presentationCache: path.join(cache, 'presentations'),
    authFile: path.join(cache, 'auth.json'),
    sessions: path.join(root, 'sessions'),
    deckSettings: path.join(root, 'deck-settings'),
    backups: path.join(root, 'backups'),
    localPresentations: path.join(root, 'local-presentations'),
    secure: path.join(root, 'secure'),
    logs: path.join(root, 'logs'),
  };
}

/**
 * Environment variables that must never reach the server process of a
 * packaged app, whatever happens to be set on the machine.
 *
 * Provider keys arrive through the cloud's provider lease after login and live
 * in process memory only (server/provider-lease.js). A permanent key inherited
 * from a coworker's shell - or from an IT-deployed environment - would
 * silently bypass the lease, the team boundary and the revocation that comes
 * with logging out. Server-side cloud secrets have no business on a laptop at
 * all.
 */
const FORBIDDEN_IN_PACKAGED = [
  /_API_KEY$/,
  /_EDGE_KEY$/,
  /_CLOUD_KEY$/,
  /^AZURE_SPEECH_KEY$/,
  /^DATABASE_URL$/,
  /^SUPABASE_SERVICE_ROLE_KEY$/,
  /^SUPABASE_JWT_SECRET$/,
  /^R2_/,
];

export function isForbiddenInPackaged(name) {
  return FORBIDDEN_IN_PACKAGED.some((re) => re.test(name));
}

/**
 * The complete environment for the server utility process.
 *
 * @param {object} opts
 * @param {boolean} opts.packaged      app.isPackaged
 * @param {Record<string,string|undefined>} opts.baseEnv  the host's process.env
 * @param {string} opts.userDataDir    app.getPath('userData')
 * @param {string} opts.appDir         directory holding server.js (app.asar in a build)
 * @param {number} opts.port           0 lets the OS choose
 * @param {string|null} opts.authKeyHex  from electron/secure-auth.js, or null
 * @returns {Record<string,string>}
 */
export function buildServerEnv({ packaged, baseEnv, userDataDir, appDir, port, authKeyHex }) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (v === undefined) continue;
    if (packaged && isForbiddenInPackaged(k)) continue;
    env[k] = String(v);
  }

  const p = dataPaths(userDataDir);

  // Writable data: ALWAYS userData, in development Electron too. The checkout
  // lives in a synced folder, which has already once removed a session folder out
  // from under a running server; `npm start` keeps its own folders, the
  // desktop app never touches them.
  env.PORT = String(port);
  env.SEDEMCEK_HOST = '127.0.0.1';
  env.SEDEMCEK_SESSIONS_DIR = p.sessions;
  env.SEDEMCEK_CACHE_DIR = p.cache;
  env.SEDEMCEK_BACKUP_DIR = p.backups;
  env.SEDEMCEK_DECK_SETTINGS_DIR = p.deckSettings;
  env.SEDEMCEK_DESKTOP = packaged ? 'packaged' : 'dev';

  if (packaged) {
    // No authored decks ship in the installer; team decks come from the cloud
    // into cache/. This folder exists so the server has a real, empty place to
    // look rather than the read-only inside of the application bundle.
    env.SEDEMCEK_PRESENTATIONS_DIR = p.localPresentations;
    // sherpa-onnx opens its model files with plain C++ fopen(), which cannot
    // read inside app.asar - they are unpacked beside it (see build.asarUnpack).
    env.SEDEMCEK_WAKEWORD_MODEL_DIR = unpackedPath(path.join(appDir, 'models', 'sherpa-wakeword'));
    // There is no .env in a packaged app and there must never be one read
    // from wherever the process happens to start. Point dotenv at a file that
    // does not exist, on purpose.
    env.DOTENV_CONFIG_PATH = path.join(p.root, 'no-dotenv-in-packaged-app');
  }
  env.DOTENV_CONFIG_QUIET = 'true';

  const cloudUrl = resolveCloudUrl({ packaged, env: baseEnv });
  if (cloudUrl) env.SEDEMCEK_CLOUD_URL = cloudUrl;
  else delete env.SEDEMCEK_CLOUD_URL;

  if (authKeyHex) env.SEDEMCEK_AUTH_KEY = authKeyHex;
  else delete env.SEDEMCEK_AUTH_KEY;

  return env;
}

/**
 * Command-line switches that hand the app's renderer or JavaScript to a
 * debugger. A packaged app launched by a presenter never needs one.
 */
const DEBUG_SWITCH = /^--(remote-debugging-port|remote-debugging-pipe|remote-debugging-address|inspect|inspect-brk|inspect-port)(=|$)/;

/** The one variable that admits them in a packaged app: the packaged-app E2E driver sets it. */
export const E2E_TEST_ENV = 'SEVENAI_E2E_TEST';

/**
 * Which debugging switch, if any, a launch must be refused for.
 *
 * Production: refused. The automated driver (scripts/verify-desktop-packaged.js)
 * drives the INSTALLED app over the DevTools protocol and sets SEVENAI_E2E_TEST=1
 * for exactly that. This is not a boundary against somebody who already controls
 * the laptop's environment and processes - nothing in a desktop app is - it
 * keeps a stray shortcut, script or support instruction from quietly opening a
 * debugging port onto a presenter's logged-in session.
 *
 * @param {{packaged:boolean, argv:string[], env:Record<string,string|undefined>}} opts
 * @returns {string|null} the offending switch name, or null to allow the launch
 */
export function refusedDebugSwitch({ packaged, argv, env }) {
  if (!packaged || env?.[E2E_TEST_ENV] === '1') return null;
  const hit = (argv || []).find((a) => DEBUG_SWITCH.test(String(a)));
  return hit ? String(hit).split('=')[0] : null;
}

/** app.asar/x -> app.asar.unpacked/x; any other path unchanged. */
export function unpackedPath(p) {
  return p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}
