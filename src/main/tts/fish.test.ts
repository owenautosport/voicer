import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FishBackend } from './fish'

describe('FishBackend', () => {
  let played: Buffer[]
  beforeEach(() => { played = [] })

  const make = (fetchImpl: unknown) =>
    new FishBackend(
      { apiKey: 'k', voiceId: 'v' },
      async (mp3) => { played.push(mp3) },
      fetchImpl as typeof fetch,
    )

  it('posts to the Fish endpoint with the free model and plays the audio', async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from('fake-mp3'), { status: 200 }))
    await make(fetchMock).speak('hello', new AbortController().signal)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.fish.audio/v1/tts')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer k', model: 's2.1-pro-free' })
    expect(JSON.parse(init.body as string)).toMatchObject({
      text: 'hello', reference_id: 'v', format: 'mp3',
    })
    expect(played).toHaveLength(1)
  })

  it('throws on a non-2xx so the router can demote', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 402 }))
    await expect(make(fetchMock).speak('hi', new AbortController().signal)).rejects.toThrow(/402/)
    expect(played).toEqual([])
  })

  it('omits reference_id when no voice is configured', async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from('x'), { status: 200 }))
    const backend = new FishBackend({ apiKey: 'k' }, async () => {}, fetchMock as unknown as typeof fetch)
    await backend.speak('hi', new AbortController().signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).reference_id).toBeUndefined()
  })

  it('propagates an abort as a rejection', async () => {
    const ac = new AbortController()
    ac.abort()
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      return new Response(Buffer.from('x'), { status: 200 })
    })
    await expect(make(fetchMock).speak('hi', ac.signal)).rejects.toThrow()
  })
})
