/**
 * What a finished meeting turns into.
 *
 * Not "a summary". One generic paragraph is what everybody already gets from
 * every meeting tool and it is not what a salesperson needs the morning after.
 * The useful artefact is a set of clearly separated answers to clearly
 * separated questions: what was decided, who owes what, what is still open,
 * what they leaned in on, what they pushed back on, what they told us.
 *
 * THE ONE RULE THAT MATTERS
 * -------------------------
 * A model asked to summarise a sales meeting will, unprompted, produce a tidy
 * list of next steps that reads beautifully and contains two things nobody
 * said. In a document a salesperson takes into the next meeting, that is not
 * a rough edge - it is a fabricated commitment attributed to a real client.
 *
 * So the fact/inference boundary is structural, not stylistic:
 *
 *  - `decisions`, `nextSteps`, `openQuestions`, `objections`, `importantFacts`
 *    and `clientInterests` may contain ONLY what the transcript supports, and
 *    each carries the timestamp it came from so it can be checked in one click;
 *  - `followUpSuggestions` is the ONLY field allowed to be the model's own
 *    idea, it is generated from a separate instruction, and the UI labels it
 *    "AI PREDLOG" wherever it appears;
 *  - an owner is never guessed. "unknown" is a supported, common, correct
 *    answer, and the prompt says so twice.
 *
 * Anything the assistant himself said arrives clearly labelled and is
 * explicitly excluded from being a client statement - see assistant-filter.js
 * for the other half of that guarantee.
 *
 * This runs AFTER the meeting, in the background. It never touches the live
 * voice path, and it may take twenty seconds without anyone noticing.
 */
import { complete, isAnthropicConfigured, isOpenAiLlmConfigured, summaryModel } from './llm.js';
import { parseJsonObject } from './meeting-memory.js';
import { renderMemory } from './meeting-memory.js';

export const SUMMARY_VERSION = 1;

const CAPS = Object.freeze({
  decisions: 15,
  nextSteps: 15,
  openQuestions: 12,
  clientInterests: 10,
  objections: 10,
  importantFacts: 15,
  followUpSuggestions: 8,
});

const TEXT_MAX = 300;
const OWNERS = new Set(['seven', 'client', 'unknown']);

export function isConfigured() {
  return isAnthropicConfigured() || isOpenAiLlmConfigured();
}

export function emptySummary() {
  return {
    version: SUMMARY_VERSION,
    generatedAt: null,
    model: null,
    summary: '',
    decisions: [],
    nextSteps: [],
    openQuestions: [],
    clientInterests: [],
    objections: [],
    importantFacts: [],
    followUpSuggestions: [],
    // What the analysis was actually able to read, so nobody mistakes a
    // summary of a paused meeting for a summary of the whole meeting.
    basedOn: { segments: 0, interactions: 0, gaps: 0, truncated: false },
  };
}

function clean(value, max = TEXT_MAX) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Coerce the model's JSON into the documented shape.
 *
 * Same discipline as normalizeMemory: nothing is trusted, everything is capped,
 * an owner outside the three allowed values becomes `unknown`, and a missing
 * section becomes an empty one rather than an error. A half-usable summary is
 * worth far more than a 500.
 */
export function normalizeSummary(raw, meta = {}) {
  const out = { ...emptySummary(), ...meta };
  out.version = SUMMARY_VERSION;
  out.generatedAt = new Date().toISOString();
  out.summary = clean(raw?.summary, 1500);

  for (const [field, cap] of Object.entries(CAPS)) {
    const list = Array.isArray(raw?.[field]) ? raw[field] : [];
    const kept = [];
    for (const entry of list) {
      const text = clean(typeof entry === 'string' ? entry : entry?.text);
      if (!text) continue;
      const item = { text };
      const at = clean(entry?.at, 12);
      if (at) item.at = at;
      const slide = Number(entry?.slide);
      if (Number.isFinite(slide) && slide > 0) item.slide = Math.round(slide);
      if (field === 'nextSteps') {
        const owner = String(entry?.owner || '').toLowerCase();
        item.owner = OWNERS.has(owner) ? owner : 'unknown';
      }
      // A suggestion is the model's own idea and must never carry a
      // transcript timestamp - a citation would make it look like evidence.
      if (field === 'followUpSuggestions') delete item.at;
      kept.push(item);
      if (kept.length >= cap) break;
    }
    out[field] = kept;
  }
  return out;
}

