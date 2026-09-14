/**
 * SevenAI desktop app - the Electron main process.
 *
 * WHAT THIS IS: a host for the existing, finished SevenAI runtime. It starts
 * the same server.js `npm start` runs (in a utility process, see
 * server-entry.mjs), opens one window onto it over loopback HTTP, and owns the
 * things only a desktop app can own: where data lives, the OS-sealed auth key,
 * one instance at a time, microphone permission, and a clean exit.
 *
 * WHAT THIS IS NOT: a second frontend. There is no IPC the web app depends on
 * and no route added for Electron; the page in the window is the page a
 * browser gets. That is what keeps "works in the browser" and "works in the
 * app" the same statement.
 *
 * WINDOW LIFECYCLE, DOCUMENTED BECAUSE macOS DIFFERS: closing the SevenAI
 * window quits SevenAI on every platform, macOS included. A presentation app
 * that kept a microphone pipeline and a meeting recorder alive in the Dock
 * after its only window was closed would be the surprising behaviour, not the
 * conventional one.
 */
import { app, BrowserWindow, Menu, dialog, safeStorage, session, shell, systemPreferences } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { APP_DIR_NAME, PREFERRED_DESKTOP_PORT, buildServerEnv, dataPaths, refusedDebugSwitch, resolveCloudUrl } from './config.js';
import { createLogger } from './logging.js';
import { pickPort } from './port.js';
import { loadOrCreateAuthKey, protectionName } from './secure-auth.js';
import { ServerHost } from './server-host.js';

const packaged = app.isPackaged;
const HERE = import.meta.dirname;

// ------------------------------------------------------------ identity ------

app.setName(APP_DIR_NAME);
// userData is decided HERE, explicitly, before anything asks for it:
//   packaged       <appData>/SevenAI          (%APPDATA%\SevenAI, ~/Library/Application Support/SevenAI)
//   development    <appData>/SevenAI-Dev      so `npm run electron:dev` never touches an installed app's data
//   SEVENAI_USER_DATA_DIR                     a throwaway profile, for a clean-device test
const userDataOverride = process.env.SEVENAI_USER_DATA_DIR;
app.setPath(
  'userData',
  userDataOverride ? path.resolve(userDataOverride) : path.join(app.getPath('appData'), packaged ? APP_DIR_NAME : `${APP_DIR_NAME}-Dev`)
);
if (process.platform === 'win32') app.setAppUserModelId('com.example.sevenai');

const paths = dataPaths(app.getPath('userData'));
const logger = createLogger({ dir: paths.logs, echo: !packaged });

process.on('uncaughtException', (err) => logger.error('main', `uncaughtException: ${err?.stack || err}`));
process.on('unhandledRejection', (err) => logger.error('main', `unhandledRejection: ${err?.stack || err}`));

// ------------------------------------------------------- single instance ----
//
// A second launch must not start a second server, a second recorder or a
// second wake-word listener on the same microphone. The lock is per userData
// directory, so an installed app and a development run are separate apps.

// ------------------------------------------------------- debug switches ----
//
// A packaged app does not start with a DevTools port or an inspector open onto
// a logged-in presenter's session. Refused before the window, the server or
// the auth key exist - see electron/config.js refusedDebugSwitch() for the one
// exception (the packaged-app E2E driver).
const refusedSwitch = refusedDebugSwitch({ packaged, argv: process.argv, env: process.env });

if (refusedSwitch) {
  logger.warn('main', `refusing to start: ${refusedSwitch} is not available in a production launch`);
  app.exit(2);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    logger.info('main', 'second launch - focusing the existing window');
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  start().catch((err) => fatal('startup', err));
}

// -------------------------------------------------------------- state -------

/** @type {BrowserWindow|null} */
let mainWindow = null;
let quitting = false;
let appUrl = null;
const host = new ServerHost({
  entry: path.join(HERE, 'server-entry.mjs'),
  // A packaged app starts from wherever the OS started it; give the server a
  // working directory that is guaranteed to exist and is ours.
  cwd: packaged ? paths.root : app.getAppPath(),
  logger,
  onUnexpectedExit: (code) => onServerLost(code),
});

