/**
 * LLM adapter: Anthropic (primary), OpenAI (fallback).
 *
 * Exposes ONE function - streamAnswer() - that yields plain text deltas for a
 * question asked against a specific presentation. Timeouts and the cached-answer
 * parachute live in server.js so this file stays a thin adapter.
 *
 * The system prompt is whatever the presentation registry composed:
 *   persona + global company knowledge + presentation knowledge + terminology.
 * Nothing about any particular client is hard-coded here.
 */
import Anthropic from '@anthropic-ai/sdk';
import { slideContextBlock } from './slide-context.js';
import { fetchWithTimeout } from './util.js';

// One default per workload, measured rather than assumed - the comparison is
// in docs/RUNBOOK.md. Against a production-size (~46 kB) system prompt, Sonnet 5
// reached the first complete spoken sentence in 1730ms where Sonnet 4.5 took
// 2018ms, cost less per answer, and kept the spoken word budget that 4.5
// overran. Haiku 4.5 runs the rolling meeting memory: that job fires ~20x an
// hour and was the single largest line item in a recorded meeting, and Haiku
// reproduced the structured record without dropping a single earlier entry.
const DEFAULT_LIVE_MODEL = 'claude-sonnet-5';
const DEFAULT_MEMORY_MODEL = 'claude-haiku-4-5';
const DEFAULT_SUMMARY_MODEL = 'claude-sonnet-5';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

let client = null;
let clientKey = null;
function anthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  // Memoised BY KEY, not just memoised. Provider credentials are leased from
  // the cloud for a bounded period and rotate on renewal (see
  // server/provider-lease.js); a client cached on identity alone would keep
  // authenticating with the previous key until the process restarted, which
  // fails silently and only during a meeting.
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key });
    clientKey = key;
  }
  return client;
}

export function isAnthropicConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** OpenAI is usable as an LLM fallback as soon as the key exists. */
export function isOpenAiLlmConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Per-role model resolvers. Three different workloads share this file - the
 * live answer path (streamAnswer/streamAnthropic), the background meeting
 * memory (meeting-memory.js), and everything that produces a JSON summary
 * (meeting-intelligence.js, and the ask-about-a-past-session path in
 * session-runtime.js) - and a model swap tuned for one of them (say, a
 * cheaper/faster model behind the live path) should never have to touch the
 * other two.
 *
 * The order of the fallback chain is the design:
 *
 *   1. the role's own variable  - the most specific thing anyone said, so it
 *      ALWAYS wins. Nothing below can take it back.
 *   2. ANTHROPIC_MODEL          - the backward-compatible blunt lever, for a
 *      laptop that predates the role variables and simply names one model.
 *   3. ANTHROPIC_LEASED_MODEL   - live role only; see below.
 *   4. the role's own measured default.
 *
 * WHY A LEASE GETS ITS OWN RUNG
 * -----------------------------
 * provider-lease.js used to map a cloud lease's `anthropic.model` straight
 * onto ANTHROPIC_MODEL. That single value is rung 2, which means one field in
 * a lease - set on the cloud, months ago, by someone thinking only about the
 * live answer path - silently COLLAPSED all three roles onto one model on any
 * laptop that had not set the role variables itself. The memory job is the
 * expensive half of that: it fires ~20x an hour, and moving it off Haiku is
 * an invisible cost increase nobody would go looking for.
 *
 * So a leased generic model now lands in its own variable and is consulted
 * for the LIVE role only. The remote lever that mattered (move the live model
 * without a deploy) still works; the two background roles cannot be moved by
 * accident from a thousand kilometres away. Anything set locally - role
 * variable or ANTHROPIC_MODEL - still outranks it, because config on the
 * machine in the room is more specific than config on a server.
 *
 * Empty and whitespace-only values count as "not set" at every rung, so
 * `ANTHROPIC_MODEL=` in a .env means what it looks like it means.
 */

/** An env var's value, or null if it is unset, empty, or only whitespace. */
function configured(name) {
  const raw = process.env[name];
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value === '' ? null : value;
}

/** Where provider-lease.js puts a lease's generic `anthropic.model`. */
export const LEASED_MODEL_VAR = 'ANTHROPIC_LEASED_MODEL';

export function liveModel() {
  return (
    configured('ANTHROPIC_LIVE_MODEL') ||
    configured('ANTHROPIC_MODEL') ||
    configured(LEASED_MODEL_VAR) ||
    DEFAULT_LIVE_MODEL
  );
}

export function memoryModel() {
  return configured('ANTHROPIC_MEMORY_MODEL') || configured('ANTHROPIC_MODEL') || DEFAULT_MEMORY_MODEL;
}

