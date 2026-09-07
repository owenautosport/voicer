# Voicer

A small microphone button that floats above everything on your Mac. Click it, talk, click
it again. Voicer sees what is on your screen, answers out loud, and — when you ask it to —
takes over the mouse and keyboard and does the thing for you.

> **Status: a spoken turn works end to end.** Click, ask a question about what is on screen,
> hear the answer — verified on real hardware. 131 unit tests and a 21-check sidecar self-test
> pass. Still unverified: the agent driving a native app or Chrome unattended (success criteria
> 2 and 3). See [the design](docs/superpowers/specs/2026-08-30-voicer-design.md) and
> [the plan](docs/superpowers/plans/2026-08-30-voicer-v1.md).

## Why

Screen-sharing your problem to an AI usually means alt-tabbing to a chat window, screenshotting,
pasting, typing the question, reading the answer, and going back. That round trip is longer than
the question. Voicer removes it: the assistant is already pinned in front of the thing you are
stuck on, it can already see it, and you never have to stop looking at your work to ask.

## How it works

```
click mic  ──▶  listen        on-device speech recognition, partials stream live
stop talking ▶  stop          a pause ends the turn; clicking again also works
           ──▶  capture       screen grab, downscaled
           ──▶  think         Claude Code agent session (transcript + screenshot)
           ──▶  speak         answer streams out sentence by sentence
           ──▶  act           mouse and keyboard, if the answer needs doing
```

Typing works too: the keyboard button opens a compose box and skips the microphone
entirely. Clicking the capsule while it is working means "stop that and listen to me".

Three processes:

| Process | Job |
| --- | --- |
| **Electron main** | Window management, the agent loop, text-to-speech routing |
| **Renderer** | The pill itself — mic level, live transcript, status, STOP |
| **`voicerkit`** (Swift) | Ears, eyes, and the fallback voice |

The Swift sidecar is one small binary speaking newline-delimited JSON over stdin/stdout. It
exists because three jobs are simply better done natively on macOS: on-device speech recognition
(`SFSpeechRecognizer`, free, offline, no API key, nothing leaves the machine), screen capture,
and `AVSpeechSynthesizer` as the fallback voice. It runs as a **child of the Electron app** on
purpose — macOS grants microphone and screen-recording permission to the app bundle, and a child
process inherits that grant.

