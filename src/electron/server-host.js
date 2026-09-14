/**
 * Owns the local server's utility process: start it, learn its port, pipe its
 * output to the log, and stop it - gracefully, then definitely.
 */
import { utilityProcess } from 'electron';

const START_TIMEOUT_MS = 45000;
const STOP_TIMEOUT_MS = 6000;

export class ServerHost {
  /**
   * @param {{entry:string, cwd:string, logger:ReturnType<import('./logging.js').createLogger>,
   *          onUnexpectedExit?:(code:number)=>void}} opts
   */
  constructor({ entry, cwd, logger, onUnexpectedExit }) {
    this.entry = entry;
    this.cwd = cwd;
    this.logger = logger;
    this.onUnexpectedExit = onUnexpectedExit;
    this.child = null;
    this.port = null;
    this.stopping = false;
  }

  get running() {
    return Boolean(this.child);
  }

  /**
   * @param {Record<string,string>} env  from electron/config.js buildServerEnv
   * @returns {Promise<number>} the bound port
   */
  start(env) {
    const log = this.logger;
    this.stopping = false;

    const child = utilityProcess.fork(this.entry, [], {
      env,
      cwd: this.cwd,
      stdio: 'pipe',
      serviceName: 'SevenAI Local Server',
    });
    this.child = child;
    child.stdout?.on('data', log.sink('server', 'info'));
    child.stderr?.on('data', log.sink('server', 'warn'));

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(Object.assign(new Error('The local server did not start in time.'), { code: 'start_timeout' }));
        child.kill();
      }, START_TIMEOUT_MS);

      child.on('message', (msg) => {
        if (settled) return;
        if (msg?.type === 'listening') {
          settled = true;
          clearTimeout(timer);
          this.port = msg.port;
          resolve(msg.port);
        } else if (msg?.type === 'failed') {
          settled = true;
          clearTimeout(timer);
          reject(Object.assign(new Error(msg.message || 'server_failed'), { code: msg.code || 'server_failed' }));
        }
      });

      child.once('exit', (code) => {
        if (this.child === child) this.child = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(Object.assign(new Error(`The local server exited during startup (code ${code}).`), { code: 'exited' }));
          return;
        }
        log.info('host', `local server exited (code ${code})`);
        if (!this.stopping) this.onUnexpectedExit?.(code);
      });
    });
  }

  /**
   * Graceful first: the server flushes cloud sync (bounded) and closes its
   * listener. If it has not exited in time it is ended outright - quitting
   * SevenAI must never leave a process holding a port or a file open.
   */
  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      child.postMessage({ type: 'shutdown' });
    } catch {
      /* already gone */
    }
    const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('timeout'), STOP_TIMEOUT_MS))]);
    if (code === 'timeout') {
      this.logger.warn('host', 'local server did not exit in time - ending it');
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    } else {
      this.logger.info('host', `local server stopped cleanly (code ${code})`);
    }
    this.child = null;
  }
}
