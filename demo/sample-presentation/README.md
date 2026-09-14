# Sample presentation: Northstar Rewards

A **synthetic** presentation folder for the fictional company **Northstar Retail**, pitching a fictional loyalty app. It mirrors the real on-disk structure and JSON schemas the SevenAI presentation loader reads. All content is invented.

The knowledge files, scripted answers and greeting are in **Slovenian**, as they are in production: SevenAI speaks Slovenian, and scripted answers and greetings are read aloud word for word. Short English glosses are included below.

See [docs/presentation-engine.md](../../docs/presentation-engine.md) and [docs/knowledge-system.md](../../docs/knowledge-system.md).

## Files

| File | Role |
|---|---|
| `presentation.json` | Deck metadata (title, client, presenter, language), `answerStyle` (target answer length in seconds, turned into a word budget), `greeting` (off by default), per-deck `settings`, and `createdAt`/`order` for catalogue sorting. |
| `slides.json` | One entry per live slide: `n`, `title`, `summary`, `points`, `keywords` (Slovenian and English variants for voice navigation), `canvaPage` (original design page), `mood` (assistant reaction on slide change), and optional `continues` (slide 4 illustrates slide 3, so it inherits that slide's idea as context). |
| `timeline.json` | Cue points for a deck exported as one continuous video: `enterAt`, `holdAt`, `holdUntil`, `exitAt` per slide, a loop on slide 4, and `hiddenPages: [5]` showing how a hidden design page closes the numbering gap. Hashes are zeroed placeholders. |
| `10-vsebina-predstavitve.md` | Presentation content, slide by slide (what each page means). |
| `20-narocnik.md` | About the client: interests and what must not be promised. |
| `30-dodatne-informacije.md` | Deck-specific FAQ and the note that illustrative numbers are not commitments. |
| `terminology.txt` | Deck-specific terms, one per line. Merged with global terms and sent to both speech recognition and the prompt. |
| `answers.json` | Q&A. Entries with `"scripted": true` are matched strictly before the model and spoken verbatim. The `false` entry is a prepared answer used only if no model is available or the first token times out. |
| `greeting.txt` | This deck's opening line. A leading `#` line is ignored. It is used only if `greeting.enabled` is true, or when the presenter asks "Predstavi se". |

Knowledge `.md` files are read in filename order, which is why they have numeric prefixes. Adding another knowledge area means adding another numbered file.

## What is deliberately not here

- **No media.** In production the optimized `media/deck.mp4` and `slides/slide-NN.jpg` stills live in private object storage and are downloaded into the local cache as a hash-verified version. Without `media/deck.mp4`, the loader rejects `timeline.json` (the video it describes is missing) and falls back to per-slide rendering. Slides with no image become cards generated from `slides.json`. This fallback is itself real behaviour.
- **No real client, brand or person.** `[DOPOLNI]` ("to be completed") marks facts the demo does not know. SevenAI is instructed never to state such a placeholder as fact.

## English glosses

| Slide | Title |
|---|---|
| 1 | Northstar Rewards (cover) |
| 2 | Challenge: customers who don't come back |
| 3 | Solution: the Northstar Rewards app |
| 4 | App screens (illustrates slide 3) |
| 5 | Weekly challenges and points |
| 6 | Timeline and next steps |

Scripted answers: "How much does the app cost?" hands off to a post-workshop quote. "When could we start the pilot?" defers the date to the workshop. The greeting introduces SevenAI and invites questions at any time.
