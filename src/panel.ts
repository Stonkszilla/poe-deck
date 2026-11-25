// What the panel shows, in the commands of the ADR 0003 seam (`rect`, `text`, `show`).
//
// The joint between the price check and the renderer. No X11, no network, no
// parser here: the input is what happened, the output is lines for gs-panel stdin.
// So the layout is tested without a Deck and without the game, with plain `bun test`.
//
// THE MAIN REQUIREMENT OF THIS FILE is not looks. It is that **a silent panel
// cannot be told apart from a broken one**. No network, API rate limit, item not
// recognized, no price on trade at all: each outcome has its own frame with words.
// There is exactly one "show nothing" frame: `clearFrame`. It means "there is
// nothing to show now", not "something went wrong".
//
// Seam limits that are visible right in the code:
//
//  - **Coordinates are absolute**, the overlay has no "window" (ADR 0003, Decision 2).
//  - **Only the renderer knows the line width.** There is no back channel, so
//    either the renderer wraps (`WRAP`), or the line is cut here by estimate.
//  - **Noto Sans coverage only** (ADR 0003, F4): Xft has no font fallback, a
//    missing glyph goes to the screen as an empty box. Hence `~` instead of
//    `≈` and `...` instead of `…`. The renderer reports such characters to stderr,
//    but it does so on the live Deck, not here.

import {
  BlockedHostError,
  MaintenanceError,
  RateLimitError,
  REQUEST_TIMEOUT_MS,
  TradeHttpError,
  TradeTimeoutError,
  UnknownLeagueError
} from './trade/client'
import { draftProblem, isDirty, slotAt, slots, type Editor, type Slot } from './editor'
import {
  NARROW_SAMPLE,
  priceAmountText,
  priceSpreadText,
  priceScopeText,
  priceValueText,
  rateText,
  stackPrice,
  type Price,
  type Rate
} from './trade/price'
import type { ExchangeReference } from './trade/ninja'
import { scopeNote } from './price-check'
import { groupLabel, rollText, type ModFilter } from './trade/filters'
import { MODE_LABEL, type PricedItem } from './trade/query'
import type { PriceCheck } from './price-check'

// ── geometry and palette ─────────────────────────────────────────────────────
//
// The left position is not a matter of taste: in PoE the inventory and the item
// tooltip live on the right, and the panel must not cover what is being priced.
// Run #69 showed that on the stash screen this is not always true either. The
// final position is chosen on the live Deck, and it is changed here, not in the renderer.

/** Panel position and width. Change it here, not in the renderer (ADR 0003, Decision 2). */
export interface Box { x: number, y: number, w: number }

// The width comes from a mod line, not from taste: "+29% to Lightning Resistance"
// with bounds did not fit in 460 px and went to "..." (run #101). The screen is
// 1280 wide and the panel is on the left, so there is room, and a cut mod can be
// neither read nor selected.
const BOX: Box = { x: 40, y: 90, w: 640 }
const PAD = 20
// Gap between lines. It was 10, and the Ambu's Charge list (a property, six
// mods, three group headers, two wraps) stopped fitting on the screen: mods
// fell into "N more below" during editing, which on the Deck reads as
// "the mods disappeared" (tester complaint after run #109). 6 px gives back four
// lines and also makes the panel denser.
const GAP = 6
/** Deck output height. The overlay window is always full screen (ADR 0003, F2). */
const SCREEN_H = 800

const BG = '0F1216E6'
const ACCENT = 'C8AA6EFF'
const MUTED = '8A8478FF'
const VALUE = 'FFFFFFFF'
const NOTE = '6FA8DCFF'
const WARN = 'E0A030FF'
const ERROR = 'E5786DFF'
const RULE = '3A3F46FF'

/**
 * A frame row: either text or a divider. Text has a cursor mark: a bar on
 * the left. It is drawn with `rect`, not with a character: the selected line on
 * a 7" screen must be seen before it is read, and an extra glyph at the start of
 * the line eats width and shifts the text against its neighbors (`fit` trims spaces).
 */
type Row =
  | { kind: 'text', text: string, px: number, color: string, marked?: boolean, cells?: string[], stops?: number[] }
  | { kind: 'rule' }

const text = (text: string, px: number, color: string, marked = false): Row =>
  ({ kind: 'text', text, px, color, marked })
/**
 * A row of equal-width columns: each label starts at the start of its column.
 * It is needed where a row has several hover zones: a label must lie over
 * its zone. `confirm · cancel` as one label took the left third of the panel, but
 * the `cancel` zone was the right half, and hovering the word `cancel` highlighted
 * `confirm` (run #133).
 */
const columns = (cells: string[], px: number, color: string, marked = false, stops?: number[]): Row =>
  ({ kind: 'text', text: cells.join(' '), px, color, marked, cells, stops })
const rule = (): Row => ({ kind: 'rule' })

