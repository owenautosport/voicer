# Voicer — design

**Date:** 2026-08-30
**Status:** approved, not yet implemented

## Purpose

A floating microphone button pinned above every window on macOS. One click starts listening,
another stops. Voicer transcribes what was said, captures the screen, asks a Claude Code agent
session, speaks the answer aloud, and — with full autonomy — drives the mouse and keyboard to
carry out whatever was asked.

The problem it removes is the round trip. Asking an AI about something on your screen normally
costs an alt-tab, a screenshot, a paste, a typed question, and a trip back. That is longer than
the question. Voicer is already in front of the work and can already see it.

### Success criteria

1. Click, speak a question about the visible window, hear a correct spoken answer, without
   touching the keyboard or moving away from the app in question.
2. Ask it to perform a multi-step task in a native app and watch it complete unattended.
3. Ask it to perform a task in Chrome and watch it complete unattended.
4. STOP halts an action in progress within a second.
5. Nothing said to Voicer leaves the machine for transcription.

## Constraints

- **The target machine is Intel.** A 2020 13" MacBook Pro: Core i5-1038NG7, four cores at 2.0 GHz,
  16 GB, macOS 26.5.1. No Neural Engine, no MLX, no usable GPU for inference. Kokoro-82M, the
  smallest credible neural voice, runs at roughly 0.5–0.7× real time on an M3 Pro and therefore
  slower than real time here; Fish-Speech is an order of magnitude larger again. **No local model
  inference anywhere in the design.** Speech synthesis is a network call or Apple's built-in
  synthesiser. Speech recognition uses Apple's on-device recogniser, which is a system service
  rather than a model Voicer loads.
- **Fish Audio's free tier is a promotion.** `s2.1-pro-free` is currently free and unmetered
  under fair use, with the free window stated as running to 2026-08-31 and subject to change with
  notice. Voice must therefore be a swappable backend with an always-available fallback, never a
  hard dependency.
- **No Xcode.app is installed**, only the command-line toolchain. The Swift component must build
  under SwiftPM and must be a plain binary, not an app target.
- **The agent's tool providers have policy tiers.** The `computer-use` MCP server grants full
  control of native applications but restricts browsers to read-only and terminals to click-only.
  Browser automation must route through `claude-in-chrome` instead.

## Architecture

Three processes.

```
┌──────────────────────────────────────────────────────────┐
│ Electron main                                            │
│   TurnMachine · AgentClient · TtsRouter · ActionLog      │
└───────┬───────────────────────────────┬──────────────────┘
        │ IPC                           │ stdio (NDJSON)
┌───────▼────────────┐         ┌────────▼───────────────────┐
│ Renderer (the pill)│         │ voicerkit (Swift)          │
│  mic meter         │         │  SFSpeechRecognizer        │
│  transcript        │         │  ScreenCaptureKit          │
│  status · STOP     │         │  AVSpeechSynthesizer       │
│  audio playback    │         └────────────────────────────┘
└────────────────────┘
```

### Why a Swift sidecar

Three jobs are materially better done natively: on-device speech recognition (free, offline, no
key, no audio leaving the machine), screen capture, and fallback synthesis. Each is a few dozen
lines of Swift against a system framework and would otherwise be a paid API or an unshippable
local model.

The sidecar is spawned as a **child of the Electron app**. macOS grants microphone and
screen-recording permission (TCC) to the app bundle; child processes inherit that grant. A
sidecar launched independently would need its own grant and its own usage-description strings,
which a SwiftPM binary with no bundle cannot present. The Electron app's `Info.plist` therefore
carries `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription` on the sidecar's
behalf. Screen recording has no corresponding plist key — macOS prompts for it on first capture
and it is granted to the bundle, which is a one-off manual approval in System Settings the first
time Voicer runs.

## Components

### 1. `voicerkit` — Swift sidecar

`native/voicerkit/`, built with SwiftPM, ad-hoc signed, copied into the app bundle's `Resources`.
Protocol is newline-delimited JSON, one object per line, requests on stdin and events on stdout.

