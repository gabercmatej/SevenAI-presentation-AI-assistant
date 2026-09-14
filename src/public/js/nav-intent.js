/**
 * Is this sentence an instruction to move the deck, or a question to answer?
 *
 * The routing is deterministic on purpose. "Pojdi na peti slajd" has exactly
 * one correct outcome and it is not a matter of opinion, so it never reaches
 * the model: a language model asked for a slide number will occasionally
 * invent one, and a deck jumping to slide 14 in front of a client because the
 * model guessed is the kind of failure nobody forgets. Parsing it here also
 * means navigation happens in a few milliseconds instead of a few seconds.
 *
 * Four outcomes:
 *   {kind:'slide',    n}       an explicit slide: "pojdi na peti slajd"
 *   {kind:'relative', delta}   "pokaži naslednjo stran"
 *   {kind:'concept',  topic}   "pokaži cenik" - the caller resolves it
 *                              against the deck's own keywords
 *   null                       everything else, which is a question
 *
 * The bar for navigating is deliberately high. A sentence must open with a
 * navigation verb, and a sentence that opens like a question never navigates,
 * because the expensive mistake is not "he answered when I wanted him to move"
 * - it is the deck jumping away from the slide the room is discussing.
 */

/**
 * Verbs that can begin an instruction to move.
 *
 * "daj" is deliberately absent. It reads as a navigation verb but in this room
 * it almost always opens a request for content - "daj jim eno idejo posebej za
 * naslednje leto" - and letting it navigate cost slide 1 in testing. "dej", its
 * colloquial twin, is absent for the same reason and is only allowed in the
 * tight "dej naprej/dalje/nazaj" idiom handled separately below.
 *
 * "nazaj" and "naprej" are also deliberately absent, even though they read as
 * movement words. Listing them here used to mean the verb search - which scans
 * the first three words for ANY match - would treat "naprej" or "nazaj" as the
 * lead verb wherever it turned up, so "no, naprej z drugo temo" (still talking)
 * and "nazaj k tistemu, kar ste rekli" (a callback, not a jump) both moved the
 * deck. They still work after a real verb ("pojdi naprej") because they are
 * matched inside `rest` below, and they work standalone ("naprej", "nazaj")
 * through the bare-phrase block, which requires them to be the whole
 * utterance - the one place a bare direction word is trustworthy.
 */
const VERBS =
  '(?:pojdi|pojdimo|pojdite|pejt|skoci|skoc|preskoci|pokazi|prikazi|odpri|vrni|vrnimo|vrnite|preklopi|premakni|premaknite|premaknimo|obrni)';

/**
 * Words that mean "a page of this deck".
 *
 * "stran" carries a negative lookahead because this is a sales tool: "stranka"
 * is the CLIENT, and "naslednji stranki" must never read as "next page".
 *
 * "slaj" is the TRUNCATED form, and it is here because of a real rehearsal.
 * The bare-phrase block below has to match the whole utterance, so when the
 * transcriber handed over "naslednji slaj" instead of "naslednji slajd" the
 * pattern failed by one letter and a two-word command that should never cost
 * anything went to the model and thought about it for several seconds. The
 * lookahead keeps it to exactly that: the word ending right there. Without it
 * "slaj\\w*" would also swallow "slajši" (sweeter), and widening a navigation
 * pattern to catch a real adjective is how a deck starts jumping mid-sentence.
 */
const SLIDE_NOUN = '(?:slajd\\w*|slajt\\w*|slide\\w*|slaj(?![a-z])|stran(?!k)\\w*|prosojnic\\w*|diapozitiv\\w*|list\\w*)';

