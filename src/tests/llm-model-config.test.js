/**
 * server/llm.js - per-role model resolvers and the model-capability request
 * shape.
 *
 * Two things are load-bearing here and both come from real API behavior
 * (verified against the live Models API - see server/llm.js's own comments):
 *
 *  1. Every resolver (liveModel/memoryModel/summaryModel, and anthropicModel()
 *     as the legacy live alias) falls back through ANTHROPIC_MODEL to the
 *     built-in default, so a laptop with none of the new env vars set behaves
 *     byte-for-byte as it did before they existed.
 *
 *  2. anthropicParams() must never send `temperature` to a "new-generation"
 *     model (claude-sonnet-5 and friends) - that model rejects it with an
 *     HTTP 400, and the existing catch-and-fall-back-to-OpenAI around every
 *     Anthropic call would turn that 400 into a SILENT provider switch. It
 *     must also never emit `thinking` for an older model (Sonnet 4.5, Haiku
 *     4.5) - that would change a request shape that has to stay untouched -
 *     and it must never emit `output_config`/`effort` unless the caller asked
 *     for an effort AND the model is new-generation (Haiku 4.5 rejects it).
 *
 * No network: only the pure resolvers and anthropicParams() are exercised.
 * Every test that touches process.env restores it in a finally, since these
 * run in the same process as the rest of the suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveModel, memoryModel, summaryModel, anthropicModel, anthropicParams } from '../server/llm.js';

const ROLE_VARS = ['ANTHROPIC_LIVE_MODEL', 'ANTHROPIC_MEMORY_MODEL', 'ANTHROPIC_SUMMARY_MODEL', 'ANTHROPIC_MODEL', 'ANTHROPIC_LEASED_MODEL'];

function snapshotEnv() {
  const saved = new Map();
  for (const key of ROLE_VARS) saved.set(key, process.env[key]);
  return saved;
}

function restoreEnv(saved) {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// -------------------------------------------------------- role resolvers ----

test('liveModel/memoryModel/summaryModel: with nothing set, each falls back to its own measured default', () => {
  const saved = snapshotEnv();
  try {
    for (const key of ROLE_VARS) delete process.env[key];
    // The three defaults are deliberately NOT the same model. Memory in
    // particular must not drift back onto a Sonnet: it fires ~20x an hour and
    // was the largest single cost in a recorded meeting.
    assert.equal(liveModel(), 'claude-sonnet-5');
    assert.equal(memoryModel(), 'claude-haiku-4-5');
    assert.equal(summaryModel(), 'claude-sonnet-5');
    assert.notEqual(memoryModel(), liveModel());
    // anthropicModel() is kept as the live resolver under its legacy name -
    // every existing caller (server.js, scripts/) imports it expecting "the"
    // live model.
    assert.equal(anthropicModel(), liveModel());
  } finally {
    restoreEnv(saved);
  }
});

test('liveModel/memoryModel/summaryModel: ANTHROPIC_MODEL is the shared fallback for all three', () => {
  const saved = snapshotEnv();
  try {
    for (const key of ROLE_VARS) delete process.env[key];
    process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5';
    assert.equal(liveModel(), 'claude-haiku-4-5');
    assert.equal(memoryModel(), 'claude-haiku-4-5');
    assert.equal(summaryModel(), 'claude-haiku-4-5');
    assert.equal(anthropicModel(), 'claude-haiku-4-5');
  } finally {
    restoreEnv(saved);
  }
});

test('liveModel/memoryModel/summaryModel: a role-specific var wins over ANTHROPIC_MODEL, and only for its own role', () => {
  const saved = snapshotEnv();
  try {
    for (const key of ROLE_VARS) delete process.env[key];
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5';
    process.env.ANTHROPIC_LIVE_MODEL = 'claude-sonnet-5';
    process.env.ANTHROPIC_MEMORY_MODEL = 'claude-haiku-4-5';
    // ANTHROPIC_SUMMARY_MODEL left unset - summaryModel() must still fall
    // back to ANTHROPIC_MODEL, not to one of the other roles' overrides.
    assert.equal(liveModel(), 'claude-sonnet-5');
    assert.equal(memoryModel(), 'claude-haiku-4-5');
    assert.equal(summaryModel(), 'claude-sonnet-4-5');
    assert.equal(anthropicModel(), 'claude-sonnet-5');
  } finally {
    restoreEnv(saved);
  }
});

// ------------------------------------------------------- anthropicParams ----

test('anthropicParams: omits temperature for claude-sonnet-5 (it 400s on the real API)', () => {
  const params = anthropicParams('claude-sonnet-5', { temperature: 0 });
  assert.equal('temperature' in params, false);
});

test('anthropicParams: includes temperature for claude-sonnet-4-5 and claude-haiku-4-5', () => {
  assert.equal(anthropicParams('claude-sonnet-4-5', { temperature: 0 }).temperature, 0);
  assert.equal(anthropicParams('claude-haiku-4-5', { temperature: 0.7 }).temperature, 0.7);
});

test('anthropicParams: omits temperature entirely (not just as undefined) when the caller passes none', () => {
  const params = anthropicParams('claude-sonnet-4-5', {});
  assert.equal('temperature' in params, false);
});

test('anthropicParams: emits thinking:{type:"disabled"} for the live path on claude-sonnet-5', () => {
  const params = anthropicParams('claude-sonnet-5', { thinking: true });
  assert.deepEqual(params.thinking, { type: 'disabled' });
});

test('anthropicParams: no thinking key for claude-sonnet-4-5 or claude-haiku-4-5, even when requested', () => {
  // These models use no `thinking` key today, or (Haiku) the old
  // enabled/budget_tokens shape that this helper deliberately never builds -
  // asking for `thinking: true` must not leak the new-generation shape onto
  // an older model.
  assert.equal('thinking' in anthropicParams('claude-sonnet-4-5', { thinking: true }), false);
  assert.equal('thinking' in anthropicParams('claude-haiku-4-5', { thinking: true }), false);
});

test('anthropicParams: no thinking key for claude-sonnet-5 when thinking is not requested', () => {
  // The live path passes thinking:true explicitly; a caller that does not
  // ask for it (e.g. complete(), used by memory/summary work) must not get
  // an unsolicited `thinking` key either.
  const params = anthropicParams('claude-sonnet-5', {});
  assert.equal('thinking' in params, false);
});

test('anthropicParams: never produces output_config or effort for claude-haiku-4-5 (it 400s on effort)', () => {
  const params = anthropicParams('claude-haiku-4-5', { temperature: 0, thinking: true });
  assert.equal('output_config' in params, false);
  assert.equal('effort' in params, false);
});

test('anthropicParams: produces no output_config for any model when no effort is asked for', () => {
  for (const model of ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-sonnet-5']) {
    const params = anthropicParams(model, { temperature: 0, thinking: true });
    assert.equal('output_config' in params, false);
    assert.equal('effort' in params, false);
  }
});

test('anthropicParams: treats a dated Sonnet 5 snapshot and the 4.6/4.7/4.8 family as new-generation too', () => {
  for (const model of ['claude-sonnet-5-20260101', 'claude-opus-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8']) {
    const params = anthropicParams(model, { temperature: 0, thinking: true });
    assert.equal('temperature' in params, false, `expected no temperature for ${model}`);
    assert.deepEqual(params.thinking, { type: 'disabled' }, `expected disabled thinking for ${model}`);
  }
});

// ------------------------------------------- precedence, case by case ----

/**
 * The rule, stated once: the role's own variable ALWAYS wins. It is the most
 * specific thing anyone said, and nothing below it on the chain - not
 * ANTHROPIC_MODEL, not a lease, not a built-in default - may take it back.
 *
 * Each case below is one row of that chain, written out separately rather
 * than folded into a loop, because when one of them fails the name of the
 * test should say which rung broke.
 */