/**
 * Left column edges as fractions of the row width. Without `stops` the columns
 * are equal. One formula for both the label and the zone: if they are computed
 * apart, the finger points at something other than what it sees (runs #133 and #150).
 */
const edges = (parts: number, stops?: number[]): number[] =>
  stops ?? Array.from({ length: parts }, (_, part) => part / parts)

/** Left edge and width of column `part`. */
const columnSpan = (box: Box, part: number, parts: number, stops?: number[]): { x: number, w: number } => {
  const inner = box.w - PAD * 2
  const at = edges(parts, stops)
  const from = Math.round(inner * at[part]!)
  const to = Math.round(inner * (at[part + 1] ?? 1))
  return { x: box.x + PAD + from, w: to - from }
}

/**
 * Line height for a font size. ADR 0003 measurement: Noto Sans gives 31 px at
 * size 22, that is ~1.41. We take a small margin so that adjacent lines do not stick.
 */
const lineHeight = (px: number): number => Math.round(px * 1.45)

/**
 * Cut by an estimated character width.
 *
 * ponytail: only the side that has the font open knows the real width, and the
 * seam is one-way (ADR 0003, Decision 2), so we cannot ask it for metrics. Hence
 * the factor 0.52 of the mean Noto Sans width, taken from the reference frame. The
 * ceiling is clear: a line of only `W` overflows, a line of only `i` is cut early. If
 * this starts to hurt, the next step is not a better factor but a `text` command
 * with `WRAP` and the panel height computed by the renderer, that is a two-way seam.
 */
export function fit (line: string, px: number, width = BOX.w - PAD * 2): string {
  const max = Math.max(4, Math.floor(width / (px * 0.52)))
  const flat = line.replace(/\s+/g, ' ').trim() // a line break would split the seam command
  return flat.length <= max ? flat : `${flat.slice(0, max - 3).trimEnd()}...`
}

/** How many characters of size `px` fit in a panel line of width `w`. */
function charBudget (px: number, w: number): number {
  return Math.max(4, Math.floor((w - PAD * 2) / (px * 0.52)))
}

/** Content height without outer padding. The backing grows by it. */
function heightOf (rows: Row[]): number {
  return rows.reduce(
    (sum, row) => sum + (row.kind === 'rule' ? GAP * 2 + 1 : lineHeight(row.px) + GAP),
    0
  )
}

/**
 * Rows to a frame: backing by content height, accent bar, text, `show`.
 *
 * Cursor marks go into the frame BEFORE the text, together with the backing. The
 * order is not cosmetic: the check `experiments/deck-ux/check-linux.sh` takes the
 * next `rect` after a line as the bottom of its vertical slot, and a mark inserted
 * between lines would declare a slot of zero height.
 */
export function frame (rows: Row[], box: Box = BOX): string[] {
  return laidOutFrame(rows, box).lines
}

/** Where a frame row lies on the screen. Needed by whoever points the cursor at it. */
export interface RowSpan { y: number, height: number }

/**
 * A frame together with the coordinates of its rows.
 *
 * A separate function, not a second geometry calculation next to it: a cursor hit
 * on a row must be computed from the same numbers the row is drawn with.
 * Two formulas for the same thing drift apart silently, and on the screen this looks
 * like "the finger points at the next row".
 */
export function laidOutFrame (
  rows: Row[],
  box: Box = BOX
): { lines: string[], spans: RowSpan[], height: number } {
  const height = PAD * 2 + Math.max(0, heightOf(rows) - GAP)

  const head = [
    `rect ${box.x} ${box.y} ${box.w} ${height} ${BG}`,
    `rect ${box.x} ${box.y} ${box.w} 4 ${ACCENT}`
  ]
  const out: string[] = []
  const spans: RowSpan[] = []

  let y = box.y + PAD
  for (const row of rows) {
    if (row.kind === 'rule') {
      y += GAP
      out.push(`rect ${box.x + PAD} ${y} ${box.w - PAD * 2} 1 ${RULE}`)
      y += GAP + 1
      continue
    }
    if (row.marked) head.push(`rect ${box.x + 8} ${y} 4 ${lineHeight(row.px)} ${ACCENT}`)
    // WRAP=0: no wrapping on purpose. Otherwise the backing height would stop
    // being computed here, and nobody else can compute it.
    const cells = row.cells ?? [row.text]
    cells.forEach((cell, part) => {
      const { x, w } = columnSpan(box, part, cells.length, row.stops)
      out.push(`text ${x} ${y} 0 ${row.color} ${row.px} ${fit(cell, row.px, w)}`)
    })
    // The row zone is half a step wider than the row itself: the gap between rows
    // goes to the nearest one, otherwise the cursor falls "between" and the selection flickers.
    spans.push({ y: y - GAP / 2, height: lineHeight(row.px) + GAP })
    y += lineHeight(row.px) + GAP
  }

  return { lines: [...head, ...out, 'show'], spans, height }
}

