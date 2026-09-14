/**
 * Who the assistant says it is, and what it says when it introduces itself.
 *
 * ONE IDENTITY. The assistant is SevenAI in every deck. A deck's
 * `assistantName` may still name something else on purpose, but the legacy
 * default "Sedemček" (every deck imported before the rename carries it, and
 * cached cloud versions cannot be rewritten) resolves to SevenAI here.
 *
 * ONE INTRODUCTION RULE, used both for the automatic greeting and for a spoken
 * "Predstavi se" that no scripted answer caught:
 *   1. a scripted answer for the introduction cue   (presenter wrote it)
 *   2. the presentation's own greeting              (greeting.text / greeting.txt)
 *   3. the global default greeting                  (knowledge/global, "## PRIVZETI POZDRAV")
 *
 * Pure functions: no file system, no network - see tests/greeting.test.js.
 */

export const ASSISTANT_NAME = 'SevenAI';

/** Heading in knowledge/global whose `>` lines are the default greeting. */
export const DEFAULT_GREETING_HEADING = 'PRIVZETI POZDRAV';

/** The thresholds server.js uses for scripted answers. */
export const SCRIPTED_MIN_SCORE = 0.62;
export const SCRIPTED_MIN_COVERAGE = 0.7;

/** Cues a scripted introduction entry is looked up by. */
const INTRO_CUES = ['Predstavi se', 'Kdo si'];

function fold(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * @param {unknown} raw presentation.json `assistantName`
 * @returns {string} the name the assistant speaks under
 */
export function resolveAssistantName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return ASSISTANT_NAME;
  const compact = fold(name).replace(/ /g, '');
  if (compact === 'sedemcek' || compact === 'sedemcekai') return ASSISTANT_NAME;
  return name;
}

/**
 * The default greeting from the global knowledge text: the `>` lines under
 * "## PRIVZETI POZDRAV", up to the next heading or file marker.
 * @param {string} text
 * @returns {string|null}
 */
export function extractDefaultGreeting(text) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${DEFAULT_GREETING_HEADING}\\s*$`, 'i').test(l.trim()));
  if (start < 0) return null;
  const quoted = [];
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (/^#{1,6}\s/.test(t) || /^-{5} .* -{5}$/.test(t)) break;
    if (t.startsWith('>')) quoted.push(t.replace(/^>\s?/, ''));
  }
  const greeting = quoted.join(' ').replace(/\s+/g, ' ').trim();
  return greeting || null;
}

const INTRO_PATTERNS = [
  // predstavi se / predstavite se / predstaviš se nam na kratko
  /^predstavi(?:s|te)?\s+(?:(?:nam|vsem)\s+)?se(?:\s+(?:nam|vsem|prosim|na kratko|na hitro))*$/,
  // se predstaviš / a se lahko predstaviš / bi se nam predstavil
  /^(?:(?:a|ali|bi|lahko|mi|nam)\s+)*se\s+(?:(?:nam|vsem|lahko)\s+)*predstavi(?:s|l|la|te)?(?:\s+(?:nam|vsem|prosim|na kratko|na hitro))*$/,
  /^kdo\s+(?:pa\s+)?si(?:\s+ti)?$/,
  /^kako\s+ti\s+je\s+ime$/,
  /^introduce\s+yourself$/,
];

/**
 * Is this utterance a request for the assistant to introduce itself? Strict:
 * "Predstavi nam rešitev" is a question about the deck, not about him.
 * @param {string} question
 */
export function isIntroductionRequest(question) {
  const s = fold(question)
    .replace(/^(?:hej|hey|zivjo|oj|ok|okej|halo|prosim)\s+/, '')
    .replace(/^(?:sevenai|seven ai|sedemcek\w*|seven)\s+/, '')
    .replace(/^(?:hej|hey|zivjo|oj)\s+/, '')
    .replace(/\s+(?:prosim|hvala)$/, '')
    .trim();
  return INTRO_PATTERNS.some((re) => re.test(s));
}

/**
 * What the assistant says to introduce itself - see the priority at the top.
 * @param {{answerCache?:{match:Function}|null, greetingText?:string|null, globalGreeting?:string|null}} input
 * @returns {{text:string, source:'scripted'|'presentation'|'global', id:string|null, audio:string|null}}
 */
export function resolveIntroduction({ answerCache = null, greetingText = null, globalGreeting = null } = {}) {
  for (const cue of INTRO_CUES) {
    const hit = answerCache?.match?.(cue, SCRIPTED_MIN_SCORE, { scriptedOnly: true, minCoverage: SCRIPTED_MIN_COVERAGE });
    const text = String(hit?.answer || '').trim();
    if (text) return { text, source: 'scripted', id: hit.id || null, audio: hit.audio || null };
  }
  const deck = String(greetingText || '').trim();
  if (deck) return { text: deck, source: 'presentation', id: null, audio: null };
  const global = String(globalGreeting || '').trim();
  return { text: global || `Pozdravljeni. Sem ${ASSISTANT_NAME}.`, source: 'global', id: null, audio: null };
}

/**
 * The /api/ask answer for an introduction request that no scripted answer
 * matched directly, shaped like an answer-cache hit - or null.
 * @param {{introduction?:{text:string, source:string, id:string|null, audio:string|null}}} presentation
 * @param {string} question
 */
export function introductionAnswer(presentation, question) {
  const intro = presentation?.introduction;
  if (!intro?.text || !isIntroductionRequest(question)) return null;
  return { id: intro.id || `introduction-${intro.source}`, answer: intro.text, audio: intro.audio || null, score: 1, source: intro.source };
}
