import { readFileSync, writeFileSync, mkdirSync, accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Alignment, isAlignment } from './placement'
import {
  DEFAULT_KOKORO_DTYPE, DEFAULT_KOKORO_VOICE, isKokoroDtype, isKokoroVoice,
  type KokoroDtype,
} from '../shared/voices'

export type TtsBackendName = 'fish' | 'apple' | 'kokoro'

const isTtsBackend = (v: unknown): v is TtsBackendName =>
  v === 'fish' || v === 'apple' || v === 'kokoro'

export type VoicerConfig = {
  tts: {
    backend: TtsBackendName
    fishApiKey?: string
    voiceId?: string
    /** Which Kokoro voice speaks, and which weights it speaks with. */
    kokoroVoice: string
    kokoroDtype: KokoroDtype
  }
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
  /**
   * Which model the agent thinks with — an alias (`opus[1m]`, `sonnet`,
   * `haiku`) or a full id. Left unset, Voicer follows whatever Claude Code is
   * already configured to use rather than pinning a model of its own.
   */
  model?: string
}

const DEFAULTS: VoicerConfig = {
  /*
   * Apple, not Kokoro, on a machine that has never run Voicer before: Kokoro
   * cannot say a word until a few hundred megabytes have been fetched, and a
   * first launch that is silent for ten minutes looks broken rather than busy.
   * Settings switches it over, and it stays switched.
   */
  tts: {
    backend: 'apple',
    kokoroVoice: DEFAULT_KOKORO_VOICE,
    kokoroDtype: DEFAULT_KOKORO_DTYPE,
  },
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
 * Any subset of the sections, and any subset of the fields within one. The file
 * is merged section by section, so a caller may change one setting without
 * having to know — or resend — everything else in the same section.
 */
export type ConfigPatch = {
  [K in keyof VoicerConfig]?: VoicerConfig[K] extends object
    ? Partial<VoicerConfig[K]>
    : VoicerConfig[K]
}

const isSection = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Write settings back, merged over whatever is already on disk so a field this
 * version does not know about survives being edited by one that does.
 */
export function saveConfig(patch: ConfigPatch, dir: string = configDir()): VoicerConfig {
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  } catch {
    // A missing or broken file is replaced rather than merged into.
  }
  /*
   * One level deep, which is as deep as the shape goes. A top-level spread
   * would replace a whole section, so patching the backend alone would silently
   * take the Fish key and the Kokoro voice down with it.
   */
  const merged: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    const prior = merged[key]
    merged[key] = isSection(value) && isSection(prior) ? { ...prior, ...value } : value
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(merged, null, 2) + '\n')
  return loadConfig(dir)
}

export function loadConfig(dir: string = configDir()): VoicerConfig {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Partial<VoicerConfig>
    return {
      tts: {
        ...DEFAULTS.tts,
        ...raw.tts,
        /*
         * Each of these three names something that has to exist — a code path,
         * a file in the model repository, a voice the model was trained on. A
         * typo in any of them is not a wrong setting, it is a backend that
         * throws on every sentence and silently demotes Voicer to the robot
         * voice for the rest of the session.
         */
        backend: isTtsBackend(raw.tts?.backend) ? raw.tts.backend : DEFAULTS.tts.backend,
        kokoroVoice: isKokoroVoice(raw.tts?.kokoroVoice)
          ? raw.tts.kokoroVoice : DEFAULTS.tts.kokoroVoice,
        kokoroDtype: isKokoroDtype(raw.tts?.kokoroDtype)
          ? raw.tts.kokoroDtype : DEFAULTS.tts.kokoroDtype,
      },
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
      ...(raw.model ? { model: raw.model } : {}),
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
