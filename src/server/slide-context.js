/**
 * Current-slide context, extracted for this showcase from the presentation
 * registry (server/presentations.js), which is not published: the registry also
 * composes the production system prompt.
 *
 * The block below rides in the UNCACHED user turn of every question, next to
 * the meeting memory. The cached system prompt carries the deck's knowledge;
 * this carries "where are we right now", so a question like "how would you
 * extend THIS?" resolves to the slide on screen.
 *
 * Prompt strings are Slovenian because SevenAI answers in Slovenian.
 */

/**
 * Slide context injected into EVERY question. Kept short on purpose: it rides
 * in the uncached user turn, so every token is paid per request.
 * @param {object} presentation
 * @param {number} n 1-based slide number
 * @returns {string}
 */
export function slideContextBlock(presentation, n) {
  const all = presentation.slides;
  const slide = all.find((s) => s.n === Number(n));
  if (!slide) return 'TRENUTNO PRIKAZANA PROSOJNICA: neznana.';

  const points = slide.points.map((p) => `- ${p}`).join('\n');

  // A screenshot or a diagram usually cannot explain itself: "prikaz zaslonov"
  // means nothing without the concept slide it belongs to. A deck declares that
  // with "continues": <n>, and the parent's summary rides along - which is what
  // makes "kako bi TO nadgradili?" resolve to the actual idea rather than to a
  // picture of some screens.
  const parent = slide.continues ? all.find((s) => s.n === Number(slide.continues)) : null;

  // Two titles of orientation, so the model knows where in the argument it is.
  const before = all.find((s) => s.n === slide.n - 1);
  const after = all.find((s) => s.n === slide.n + 1);
  const neighbours = [
    before ? `prejšnja: ${before.title}` : null,
    after ? `naslednja: ${after.title}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return [
    `TRENUTNO PRIKAZANA PROSOJNICA: ${slide.n} od ${all.length}`,
    `Naslov: ${slide.title}`,
    slide.summary ? `Vsebina: ${slide.summary}` : '',
    points ? `Ključne točke:\n${points}` : '',
    parent ? `Ta prosojnica prikazuje: ${parent.title}. ${parent.summary || ''}`.trim() : '',
    neighbours ? `Sosednji prosojnici: ${neighbours}` : '',
    // The whole reason this block travels with every single question.
    'Kadar vprašanje uporablja kazalni zaimek (to, tega, tem, ta rešitev) ali je brez ' +
      'konteksta, se nanaša na to prosojnico.',
  ]
    .filter(Boolean)
    .join('\n');
}
