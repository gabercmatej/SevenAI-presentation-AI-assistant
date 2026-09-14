/**
 * The rolling meeting memory - the reason a 70-minute meeting does not make
 * Sedemcek slower than a 5-minute one.
 *
 * THE PROBLEM IT SOLVES
 * ---------------------
 * The obvious way to let him answer "kaj smo se do zdaj dogovorili?" is to put
 * the meeting transcript in the prompt. After an hour that is ~8000 words of
 * mostly irrelevant conversation on every single question: seconds of extra
 * time-to-first-token on a path budgeted at 1.4 s, a cost that grows with the
 * length of the meeting, and - worst of the three - a prompt in which the
 * current slide, the thing that actually disambiguates most questions, is now
 * 2 % of the context instead of a highlighted block.
 *
 * THE SHAPE OF THE FIX
 * --------------------
 * Keep a small structured summary of the meeting so far, updated in the
 * BACKGROUND as transcript accumulates, and give the answer path that instead.
 * Two properties matter more than the exact prompt:
 *
 *  1. **It is bounded.** Every list is capped, every entry is capped, and the
 *     RENDERED BLOCK is capped too (RENDER_BUDGET below) - the last of those
 *     because the first two bound the memory by entry count, not by size, and
 *     62 maximum-length entries would be about 15 kB of uncached prompt on
 *     every question. So: ~4-6 kB in practice, never more than 6 kB by
 *     construction, whether the meeting ran ten minutes or two hours. The live
 *     answer path's cost stops depending on the length of the meeting.
 *
 *  2. **It is never on the critical path.** An update is triggered by
 *     transcript arriving, runs on the server, and writes a file. /api/ask
 *     READS the current memory.json and never waits for an update to finish.
 *     A memory update that is slow, or fails, or is still running, costs the
 *     room exactly nothing - the answer is composed from the last good one.
 *
 * WHAT GOES IN IT
 * ---------------
 * Only things a presenter would want repeated back: decisions, commitments,
 * open questions, what the client showed interest in, what they objected to,
 * and facts they supplied. Deliberately NOT a narrative - a narrative is what
 * the end-of-meeting summary is for, and a narrative cannot be capped without
 * losing the beginning of the meeting first.
 *
 * FACT VERSUS INFERENCE
 * ---------------------
 * Every entry carries the timestamp it came from, and the prompt below refuses
 * anything that is not supported by the transcript slice it was given. Nothing
 * in this file may invent an owner, and "AI suggestion" has no representation
 * here at all - suggestions exist only in the final intelligence, in their own
 * clearly separated field.
 */
import { complete, isAnthropicConfigured, isOpenAiLlmConfigured, memoryModel } from './llm.js';

export const MEMORY_VERSION = 1;

/** The lists, and how many entries each may hold. */
const CAPS = Object.freeze({
  decisions: 12,
  commitments: 12,
  openQuestions: 10,
  clientInterests: 8,
  objections: 8,
  importantFacts: 12,
});

const TEXT_MAX = 220;
const OWNERS = new Set(['seven', 'client', 'unknown']);

/**
 * The hard ceiling on the rendered block, in characters.
 *
 * The per-list caps above bound the memory by ENTRY COUNT, which is what makes
 * its size independent of how long the meeting ran - the important property.
 * They do not bound it by SIZE: 62 entries of 220 characters each is about
 * 15 kB, roughly 4000 uncached tokens on every single question, which is
 * exactly the cost this module exists to avoid.
 *
 * In practice a model writing one short sentence per entry lands around 4-6 kB
 * and never approaches that. But "in practice" is not a bound, and a prompt
 * budget that only holds while the model is well behaved is not a budget. So
 * the ceiling is enforced, by trimming, in the order below.
 */
const RENDER_BUDGET = 6000;

/**
 * What gets dropped first when the memory does not fit.
 *
 * Least to most valuable, and the order is a judgement about a meeting rather
 * than about data: a fact the client mentioned is useful, an interest is a
 * hint, but a DECISION and a COMMITMENT are the two things a presenter
 * actually came away with. Those two are trimmed last, and within every list
 * the OLDEST entries go first - the end of a meeting is where the decisions
 * are.
 */
const TRIM_ORDER = ['importantFacts', 'clientInterests', 'objections', 'openQuestions', 'commitments', 'decisions'];