/** Empty frame: no panel on the screen. The only legal way to stay silent. */
export function clearFrame (): string[] {
  return ['show']
}

// ── what exactly we show ─────────────────────────────────────────────────────

/** Item name for the title. A unique needs both names, the rest only need the base. */
export function itemTitle (item: PricedItem): string {
  return item.info.name ?? item.info.refName
}

function itemSubtitle (item: PricedItem): string {
  const parts: string[] = []
  if (item.info.name && item.info.name !== item.info.refName) parts.push(item.info.refName)
  if (item.rarity) parts.push(item.rarity)
  // The map tier is what the map is searched by (`map_tier`), and the player must
  // see it on the panel: without it the T14 and T16 prices look like one price (tester).
  if (item.mapTier != null) parts.push(`T${item.mapTier}`)
  if (item.itemLevel) parts.push(`ilvl ${item.itemLevel}`)
  if (item.isCorrupted) parts.push('corrupted')
  if (item.isUnidentified) parts.push('unidentified')
  return parts.join(' · ')
}

/**
 * Waiting frame. A second or two passes between the press and the price: first the
 * game finishes the clipboard, then trade answers. Without this frame the panel is
 * empty all that time, and the tool looks broken exactly when it works.
 */
export function checkingFrame (item: PricedItem): string[] {
  return frame([
    text(itemTitle(item), 24, ACCENT),
    text(itemSubtitle(item) || 'item parsed', 18, MUTED),
    rule(),
    text('checking price...', 28, VALUE)
  ])
}

/**
 * How much time has passed, in human words. Exactly one frame needs it: the
 * recalled result. "5 chaos" without an age is a promise, not a measurement.
 */
export function agoText (ms: number): string {
  if (ms < 60_000) return 'just now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return `${hours} h ago`
}

/**
 * The "nothing to show" frame. The recall gesture is pressed, but there was no
 * result in this session yet: we cannot show a foreign or made-up price, and we
 * cannot stay silent either (otherwise the gesture looks broken: at the demo
 * acceptance eight L4 presses in a row gave nothing, and the button was judged
 * broken). The button is the same `PRICE_BUTTON` as in the ready frame, so that
 * the hint does not drift from the layout.
 */
export function noResultFrame (): string[] {
  return frame([
    text(`nothing to hide — press ${PRICE_BUTTON} on an item`, 22, VALUE)
  ])
}

/**
 * Which price is the main one on the panel, as the big number. One place for the whole project.
 *
 * `trade` is the best instant buyout rate on trade: it can be done by hand now.
 * `faustus` is the in-game Currency Exchange rate from poe.ninja: trade does not
 * see it, and for cheap currency it differs from trade many times (Orb of Scouring in
 * Covens: a stack of 30 is 10 chaos on trade against ~23 at Faustus). In both cases
 * the second price stays on the panel one line below. If there is no Faustus rate,
 * the trade price becomes the main one for any setting.
 *
 * The default is `faustus`: the player trades currency at the NPC, and the price
 * seen in the game is the Faustus rate (acceptance decision).
 */
export type MainPrice = 'trade' | 'faustus'
export const MAIN_PRICE: MainPrice = 'faustus'

/**
 * The big number and the rate line under it. Currency and shards are sold as a stack:
 * big is the price of the whole stack, below it is the rate of one unit (acceptance
 * remark: "a stack of 20 chaos is 1 divine").
 */
function amountRows (rate: Rate, isExchange: boolean, stack: number | undefined): Row[] {
  const whole = stackPrice(rate, stack)
  // The rate has its own line. The big line has only the number, otherwise
  // "(9.15 per 1 divine)" after the stack price gets cut and means nothing.
  // If one unit costs more than one, the rate is the big number, and a rate line would repeat it.
  const rated = whole ?? (isExchange && rate.amount < 1 ? rate : undefined)
  const rows = [text(`~ ${rated ? priceValueText(whole ?? rate) : priceAmountText(rate)}`, 34, VALUE)]
  if (rated) {
    const unit = rateText(rate)
    rows.push(text(whole ? `stack ${stack} · ${unit}` : unit, 18, MUTED))
  }
  return rows
}

/** The Faustus rate as the second line, when the main price is the trade price. */
function faustusRow (reference: ExchangeReference, stack: number | undefined): Row {
  const whole = stackPrice(reference, stack)
  return text(`Faustus: ${whole ? `~ ${priceValueText(whole)} · ` : ''}${rateText(reference)}`, 22, VALUE)
}

/**
 * Price frame. It is also the "no price" frame: that is an answer from trade, not a failure.
 *
 * `previousMs` is the age of the result when it was recalled with the gesture. A
 * recalled price must look different from a fresh one: it is about the same item and
 * the same filter set, but the market may have moved since then.
 *
 * `main` is which price is big, by default `MAIN_PRICE`.
 */
