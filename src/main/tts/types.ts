export interface TtsBackend {
  readonly name: string
  speak(text: string, signal: AbortSignal): Promise<void>
  /**
   * Optional. Begin work on a sentence before it is its turn to be spoken, for
   * a backend slow enough that the gap while the previous sentence plays is
   * worth using. Never awaited, and never allowed to fail a turn.
   */
  prepare?(text: string, signal: AbortSignal): void
}