// -------------------------------------------------------------- startup -----

async function start() {
  await app.whenReady();

  logger.info('main', `SevenAI ${app.getVersion()} starting (${packaged ? 'packaged' : 'development'}; electron ${process.versions.electron}; ${process.platform}-${process.arch})`);
  logger.info('main', `userData: ${paths.root}`);

  if (!prepareDataDirectories()) return;

  const authKeyHex = loadOrCreateAuthKey({
    safeStorage,
    secureDir: paths.secure,
    log: (level, msg) => logger[level === 'error' ? 'error' : 'warn']('auth', msg),
  });
  logger.info('auth', authKeyHex ? `credential encryption: ${protectionName()}` : 'credential encryption: UNAVAILABLE (file permissions only)');

  installMenu();
  installPermissionPolicy();

  mainWindow = createWindow();
  await mainWindow.loadFile(path.join(HERE, 'splash.html'));

  if (process.platform === 'darwin') requestMacMicrophoneAccess();

  let port;
  try {
    port = await startServer(authKeyHex, PREFERRED_DESKTOP_PORT);
  } catch (err) {
    return fatal('server', err, 'Lokalnega strežnika SevenAI ni bilo mogoče zagnati.');
  }

  appUrl = `http://127.0.0.1:${port}/`;
  logger.info('main', `local server listening on 127.0.0.1:${port}`);
  logDiagnostics(port);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.loadURL(appUrl);
}

/**
 * Every writable directory must exist and actually accept a write before the
 * server is asked to use it. A full disk or a profile folder locked by some
 * policy is reported here, in words, instead of as a login that silently
 * cannot be remembered or a download that silently fails.
 */
function prepareDataDirectories() {
  try {
    for (const dir of [paths.root, paths.cache, paths.sessions, paths.deckSettings, paths.backups, paths.localPresentations, paths.secure, paths.logs]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const probe = path.join(paths.root, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return true;
  } catch (err) {
    fatal('data', err, 'Mape s podatki SevenAI ni mogoče uporabiti (predstavitve, seje in prijava se ne morejo shraniti). Preverite, ali je na disku dovolj prostora.');
    return false;
  }
}

async function startServer(authKeyHex, preferred) {
  const envFor = (port) =>
    buildServerEnv({
      packaged,
      baseEnv: process.env,
      userDataDir: paths.root,
      appDir: app.getAppPath(),
      port,
      authKeyHex,
    });

  const cloudUrl = resolveCloudUrl({ packaged, env: process.env });
  logger.info('main', `cloud: ${cloudUrl || '(from .env - development)'}`);

  const picked = await pickPort({ preferred });
  if (!picked.preferred) logger.info('main', `port ${preferred} is in use by another program - using ${picked.port}`);
  try {
    return await host.start(envFor(picked.port));
  } catch (err) {
    // The one race port.js cannot close: somebody took the port between the
    // probe and the bind. Let the OS choose, once.
    if (err.code !== 'EADDRINUSE') throw err;
    logger.warn('main', `port ${picked.port} was taken during startup - retrying on a free port`);
    return host.start(envFor(0));
  }
}

/** Startup facts for the log - what support will ask for first. Never a credential. */
async function logDiagnostics(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/wakeword`);
    const wake = await res.json();
    logger.info('wakeword', wake.configured ? `ready ("${wake.keyword}", ${wake.model})` : `NOT available: ${wake.reason} - SPACE activation remains`);
  } catch (err) {
    logger.warn('wakeword', `status unavailable: ${err.message}`);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/cloud/status`);
    const cs = await res.json();
    const cached = (cs.presentations?.cached || []).map((c) => `${c.presentationId}@${c.active?.version ?? '-'}`);
    logger.info('cloud', `state=${cs.state} authenticated=${cs.authenticated} cachedPresentations=[${cached.join(', ')}]`);
  } catch (err) {
    logger.warn('cloud', `status unavailable: ${err.message}`);
  }
}