export function priceFrame (item: PricedItem, check: PriceCheck, previousMs?: number, main: MainPrice = MAIN_PRICE): string[] {
  const rows: Row[] = [
    text(itemTitle(item), 24, ACCENT),
    text(itemSubtitle(item) || 'item parsed', 18, MUTED),
    rule()
  ]
  if (previousMs != null) {
    rows.push(text(`previous result · ${agoText(previousMs)}`, 18, WARN))
  }

  const stack = item.stackSize?.value
  if (main === 'faustus' && check.reference) {
    // The main price is the Faustus rate: it is big, the trade price is one line below.
    rows.push(...amountRows(check.reference, true, stack))
    rows.push(text(`Faustus exchange (poe.ninja), ${check.league}`, 18, NOTE))
    rows.push(check.price
      ? text(`trade: ~ ${priceValueText(stackPrice(check.price, stack) ?? check.price)} · ${priceScopeText(check.price)}`, 18, MUTED)
      : text(`trade: no listings in ${check.league}`, 18, WARN))
  } else if (check.price) {
    rows.push(...amountRows(check.price, check.price.kind === 'exchange', stack))
    rows.push(text(`${priceScopeText(check.price)}, ${check.league}`, 18, NOTE))
    // Spread: where the market stands and how wide it is. One number does not tell
    // the market "5,5,6,6,7" from the market "1,1,40,40,80", and that changes the decision to sell.
    // Exchange has no spread: the price is the best rate, and the tail of the results is overpriced lots.
    const spread = check.price.kind === 'exchange' ? '' : priceSpreadText(check.price)
    if (spread) rows.push(text(spread, 18, MUTED))
    // Four lots on all of trade is the price of four specific items, not of
    // the item: in run #113 Cane of Kulemak with four enabled mods
    // gave 37.5 divine from four lots while the market was 6–10.
    if (check.price.total < NARROW_SAMPLE) {
      rows.push(text(`only ${check.price.total} listings — the filter is narrow`, 18, WARN))
    }
    if (check.reference) rows.push(faustusRow(check.reference, stack))
  } else {
    rows.push(text('no price', 28, WARN))
    rows.push(text(`no listings in ${check.league}`, 18, NOTE))
    if (check.reference) rows.push(faustusRow(check.reference, stack))
  }

  // Caveats. We must not stay silent about them: an empty filter with five mods is
  // the price of the base, and showing it as the item price means showing a foreign number.
  if (check.fellBackToSearch) {
    rows.push(text('no exchange rate — price from listings', 18, WARN))
  }
  // The search mode is part of the answer, not a setting somewhere aside: instant
  // buyout and a hand-to-hand trade on one item differ many times (measured 15.09,
  // Ambu's Charge: 1 chaos against 10). If the requested mode is empty, we say which
  // market answers instead.
  rows.push(text(
    check.fellBackToMode
      ? `nothing in the chosen mode — showing ${MODE_LABEL[check.mode]}`
      : `mode: ${MODE_LABEL[check.mode]}`,
    18,
    check.fellBackToMode ? WARN : MUTED
  ))
  // The set of the player is stated instead of the automatic caveat: "6 mods outside
  // the filter" after a manual edit would not mean what the player did.
  if (check.manualStats) {
    rows.push(text(
      check.manualStats.length
        ? `by ${check.manualStats.length} selected filters`
        : 'no stat filters: base price',
      18,
      check.manualStats.length ? NOTE : WARN
    ))
    // Empty results with selected filters read as "search does not work"
    // (run #101). It is not a fault but a set that is too narrow, and the panel
    // must say so, not the log that the player does not see.
    if (!check.price && check.manualStats.length) {
      rows.push(text('filters narrowed it to nothing — drop some and confirm again', 18, WARN))
    }
  } else if (check.fork === 'search' && check.skippedExplicits) {
    rows.push(text(scopeNote(item, check.skippedExplicits), 18, WARN))
  }

  return frame(rows)
}

// ── filter editor ────────────────────────────────────────────────────────────
//
// The mod list is longer than the screen by definition: a rare item has
// six to eight, each numeric mod has three cursor slots, and the panel has no
// right to cover the whole game. So the list moves as a window around the cursor, and
// what is outside the window is named by a number, not cut silently. Otherwise the
// epic acceptance item "fully reachable from the gamepad" cannot be checked.

/** Editor panel position and font sizes. The final ones are chosen on the live Deck. */
export interface EditorLayout extends Box { title: number, body: number }
export const EDITOR_LAYOUT: EditorLayout = { ...BOX, title: 22, body: 18 }

const boundText = (value?: number): string => value == null ? '-' : rollText(value)

