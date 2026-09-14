# Global knowledge layer (synthetic example)

SevenAI's prompt for any presentation is built from **two layers of files**:

```text
global layer                       presentation folder (one per deck)
  10-company.md                      10-vsebina-predstavitve.md
  20-services.md                     20-narocnik.md
  90-persona.md    (read last)       30-dodatne-informacije.md
  terminology.txt                    terminology.txt
            \                               /
             \                             /
              ▼                           ▼
     SYSTEM BLOCK: rules + GLOBAL KNOWLEDGE + PRESENTATION KNOWLEDGE
                   + merged TERMINOLOGY + SLIDE INDEX   (prompt-cached)
```

The files in this folder illustrate the **global** layer: content that is true in every meeting, meaning who the company is, what it offers and how the assistant speaks. For a presentation-layer example, see [demo/sample-presentation/](../../demo/sample-presentation/).

**This is a synthetic example.** In production the global layer describes the company that operates SevenAI. This example uses a fictional agency, **Harbor Lane Studio**, so no real company facts, references or wording are reproduced. It is written in English for readability. Production knowledge is written in Slovenian, although the loader itself does not depend on language.

## Rules the loader applies

- Every `.md` / `.txt` file in the directory is knowledge, **except** `terminology.txt` and any README.
- Files are concatenated in **filename order**, so numeric prefixes set the order. The persona is numbered last so its speaking rules are the most recently read.
- Only top-level files are read; subfolders are ignored.
- `terminology.txt` holds one term per line, and `#` starts a comment. Global and presentation terms are merged and de-duplicated case-insensitively. The list goes to speech recognition as vocabulary and into the prompt as a spelling reference.
- A `## PRIVZETI POZDRAV` ("default greeting") section in the global text supplies the fallback introduction. Its `>` quoted lines are spoken when a deck has no greeting of its own.

## What belongs where

| Global layer | Presentation folder |
|---|---|
| Company description, services, general FAQ | What this deck proposes, slide by slide |
| How the assistant speaks (persona) | Who the client is and what not to promise |
| Company-wide terminology | Client and product names for this deck |
| The default greeting | This deck's own greeting and scripted Q&A |

**Client facts never go into the global layer**, even when several decks share a client. The global layer reaches every meeting, so anything client-specific placed there could surface in another client's presentation.