// --------------------------------------------------------------- window -----

function createWindow() {
  const win = new BrowserWindow({
    title: 'SevenAI',
    // Windows and Linux windows. A packaged Windows window already shows the
    // exe's own icon and macOS takes the bundle's; this covers development.
    ...(process.platform === 'darwin' ? {} : { icon: path.join(HERE, 'assets', 'icon.png') }),
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0f1115',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(HERE, 'preload.cjs'),
      additionalArguments: [`--sevenai-version=${app.getVersion()}`],
      spellcheck: false,
      // A presenter switching to their notes must not slow the wake-word
      // stream or the timeline clock of the deck left running behind them.
      backgroundThrottling: false,
      devTools: !packaged || process.env.SEVENAI_DEVTOOLS === '1',
    },
  });

  win.once('ready-to-show', () => win.show());
  // The deck's own <title> must not rename the app window.
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  const wc = win.webContents;

  // Nothing but SevenAI itself is ever loaded into this window. A link to the
  // outside world opens in the system browser; anything else is refused.
  wc.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    openExternally(url);
  });
  wc.on('will-redirect', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' };
    openExternally(url);
    return { action: 'deny' };
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());

  wc.on('render-process-gone', (_e, details) => {
    logger.error('renderer', `render process gone: ${details.reason} (exit ${details.exitCode})`);
    if (quitting || details.reason === 'clean-exit' || !appUrl || win.isDestroyed()) return;
    // Everything a meeting has produced is already on disk in the server
    // process, which is still running. Reloading hands the presenter back the
    // app, and the existing Session recovery takes it from there.
    win.loadURL(appUrl).catch((err) => logger.error('renderer', `reload failed: ${err.message}`));
  });
  wc.on('unresponsive', () => logger.warn('renderer', 'window unresponsive'));
  wc.on('responsive', () => logger.info('renderer', 'window responsive again'));
  wc.on('console-message', (details) => {
    // Only the renderer's warnings and errors: enough to diagnose a failure
    // on a laptop with no DevTools, without copying every log line.
    const level = details.level;
    if (level === 'warning' || level === 'error') logger[level === 'error' ? 'error' : 'warn']('renderer', details.message);
  });

  if (!packaged || process.env.SEVENAI_DEVTOOLS === '1') {
    wc.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
        wc.toggleDevTools();
        e.preventDefault();
      }
    });
  }

  return win;
}

function isAppUrl(url) {
  if (!appUrl) return false;
  try {
    return new URL(url).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

function openExternally(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') {
      shell.openExternal(url);
      return;
    }
  } catch {
    /* not a URL */
  }
  logger.warn('main', `blocked navigation to ${String(url).slice(0, 200)}`);
}

// ---------------------------------------------------------- permissions -----

/**
 * The microphone, fullscreen and clipboard writes - for SevenAI's own origin
 * only, and audio only: the app never asks for a camera, and a request for one
 * is refused rather than prompted.
 */
function installPermissionPolicy() {
  const ses = session.defaultSession;
  const ALLOWED = new Set(['media', 'fullscreen', 'clipboard-sanitized-write']);

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details.requestingUrl || wc?.getURL() || '';
    let ok = isAppUrl(origin) && ALLOWED.has(permission);
    if (ok && permission === 'media') {
      const types = details.mediaTypes || [];
      ok = types.length > 0 && types.every((t) => t === 'audio');
    }
    if (!ok) logger.warn('permissions', `denied ${permission} for ${String(origin).slice(0, 120)}`);
    callback(ok);
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return isAppUrl(requestingOrigin) && ALLOWED.has(permission);
  });
}

/**
 * macOS asks the user once, with NSMicrophoneUsageDescription as the reason.
 * Asked at launch rather than at the first getUserMedia() call, so the prompt
 * appears on an idle screen - not over the dashboard at the moment the
 * presenter first says "Hey Seven" in front of a client.
 */