/** The selected value in square brackets, the edited one in angle brackets. ASCII only (ADR 0003, F4). */
const focusMark = (value: string, focused: boolean, editing: boolean): string =>
  focused ? (editing ? `<${value}>` : `[${value}]`) : value

/**
 * A list line: state and mod on the left, bounds or the reason it is unavailable on the right.
 *
 * A name that does not fit in the line wraps to a second one and is not cut: "Trigger
 * Level 20 Death Au..." can be neither read nor compared with the description in the game
 * (tester complaint after runs #101 and #107: "the mod text still does not
 * fit"). The second line is indented under the name and has no tail: the checkbox
 * and the bounds are already in the first one.
 */
function listLines (px: number, width: number, head: string, label: string, tail: string, labelW = width): string[] {
  const room = charBudget(px, labelW) - head.length - tail.length - 2
  if (label.length <= room) return [`${head} ${label} ${tail}`.trim()]

  // Wrap by words: a break in the middle of a word reads worse than a short line.
  const words = label.split(' ')
  let first = ''
  while (words.length && `${first} ${words[0]!}`.trim().length <= room) {
    first = `${first} ${words.shift()!}`.trim()
  }
  if (!first) first = label.slice(0, room) // one word longer than the line is rare, but we do not crash

  // An indent cannot mark the continuation: `fit` collapses spaces (a line break
  // would split the seam command), so a leading space never reaches the screen.
  // The dot is the same character that already separates the title parts, and it
  // says at once that the line does not start a new mod.
  const mark = '· '
  const restRoom = charBudget(px, width) - mark.length
  const rest = words.join(' ') || label.slice(first.length).trim()
  const second = rest.length > restRoom ? `${rest.slice(0, Math.max(1, restRoom - 3)).trimEnd()}...` : rest
  return [`${head} ${first} ${tail}`.trim(), `${mark}${second}`]
}

/**
 * Columns of a mod line with a range: name, min, max, `=`. The bound columns are
 * narrow and always stand at the right edge, not right after the name: a hover zone
 * must lie under its label. Before, the zones were quarters of the line, and
 * `2+ =` came after the name: for a short mod there was nothing over the `=` zone, and
 * min and max fell on the name (run #150). The width fits `<12.5>` and `[=]`.
 */
const BOUND_CHARS = 8
const EXACT_CHARS = 4
function modStops (px: number, width: number): number[] {
  const inner = width - PAD * 2
  const bound = BOUND_CHARS * px * 0.52 / inner
  const exact = EXACT_CHARS * px * 0.52 / inner
  return [0, 1 - exact - bound * 2, 1 - exact - bound, 1 - exact]
}

function modLines (
  row: ModFilter,
  px: number,
  width: number,
  focus: { field?: Slot['kind'], editing: boolean }
): { lines: string[], controls?: string[] } {
  const box = row.unavailable ? '[-]' : row.enabled ? '[x]' : '[ ]'
  if (row.kind === 'range' && !row.unavailable) {
    // The label of an empty bound is always visible, not only under the cursor: a label
    // that appears on hover shifts the line, and the line blinks.
    const bound = (value: number | undefined, name: 'min' | 'max'): string =>
      focusMark(value == null ? name : rollText(value), focus.field === name, focus.editing)
    const labelW = Math.round((width - PAD * 2) * modStops(px, width)[1]!) + PAD * 2
    return {
      lines: listLines(px, width, box, row.label, '', labelW),
      controls: [bound(row.min, 'min'), bound(row.max, 'max'), focusMark('=', focus.field === 'exact', false)]
    }
  }
  const tail = row.unavailable
    ? `(${row.unavailable})`
    : row.kind === 'option'
      ? `variant ${rollText(row.option ?? 0)}`
      // A flag mod has no value, and the checkbox on the left already says everything: the word
      // "yes/no" took nine characters from the name for nothing.
      : ''
  // We do not wrap the checkbox in brackets: it is made of brackets itself, and the selected line
  // is already marked with the bar and the color.
  return { lines: listLines(px, width, box, row.label, tail) }
}

/**
 * Editor frame: what goes to the search and what the player edits right now.
 *
 * `last` is the price already received. While the draft is not applied, it is called
 * previous: attaching the old number to a new filter set means lying about what
 * this price is for. This is an epic requirement, not decoration.
 */
export function editorFrame (
  item: PricedItem,
  editor: Editor,
  layout: EditorLayout = EDITOR_LAYOUT,
  last?: PriceCheck
): string[] {
  return editorView(item, editor, layout, last).lines
}

/** A screen zone with a cursor slot under it. An empty one is a non-clickable line. */
export interface EditorZone { slot: number, x: number, y: number, w: number, h: number }