export function summaryModel() {
  return configured('ANTHROPIC_SUMMARY_MODEL') || configured('ANTHROPIC_MODEL') || DEFAULT_SUMMARY_MODEL;
}

/**
 * Kept under its original name because server.js and scripts/ already import
 * it - it is simply the live resolver under the name every existing caller
 * uses. Outside this file, "the" Anthropic model has always meant the one the
 * live answer path talks to.
 */
export function anthropicModel() {
  return liveModel();
}

export function openAiModel() {
  return process.env.OPENAI_LLM_MODEL || DEFAULT_OPENAI_MODEL;
}

/** The model that a question would be sent to right now. */
export function llmModel() {
  if (isAnthropicConfigured()) return anthropicModel();
  if (isOpenAiLlmConfigured()) return openAiModel();
  return 'none';
}

/**
 * Build the user turn: slide context + what has happened in this meeting + the
 * question.
 *
 * `meetingContext` is the rolling meeting memory plus the last few minutes of
 * the room, never the full transcript - see server/meeting-memory.js for why
 * that distinction is the difference between an assistant that stays fast
 * through a 70-minute meeting and one that does not. It sits in the UNCACHED
 * turn because it changes every few minutes; the slide block is already here
 * for the same reason.
 */
function buildUserTurn(presentation, question, slide, meetingContext = '') {
  const [minW, maxW] = presentation.config.answerStyle.wordBudget;
  return [
    slideContextBlock(presentation, slide),
    '',
    ...(meetingContext ? [meetingContext, ''] : []),
    // Repeating the length rule here, in the uncached turn, is what actually
    // holds it: a rule 30 kB up in the system prompt drifts by the third answer.
    // The short-opener rule is repeated for the same reason, and because it is
    // worth about a second of time-to-first-audio on every single answer.
    `VPRAŠANJE OBČINSTVA. Odgovori v slovenščini, v največ ${maxW} besedah (ciljaj ${minW}-${Math.round((minW + maxW) / 2)}),`,
    'kot en odstavek govorjenega besedila. Prvi stavek naj bo kratek, največ osem besed:',
    question,
  ].join('\n');
}

function trimHistory(history) {
  return history.slice(-4).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 2000),
  }));
}

/**
 * Stream an answer as text deltas. Anthropic first; if it fails before the
 * first token, OpenAI takes over transparently.
 *
 * @param {{presentation:object, question:string, slide:number, history?:Array, signal?:AbortSignal,
 *          onProvider?:Function, meetingContext?:string}} opts
 * @returns {AsyncGenerator<string>}
 */
export async function* streamAnswer({ presentation, question, slide, history = [], signal, onProvider, meetingContext = '' }) {
  if (isAnthropicConfigured()) {
    try {
      // Probe the stream before committing: a 401/429/500 from Anthropic must
      // fall through to OpenAI, not surface as a failed answer. Once the first
      // token is out we are committed - a mid-stream failure ends the answer.
      const iterator = streamAnthropic({ presentation, question, slide, history, signal, meetingContext });
      const first = await iterator.next();
      if (!first.done) {
        onProvider?.({ provider: 'anthropic', model: anthropicModel() });
        yield first.value;
        yield* iterator;
        return;
      }
      onProvider?.({ provider: 'anthropic', model: anthropicModel() });
      return;
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('[llm] anthropic failed (%s) - trying OpenAI', err.message);
      if (!isOpenAiLlmConfigured()) throw err;
    }
  }

  if (isOpenAiLlmConfigured()) {
    onProvider?.({ provider: 'openai', model: openAiModel() });
    yield* streamOpenAi({ presentation, question, slide, history, signal, meetingContext });
    return;
  }

  const err = new Error('no_llm_configured');
  err.code = 'no_llm_configured';
  throw err;
}

/**
 * Whether `model` belongs to the "new-generation" Anthropic family - Sonnet 5,
 * Opus 5, and the *-4-6 / *-4-7 / *-4-8 line. These models changed two things
 * about the request shape that the rest of this file cannot get wrong:
 *
 *   - `temperature` (and `top_p`/`top_k`) are REJECTED with an HTTP 400. This
 *     file always sent `temperature`, so pointing any role at one of these
 *     models via the resolvers above would 400 on every single request - and
 *     the existing catch-and-fall-back-to-OpenAI around both call sites would
 *     turn that into a SILENT provider switch, not a visible error.
 *   - an OMITTED `thinking` field runs ADAPTIVE thinking, not "no thinking"
 *     the way every older model behaves. On the live answer path that turns a
 *     bounded ~1-2 s completion into an open-ended reasoning call and blows
 *     the latency budget the whole voice pipeline is tuned around - silently,
 *     because nothing about it is an error. The fix is to say what we mean:
 *     `thinking: { type: 'disabled' }` wherever the old fast behavior is
 *     wanted.
 *
 * An explicit regex rather than a hard-coded ID list, so a future -4-9 or
 * -5-x release doesn't silently fall back into the old (now wrong) codepath.
 */
