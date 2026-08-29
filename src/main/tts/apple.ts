import type { TtsBackend } from './types'
import type { SidecarClient } from '../sidecar'

/** Always available, offline, and no key. The floor Voicer never drops below. */
export class AppleBackend implements TtsBackend {
  readonly name = 'apple'
  constructor(private readonly sidecar: Pick<SidecarClient, 'speak'>) {}
  speak(text: string, signal: AbortSignal): Promise<void> {
    return this.sidecar.speak(text, signal)
  }
}
