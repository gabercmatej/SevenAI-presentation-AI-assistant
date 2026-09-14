# Knowledge system

SevenAI answers from what it has been given for this presentation and this meeting, and from nothing else. This document describes the knowledge layers, the exact order they are assembled in, and why one client's material cannot reach another client's meeting.

Related: [presentation-engine.md](presentation-engine.md) · [meeting-memory.md](meeting-memory.md) · examples: [demo/sample-presentation/](../demo/sample-presentation/) · [examples/knowledge/](../examples/knowledge/)

## Layers

| Layer | Source | Changes | Where it goes |
|---|---|---|---|
| **Rules** | generated per presentation (assistant name, deck title, word budget, speaking rules) | per deck | system block (cached) |
| **Global knowledge** | global layer: company, services, reference material, technical FAQ, persona | rarely | system block (cached) |
| **Presentation knowledge** | the deck folder's numbered `.md` / `.txt` files | per version | system block (cached) |
| **Terminology** | global + presentation `terminology.txt`, de-duplicated | per version | system block (cached) and speech recognition vocabulary |
| **Slide index** | titles from `slides.json` | per version | system block (cached) |
| **Scripted Q&A** | `answers.json` | per version, editable | matched before the model; never in the prompt |
| **Greeting** | scripted intro, `greeting.text` / `greeting.txt`, global default | per deck | deterministic; never generated |
| **Recent conversation** | the last few question/answer messages in this open deck | per question | message history |
| **Current slide context** | the visible slide's title, summary, points, neighbours | every question | user turn (uncached) |
| **Meeting memory** | rolling structured memory + recent room transcript | every few minutes | user turn (uncached, only while recording) |
| **The question** | transcript, with the word budget repeated | every question | user turn (uncached) |

## Assembly order, as implemented

```text
SYSTEM  (one block, cache_control: ephemeral, 1 h TTL)
  rules          assistant identity, Slovenian speech rules, word budget,
                 "answer only from the knowledge below", "[DOPOLNI] is not a fact"
  ===== GLOBAL KNOWLEDGE =====          global layer files, filename order, persona last
  ===== PRESENTATION KNOWLEDGE =====    this deck's files, filename order
  ===== TERMINOLOGY =====                merged term list
  ===== SLIDE INDEX =====                "1. Title", "2. Title", ...

MESSAGES
  history        up to the last 4 messages, each truncated
  USER TURN
    current slide     "slide 3 of 6", title, summary, key points,
                      the parent slide if this one illustrates another,
                      previous and next titles,
                      "demonstratives like 'this' refer to this slide"
    meeting context   (only inside a recording Session)
                      rendered meeting memory
                      recent room transcript (last 4 min, ≤ 18 segments, ≤ 2200 chars)
                      for questions ABOUT the meeting: retrieved transcript lines + gap warning
    question          Slovenian, at most N words, short first sentence, then the question text
```

Knowledge files are concatenated in **filename order**, which is why they carry numeric prefixes (`10-`, `20-`, `30-`). The persona file is numbered last so its rules are the most recently read. A README and the terminology file are excluded from the knowledge text. Adding a new knowledge area is adding a file.

## Why this split

**Everything stable is cached.** The system block is identical for every question in a presentation, so Anthropic prompt caching applies to all of it. The cache TTL is one hour rather than the default five minutes, because audience questions often come more than five minutes apart. Without the longer TTL, most questions would pay a cache write instead of a cheap cache read. Each answer logs whether the cache hit, so a cache that silently stopped working is visible in the logs.

**Everything that changes is not.** The current slide and meeting context change between questions, so they ride in the uncached user turn. They are kept short because they are paid for on every request.

**The current slide is the primary disambiguator.** "Kaj to pomeni?" (What does this mean?) and "zakaj je ta rešitev zanimiva?" (why is this solution interesting?) resolve against what is on screen. A slide can declare `continues: <n>` so a screenshot or diagram slide inherits the idea of the concept slide it illustrates.

**Rules are repeated where they hold.** The word budget and short-opener rule appear in the system block and again in the user turn. A length rule tens of kilobytes up a system prompt drifts after a few answers.

**No retrieval for knowledge.** A presentation's whole knowledge base fits comfortably in the context window. Retrieval would add latency and a failure mode for no accuracy gain at this size. Meeting transcripts use a local keyword scan for questions about the meeting, not an embedding index (see [meeting-memory.md](meeting-memory.md#asking-about-the-meeting)).

## Per-presentation isolation

Cross-client leakage is prevented by construction:

- **A prompt is built from exactly two sources:** the global layer and one presentation directory. The loader resolves a presentation id to a single directory (a cached immutable version, or an authored folder) and reads only that directory's top-level files. Nested files are ignored.
- **The global layer is company-level only.** Client facts belong in each deck's own files, even when two decks share a client.
- **Shared code never names a client.** A test scans the server, frontend and scripts for deck-specific terms and fails the build on a hit. Deck-specific behaviour is expressed as data in the deck folder.
- **Meeting context is keyed by Session id,** and a Session belongs to exactly one presentation. Another meeting's transcript or memory is never read into a prompt.
- **Scripted answers are per deck, and edited answers are stored per version.** A new deck starts with an empty Q&A list, and one meeting's scripts are never copied into another.
- **In the cloud,** every presentation query is filtered by the caller's team in the same statement that looks the row up.

## Scripted exact answers versus model answers

| | Scripted answer | Model answer |
|---|---|---|
| Source | presenter-written `answers.json` entry with `scripted: true` | Claude over the assembled context |
| When | checked first, strict score and coverage thresholds | when no scripted entry matches |
| Output | spoken word for word | generated within the word budget |
| Network | none | LLM provider |
| Typical use | introductions, pricing handoffs, legally sensitive phrasing | open questions about the deck |

Prepared non-scripted entries are the fallback when no model is configured or the first token times out. If nothing matches, SevenAI says it does not have that information and offers to follow up. It never produces an empty answer or an error message.

## Not inventing facts

The rules instruct the model to answer only from the provided knowledge. When an exact price, number, date, deadline or commitment is missing, the model must say so calmly and offer to confirm it later. Anything marked `[DOPOLNI]` ("to be completed") in a knowledge file is never stated as fact. Leaving a field empty is preferred to inventing one, and the deck verifier reports unresolved placeholders before a meeting.

## File conventions

```text
global layer                          presentation folder
  10-company.md                         10-vsebina-predstavitve.md   slide-by-slide meaning
  20-services.md                        20-narocnik.md               audience, needs, what is not promised
  ...                                   30-dodatne-informacije.md    deck-specific FAQ
  90-persona.md    (last)               40-govor-in-izgovorjava.md   pronunciation and hand-off phrasing
  terminology.txt                       terminology.txt
```

The global persona file contains a `## PRIVZETI POZDRAV` (default greeting) section. Its quoted lines are the fallback introduction.
