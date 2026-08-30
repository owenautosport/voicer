import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export type SidecarEvent =
  | { id: number; event: 'partial'; text: string; level: number }
  | { id: number; event: 'final'; text: string }
  | { id: number; event: 'captured'; path: string; w: number; h: number }
  | { id: number; event: 'speech_done' }
  | { id: number; event: 'acted' }
  | { id: number; event: 'cancelled' }
  | { id: number; event: 'error'; code: string; message: string }

type Pending = { resolve: (e: SidecarEvent) => void; reject: (err: Error) => void }

/**
 * The TypeScript half of the voicerkit wire protocol: one JSON request per line
 * out, one JSON event per line back, correlated by `id`.
 */
export class SidecarClient {
  #proc?: ChildProcessWithoutNullStreams
  #buffer = ''
  #nextId = 1
  #pending = new Map<number, Pending>()
  #onPartial = new Map<number, (text: string, level: number) => void>()
  #crashHandlers: (() => void)[] = []
  #errorHandlers: ((err: Error) => void)[] = []
  #listenId?: number

  constructor(
    private readonly binary: string,
    private readonly args: string[] = [],
  ) {}

  start(): void {
    const proc = spawn(this.binary, this.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.#ingest(chunk))

    // The sidecar's own diagnostics. Swallowing these once cost an hour of
    // "it just isn't running" with nothing to go on.
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      const line = chunk.trim()
      if (line) console.warn('[voicerkit]', line)
    })

    proc.on('exit', (code, signal) => {
      const err = new Error(`sidecar exited (code ${code}, signal ${signal})`)
      for (const p of this.#pending.values()) p.reject(err)
      this.#pending.clear()
      this.#proc = undefined
      this.#report(err)
      for (const fn of this.#crashHandlers) fn()
    })

    // A failed spawn — a missing or unexecutable binary — is reported, never
    // swallowed. A dead pipe must still not take the whole app down.
    proc.on('error', (err) => {
      console.error(`[voicerkit] could not spawn ${this.binary}:`, err)
      this.#report(err)
    })
    proc.stdin.on('error', (err) => console.warn('[voicerkit] stdin:', err.message))

    this.#proc = proc
  }

  onCrash(fn: () => void): void {
    this.#crashHandlers.push(fn)
  }

  /** Fatal sidecar problems, with the reason attached. */
  onError(fn: (err: Error) => void): void {
    this.#errorHandlers.push(fn)
  }

  #report(err: Error): void {
    for (const fn of this.#errorHandlers) fn(err)
  }

  /** Exposed for tests that need to poke the protocol directly. */
  sendRaw(req: Record<string, unknown>): void {
    this.#proc?.stdin.write(JSON.stringify(req) + '\n')
  }

  #ingest(chunk: string): void {
    this.#buffer += chunk
    let i: number
    while ((i = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, i).trim()
      this.#buffer = this.#buffer.slice(i + 1)
      if (!line) continue
      try {
        this.#dispatch(JSON.parse(line) as SidecarEvent)
      } catch {
        // A malformed line is the sidecar's problem, not a reason to stop reading.
      }
    }
  }

  #dispatch(event: SidecarEvent): void {
    // Partials are a stream, not a reply — they never settle the promise.
    if (event.event === 'partial') {
      this.#onPartial.get(event.id)?.(event.text, event.level)
      return
    }
    const pending = this.#pending.get(event.id)
    if (!pending) return
    this.#pending.delete(event.id)
    this.#onPartial.delete(event.id)
    if (event.event === 'error') {
      pending.reject(new Error(`${event.code}: ${event.message}`))
    } else {
      pending.resolve(event)
    }
  }

  #request(cmd: string, extra: Record<string, unknown> = {}): { id: number; done: Promise<SidecarEvent> } {
    const id = this.#nextId++
    const done = new Promise<SidecarEvent>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
    })
    this.sendRaw({ cmd, id, ...extra })
    return { id, done }
  }

  listenStart(onPartial: (text: string, level: number) => void): Promise<string> {
    const { id, done } = this.#request('listen_start')
    this.#listenId = id
    this.#onPartial.set(id, onPartial)
    return done.then((e) => (e.event === 'final' ? e.text : ''))
  }

  listenStop(): void {
    if (this.#listenId === undefined) return
    this.sendRaw({ cmd: 'listen_stop', id: this.#listenId })
    this.#listenId = undefined
  }

  async capture(): Promise<{ path: string; w: number; h: number }> {
    const e = await this.#request('capture').done
    if (e.event !== 'captured') throw new Error('unexpected reply to capture')
    return { path: e.path, w: e.w, h: e.h }
  }

  async speak(text: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('aborted')
    const { id, done } = this.#request('speak', { text })
    const onAbort = () => this.sendRaw({ cmd: 'cancel', id })
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await done
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** click / type / key / scroll — resolves once the sidecar reports `acted`. */
  async act(cmd: string, args: Record<string, unknown>): Promise<void> {
    await this.#request(cmd, args).done
  }

  stop(): void {
    this.#proc?.kill()
    this.#proc = undefined
  }
}