test('precedence A: a generic ANTHROPIC_MODEL cannot pull LIVE off its own variable', () => {
  const saved = snapshotEnv();
  try {
    for (const key of ROLE_VARS) delete process.env[key];
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5';
    process.env.ANTHROPIC_LIVE_MODEL = 'claude-sonnet-5';
    assert.equal(liveModel(), 'claude-sonnet-5');
  } finally {
    restoreEnv(saved);
  }
});

test('precedence B: a generic ANTHROPIC_MODEL cannot pull MEMORY off Haiku', () => {
  const saved = snapshotEnv();
  try {
    for (const key of ROLE_VARS) delete process.env[key];
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-5';
    process.env.ANTHROPIC_MEMORY_MODEL = 'claude-haiku-4-5';
    // The expensive direction: memory fires ~20x an hour, so this is the rung
    // whose failure costs real money rather than a little latency.
    assert.equal(memoryModel(), 'claude-haiku-4-5');
  } finally {
    restoreEnv(saved);
  }
});

test('precedence C: a generic ANTHROPIC_MODEL cannot pull SUMMARY off its own variable', () => {
  const saved = snapshotEnv();
  try {
    for (const key of ROLE_VARS) delete process.env[key];
    process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5';
    process.env.ANTHROPIC_SUMMARY_MODEL = 'claude-sonnet-5';
    assert.equal(summaryModel(), 'claude-sonnet-5');
  } finally {
    restoreEnv(saved);
  }
});