/**
 * Slovenian ordinals by stem, so every case ending matches: "peti slajd",
 * "peto stran", "na petem slajdu". Longest stems first - "dvaindvajset" must
 * win over "dvajset", and "enajst" over "ena".
 *
 * The list runs to thirty, not to the length of any one deck. It used to stop
 * at twenty-two, which was exactly the page count of the first deck imported,
 * and a 25-page deck then had three slides that could be reached by digits
 * ("pojdi na slajd 25") but not by the words a presenter actually says
 * ("pojdi na petindvajseti slajd") - the ordinal fell through to concept
 * parsing and the deck either answered or moved somewhere else. Nothing here
 * is per-deck: `total` is what bounds a spoken number to the deck in the room
 * (see parseNavigation), and this table only has to be able to name it.
 */
const ORDINALS = [
  ['devetindvajset', 29],
  ['sedemindvajset', 27],
  ['stiriindvajset', 24],
  ['osemindvajset', 28],
  ['sestindvajset', 26],
  ['dvaindvajset', 22],
  ['enaindvajset', 21],
  ['petindvajset', 25],
  ['triindvajset', 23],
  ['devetnajst', 19],
  ['osemnajst', 18],
  ['sedemnajst', 17],
  ['sestnajst', 16],
  ['petnajst', 15],
  ['stirinajst', 14],
  ['trinajst', 13],
  ['dvanajst', 12],
  ['enajst', 11],
  ['trideset', 30],
  ['dvajset', 20],
  ['deset', 10],
  ['devet', 9],
  ['osm', 8],
  ['osem', 8],
  ['sedm', 7],
  ['sedem', 7],
  ['sest', 6],
  ['pet', 5],
  ['cetrt', 4],
  ['stiri', 4],
  ['tretj', 3],
  ['tri', 3],
  ['drug', 2],
  ['dve', 2],
  ['dva', 2],
  ['prv', 1],
  ['ena', 1],
  ['en', 1],
];

