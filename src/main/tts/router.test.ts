import { describe, it, expect } from 'vitest'
import { TtsRouter, splitSentences } from './router'
import type { TtsBackend } from './types'

type Fake = TtsBackend & { spoken: string[] }

const fake = (name: string, fail = false): Fake => {
  const spoken: string[] = []
  return {
    name,
    spoken,
    async speak(text: string) {
      if (fail) throw new Error(`${name} is down`)
      spoken.push(text)
    },
  }
}

describe('splitSentences', () => {
  it('emits complete sentences and keeps the remainder', () => {
    expect(splitSentences('One. Two! Three')).toEqual({ ready: ['One.', 'Two!'], rest: ' Three' })
  })

  it('holds back a sentence that has not ended', () => {
    expect(splitSentences('Still going')).toEqual({ ready: [], rest: 'Still going' })
  })

  it('does not split on a decimal point', () => {
    expect(splitSentences('It costs 3.50 today. Yes. ').ready).toEqual(['It costs 3.50 today.', 'Yes.'])
  })

  it('treats a question mark as a boundary', () => {
    expect(splitSentences('Ready? Go. ').ready).toEqual(['Ready?', 'Go.'])
  })
})

describe('TtsRouter', () => {
  it('speaks each complete sentence as it arrives', async () => {
    const primary = fake('primary')
    const r = new TtsRouter([primary])
    r.push('Hello there. ')
    await r.flush()
    expect(primary.spoken).toEqual(['Hello there.'])
  })

  it('speaks the trailing fragment on flush', async () => {
    const primary = fake('primary')
    const r = new TtsRouter([primary])
    r.push('No full stop here')
    await r.flush()
    expect(primary.spoken).toEqual(['No full stop here'])
  })

  it('demotes to the fallback after a failure and stays there', async () => {
    const primary = fake('primary', true)
    const fallback = fake('fallback')
    const r = new TtsRouter([primary, fallback])
    r.push('First one. ')
    await r.flush()
    expect(fallback.spoken).toEqual(['First one.'])
    expect(r.activeBackend).toBe('fallback')

    r.push('Second one. ')
    await r.flush()
    expect(fallback.spoken).toEqual(['First one.', 'Second one.'])
    expect(primary.spoken).toEqual([])
  })

  it('re-speaks the failed sentence on the fallback rather than dropping it', async () => {
    const fallback = fake('fallback')
    const r = new TtsRouter([fake('primary', true), fallback])
    r.push('Do not lose me. ')
    await r.flush()
    expect(fallback.spoken).toEqual(['Do not lose me.'])
  })

  it('gives up silently when every backend fails', async () => {
    const r = new TtsRouter([fake('a', true), fake('b', true)])
    r.push('Nobody can say this. ')
    await expect(r.flush()).resolves.toBeUndefined()
  })

  it('abort drops speech that is still queued', async () => {
    // A real backend honours the signal — Fish passes it to fetch, Apple to the
    // sidecar's cancel — so the fake does too.
    const spoken: string[] = []
    const slow: TtsBackend = {
      name: 'slow',
      async speak(text, signal) {
        await new Promise((r) => setTimeout(r, 5))
        if (signal.aborted) throw new Error('aborted')
        spoken.push(text)
      },
    }
    const r = new TtsRouter([slow])
    r.push('One. Two. Three. ')
    r.abort()
    await r.flush()
    expect(spoken).toEqual([])
  })

  it('an abort does not demote the backend — the next turn still uses it', async () => {
    const spoken: string[] = []
    const primary: TtsBackend = {
      name: 'primary',
      async speak(text, signal) {
        await new Promise((r) => setTimeout(r, 5))
        if (signal.aborted) throw new Error('aborted')
        spoken.push(text)
      },
    }
    const fallback = fake('fallback')
    const r = new TtsRouter([primary, fallback])

    r.push('Interrupted. ')
    r.abort()
    await r.flush()
    expect(r.activeBackend).toBe('primary')

    r.push('Next turn. ')
    await r.flush()
    expect(spoken).toEqual(['Next turn.'])
    expect(fallback.spoken).toEqual([])
  })

  it('speaks sentences in order even when pushed in fragments', async () => {
    const primary = fake('primary')
    const r = new TtsRouter([primary])
    for (const frag of ['One', '. ', 'Two', '. ', 'Three.']) r.push(frag)
    await r.flush()
    expect(primary.spoken).toEqual(['One.', 'Two.', 'Three.'])
  })
})