function isNewGenerationModel(model) {
  return /^claude-(sonnet|opus)-5(-|$)|-4-[678](-|$)/.test(String(model || ''));
}

/**
 * Build the model-appropriate extra fields for an Anthropic messages.create()
 * request body, so callers never have to special-case a model generation
 * themselves. See isNewGenerationModel() above for why this matters.
 *
 *   - `temperature`: included for every model EXCEPT a new-generation one,
 *     which rejects it outright.
 *   - `thinking`: only ever emitted for a new-generation model, and only when
 *     the caller explicitly asks for it via `thinking: true` - which the live
 *     path does, to get `{ type: 'disabled' }` (the fast, bounded behavior).
 *     Older models (including Sonnet 4.5) get no `thinking` key at all, which
 *     is exactly today's shape. Haiku 4.5 is not new-generation, so this
 *     helper never emits `thinking` (or `output_config`/`effort`, which it
 *     never produces for anyone) for it either - Haiku still uses the old
 *     enabled/budget_tokens shape, and callers that want that build it
 *     themselves rather than through this helper.
 *
 * Exported (alongside the pure resolvers above) purely so tests can assert on
 * its output without making a network call - nothing outside this file needs
 * to call it directly today.
 *
 * `thinking` takes three values, because "leave it out" does not mean the same
 * thing on both sides of the generation line and that is the whole trap:
 *   false       - emit no thinking key (correct for every older model)
 *   'disabled'  - `{ type: 'disabled' }`, the live path's fast, bounded shape
 *   'adaptive'  - `{ type: 'adaptive' }`, for background work that benefits
 *                 from reasoning and has no latency budget
 * `true` is kept as a synonym for 'disabled' so existing callers and tests
 * read the same as before.
 *
 * `effort` maps to output_config.effort and is only ever emitted for a
 * new-generation model. That exclusion is load-bearing rather than tidy:
 * Haiku 4.5 rejects output_config.effort outright, and it is not a
 * new-generation model, so it can never receive one through this helper.
 * Leaving effort unset on a new-generation model means the API default
 * (high) - which is why the summary path names 'medium' explicitly rather
 * than saying nothing and hoping.
 *
 * @param {string} model
 * @param {{temperature?:number, thinking?:boolean|'disabled'|'adaptive', effort?:string|null}} [opts]
 * @returns {object} fields to spread into the request body
 */
export function anthropicParams(model, { temperature, thinking = false, effort = null } = {}) {
  if (!isNewGenerationModel(model)) {
    return temperature !== undefined ? { temperature } : {};
  }
  const out = {};
  if (thinking === 'adaptive') out.thinking = { type: 'adaptive' };
  else if (thinking) out.thinking = { type: 'disabled' };
  if (effort) out.output_config = { effort };
  return out;
}

/**
 * A plain system+user completion, with no presentation scaffolding at all.
 *
 * streamAnswer() above is shaped entirely around a live question: it prepends
 * the current slide, appends a spoken word budget, and asks for one paragraph
 * of speech. That is exactly right in front of a room and exactly wrong for
 * the meeting-memory and meeting-intelligence work, which runs in the
 * background and must come back as JSON. Rather than let those two callers
 * fight the answer prompt, they get their own door.
 *
 * Same provider chain, same fallback, same keep-alive pool. Non-streaming on
 * purpose: nothing is waiting to speak this, so there is nothing to gain from
 * partial output, and one response is far easier to parse than a stream.
 *
 * `model` defaults to summaryModel() - most of complete()'s callers are
 * summary-shaped (meeting-intelligence, ask-about-a-past-session); the one
 * that isn't (meeting-memory) passes memoryModel() explicitly.
 *
 * `thinking`/`effort` are passed straight to anthropicParams(), so an older
 * model ignores them entirely and a caller can ask for reasoning without
 * first checking which model it is about to get. Only the summary asks: it
 * runs after the meeting, where a better answer is worth more than a faster
 * one. Note that the response is filtered to text blocks below, so a thinking
 * block never reaches the JSON parser.
 *
 * @param {{system:string, user:string, maxTokens?:number, signal?:AbortSignal, temperature?:number,
 *          model?:string, thinking?:boolean|'disabled'|'adaptive', effort?:string|null}} opts
 * @returns {Promise<{text:string, provider:string, model:string}>}
 */
