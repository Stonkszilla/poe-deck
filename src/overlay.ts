// The panel as one state: price, editor, failure, nothing, and the transitions between them.
//
// The assembly of the daily scenario. Before this file the daemon itself decided which
// frame to show and knew about timers; now it handles processes, and the decisions
// are made here, without X11, without the network and without a clock, so they are tested
// with plain `bun test`.
//
// ── Why the editor has no "open" button ────────────────────────────────────
//
// The Deck has exactly one free back button (ADR 0002: the lower left one is taken
// by the price check, the lower right one by the `gamepad_fps` template), and it is needed
// for the action. So the editor **opens on hover**: the cursor moves onto
// the panel and the mod list appears, the finger moves away and the panel folds back to
// the price. This costs no buttons at all.
//
// This works because the measurements gave a rare combination: the cursor is moved by the LEFT
// trackpad and only by it (F14), so the panel has its own pointing device that is not taken
// from the game, and PoE ignores the trackpad click anyway (F12).
//
// ── Two timers, and they are about different things ────────────────────────
//
//  - `hideAt`: how long the price stays on the screen (POE_DECK_PANEL_TTL). While the finger
//    is on the panel, it does not tick: we must not hide what a person reads and edits.
//  - `leaveAt`: how long to wait before folding the editor back. Without
//    a delay the panel would collapse from any finger jitter at the edge.

import { newEditor, reduce, slots, type Editor, type EditorSearch } from './editor'
import {
  checkingFrame,
  clearFrame,
  editorFrame,
  editorView,
  errorFrame,
  agoText,
  FLIP_TO_MAP,
  MAIN_PRICE,
  mapCheckFrame,
  noResultFrame,
  priceFrame,
  rateLimitOverFrame,
  zoneAt,
  type EditorLayout,
  type EditorZone,
  type Failure
} from './panel'
import type { PriceCheck } from './price-check'
import type { MapCheck } from './map-check'
import { priceAmountText } from './trade/price'
import { DEFAULT_SEARCH_MODE, type SearchMode } from './trade/query'
import { toStatFilters } from './trade/filters'
import type { PricedItem } from './trade/query'

export type OverlayMode = 'idle' | 'checking' | 'price' | 'editor' | 'error' | 'notice' | 'map'

export interface Overlay {
  mode: OverlayMode
  item?: PricedItem
  check?: PriceCheck
  editor?: Editor
  /** When to hide the panel, ms. `0` means no deadline (the next frame replaces it). */
  hideAt: number
  /** When to fold the editor back to the price. `0` means the cursor is on the panel. */
  leaveAt: number
  /**
   * Where the value edit counts from: the cursor Y at the moment the edit started.
   * In edit mode the finger does not select a line, it turns the number like a wheel.
   */
  grabY?: number
  /** Where the cursor was the last time. The edit reference point comes from here. */
  lastY?: number
  /**
   * The default market for a new item. The mode is edited in the editor, but
   * the next item starts with what the daemon selected, not with the factory default:
   * the player selects the market once per session, not for each item.
   */
  priceMode: SearchMode
  /**
   * The last finished result of the session. It is kept when the panel is hidden,
   * by the gesture or by the deadline, so that it can be brought back to the screen without a new
   * request to trade (a required action of the epic).
   */
  last?: LastResult
  /**
   * The player hid the panel. A late answer to a search already in progress does not open it:
   * hidden means the player looks at the game now, not at the price.
   */
  hidden?: boolean
  /**
   * The failure on the screen. It is kept for the rate limit: the end of its window is the event
   * on which the frame changes to "you can press again".
   */
  failure?: Failure
  /** The map check on the screen. */
  map?: MapCheck
}

/** A finished price result: what was shown, with which set and when. */
export interface PriceResult {
  item: PricedItem
  check: PriceCheck
  editor: Editor
  /** When it was received. The age goes to the panel: a price without a time is a promise. */
  at: number
  /**
   * The map check of the same item, when this is the price of a map. It is kept
   * with the price, not beside it: L4 and the timeout clear the panel, and the next L5
   * must still be able to flip back to the map check without reading the map again.
   */
  map?: MapResult
}

/**
 * A finished map check. It is a result like a price: L4 hides it and brings it back,
 * and bringing back the price of the item before the map instead would show a
 * foreign answer under the gesture "show what I just saw".
 */
export interface MapResult {
  map: MapCheck
  at: number
  /** The price of the same map, once asked for with a second L5. The next flip shows it without a request. */
  price?: PriceResult
}

