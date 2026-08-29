import { describe, it, expect, vi, afterEach } from 'vitest'
import { SidecarClient } from './sidecar'

const FAKE = new URL('../../test/fake-sidecar.mjs', import.meta.url).pathname

let client: SidecarClient | undefined
afterEach(() => {
  client?.stop()
  client = undefined
})

const started = () => {
  client = new SidecarClient(process.execPath, [FAKE])
  client.start()
  return client
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))

describe('SidecarClient', () => {
  it('streams partials then resolves with the final transcript', async () => {
    const c = started()
    const partials: string[] = []
    const final = c.listenStart((text) => partials.push(text))
    await tick()
    c.listenStop()
    expect(await final).toBe('hello world')
    expect(partials).toEqual(['hello', 'hello world'])
  })

  it('reports the mic level alongside each partial', async () => {
    const c = started()
    const levels: number[] = []
    const final = c.listenStart((_t, level) => levels.push(level))
    await tick()
    c.listenStop()
    await final
    expect(levels).toEqual([0.4, 0.6])
  })

  it('resolves capture with the path and dimensions', async () => {
    expect(await started().capture()).toEqual({ path: '/tmp/fake.jpg', w: 1280, h: 800 })
  })

  it('resolves speak when the sidecar reports speech_done', async () => {
    await expect(started().speak('hi', new AbortController().signal)).resolves.toBeUndefined()
  })

  it('rejects speak when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(started().speak('hi', ac.signal)).rejects.toThrow(/abort/i)
  })

  it('resolves act when the sidecar reports it acted', async () => {
    await expect(started().act('click', { x: 1, y: 2 })).resolves.toBeUndefined()
  })

  it('rejects act when the sidecar reports an error', async () => {
    await expect(started().act('click', { x: 1, y: 2, fail: true })).rejects.toThrow(/not trusted/)
  })

  it('correlates concurrent requests by id', async () => {
    const c = started()
    const [a, b] = await Promise.all([c.capture(), c.capture()])
    expect(a.path).toBe('/tmp/fake.jpg')
    expect(b.path).toBe('/tmp/fake.jpg')
  })

  it('notifies on crash', async () => {
    const c = started()
    const onCrash = vi.fn()
    // Wait on the event rather than the clock: spawning node takes long enough
    // under load that any fixed sleep is a flake waiting to happen.
    const crashed = new Promise<void>((resolve) => c.onCrash(() => resolve()))
    c.onCrash(onCrash)
    c.sendRaw({ cmd: 'crash', id: 99 })
    await crashed
    expect(onCrash).toHaveBeenCalled()
  })

  it('rejects in-flight requests when the sidecar dies', async () => {
    const c = started()
    const pending = c.act('hang', {})
    c.sendRaw({ cmd: 'crash', id: 98 })
    await expect(pending).rejects.toThrow(/exited/)
  })

  it('does not split events that arrive in one chunk', async () => {
    const c = started()
    const results = await Promise.all([c.capture(), c.capture(), c.capture()])
    expect(results).toHaveLength(3)
  })
})