/** A memory for a meeting nothing has been said in yet. */
export function emptyMemory() {
  return {
    version: MEMORY_VERSION,
    updatedAt: null,
    // How far into the meeting this memory accounts for. Everything after it
    // is still only in the transcript.
    coveredUntilMs: 0,
    coveredUntil: null,
    segmentsSeen: 0,
    updates: 0,
    decisions: [],
    commitments: [],
    openQuestions: [],
    clientInterests: [],
    objections: [],
    importantFacts: [],
  };
}

function clean(value, max = TEXT_MAX) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Two entries are "the same" when their content words are - not their wording. */
function key(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 8)
    .join(' ');
}

/**
 * Coerce whatever the model returned into the documented shape.
 *
 * Nothing here trusts the model: a missing list becomes an empty one, an entry
 * with no text is dropped, an owner outside the three allowed values becomes
 * `unknown` rather than being invented, and every list is capped. A malformed
 * response degrades the memory to "slightly less complete", never to broken.
 *
 * @param {object} raw whatever came back
 * @param {object} previous the memory being replaced, for the fields the model does not own
 */
export function normalizeMemory(raw, previous = emptyMemory()) {
  const base = { ...emptyMemory(), ...previous };
  const out = {
    version: MEMORY_VERSION,
    updatedAt: new Date().toISOString(),
    coveredUntilMs: base.coveredUntilMs,
    coveredUntil: base.coveredUntil,
    segmentsSeen: base.segmentsSeen,
    updates: (Number(base.updates) || 0) + 1,
  };

  for (const [field, cap] of Object.entries(CAPS)) {
    const list = Array.isArray(raw?.[field]) ? raw[field] : [];
    const seen = new Set();
    const kept = [];
    for (const entry of list) {
      const text = clean(typeof entry === 'string' ? entry : entry?.text);
      if (!text) continue;
      const k = key(text);
      if (!k || seen.has(k)) continue;
      seen.add(k);

      const item = { text };
      const at = clean(entry?.at, 12);
      if (at) item.at = at;
      const slide = Number(entry?.slide);
      if (Number.isFinite(slide) && slide > 0) item.slide = Math.round(slide);

      if (field === 'commitments') {
        const owner = String(entry?.owner || '').toLowerCase();
        // NEVER guess. An unstated owner stays unstated - a summary that
        // assigns a task to a client who never accepted it is worse than one
        // that says nobody was named.
        item.owner = OWNERS.has(owner) ? owner : 'unknown';
      }
      if (field === 'clientInterests') {
        const weight = Number(entry?.weight);
        item.weight = Number.isFinite(weight) && weight > 0 ? Math.min(99, Math.round(weight)) : 1;
      }
      kept.push(item);
      if (kept.length >= cap) break;
    }
    out[field] = kept;
  }
  return enforceBudget(out);
}

/**
 * Trim the memory until the block it renders to fits RENDER_BUDGET.
 *
 * Almost always a no-op - a normal meeting's memory is well under the ceiling -
 * so the loop below costs one render on the common path. When it does fire, it
 * drops from the least valuable list first and from the oldest end of it, so
 * what survives is the recent, decision-shaped half of the meeting.
 *
 * Exported for the tests: a bound nobody can check is not a bound.
 */
export function enforceBudget(memory, budget = RENDER_BUDGET) {
  const out = { ...memory };
  let guard = 0;
  while (renderMemory(out).length > budget && guard++ < 200) {
    const field = TRIM_ORDER.find((f) => out[f]?.length);
    if (!field) break; // everything is empty and it still does not fit - nothing left to do
    out[field] = out[field].slice(1);
  }
  return out;
}

/** Roughly how big the memory block is in a prompt. Shown in diagnostics. */
export function memorySizeChars(memory) {
  return renderMemory(memory).length;
}

/**
 * The memory, as it appears in a prompt.
 *
 * Rendered as labelled lines rather than raw JSON: a model reading prose
 * follows the "do not invent" instruction more reliably than one reading a
 * schema it may feel invited to fill in. Empty sections are omitted entirely -
 * an empty list in a prompt is an invitation to populate it.
 */