| Request | Emits |
| --- | --- |
| `{"cmd":"listen_start","id":N}` | `{"id":N,"event":"partial","text":"…"}` repeatedly, then `{"id":N,"event":"final","text":"…"}` |
| `{"cmd":"listen_stop","id":N}` | terminates the stream with a `final` |
| `{"cmd":"capture","id":N}` | `{"id":N,"event":"captured","path":"/tmp/voicer-…​.jpg","w":…,"h":…}` |
| `{"cmd":"speak","id":N,"text":"…"}` | `{"id":N,"event":"speech_done"}` |
| `{"cmd":"cancel","id":N}` | `{"id":N,"event":"cancelled"}` |
| any | `{"id":N,"event":"error","code":"…","message":"…"}` |

Recognition uses `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true`, which is
supported on Intel Macs for `en-GB`. Audio is captured with `AVAudioEngine`; RMS level is emitted
alongside partials so the pill can animate. Capture uses `ScreenCaptureKit` for the main display,
downscaled so the longest edge is at most 1280 px and written as JPEG at quality 70 — enough for
the model to read UI text, small enough to keep the turn quick.

The `id` field correlates every response with its request; the sidecar handles one recognition
session at a time and rejects a second `listen_start` with an `error`.

### 2. Electron main

`src/main/`.

**`TurnMachine`** — a pure finite state machine with no Electron or Node imports, so it is
testable in isolation.

```
idle ──click──▶ listening ──click──▶ transcribing ──▶ capturing ──▶ thinking
                    │                                                  │
                    │                                    ┌─────────────┴──────────────┐
                    │                                    ▼                            ▼
                    │                                 speaking ◀──────────────────▶ acting
                    │                                    │                            │
                    └────────────── stop / abort ────────┴────────────────────────────┘
                                                          │
                                                          ▼
                                                        idle
```

`speaking` and `acting` interleave: the agent streams prose and tool calls in whatever order it
chooses, and the machine tracks both. Any `abort` transitions to `idle` from any state.

**`AgentClient`** — wraps `@anthropic-ai/claude-agent-sdk`'s `query()`.

- `permissionMode: 'bypassPermissions'` — this is the setting that delivers full autonomy; without
  it the SDK stops and asks, which cannot be answered from a voice widget.
- `mcpServers` — `computer-use` and `claude-in-chrome`, read from the user's existing Claude Code
  configuration so Voicer does not maintain a second copy.
- `resume: sessionId` — the previous turn's session id, which is what makes "no, the other one"
  resolve correctly. Stored in memory; cleared when the app quits.
- `abortController` — held by the STOP button and the kill hotkey.
- `appendSystemPrompt` — tells the agent its replies are *spoken*: two or three sentences, no
  markdown, no code blocks or file paths read aloud unless explicitly requested, and say what it
  is about to do before doing it.

The prompt for each turn is the transcript plus the captured screenshot as an image block.

**`TtsRouter`** — owns a `TtsBackend[]` and the current index. Accumulates streamed text, splits
on sentence boundaries, and enqueues each complete sentence so speech starts before the answer
finishes. On any backend failure it logs, demotes to the next backend for the remainder of the
session, and re-speaks the failed sentence there.

```ts
interface TtsBackend {
  readonly name: string
  speak(text: string, signal: AbortSignal): Promise<void>
}
```

- `FishBackend` — `POST https://api.fish.audio/v1/tts`, bearer token, model `s2.1-pro-free`,
  MP3 out, handed to the renderer to play. Ten-second timeout.
- `AppleBackend` — a `speak` command to the sidecar.

**`ActionLog`** — appends one JSON object per line to `~/.voicer/actions.jsonl` for every tool
call the agent makes: timestamp, turn id, tool name, arguments, result summary. Append-only,
never rotated by the app. This is the record of what an autonomous agent did to the machine.

### 3. Renderer

