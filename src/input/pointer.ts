// Указатель сессионного X-сервера как аналоговый канал панели.
//
// После замеров [#87] и [#88]. evdev отпал не по правам, а по захвату
// (ADR 0002, Ф9): контроллер читается, но молчит — Steam Input держит его себе.
// С включённым mouse behaviour указатель существует, но в `/dev/input` его нет
// вовсе (Ф10): Steam Input отдаёт его внутрь gamescope.
//
// Отсюда единственный оставшийся аналоговый канал: **указатель того самого
// X-сервера `:0`, на котором живёт наша панель**. Он читается опросом, а не
// событиями, и потому не требует ни фокуса, ни ввода в слой оверлея — то есть
// не спорит с инвариантом «ввод из слоя оверлея не приходит никогда».
//
// Здесь только разбор ответа `xdotool getmouselocation --shell`. Сам опрос —
// в зонде (`tools/probe-pointer.ts`); в рантайме его заменит `XQueryPointer`
// из процесса панели, если замер скажет «да».

export interface PointerAt { x: number, y: number, screen?: number, window?: number }

/**
 * Ответ `xdotool getmouselocation --shell`:
 *
 *   X=640
 *   Y=400
 *   SCREEN=0
 *   WINDOW=12582919
 *
 * `null` — ответа нет или он не про указатель. Пустая строка тоже сюда: молчащий
 * `xdotool` неотличим от нулевых координат, если не различить их явно.
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
  /** Сколько раз координата отличалась от предыдущей. Это и есть «указатель жив». */
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

/** Добавляет отсчёт к следу. Движением считается только смена координаты. */
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
 * Вердикт следа словами. Разделение важное: «указатель не двигался» и «указатель
 * шевельнулся на пиксель» — разные ответы. Первое значит, что канала нет; второе
 * значит, что канал есть, но палец по тачпаду до него доезжает не весь.
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
 * На каком сервере курсор действительно шевелился. `null` — ни на одном.
 *
 * Нужно потому, что серверов два и курсор может жить не там, где панель: замер
 * [#90] показал на `:0` неподвижные 1279,799, пока на экране курсор ходил.
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

// ── кнопка ──────────────────────────────────────────────────────────────────
//
// Клик у панели берётся из той же строки `gs-pointer`, что и координаты: маска
// кнопок приезжает третьим полем `XQueryPointer`. Отдельного канала не нужно —
// Тестер забиндил левую кнопку мыши на имитацию нажатия тачпада (14.09.2026),
// а PoE в геймпад-режиме мышь игнорирует (ADR 0002, Ф12). То есть нажатие
// достаётся нам и не достаётся игре.

/** `Button1Mask` в ответе `XQueryPointer` — левая кнопка. */
export const BUTTON1 = 1 << 8

export const isPressed = (mask: number): boolean => (mask & BUTTON1) !== 0

/**
 * Строка `gs-pointer`: `pointer <x> <y> <mask>`. `null` — строка не про указатель
 * (баннер, жалоба); молчать о таких нельзя только тому, кто их печатает.
 */
export function parsePointerLine (line: string): { x: number, y: number, mask: number } | null {
  const found = line.match(/^pointer (-?\d+) (-?\d+) (\d+)/)
  if (!found) return null
  return { x: Number(found[1]), y: Number(found[2]), mask: Number(found[3]) }
}
