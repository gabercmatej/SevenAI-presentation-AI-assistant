# Presentation engine

SevenAI is not a chatbot floating over PowerPoint. The deck is part of the runtime: the assistant knows which slide is on screen, slide changes are recorded against the meeting transcript, and voice commands move the deck through the same code path as the keyboard.

Related: [knowledge-system.md](knowledge-system.md) · [presentation-versioning.md](presentation-versioning.md) · sample deck: [demo/sample-presentation/](../demo/sample-presentation/)

## A presentation is a folder

```text
<presentation-id>/
  presentation.json            title, client, presenter, answer style, settings, greeting
  slides.json                  per slide: title, summary, points, keywords, mood
  timeline.json                cue points, when the deck is one continuous video
  10-vsebina-predstavitve.md   knowledge, read in filename order
  20-narocnik.md
  30-dodatne-informacije.md
  terminology.txt              recognition and prompt vocabulary
  answers.json                 scripted and prepared answers
  greeting.txt                 optional opening line
  media/deck.mp4               continuous deck video (object storage, not in git)
  slides/slide-NN.jpg          per-slide stills and fallback images
```

Adding a presentation changes no application code. Folders starting with `_` are templates and are hidden from the picker. A test walks the shared server, frontend and script code and fails if client-specific terms appear there.

## Two kinds of deck

| Kind | Source | Rendering |
|---|---|---|
| **Timeline deck** | one continuous video export (for example a Canva deck exported as a single MP4) plus page screenshots | the video is driven as discrete slides |
| **Per-slide deck** | one video or image per slide | each slide is its own element; a slide with no media becomes a card generated from `slides.json` |

## Turning one video into slides

A continuous export keeps every animation and transition exactly as designed, but it loses the one thing a presenter needs: stopping on a page for as long as the conversation takes. An offline build step recovers that.

**Which page is on screen** is found by matching every video frame (downscaled greyscale) against the exported page screenshots. **When a page has finished animating** is found from motion, measured per block so a small embedded animation is not averaged away. The two signals are kept separate on purpose. A frame that merely *looks like* the finished screenshot can still be mid-animation, and stopping there would freeze a half-drawn page.

```text
transition   frames match no page well          distance high, motion high
entrance     the page resolves into place       distance falls, motion falls
animation    reveals, typing, easing            distance flat, motion low but real
HOLD         nothing moves                      distance minimal, motion ≈ 0
exit         the page starts leaving            distance rises, motion rises
```

A page hidden in the design tool is exported as a screenshot but absent from the video. It never matches, so the live numbering closes the gap automatically and the original page number is kept in `canvaPage`.

A page with an endless embedded reel never goes still. It is declared as a loop explicitly, because a finite animation and an endless loop look identical in the motion signal. Holds can also be declared by hand when a tiny animation is below detection.

### timeline.json

```json
{
  "video": "deck.mp4",
  "duration": 96.4,
  "fps": 30,
  "canvaPages": 7,
  "hiddenPages": [5],
  "videoSha256": "<sha256 of the optimized video>",
  "slides": [
    { "n": 1, "canvaPage": 1, "enterAt": 0.0,  "holdAt": 1.9,  "holdUntil": 4.8,  "exitAt": 5.2 },
    { "n": 2, "canvaPage": 2, "enterAt": 5.2,  "holdAt": 7.1,  "holdUntil": 12.6, "exitAt": 13.0,
      "loopStart": 7.1, "loopEnd": 12.6 }
  ]
}
```

The build also produces a seek-optimized copy of the video (a keyframe twice per second, no audio track) and a still image per slide. Recording the video hash lets a verifier detect a timeline built from a different export.

## Deterministic playback

Playback is never "playing" in the video sense. It is always a move from one hold to another:

| Action | Behaviour |
|---|---|
| **next** | seek to the current slide's `exitAt`, play the real exit, transition and entrance, stop on the next slide's hold |
| **previous** | seek to the previous slide's `enterAt`, replay its entrance, stop on its hold (video cannot play backwards) |
| **jump to n** | the same move as previous, from any slide to any slide |
| **rapid presses** | intermediate transitions are skipped; the move lands on the final target |