const SYSTEM = [
  'Si analitik poslovnih sestankov. Iz prepisa sestanka izlušči strukturiran zapis.',
  '',
  'ŽELEZNA PRAVILA:',
  '1. Vse, kar zapišeš v decisions, nextSteps, openQuestions, clientInterests,',
  '   objections in importantFacts, mora imeti neposredno oporo v prepisu.',
  '   Če nečesa ni v prepisu, tega ne zapišeš. Nikoli.',
  '2. DOGOVOR je samo tisto, s čimer sta se strani izrecno strinjali. Predlog,',
  '   ideja, ponudba ali vprašanje NI dogovor.',
  '3. Nosilca naloge NE UGIBAJ. Če ni bilo izrecno povedano, kdo nekaj naredi,',
  '   je owner "unknown". "unknown" je pravilen in pogost odgovor.',
  '4. Vrstice, označene z ASISTENT, je izgovoril virtualni asistent predstavitelja.',
  '   To niso izjave naročnika, niso dogovori in niso zaveze naročnika.',
  '5. Samo followUpSuggestions so tvoji lastni predlogi. Tam ne navajaj časov in',
  '   ne piši, kot da je bilo dogovorjeno.',
  '6. Odgovori IZKLJUČNO z veljavnim JSON objektom, brez razlage in brez oznak.',
  '',
  'Shema:',
  '{"summary":"3-6 povedi, kaj se je na sestanku zgodilo",',
  ' "decisions":[{"text":"","at":"","slide":0}],',
  ' "nextSteps":[{"text":"","owner":"seven|client|unknown","at":""}],',
  ' "openQuestions":[{"text":"","at":""}],',
  ' "clientInterests":[{"text":"","at":""}],',
  ' "objections":[{"text":"","at":""}],',
  ' "importantFacts":[{"text":"","at":""}],',
  ' "followUpSuggestions":[{"text":""}]}',
  '',
  'Vse besedilo je v slovenščini.',
].join('\n');

/**
 * How much transcript the final analysis is allowed to read.
 *
 * Unlike the live path this one CAN afford the whole meeting - it runs once,
 * in the background, after everyone has left the room. The cap exists only so
 * an unusually long meeting cannot exceed a context window: past it, the
 * middle is thinned rather than the end truncated, because the end of a
 * meeting is where the decisions are.
 */
const MAX_TRANSCRIPT_CHARS = 60_000;

/**
 * Thin an over-long transcript from the MIDDLE.
 *
 * Keeping the opening (who is in the room, what this is about) and the close
 * (what was agreed) matters more than keeping a contiguous middle, and a
 * summary that silently lost the last fifteen minutes would be worse than
 * useless - it would be confidently wrong about the outcome.
 *
 * @returns {{segments:Array, truncated:boolean}}
 */
export function fitTranscript(segments = [], maxChars = MAX_TRANSCRIPT_CHARS) {
  const list = Array.isArray(segments) ? segments : [];
  const total = list.reduce((n, s) => n + s.text.length, 0);
  if (total <= maxChars) return { segments: list, truncated: false };

  const half = Math.floor(maxChars / 2);
  const head = [];
  let chars = 0;
  for (const s of list) {
    if (chars + s.text.length > half) break;
    head.push(s);
    chars += s.text.length;
  }
  const tail = [];
  chars = 0;
  for (let i = list.length - 1; i >= head.length; i--) {
    if (chars + list[i].text.length > half) break;
    tail.push(list[i]);
    chars += list[i].text.length;
  }
  return { segments: [...head, ...tail.reverse()], truncated: true };
}

/**
 * Build the analysis prompt.
 *
 * Three inputs, in this order and clearly separated: the rolling memory (what
 * we already believed), the transcript (the evidence), and the assistant's own
 * interactions (labelled, and excluded from being anybody's statement). The
 * recording gaps are named explicitly so the model cannot summarise silence as
 * agreement.
 */