/**
 * Editor frame together with the hover zones.
 *
 * Zones are needed since the cursor became an input channel: measurement #94
 * showed that the left trackpad moves the pointer on the game server and the right one
 * does not, so the panel has its own pointing device that is not taken from the player.
 * The finger points at a line, a back button acts.
 *
 * A mod line is split horizontally into four zones: checkbox, min, max and `=`, exactly the
 * slots that a button cycled through before. The footer line is confirm
 * and cancel. Unavailable mods and service lines get no zones: there is nothing to do
 * with them, and "pressed and nothing happened" is worse than "cannot point there".
 */
export function editorView (
  item: PricedItem,
  editor: Editor,
  layout: EditorLayout = EDITOR_LAYOUT,
  last?: PriceCheck
): { lines: string[], zones: EditorZone[], box: EditorZone } {
  const all = slots(editor.draft)
  const slot = slotAt(editor)
  const dirty = isDirty(editor)
  const problem = draftProblem(editor.draft)
  const width = layout.w

  const sent = editor.draft.filter(row => row.enabled && row.id).length
  const available = editor.draft.filter(row => row.id).length

  // Two lines instead of three: the price and the filter state live in one. Space on
  // a 7" screen is worth more than symmetry, and there are enough dividers already.
  const status = `searching ${sent} of ${available} · ${dirty ? 'draft' : 'applied'}`
  const head: Row[] = [text(itemTitle(item), layout.title, ACCENT)]
  if (last?.price) {
    head.push(text(
      dirty
        ? `previous ~ ${priceAmountText(last.price)} · ${status}`
        : `~ ${priceAmountText(last.price)}, ${last.league} · ${status}`,
      layout.body,
      dirty ? WARN : VALUE
    ))
  } else {
    head.push(text(status, layout.body, dirty ? WARN : NOTE))
  }
  head.push(rule())

  const foot: Row[] = [rule()]
  // The market has its own line above the buttons: it is part of the question that
  // goes to trade, not a setting somewhere aside. A click on it cycles through
  // the five modes: a dropdown cannot be used with a finger.
  foot.push(text(
    `${focusMark(`mode: ${MODE_LABEL[editor.mode]}`, slot.kind === 'mode', false)}`,
    layout.body,
    slot.kind === 'mode' ? ACCENT : editor.mode === editor.appliedMode ? MUTED : WARN,
    slot.kind === 'mode'
  ))
  const onAction = slot.kind === 'confirm' || slot.kind === 'cancel'
  foot.push(columns(
    [focusMark('confirm', slot.kind === 'confirm', false), focusMark('cancel', slot.kind === 'cancel', false)],
    layout.body,
    onAction ? ACCENT : MUTED,
    onAction
  ))
  if (problem) foot.push(text(`${problem.reason} — cannot search like that`, layout.body, ERROR))
  if (!editor.draft.length) {
    // A form without mods: currency, a map, a key. There is nothing to edit, and it is not a fault.
    foot.push(text('item has no mods — searching by name and base', layout.body, MUTED))
  }

  // How many LINES fit between the header and the footer without going below the screen.
  // We count lines, not mods: a long name takes two, and each group
  // change adds a header.
  const step = lineHeight(layout.body) + GAP
  const room = SCREEN_H - layout.y - PAD * 2 - heightOf([...head, ...foot])
  // Minus two lines: "N more above" and "N more below" take space too.
  const budget = Math.max(2, Math.floor(room / step) - 2)
  // A rough estimate of "how many mods that is" is only needed to aim the window at
  // the selected line; the budget below decides how many really fit.
  const visible = Math.max(1, Math.floor(budget / 1.4))

  // The cursor on confirm does not reset the list to the start: the window holds on to
  // the last mod the player looked at.
  let anchor = 0
  for (let i = Math.min(editor.index, all.length - 1); i >= 0; i--) {
    const seen = all[i]!
    if ('row' in seen) { anchor = seen.row; break }
  }
  let start = Math.max(0, Math.min(anchor - Math.floor(visible / 2), editor.draft.length - visible))

  /** What fits in the line budget, starting from mod `from`. */
  const pick = (from: number): Array<{ index: number, lines: string[], controls?: string[], group?: string }> => {
    const out: Array<{ index: number, lines: string[], controls?: string[], group?: string }> = []
    let used = 0
    let prevType: string | undefined
    for (let i = from; i < editor.draft.length; i++) {
      const row = editor.draft[i]!
      const focused = 'row' in slot && slot.row === i
      const { lines, controls } = modLines(row, layout.body, width, {
        field: focused ? slot.kind : undefined,
        editing: focused && editor.editing
      })
      const group = row.type === prevType ? undefined : groupLabel(row.type)
      const cost = lines.length + (group ? 1 : 0)
      if (out.length && used + cost > budget) break
      out.push({ index: i, lines, controls, group })
      used += cost
      prevType = row.type
    }
    return out
  }

  let shown = pick(start)
  // The selected line must be on the screen: otherwise the cursor goes past the window edge
  // and the finger moves blind.
  // The window then ends on it and does not start with it: the old `start =
  // anchor` on the last mod left it alone and hid the other seven behind
  // "more above" (run #145, Large Cluster Jewel).
  if (!shown.some(entry => entry.index === anchor)) {
    start = anchor
    while (start > 0 && pick(start - 1).some(entry => entry.index === anchor)) start--
    shown = pick(start)
  }

  const list: Row[] = []
  /** The first line of a mod: the hover zones are tied to it. */
  const headRow = new Map<number, Row>()
  if (start > 0) list.push(text(`... ${start} more above`, layout.body, MUTED))
  for (const entry of shown) {
    const row = editor.draft[entry.index]!
    const focused = 'row' in slot && slot.row === entry.index
    if (entry.group) list.push(text(`-- ${entry.group} --`, layout.body, MUTED))
    entry.lines.forEach((line, at) => {
      const color = focused ? ACCENT : row.enabled ? VALUE : MUTED
      const made = at === 0 && entry.controls
        ? columns([line, ...entry.controls], layout.body, color, focused, modStops(layout.body, width))
        : text(line, layout.body, color, focused && at === 0)
      if (at === 0) headRow.set(entry.index, made)
      list.push(made)
    })
  }
  const below = editor.draft.length - (start + shown.length)
  if (below > 0) list.push(text(`... ${below} more below`, layout.body, MUTED))

  const rows = [...head, ...list, ...foot]
  const { lines, spans, height } = laidOutFrame(rows, layout)

  // Zones are computed from THE SAME spans that are drawn: the list row index
  // maps to a span index, not to a separately computed y.
  const textRows: Row[] = rows.filter(row => row.kind === 'text')
  const zones: EditorZone[] = []
  const zoneOf = (row: Row, slot: number, part = 0, parts = 1): void => {
    const at = textRows.indexOf(row)
    const span = spans[at]
    if (!span || slot < 0) return
    const { x, w } = columnSpan(layout, part, parts, row.kind === 'text' ? row.stops : undefined)
    zones.push({ slot, x, y: span.y, w, h: span.height })
  }

  shown.forEach(entry => {
    const index = entry.index
    const row = editor.draft[index]!
    const line = headRow.get(index)
    if (!line || !row.id) return // an unavailable mod has nothing to touch
    const fields: Array<Slot['kind']> = row.kind === 'range'
      ? ['enabled', 'min', 'max', 'exact']
      : ['enabled']
    fields.forEach((field, part) => {
      zoneOf(line, all.findIndex(s => 'row' in s && s.row === index && s.kind === field), part, fields.length)
    })
  })

  const footRows: Row[] = foot.filter(row => row.kind === 'text')
  const [modeRow, actionRow] = footRows
  if (modeRow) zoneOf(modeRow, all.findIndex(s => s.kind === 'mode'))
  if (actionRow) {
    zoneOf(actionRow, all.findIndex(s => s.kind === 'confirm'), 0, 2)
    zoneOf(actionRow, all.findIndex(s => s.kind === 'cancel'), 1, 2)
  }

  // The rectangle of the whole panel, not only of the rows: "the cursor left the panel"
  // is computed by it, otherwise a finger that lands between rows would read as leaving.
  const box: EditorZone = { slot: -1, x: layout.x, y: layout.y, w: layout.w, h: height }
  return { lines, zones, box }
}

