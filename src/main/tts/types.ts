export interface TtsBackend {
  readonly name: string
  speak(text: string, signal: AbortSignal): Promise<void>
}
