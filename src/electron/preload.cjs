/**
 * The whole of the renderer's Node surface: nothing.
 *
 * SevenAI's frontend talks to its local server over HTTP, exactly as it does in
 * a browser, so it needs no IPC to work. What is exposed here is read-only
 * facts - enough for the diagnostics screen to say "desktop app, version X" -
 * and no function that reaches the filesystem, the shell or the main process.
 * contextIsolation keeps even this on the far side of a structured-clone
 * boundary.
 */
const { contextBridge } = require('electron');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

contextBridge.exposeInMainWorld('sevenaiDesktop', Object.freeze({
  isDesktop: true,
  version: arg('sevenai-version'),
  platform: process.platform,
}));
