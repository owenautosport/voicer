import type { TtsBackend } from './types'

export type FishConfig = { apiKey: string; voiceId?: string }

/**
 * Fish Audio's `s2.1-pro-free` model. Free under fair use, but it is a
 * promotion with a stated end date — so every failure path here must throw,
 * letting TtsRouter demote to Apple rather than the answer going silent.
 */
export class FishBackend implements TtsBackend {
  readonly name = 'fish'

  constructor(
    private readonly config: FishConfig,
    private readonly play: (mp3: Buffer) => Promise<void>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async speak(text: string, signal: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(10_000)])

    const res = await this.fetchImpl('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        model: 's2.1-pro-free',
      },
      body: JSON.stringify({
        text,
        format: 'mp3',
        ...(this.config.voiceId ? { reference_id: this.config.voiceId } : {}),
      }),
      signal: combined,
    })

    if (!res.ok) throw new Error(`fish: HTTP ${res.status}`)
    await this.play(Buffer.from(await res.arrayBuffer()))
  }
}
