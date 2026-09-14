# Session folder (synthetic example)

A complete, **synthetic** Session: a 24-minute meeting presenting the fictional [Northstar Rewards demo deck](../../demo/sample-presentation/) to the fictional company Northstar Retail. The file names, record shapes and field names follow the production Session store. All people, text, ids and hashes are invented. Speakers are anonymous diarization labels, as in production.

The meeting text is in Slovenian, as it would be in a real Session. See [docs/meeting-memory.md](../../docs/meeting-memory.md) for the full design.

```text
s-20260115-100000-demo/
  session.json         metadata, lifecycle, stats
  transcript.jsonl     19 segments
  events.jsonl         19 events
  interactions.jsonl   3 assistant exchanges
  memory.json          rolling meeting memory at the end of the meeting
  summary.json         final meeting summary
  sync.json            cloud sync cursors
```

## What happened in this meeting

| Time | Event |
|---|---|
| 10:00 | Session starts with recording on; slide 1 |
| 10:06:38 | Presenter asks SevenAI how the app connects to existing tills; the model answers |
| 10:06:54 | The client talks over the answer. The segment is kept and flagged `duringAssistantSpeech: true` (barge-in) |
| 10:11:38 | "Hey Seven, pojdi na tedenske izzive." A deterministic topic navigation to slide 5 (`navigation_command`, `slide_change`) |
| 10:14:00 | Decision: a pilot in one store |
| 10:15–10:16 | The live transcription connection drops (`transcription_gap` … `transcription_resumed`) |
| 10:18:25 | "Koliko stane aplikacija?" matches a **scripted** answer, spoken verbatim (`source: "cache"`) |
| 10:21:38 | "Kaj smo se do zdaj dogovorili?" A question about the meeting, answered from memory and transcript |
| 10:24 | Session ends; background processing runs |
| 10:25 | Summary written; raw audio deleted after verification (`audio_deleted`) |

## Files

**`session.json`** is rewritten atomically on every change. It holds the `schemaVersion`, the Session id (sortable date-time plus a random suffix), `presentationId`, and the `presentationVersionId` pinned at creation and never rewritten. The lifecycle fields are `status` (`active` → `processing` → `ready` / `failed`), `summaryStatus`, `transcriptStatus` (`realtime`, `finalizing`, `final`, `partial`), `audioRetention` (`delete` by default) and `audioStatus`. `stats` counts segments, words, events, interactions and stored audio. `recordedMs` is derived from the recording events. `assistantFiltered` counts echoes of the assistant's own voice that were dropped, which is why they appear nowhere else in this folder.

**`transcript.jsonl`** is append-only, one segment per line: `t` (ISO), `clock` (local), `ms` since start, `durationMs`, `speaker`, `text`, `slide` (metadata, never part of the text), `source` and `duringAssistantSpeech`. Note:
- The presenter's own "Hey Seven …" questions appear here, because the meeting microphone hears them. What SevenAI *said* does not; that lives only in `interactions.jsonl`.
- The segment at 10:15:00 has `source: "final"` and `speaker: "Speaker ?"`. It was filled from stored audio for the window the live transcript missed. A batch transcript does not know who spoke, so no speaker is invented.
- Because the final pass merged a filled window in, production also keeps the pre-merge live file as `transcript.realtime.jsonl`. It is omitted here for brevity.

**`events.jsonl`** is append-only: `session_started`, `recording_started`, `slide_change`, `assistant_question` / `assistant_answer`, `navigation_command`, `transcription_gap` / `transcription_resumed`, `session_ended`, `audio_deleted`. Slide changes let any segment be tied to the slide on screen. Gaps become explicit breaks in the transcript view and are named in the summary prompt.

**`interactions.jsonl`** is append-only, one exchange with SevenAI per line: question, answer, slide, `source` (`llm` for a model answer, `cache` for a scripted or prepared one) and `spokeUntil`. The echo filter uses `spokeUntil` to know when the assistant's voice was in the room. Production records may also carry per-answer diagnostic timings, omitted here.

**`memory.json`** is the rolling memory as it stood after the final flush. The lists are `decisions`, `commitments` (each with `owner`: `seven`, `client` or `unknown`), `openQuestions`, `clientInterests` (with `weight`), `objections` and `importantFacts`. `coveredUntilMs` marks how far into the meeting the memory accounts for, and `updates` counts the background updates.

**`summary.json`** is the final meeting summary. Every list except `followUpSuggestions` must be supported by the transcript and carries its timestamp. `followUpSuggestions` is the model's own idea, has no timestamp, and is labelled as an AI suggestion in the UI. `basedOn` records what the analysis could see, including the one gap.

**`sync.json`** holds the cloud sync state. `cursors` are line counts already acknowledged per stream, and `bytes` are the matching file offsets. `revisions.transcript: 2` shows the transcript was replaced once by the final pass and re-sent as a full, transactional replace. `audio.uploaded` is empty because retention is `delete`, and audio is uploaded only when retention is `keep`. Hash values here are placeholders.

## What is not here

- **`audio/`**: raw audio chunks (self-contained files of about 90 seconds, plus `index.jsonl`) existed during the meeting and were deleted once the transcript was verified and the summary succeeded.
- **Real data of any kind.** This folder is illustrative only.
