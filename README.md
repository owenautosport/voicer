# Voicer

A small microphone button that floats above everything on your Mac. Click it, talk, click
it again. Voicer sees what is on your screen, answers out loud, and — when you ask it to —
takes over the mouse and keyboard and does the thing for you.

> **Status: built, not yet verified end to end.** The app builds, launches, and runs its
> sidecar; 92 unit tests and a 21-check sidecar self-test pass. What has *not* been confirmed
> is a full spoken turn on real hardware — that needs the macOS permissions below granted
> first. See [the design](docs/superpowers/specs/2026-08-30-voicer-design.md) and
> [the plan](docs/superpowers/plans/2026-08-30-voicer-v1.md).

## Why

Screen-sharing your problem to an AI usually means alt-tabbing to a chat window, screenshotting,
pasting, typing the question, reading the answer, and going back. That round trip is longer than
the question. Voicer removes it: the assistant is already pinned in front of the thing you are
stuck on, it can already see it, and you never have to stop looking at your work to ask.

## How it works

```
click mic  ──▶  listen        on-device speech recognition, partials stream live
click mic  ──▶  stop          final transcript
           ──▶  capture       screen grab, downscaled
           ──▶  think         Claude Code agent session (transcript + screenshot)
           ──▶  speak         answer streams out sentence by sentence
           ──▶  act           mouse and keyboard, if the answer needs doing
```

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

Voicer runs the agent with permissions bypassed — it acts rather than asking first. The rails
against that are visibility and reversibility, not confirmation prompts:

- a global kill hotkey (<kbd>⌥</kbd><kbd>⌘</kbd><kbd>.</kbd>) that aborts mid-action,
- an unmissable red pulsing state whenever it has the controls,
- an append-only log at `~/.voicer/actions.jsonl` recording everything it did.

## Permissions

macOS gates everything Voicer does. Two grants are manual:

| Pane | Manual? | Without it |
| --- | --- | --- |
| **Accessibility** | **Yes** | No clicking, typing or scrolling — no computer control at all |
| **Screen Recording** | **Yes** | Voicer cannot see your screen |
| Microphone | Prompted | No listening |
| Speech Recognition | Prompted | No transcription |

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
- [Claude Code](https://claude.com/claude-code) installed and signed in
- Node 20+
- Swift toolchain (ships with the Xcode Command Line Tools — full Xcode is not required)
- Accessibility permission, granted once on first use, so Voicer can move the mouse and keyboard

Voicer is built and tested on an Intel Mac. It does no local model inference, which is
deliberate: the smallest usable neural voice models still run slower than real time on an Intel
CPU, so speech synthesis is a network call or Apple's built-in synthesiser, never a local model.
Apple Silicon works too, it just is not required.

## Configuration

Configuration lives in `~/.voicer/config.json`, outside the repository. No credentials are ever
stored in the project.

```jsonc
{
  "tts": {
    "backend": "fish",           // "fish" | "apple"
    "fishApiKey": "…",           // from https://fish.audio/app/api-keys/
    "voiceId": "…"
  },
  "hotkeys": { "kill": "Alt+Command+." },
  "capture": { "maxEdgePx": 1280, "quality": 70 }
}
```

## Not in version one

Wake-word activation, interrupting it mid-sentence, a conversation history view, a graphical
settings window, notarised distribution, and any platform that is not macOS.

## Licence

MIT