export type LastResult = PriceResult | MapResult

/** A price result always has the item; a map result never has it (a price can carry `map`). */
export const isMapResult = (last: LastResult): last is MapResult => !('item' in last)

/**
 * What a second L5 on the same map does, decided from the panel state:
 *
 * - `fetch`: the map check is on the screen and its price was never asked for — one trade request;
 * - `flip`: the other view of the same map is already known — no request;
 * - `wait`: the price of the map is on its way — the press would only race the answer;
 * - `recall`: the panel is not on the screen, or the item is not a map — bring back the last result, as before.
 *
 * A hidden panel recalls instead of flipping: after L4 the player asks "what did I see", not "show the other side".
 */
export type FlipAction = 'fetch' | 'flip' | 'wait' | 'recall'

export function flipOf (overlay: Overlay): FlipAction {
  const last = overlay.last
  if (!last) return 'recall'
  if (isMapResult(last)) {
    if (overlay.mode === 'map') return last.price ? 'flip' : 'fetch'
    if (overlay.mode === 'checking') return 'wait'
    return 'recall'
  }
  if (last.map && (overlay.mode === 'price' || overlay.mode === 'editor')) return 'flip'
  return 'recall'
}

/** The price frame of the current result, with the flip hint when it is the price of a map. */
function priceFrameOf (item: PricedItem, check: PriceCheck, last: LastResult | undefined, previousMs?: number): string[] {
  const ofMap = last && !isMapResult(last) && last.item === item && last.map
  return priceFrame(item, check, previousMs, MAIN_PRICE, ofMap ? FLIP_TO_MAP : undefined)
}

export interface OverlayTimes {
  /** How long the price lives on the screen without a finger. */
  ttlMs: number
  /** How long to wait after the cursor leaves before folding the editor. */
  leaveMs: number
  /** How many pixels of finger motion make one value step. */
  pxPerStep?: number
}

export const DEFAULT_TIMES: OverlayTimes = { ttlMs: 15_000, leaveMs: 1_200, pxPerStep: 14 }

export type OverlayEvent =
  | { kind: 'checking', item: PricedItem }
  /** `map`: this is the price of the map whose check was on the panel. */
  | { kind: 'price', item: PricedItem, check: PriceCheck, map?: MapResult }
  /** A copied map with mods: the map check instead of the price, no trade request. */
  | { kind: 'map', map: MapCheck }
  /**
   * `press` is a failure on the L5 press itself, not a late search answer: the player just
   * asked for the panel, and the earlier "hidden with the gesture" does not mute it.
   */
  | { kind: 'failure', failure: Failure, press?: boolean }
  | { kind: 'pointer', x: number, y: number }
  | { kind: 'act' }
  /** The second gesture: hide the panel or bring back the last result, without a request. */
  | { kind: 'toggle' }
  /**
   * A second L5 on the same map whose other view is already known (`flipOf` → `flip`):
   * map check → price or price → map check, without a request.
   */
  | { kind: 'flip' }
  /**
   * L5 on the same clipboard that already has a result: show it, like
   * the L4 recall, without a request. No new item means no new question to trade either.
   */
  | { kind: 'recall' }
  | { kind: 'focus', inGame: boolean }
  /** A daemon message not tied to an item: the "ready" frame of the first launch. */
  | { kind: 'notice', frame: string[] }
  | { kind: 'tick' }

export interface OverlayStep {
  overlay: Overlay
  /** The frame, if it changed. None means there is nothing to redraw. */
  frame?: string[]
  /** The confirmed set: filters and market mode, for exactly one search. */
  search?: EditorSearch
}

export const newOverlay = (mode: SearchMode = DEFAULT_SEARCH_MODE): Overlay =>
  ({ mode: 'idle', hideAt: 0, leaveAt: 0, priceMode: mode })

/**
 * The last result back on the panel: the same item, the same set, the age.
 * Shared by L4 and a repeated L5, so that the two recall paths do not drift apart.
 */
function restore (overlay: Overlay, last: LastResult, now: number, times: OverlayTimes): OverlayStep {
  if (isMapResult(last)) {
    return {
      overlay: {
        mode: 'map',
        map: last.map,
        hideAt: now + times.ttlMs,
        leaveAt: 0,
        priceMode: overlay.priceMode,
        last,
        hidden: false
      },
      frame: mapCheckFrame(last.map, Math.max(0, now - last.at))
    }
  }
  return {
    overlay: {
      mode: 'price',
      item: last.item,
      check: last.check,
      editor: last.editor,
      hideAt: now + times.ttlMs,
      leaveAt: 0,
      priceMode: overlay.priceMode,
      last,
      hidden: false
    },
    frame: priceFrameOf(last.item, last.check, last, Math.max(0, now - last.at))
  }
}

