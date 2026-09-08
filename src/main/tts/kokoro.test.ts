import { describe, it, expect } from 'vitest'
import { KokoroBackend, wavFromPcm, type Clip } from './kokoro'

const pcm = (n: number, value = 0.5) => new Float32Array(n).fill(value)

/** A stand-in for the model: records what it was asked for and how many runs
 *  overlapped, so "prepare ahead" can be told apart from "run everything now". */
const model = (opts: { fail?: boolean; delayMs?: number } = {}) => {
  const asked: string[] = []
  let live = 0
  let peak = 0
  const synth = async (text: string): Promise<Clip> => {
    asked.push(text)
    peak = Math.max(peak, ++live)
    try {
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 0))
      if (opts.fail) throw new Error('model is down')
      return { audio: pcm(4), sampleRate: 24000 }
    } finally { live-- }
  }
  return { synth, asked, get peak() { return peak } }
}

const player = () => {
  const played: { bytes: Buffer; mime: string }[] = []
  return { played, play: async (bytes: Buffer, mime: string) => { played.push({ bytes, mime }) } }
}

describe('wavFromPcm', () => {
  it('wraps the samples in a mono 16-bit WAV the renderer can play', () => {
    const wav = wavFromPcm(pcm(4), 24000)
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.readUInt16LE(22)).toBe(1)        // channels
    expect(wav.readUInt32LE(24)).toBe(24000)    // sample rate
    expect(wav.readUInt16LE(34)).toBe(16)       // bits per sample
    expect(wav.readUInt32LE(40)).toBe(8)        // 4 samples x 2 bytes
    expect(wav.length).toBe(44 + 8)
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8)
  })

  /* A model that overshoots ±1 would wrap around to the opposite sign and
     arrive as a crack in the middle of a word. */
  it('clamps samples outside the range instead of letting them wrap', () => {
    const wav = wavFromPcm(new Float32Array([2, -2]), 24000)
    expect(wav.readInt16LE(44)).toBe(32767)
    expect(wav.readInt16LE(46)).toBe(-32768)
  })
})

describe('KokoroBackend', () => {
  const signal = () => new AbortController().signal

  it('runs the sentence through the model and plays it as a WAV', async () => {
    const m = model(); const p = player()
    await new KokoroBackend(m.synth, p.play).speak('Hello there.', signal())
    expect(m.asked).toEqual(['Hello there.'])
    expect(p.played).toHaveLength(1)
    expect(p.played[0]!.mime).toBe('audio/wav')
    expect(p.played[0]!.bytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
  })

  it('speaks a prepared sentence without running the model twice', async () => {
    const m = model(); const p = player()
    const b = new KokoroBackend(m.synth, p.play)
    const s = signal()
    b.prepare('Ready ahead of time.', s)
    await b.speak('Ready ahead of time.', s)
    expect(m.asked).toEqual(['Ready ahead of time.'])
    expect(p.played).toHaveLength(1)
  })

  /* The gap while one sentence plays is the only free time there is. Spending
     it on four inferences at once finishes all four late instead of one early. */
  it('puts one sentence through the model at a time', async () => {
    const m = model({ delayMs: 5 }); const p = player()
    const b = new KokoroBackend(m.synth, p.play)
    const s = signal()
    for (const t of ['One.', 'Two.', 'Three.']) b.prepare(t, s)
    await b.speak('One.', s)
    await b.speak('Two.', s)
    await b.speak('Three.', s)
    expect(m.peak).toBe(1)
    expect(m.asked).toEqual(['One.', 'Two.', 'Three.'])
  })

  it('throws when the model fails so the router can demote to Apple', async () => {
    const m = model({ fail: true }); const p = player()
    await expect(new KokoroBackend(m.synth, p.play).speak('hi', signal()))
      .rejects.toThrow(/model is down/)
    expect(p.played).toEqual([])
  })

  /* A failed sentence must not be remembered as "already prepared", or the
     demotion would be permanent for that exact wording. */
  it('does not cache a failure', async () => {
    const m = model({ fail: true }); const p = player()
    const b = new KokoroBackend(m.synth, p.play)
    const s = signal()
    b.prepare('hi', s)
    await expect(b.speak('hi', s)).rejects.toThrow()
    await expect(b.speak('hi', s)).rejects.toThrow()
    expect(m.asked).toEqual(['hi', 'hi'])
  })

  it('stays silent when the turn was aborted while it was synthesising', async () => {
    const m = model({ delayMs: 5 }); const p = player()
    const ac = new AbortController()
    const speaking = new KokoroBackend(m.synth, p.play).speak('hi', ac.signal)
    ac.abort()
    await speaking
    expect(p.played).toEqual([])
  })

  /* Sentences prepared for a turn the user cut off are not answers to
     anything any more, and holding them would let a whole abandoned answer sit
     in memory until something with the same wording came along. */
  it('throws away what it prepared for a turn that was abandoned', async () => {
    const m = model(); const p = player()
    const b = new KokoroBackend(m.synth, p.play)
    const abandoned = new AbortController()
    b.prepare('One.', abandoned.signal)
    b.prepare('Two.', abandoned.signal)
    await new Promise((r) => setTimeout(r, 5))
    abandoned.abort()

    await b.speak('One.', new AbortController().signal)
    expect(m.asked).toEqual(['One.', 'Two.', 'One.'])
  })

  it('forgets a clip once it has been spoken', async () => {
    const m = model(); const p = player()
    const b = new KokoroBackend(m.synth, p.play)
    const s = signal()
    await b.speak('Same words.', s)
    await b.speak('Same words.', s)
    expect(m.asked).toEqual(['Same words.', 'Same words.'])
  })
})
