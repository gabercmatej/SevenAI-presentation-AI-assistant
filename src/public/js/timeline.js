/**
 * A continuous Canva export, driven like a slide deck.
 *
 * Canva exports a whole presentation as ONE video. That keeps every animation
 * and every transition exactly as designed, and takes away the only thing a
 * presenter actually needs: the ability to stop on a page and stay there for
 * as long as the conversation in the room takes.
 *
 * This class gives that back. `presentations/<deck>/timeline.json` (built by
 * scripts/build-timeline.js) says, for every slide, where its entrance begins
 * and which frame is its hold. Playback is then never "playing" in the video
 * sense - it is always a move from one hold to another:
 *
 *   next()      play forward from here -> the real Canva exit, transition and
 *               entrance -> stop dead on the next hold
 *   prev()      seek to the previous slide's entrance -> play it -> stop on
 *               its hold. Video cannot run backwards, so going back replays
 *               the arrival rather than reversing the departure.
 *   goTo(n)     the same, from anywhere to anywhere
 *
 * Between moves the video is PAUSED on an exact frame. That is what makes it a
 * slide: nothing drifts, nothing advances while Sedemček is talking, and the
 * presenter can stand on one page for ten minutes.
 *
 * STOPPING ON THE RIGHT FRAME
 * ---------------------------
 * `timeupdate` fires about four times a second, which at 30 fps is an overshoot
 * of up to eight frames - enough to slide visibly into the next transition. So
 * the stop is driven by requestVideoFrameCallback, which fires once per
 * decoded frame, and after pausing the currentTime is set back to the exact
 * cue point. The seek corrects whatever the last frame overshot by, so the
 * frame on screen is always the one the timeline chose.
 *
 * THE ONE LOOPING SLIDE
 * ---------------------
 * A page carrying an embedded reel never goes still, so it gets loopStart and
 * loopEnd instead of a frozen hold, and wraps between them for as long as the
 * presenter stands there.
 */

const EPSILON = 0.02; // seconds; a frame at 30 fps is 0.033

class TimelineDeck extends EventTarget {
  /**
   * @param {object} timeline the deck's timeline.json
   * @param {string} src URL of the video
   */
  constructor(timeline, src) {
    super();
    this.timeline = timeline;
    this.src = src;
    this.cues = timeline.slides || [];
    this.index = 1;
    this.video = null;
    this.ready = false;

    this._rvfc = null; // requestVideoFrameCallback handle
    this._raf = null; // fallback handle
    this._target = null; // where the current move is heading
    this._moveToken = 0; // invalidates a move that has been superseded
    this._objectUrl = null;
  }

  get total() {
    return this.cues.length;
  }

  /** @param {number} n @returns {object|null} the cue points for a slide */
  cue(n) {
    return this.cues.find((c) => c.n === n) || null;
  }

  // ------------------------------------------------------------- mounting ---

  /**
   * Build the video element and get the whole file into memory.
   *
   * The file is fetched as a Blob rather than handed to the element as a URL.
   * On a local server both work, but only the Blob guarantees that every seek
   * afterwards is served from memory - no range request, no stall, no
   * buffering pause in the middle of a meeting. A deck is tens of megabytes;
   * holding it is a bargain for never having to think about it again.
   *
   * @param {HTMLElement} stage
   */
  async mount(stage) {
    const video = document.createElement('video');
    video.className = 'slide-media deck-video is-active';
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.muted = true; // the deck is silent; Sedemcek is the only voice
    video.controls = false;
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.setAttribute('controlslist', 'nodownload noplaybackrate noremoteplayback');
    stage.appendChild(video);
    this.video = video;

    let src = this.src;
    try {
      const res = await fetch(this.src, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`http_${res.status}`);
      const blob = await res.blob();
      this._objectUrl = URL.createObjectURL(blob);
      src = this._objectUrl;
    } catch (err) {
      // Streaming still works; it just seeks less predictably.
      console.warn('[timeline] could not preload the deck (%s) - streaming instead', err.message);
    }

    await new Promise((resolve) => {
      const done = () => resolve();
      video.addEventListener('loadeddata', done, { once: true });
      video.addEventListener('error', done, { once: true });
      video.src = src;
      video.load();
      setTimeout(done, 8000); // never block the meeting on a video that will not load
    });

    this.ready = video.readyState >= 2;
    if (!this.ready) {
      console.warn('[timeline] the deck video did not load');
      this.dispatchEvent(new CustomEvent('unavailable'));
      return this;
    }

    // Park on slide 1's hold without showing the entrance: the deck should be
    // sitting on the title slide before anyone looks at the screen.
    await this._seek(this.cue(1)?.holdAt ?? 0);
    this.index = 1;
    this._announce(1, null);
    return this;
  }

  /** Free the blob. Called when the deck is swapped or the page unloads. */
  destroy() {
    this._stopWatching();
    this.video?.pause();
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = null;
    this.video?.remove();
    this.video = null;
  }

  // ----------------------------------------------------------- navigation ---

