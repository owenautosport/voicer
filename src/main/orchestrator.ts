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

/** States in which a turn is under way and the user is only watching. */
const WORKING = new Set<TurnState>(['capturing', 'thinking', 'speaking', 'acting'])

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
  #failHandlers: ((message: string) => void)[] = []
  #answer = ''

  constructor(private readonly deps: OrchestratorDeps) {
    this.#machine.onChange((s) => this.#stateHandlers.forEach((fn) => fn(s)))
    this.deps.sidecar.onCrash(() => this.#fail('the sidecar stopped running'))
  }

  get state(): TurnState {
    return this.#machine.state
  }

  onState(fn: (s: TurnState) => void) { this.#stateHandlers.push(fn) }
  onPartial(fn: (t: string, l: number) => void) { this.#partialHandlers.push(fn) }
  onAnswer(fn: (t: string) => void) { this.#answerHandlers.push(fn) }
  onStatus(fn: (t: string) => void) { this.#statusHandlers.push(fn) }
  onFail(fn: (message: string) => void) { this.#failHandlers.push(fn) }

  #status(text: string) { this.#statusHandlers.forEach((fn) => fn(text)) }

  /**
   * A red pill with no words is unreadable — it looks exactly like a recording
   * that will not stop. Whatever ended the turn always says why, so say it: to
   * the console for us, and to the UI for whoever is standing in front of it.
   */
  #fail(message: string): void {
    console.error('[voicer] turn failed:', message)
    this.#failHandlers.forEach((fn) => fn(message))
    this.#machine.send({ type: 'FAIL', message })
  }

  micClick(): void {
    const before = this.#machine.state

    // The transcript is already on its way back; a second click means nothing.
    if (before === 'transcribing') return

    // Clicking while it is working means "stop that and listen to me". Without
    // it, anything that fails to reach idle — a backend that never returns, an
    // agent that hangs — leaves the button dead with no way back.
    if (WORKING.has(before)) this.abort()

    const after = this.#machine.send({ type: 'MIC_CLICK' })

    if (after === 'listening' && before !== 'listening') {
      this.#answer = ''
      this.#failHandlers.forEach((fn) => fn(''))
      void this.#listen()
    } else if (after === 'transcribing') {
      this.deps.sidecar.listenStop()
    }
  }

  /** Run a turn from typed text, with no microphone involved. */
  submit(text: string): void {
    const prompt = text.trim()
    if (!prompt) return

    // Same courtesy as the mic: whatever is running gives way.
    if (this.#machine.state !== 'idle' && this.#machine.state !== 'error') this.abort()

    this.#answer = ''
    this.#failHandlers.forEach((fn) => fn(''))
    if (this.#machine.send({ type: 'SUBMIT', text: prompt }) !== 'capturing') return
    void this.#runTurn(prompt)
  }

  abort(): void {
    // The recogniser is still holding the microphone open until told otherwise.
    this.deps.sidecar.listenStop()
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
      this.#fail(err instanceof Error ? err.message : String(err))
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
