/**
 * Choosing the loopback port for the desktop app's local server.
 *
 * Preferred port first, because a stable port keeps the renderer's origin
 * stable between launches - and the origin is what Chromium keys microphone
 * permission and localStorage on. If anything already holds it, the OS picks a
 * free one instead. Nothing here ever stops, signals or inspects the process
 * that owns a busy port: it is somebody else's, and SevenAI simply goes
 * elsewhere.
 *
 * There is an unavoidable gap between "this port was free" and "the server
 * bound it". electron/server-host.js closes it by retrying once with port 0 if
 * the server itself reports EADDRINUSE.
 */
import net from 'node:net';

/** Can we bind this port on this host right now? Never throws. */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

/** A port the OS says is free now. */
export function ephemeralPort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen({ port: 0, host, exclusive: true }, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * @param {{preferred?:number, host?:string}} [opts]
 * @returns {Promise<{port:number, preferred:boolean}>}
 */
export async function pickPort({ preferred, host = '127.0.0.1' } = {}) {
  if (Number.isInteger(preferred) && preferred > 0 && (await isPortFree(preferred, host))) {
    return { port: preferred, preferred: true };
  }
  return { port: await ephemeralPort(host), preferred: false };
}
