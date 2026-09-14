/**
 * server/assistant-filter.js - keeping Sedemcek's own voice out of the
 * meeting transcript, without losing the human who talks over him.
 *
 * THE FAILURE THIS PREVENTS: Sedemcek answers through the laptop speakers,
 * the meeting microphone hears the speakers, and his own sentence comes back
 * into the transcript as an anonymous speaker - and later the meeting
 * summary reports one of HIS sentences as something the client agreed to.
 * That is not a cosmetic bug: it is the system inventing a commitment and
 * attributing it to a real person in a real meeting.
 *
 * THE OTHER HALF: a presenter can, and often does, interrupt Sedemcek
 * mid-answer ("Hey Seven, kaj pa cena?"). Blanking the transcript for the
 * whole of every answer would delete exactly the sentences a presenter
 * cares most about. So this file is tested from both directions on purpose.
 *
 * Everything here is pure - no I/O, no network - which is the only reason a
 * rule this important can be pinned down in a fast, deterministic test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coverage,
  assistantWindows,
  filterAssistantEcho,
  ECHO_COVERAGE,
  ECHO_COVERAGE_SHORT,
} from '../server/assistant-filter.js';

// -------------------------------------------------------------- coverage ----

test('coverage() asks "how much of the heard fragment is his", not "are these the same sentence"', () => {
  const reference = 'Cena za osnovni paket je tisoč evrov na mesec, vključno s podporo in posodobitvami.';
  assert.equal(coverage('tisoč evrov na mesec', reference), 1, 'a short fragment fully contained in a long reference scores 1.0');
  assert.equal(coverage('kolesarska dirka v alpah', reference), 0, 'unrelated text scores 0');
});

test('coverage() treats reference words as a bag, not a set - repeating a word once used does not earn double credit', () => {
  const reference = 'da to je res dobra ideja';
  // "da" appears once in the reference; asking for it three times cannot be
  // more than one hit, or a fragment could cheat coverage by repetition.
  assert.equal(coverage('da da da', reference), 1 / 3);
});

// -------------------------------------------------------- assistantWindows ---

test('assistantWindows uses spokeUntil when the browser actually stamped one', () => {
  const interactions = [
    { ms: 10000, t: '2026-01-01T10:00:00.000Z', spokeUntil: '2026-01-01T10:00:08.000Z', answer: 'Odgovor.' },
  ];
  const [w] = assistantWindows(interactions);
  assert.equal(w.fromMs, 10000);
  // 8000ms of measured playback + the 900ms tail/reverb pad the module adds.
  assert.equal(w.toMs, 10000 + 8000 + 900);
});

test('assistantWindows estimates a window from answer length when spokeUntil is missing, and the estimate is bounded', () => {
  const oneWord = assistantWindows([{ ms: 0, answer: 'Ja.' }])[0];
  // The floor exists so a one-word answer never produces a near-zero window
  // that would let the very next syllable slip past the filter as a client.
  assert.ok(oneWord.toMs - oneWord.fromMs >= 1500, 'a very short answer is floored, never estimated at ~0ms');

  const veryLong = assistantWindows([{ ms: 0, answer: 'beseda '.repeat(1000) }])[0];
  assert.ok(veryLong.toMs - veryLong.fromMs <= 60000 + 900, 'a very long answer is capped, not extrapolated forever');
});

test('assistantWindows sorts windows chronologically regardless of interaction order', () => {
  const windows = assistantWindows([
    { ms: 5000, answer: 'Drugi odgovor.' },
    { ms: 1000, answer: 'Prvi odgovor.' },
  ]);
  assert.deepEqual(windows.map((w) => w.fromMs), [1000, 5000]);
});

// --------------------------------------------------------- filterAssistantEcho

test('Sedemcek\'s own answer, echoed back slightly mangled by a recogniser hearing a loudspeaker, is dropped as his echo', () => {
  const answer = 'Cena za osnovni paket je tisoč evrov na mesec vključno s podporo';
  const interactions = [{ ms: 10000, t: '2026-01-01T10:00:00.000Z', spokeUntil: '2026-01-01T10:00:08.000Z', answer }];

  // One word garbled ("podporo" -> "podporoo"), exactly what a mic pointed at
  // a laptop speaker across the room actually produces.
  const mangled = 'Cena za osnovni paket je tisoč evrov na mesec vključno s podporoo';
  const segments = [{ ms: 12000, durationMs: 1000, text: mangled }];

  const { kept, dropped } = filterAssistantEcho(segments, interactions);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, 'assistant_echo');
  assert.ok(dropped[0].coverage >= ECHO_COVERAGE, 'the coverage that triggered the drop is reported, not hidden');
});

test('a human interrupting him mid-answer is KEPT - suppressing the whole window would delete exactly the sentences a presenter cares most about', () => {
  const answer = 'Cena za osnovni paket je tisoč evrov na mesec vključno s podporo';
  const interactions = [{ ms: 10000, t: '2026-01-01T10:00:00.000Z', spokeUntil: '2026-01-01T10:00:08.000Z', answer }];

  // A genuinely different sentence, recorded inside the very same window.
  const bargeIn = 'Ali lahko dodamo še tretjo lokacijo v ponudbo?';
  const segments = [{ ms: 12000, durationMs: 1000, text: bargeIn }];

  const { kept, dropped } = filterAssistantEcho(segments, interactions);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].text, bargeIn, 'the barge-in survives verbatim');
  assert.equal(kept[0].duringAssistantSpeech, true, 'flagged as contested, not silently indistinguishable from a clean segment');
});

test('a short generic agreement is held to the stricter short-fragment threshold and survives', () => {
  // A long answer; the human's reply below shares 3 of its 4 words with it
  // by coincidence (four short, everyday words), which is exactly the kind of
  // near-miss the short threshold exists to protect against. At the normal
  // 0.7 threshold this 0.75 coverage would be wrongly dropped as an echo;
  // ECHO_COVERAGE_SHORT (0.95) is why it is not.
  const answer = 'Da cena vključuje podporo in redne posodobitve programske opreme za celotno leto brez doplačila zares vedno';
  const interactions = [{ ms: 10000, t: '2026-01-01T10:00:00.000Z', spokeUntil: '2026-01-01T10:00:10.000Z', answer }];

  const shortReply = 'Da cena vključuje super'; // 4 words, 3 of them happen to appear in the answer
  const segments = [{ ms: 12000, durationMs: 500, text: shortReply }];

  const n = 4;
  const expectedCoverage = 3 / n;
  assert.ok(expectedCoverage >= ECHO_COVERAGE, 'sanity: this fragment WOULD be dropped under the normal, longer-fragment threshold');
  assert.ok(expectedCoverage < ECHO_COVERAGE_SHORT, 'but it does not clear the stricter short-fragment bar');

  const { kept, dropped } = filterAssistantEcho(segments, interactions);
  assert.equal(dropped.length, 0, 'not mistaken for an echo just because a few short, common words coincide');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].duringAssistantSpeech, true);
});

test('nothing outside a speaking window is ever touched', () => {
  const interactions = [{ ms: 10000, t: '2026-01-01T10:00:00.000Z', spokeUntil: '2026-01-01T10:00:08.000Z', answer: 'Neki odgovor tukaj.' }];
  const before = { ms: 1000, durationMs: 500, text: 'Nekaj je bilo povedano precej pred vprašanjem.' };
  const after = { ms: 60000, durationMs: 500, text: 'Nekaj je bilo povedano precej po odgovoru.' };

  const { kept, dropped } = filterAssistantEcho([before, after], interactions);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 2);
  assert.ok(kept.every((s) => s.duringAssistantSpeech === false));
});

test('filterAssistantEcho never mutates its input', () => {
  const interactions = [{ ms: 10000, t: '2026-01-01T10:00:00.000Z', spokeUntil: '2026-01-01T10:00:08.000Z', answer: 'Cena je tisoč evrov na mesec.' }];
  const segment = { ms: 12000, durationMs: 500, text: 'Cena je tisoč evrov na mesec.' };
  const segments = [segment];
  const segmentsSnapshot = JSON.parse(JSON.stringify(segments));

  filterAssistantEcho(segments, interactions);

  assert.deepEqual(segments, segmentsSnapshot, 'the original array and its objects are untouched');
  assert.ok(!('duringAssistantSpeech' in segment), 'the flag is added to a copy, never to the caller\'s own object');
});