/** The editor frame and its geometry in one call, so that they do not drift apart. */
function view (overlay: Overlay, layout?: EditorLayout): { lines: string[], zones: EditorZone[], box: EditorZone } {
  return editorView(overlay.item!, overlay.editor!, layout, overlay.check)
}

/**
 * Event to a new panel state.
 *
 * `now` comes from outside: the clock is also the outside world, and without it the transitions
 * are checked by a test, not by a run on hardware.
 */
export function step (
  overlay: Overlay,
  event: OverlayEvent,
  now: number,
  times: OverlayTimes = DEFAULT_TIMES,
  layout?: EditorLayout
): OverlayStep {
  switch (event.kind) {
    case 'checking':
      // A price-check press is itself a panel recall: the player looks at the price.
      return {
        overlay: {
          mode: 'checking',
          item: event.item,
          hideAt: 0,
          leaveAt: 0,
          priceMode: overlay.priceMode,
          last: overlay.last
        },
        frame: checkingFrame(event.item)
      }

    case 'price': {
      // A new item means a new draft: filters of the previous item do not carry over
      // (epic requirement). The same item after confirm keeps the editor
      // state, otherwise the edits would disappear together with the answer.
      const same = overlay.item === event.item && overlay.editor
      const editor = same ? overlay.editor! : newEditor(event.item, overlay.priceMode)
      const next: Overlay = {
        mode: overlay.mode === 'editor' ? 'editor' : 'price',
        item: event.item,
        check: event.check,
        editor,
        hideAt: overlay.mode === 'editor' ? 0 : now + times.ttlMs,
        leaveAt: overlay.mode === 'editor' ? overlay.leaveAt : 0,
        // The market selected by the player survives the answer and moves to the next
        // item: selecting it again for each item is work, not a setting.
        priceMode: editor.appliedMode
      }
      // The map stays with its price through a filtered search on the same item: a confirm
      // in the editor asks again about the same map, and the flip back must survive it.
      const before = overlay.last && !isMapResult(overlay.last) && overlay.last.item === event.item ? overlay.last.map : undefined
      const last: PriceResult = { item: event.item, check: event.check, editor, at: now, map: event.map ?? before }

      // A late answer to a search that the player already "cancelled" with the gesture: we
      // remember the result, but do not raise the panel by ourselves (epic requirement).
      if (overlay.hidden) {
        return { overlay: { ...newOverlay(overlay.priceMode), last, hidden: true } }
      }

      return {
        overlay: { ...next, last },
        frame: next.mode === 'editor'
          ? view(next, layout).lines
          : priceFrameOf(event.item, event.check, last)
      }
    }

    case 'map': {
      // A press, like `checking`: the player asked for the panel, so an earlier
      // hide does not mute it. Nothing to edit and no network: the frame is final.
      const last: MapResult = { map: event.map, at: now }
      return {
        overlay: { mode: 'map', map: event.map, hideAt: now + times.ttlMs, leaveAt: 0, priceMode: overlay.priceMode, last },
        frame: mapCheckFrame(event.map)
      }
    }

    case 'failure':
      if (overlay.hidden && !event.press) return { overlay }
      return {
        overlay: {
          mode: 'error',
          hideAt: now + times.ttlMs,
          leaveAt: 0,
          priceMode: overlay.priceMode,
          last: overlay.last,
          failure: event.failure
        },
        frame: errorFrame(event.failure, now)
      }

    case 'pointer': {
      if (!overlay.item || !overlay.editor) return { overlay }
      if (overlay.mode !== 'price' && overlay.mode !== 'editor') return { overlay }

      // Bound edit: the finger turns the number and does not select a line. The panel
      // does not fold even if the cursor went past its edge, otherwise
      // the value could not be turned all the way.
      if (overlay.editor.editing) {
        const px = times.pxPerStep ?? 14
        const from = overlay.grabY ?? event.y
        const steps = Math.trunc((from - event.y) / px) // up means more
        if (!steps) return { overlay }
        const editor = Array.from({ length: Math.abs(steps) })
          .reduce<Editor>(state => reduce(state, steps > 0 ? 'next' : 'prev').editor, overlay.editor)
        const next: Overlay = {
          ...overlay, editor, grabY: from - steps * px, lastY: event.y, hideAt: 0, leaveAt: 0
        }
        return { overlay: next, frame: view(next, layout).lines }
      }

      const { zones, box } = view(overlay, layout)
      const onPanel = event.x >= box.x && event.x < box.x + box.w &&
                      event.y >= box.y && event.y < box.y + box.h

      if (!onPanel) {
        // The cursor left: we do not fold at once. With a relative pointer (F14)
        // any extra finger motion touches the panel edge.
        if (overlay.mode !== 'editor' || overlay.leaveAt) return { overlay: { ...overlay, lastY: event.y } }
        return { overlay: { ...overlay, lastY: event.y, leaveAt: now + times.leaveMs } }
      }

      const slot = zoneAt(zones, event.x, event.y)
      const editor: Editor = {
        ...overlay.editor,
        open: true,
        index: slot ?? overlay.editor.index
      }
      const next: Overlay = { ...overlay, mode: 'editor', editor, lastY: event.y, hideAt: 0, leaveAt: 0 }

      // Redraw only when something changed: the cursor moves
      // dozens of times per second, and there is no reason to send a frame on each motion.
      const changed = overlay.mode !== 'editor' || editor.index !== overlay.editor.index
      return changed ? { overlay: next, frame: view(next, layout).lines } : { overlay: next }
    }

    case 'act': {
      if (overlay.mode !== 'editor' || !overlay.editor) return { overlay }
      const done = reduce(overlay.editor, 'act')
      // Edit entry: from here the finger turns the value, and the count starts at the point
      // where it was at this moment. Exit is the same button, the reference point is reset.
      const next: Overlay = {
        ...overlay,
        editor: done.editor,
        grabY: done.editor.editing ? overlay.lastY ?? 0 : undefined
      }
      if (!done.search) return { overlay: next, frame: view(next, layout).lines }

      // Confirm: the panel honestly says "checking price", and the search goes out.
      // The item stays the same, so the draft survives the answer.
      return {
        overlay: { ...next, mode: 'checking', hideAt: 0, leaveAt: 0 },
        frame: checkingFrame(overlay.item!),
        search: done.search
      }
    }

    case 'toggle': {
      // The panel is on the screen: hide it. The last result is not lost:
      // the same gesture brings it back.
      if (overlay.mode !== 'idle') {
        return {
          overlay: { ...newOverlay(overlay.priceMode), last: overlay.last, hidden: true },
          frame: clearFrame()
        }
      }

      // Recall. There is no new request and there must not be one: we show exactly what
      // was already received, together with the age and the filter set it was
      // received with.
      // Nothing to bring back: a hint instead of silence. This is a message, not
      // a price: it lives as long as the ready frame and is hidden by the same L4.
      const last = overlay.last
      if (!last) {
        return {
          overlay: { ...newOverlay(overlay.priceMode), mode: 'notice', hideAt: now + times.ttlMs },
          frame: noResultFrame()
        }
      }

      return restore(overlay, last, now, times)
    }

    case 'recall': {
      // The same item on L5 after L4 was silent: the clipboard did not change, and the
      // "game did not copy" failure was muted by the hidden panel (rc6, remark 15).
      // We show the same thing L4 would bring back, with the age, so that an old price
      // cannot be taken for a fresh one. Without a result there is nothing to show: the daemon
      // does not send such an event.
      const last = overlay.last
      if (!last) return { overlay }
      return restore(overlay, last, now, times)
    }

    case 'flip': {
      // The other view of the same map, both already known: no request.
      // The price keeps its age — the market moved since. The map check does not:
      // its mods do not change, and "previous result" on it would read as a warning.
      if (flipOf(overlay) !== 'flip') return { overlay }
      const last = overlay.last!
      if (isMapResult(last)) {
        return restore(overlay, { ...last.price!, map: { map: last.map, at: last.at } }, now, times)
      }
      const { map, ...price } = last as PriceResult
      const back: MapResult = { ...map!, price }
      return {
        overlay: { mode: 'map', map: back.map, hideAt: now + times.ttlMs, leaveAt: 0, priceMode: overlay.priceMode, last: back },
        frame: mapCheckFrame(back.map)
      }
    }

    case 'notice':
      // A message does not interrupt a price or an edit: a player who already presses
      // the button knows that poe-deck works. A panel hidden with the gesture also
      // stays hidden. The message lives as long as the price and is hidden
      // by the same L4.
      if (overlay.mode !== 'idle' || overlay.hidden) return { overlay }
      return {
        overlay: { ...newOverlay(overlay.priceMode), last: overlay.last, mode: 'notice', hideAt: now + times.ttlMs },
        frame: event.frame
      }

    case 'focus':
      if (event.inGame) return { overlay }
      // Outside PoE there is no panel at all: it must not hang over
      // the Steam interface (overlay spike, exp. 6).
      return { overlay: { ...newOverlay(overlay.priceMode), last: overlay.last }, frame: clearFrame() }

    case 'tick': {
      // The rate limit window ended while its frame is on the screen: "retry in 42s" without
      // a redraw would stay there, although the player can press already. This is a state change,
      // not a stopwatch: the frame goes out once, and the hide deadline starts again.
      const retryAt = overlay.failure?.retryAt
      if (overlay.mode === 'error' && retryAt != null && now >= retryAt) {
        return {
          overlay: { ...overlay, failure: undefined, hideAt: now + times.ttlMs },
          frame: rateLimitOverFrame()
        }
      }
      if (overlay.mode === 'editor' && overlay.leaveAt && now >= overlay.leaveAt) {
        const next: Overlay = { ...overlay, mode: 'price', leaveAt: 0, hideAt: now + times.ttlMs }
        return { overlay: next, frame: priceFrameOf(overlay.item!, overlay.check!, overlay.last) }
      }
      if (overlay.hideAt && now >= overlay.hideAt) {
        // The deadline passed: the panel goes out, but the result can still be brought back:
        // hiding on a timer is not the same as "the player hid it".
        return { overlay: { ...newOverlay(overlay.priceMode), last: overlay.last }, frame: clearFrame() }
      }
      return { overlay }
    }
  }
}

