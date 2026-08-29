export type TurnState =
  | 'idle' | 'listening' | 'transcribing' | 'capturing'
  | 'thinking' | 'speaking' | 'acting' | 'error'

export type TurnEvent =
  | { type: 'MIC_CLICK' }
  | { type: 'TRANSCRIPT'; text: string }
  | { type: 'CAPTURED'; path: string }
  | { type: 'AGENT_TEXT'; text: string }
  | { type: 'AGENT_TOOL'; tool: string }
  | { type: 'AGENT_DONE'; sessionId: string }
  | { type: 'SPEECH_DONE' }
  | { type: 'ABORT' }
  | { type: 'FAIL'; message: string }

type Listener = (state: TurnState, prev: TurnState) => void

/**
 * The whole of Voicer's behaviour, with no I/O so it can be tested directly.
 *
 * `speaking` and `acting` interleave rather than nest: the agent streams prose
 * and tool calls in whatever order it likes, so the machine tracks whether the
 * agent has finished separately from whether speech has drained.
 */
export class TurnMachine {
  #state: TurnState = 'idle'
  #listeners = new Set<Listener>()
  #agentDone = false
  #speechPending = false

  get state(): TurnState {
    return this.#state
  }

  onChange(fn: Listener): () => void {
    this.#listeners.add(fn)
    return () => {
      this.#listeners.delete(fn)
    }
  }

  send(event: TurnEvent): TurnState {
    const next = this.#next(event)
    if (next !== this.#state) {
      const prev = this.#state
      this.#state = next
      for (const fn of this.#listeners) fn(next, prev)
    }
    return this.#state
  }

  #reset(): TurnState {
    this.#agentDone = false
    this.#speechPending = false
    return 'idle'
  }

  #next(event: TurnEvent): TurnState {
    // Abort and failure win from anywhere.
    if (event.type === 'ABORT') return this.#reset()
    if (event.type === 'FAIL') {
      this.#reset()
      return 'error'
    }

    switch (this.#state) {
      case 'idle':
      case 'error':
        return event.type === 'MIC_CLICK' ? 'listening' : this.#state

      case 'listening':
        return event.type === 'MIC_CLICK' ? 'transcribing' : this.#state

      case 'transcribing':
        if (event.type !== 'TRANSCRIPT') return this.#state
        // Nothing was said. Don't spend an agent turn on silence.
        return event.text.trim() === '' ? this.#reset() : 'capturing'

      case 'capturing':
        return event.type === 'CAPTURED' ? 'thinking' : this.#state

      case 'thinking':
      case 'speaking':
      case 'acting':
        switch (event.type) {
          case 'AGENT_TEXT':
            this.#speechPending = true
            return 'speaking'
          case 'AGENT_TOOL':
            return 'acting'
          case 'AGENT_DONE':
            this.#agentDone = true
            return this.#speechPending ? this.#state : this.#reset()
          case 'SPEECH_DONE':
            this.#speechPending = false
            return this.#agentDone ? this.#reset() : this.#state
          default:
            return this.#state
        }
    }
  }
}
