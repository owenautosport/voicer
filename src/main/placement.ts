/**
 * Where the capsule sits, and where it moves to when it is in the way.
 *
 * Pure, so every position can be asserted without a screen: the arithmetic is
 * the whole of the behaviour, and getting it wrong puts the window off the edge
 * of a display where nobody can drag it back.
 */

export type Alignment =
  | 'top-left' | 'top' | 'top-right'
  | 'right' | 'bottom-right' | 'bottom'
  | 'bottom-left' | 'left'

/** Clockwise from the top-left, so a UI can lay them out in a ring. */
export const ALIGNMENTS: Alignment[] = [
  'top-left', 'top', 'top-right',
  'right', 'bottom-right', 'bottom',
  'bottom-left', 'left',
]

export const isAlignment = (v: unknown): v is Alignment =>
  typeof v === 'string' && (ALIGNMENTS as string[]).includes(v)

export type Rect = { x: number; y: number; width: number; height: number }
export type Size = { width: number; height: number }

const horizontal = (align: Alignment): 'start' | 'centre' | 'end' =>
  align.endsWith('left') ? 'start' : align.endsWith('right') ? 'end'
    : align === 'left' ? 'start' : align === 'right' ? 'end' : 'centre'

const vertical = (align: Alignment): 'start' | 'centre' | 'end' =>
  align.startsWith('top') ? 'start' : align.startsWith('bottom') ? 'end' : 'centre'

/**
 * Flush to the edges it is named after. The capsule is drawn as something
 * hanging off an edge, so a gap would read as a mistake rather than as margin.
 */
export function placeIn(area: Rect, size: Size, align: Alignment): { x: number; y: number } {
  const h = horizontal(align)
  const v = vertical(align)
  return {
    x: h === 'start' ? area.x
      : h === 'end' ? area.x + area.width - size.width
      : Math.round(area.x + (area.width - size.width) / 2),
    y: v === 'start' ? area.y
      : v === 'end' ? area.y + area.height - size.height
      : Math.round(area.y + (area.height - size.height) / 2),
  }
}

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
}

const centreOf = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

const rectFor = (area: Rect, size: Size, align: Alignment): Rect => ({
  ...placeIn(area, size, align),
  ...size,
})

/**
 * The alignment furthest from a point the capsule must stop covering.
 *
 * Returns undefined when the capsule is not in the way, so the caller can leave
 * a settled window alone rather than shuffling it on every click.
 */
export function alignmentAwayFrom(
  area: Rect,
  size: Size,
  current: Alignment,
  x: number,
  y: number,
): Alignment | undefined {
  if (!contains(rectFor(area, size, current), x, y)) return undefined

  let best: Alignment | undefined
  let bestDistance = -1
  for (const align of ALIGNMENTS) {
    if (align === current) continue
    const rect = rectFor(area, size, align)
    if (contains(rect, x, y)) continue
    const c = centreOf(rect)
    const distance = (c.x - x) ** 2 + (c.y - y) ** 2
    if (distance > bestDistance) {
      bestDistance = distance
      best = align
    }
  }
  return best
}
