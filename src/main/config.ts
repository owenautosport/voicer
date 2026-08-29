import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type VoicerConfig = {
  tts: { backend: 'fish' | 'apple'; fishApiKey?: string; voiceId?: string }
  hotkeys: { kill: string }
  capture: { maxEdgePx: number; quality: number }
}

const DEFAULTS: VoicerConfig = {
  tts: { backend: 'apple' },
  hotkeys: { kill: 'Alt+Command+.' },
  capture: { maxEdgePx: 1280, quality: 70 },
}

export const configDir = (): string => join(homedir(), '.voicer')

/**
 * Config is a convenience, never a hard dependency — a missing or broken file
 * degrades to defaults so Voicer always starts.
 */
export function loadConfig(dir: string = configDir()): VoicerConfig {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Partial<VoicerConfig>
    return {
      tts: { ...DEFAULTS.tts, ...raw.tts },
      hotkeys: { ...DEFAULTS.hotkeys, ...raw.hotkeys },
      capture: { ...DEFAULTS.capture, ...raw.capture },
    }
  } catch {
    return structuredClone(DEFAULTS)
  }
}
