/**
 * Finding the part of a meeting a question is about - without a vector store.
 *
 * WHY NOT EMBEDDINGS
 * ------------------
 * The whole application already declines RAG for the knowledge base, for a
 * reason that applies here with more force, not less: a one-hour meeting is
 * about 8000 words - roughly 12 kB - and a linear scan over it takes under a
 * millisecond. An embedding index would add an index-build step, a second
 * store to keep in sync with an append-only transcript, a network call on the
 * one code path that must keep working when the network is the thing that
 * failed, and a whole class of "the index is stale" bugs. It would buy
 * accuracy we cannot measure at this size.
 *
 * So: normalised keyword overlap, weighted by how rare a word is in THIS
 * meeting (a crude idf), plus neighbour expansion so a hit arrives with the
 * exchange around it rather than as one orphaned line. Same family of
 * technique as server/cache.js, same reasons.
 *
 * Everything here is pure. No fs, no fetch.
 */

/** Slovenian stop words. Same list as the answer cache, plus meeting filler. */
const STOP = new Set([
  'in', 'ali', 'je', 'so', 'da', 'na', 'v', 'za', 'z', 's', 'k', 'h', 'o', 'po',
  'pri', 'od', 'do', 'se', 'si', 'ki', 'kaj', 'kako', 'kje', 'kdaj', 'zakaj',
  'kdo', 'bi', 'bo', 'smo', 'ste', 'sem', 'ni', 'ne', 'to', 'ta', 'te', 'ti',
  'tega', 'tem', 'the', 'a', 'lahko', 'tudi', 'pa', 'kot', 'ce', 'ker',
  'nam', 'nas', 'vam', 'vas', 'mi', 'vi', 'oni', 'bil', 'bila', 'bilo', 'ima',
  'imate', 'imamo', 'bodo', 'boste', 'bomo', 'sta', 'ju', 'jih', 'jo', 'ga',
  'no', 'pac', 'sej', 'ja', 'jaz', 'zdaj', 'potem', 'samo', 'zelo', 'res',
]);

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

/**
 * Content words only, crudely stemmed.
 *
 * Slovenian inflects heavily and a retriever that matches on exact word forms
 * finds almost nothing: someone asks *"ali smo govorili o ceni?"* and the line
 * that answers it says *"cena pa bo odvisna od obsega"*. Two forms of the same
 * word, no match, and the presenter is told the meeting never discussed price.
 *
 * Two cheap rules, in this order, cover the common cases without a
 * morphological analyser we would then have to maintain:
 *
 *   - truncate anything over five characters, which collapses the long
 *     endings ("integracija" / "integracije" / "integracijo" -> "integ");
 *   - then drop a trailing vowel, which collapses the short ones the
 *     truncation cannot reach ("cena" / "ceni" -> "cen").
 *
 * Over-stemming is the acceptable direction of error here: a false match costs
 * one irrelevant line in a result set that is scored by rarity and expanded to
 * its neighbours anyway, while a missed match costs the answer.
 */
export function terms(text) {
  return normalize(text)
    .split(' ')
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => {
      const stem = w.length > 5 ? w.slice(0, 5) : w;
      return stem.length >= 4 ? stem.replace(/[aeiou]$/, '') : stem;
    });
}

/**
 * Score every segment against the question, then return the best ones together
 * with their neighbours, in chronological order.
 *
 * @param {Array} segments the meeting transcript
 * @param {string} question
 * @param {{limit?:number, neighbours?:number, maxChars?:number}} [opts]
 * @returns {Array} the selected segments, chronological, each with `score`
 */
export function searchTranscript(segments = [], question = '', opts = {}) {
  const { limit = 12, neighbours = 2, maxChars = 6000 } = opts;
  const list = Array.isArray(segments) ? segments : [];
  if (!list.length) return [];

  const q = terms(question);
  if (!q.length) return [];

  // How many segments each term appears in - a rare word in this meeting is a
  // much stronger signal than one the presenter said forty times.
  const df = new Map();
  const perSegment = list.map((s) => {
    const set = new Set(terms(s.text));
    for (const w of set) df.set(w, (df.get(w) || 0) + 1);
    return set;
  });
  const n = list.length;

  const scored = [];
  for (let i = 0; i < n; i++) {
    let score = 0;
    for (const w of q) {
      if (!perSegment[i].has(w)) continue;
      score += Math.log(1 + n / (1 + (df.get(w) || 0)));
    }
    if (score > 0) scored.push({ i, score });
  }
  if (!scored.length) return [];

  scored.sort((a, b) => b.score - a.score || a.i - b.i);

  // Expand each hit into its neighbourhood: a question and its answer are two
  // segments, and returning only the one that matched loses half the exchange.
  const chosen = new Map();
  for (const { i, score } of scored.slice(0, limit)) {
    for (let j = Math.max(0, i - neighbours); j <= Math.min(n - 1, i + neighbours); j++) {
      const existing = chosen.get(j) || 0;
      chosen.set(j, Math.max(existing, j === i ? score : score * 0.25));
    }
  }

  const out = [...chosen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, score]) => ({ ...list[i], score: Number(score.toFixed(3)) }));

  // Hard character cap, trimmed from the LOWEST-scoring end so the strongest
  // evidence is what survives, then put back in order.
  let total = out.reduce((sum, s) => sum + s.text.length, 0);
  if (total <= maxChars) return out;

  const byScore = out.slice().sort((a, b) => a.score - b.score);
  const drop = new Set();
  for (const s of byScore) {
    if (total <= maxChars) break;
    drop.add(s);
    total -= s.text.length;
  }
  return out.filter((s) => !drop.has(s));
}

