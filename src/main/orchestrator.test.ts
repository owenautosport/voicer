import { describe, it, expect, vi } from 'vitest'
import { Orchestrator, type OrchestratorDeps } from './orchestrator'

type Deps = OrchestratorDeps & {
  sidecar: { listenStart: any; listenStop: any; capture: any; onCrash: any }
  agent: { run: any; abort: any }
  tts: { push: any; flush: any; abort: any; activeBackend: string }
}

/**
 * Mirrors the real SidecarClient: listenStart's promise stays pending until
 * listenStop is called, because the transcript only arrives on `final`.
 */
const gatedListen = (transcript = 'what is this') => {
  let release: (t: string) => void = () => {}
  const listenStart = vi.fn(
    (_onPartial: (t: string, l: number) => void) =>
      new Promise<string>((resolve) => { release = resolve }),
  )
  const listenStop = vi.fn(() => release(transcript))
  return { listenStart, listenStop }
}

const deps = (over: Record<string, any> = {}): Deps => ({
  sidecar: {
    ...gatedListen(),
    capture: vi.fn(async () => ({ path: '/tmp/a.jpg', w: 1280, h: 800 })),
    onCrash: vi.fn(),
    ...over.sidecar,
  },
  agent: {
    run: vi.fn(async (_t: string, _i: string | undefined, cb: any) => {
      cb.onText('It is a login form.')
      cb.onDone('s1')
    }),
    abort: vi.fn(),
    ...over.agent,
  },
  tts: {
    push: vi.fn(), flush: vi.fn(async () => {}), abort: vi.fn(), activeBackend: 'apple',
    ...over.tts,
  },
}) as Deps

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('Orchestrator', () => {
  it('first click listens, second click runs the turn', async () => {
    const d = deps()
    const o = new Orchestrator(d)
    o.micClick()
    await settle()
    expect(d.sidecar.listenStart).toHaveBeenCalled()
    o.micClick()
    await settle()
    expect(d.sidecar.listenStop).toHaveBeenCalled()
    expect(d.sidecar.capture).toHaveBeenCalled()
    expect(d.agent.run).toHaveBeenCalledWith('what is this', '/tmp/a.jpg', expect.anything())
  })

  it('pushes the agent text into the speech router and drains it', async () => {
    const d = deps()
    const o = new Orchestrator(d)
    o.micClick(); await settle()
    o.micClick(); await settle()
    expect(d.tts.push).toHaveBeenCalledWith('It is a login form.')
    expect(d.tts.flush).toHaveBeenCalled()
    expect(o.state).toBe('idle')
  })

  it('surfaces the running answer to the UI', async () => {
    const d = deps()
    const o = new Orchestrator(d)
    const answers: string[] = []
    o.onAnswer((t) => answers.push(t))
    o.micClick(); await settle()
    o.micClick(); await settle()
    expect(answers).toEqual(['It is a login form.'])
  })

  it('does not call the agent when nothing was said', async () => {
    const d = deps({ sidecar: gatedListen('   ') })
    const o = new Orchestrator(d)
    o.micClick(); await settle()
    o.micClick(); await settle()
    expect(d.agent.run).not.toHaveBeenCalled()
    expect(o.state).toBe('idle')
  })

  it('abort stops the agent and the speech and returns to idle', async () => {
    const d = deps()
    const o = new Orchestrator(d)
    o.micClick(); await settle()
    o.micClick()
    o.abort()
    await settle()
    expect(d.agent.abort).toHaveBeenCalled()
    expect(d.tts.abort).toHaveBeenCalled()
    expect(o.state).toBe('idle')
  })

  it('reports a tool call as a human-readable status', async () => {
    const d = deps({
      agent: {
        run: vi.fn(async (_t: string, _i: unknown, cb: any) => {
          cb.onTool('mcp__voicer-control__click', {})
          cb.onDone('s1')
        }),
      },
    })
    const o = new Orchestrator(d)
    const status = vi.fn()
    o.onStatus(status)
    o.micClick(); await settle()
    o.micClick(); await settle()
    expect(status).toHaveBeenCalledWith('click…')
  })

  it('goes red while the agent has the controls', async () => {
    let states: string[] = []
    const d = deps({
      agent: {
        run: vi.fn(async (_t: string, _i: unknown, cb: any) => {
          cb.onTool('mcp__voicer-control__click', {})
          cb.onDone('s1')
        }),
      },
    })
    const o = new Orchestrator(d)
    o.onState((s) => states.push(s))
    o.micClick(); await settle()
    o.micClick(); await settle()
    expect(states).toContain('acting')
  })

  it('a capture failure still runs the turn, without the screenshot', async () => {
    const d = deps({ sidecar: { capture: vi.fn(async () => { throw new Error('no display') }) } })
    const o = new Orchestrator(d)
    o.micClick(); await settle()
    o.micClick(); await settle()
    expect(d.agent.run).toHaveBeenCalledWith('what is this', undefined, expect.anything())
  })

  it('an agent error is spoken and leaves the machine idle', async () => {
    const d = deps({
      agent: { run: vi.fn(async (_t: string, _i: unknown, cb: any) => cb.onError(new Error('boom'))) },
    })
    const o = new Orchestrator(d)
    o.micClick(); await settle()
    o.micClick(); await settle()
    expect(d.tts.push).toHaveBeenCalledWith(expect.stringContaining('went wrong'))
    expect(o.state).toBe('idle')
  })

  it('a sidecar crash puts the pill into the error state', async () => {
    let crash: (() => void) | undefined
    const d = deps({ sidecar: { onCrash: vi.fn((fn: () => void) => { crash = fn }) } })
    const o = new Orchestrator(d)
    crash!()
    expect(o.state).toBe('error')
  })

  it('a listen failure does not wedge the machine', async () => {
    const d = deps({ sidecar: { listenStart: vi.fn(async () => { throw new Error('no mic') }) } })
    const o = new Orchestrator(d)
    o.micClick(); await settle()
    expect(o.state).toBe('error')
    o.micClick()
    expect(o.state).toBe('listening')
  })

  it('forwards partial transcripts and mic level to the UI', async () => {
    const d = deps({
      sidecar: {
        listenStart: vi.fn((onPartial: (t: string, l: number) => void) => {
          onPartial('hel', 0.3)
          onPartial('hello', 0.5)
          return new Promise<string>(() => {})
        }),
      },
    })
    const o = new Orchestrator(d)
    const seen: [string, number][] = []
    o.onPartial((t, l) => seen.push([t, l]))
    o.micClick(); await settle()
    expect(seen).toEqual([['hel', 0.3], ['hello', 0.5]])
  })

  it('runs the turn when the recogniser finishes on its own, with no second click', async () => {
    // SFSpeechRecognizer emits a final at end of speech or on error. Without
    // this the turn would be silently discarded.
    const d = deps({ sidecar: { listenStart: vi.fn(async () => 'it stopped by itself') } })
    const o = new Orchestrator(d)
    o.micClick()
    await settle()
    expect(d.agent.run).toHaveBeenCalledWith('it stopped by itself', '/tmp/a.jpg', expect.anything())
    expect(o.state).toBe('idle')
  })
})
