import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config'

const dir = () => mkdtempSync(join(tmpdir(), 'voicer-'))

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    const cfg = loadConfig(dir())
    expect(cfg.tts.backend).toBe('apple')
    expect(cfg.capture.maxEdgePx).toBe(1280)
    expect(cfg.hotkeys.kill).toBe('Alt+Command+.')
  })

  it('merges a partial config over the defaults', () => {
    const d = dir()
    writeFileSync(join(d, 'config.json'), JSON.stringify({ tts: { backend: 'fish', fishApiKey: 'k' } }))
    const cfg = loadConfig(d)
    expect(cfg.tts.backend).toBe('fish')
    expect(cfg.tts.fishApiKey).toBe('k')
    expect(cfg.capture.quality).toBe(70)
  })

  it('falls back to defaults on malformed JSON rather than throwing', () => {
    const d = dir()
    writeFileSync(join(d, 'config.json'), '{ not json')
    expect(loadConfig(d).tts.backend).toBe('apple')
  })

  it('does not let one call mutate the defaults seen by the next', () => {
    const a = loadConfig(dir())
    a.capture.maxEdgePx = 99
    expect(loadConfig(dir()).capture.maxEdgePx).toBe(1280)
  })
})
