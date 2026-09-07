import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { loadConfig, saveConfig, resolveClaudePath, resolveAgentCwd } from './config'

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

describe('resolveClaudePath', () => {
  // The SDK's bundled CLI lives inside app.asar, which is a file, not a
  // directory — spawning it fails with ENOTDIR. Voicer drives the installed
  // Claude Code binary instead, which is also what signs it in.
  const exists = (...ok: string[]) => (p: string) => ok.includes(p)

  it('prefers an explicitly configured path', () => {
    const found = resolveClaudePath('/custom/claude', exists('/custom/claude', '/usr/local/bin/claude'))
    expect(found).toBe('/custom/claude')
  })

  it('falls past a configured path that is not there', () => {
    expect(resolveClaudePath('/gone/claude', exists('/usr/local/bin/claude')))
      .toBe('/usr/local/bin/claude')
  })

  it('finds the binary in the usual install locations', () => {
    expect(resolveClaudePath(undefined, exists('/opt/homebrew/bin/claude')))
      .toBe('/opt/homebrew/bin/claude')
  })

  it('returns undefined when Claude Code is not installed anywhere', () => {
    expect(resolveClaudePath(undefined, () => false)).toBeUndefined()
  })
})

describe('resolveAgentCwd', () => {
  it('defaults to the home directory, where an interactive session would run', () => {
    expect(resolveAgentCwd()).toBe(homedir())
  })

  it('honours an explicit setting', () => {
    expect(resolveAgentCwd('/Users/someone/SecondBrain')).toBe('/Users/someone/SecondBrain')
  })
})

describe('saveConfig', () => {
  it('writes a setting and reads it back', () => {
    const d = dir()
    const saved = saveConfig({ window: { alignment: 'bottom-right', autoMove: false } }, d)
    expect(saved.window).toEqual({ alignment: 'bottom-right', autoMove: false })
    expect(loadConfig(d).window.alignment).toBe('bottom-right')
  })

  it('creates the file when there is none', () => {
    const d = dir()
    saveConfig({ listen: { silenceMs: 500 } }, d)
    expect(JSON.parse(readFileSync(join(d, 'config.json'), 'utf8')).listen.silenceMs).toBe(500)
  })

  it('keeps settings it was not asked to change', () => {
    const d = dir()
    saveConfig({ tts: { backend: 'fish', fishApiKey: 'k' } }, d)
    saveConfig({ listen: { silenceMs: 3000 } }, d)
    const c = loadConfig(d)
    expect(c.tts.fishApiKey).toBe('k')
    expect(c.listen.silenceMs).toBe(3000)
  })

  it('refuses an alignment it does not recognise rather than losing the window', () => {
    const d = dir()
    saveConfig({ window: { alignment: 'nowhere' as never, autoMove: true } }, d)
    expect(loadConfig(d).window.alignment).toBe('top')
  })
})