  /**
   * @param {number} n 1-based live slide number
   * @param {{immediate?:boolean}} [opts] immediate: jump to the hold with no
   *   entrance animation at all. Used for the initial park.
   */
  async goTo(n, opts = {}) {
    const target = Math.min(this.total, Math.max(1, Math.round(n)));
    const cue = this.cue(target);
    if (!cue || !this.video) return false;

    const from = this.index;
    if (target === from && !opts.force) {
      // Re-entering the slide you are already on: replay its entrance rather
      // than doing nothing, so "pokaži cenik" always looks like it did
      // something.
      if (!opts.replay) return true;
    }

    const token = ++this._moveToken;
    this._stopWatching();

    // The context belongs to the destination the moment the move starts. If a
    // question arrives mid-transition it is about where we are going, not
    // where we were.
    this.index = target;
    this._announce(target, from);

    if (opts.immediate) {
      await this._seek(cue.holdAt);
      return true;
    }

    // Moving forward by exactly one slide plays the real Canva exit,
    // transition and entrance, which are all sitting in the video between the
    // two holds - but it starts from the frame where the current page BEGINS
    // to leave, not from wherever playback happens to be.
    //
    // That distinction is the whole feel of the thing. A held page can sit two
    // seconds before its exit, and a page with an embedded reel twenty; playing
    // from where we stand would make the arrow key take that long to do
    // anything. Seeking to the exit frame first costs nothing visually - it is
    // the same settled page - and the transition then begins on the keypress.
    // It also means hammering the arrow key skips intermediate transitions and
    // lands on the destination, the way a deck is expected to behave.
    const fromCue = this.cue(from);
    if (target === from + 1 && fromCue) {
      if (this.video.currentTime < fromCue.exitAt - EPSILON) await this._seek(fromCue.exitAt);
    } else {
      await this._seek(cue.enterAt);
    }
    if (this._moveToken !== token) return false;

    await this._playUntil(cue.holdAt, token);
    return true;
  }

  next() {
    return this.goTo(this.index + 1);
  }

  prev() {
    return this.goTo(this.index - 1);
  }

  first() {
    return this.goTo(1);
  }

  last() {
    return this.goTo(this.total);
  }

  // -------------------------------------------------------------- internal --

  /** @param {number} t @returns {Promise<void>} resolves when the frame is shown */
  _seek(t) {
    const video = this.video;
    if (!video) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        clearTimeout(timer);
        video.removeEventListener('seeked', done);
        resolve();
      };
      video.addEventListener('seeked', done);
      // A seek that never completes must not strand the deck.
      timer = setTimeout(done, 1200);
      try {
        video.currentTime = Math.max(0, t);
      } catch {
        done();
      }
    });
  }

  /**
   * Play from wherever we are to `stopAt`, then pause exactly on it.
   * @param {number} stopAt
   * @param {number} token
   */
  async _playUntil(stopAt, token) {
    const video = this.video;
    if (!video) return;
    this._target = stopAt;

    try {
      await video.play();
    } catch {
      // Autoplay was refused: the pre-flight click normally unlocks this. Land
      // on the destination frame anyway - a deck that does not animate is far
      // better than a deck that does not move.
      await this._seek(stopAt);
      this._afterArrival(token);
      return;
    }

    await new Promise((resolve) => {
      const arrived = async () => {
        this._stopWatching();
        video.pause();
        // Correct the overshoot. Whatever frame the decoder happened to be on
        // when we noticed, the frame we hold is the one the timeline chose.
        await this._seek(stopAt);
        resolve();
      };

      const check = () => {
        if (this._moveToken !== token) return resolve();
        if (video.currentTime >= stopAt - EPSILON) return arrived();
        if (video.ended) return arrived();
        this._watch(check);
      };
      this._watch(check);
    });

    this._afterArrival(token);
  }

  /** Once stopped on a hold: start the reel if this slide has one. */
  _afterArrival(token) {
    if (this._moveToken !== token) return;
    const cue = this.cue(this.index);
    this.dispatchEvent(new CustomEvent('arrived', { detail: { index: this.index, cue } }));
    if (cue?.loopStart !== undefined) this._startLoop(cue, token);
  }

  /**
   * A page whose content keeps moving loops between its two cue points for as
   * long as we stand on it.
   */
  async _startLoop(cue, token) {
    const video = this.video;
    if (!video) return;
    try {
      await video.play();
    } catch {
      return; // no autoplay: the frozen frame is a perfectly good slide
    }
    const check = () => {
      if (this._moveToken !== token) return;
      if (video.currentTime >= cue.loopEnd - EPSILON) {
        video.currentTime = cue.loopStart;
      }
      this._watch(check);
    };
    this._watch(check);
  }

  /**
   * Run `fn` on the next decoded video frame.
   *
   * requestVideoFrameCallback fires once per frame presented to the compositor,
   * which is the only clock accurate enough to stop on a cue point. Where it is
   * missing, rAF is close enough - it runs at display rate, so at worst it is
   * one frame late, not the eight that `timeupdate` would be.
   */
  _watch(fn) {
    const video = this.video;
    if (!video) return;
    if (typeof video.requestVideoFrameCallback === 'function') {
      this._rvfc = video.requestVideoFrameCallback(() => fn());
    } else {
      this._raf = requestAnimationFrame(() => fn());
    }
  }

  _stopWatching() {
    const video = this.video;
    if (this._rvfc && video?.cancelVideoFrameCallback) video.cancelVideoFrameCallback(this._rvfc);
    if (this._raf) cancelAnimationFrame(this._raf);
    this._rvfc = this._raf = null;
  }

  _announce(index, prev) {
    this.dispatchEvent(new CustomEvent('slidechange', { detail: { index, prev } }));
  }

  /** For the debug HUD. */
  describe() {
    const cue = this.cue(this.index);
    if (!cue) return 'timeline: -';
    const at = this.video ? this.video.currentTime.toFixed(2) : '?';
    return `timeline ${this.index}/${this.total} · canva ${cue.canvaPage} · t=${at}s · hold ${cue.holdAt}${
      cue.loopStart === undefined ? '' : ` · loop ${cue.loopStart}-${cue.loopEnd}`
    }`;
  }
}

export { TimelineDeck };
export default TimelineDeck;
