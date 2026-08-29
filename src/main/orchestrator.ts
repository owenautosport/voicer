import { TurnMachine, type TurnState } from './turn-machine'

export type OrchestratorDeps = {
  sidecar: {
    listenStart(onPartial: (text: string, level: number) => void): Promise<string>
    listenStop(): void
    capture(): Promise<{ path: string; w: number; h: number }>
    onCrash(fn: () => void): void
  }
  agent: {
    run(transcript: string, imagePath: string | undefined, cb: {
      onText(text: string): void
      onTool(tool: string, input: unknown): void
      onDone(sessionId: string): void
      onError(err: Error): void
    }): Promise<void>
    abort(): void
  }
  tts: {
    push(text: string): void
    flush(): Promise<void>
    abort(): void
    readonly activeBackend: string
  }
}

/** Strip the MCP prefix so "mcp__voicer-control__click" reads as "click". */
const friendlyTool = (tool: string): string => tool.split('__').pop() ?? tool

/**
 * Drives one turn end to end, translating between the pure TurnMachine and the
 * three collaborators that do the actual work. Everything is injected so a
 * whole turn can be tested with no Electron, no microphone and no agent.
 */
export class Orchestrator {
  #machine = new TurnMachine()
  #stateHandlers: ((s: TurnState) => void)[] = []
  #partialHandlers: ((t: string, l: number) => void)[] = []
  #answerHandlers: ((t: string) => void)[] = []
  #statusHandlers: ((t: string) => void)[] = []
  #answer = ''

  constructor(private readonly deps: OrchestratorDeps) {
    this.#machine.onChange((s) => this.#stateHandlers.forEach((fn) => fn(s)))
    this.deps.sidecar.onCrash(() => this.#machine.send({ type: 'FAIL', message: 'sidecar crashed' }))
  }

  get state(): TurnState {
    return this.#machine.state
  }

  onState(fn: (s: TurnState) => void) { this.#stateHandlers.push(fn) }
  onPartial(fn: (t: string, l: number) => void) { this.#partialHandlers.push(fn) }
  onAnswer(fn: (t: string) => void) { this.#answerHandlers.push(fn) }
  onStatus(fn: (t: string) => void) { this.#statusHandlers.push(fn) }

  #status(text: string) { this.#statusHandlers.forEach((fn) => fn(text)) }

  micClick(): void {
    const before = this.#machine.state
    const after = this.#machine.send({ type: 'MIC_CLICK' })

    if (after === 'listening' && before !== 'listening') {
      this.#answer = ''
      void this.#listen()
    } else if (after === 'transcribing') {
      this.deps.sidecar.listenStop()
    }
  }

  abort(): void {
    this.deps.agent.abort()
    this.deps.tts.abort()
    this.#machine.send({ type: 'ABORT' })
    this.#status('')
  }

  async #listen(): Promise<void> {
    try {
      const transcript = await this.deps.sidecar.listenStart((text, level) =>
        this.#partialHandlers.forEach((fn) => fn(text, level)),
      )
      // The recogniser can finish on its own — end of speech, or an error —
      // without the user clicking stop. Treat that as the stop it is, rather
      // than dropping the turn on the floor.
      if (this.#machine.state === 'listening') this.#machine.send({ type: 'MIC_CLICK' })
      if (this.#machine.send({ type: 'TRANSCRIPT', text: transcript }) !== 'capturing') return
      await this.#runTurn(transcript)
    } catch (err) {
      this.#machine.send({ type: 'FAIL', message: String(err) })
    }
  }

  async #runTurn(transcript: string): Promise<void> {
    // A failed screenshot is not a failed turn — plenty of questions need no picture,
    // and the agent can always take its own with the screenshot tool.
    let imagePath: string | undefined
    try {
      imagePath = (await this.deps.sidecar.capture()).path
    } catch (err) {
      console.warn('[orchestrator] capture failed, continuing without a screenshot:', err)
    }
    this.#machine.send({ type: 'CAPTURED', path: imagePath ?? '' })

    let failed = false
    await this.deps.agent.run(transcript, imagePath, {
      onText: (text) => {
        this.#answer += text
        this.#answerHandlers.forEach((fn) => fn(this.#answer))
        this.deps.tts.push(text)
        this.#machine.send({ type: 'AGENT_TEXT', text })
      },
      onTool: (tool) => {
        this.#status(`${friendlyTool(tool)}…`)
        this.#machine.send({ type: 'AGENT_TOOL', tool })
      },
      onDone: (sessionId) => {
        this.#machine.send({ type: 'AGENT_DONE', sessionId })
      },
      onError: (err) => {
        failed = true
        console.error('[orchestrator] agent error:', err)
        this.deps.tts.push('Sorry, something went wrong.')
        this.#machine.send({ type: 'AGENT_DONE', sessionId: '' })
      },
    })

    this.#status('')
    await this.deps.tts.flush()
    this.#machine.send({ type: 'SPEECH_DONE' })
    if (failed) this.#machine.send({ type: 'ABORT' })
  }
}