/**
 * The last few minutes of the meeting - the "recent window" every live answer
 * gets, in place of the full transcript.
 *
 * @param {Array} segments
 * @param {{minutes?:number, maxSegments?:number, maxChars?:number, nowMs?:number}} [opts]
 */
export function recentWindow(segments = [], opts = {}) {
  const { minutes = 4, maxSegments = 20, maxChars = 2500 } = opts;
  const list = Array.isArray(segments) ? segments : [];
  if (!list.length) return [];

  const nowMs = opts.nowMs != null ? opts.nowMs : list[list.length - 1].ms;
  const floor = nowMs - minutes * 60_000;

  const out = [];
  let chars = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (s.ms < floor) break;
    if (out.length >= maxSegments || chars + s.text.length > maxChars) break;
    out.push(s);
    chars += s.text.length;
  }
  return out.reverse();
}

/**
 * Is this question about the MEETING rather than about the presentation?
 *
 * "Kako bi to povezali s CRM-jem?" is a question about the product and is
 * answered from the deck. "Kaj smo se glede CRM-ja dogovorili?" is a question
 * about the room and can only be answered from the transcript. Both mention
 * CRM; only the second one should pull in meeting evidence and be told to
 * answer in the past tense about what was said.
 *
 * Deliberately a phrase list rather than a model call, for the same reason
 * nav-intent.js is: this runs before every answer, on the latency path, and a
 * wrong classification here is cheap (the memory block travels with every
 * question anyway) while a network round-trip to decide it is not.
 *
 * @param {string} question
 * @returns {boolean}
 */
export function isMeetingQuestion(question) {
  const q = normalize(question);
  if (!q) return false;
  return [
    // what was agreed / said / discussed. "zmeniti se" is the everyday twin of
    // "dogovoriti se" and is what people actually say out loud, so leaving it
    // out meant "povej vse, kar smo se zmenili" fetched no transcript at all.
    /\bsmo se (danes |do zdaj |do sedaj |zdaj )?(dogovoril|zmenil|uskladil|strinjal)/,
    /\bdogovorjen|\bzmenjen/,
    /\bsmo (se )?(danes |do zdaj |do sedaj )?(rekli|govorili|omenili|obljubili|uskladili)/,
    /\bso (rekli|povedali|omenili|vprasali|izpostavili)\b/,
    /\bje bilo (glavno|kljucno|najbolj)/,
    /\bkaj smo\b/,
    /\bkaj so\b/,
    // what is still open / what we must do
    /\bse moramo\b|\bmoramo (preveriti|pripraviti|poslati|narediti)\b/,
    /\bmora (seven|sedem)\b/,
    // Slovene puts the adjective on either side of the noun, so both orders
    // have to count: "odprta vprašanja" and "katera vprašanja so še odprta".
    /\bodprt\w*\s+vprasanj/,
    /\bvprasanj\w*(?:\s+\w+){0,3}\s+odprt/,
    /\bnaslednji korak/,
    // meta: summarise this meeting
    /\bpovzemi\b|\bpovzetek (sestanka|tega sestanka|srecanja)\b/,
    /\bna (tem )?sestanku\b|\bdanes na sestanku\b/,
    /\bdo zdaj\b|\bdo sedaj\b/,
    /\bali smo (govorili|omenili|se dogovorili)/,
    /\bjih je (najbolj )?zanimal/,
  ].some((re) => re.test(q));
}

/**
 * Render segments for a prompt.
 *
 * The slide is printed as a bracketed metadata prefix, never merged into the
 * spoken words, and the "assistant was speaking" flag is printed too - a model
 * reading this must be able to tell a contested moment from a clean one.
 *
 * @param {Array} segments
 * @returns {string}
 */
export function renderSegments(segments = []) {
  return (segments || [])
    .map((s) => {
      const slide = s.slide ? ` · slide ${s.slide}` : '';
      const over = s.duringAssistantSpeech ? ' · med govorom asistenta' : '';
      return `[${s.clock || ''}${slide}${over}] ${s.speaker || 'Speaker ?'}: ${s.text}`;
    })
    .join('\n');
}