Seeking to `exitAt` rather than playing forward from the current position means a slide that has been still for twenty seconds starts its transition the moment the key is pressed.

**Stopping on the right frame.** `timeupdate` fires only a few times a second, which at 30 fps can overshoot by several frames. Stops are driven by `requestVideoFrameCallback` (once per decoded frame), and after pausing, `currentTime` is set back to the exact cue point.

**Nothing moves while the assistant talks.** Between moves the video is paused on an exact frame. Only navigation starts playback.

**The whole video is held in memory** as a Blob after loading, so every seek is served locally with no buffering mid-meeting.

**Safety.** The server validates `timeline.json` against `slides.json`: slide count, numbering, cue ordering, loop bounds and the presence of the video. On any mismatch it **rejects the timeline** and falls back to per-slide rendering. Showing one page while the assistant talks about another is worse than losing the animations. If the video fails to load or decode in the browser, the deck switches to the per-slide stills.

## Navigation surfaces

| Input | Actions |
|---|---|
| Keyboard | Arrow keys and PageUp/PageDown (previous/next), Home/End (first/last), digits + Enter (jump), F (fullscreen), Esc (cancel the assistant) |
| Voice | slide numbers (digits and Slovenian ordinals), next/previous, first/last, topic by title/keyword; see [realtime-voice.md](realtime-voice.md#deterministic-navigation-versus-questions) |
| Recording | Shift+R toggles meeting recording (Shift prevents a stray keypress from starting or stopping a recording) |

Every slide change emits an event. The meeting recorder logs it, so each transcript segment can be tied to the slide that was visible.

## Per-presentation settings

Settings that belong to one meeting, not to the whole product, live in `presentation.json`:

| Setting | Default | Range |
|---|---|---|
| `settings.mascotSizePx` | 180 | 60–400 |
| `settings.subtitlesEnabled` | true | |
| `settings.speakingSpeed` | server default | 0.5–2.5 |
| `settings.preview` | slide 1's image | must be inside this deck's own media path |
| `greeting.enabled` | false | |
| `greeting.delayMs` | 5000 | 0–15000 |
| `greeting.text` | none, falls back to `greeting.txt` | ≤ 4000 characters |

A hand-edited file and the in-app settings editor go through the same normalisation. An out-of-range value is **clamped**, a wrongly typed value falls back to its default, and a warning names the deck and field. The editor writes only known fields, leaves every other key untouched, and keeps a timestamped backup before each overwrite.

A downloaded cloud version is immutable, so presenter edits are stored beside it. Settings are kept as a patch that carries over to the next version. Edited answers are kept per version.

Room-specific tuning (VAD calibration) and the recording preference are stored per laptop, not per deck, because they describe the room and the person, not the client.

## Greeting

What SevenAI says to introduce itself, whether automatically at open or when asked "Predstavi se", is resolved deterministically:

1. a scripted Q&A entry for the introduction cue,
2. this presentation's greeting (`greeting.text`, else `greeting.txt`),
3. the global default greeting from the persona file.

The automatic greeting is off by default (presenters usually prefer to cue it). When enabled it fires at most once per open, after the delay, and only if nobody has asked anything yet.

## Scripted Q&A and exact responses

`answers.json` holds two kinds of entry:

| Entry | Matching | Use |
|---|---|---|
| `"scripted": true` | strict: minimum score and minimum coverage of the question, checked **before** the model | a line the presenter wrote and expects to hear **word for word** |
| `"scripted": false` | looser keyword similarity | a prepared answer used when no model is configured or the model times out |

Scripted entries are the exact-response mode. They need no network, they never paraphrase, and the settings panel ("Vprašanja in odgovori", Questions and answers) shows how many entries are verbatim. The coverage floor matters: a one-word cue must not fire on any sentence that happens to contain that word. Scripted matching is skipped for questions about the meeting itself ("what have we agreed so far?"), which no rehearsed line can answer.

## Verification before a deck is used

A verifier reads the deck exactly as the running server would and drives the real timeline class against a simulated video clock. It reports PASS/WARN/FAIL/N/A for slide count and page mapping, hidden pages, the video hash, cue-point accuracy, loops, forward/backward/random/rapid navigation, the final-slide freeze and current-slide context. Unresolved placeholders in the knowledge are reported for review.
