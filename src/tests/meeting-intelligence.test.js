/**
 * server/meeting-intelligence.js - what a finished meeting turns into.
 *
 * THE ONE RULE THAT MATTERS: a model asked to summarise a sales meeting will,
 * unprompted, invent a tidy list of next steps that reads well and contains
 * two things nobody said. In a document a salesperson takes into the next
 * meeting that is a fabricated commitment attributed to a real client, not a
 * rough edge - so the fact/inference boundary is structural here, not
 * stylistic: only `followUpSuggestions` is allowed to be the model's own
 * idea, and it is the one field that may never carry a transcript timestamp,
 * because a citation would make an invented suggestion look like evidence.
 *
 * Only the pure functions are exercised - generateSummary() reaches an LLM
 * and is out of scope for these tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSummary,
  fitTranscript,
  buildSummaryPrompt,
} from '../server/meeting-intelligence.js';

// ------------------------------------------------------------ normalizeSummary

test('normalizeSummary caps every list to its documented maximum', () => {
  // Mirrors the CAPS constants in the source file (not exported); this is
  // the contract the prompt schema and the UI both depend on.
  const caps = { decisions: 15, nextSteps: 15, openQuestions: 12, clientInterests: 10, objections: 10, importantFacts: 15, followUpSuggestions: 8 };
  const raw = {};
  for (const [field, cap] of Object.entries(caps)) {
    raw[field] = Array.from({ length: cap + 10 }, (_, i) => ({ text: `Unikatna tocka ${field} ${i}` }));
  }
  const out = normalizeSummary(raw);
  for (const [field, cap] of Object.entries(caps)) {
    assert.equal(out[field].length, cap, `${field} was not capped at ${cap}`);
  }
});

test('normalizeSummary: a nextSteps owner outside seven|client|unknown becomes unknown', () => {
  const out = normalizeSummary({ nextSteps: [{ text: 'Poslati pogodbo.', owner: 'someone_else' }] });
  assert.equal(out.nextSteps[0].owner, 'unknown');
});

test('normalizeSummary: followUpSuggestions never carry an "at" timestamp - a citation would make an AI suggestion look like transcript evidence', () => {
  const out = normalizeSummary({ followUpSuggestions: [{ text: 'Morda velja predlagati letno narocnino.', at: '14:22:10' }] });
  assert.equal(out.followUpSuggestions.length, 1);
  assert.equal('at' in out.followUpSuggestions[0], false, 'the at field must be stripped, not merely left unset');
});

test('normalizeSummary degrades a malformed model response to a valid empty summary rather than throwing', () => {
  for (const bad of [null, undefined, {}, 'not an object', 42, { decisions: 'nope' }]) {
    const out = normalizeSummary(bad);
    assert.equal(out.version, 1);
    assert.equal(out.summary, '');
    assert.deepEqual(out.decisions, []);
    assert.deepEqual(out.followUpSuggestions, []);
  }
});

test('normalizeSummary carries basedOn metadata through from meta, so nobody mistakes a partial read for a complete one', () => {
  const out = normalizeSummary({ summary: 'Kratek povzetek.' }, { basedOn: { segments: 40, interactions: 3, gaps: 1, truncated: true } });
  assert.deepEqual(out.basedOn, { segments: 40, interactions: 3, gaps: 1, truncated: true });
});

// ---------------------------------------------------------------- fitTranscript

function bigSeg(ms, text) {
  return { ms, text, clock: '00:00:00', speaker: 'Speaker 1', slide: null };
}

test('fitTranscript returns everything untouched when the transcript is already under the cap', () => {
  const segments = [bigSeg(0, 'kratek prepis')];
  const { segments: out, truncated } = fitTranscript(segments, 10000);
  assert.equal(truncated, false);
  assert.deepEqual(out, segments);
});

test('fitTranscript over the cap thins the MIDDLE and keeps both the opening and the closing segments', () => {
  // The end of a meeting is where the decisions are; silently losing the
  // last fifteen minutes would make a summary confidently wrong about the
  // outcome, which is worse than an honestly incomplete one.
  const segments = [];
  for (let i = 0; i < 50; i++) segments.push(bigSeg(i * 1000, 'x'.repeat(500) + ` segment-${i}`));

  const { segments: out, truncated } = fitTranscript(segments, 5000);
  assert.equal(truncated, true);
  assert.ok(out.length < segments.length, 'the middle really was thinned');
  assert.equal(out[0].ms, segments[0].ms, 'the opening segment survives');
  assert.equal(out[out.length - 1].ms, segments[segments.length - 1].ms, 'the CLOSING segment survives - this is the property that matters most');
});

// ----------------------------------------------------------- buildSummaryPrompt

test('buildSummaryPrompt names recording gaps explicitly so a model cannot summarise silence as agreement', () => {
  const session = { name: 'Sestanek z Acme', presentationId: 'acme', durationMs: 3_600_000 };
  const withGaps = buildSummaryPrompt({ session, segments: [], gaps: [{ from: '10:00:00', to: '10:07:00', reason: 'paused' }] });
  assert.match(withGaps, /PREPIS NI POPOLN/);
  assert.match(withGaps, /10:00:00 do 10:07:00/);
  assert.match(withGaps, /paused/);

  const withoutGaps = buildSummaryPrompt({ session, segments: [], gaps: [] });
  assert.doesNotMatch(withoutGaps, /PREPIS NI POPOLN/);
});

test('buildSummaryPrompt labels assistant interactions as ASISTENT and states they are not the client\'s statements', () => {
  const session = { name: 'Sestanek', presentationId: 'demo' };
  const prompt = buildSummaryPrompt({
    session,
    segments: [],
    interactions: [{ clock: '10:01:00', question: 'Koliko stane?', answer: 'Odvisno od paketa.' }],
  });
  assert.match(prompt, /ASISTENT/);
  assert.match(prompt, /NISO izjave naročnika/);
  assert.match(prompt, /Odvisno od paketa\./);
});

test('buildSummaryPrompt includes the slide as metadata on a transcript line', () => {
  const session = { name: 'Sestanek', presentationId: 'demo' };
  const prompt = buildSummaryPrompt({
    session,
    segments: [{ clock: '10:02:00', slide: 9, speaker: 'Speaker 1', text: 'Ta del je bil povedan pri sliji devet.' }],
  });
  assert.match(prompt, /slide 9/);
  assert.match(prompt, /Ta del je bil povedan pri sliji devet\./);
});
