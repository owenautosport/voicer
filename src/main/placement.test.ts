import { describe, it, expect } from 'vitest'
import { placeIn, contains, alignmentAwayFrom, ALIGNMENTS, isAlignment } from './placement'

const SCREEN = { x: 0, y: 25, width: 1000, height: 600 }
const PILL = { width: 100, height: 40 }

describe('placeIn', () => {
  it('hangs from the top edge when centred on top', () => {
    expect(placeIn(SCREEN, PILL, 'top')).toEqual({ x: 450, y: 25 })
  })

  it('sits flush in each corner', () => {
    expect(placeIn(SCREEN, PILL, 'top-left')).toEqual({ x: 0, y: 25 })
    expect(placeIn(SCREEN, PILL, 'top-right')).toEqual({ x: 900, y: 25 })
    expect(placeIn(SCREEN, PILL, 'bottom-left')).toEqual({ x: 0, y: 585 })
    expect(placeIn(SCREEN, PILL, 'bottom-right')).toEqual({ x: 900, y: 585 })
  })

  it('centres vertically on the left and right edges', () => {
    expect(placeIn(SCREEN, PILL, 'left')).toEqual({ x: 0, y: 305 })
    expect(placeIn(SCREEN, PILL, 'right')).toEqual({ x: 900, y: 305 })
  })

  it('respects a work area that does not start at the origin', () => {
    const area = { x: 100, y: 50, width: 500, height: 400 }
    expect(placeIn(area, PILL, 'bottom')).toEqual({ x: 300, y: 410 })
  })

  it('never places the window outside the work area', () => {
    for (const align of ALIGNMENTS) {
      const p = placeIn(SCREEN, PILL, align)
      expect(p.x).toBeGreaterThanOrEqual(SCREEN.x)
      expect(p.y).toBeGreaterThanOrEqual(SCREEN.y)
      expect(p.x + PILL.width).toBeLessThanOrEqual(SCREEN.x + SCREEN.width)
      expect(p.y + PILL.height).toBeLessThanOrEqual(SCREEN.y + SCREEN.height)
    }
  })
})

describe('alignmentAwayFrom', () => {
  it('stays put when the capsule is nowhere near the point', () => {
    expect(alignmentAwayFrom(SCREEN, PILL, 'top', 500, 500)).toBeUndefined()
  })

  it('moves when the point falls under the capsule', () => {
    // Dead centre of the top edge, which is exactly where 'top' sits.
    const moved = alignmentAwayFrom(SCREEN, PILL, 'top', 500, 30)
    expect(moved).toBeDefined()
    expect(moved).not.toBe('top')
  })

  it('moves as far from the obstruction as it can', () => {
    expect(alignmentAwayFrom(SCREEN, PILL, 'top-left', 10, 30)).toBe('bottom-right')
    expect(alignmentAwayFrom(SCREEN, PILL, 'bottom-right', 990, 610)).toBe('top-left')
  })

  it('never chooses somewhere that is also in the way', () => {
    const moved = alignmentAwayFrom(SCREEN, PILL, 'top', 500, 30)
    expect(contains({ ...placeIn(SCREEN, PILL, moved!), ...PILL }, 500, 30)).toBe(false)
  })
})

describe('isAlignment', () => {
  it('accepts the eight it knows and rejects anything else', () => {
    expect(ALIGNMENTS.every(isAlignment)).toBe(true)
    expect(isAlignment('centre')).toBe(false)
    expect(isAlignment(undefined)).toBe(false)
  })
})
