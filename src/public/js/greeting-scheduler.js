/**
 * The automatic greeting: at most ONE per presentation open.
 *
 * app.js arms this once the deck and runtime are ready (deck mounted, wake word
 * initialised). After `delayMs` it speaks - but only if the room is still quiet.
 * If the presenter already asked something, the greeting is skipped rather than
 * queued: one voice at a time, and an unprompted hello after an answer would
 * talk over the meeting.
 *
 * Once armed it can never be armed again for this page, so slide navigation,
 * catalogue refreshes, state changes, cloud polling or fullscreen toggles cannot
 * trigger a second greeting. A new open is a new page load (the back button
 * navigates to "/"), which constructs a new scheduler.
 *
 * No DOM, injectable timers - see tests/greeting-scheduler.test.js.
 */

export const GREETING_DEFAULT_DELAY_MS = 5000;

/**
 * @param {{isQuiet:() => boolean, speak:(text:string) => void,
 *          setTimer?:(fn:Function, ms:number) => unknown, clearTimer?:(t:unknown) => void}} deps
 */
export function createGreetingScheduler({ isQuiet, speak, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) }) {
  let armed = false;
  let timer = null;
  /** null until decided, then 'disabled' | 'spoken' | 'skipped' | 'cancelled' */
  let outcome = null;

  return {
    /**
     * @param {{enabled:boolean, text:string|null, delayMs?:number}} greeting
     * @returns {boolean} whether a greeting is now pending
     */
    arm({ enabled, text, delayMs } = {}) {
      if (armed) return false;
      armed = true;
      const line = String(text || '').trim();
      if (enabled !== true || !line) {
        outcome = 'disabled';
        return false;
      }
      const delay = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : GREETING_DEFAULT_DELAY_MS;
      timer = setTimer(() => {
        timer = null;
        if (!isQuiet()) {
          outcome = 'skipped';
          return;
        }
        outcome = 'spoken';
        speak(line);
      }, delay);
      return true;
    },

    /** Leaving the deck: a pending greeting must not fire. */
    cancel() {
      if (timer === null) return;
      clearTimer(timer);
      timer = null;
      outcome = 'cancelled';
    },

    get armed() {
      return armed;
    },
    get pending() {
      return timer !== null;
    },
    get outcome() {
      return outcome;
    },
  };
}