`src/renderer/`, plain TypeScript with Vite. One component; a framework would be overhead.

A 64 px circle that expands to a 380 px card while there is text to show. Transparent window,
`alwaysOnTop` at screen-saver level, visible on all workspaces and over fullscreen windows,
`focusable: false` so it never steals the keyboard. Position persisted to `~/.voicer/window.json`.

Visual states: **idle** (grey), **listening** (blue, ring pulsing with mic level), **thinking**
(amber, indeterminate), **speaking** (green), **acting** (red, pulsing — deliberately alarming,
because the agent has the controls). STOP is visible in every state except idle.

Audio playback lives here, in a hidden `<audio>` element, because Electron's main process has no
audio output.

## Data flow for one turn

1. Click. `listen_start`. Partials render live; the ring tracks RMS.
2. Click. `listen_stop` yields the final transcript. Empty transcript aborts the turn silently.
3. `capture` returns a JPEG path.
4. `AgentClient.run(transcript, imagePath, sessionId)` streams:
   - text deltas → transcript pane, and into `TtsRouter`,
   - `tool_use` → the status line ("clicking Send…"), state to `acting`, `ActionLog` entry,
   - `result` → the new session id is stored, state returns to `idle`.
5. STOP or ⌥⌘. at any point aborts the controller, cancels in-flight speech, and returns to idle.

## Error handling

| Failure | Response |
| --- | --- |
| Sidecar exits unexpectedly | Respawn once. A second failure within 30 s disables voice input and shows "microphone unavailable". |
| Permission denied (mic, speech, screen) | Pill shows a permission state and opens the relevant System Settings pane on click. Not retried in a loop. |
| On-device recognition unavailable for the locale | Fail loudly at startup with a specific message. Never silently fall back to server-side recognition — that would send audio off the machine, breaking a stated success criterion. |
| Fish Audio non-2xx, or timeout | Log, demote the session to `AppleBackend`, re-speak the sentence. Silent to the user beyond the change in voice. |
| Agent error or SDK exception | Speak one short apology, log the full error, keep the session id so the next turn still has context. |
| Abort mid-tool | The SDK's abort signal stops the turn; a partially completed action is *not* undone. The action log is how the user finds out what happened. |

## Testing

- **`TurnMachine`** — pure, no I/O. Exhaustive transition tests including abort from every state.
- **Sidecar protocol** — `voicerkit` is driven by piping fixture JSON at it and asserting on stdout,
  so the wire format is tested without a microphone. Swift-side unit tests cover downscaling maths.
- **`TtsRouter`** — a `FakeBackend` that can be told to fail proves demotion, and that sentence
  chunking never splits mid-sentence or drops a trailing fragment.
- **`AgentClient`** — a recorded stream fixture replays text deltas and tool-use events, proving
  the router and action log are driven correctly without invoking a real agent.
- **Manual** — the five success criteria above. Autonomous control of a real machine is not
  something to assert from unit tests.

Vitest for the TypeScript, `swift test` for the sidecar.

## Explicitly out of scope for v1

Wake-word activation; barge-in (interrupting mid-sentence); a conversation history view; a
graphical settings window (`~/.voicer/config.json` instead); notarised distribution; Windows and
Linux; any local model inference.

## Open risks

1. **Fish Audio's free window may close at any time.** Mitigated by the backend interface and the
   Apple fallback; the failure mode is a less pleasant voice, not an outage.
2. **`bypassPermissions` is genuinely dangerous.** An agent with the mouse and keyboard on a
   logged-in machine can do irreversible things. This was an explicit choice; the mitigations are
   visibility (red state), interruption (STOP, kill hotkey) and forensics (action log), not
   prevention.
3. **Turn latency on Intel hardware is unmeasured.** Recognition, capture, agent round trip and
   the first audio byte all add up, and the agent round trip dominates. If the total proves too
   slow to feel conversational, the first lever is to stop sending a screenshot on turns that do
   not need one.
