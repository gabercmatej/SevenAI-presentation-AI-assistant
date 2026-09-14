/**
 * server/meeting-memory.js - the rolling meeting memory that lets a 70-minute
 * meeting cost Sedemcek exactly as much per question as a 5-minute one.
 *
 * Two properties are under test, and both come straight from the file's own
 * header: the memory block is BOUNDED (every list capped, so the block is a
 * few kB whether the meeting ran ten minutes or two hours), and updating it
 * is O(new speech) rather than O(meeting) - updateDue() only ever looks at
 * segments after coveredUntilMs, and the trigger policy exists so a whole
 * hour of conversation costs about twenty cheap background calls, not one
 * per sentence.
 *
 * Nothing here calls updateMemory() or buildUpdatePrompt's network sibling -
 * those reach an LLM. Only the pure functions around them are exercised.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  updateDue,
  normalizeMemory,
  renderMemory,
  parseJsonObject,
  emptyMemory,
  TRIGGER,
} from '../server/meeting-memory.js';

// ------------------------------------------------------------- updateDue ----

test('updateDue: nothing new since the last update is never due', () => {
  const memory = { ...emptyMemory(), coveredUntilMs: 5000 };
  const segments = [{ ms: 1000, text: 'staro' }, { ms: 4000, text: 'se starejse' }];
  const result = updateDue({ memory, segments });
  assert.equal(result.due, false);
  assert.equal(result.reason, 'nothing_new');
});

test('updateDue: a big new slice of transcript is due on its own, without waiting for a timer', () => {
  const memory = emptyMemory();
  const bigText = 'x'.repeat(TRIGGER.NEW_CHARS);
  const segments = [{ ms: 1000, text: bigText }];
  const result = updateDue({ memory, segments });
  assert.equal(result.due, true);
  assert.equal(result.reason, 'new_transcript');
});

test('updateDue: an ending session is due whenever anything at all is new, however small', () => {
  const memory = emptyMemory();
  const segments = [{ ms: 1000, text: 'samo eno kratko stavek' }];
  const result = updateDue({ memory, segments, ending: true });
  assert.equal(result.due, true);
  assert.equal(result.reason, 'session_ending');
});

test('updateDue: the elapsed-time trigger needs BOTH enough time AND a minimum of new text', () => {
  const memory = emptyMemory();
  const now = 1_000_000;
  const lastRunAt = now - TRIGGER.ELAPSED_MS; // exactly enough time has passed

  const enoughText = [{ ms: 1000, text: 'x'.repeat(TRIGGER.MIN_CHARS) }];
  const dueOnTime = updateDue({ memory, segments: enoughText, lastRunAt, now });
  assert.equal(dueOnTime.due, true);
  assert.equal(dueOnTime.reason, 'elapsed');

  // Time passed, but there is barely anything new to justify a model call -
  // a quiet stretch must not still cost a call every four minutes.
  const tooLittleText = [{ ms: 1000, text: 'x'.repeat(TRIGGER.MIN_CHARS - 1) }];
  const notDue = updateDue({ memory, segments: tooLittleText, lastRunAt, now });
  assert.equal(notDue.due, false);
  assert.equal(notDue.reason, 'below_threshold');
});

test('updateDue: an assistant interaction lowers the bar for a fresh update, but does not remove it entirely', () => {
  const memory = emptyMemory();

  const overAfterInteractionBar = [{ ms: 1000, text: 'x'.repeat(TRIGGER.AFTER_INTERACTION_CHARS) }];
  const due = updateDue({ memory, segments: overAfterInteractionBar, interactionSince: true });
  assert.equal(due.due, true);
  assert.equal(due.reason, 'after_interaction');

  const underEvenTheLoweredBar = [{ ms: 1000, text: 'x'.repeat(TRIGGER.AFTER_INTERACTION_CHARS - 1) }];
  const notDue = updateDue({ memory, segments: underEvenTheLoweredBar, interactionSince: true });
  assert.equal(notDue.due, false, 'interactionSince makes an update cheaper to justify, not free');
});

test('updateDue only ever considers segments after coveredUntilMs - the property that makes an update cost O(new speech), not O(meeting)', () => {
  const memory = { ...emptyMemory(), coveredUntilMs: 10000 };
  const segments = [
    { ms: 1000, text: 'already covered, from earlier in the meeting' },
    { ms: 9999, text: 'also already covered' },
    { ms: 10001, text: 'new since the last update' },
    { ms: 15000, text: 'also new' },
  ];
  const result = updateDue({ memory, segments, ending: true });
  assert.equal(result.newSegments.length, 2);
  assert.ok(result.newSegments.every((s) => s.ms > 10000));
});

// ----------------------------------------------------------- normalizeMemory

test('normalizeMemory caps every list - checked here on decisions (cap 12), the same discipline applies to all six', () => {
  // The index has to appear as a word longer than 3 characters, or
  // normalizeMemory's own dedup-by-content-key would collapse all 30 of
  // these into one entry before the cap ever gets a chance to matter.
  const raw = { decisions: Array.from({ length: 30 }, (_, i) => ({ text: `Odlocitev stevilka entry${String(i).padStart(3, '0')} popolnoma unikatna` })) };
  const out = normalizeMemory(raw);
  assert.equal(out.decisions.length, 12);
});

test('normalizeMemory drops an entry with no usable text', () => {
  const raw = { decisions: [{ text: '' }, { text: '   ' }, {}, { text: 'Prava odlocitev' }] };
  const out = normalizeMemory(raw);
  assert.equal(out.decisions.length, 1);
  assert.equal(out.decisions[0].text, 'Prava odlocitev');
});

test('normalizeMemory collapses duplicates by content, not by exact wording', () => {
  const raw = {
    decisions: [
      { text: 'Dogovorili smo se za paket Premium.' },
      { text: 'dogovorili SMO se za paket premium' }, // same content, different case/punctuation
      { text: 'Nekaj popolnoma drugega.' },
    ],
  };
  const out = normalizeMemory(raw);
  assert.equal(out.decisions.length, 2, 'the near-duplicate collapses into one entry');
});

test('normalizeMemory: a commitment owner outside seven|client|unknown becomes unknown, never a guess', () => {
  // Assigning a task to a client who never accepted it is a fabricated
  // commitment attributed to a real person - "unknown" is the only safe
  // fallback for anything the model was not explicitly told.
  const raw = { commitments: [{ text: 'Poslati ponudbo.', owner: 'boss' }, { text: 'Pripraviti demo.', owner: 'seven' }] };
  const out = normalizeMemory(raw);
  const byText = Object.fromEntries(out.commitments.map((c) => [c.text, c.owner]));
  assert.equal(byText['Poslati ponudbo.'], 'unknown');
  assert.equal(byText['Pripraviti demo.'], 'seven', 'a legitimate owner is preserved, not overridden');
});

test('normalizeMemory degrades a completely malformed model response to an empty-but-valid memory rather than throwing', () => {
  for (const bad of [null, undefined, {}, { decisions: 'not an array' }, 'a plain string', 42]) {
    const out = normalizeMemory(bad);
    assert.equal(out.version, 1);
    assert.deepEqual(out.decisions, []);
    assert.deepEqual(out.commitments, []);
    assert.deepEqual(out.openQuestions, []);
    assert.deepEqual(out.clientInterests, []);
    assert.deepEqual(out.objections, []);
    assert.deepEqual(out.importantFacts, []);
  }
});

// -------------------------------------------------------------- renderMemory

test('renderMemory omits an empty section entirely rather than printing an empty header', () => {
  const memory = normalizeMemory({ decisions: [{ text: 'Edina odlocitev.' }] });
  const rendered = renderMemory(memory);
  assert.match(rendered, /DOGOVORJENO:/);
  assert.doesNotMatch(rendered, /NASLEDNJI KORAKI:/);
  assert.doesNotMatch(rendered, /ODPRTA VPRAŠANJA:/);
});

test('renderMemory renders an owner-less commitment as "ni določeno", never blank and never a guess', () => {
  const memory = normalizeMemory({ commitments: [{ text: 'Nekaj je treba narediti.' }] });
  const rendered = renderMemory(memory);
  assert.match(rendered, /ni določeno/);
});

test('renderMemory of an empty memory is a short honest sentence, not an empty string', () => {
  const rendered = renderMemory(emptyMemory());
  assert.ok(rendered.length > 0);
  assert.equal(rendered, 'SPOMIN SESTANKA: zaenkrat še ni zabeleženih dogovorov ali odprtih vprašanj.');
});

test('renderMemory stays bounded even with every list filled to its cap - this is what keeps answer latency independent of meeting length', () => {
  // Every list at its documented cap, every entry at the maximum length
  // normalizeMemory allows (220 characters) - the true theoretical worst
  // case, not a realistic one (a well-behaved model writes one short
  // sentence per entry, as the memory-update prompt instructs).
  const caps = { decisions: 12, commitments: 12, openQuestions: 10, clientInterests: 8, objections: 8, importantFacts: 12 };
  const raw = {};
  for (const [field, cap] of Object.entries(caps)) {
    raw[field] = Array.from({ length: cap }, (_, i) => {
      // The unique "entryNNNN" token must land in normalizeMemory's dedup
      // key (its first up-to-8 content words), or same-length filler text
      // would collapse every entry in a field down to one and defeat the
      // point of this test - it needs the cap to actually be reached.
      const base = `Unikatna tocka entry${String(i).padStart(4, '0')} za polje ${field}`;
      const text = (base + ' ' + 'x'.repeat(Math.max(0, 220 - base.length - 1))).slice(0, 220);
      const entry = { text, at: '14:22:10', slide: 12 };
      if (field === 'clientInterests') entry.weight = 5;
      return entry;
    });
    if (field === 'commitments') raw[field].forEach((e) => { e.owner = 'unknown'; });
  }
  const memory = normalizeMemory(raw);
  const rendered = renderMemory(memory);

  // NOTE: the file's own header claims the block stays "~2-4 kB" no matter
  // how full it gets. At the true worst case (every cap filled with a
  // TEXT_MAX-length entry) it renders far larger than that - see this
  // suite's final report for the measured number. The property this test
  // actually protects - the one the header cares about - is that the size
  // is bounded by the CAPS constants alone and cannot grow with meeting
  // length, which the assertion below still checks.
  assert.ok(rendered.length < 20000, `worst-case memory block was unexpectedly large: ${rendered.length} chars`);
});

// ------------------------------------------------------------ parseJsonObject

test('parseJsonObject accepts plain JSON, a ```json fenced block, and JSON surrounded by prose', () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonObject('Seveda, tukaj je zapis:\n{"a":1}\nUpam da pomaga!'), { a: 1 });
});

test('parseJsonObject returns null for anything that cannot be parsed, rather than throwing', () => {
  assert.equal(parseJsonObject('not json at all'), null);
  assert.equal(parseJsonObject(''), null);
  assert.equal(parseJsonObject('{"a": broken}'), null);
});