/**
 * The slot under the cursor. `null` means the cursor is outside the panel: the selection is NOT reset
 * then (the caller is responsible for that), because the pointer is relative and moves past
 * the panel edge from any extra finger motion.
 */
export function zoneAt (zones: EditorZone[], x: number, y: number): number | null {
  for (const zone of zones) {
    if (x >= zone.x && x < zone.x + zone.w && y >= zone.y && y < zone.y + zone.h) return zone.slot
  }
  return null
}

/**
 * A failure in words for the player. The frame is read in combat, so each failure
 * has three answers: what happened, a detail and **what to do**. Without the last one
 * the player presses a button at random or decides that poe-deck is broken.
 *
 * Only the rate limit has `retryAt`: the moment when trade accepts a request again.
 * The seconds until then are computed when drawing, not stored as a number:
 * otherwise a repeated press would show the old remainder.
 */
export interface Failure {
  title: string
  detail: string
  todo: string
  retryAt?: number
}

/** Seconds until retry, rounded up: "0s" while the window is still open would be a lie. */
export function secondsLeft (retryAt: number, now: number): number {
  return Math.max(1, Math.ceil((retryAt - now) / 1000))
}

/**
 * Failure frame. The title is what happened, below it the detail and one "what to
 * do" line in its own color: the eye looks for it first.
 *
 * The rate limit frame is redrawn on an event (ADR 0003, Decision 3), not on a
 * frame timer: a new press draws it again with a new remainder, and the end of
 * the window replaces it with the `rateLimitOverFrame` frame. There is no stopwatch
 * that ticks once per second, on purpose.
 */