test('precedence D: with no role variable, ANTHROPIC_MODEL is still the backward-compatible fallback', () => {
  const saved = snapshotEnv();
  try {
    for (const key of ROLE_VARS) delete process.env[key];
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5';
    // A laptop that predates the role variables and simply names one model
    // must keep behaving exactly as it did.
    assert.equal(liveModel(), 'claude-sonnet-4-5');
    assert.equal(memoryModel(), 'claude-sonnet-4-5');
    assert.equal(summaryModel(), 'claude-sonnet-4-5');
  } finally {
    restoreEnv(saved);
  }
});

test('precedence E: with nothing set at all, each role gets its own built-in default', () => {
  const saved = snapshotEnv();
  try {
    for (const key of ROLE_VARS) delete process.env[key];
    assert.equal(liveModel(), 'claude-sonnet-5');
    assert.equal(memoryModel(), 'claude-haiku-4-5');
    assert.equal(summaryModel(), 'claude-sonnet-5');
  } finally {
    restoreEnv(saved);
  }
});

test('an empty or whitespace-only variable means "not set", not "the empty model"', () => {
  const saved = snapshotEnv();
  try {
    for (const key of ROLE_VARS) delete process.env[key];
    // `ANTHROPIC_MODEL=` is exactly how production turns the blunt lever off,
    // and a trailing-space edit must not turn it back on as a model named " ".
    process.env.ANTHROPIC_MODEL = '';
    process.env.ANTHROPIC_LIVE_MODEL = '   ';
    assert.equal(liveModel(), 'claude-sonnet-5');
    assert.equal(memoryModel(), 'claude-haiku-4-5');
    assert.equal(summaryModel(), 'claude-sonnet-5');

    // ...and a real value still survives stray whitespace around it.
    process.env.ANTHROPIC_MEMORY_MODEL = ' claude-haiku-4-5 ';
    assert.equal(memoryModel(), 'claude-haiku-4-5');
  } finally {
    restoreEnv(saved);
  }
});

test('a leased generic model is consulted for LIVE only, and below everything local', () => {
  const saved = snapshotEnv();
  try {
    for (const key of ROLE_VARS) delete process.env[key];
    // What provider-lease.js writes when a lease carries `anthropic.model`.
    process.env.ANTHROPIC_LEASED_MODEL = 'claude-sonnet-4-5';

    assert.equal(liveModel(), 'claude-sonnet-4-5', 'the remote lever still moves the live model');
    assert.equal(memoryModel(), 'claude-haiku-4-5', 'and must never reach memory');
    assert.equal(summaryModel(), 'claude-sonnet-5', 'or the summary');

    // Anything configured on this machine outranks it.
    process.env.ANTHROPIC_LIVE_MODEL = 'claude-sonnet-5';
    assert.equal(liveModel(), 'claude-sonnet-5');
    delete process.env.ANTHROPIC_LIVE_MODEL;
    process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5';
    assert.equal(liveModel(), 'claude-haiku-4-5');
  } finally {
    restoreEnv(saved);
  }
});

// ------------------------------- reasoning mode stays a per-role choice ----

/**
 * Model selection and thinking configuration are separate concerns, and the
 * second one is easy to flatten by accident while fixing the first. These
 * assert the three shapes the three call sites actually build - see
 * streamAnthropic() (live), meeting-memory.js (memory) and
 * meeting-intelligence.js (summary).
 */
test('the three roles keep three different reasoning shapes', () => {
  // LIVE: thinking explicitly disabled. Omitting it on a new-generation model
  // means ADAPTIVE, which would silently blow the voice latency budget.
  const live = anthropicParams('claude-sonnet-5', { thinking: true });
  assert.deepEqual(live.thinking, { type: 'disabled' });
  assert.equal('output_config' in live, false);
  assert.equal('temperature' in live, false);

  // MEMORY: Haiku 4.5 is not new-generation - no thinking key, no effort, and
  // temperature still sent, which is the shape it has always had.
  const memory = anthropicParams('claude-haiku-4-5', { temperature: 0 });
  assert.equal('thinking' in memory, false);
  assert.equal('output_config' in memory, false);
  assert.equal(memory.temperature, 0);

  // SUMMARY: adaptive at medium effort. Nobody is waiting on it, but the API
  // default is high and effort is where a background job overspends.
  const summary = anthropicParams('claude-sonnet-5', { temperature: 0, thinking: 'adaptive', effort: 'medium' });
  assert.deepEqual(summary.thinking, { type: 'adaptive' });
  assert.deepEqual(summary.output_config, { effort: 'medium' });
  assert.equal('temperature' in summary, false);
});