export function renderMemory(memory) {
  const m = { ...emptyMemory(), ...(memory || {}) };
  const lines = [];
  const section = (title, list, fmt) => {
    if (!list?.length) return;
    lines.push(title);
    for (const e of list) lines.push(`- ${fmt(e)}`);
    lines.push('');
  };

  const stamp = (e) => (e.at ? ` (${e.at}${e.slide ? `, slide ${e.slide}` : ''})` : e.slide ? ` (slide ${e.slide})` : '');

  section('DOGOVORJENO:', m.decisions, (e) => `${e.text}${stamp(e)}`);
  section('NASLEDNJI KORAKI:', m.commitments, (e) => {
    const who = e.owner === 'seven' ? 'Seven' : e.owner === 'client' ? 'Naročnik' : 'ni določeno';
    return `${e.text} — nosilec: ${who}${stamp(e)}`;
  });
  section('ODPRTA VPRAŠANJA:', m.openQuestions, (e) => `${e.text}${stamp(e)}`);
  section('ZANIMANJE NAROČNIKA:', m.clientInterests, (e) => `${e.text}${e.weight > 1 ? ` (${e.weight}×)` : ''}`);
  section('POMISLEKI IN UGOVORI:', m.objections, (e) => `${e.text}${stamp(e)}`);
  section('POMEMBNA DEJSTVA:', m.importantFacts, (e) => `${e.text}${stamp(e)}`);

  if (!lines.length) return 'SPOMIN SESTANKA: zaenkrat še ni zabeleženih dogovorov ali odprtih vprašanj.';
  return ['SPOMIN SESTANKA (kaj se je na tem sestanku že zgodilo):', '', ...lines].join('\n').trim();
}

// ------------------------------------------------------------- triggering ---

/**
 * When to spend a model call on an update.
 *
 * The brief says "do not run an expensive LLM request after every sentence"
 * and "use sensible batching". These are the four triggers, in the order they
 * matter:
 *
 *  - enough NEW WORDS have accumulated to be worth reading (the common case);
 *  - enough TIME has passed with at least something new, so a slow, quiet
 *    conversation still gets folded in before it is forgotten;
 *  - an ASSISTANT INTERACTION just happened - a question to Sedemcek almost
 *    always follows something worth remembering, and the presenter may well
 *    ask "what did we agree" moments later;
 *  - the meeting is ENDING, where the cost no longer matters and completeness
 *    does.
 *
 * At a normal speaking rate the first trigger fires roughly every 2-3 minutes,
 * so a one-hour meeting costs ~20-25 cheap calls in total - all of them in the
 * background, none of them in front of the room.
 */
export const TRIGGER = Object.freeze({
  NEW_CHARS: 1200,
  MIN_CHARS: 200,
  ELAPSED_MS: 4 * 60_000,
  AFTER_INTERACTION_CHARS: 400,
});

/**
 * @param {{memory:object, segments:Array, lastRunAt?:number, now?:number,
 *          interactionSince?:boolean, ending?:boolean}} opts
 * @returns {{due:boolean, reason:string, newSegments:Array}}
 */
export function updateDue({ memory, segments = [], lastRunAt = 0, now = Date.now(), interactionSince = false, ending = false }) {
  const m = { ...emptyMemory(), ...(memory || {}) };
  const fresh = segments.filter((s) => s.ms > m.coveredUntilMs);
  const chars = fresh.reduce((n, s) => n + s.text.length, 0);

  if (!fresh.length) return { due: false, reason: 'nothing_new', newSegments: fresh };
  if (ending) return { due: true, reason: 'session_ending', newSegments: fresh };
  if (chars >= TRIGGER.NEW_CHARS) return { due: true, reason: 'new_transcript', newSegments: fresh };
  if (interactionSince && chars >= TRIGGER.AFTER_INTERACTION_CHARS) {
    return { due: true, reason: 'after_interaction', newSegments: fresh };
  }
  if (lastRunAt && now - lastRunAt >= TRIGGER.ELAPSED_MS && chars >= TRIGGER.MIN_CHARS) {
    return { due: true, reason: 'elapsed', newSegments: fresh };
  }
  return { due: false, reason: 'below_threshold', newSegments: fresh };
}

// ---------------------------------------------------------------- the call --

