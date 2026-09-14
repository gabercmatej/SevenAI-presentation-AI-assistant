# Source excerpt

This folder is a **curated excerpt** of the production SevenAI codebase. It is
here so the engineering can be read, not so the product can be rebuilt. There
is no `package.json`, and several modules import files that are deliberately
not published.

Files keep their production paths (`server/`, `cloud/`, `electron/`,
`public/js/`, `scripts/`, `tests/`) so the relative imports and tests read
as they do in the real repository. Client examples in comments were replaced
with neutral ones; the production cloud URL is `https://cloud.example.com`.

## What is included

| Area | Files | What to look at |
|---|---|---|
| Model orchestration | `server/llm.js`, `server/slide-context.js` | One model per job (live / memory / summary), thinking disabled on the live path, a cached system-prompt block, fallback only before the first token |
| Streamed speech | `server/util.js`, `server/tts/*` | Sentence splitter feeding TTS while the answer is still streaming; configurable provider chain (Google, Azure, OpenAI) with one voice pinned per answer |
| Meeting memory | `server/meeting-memory.js`, `server/meeting-intelligence.js` | Threshold-triggered, bounded, structured memory; final summary with a fact vs. suggestion boundary |
| Transcript hygiene | `server/assistant-filter.js`, `server/transcript-search.js` | Keeping the assistant's own voice out of the meeting transcript; retrieval without embeddings |
| Greeting | `server/greeting.js`, `public/js/greeting-scheduler.js` | Greeting resolution order; one-shot greeting that never talks over the room |
| Versioned deck cache | `server/presentation-store.js`, `server/cache-gc.js`, `server/presentation-cleanup.js`, `server/deck-overrides.js`, `server/paths.js` | SHA-256 verified downloads, shared blob store, atomic materialisation, Session pins, reference-safe cleanup |
| Presentation runtime | `public/js/timeline.js`, `public/js/nav-intent.js` | One video driven like a slide deck with frame-accurate holds; deterministic Slovenian voice navigation that never reaches the LLM |
| Cloud safety | `cloud/lib/presentation-delete.js`, `cloud/lib/errors.js`, `cloud/db/migrations/002_rls.sql` | Admin, team-scoped delete-or-archive; shared media removed only when unreferenced; default-deny Row Level Security |
| Desktop hardening | `electron/*`, `server/auth-store.js`, `scripts/scan-desktop-build.js` | Sandboxed renderer, locked navigation, loopback-only server, secrets stripped from the packaged environment, safeStorage + AES-256-GCM auth at rest, build secret scan |
| Tests | `tests/*` | `node --test` suites for the modules above, using synthetic data only |

## What is intentionally not included

- The cloud API itself: routes, authentication middleware, the provider lease endpoint and the full database schema.
- The local runtime core: `server.js`, the Session store and runtime, cloud sync, and the presentation registry that composes the production system prompt.
- The provider-lease client and the cloud client (described in [docs/security.md](../docs/security.md) instead).
- Operational tooling: deployment verification, backups, admin bootstrap, import and publishing scripts.
- The UI layer (dashboard, Sessions view, settings, mascot): shown as screenshots instead.
- All client presentations, production knowledge, Sessions and credentials.

Architecture for the parts that are not published is described in [docs/](../docs/).
