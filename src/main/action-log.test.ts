import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActionLog } from './action-log'

const path = (...extra: string[]) => join(mkdtempSync(join(tmpdir(), 'voicer-')), ...extra, 'actions.jsonl')

describe('ActionLog', () => {
  it('appends one JSON object per line', () => {
    const p = path()
    const log = new ActionLog(p)
    log.append({ tool: 'click', x: 10 })
    log.append({ tool: 'type', text: 'hi' })
    const lines = readFileSync(p, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ tool: 'click', x: 10 })
  })

  it('stamps every entry with a timestamp', () => {
    const p = path()
    new ActionLog(p).append({ tool: 'click' })
    expect(JSON.parse(readFileSync(p, 'utf8').trim()).ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('creates the parent directory if it is missing', () => {
    const p = path('nested', 'deep')
    new ActionLog(p).append({ tool: 'click' })
    expect(readFileSync(p, 'utf8')).toContain('click')
  })
})