export function errorFrame (failure: Failure, now = Date.now()): string[] {
  const detail = failure.retryAt != null
    ? `${failure.detail}: retry in ${secondsLeft(failure.retryAt, now)}s`
    : failure.detail
  return frame([
    text('price check failed', 24, ERROR),
    rule(),
    text(failure.title, 26, VALUE),
    text(detail, 18, MUTED),
    text(failure.todo, 18, NOTE)
  ])
}

/**
 * The price-check button in the layout template, as a word for the player. The template puts
 * the `POE_DECK_KEYS` chord on the lower left back button (ADR 0002, F17): L3
 * stays with the game, a stick click shows the advanced item text. The contract
 * is held by tools/steam-template.test.ts.
 */
export const PRICE_BUTTON = 'L5'
/** The "hide / bring back" button in the layout template (`POE_DECK_TOGGLE_KEYS`). */
export const TOGGLE_BUTTON = 'L4'

/**
 * First launch after install: one "all ready" frame and which
 * button to press. It is shown once per device; the daemon sets the mark.
 * Without it the first thing the player sees from poe-deck is nothing, and nothing cannot be told
 * apart from "did not install".
 */
export function readyFrame (): string[] {
  return frame([
    text('poe-deck ready', 24, ACCENT),
    rule(),
    text(`select an item and press ${PRICE_BUTTON}`, 22, VALUE),
    text(`${TOGGLE_BUTTON} hides the panel or brings it back`, 18, MUTED),
    text('no price? run poe-deck doctor in Desktop Mode', 18, NOTE)
  ])
}

/** The rate limit window ended while the rate limit frame was on the screen: you can press again. */
export function rateLimitOverFrame (): string[] {
  return frame([
    text('trade is ready again', 24, ACCENT),
    rule(),
    text('the rate limit window is over', 18, MUTED),
    text('press the price-check button again', 18, NOTE)
  ])
}

/** League hint: the config file of the player and the self-check (src/config.ts). */
// Fits in a size-18 line (64 characters): longer, and the advice goes to "...".
// doctor names the full path to the file.
const LEAGUE_TODO = 'fix league in poe-deck.conf or run poe-deck doctor'

/**
 * Failure to words for a human. Different causes need different actions, so
 * "something went wrong" is forbidden here: it cannot be told apart from silence.
 */
export function explainFailure (err: unknown): Failure {
  if (err instanceof RateLimitError) {
    return {
      title: 'trade rate limit',
      // A refusal from our limiter and a refusal from the server ask for the same thing, but
      // the first is politeness and the second is a penalty, and the player benefits from knowing the difference.
      detail: err.source === 'server' ? 'GGG asked to wait' : 'holding requests under the GGG limit',
      todo: 'press again after that — earlier presses are not sent',
      retryAt: err.retryAt
    }
  }
  if (err instanceof MaintenanceError) {
    return {
      title: 'GGG servers are down',
      detail: `pathofexile.com answers ${err.status}: maintenance or a patch`,
      todo: 'not your Wi-Fi — try again when pathofexile.com is back'
    }
  }
  if (err instanceof UnknownLeagueError) {
    return {
      title: 'league not found',
      detail: `"${err.league}" ended or was renamed`,
      todo: LEAGUE_TODO
    }
  }
  if (err instanceof TradeTimeoutError) {
    return {
      title: 'trade did not answer',
      detail: `no reply in ${REQUEST_TIMEOUT_MS / 1000}s`,
      todo: 'press again; if it repeats, check Wi-Fi'
    }
  }
  if (err instanceof TradeHttpError) {
    return {
      title: 'trade server error',
      detail: `pathofexile.com answered HTTP ${err.status}`,
      todo: 'press again in a minute'
    }
  }
  if (err instanceof BlockedHostError) {
    return {
      title: 'request never left',
      detail: `host ${err.host} is not allowlisted`,
      todo: 'this is a poe-deck bug — report it with the daemon log'
    }
  }

  const message = err instanceof Error ? err.message : String(err)

  if (/trade API:/.test(message)) {
    return {
      title: 'trade returned an error',
      detail: message.replace(/^trade API:\s*/, ''),
      todo: 'press again; if it repeats, report the item'
    }
  }
  if (/unable to connect|connection|failed to fetch|fetch failed|dns|getaddrinfo|socket|timeout|network/i.test(message)) {
    return {
      title: 'no network',
      detail: 'cannot reach pathofexile.com',
      todo: 'check Wi-Fi, then press again'
    }
  }
  if (/no tradeable league/.test(message)) {
    return { title: 'league not found', detail: 'pathofexile.com lists no trade league', todo: LEAGUE_TODO }
  }

  return { title: 'request failed', detail: message, todo: 'press again; if it repeats, run poe-deck doctor' }
}
