import type { TtsBackend } from './types'

/** What the model hands back: mono float32 samples, and the rate they run at. */
export type Clip = { audio: Float32Array; sampleRate: number }

export type Synth = (text: string, signal: AbortSignal) => Promise<Clip>

const HEADER_BYTES = 44

/**
 * Mono 16-bit PCM in a WAV wrapper.
 *
 * The renderer plays audio through an `<audio>` element, which will not touch a
 * bare buffer of samples — it needs a container it recognises. WAV is the one
 * that costs nothing to write and nothing to decode.
 */
export function wavFromPcm(samples: Float32Array, sampleRate: number): Buffer {
  const bytes = samples.length * 2
  const wav = Buffer.alloc(HEADER_BYTES + bytes)

  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(HEADER_BYTES - 8 + bytes, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)             // PCM header length
  wav.writeUInt16LE(1, 20)              // format: uncompressed PCM
  wav.writeUInt16LE(1, 22)              // channels
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28) // byte rate: one channel, two bytes
  wav.writeUInt16LE(2, 32)              // block align
  wav.writeUInt16LE(16, 34)             // bits per sample
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(bytes, 40)

  for (let i = 0; i < samples.length; i++) {
    // Clamped, not wrapped: a sample past ±1 that wraps flips sign and arrives
    // as a crack in the middle of a word.
    const s = Math.max(-1, Math.min(1, samples[i]!))
    wav.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), HEADER_BYTES + i * 2)
  }
  return wav
}

/**
 * Kokoro, running on this Mac — no key, no account, and nothing said out loud
 * ever leaving the machine.
 *
 * It is slower than the cloud, so the sentence being spoken is rarely the one
 * being made: `prepare` starts a sentence the moment it is complete, and the
 * gap while the previous one is playing pays for it. By the time its turn comes
 * the audio is usually already sitting here.
 */
export class KokoroBackend implements TtsBackend {
  readonly name = 'kokoro'
  #clips = new Map<string, Promise<Buffer>>()
  #lane: Promise<unknown> = Promise.resolve()
  /** Turns already being watched for abandonment. One listener per turn rather
   *  than one per sentence, which on a long answer is enough to trip Node's
   *  warning about a leaking EventTarget. */
  #watched = new WeakSet<AbortSignal>()

  constructor(
    private readonly synth: Synth,
    private readonly play: (audio: Buffer, mime: string) => Promise<void>,
  ) {}

  /** Begin a sentence it is not yet time to speak. Failures are left for
   *  `speak` to raise, so the router demotes once rather than twice. */
  prepare(text: string, signal: AbortSignal): void {
    void this.#clipFor(text, signal).catch(() => {})
  }

  async speak(text: string, signal: AbortSignal): Promise<void> {
    let wav: Buffer
    try {
      wav = await this.#clipFor(text, signal)
    } finally {
      this.#clips.delete(text)
    }
    // The model cannot be stopped part-way, so an abort is honoured here
    // instead: the work is wasted, but nothing is said over the next turn.
    if (signal.aborted) return
    await this.play(wav, 'audio/wav')
  }

  #clipFor(text: string, signal: AbortSignal): Promise<Buffer> {
    const known = this.#clips.get(text)
    if (known) return known

    /*
     * One sentence through the model at a time. Preparing ahead is about using
     * the gap while the last sentence plays; running four inferences at once on
     * the same cores finishes all four late instead of one early.
     */
    const clip = this.#lane.then(async () => {
      const { audio, sampleRate } = await this.synth(text, signal)
      return wavFromPcm(audio, sampleRate)
    })
    // The lane must not inherit the rejection, or one bad sentence would stall
    // every sentence queued behind it.
    this.#lane = clip.catch(() => {})
    this.#clips.set(text, clip)
    // Nothing prepared for a turn that has been abandoned is worth keeping.
    if (!this.#watched.has(signal)) {
      this.#watched.add(signal)
      signal.addEventListener('abort', () => this.#clips.clear(), { once: true })
    }
    return clip
  }
}