/** Lowercase, strip diacritics, collapse whitespace. */
export function normalise(s) {
  return String(s || '')
    .toLowerCase()
    // A stroked d does not decompose under NFD, so it is mapped by hand.
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remove the way people address him before saying anything else:
 * "hej sedemcek, pojdi ..." -> "pojdi ...".
 */
function stripAddress(s) {
  return s
    .replace(/^(?:hej|hey|zivjo|oj|ok|okej|halo)\s+/i, '')
    .replace(/^(?:sevenai|seven ai|sedemcek\w*|seven|sedem cek)\s+/i, '')
    .replace(/^(?:hej|hey|zivjo|oj)\s+/i, '')
    .trim();
}

/**
 * Case endings only. Matching a bare prefix would read "petindvajseti" as
 * "peti" and send the deck to slide 5 when the presenter said twenty-five.
 */
const CASE_ENDING = /^(?:i|a|o|e|u|ega|emu|em|em[au]|ih|im|imi|ju|ima)?$/;

/** @param {string} word @returns {number|null} */
function ordinalValue(word) {
  for (const [stem, value] of ORDINALS) {
    if (word.startsWith(stem) && CASE_ENDING.test(word.slice(stem.length))) return value;
  }
  return null;
}

/**
 * Words that make a sentence a genuine question no matter what follows them.
 *
 * Checked ANYWHERE in the sentence, not just at the front, because the tail
 * rule below deliberately ignores how a sentence opens - and "povej mi, kaj je
 * na naslednjem slajdu" ends in exactly the same three words as a command.
 */
const QUESTION_WORD = /\b(?:kako|zakaj|kaj|kdaj|kje|kdo|koliko|kater\w*|kaksn\w*)\b/;

/**
 * Openers that mark a request rather than narration. Only used to let a
 * SENTENCE-FINAL bare "naprej"/"nazaj" count - a direction word on its own is
 * only trustworthy when something in front of it was asking for something.
 */
const REQUEST =
  /^(?:(?:a|ali)\s+)?(?:bi\s+)?(?:lahko|prosim|daj|dej|dajmo|gremo|greva|gres|pojdi\w*|premakn\w*|prestav\w*|preklop\w*|pomakn\w*|obrn\w*|nadaljuj\w*|klikn\w*)\b/;

/**
 * The politeness rule: a sentence that ENDS on an explicit slide reference is
 * an instruction, whatever it opened with.
 *
 * This exists because of a real meeting. "Bi lahko dal na naslednji slajd" was
 * routed to the model - it opens with "bi", and the opener test below reads
 * that as a question - so Sedemček helpfully described the next slide instead
 * of showing it. Slovene wraps requests in the conditional constantly ("bi
 * lahko", "a lahko", "bi šel"), and a presenter who has said the words
 * "naslednji slajd" out loud has not asked for a description of it.
 *
 * What keeps this safe is that BOTH ends of the sentence have to agree:
 *
 *   - no question word anywhere, so "kaj pokažemo na naslednji strani" and
 *     "kaj je bilo na prejšnjem slajdu" stay questions;
 *   - the slide reference has to be the LAST thing said (bar a trailing
 *     "prosim"), so "na naslednjem slajdu vidite naše reference" and "in
 *     naprej z naslednjo točko" are still narration and move nothing.
 *
 * A reference here also has to be explicit - a direction or a number pinned to
 * a slide noun. A bare "naprej" only counts after a request opener.
 *
 * @param {string} t the normalised, address-stripped sentence
 * @param {number} total
 */
function tailInstruction(t, total) {
  if (QUESTION_WORD.test(t)) return null;
  const s = t.replace(/\s+(?:prosim|hvala|no|pa)$/, '').trim();
  const end = (body) => new RegExp(`(?:^|\\s)(?:${body})$`).test(s);

  if (end(`naslednj\\w*\\s+${SLIDE_NOUN}`) || end(`${SLIDE_NOUN}\\s+(?:naprej|dalje)`)) {
    return { kind: 'relative', delta: 1 };
  }
  if (end(`(?:prejsnj\\w*|predhodn\\w*)\\s+${SLIDE_NOUN}`) || end(`${SLIDE_NOUN}\\s+nazaj`)) {
    return { kind: 'relative', delta: -1 };
  }
  // A bare direction word, but only when the sentence was asking for something.
  if (REQUEST.test(s)) {
    if (end('naprej|dalje')) return { kind: 'relative', delta: 1 };
    if (end('nazaj')) return { kind: 'relative', delta: -1 };
  }

  // "daj na slajd 7", "a lahko na 7. slajd"
  const digits = s.match(new RegExp(`(?:^|\\s)(?:${SLIDE_NOUN}\\s+(\\d{1,2})|(\\d{1,2})\\s+${SLIDE_NOUN})$`));
  if (digits) {
    const n = Number(digits[1] ?? digits[2]);
    if (n >= 1 && n <= total) return { kind: 'slide', n };
  }

  // "bi lahko dal na peti slajd"
  const words = s.split(' ');
  if (words.length >= 2 && new RegExp(`^${SLIDE_NOUN}$`).test(words[words.length - 1])) {
    const n = ordinalValue(words[words.length - 2]);
    if (n !== null && n >= 1 && n <= total) return { kind: 'slide', n };
  }
  return null;
}

/**
 * @param {string} text what the presenter said
 * @param {{total?:number}} [opts] how many slides the deck has
 * @returns {{kind:string, n?:number, delta?:number, topic?:string}|null}
 */
export function parseNavigation(text, { total = 99 } = {}) {
  const raw = normalise(text);
  if (!raw) return null;
  const s = stripAddress(raw);

  // A slide named at the very end of the sentence is an instruction however
  // the sentence began - see tailInstruction() for why, and for the two things
  // that keep it from swallowing questions.
  const tail = tailInstruction(s, total);
  if (tail) return tail;

  // A sentence that opens as a question is a question, whatever verbs appear
  // later in it. "Kako bi lahko pokazali mobilno aplikacijo?" asks for an
  // answer; it must not move the deck.
  if (/^(?:kako|zakaj|kaj|kdaj|kje|kdo|koliko|kateri|katera|katero|ali|bi|se da|a lahko|lahko)\b/.test(s)) return null;

  // --- bare relative phrases: no verb needed, but the WHOLE utterance --------
  // "Naslednji slajd" and "nazaj" are already complete instructions with no
  // verb in front of them, so they cannot go through the verb search below.
  // What they trade for that is a stricter match: the pattern has to cover the
  // entire sentence (an optional trailing "prosim" aside), because a direction
  // word inside a longer sentence is usually talk, not a command - "gremo
  // naprej z drugim delom" is still narrating content, and a bare "naprej" or
  // "nazaj" that isn't the whole thing is exactly the shape that used to send
  // the deck jumping out of a sentence about something else entirely. "gremo"
  // and "dej" are colloquial openers for the idiom only, never general verbs -
  // see the note on VERBS above for why "dej" cannot lead on its own.
  const PLEASE = '(?:\\s+prosim)?$';
  if (
    new RegExp(`^naslednj\\w*(?:\\s+${SLIDE_NOUN})?${PLEASE}`).test(s) ||
    new RegExp(`^naprej${PLEASE}`).test(s) ||
    new RegExp(`^dalje${PLEASE}`).test(s) ||
    new RegExp(`^(?:en|eno|ena)\\s+${SLIDE_NOUN}\\s+(?:naprej|dalje)${PLEASE}`).test(s) ||
    /^(?:gremo|dej)\s+(?:naprej|dalje)(?:\s+prosim)?$/.test(s)
  ) {
    return { kind: 'relative', delta: 1 };
  }
  if (
    new RegExp(`^(?:prejsnj\\w*|prej)(?:\\s+${SLIDE_NOUN})?${PLEASE}`).test(s) ||
    new RegExp(`^nazaj${PLEASE}`).test(s) ||
    new RegExp(`^(?:en|eno|ena)\\s+${SLIDE_NOUN}\\s+nazaj${PLEASE}`).test(s) ||
    /^(?:gremo|dej)\s+nazaj(?:\s+prosim)?$/.test(s)
  ) {
    return { kind: 'relative', delta: -1 };
  }

  const words = s.split(' ');
  const verbAt = words.findIndex((w) => new RegExp(`^${VERBS}$`).test(w));
  // The instruction has to START with the verb, give or take a filler word.
  // Deep in a sentence, a verb is part of a question.
  const hasVerb = verbAt !== -1 && verbAt <= 2;
  if (!hasVerb) return null;

  // Everything after the verb, minus the little connecting words.
  let rest = words
    .slice(verbAt + 1)
    .join(' ')
    .replace(/^(?:se\s+)?(?:na|k|do|v|nam|jim|mi|nazaj na|naprej na)\s+/, '')
    .replace(/^(?:na|k|do|v)\s+/, '')
    // "vrnimo SE nazaj ..." - the reflexive can precede a bare direction word
    // too, not just a preposition, and it has to come off before the check
    // just below can see the direction word leading `rest`.
    .replace(/^se\s+/, '')
    .trim();

  // --- relative: "naslednja stran", "prejsnji slajd" ------------------------
  // The direction word can carry the noun on either side of it ("slajd
  // naprej", "premakni slajd naprej") or none at all ("pojdi naprej"), since
  // all three are the same instruction said with a different amount of
  // padding.
  if (
    new RegExp(`^naslednj\\w*(\\s+${SLIDE_NOUN})?$`).test(rest) ||
    new RegExp(`^(?:${SLIDE_NOUN}\\s+)?(?:naprej|dalje)(?:\\s+${SLIDE_NOUN})?$`).test(rest) ||
    new RegExp(`^(?:en|eno|ena)\\s+${SLIDE_NOUN}\\s+(?:naprej|dalje)$`).test(rest)
  ) {
    return { kind: 'relative', delta: 1 };
  }
  if (
    new RegExp(`^(?:prejsnj\\w*|prej)(\\s+${SLIDE_NOUN})?$`).test(rest) ||
    new RegExp(`^(?:${SLIDE_NOUN}\\s+)?nazaj(?:\\s+${SLIDE_NOUN})?$`).test(rest) ||
    new RegExp(`^(?:en|eno|ena)\\s+${SLIDE_NOUN}\\s+nazaj$`).test(rest)
  ) {
    return { kind: 'relative', delta: -1 };
  }
  // "vrni se eno nazaj/naprej" - a bare quantifier with no noun still counts.
  if (/^(?:eno\s+)?nazaj$/.test(rest)) return { kind: 'relative', delta: -1 };
  if (/^(?:eno\s+)?naprej$/.test(rest)) return { kind: 'relative', delta: 1 };

  // "premakni slajd" - said with no direction at all, it still has to mean
  // something, and in this room it always means forward. An explicit
  // direction ("premakni slajd nazaj") is caught by the blocks above first,
  // so this only fires when the presenter really did leave it unqualified.
  if (/^premakn\w*$/.test(words[verbAt]) && new RegExp(`^${SLIDE_NOUN}$`).test(rest)) {
    return { kind: 'relative', delta: 1 };
  }

  // A direction word that LEADS `rest` but isn't the whole of it (once slide-
  // noun padding above is discounted) is picking a conversation back up, not
  // asking for a slide: "vrnimo se nazaj k prejšnji temi, o kateri smo
  // govorili" is a callback to an earlier topic, not "previous slide". Left
  // alone it would fall into concept parsing below and hand the model a
  // "topic" that is actually the rest of a sentence about something else.
  if (/^(?:nazaj|naprej|dalje)\b/.test(rest)) return null;

  // --- explicit slide number ------------------------------------------------
  // Digits: "slajd 5", "5. slajd", "na 5".
  const digit = rest.match(new RegExp(`(?:^|\\b)(?:${SLIDE_NOUN}\\s+)?(\\d{1,2})(?:\\s+${SLIDE_NOUN})?(?:\\s|$)`));
  if (digit) {
    const n = Number(digit[1]);
    const mentionsSlide = new RegExp(SLIDE_NOUN).test(rest);
    // A bare number only counts when the sentence is about slides; otherwise
    // "pokazi 6 primerov" would jump to slide 6.
    if (n >= 1 && n <= total && (mentionsSlide || rest.trim() === String(n))) return { kind: 'slide', n };
  }

  // Words: "peti slajd", "slajd pet", "peto stran", or a bare ordinal.
  const restWords = rest.split(' ').filter(Boolean);
  const nounIdx = restWords.findIndex((w) => new RegExp(`^${SLIDE_NOUN}$`).test(w));
  for (let i = 0; i < restWords.length; i++) {
    if (i === nounIdx) continue;
    const value = ordinalValue(restWords[i]);
    if (value === null || value > total) continue;
    // nounIdx of -1 means there is no slide noun at all, and must not be
    // allowed to satisfy "the ordinal sits just before it".
    const nextToNoun = nounIdx !== -1 && (nounIdx === i + 1 || nounIdx === i - 1);
    const aloneAfterVerb = restWords.length === 1;
    if (nextToNoun || aloneAfterVerb) return { kind: 'slide', n: value };
  }

  // --- concept --------------------------------------------------------------
  // "pokazi jim cenik", "pojdi na reference".
  const topic = rest
    .replace(new RegExp(`^(?:temo|del|tisti del z|tisti del|tam kjer je|kjer je|tocko|${SLIDE_NOUN})\\s+`), '')
    .replace(/^(?:o|z|s|pri|glede)\s+/, '')
    .trim();
  if (topic.length < 3) return null;
  return { kind: 'concept', topic };
}

export default parseNavigation;