The brain is a headless [Claude Code](https://claude.com/claude-code) session driven through the
Claude Agent SDK, so it authenticates with your existing subscription rather than a metered API
key, and it inherits the MCP servers, skills and instructions you have already configured.

### Voice

Voicer speaks through a pluggable backend:

1. **[Fish Audio](https://fish.audio) `s2.1-pro-free`** — the default. Human-sounding, free, no
   card required.
2. **Apple `AVSpeechSynthesizer`** — the fallback, via the sidecar. Offline and always available.

Any failure from the first demotes the session to the second for the rest of its life. Fish
Audio's free tier is a time-limited promotion, so when it ends Voicer gets less pleasant to
listen to rather than silently breaking, and adding a third backend is one file.

### Computer control

Voicer implements its own control, rather than borrowing Claude Code's. The sidecar posts
`CGEvent`s for click, type, key and scroll, and Voicer exposes those to the agent as an in-process
MCP server called `voicer-control`, alongside the screenshot it already takes.

This was forced rather than chosen. Claude Code ships a `computer-use` MCP server, and the `claude`
binary will even run it standalone — but every call from a headless session comes back with *"This
computer-use server instance is not wired to a session"*, because the implementation lives in an
interactive session's state. (A second trap on the way: the MCP server *name* `computer-use` is
reserved. Register a server under it and the CLI substitutes its own built-in, which then vanishes
from the session with no error at all.)

Owning the executor turns out to be the better end state anyway. Claude Code's server caps browsers
at read-only and terminals at click-only, so it can *see* Chrome but not type into it. Voicer's has
no such tier — Chrome and Terminal are controllable like anything else.

Because the capsule floats above everything — including whatever it is being asked to drive —
it checks before every pointer action whether it is sitting on the target, and moves to the
furthest alignment if it is, returning to the one you chose when the turn ends.

The agent runs with permissions bypassed — it acts rather than asking first. The rails
against that are visibility and reversibility, not confirmation prompts:

- a global kill hotkey (<kbd>⌥</kbd><kbd>⌘</kbd><kbd>.</kbd>) that aborts mid-action,
- an unmissable red pulsing state whenever it has the controls,
- an append-only log at `~/.voicer/actions.jsonl` recording everything it did.

## Permissions

**The app must be code signed, or macOS refuses everything without asking.** An unsigned
bundle is not prompted for the microphone, screen recording or accessibility — TCC simply
answers "denied", and Voicer hears silence and sees nothing. Worse, a grant is remembered
against the signature, so ad-hoc signing (a fresh hash every build) makes each rebuild a
different app that silently loses the permissions the last one was given, while the row in
System Settings stays switched on.

`npm run signing-identity` creates a stable self-signed identity once; every build is signed
with it, and the grants then survive rebuilds — and moving the app to `/Applications`.

macOS gates everything else too. Two grants are manual:

| Pane | Manual? | Without it |
| --- | --- | --- |
| **Accessibility** | **Yes** | No clicking, typing or scrolling — no computer control at all |
| **Screen Recording** | **Yes** | Voicer cannot see your screen |
| Microphone | Prompted | No listening — a silent, flat level meter |
| Speech Recognition | Prompted | No transcription |

**Dictation must be switched on** (System Settings → Keyboard → Dictation, English (UK)):
that is what installs the offline speech model. Without it the recogniser returns
`kLSRErrorDomain 201, "Siri and Dictation are disabled"`, which Voicer translates into the
setting you need to change.

Grant these to the **app bundle**, never to `voicerkit`. The sidecar is a child process, so macOS
attributes its requests to the parent and `voicerkit` never appears in the list.

An app only appears in System Settings once it has *asked*, so Voicer requests Accessibility at
launch rather than mid-click — both to put the row there before you need it, and because a
permission dialog appearing while the agent is already moving your mouse is alarming.

**Running from source is different.** The parent bundle is then the generic `Electron.app`, which
carries none of Voicer's usage strings, and macOS *kills* the sidecar the moment it touches the
speech recogniser. Development that involves the microphone needs the packaged app: `npm run build`,
then run `dist/mac/Voicer.app`.

## Requirements

- macOS 26 or later
- [Claude Code](https://claude.com/claude-code) installed and signed in — Voicer drives the
  installed binary, never the SDK's bundled copy, which inside `app.asar` is not a real path
  and dies with `spawn ENOTDIR`
- Dictation switched on, for the offline speech model
- Node 20+
- Swift toolchain (ships with the Xcode Command Line Tools — full Xcode is not required)
- Accessibility permission, granted once on first use, so Voicer can move the mouse and keyboard

Voicer is built and tested on an Intel Mac. It does no local model inference, which is
deliberate: the smallest usable neural voice models still run slower than real time on an Intel
CPU, so speech synthesis is a network call or Apple's built-in synthesiser, never a local model.
Apple Silicon works too, it just is not required.

## Configuration

Everything is editable from the gear button on the capsule, and lives in
`~/.voicer/config.json` outside the repository. No credentials are ever stored in the project.

```jsonc
{
  "tts": {
    "backend": "fish",           // "fish" | "apple"
    "fishApiKey": "…",           // from https://fish.audio/app/api-keys/
    "voiceId": "…"
  },
  "listen": { "silenceMs": 2000 },        // pause that ends a turn; 0 disables auto-stop
  "window": {
    "alignment": "top",                   // any edge centre or corner
    "autoMove": true                      // step aside when the agent needs to click underneath
  },
  "hotkeys": { "kill": "Alt+Command+." },
  "capture": { "maxEdgePx": 1280, "quality": 70 },
  "claudePath": "…",                      // found automatically if omitted
  "agentCwd": "…"                         // defaults to the home directory
}
```

Position, auto-move, pause length, hotkey and screenshot settings apply immediately; the voice
and the paths are read at startup.

## Building

```bash
npm run signing-identity   # once per machine
npm run icon               # regenerate build/icon.icns from scripts/make-icon.swift
npm run dist               # sidecar, bundle, sign, and zip to dist/Voicer-macOS.zip
```

## Not in version one

Wake-word activation, interrupting it mid-sentence, a conversation history view, notarised
distribution, and any platform that is not macOS.

## Licence

MIT
