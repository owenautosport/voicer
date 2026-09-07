import { describe, it, expect } from 'vitest'
import { windowOptions, PILL_WIDTH, PILL_HEIGHT } from './window'

const PRELOAD = '/app/preload.js'

describe('windowOptions', () => {
  it('is transparent, frameless and always on top', () => {
    const o = windowOptions(PRELOAD)
    expect(o.transparent).toBe(true)
    expect(o.frame).toBe(false)
    expect(o.alwaysOnTop).toBe(true)
  })

  it('never takes keyboard focus, so typing continues in the app underneath', () => {
    expect(windowOptions(PRELOAD).focusable).toBe(false)
  })

  it('has no shadow, is not resizable, and stays out of the taskbar', () => {
    const o = windowOptions(PRELOAD)
    expect(o.hasShadow).toBe(false)
    expect(o.resizable).toBe(false)
    expect(o.skipTaskbar).toBe(true)
  })

  it('isolates the renderer from Node', () => {
    const wp = windowOptions(PRELOAD).webPreferences
    expect(wp.contextIsolation).toBe(true)
    expect(wp.nodeIntegration).toBe(false)
    expect(wp.preload).toBe(PRELOAD)
  })

  it('restores a saved position when given one', () => {
    const o = windowOptions(PRELOAD, { x: 400, y: 120 })
    expect(o).toMatchObject({ x: 400, y: 120 })
  })

  it('omits x and y when there is no saved position', () => {
    expect(windowOptions(PRELOAD)).not.toHaveProperty('x')
  })

  it('is the size the renderer expects', () => {
    const o = windowOptions(PRELOAD)
    expect(o.width).toBe(PILL_WIDTH)
    expect(o.height).toBe(PILL_HEIGHT)
  })
})