function requestMacMicrophoneAccess() {
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    logger.info('microphone', `macOS access status: ${status}`);
    if (status === 'not-determined') {
      systemPreferences
        .askForMediaAccess('microphone')
        .then((granted) => logger.info('microphone', `macOS access ${granted ? 'granted' : 'denied'}`))
        .catch((err) => logger.warn('microphone', `access request failed: ${err.message}`));
    }
  } catch (err) {
    logger.warn('microphone', `status unavailable: ${err.message}`);
  }
}

// ----------------------------------------------------------------- menu -----

function installMenu() {
  if (process.platform === 'darwin') {
    // macOS needs an application menu for Cmd+Q and for Cmd+C / Cmd+V to work
    // in the login form at all. No View menu in a packaged build: no reload
    // and no DevTools one keystroke away from a client meeting.
    const template = [
      { role: 'appMenu' },
      { role: 'editMenu' },
      ...(packaged ? [] : [{ role: 'viewMenu' }]),
      { role: 'windowMenu' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    return;
  }
  // Windows: no menu bar in a packaged build. Clipboard shortcuts work in the
  // page without one. Development keeps Electron's default menu.
  if (packaged) Menu.setApplicationMenu(null);
}

// -------------------------------------------------------------- failures ----

async function onServerLost(code) {
  if (quitting) return;
  logger.error('main', `local server stopped unexpectedly (code ${code})`);
  const { response } = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    type: 'error',
    title: 'SevenAI',
    message: 'Lokalni strežnik SevenAI se je nepričakovano ustavil.',
    detail: 'Posnetki sej in prenesene predstavitve ostanejo shranjeni. SevenAI lahko znova zaženete.',
    buttons: ['Znova zaženi', 'Zapri SevenAI'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return app.quit();
  try {
    const previous = appUrl ? Number(new URL(appUrl).port) : PREFERRED_DESKTOP_PORT;
    const authKeyHex = loadOrCreateAuthKey({ safeStorage, secureDir: paths.secure });
    const port = await startServer(authKeyHex, previous);
    appUrl = `http://127.0.0.1:${port}/`;
    logger.info('main', `local server restarted on 127.0.0.1:${port}`);
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(appUrl);
  } catch (err) {
    fatal('server', err, 'Lokalnega strežnika SevenAI ni bilo mogoče ponovno zagnati.');
  }
}

/**
 * A failure the app cannot run past. The presenter gets a sentence in their
 * own language and a way to the log; the stack trace goes to the log only.
 */
async function fatal(area, err, message = 'SevenAI se ni mogel zagnati.') {
  logger.error(area, err?.stack || String(err));
  if (quitting) return;
  try {
    await app.whenReady();
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'SevenAI',
      message,
      detail: `Podrobnosti so zapisane v dnevniku:\n${logger.file}`,
      buttons: ['Odpri mapo z dnevniki', 'Zapri'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) await shell.openPath(logger.dir);
  } catch {
    /* no UI available: the log already has it */
  }
  await shutdown();
  app.exit(1);
}

// -------------------------------------------------------------- shutdown ----
//
// Order matters. The window goes first: destroying the renderer is what stops
// the microphone, the speech-to-text socket and any TTS still playing. Then
// the server, which flushes cloud sync (bounded) and releases its port. A
// Session still open is left exactly as a closed browser tab leaves it -
// active on disk, offered for recovery on the next launch - and is never
// marked finished by a quit that did not finish it.

async function shutdown() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  mainWindow = null;
  await host.stop();
}

app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  logger.info('main', 'quitting');
  shutdown()
    .catch((err) => logger.error('main', `shutdown: ${err?.stack || err}`))
    .finally(() => {
      logger.info('main', 'exit');
      app.exit(0);
    });
});

app.on('window-all-closed', () => app.quit());

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => app.quit());
}