const SYSTEM = [
  'Si zapisnikar na poslovnem sestanku. Tvoja edina naloga je vzdrževati kratek,',
  'strukturiran zapis tega, kar se je na sestanku DEJANSKO zgodilo.',
  '',
  'ŽELEZNA PRAVILA:',
  '1. Ničesar si ne izmišljuj. Vsak vnos mora imeti oporo v prepisu, ki ga dobiš.',
  '2. Dogovor je samo tisto, s čimer sta se strani izrecno strinjali. Predlog, ideja',
  '   ali vprašanje NI dogovor.',
  '3. Nosilca naloge ne ugibaj. Če ni bilo izrecno povedano, kdo nekaj naredi,',
  '   je owner "unknown".',
  '4. Vrstice, označene z ASISTENT, je izgovoril virtualni asistent, ne človek.',
  '   Njegove besede niso izjave naročnika in nikoli niso dogovor.',
  '5. Odgovori IZKLJUČNO z veljavnim JSON objektom, brez razlage in brez oznak.',
  '',
  'Vrni celoten posodobljen zapis (star + nov), ne samo novosti. Vsak vnos naj bo',
  'en kratek stavek v slovenščini. Polje "at" je čas iz prepisa (npr. "14:22:10").',
  '',
  'Shema:',
  '{"decisions":[{"text":"","at":"","slide":0}],',
  ' "commitments":[{"text":"","owner":"seven|client|unknown","at":"","slide":0}],',
  ' "openQuestions":[{"text":"","at":""}],',
  ' "clientInterests":[{"text":"","weight":1}],',
  ' "objections":[{"text":"","at":""}],',
  ' "importantFacts":[{"text":"","at":""}]}',
].join('\n');

/** Pull the first JSON object out of a model response that may have wrapped it. */
export function parseJsonObject(text) {
  const s = String(text || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Is there any model at all to update the memory with? */
export function isConfigured() {
  return isAnthropicConfigured() || isOpenAiLlmConfigured();
}

/**
 * Build the user turn: the memory so far, plus ONLY the new transcript.
 *
 * This is the property that makes the whole design work - the input to an
 * update is O(new speech), not O(meeting). The tenth update of a long meeting
 * costs the same as the first.
 */
export function buildUpdatePrompt({ memory, newSegments, interactions = [] }) {
  const lines = [];
  lines.push('ZAPIS DO ZDAJ (posodobi ga):');
  lines.push(JSON.stringify(pickLists(memory), null, 1));
  lines.push('');
  lines.push('NOV DEL PREPISA:');
  for (const s of newSegments) {
    const slide = s.slide ? ` · slide ${s.slide}` : '';
    lines.push(`[${s.clock}${slide}] ${s.speaker}: ${s.text}`);
  }
  if (interactions.length) {
    lines.push('');
    lines.push('KAJ JE V TEM ČASU POVEDAL ASISTENT (ni izjava naročnika, ni dogovor):');
    for (const i of interactions) {
      if (i.question) lines.push(`[${i.clock}] VPRAŠANJE PREDSTAVITELJA: ${i.question}`);
      if (i.answer) lines.push(`[${i.clock}] ASISTENT: ${i.answer.slice(0, 500)}`);
    }
  }
  lines.push('');
  lines.push('Vrni posodobljen JSON zapis.');
  return lines.join('\n');
}

function pickLists(memory) {
  const m = { ...emptyMemory(), ...(memory || {}) };
  return {
    decisions: m.decisions,
    commitments: m.commitments,
    openQuestions: m.openQuestions,
    clientInterests: m.clientInterests,
    objections: m.objections,
    importantFacts: m.importantFacts,
  };
}

/**
 * Run one update. Returns the new memory, or null when nothing could be done -
 * a null is always safe here: the caller keeps the previous memory, and the
 * live answer path never notices.
 *
 * @param {{memory:object, newSegments:Array, interactions?:Array, signal?:AbortSignal}} opts
 */
export async function updateMemory({ memory, newSegments, interactions = [], signal }) {
  if (!isConfigured() || !newSegments?.length) return null;

  const previous = { ...emptyMemory(), ...(memory || {}) };

  const { text } = await complete({
    system: SYSTEM,
    user: buildUpdatePrompt({ memory: previous, newSegments, interactions }),
    maxTokens: 1600,
    signal,
    model: memoryModel(),
  });

  const parsed = parseJsonObject(text);
  if (!parsed) {
    console.warn('[memory] model did not return usable JSON - keeping the previous memory');
    return null;
  }

  const last = newSegments[newSegments.length - 1];
  const next = normalizeMemory(parsed, previous);
  next.coveredUntilMs = Math.max(previous.coveredUntilMs, last.ms);
  next.coveredUntil = last.clock || previous.coveredUntil;
  next.segmentsSeen = (Number(previous.segmentsSeen) || 0) + newSegments.length;
  return next;
}