export function buildSummaryPrompt({ session, segments, interactions = [], memory = null, gaps = [] }) {
  const lines = [];
  lines.push(`SESTANEK: ${session.name || session.presentationName || 'predstavitev'}`);
  lines.push(`PREDSTAVITEV: ${session.presentationName || session.presentationId}`);
  if (session.durationMs) lines.push(`TRAJANJE: ${Math.round(session.durationMs / 60000)} minut`);
  lines.push('');

  if (memory && (memory.decisions?.length || memory.commitments?.length || memory.openQuestions?.length)) {
    lines.push('ZAPIS, KI SE JE VODIL MED SESTANKOM (preveri ga ob prepisu, ni dokaz sam po sebi):');
    lines.push(renderMemory(memory));
    lines.push('');
  }

  if (gaps.length) {
    lines.push('POZOR - PREPIS NI POPOLN. V teh obdobjih snemanje ni teklo:');
    for (const g of gaps) lines.push(`- ${g.from || '?'} do ${g.to || 'konca'} (${g.reason})`);
    lines.push('Ne sklepaj, kaj se je zgodilo v teh obdobjih.');
    lines.push('');
  }

  lines.push('PREPIS SESTANKA:');
  for (const s of segments) {
    const slide = s.slide ? ` · slide ${s.slide}` : '';
    lines.push(`[${s.clock}${slide}] ${s.speaker}: ${s.text}`);
  }

  if (interactions.length) {
    lines.push('');
    lines.push('VPRAŠANJA PREDSTAVITELJA ASISTENTU IN ASISTENTOVI ODGOVORI');
    lines.push('(asistentove besede NISO izjave naročnika in NISO dogovori):');
    for (const i of interactions) {
      if (i.question) lines.push(`[${i.clock}] PREDSTAVITELJ: ${i.question}`);
      if (i.answer) lines.push(`[${i.clock}] ASISTENT: ${i.answer.slice(0, 600)}`);
    }
  }

  lines.push('');
  lines.push('Vrni JSON po shemi.');
  return lines.join('\n');
}

/**
 * Generate the meeting intelligence for one finished session.
 *
 * @param {{session:object, segments:Array, interactions?:Array, memory?:object,
 *          gaps?:Array, signal?:AbortSignal}} opts
 * @returns {Promise<object>} a normalized summary
 */
export async function generateSummary({ session, segments = [], interactions = [], memory = null, gaps = [], signal }) {
  if (!isConfigured()) {
    const err = new Error('no_llm_configured');
    err.code = 'no_llm_configured';
    throw err;
  }

  const fitted = fitTranscript(segments);
  const { text, model } = await complete({
    system: SYSTEM,
    user: buildSummaryPrompt({ session, segments: fitted.segments, interactions, memory, gaps }),
    // Nobody is waiting on this - it runs after everyone has left the room -
    // so reasoning is worth its latency here in a way it never is on the live
    // path. 'medium' rather than the API default of high: this is reading one
    // meeting's transcript and filling a fixed schema, not solving anything,
    // and effort is the first place a background job quietly overspends.
    // Both are ignored outright on an older model (see anthropicParams).
    thinking: 'adaptive',
    effort: 'medium',
    // Thinking tokens are drawn from max_tokens, so the old 3000 - chosen
    // when no call could think - is now a truncation risk: a summary cut
    // mid-JSON throws summary_not_json and marks the session FAILED. Output
    // is billed by what is generated, not by the ceiling, so raising it
    // costs nothing and removes the failure mode.
    maxTokens: 8000,
    signal,
    model: summaryModel(),
  });

  const parsed = parseJsonObject(text);
  if (!parsed) {
    const err = new Error('summary_not_json');
    err.code = 'summary_not_json';
    throw err;
  }

  return normalizeSummary(parsed, {
    model,
    basedOn: {
      segments: fitted.segments.length,
      interactions: interactions.length,
      gaps: gaps.length,
      truncated: fitted.truncated,
    },
  });
}
