import { readFileSync, writeFileSync, mkdirSync, accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Alignment, isAlignment } from './placement'

export type VoicerConfig = {
  tts: { backend: 'fish' | 'apple'; fishApiKey?: string; voiceId?: string }
  hotkeys: { kill: string }
  capture: { maxEdgePx: number; quality: number }
  /** How long a pause counts as "finished talking". 0 disables auto-stop. */
  listen: { silenceMs: number }
  /** Where the capsule sits, and whether it steps aside when it is in the way. */
  window: { alignment: Alignment; autoMove: boolean }
  /** Override when Claude Code lives somewhere unusual. */
  claudePath?: string
  /** Where the agent works. Defaults to the home directory. */
  agentCwd?: string
}

const DEFAULTS: VoicerConfig = {
  tts: { backend: 'apple' },
  hotkeys: { kill: 'Alt+Command+.' },
  capture: { maxEdgePx: 1280, quality: 70 },
  listen: { silenceMs: 2000 },
  window: { alignment: 'top', autoMove: true },
}

export const configDir = (): string => join(homedir(), '.voicer')

/**
 * Config is a convenience, never a hard dependency — a missing or broken file
 * degrades to defaults so Voicer always starts.
 */
/**
 * Write settings back, merged over whatever is already on disk so a field this
 * version does not know about survives being edited by one that does.
 */
export function saveConfig(patch: Partial<VoicerConfig>, dir: string = configDir()): VoicerConfig {
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  } catch {
    // A missing or broken file is replaced rather than merged into.
  }
  const merged = { ...existing, ...patch }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(merged, null, 2) + '\n')
  return loadConfig(dir)
}

export function loadConfig(dir: string = configDir()): VoicerConfig {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Partial<VoicerConfig>
    return {
      tts: { ...DEFAULTS.tts, ...raw.tts },
      hotkeys: { ...DEFAULTS.hotkeys, ...raw.hotkeys },
      capture: { ...DEFAULTS.capture, ...raw.capture },
      listen: { ...DEFAULTS.listen, ...raw.listen },
      window: {
        // An unknown alignment would put the window somewhere unreachable.
        alignment: isAlignment(raw.window?.alignment)
          ? raw.window.alignment : DEFAULTS.window.alignment,
        autoMove: raw.window?.autoMove ?? DEFAULTS.window.autoMove,
      },
      ...(raw.claudePath ? { claudePath: raw.claudePath } : {}),
      ...(raw.agentCwd ? { agentCwd: raw.agentCwd } : {}),
    }
  } catch {
    return structuredClone(DEFAULTS)
  }
}

/**
 * Where Claude Code actually is.
 *
 * The Agent SDK defaults to the CLI bundled inside its own package, and in a
 * packaged Electron app that path is inside `app.asar` — a single file, not a
 * directory, so spawning it dies with ENOTDIR before the agent starts. Voicer
 * points the SDK at the installed binary instead, which is the one already
 * signed in to the user's subscription.
 */
const CLAUDE_LOCATIONS = [
  '.local/bin/claude',
  '.claude/local/claude',
]
const CLAUDE_ABSOLUTE = [
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
]

const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveClaudePath(
  configured?: string,
  exists: (p: string) => boolean = isExecutable,
): string | undefined {
  const candidates = [
    ...(configured ? [configured] : []),
    ...CLAUDE_LOCATIONS.map((rel) => join(homedir(), rel)),
    ...CLAUDE_ABSOLUTE,
  ]
  return candidates.find(exists)
}

/**
 * Where the agent session runs.
 *
 * User-level instructions (~/.claude/CLAUDE.md) and hooks load wherever it is
 * started, but the working directory decides what the agent treats as "here" —
 * and Electron's is wherever the bundle was launched from, usually `/`. The
 * home directory is the same place an interactive session runs, which is what
 * makes the vault at ~/SecondBrain as reachable to Voicer as to any other
 * Claude Code session.
 */
export function resolveAgentCwd(configured?: string): string {
  return configured ?? homedir()
}
