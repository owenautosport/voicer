import type { TtsBackend } from './types'

/**
 * Split on sentence-ending punctuation followed by whitespace. The lookbehind
 * for a non-digit is what stops "3.50" becoming two sentences. Punctuation that
 * ends the buffer is held back — the next delta may continue the number or the
 * abbreviation.
 */
export function splitSentences(buffer: string): { ready: string[]; rest: string } {
  const ready: string[] = []
  const boundary = /(?<=[^0-9\s])[.!?]+(?=\s)/g
  let match: RegExpExecArray | null
  let consumed = 0
  while ((match = boundary.exec(buffer)) !== null) {
    const end = match.index + match[0].length
    const sentence = buffer.slice(consumed, end).trim()
    if (sentence) ready.push(sentence)
    consumed = end
  }
  return { ready, rest: buffer.slice(consumed) }
}

/**
 * Turns a stream of text deltas into spoken sentences, and survives a backend
 * dying mid-answer by demoting to the next one and re-speaking what was lost.
 */
export class TtsRouter {
  #buffer = ''
  #index = 0
  #queue: Promise<void> = Promise.resolve()
  #controller = new AbortController()

  constructor(private readonly backends: TtsBackend[]) {}

  get activeBackend(): string {
    return this.backends[this.#index]?.name ?? 'none'
  }

  push(textDelta: string): void {
    this.#buffer += textDelta
    const { ready, rest } = splitSentences(this.#buffer)
    this.#buffer = rest
    for (const sentence of ready) this.#enqueue(sentence)
  }

  async flush(): Promise<void> {
    const remainder = this.#buffer.trim()
    this.#buffer = ''
    if (remainder) this.#enqueue(remainder)
    await this.#queue
  }

  abort(): void {
    this.#controller.abort()
    this.#buffer = ''
    this.#queue = Promise.resolve()
    this.#controller = new AbortController()
  }

  #enqueue(sentence: string): void {
    if (!sentence) return
    const signal = this.#controller.signal
    if (signal.aborted) return
    /*
     * Hand the sentence over the moment it is complete rather than when its
     * turn comes. A backend that synthesises on this machine is slower than the
     * speech it produces, and the only free time it will ever get is the gap
     * while the sentence before it is playing. Preparing is an optimisation, so
     * a backend that throws here has still not been asked to speak.
     */
    try {
      this.backends[this.#index]?.prepare?.(sentence, signal)
    } catch (err) {
      console.warn('[tts] prepare failed, carrying on:', err)
    }
    this.#queue = this.#queue.then(() => this.#speakWithFallback(sentence, signal))
  }

  /**
   * Try the current backend; on any failure demote permanently and re-speak the
   * same sentence on the next one, so a mid-answer outage costs a change of
   * voice rather than a lost sentence.
   */
  async #speakWithFallback(sentence: string, signal: AbortSignal): Promise<void> {
    while (this.#index < this.backends.length) {
      if (signal.aborted) return
      const backend = this.backends[this.#index]!
      try {
        await backend.speak(sentence, signal)
        return
      } catch (err) {
        if (signal.aborted) return
        console.warn(`[tts] ${backend.name} failed, demoting:`, err)
        this.#index += 1
      }
    }
    // Every backend is down. Losing the audio is bad; crashing the turn is worse.
  }
}