export async function complete({
  system,
  user,
  maxTokens = 1600,
  signal,
  temperature = 0,
  model = summaryModel(),
  thinking = false,
  effort = null,
}) {
  if (isAnthropicConfigured()) {
    try {
      const res = await anthropic().messages.create(
        {
          model,
          max_tokens: maxTokens,
          ...anthropicParams(model, { temperature, thinking, effort }),
          system: [{ type: 'text', text: system }],
          messages: [{ role: 'user', content: user }],
        },
        // The SDK default is a 10-MINUTE timeout with 2 retries. A hung call
        // here holds `memoryRunning`/equivalent background-job state true in
        // session-runtime.js, coalescing every later trigger behind it for up
        // to that long - nothing on this path is worth waiting ten minutes
        // for. The OpenAI branch below already uses 60s; match it here.
        { signal, timeout: 60_000, maxRetries: 1 }
      );
      const text = (res.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return { text, provider: 'anthropic', model };
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('[llm] anthropic completion failed (%s) - trying OpenAI', err.message);
      if (!isOpenAiLlmConfigured()) throw err;
    }
  }

  if (!isOpenAiLlmConfigured()) {
    const err = new Error('no_llm_configured');
    err.code = 'no_llm_configured';
    throw err;
  }

  const fallbackModel = openAiModel();
  const usesMaxCompletionTokens = /^(gpt-5|o[1-9])/i.test(fallbackModel);
  const res = await fetchWithTimeout(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: fallbackModel,
        [usesMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens']: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal,
    },
    60000
  );
  if (!res.ok) throw new Error(`openai_llm_http_${res.status}`);
  const json = await res.json();
  return { text: json.choices?.[0]?.message?.content || '', provider: 'openai', model: fallbackModel };
}

async function* streamAnthropic({ presentation, question, slide, history, signal, meetingContext }) {
  const maxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS || presentation.config.answerStyle.maxTokens || 400);
  const model = liveModel();

  const stream = await anthropic().messages.create(
    {
      model,
      max_tokens: maxTokens,
      // thinking:true asks anthropicParams() for the fast, bounded behavior on
      // a new-generation model (`{ type: 'disabled' }`) - see
      // isNewGenerationModel()'s comment for why leaving `thinking` out would
      // silently turn this into an open-ended adaptive-reasoning call and blow
      // the live-answer latency budget. Older models (Sonnet 4.5 included)
      // get no `thinking` key at all, exactly as before.
      ...anthropicParams(model, { thinking: true }),
      // The whole knowledge base is one cached block. Cache hits cut both cost
      // and time-to-first-token on every question after the first. TTL is 1h
      // rather than the API default of 5m: the real system prompt is ~14.7k
      // tokens and audience questions routinely land more than 5 minutes
      // apart, so the 5m default meant most questions paid a full cache WRITE
      // (~2x the read cost, but still cheaper than a cold prompt) instead of a
      // cache READ (~0.1x). A 1h write costs ~2x once per meeting; every
      // question after that reads at ~0.1x instead of re-writing.
      system: [{ type: 'text', text: presentation.systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [...trimHistory(history), { role: 'user', content: buildUserTurn(presentation, question, slide, meetingContext) }],
      stream: true,
    },
    { signal }
  );

  for await (const event of stream) {
    // One line per answer, so a cache that has silently stopped hitting is
    // visible rather than just felt as "it got slower today". A cold prompt
    // costs roughly a second of time-to-first-token on an 11k-token brief.
    if (event.type === 'message_start' && event.message?.usage) {
      const u = event.message.usage;
      const read = u.cache_read_input_tokens || 0;
      const written = u.cache_creation_input_tokens || 0;
      console.log(
        '[llm] prompt cache %s (read %d, written %d, fresh %d)',
        read ? 'HIT' : written ? 'primed' : 'MISS',
        read,
        written,
        u.input_tokens || 0
      );
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      yield event.delta.text;
    }
  }
}

/** OpenAI fallback, using the same composed system prompt. */
async function* streamOpenAi({ presentation, question, slide, history, signal, meetingContext }) {
  const maxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS || presentation.config.answerStyle.maxTokens || 400);
  const model = openAiModel();

  // The newer reasoning-era models renamed the token cap; send the right one.
  const usesMaxCompletionTokens = /^(gpt-5|o[1-9])/i.test(model);
  const body = {
    model,
    stream: true,
    [usesMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens']: maxTokens,
    messages: [
      { role: 'system', content: presentation.systemPrompt },
      ...trimHistory(history),
      { role: 'user', content: buildUserTurn(presentation, question, slide, meetingContext) },
    ],
  };

  const res = await fetchWithTimeout(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal,
    },
    30000
  );

  if (!res.ok || !res.body) throw new Error(`openai_llm_http_${res.status}`);

  // Minimal SSE reader.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        /* ignore malformed keep-alive lines */
      }
    }
  }
}
