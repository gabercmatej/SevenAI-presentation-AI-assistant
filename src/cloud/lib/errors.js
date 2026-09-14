/**
 * cloud/lib/errors.js - small error/async helpers shared by every route file.
 *
 * httpError() builds a plain Error carrying an HTTP status and a stable
 * machine code, so a route can `throw httpError(404, 'not_found')` and the
 * error handler in cloud/index.js knows exactly what to send back without
 * ever inspecting err.message for a real error (that string is for the log).
 * A message passed here IS shown to the client (see the `expose` flag below)
 * - it exists for the handful of cases where the message itself is the
 * useful, safe thing to say ("Napačen e-poštni naslov ali geslo."), not for
 * leaking implementation detail.
 *
 * asyncRoute() wraps a handler so a rejected promise reaches next(err)
 * instead of the request hanging forever. Express 5 already forwards a
 * rejected async handler to the error middleware on its own - this is not a
 * workaround for a bug. It is here so every route in cloud/ reads the same
 * way regardless of Express's own behaviour, and so a handler that returns a
 * promise without being declared `async` (easy typo) is covered too.
 */

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
    // Only an error built through httpError() has a message safe to send to
    // a client. Every other error (a bug, a driver throwing, a null
    // dereference) gets a generic message in the handler instead - see
    // cloud/index.js's error handler.
    this.expose = true;
  }
}

/**
 * @param {number} status HTTP status code
 * @param {string} code machine-readable error code, stable across releases -
 *   this is what a client is expected to branch on, never `message`
 * @param {string} [message] human-readable detail shown to the client.
 *   Slovenian where the existing server uses Slovenian user-facing text
 *   (login failures, account state), English for developer-facing detail
 *   (missing configuration, malformed requests).
 * @returns {HttpError}
 */
export function httpError(status, code, message) {
  return new HttpError(status, code, message);
}

/**
 * Wrap an async Express handler so a rejected promise reaches the error
 * middleware via next(err) rather than leaving the request open.
 * @param {(req: object, res: object, next: Function) => Promise<any>} fn
 * @returns {(req: object, res: object, next: Function) => void}
 */
export function asyncRoute(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
