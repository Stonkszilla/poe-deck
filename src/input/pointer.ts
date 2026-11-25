// The pointer of the session X server as the analog channel of the panel.
//
// After measurements [#87] and [#88]. evdev dropped out not because of permissions but because of a grab
// (ADR 0002, F9): the controller is readable but silent, because Steam Input keeps it.
// With mouse behaviour on, the pointer exists, but it is not in `/dev/input`
// at all (F10): Steam Input gives it into gamescope.
//
// Hence the only analog channel left: **the pointer of the same
// X server `:0` where our panel lives**. We read it by polling, not
// by events, so it needs neither focus nor input into the overlay layer; so it
// does not conflict with the invariant "input never comes from the overlay layer".
//
// Here is only the parser of the `xdotool getmouselocation --shell` reply. The polling
// is in the probe (`tools/probe-pointer.ts`); at runtime `XQueryPointer`
// from the panel process replaces it, if the measurement says "yes".

export interface PointerAt { x: number, y: number, screen?: number, window?: number }

/**
 * The reply of `xdotool getmouselocation --shell`:
 *
 *   X=640
 *   Y=400
 *   SCREEN=0
 *   WINDOW=12582919
 *
 * `null`: no reply, or the reply is not about the pointer. An empty string goes here too: a silent
 * `xdotool` looks the same as zero coordinates unless we tell them apart explicitly.
 */
export function parsePointer (text: string): PointerAt | null {
  const num = (key: string): number | undefined => {
    const found = text.match(new RegExp(`^${key}=(-?\\d+)$`, 'm'))
    return found ? Number(found[1]) : undefined
  }

  const x = num('X')
  const y = num('Y')
  if (x === undefined || y === undefined) return null

  const at: PointerAt = { x, y }
  const screen = num('SCREEN')
  const window = num('WINDOW')
  if (screen !== undefined) at.screen = screen
  if (window !== undefined) at.window = window
  return at
}

export interface PointerTrack {
  samples: number
  /** How many times the coordinate differed from the previous one. This is "the pointer is alive". */
  moves: number
  minX: number
  maxX: number
  minY: number
  maxY: number
  last?: PointerAt
}

export const emptyTrack = (): PointerTrack => ({
  samples: 0, moves: 0, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity
})

/** Adds a sample to the track. Only a coordinate change counts as a move. */
export function track (prev: PointerTrack, at: PointerAt): PointerTrack {
  const moved = !prev.last || prev.last.x !== at.x || prev.last.y !== at.y
  return {
    samples: prev.samples + 1,
    moves: prev.moves + (moved ? 1 : 0),
    minX: Math.min(prev.minX, at.x),
    maxX: Math.max(prev.maxX, at.x),
    minY: Math.min(prev.minY, at.y),
    maxY: Math.max(prev.maxY, at.y),
    last: at
  }
}

/**
 * The track verdict in words. The distinction matters: "the pointer did not move" and "the pointer
 * moved by one pixel" are different answers. The first means there is no channel; the second
 * means the channel exists, but not all of the finger travel on the trackpad reaches it.
 */
export function verdict (t: PointerTrack, screen = { w: 1280, h: 800 }): string {
  if (!t.samples) return '✗  no samples at all: could not read the pointer'
  if (t.moves <= 1) return '✗  pointer never moved — no analog channel on this server'

  const spanX = t.maxX - t.minX
  const spanY = t.maxY - t.minY
  const wide = spanX >= screen.w / 4 && spanY >= screen.h / 4
  return wide
    ? `✓  pointer travels the screen: ${t.moves} moves, X ${t.minX}..${t.maxX}, Y ${t.minY}..${t.maxY}`
    : `⚠  pointer moved, but in a small field: X ${t.minX}..${t.maxX}, Y ${t.minY}..${t.maxY} — ` +
      'check whether the whole touchpad reaches the screen'
}

/**
 * The server on which the cursor really moved. `null`: none.
 *
 * It is needed because there are two servers, and the cursor may live away from the panel: measurement
 * [#90] showed a still 1279,799 on `:0` while the cursor moved on the screen.
 */
export function where (tracks: Map<string, PointerTrack>): string | null {
  let best: { display: string, span: number } | null = null

  for (const [display, t] of tracks) {
    if (t.moves <= 1) continue
    const span = (t.maxX - t.minX) + (t.maxY - t.minY)
    if (!best || span > best.span) best = { display, span }
  }

  return best?.display ?? null
}

// ── button ──────────────────────────────────────────────────────────────────
//
// The panel takes the click from the same `gs-pointer` line as the coordinates: the button
// mask arrives as the third field of `XQueryPointer`. No separate channel is needed:
// the tester bound the left mouse button to the emulated trackpad press (14.09.2026),
// and PoE in gamepad mode ignores the mouse (ADR 0002, F12). So the press
// reaches us and does not reach the game.

/** `Button1Mask` in the `XQueryPointer` reply: the left button. */
export const BUTTON1 = 1 << 8

export const isPressed = (mask: number): boolean => (mask & BUTTON1) !== 0

/**
 * A `gs-pointer` line: `pointer <x> <y> <mask>`. `null`: the line is not about the pointer
 * (a banner, a complaint); only the process that prints such lines must not stay silent about them.
 */
export function parsePointerLine (line: string): { x: number, y: number, mask: number } | null {
  const found = line.match(/^pointer (-?\d+) (-?\d+) (\d+)/)
  if (!found) return null
  return { x: Number(found[1]), y: Number(found[2]), mask: Number(found[3]) }
}