/**
 * What the gesture did, as a log line. `describe` tells only about the panel
 * state, and with it you cannot tell "the previous result came back" from "the panel
 * already had a price": in run #121 eleven L4 presses gave `toggle: price` and
 * `toggle: idle`, and no proof of a recall was left. The epic acceptance requires
 * ten cycles, so a cycle must be visible in the log.
 */
export function describeToggle (before: Overlay, after: Overlay, now: number): string {
  if (after.mode === 'idle') {
    if (before.mode === 'idle') return 'nothing to hide'
    // Hiding during a search is a separate acceptance case: exactly after it a late
    // answer must not raise the panel back. By the bare `hidden` it cannot be told apart from
    // a normal hide (run #125).
    return before.mode === 'checking' ? 'hidden during a search' : 'hidden'
  }
  const last = after.last
  if (!last) return before.mode === 'idle' ? 'nothing to hide — hint shown' : `restored ${after.mode}`
  const age = agoText(Math.max(0, now - last.at))
  if (isMapResult(last)) return `restored map check ${last.map.name ?? last.map.base}, age ${age}`
  const name = last.item.info.name ?? last.item.info.refName
  const price = last.check.price ? priceAmountText(last.check.price) : 'no price'
  return `restored ${name}: ${price}, age ${age}`
}

/** A log line about what is on the panel now. For runs on hardware. */
export function describe (overlay: Overlay): string {
  if (overlay.mode !== 'editor' || !overlay.editor) return overlay.mode
  const all = slots(overlay.editor.draft)
  const slot = all[Math.min(overlay.editor.index, all.length - 1)]
  const where = slot && 'row' in slot ? `mod ${slot.row + 1}, ${slot.kind}` : slot?.kind ?? '—'
  return `editor: ${where}, filters ${toStatFilters(overlay.editor.draft).length}`
}

/** The frame of the current state. Needed when the frame is lost, for example when the renderer restarted. */
export function currentFrame (overlay: Overlay, layout?: EditorLayout): string[] {
  if (overlay.mode === 'editor' && overlay.item && overlay.editor) return view(overlay, layout).lines
  if (overlay.mode === 'price' && overlay.item && overlay.check) return priceFrameOf(overlay.item, overlay.check, overlay.last)
  if (overlay.mode === 'checking' && overlay.item) return checkingFrame(overlay.item)
  if (overlay.mode === 'map' && overlay.map) return mapCheckFrame(overlay.map)
  if (overlay.mode === 'error' && overlay.failure) return errorFrame(overlay.failure)
  return clearFrame()
}

export { editorFrame }
