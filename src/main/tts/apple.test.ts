import { describe, it, expect, vi } from 'vitest'
import { AppleBackend } from './apple'

describe('AppleBackend', () => {
  it('delegates to the sidecar', async () => {
    const speak = vi.fn(async () => {})
    const signal = new AbortController().signal
    await new AppleBackend({ speak }).speak('hello', signal)
    expect(speak).toHaveBeenCalledWith('hello', signal)
  })

  it('propagates a sidecar failure so the router can react', async () => {
    const speak = vi.fn(async () => { throw new Error('sidecar exited') })
    await expect(new AppleBackend({ speak }).speak('hi', new AbortController().signal))
      .rejects.toThrow(/sidecar exited/)
  })
})
