/**
 * Keep Sedemcek's own voice out of the meeting transcript - without losing the
 * human who talks over him.
 *
 * THE FAILURE THIS PREVENTS
 * -------------------------
 * Sedemcek answers through the laptop speakers. The meeting microphone hears
 * those speakers. Left alone, his own answer comes back into the transcript as
 * an anonymous "Speaker 3", and an hour later the meeting summary reports one
 * of HIS sentences as something the client said - and, worse, as something the
 * client agreed to. That is not a cosmetic bug: it is the system inventing a
 * commitment and attributing it to a real person in a real meeting.
 *
 * THE TENSION
 * -----------
 * The blunt fix - discard everything the microphone hears while he is speaking
 * - breaks barge-in. Interrupting him with "Hey Seven, kaj pa cena?" is a
 * supported and frequently used gesture; blanking the transcript for the whole
 * of every answer would delete exactly the sentences a presenter cares most
 * about, and leave a minute-long hole around each one.
 *
 * THE RESOLUTION
 * --------------
 * We know EXACTLY what Sedemcek said, word for word, from our own interaction
 * log - we do not have to guess. So a segment recorded while he was speaking is
 * dropped only when its words are HIS words; anything else recorded in that
 * same window is a human talking over him and is kept, flagged
 * `duringAssistantSpeech` so the transcript view and the summary prompt both
 * know the microphone was contested at that moment.
 *
 * And structurally, the assistant is never a speaker at all: his utterances
 * live in interactions.jsonl, and every prompt that sees them labels them as
 * the assistant. Even a segment this filter misses cannot become "the client
 * agreed", because the summary prompt is told, explicitly, which text is his.
 *
 * Pure functions, no I/O, no network - all of this is testable without a
 * meeting, which is the only way a rule this important stays true.
 */

/** Strip diacritics and punctuation. Same rules as server/cache.js. */
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text) {
  return normalize(text).split(' ').filter(Boolean);
}

/**
 * How much of `candidate` is accounted for by `reference`.
 *
 * Deliberately asymmetric: the question is not "are these the same sentence"
 * but "is everything in this heard fragment something he had just said". A
 * three-word echo of a forty-word answer must score 1.0, because it IS his -
 * the microphone simply caught a piece of it.
 *
 * Word multiplicity is respected (a bag, not a set), so a heard fragment that
 * repeats a word he used once does not get full credit for both.
 *
 * @param {string} candidate the text the microphone produced
 * @param {string} reference what the assistant actually said
 * @returns {number} 0..1
 */
export function coverage(candidate, reference) {
  const cand = words(candidate);
  if (!cand.length) return 0;
  const pool = new Map();
  for (const w of words(reference)) pool.set(w, (pool.get(w) || 0) + 1);

  let hit = 0;
  for (const w of cand) {
    const left = pool.get(w) || 0;
    if (left > 0) {
      pool.set(w, left - 1);
      hit++;
    }
  }
  return hit / cand.length;
}

/**
 * The windows during which the assistant's voice was in the room.
 *
 * `spokeUntil` is stamped by the browser when playback actually ends; when it
 * is missing (an answer cut short by a crash, an older record) the window is
 * estimated from the length of the answer at a measured speaking rate, with a
 * floor and a ceiling. An estimate is the right behaviour here: the cost of a
 * window that is slightly too long is one flagged human segment, and the cost
 * of no window at all is his voice entering the transcript as a client.
 *
 * @param {Array} interactions from interactions.jsonl
 * @returns {Array<{fromMs:number,toMs:number,text:string}>}
 */
export function assistantWindows(interactions = []) {
  const WORDS_PER_MS = 1.9 / 1000; // the same measured rate the answer budget uses
  const MIN_MS = 1500;
  const MAX_MS = 60_000;
  const PAD_MS = 900; // room reverb, and the tail of the last syllable

  return (interactions || [])
    .filter((i) => i && i.answer)
    .map((i) => {
      const fromMs = Math.max(0, Number(i.ms) || 0);
      let toMs;
      if (i.spokeUntil && i.t) {
        const span = new Date(i.spokeUntil) - new Date(i.t);
        toMs = Number.isFinite(span) && span > 0 ? fromMs + span : null;
      }
      if (toMs == null) {
        const n = words(i.answer).length;
        toMs = fromMs + Math.min(MAX_MS, Math.max(MIN_MS, Math.round(n / WORDS_PER_MS)));
      }
      return { fromMs, toMs: toMs + PAD_MS, text: i.answer };
    })
    .sort((a, b) => a.fromMs - b.fromMs);
}

/**
 * How much of a heard segment has to be the assistant's words before it is
 * treated as his echo rather than a person.
 *
 * 0.7 rather than 0.9 because a recogniser hearing a loudspeaker mangles a
 * word or two in every sentence; 0.7 rather than 0.5 because a human agreeing
 * with him ("da, to bi bilo koristno") legitimately reuses several of his
 * words and must survive. Short fragments are held to a stricter standard
 * below, where a coincidence is much cheaper to produce.
 */
export const ECHO_COVERAGE = 0.7;
export const ECHO_COVERAGE_SHORT = 0.95;
const SHORT_WORDS = 4;

/**
 * Split incoming meeting segments into what to keep and what to drop.
 *
 * Never mutates its input. The returned `kept` segments carry
 * `duringAssistantSpeech` so a downstream reader knows the assistant held the
 * floor when they were recorded - which is exactly the marker the barge-in
 * case needs, and exactly what the summary prompt uses to stay careful.
 *
 * @param {Array} segments incoming candidates, each with `ms` and `text`
 * @param {Array} interactions the assistant interaction log for this session
 * @returns {{kept:Array, dropped:Array}}
 */
export function filterAssistantEcho(segments = [], interactions = []) {
  const windows = assistantWindows(interactions);
  const kept = [];
  const dropped = [];

  for (const raw of segments || []) {
    if (!raw || !raw.text) continue;
    const ms = Math.max(0, Number(raw.ms) || 0);
    const endMs = ms + (Number(raw.durationMs) || 0);

    // Every assistant utterance whose voice overlapped this segment at all.
    const overlapping = windows.filter((w) => endMs >= w.fromMs && ms <= w.toMs);
    if (!overlapping.length) {
      kept.push({ ...raw, duringAssistantSpeech: false });
      continue;
    }

    const n = words(raw.text).length;
    const threshold = n <= SHORT_WORDS ? ECHO_COVERAGE_SHORT : ECHO_COVERAGE;
    const best = Math.max(...overlapping.map((w) => coverage(raw.text, w.text)));

    if (best >= threshold) {
      dropped.push({ ...raw, reason: 'assistant_echo', coverage: Number(best.toFixed(3)) });
    } else {
      // A human speaking over him. This is the barge-in case, and it must
      // survive verbatim - it is often the most important line in the meeting.
      kept.push({ ...raw, duringAssistantSpeech: true });
    }
  }

  return { kept, dropped };
}
