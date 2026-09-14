/**
 * server/transcript-search.js - finding the part of a meeting a question is
 * about, with a linear keyword scan instead of a vector store.
 *
 * isMeetingQuestion is the gate that decides whether a question is about the
 * PRODUCT (answered from the deck, possibly from a rehearsed scripted
 * answer) or about the ROOM (answered from what was actually said). Getting
 * this wrong in either direction is a real failure: a question about the
 * room answered from a script invents what happened, and a question about
 * the product needlessly dragged into meeting-retrieval mode wastes the
 * budget searchTranscript exists to protect.
 *
 * Everything here is pure - no fs, no fetch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMeetingQuestion,
  searchTranscript,
  recentWindow,
  renderSegments,
} from '../server/transcript-search.js';

// -------------------------------------------------------- isMeetingQuestion

test('isMeetingQuestion is true for questions that can only be answered from what was actually said in the room', () => {
  const meetingQuestions = [
    'Kaj smo se do zdaj dogovorili?',
    'Kaj smo se danes dogovorili?',
    'Kaj je bilo glavno vprašanje?',
    'Kaj smo rekli glede CRM-ja?',
    'Kaj še moramo preveriti?',
    'Ali smo govorili o ceni?',
  ];
  for (const q of meetingQuestions) {
    assert.equal(isMeetingQuestion(q), true, `expected a meeting question: "${q}"`);
  }
});

test('isMeetingQuestion is false for ordinary presentation questions - these must be free to use a rehearsed scripted answer', () => {
  const productQuestions = [
    'Kako deluje ta rešitev?',
    'Koliko stane licenca?',
    'Kaj to pomeni?',
  ];
  for (const q of productQuestions) {
    assert.equal(isMeetingQuestion(q), false, `expected NOT a meeting question: "${q}"`);
  }
});

// ---------------------------------------------------------- searchTranscript

function seg(ms, text, extra = {}) {
  return { ms, text, clock: `00:00:${String(ms / 1000).padStart(2, '0')}`, speaker: 'Speaker 1', slide: null, ...extra };
}

test('searchTranscript finds the segment containing a rare term, even a crudely-stemmed variant of it', () => {
  const segments = [
    seg(0, 'Dober dan vsem, začnimo s predstavitvijo.'),
    seg(1000, 'To je prva slajd o podjetju.'),
    seg(2000, 'Kako poteka integracijo s CRM sistemom, to je pogosto vprašanje.'),
    seg(3000, 'Nadaljujmo na naslednjo temo.'),
    seg(4000, 'Hvala za pozornost.'),
  ];
  const found = searchTranscript(segments, 'Kako poteka integracija s CRM-jem?');
  assert.ok(found.some((s) => s.ms === 2000), 'the segment with the matching (stemmed) term is found');
});

test('searchTranscript returns a hit together with its neighbours, in chronological order', () => {
  const segments = [
    seg(0, 'Uvodni pogovor o vremenu.'),
    seg(1000, 'Se en uvodni stavek pred glavno temo.'),
    seg(2000, 'Vprasanje je bilo o robotiki in avtomatizaciji tovarne.'), // the only segment that matches
    seg(3000, 'Sledil je premor za kavo.'),
    seg(4000, 'Zakljucna beseda sestanka.'),
  ];
  const found = searchTranscript(segments, 'Povejte mi vec o robotiki.', { neighbours: 1 });
  const foundMs = found.map((s) => s.ms);
  assert.deepEqual(foundMs, [1000, 2000, 3000], 'the hit plus one neighbour on each side, still time-ordered');
});

test('searchTranscript returns nothing for a question with no content words, and nothing for an empty transcript', () => {
  assert.deepEqual(searchTranscript([seg(0, 'Neka vsebina.')], 'Kaj? Ali? Kako?'), [], 'only stop words - nothing to search for');
  assert.deepEqual(searchTranscript([], 'Kaj smo se dogovorili?'), [], 'no transcript to search at all');
});

test('searchTranscript respects maxChars by dropping the LOWEST-scoring segments first', () => {
  const long = (label) => `${label} ${'beseda '.repeat(40)}`;
  const segments = [
    seg(0, long('malo-povezano besedilo o vremenu')), // matches loosely, if at all
    seg(1000, long('robotika avtomatizacija tovarne robotika')), // matches strongly, term repeated
    seg(2000, long('se malo-povezano besedilo o kavi')),
  ];
  const full = searchTranscript(segments, 'robotika avtomatizacija', { maxChars: 100000 });
  const trimmed = searchTranscript(segments, 'robotika avtomatizacija', { maxChars: 400 });

  assert.ok(trimmed.length < full.length, 'the char cap actually dropped something');
  assert.deepEqual(trimmed.map((s) => s.ms), [1000], 'only the strongest evidence survives the cap');
});

test('searchTranscript weighs a rare term more than one repeated in almost every segment', () => {
  const segments = [
    seg(0, 'To je redkokdaj omenjena podrobnost o pogodbi.'), // "redkokdaj" appears nowhere else
    seg(1000, 'Pogosto se to vprasanje pojavi na sestankih.'),
    seg(2000, 'Pogosto se to vprasanje ponovi znova in znova.'),
    seg(3000, 'Pogosto o tem govorimo tudi v podjetju.'),
    seg(4000, 'Pogosto smo to omenjali tudi prej.'),
  ];
  // neighbours: 0 keeps every returned score "pure" (no diluted neighbour score).
  const found = searchTranscript(segments, 'pogosto redkokdaj', { neighbours: 0, limit: 10 });

  const rareOnly = found.find((s) => s.ms === 0);
  const commonOnly = found.find((s) => s.ms === 1000);
  assert.ok(rareOnly && commonOnly);
  assert.ok(rareOnly.score > commonOnly.score, 'the segment matching only the rare term outscores one matching only the common term');
});

// -------------------------------------------------------------- recentWindow

test('recentWindow returns only the last N minutes, chronological, bounded by maxSegments and maxChars', () => {
  const segments = [];
  for (let i = 0; i < 20; i++) segments.push(seg(i * 60_000, `Minuta ${i}.`)); // one segment per minute, 0..19

  // The floor is inclusive, so a 4-minute-wide window at 1-minute spacing
  // yields 5 samples (minute 15 through minute 19) - a window's DURATION, not
  // a fixed sample count, is the contract here.
  const recent = recentWindow(segments, { minutes: 4, maxSegments: 100, maxChars: 100000, nowMs: 19 * 60_000 });
  assert.deepEqual(
    recent.map((s) => s.ms),
    [15, 16, 17, 18, 19].map((m) => m * 60_000),
    'every segment within the last 4 minutes, oldest first'
  );

  const boundedBySegments = recentWindow(segments, { minutes: 30, maxSegments: 3, maxChars: 100000, nowMs: 19 * 60_000 });
  assert.equal(boundedBySegments.length, 3);
  assert.deepEqual(boundedBySegments.map((s) => s.ms), [17 * 60_000, 18 * 60_000, 19 * 60_000], 'the most recent ones win when segments must be dropped');

  const boundedByChars = recentWindow(segments, { minutes: 30, maxSegments: 100, maxChars: 20, nowMs: 19 * 60_000 });
  assert.ok(boundedByChars.length < 20, 'the char cap trims it too');
});

// ------------------------------------------------------------ renderSegments

test('renderSegments prints the slide as bracketed metadata and never merges it into the spoken text', () => {
  const segments = [{ clock: '10:05:00', slide: 7, speaker: 'Speaker 1', text: 'To je natanko, kar je bilo povedano.', duringAssistantSpeech: false }];
  const out = renderSegments(segments);
  assert.match(out, /slide 7/);
  assert.ok(out.includes('To je natanko, kar je bilo povedano.'), 'the segment\'s own text appears verbatim');
  // The slide label lives inside the bracketed metadata prefix, never inside
  // the spoken text itself - a model reading this must never mistake "slide 7"
  // for something somebody said.
  const spokenPart = out.split(': ').slice(1).join(': ');
  assert.equal(spokenPart, 'To je natanko, kar je bilo povedano.');
});

test('renderSegments marks a segment recorded while the assistant was speaking', () => {
  const segments = [
    { clock: '10:00:00', slide: null, speaker: 'Speaker ?', text: 'Kontestiran trenutek.', duringAssistantSpeech: true },
    { clock: '10:00:05', slide: null, speaker: 'Speaker ?', text: 'Cist trenutek.', duringAssistantSpeech: false },
  ];
  const [contested, clean] = renderSegments(segments).split('\n');
  assert.match(contested, /med govorom asistenta/);
  assert.doesNotMatch(clean, /med govorom asistenta/);
});
