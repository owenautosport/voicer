import { describe, it, expect, vi, type Mock } from 'vitest'
import { buildControlTools, type ControlDeps } from './control-server'

const deps = (over: Partial<ControlDeps> = {}) => {
  const d = {
    sidecar: {
      capture: vi.fn(async () => ({ path: '/tmp/a.jpg', w: 1280, h: 800 })),
      act: vi.fn(async () => {}),
    },
    log: { append: vi.fn() },
    onAction: vi.fn(),
    readImage: () => Buffer.from('jpegbytes'),
    ...over,
  }
  return d as unknown as ControlDeps & {
    sidecar: { capture: Mock; act: Mock }
    log: { append: Mock }
    onAction: Mock
  }
}

const toolNamed = (d: ControlDeps, name: string) =>
  buildControlTools(d).find((t) => t.name === name)!

describe('control tools', () => {
  it('exposes exactly the five tools the agent needs', () => {
    const names = buildControlTools(deps()).map((t) => t.name).sort()
    expect(names).toEqual(['click', 'key', 'screenshot', 'scroll', 'type'])
  })

  it('never exposes a tool that could be confused with request_access', () => {
    // Claude Code's server gates everything behind request_access. Voicer's
    // does not, and must not pretend to.
    const names = buildControlTools(deps()).map((t) => t.name)
    expect(names).not.toContain('request_access')
  })

  it('screenshot returns an image block the model can read', async () => {
    const d = deps()
    const out = await toolNamed(d, 'screenshot').handler({} as never)
    expect(out.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
    expect(d.sidecar.capture).toHaveBeenCalled()
  })

  it('screenshot tells the model the coordinate space it just got', async () => {
    const out = await toolNamed(deps(), 'screenshot').handler({} as never)
    expect(JSON.stringify(out.content)).toContain('1280x800')
  })

  it('click forwards coordinates to the sidecar', async () => {
    const d = deps()
    await toolNamed(d, 'click').handler({ x: 10, y: 20, button: 'left' } as never)
    expect(d.sidecar.act).toHaveBeenCalledWith('click', { x: 10, y: 20, button: 'left' })
  })

  it('logs every action and reports it for the status line', async () => {
    const d = deps()
    await toolNamed(d, 'type').handler({ text: 'hello' } as never)
    expect(d.log.append).toHaveBeenCalledWith(expect.objectContaining({ tool: 'type' }))
    expect(d.onAction).toHaveBeenCalledWith('type')
  })

  it('surfaces a sidecar failure as a tool error rather than throwing', async () => {
    const d = deps()
    d.sidecar.act.mockRejectedValueOnce(new Error('not_trusted: not trusted'))
    const out = await toolNamed(d, 'click').handler({ x: 1, y: 1 } as never)
    expect(out.isError).toBe(true)
    expect(JSON.stringify(out.content)).toContain('not trusted')
  })

  it('logs an action that failed, not just ones that succeeded', async () => {
    const d = deps()
    d.sidecar.act.mockRejectedValueOnce(new Error('boom'))
    await toolNamed(d, 'key').handler({ combo: 'cmd+s' } as never)
    expect(d.log.append).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }))
  })

  it('reports a capture failure as a tool error', async () => {
    const d = deps()
    d.sidecar.capture.mockRejectedValueOnce(new Error('declined TCC'))
    const out = await toolNamed(d, 'screenshot').handler({} as never)
    expect(out.isError).toBe(true)
    expect(JSON.stringify(out.content)).toContain('declined TCC')
  })

  it('gets out of the way before clicking where it might be sitting', async () => {
    const seen: unknown[] = []
    const tools = buildControlTools(deps({
      avoid: (x: number, y: number, shot?: { w: number; h: number }) => {
        seen.push({ x, y, shot })
      },
    }))
    await tools.find((t) => t.name === 'screenshot')!.handler({} as never)
    await tools.find((t) => t.name === 'click')!.handler({ x: 12, y: 34 } as never)
    expect(seen).toEqual([{ x: 12, y: 34, shot: { w: 1280, h: 800 } }])
  })

  it('does not consult the mover for actions that have no point', async () => {
    let called = 0
    const tools = buildControlTools(deps({ avoid: () => { called += 1 } }))
    await tools.find((t) => t.name === 'type')!.handler({ text: 'hi' } as never)
    await tools.find((t) => t.name === 'key')!.handler({ combo: 'cmd+s' } as never)
    expect(called).toBe(0)
  })
})
