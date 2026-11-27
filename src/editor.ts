// Search filter editor: the draft, the applied set and the move between them.
//
// Stage 1. There is no input, no drawing and no network here, only the state
// and the allowed transitions. This is because the control scheme on the Deck is
// NOT chosen yet (ADR 0002 holds only the price check): which button moves through the list
// and which one confirms is decided on live hardware. Implementing the actions first
// and the bindings later means not inventing a layout from thin air.
//
// ── Why there are exactly this many actions ────────────────────────────────
//
// The epic acceptance requires: go through the whole mod list, enable and disable a filter,
// set and clear both bounds, confirm the search and cancel the edits. That is the
// minimum: `next`/`prev`/`act`/`clear`/`confirm`/`cancel` plus enter and exit.
// The Deck will not have that many buttons for them: two back buttons are free (the lower right one
// is taken by the `gamepad_fps` template, the lower left one by the price check), and the probe parses
// no more than eight chords. So `confirm` and `cancel` are available in TWO ways:
// as a separate action and as list lines on which `act` works. The scheme with
// two buttons (`next` + `act`) meets all acceptance requirements, and the scheme with
// separate buttons is faster. A run shows which one to choose.
//
// ── What is left out here on purpose ──────────────────────────────────────
//
// Working with the game at the same time (the D-pad keeps controlling PoE), hold
// and auto-repeat, the trade API answer and the memory of the last result are not here. They
// are either properties of the input channel or the work of the daemon.

import {
  copyFilters,
  defaultBound,
  defaultFilters,
  filterProblem,
  filterSignature,
  minRoll,
  toStatFilters,
  type ModFilter
} from './trade/filters'
import {
  DEFAULT_SEARCH_MODE,
  nextSearchMode,
  type PricedItem,
  type SearchMode,
  type StatEntryFilter
} from './trade/query'

/**
 * A search chosen by the player. No `stats` means the automatic set, as on the first
 * button press: this is how the price cache sees it and how the panel labels it.
 */
export interface EditorSearch { stats?: StatEntryFilter[], mode: SearchMode }

export type EditorAction =
  | 'open' | 'close'
  | 'next' | 'prev'
  | 'act' | 'clear'
  | 'confirm' | 'cancel'

/** Where the cursor points. Unavailable mods do not get here: there is nothing to do with them. */
export type Slot =
  | { kind: 'enabled' | 'min' | 'max' | 'exact', row: number }
  | { kind: 'mode' }
  | { kind: 'confirm' }
  | { kind: 'cancel' }

export interface Editor {
  /** The editor panel is on the screen. A closed editor does not lose the draft. */
  open: boolean
  /** The draft: what the player set up. It does not go to the search until confirm. */
  draft: ModFilter[]
  /** The applied set: the price now on the panel was received with it. */
  applied: ModFilter[]
  /**
   * The auto set: the price appeared with it after the button press. Cancel goes back
   * to it: after a confirm there is nothing to roll back to in the applied set, and
   * the player presses cancel to drop their own choice (tester, run #145).
   */
  auto: ModFilter[]
  index: number
  /** Value edit: `next`/`prev` change the number and do not move the cursor. */
  editing: boolean
  /**
   * The search mode of the draft is the fourth market in the trade list, not a setting.
   * Instant buyout and a hand-to-hand trade give prices on one item that differ
   * many times, so the mode is edited in the same place as the filters and applied by the same
   * confirm.
   */
  mode: SearchMode
  /** The mode with which the price now on the panel was received. */
  appliedMode: SearchMode
}

/** A new editor for an item. Each item has its own, the draft does not move over. */
export function newEditor (item: PricedItem, mode: SearchMode = DEFAULT_SEARCH_MODE): Editor {
  const rows = defaultFilters(item)
  return {
    open: false,
    draft: rows,
    applied: copyFilters(rows),
    auto: copyFilters(rows),
    index: 0,
    editing: false,
    mode,
    appliedMode: mode
  }
}

/** Cursor slots for a draft: a range has four, a flag and a variant have one. */
export function slots (draft: ModFilter[]): Slot[] {
  const out: Slot[] = []
  draft.forEach((row, index) => {
    if (!row.id) return // an unavailable mod is shown, but there is nothing in it to turn
    out.push({ kind: 'enabled', row: index })
    if (row.kind === 'range') {
      out.push({ kind: 'min', row: index }, { kind: 'max', row: index }, { kind: 'exact', row: index })
    }
  })
  out.push({ kind: 'mode' }, { kind: 'confirm' }, { kind: 'cancel' })
  return out
}

export function slotAt (editor: Editor): Slot {
  const all = slots(editor.draft)
  return all[Math.min(editor.index, all.length - 1)]!
}

/** The draft differs from the applied set: the price on the panel belongs to the previous one. */
export function isDirty (editor: Editor): boolean {
  return editor.mode !== editor.appliedMode ||
    filterSignature(editor.draft) !== filterSignature(editor.applied)
}

/**
 * The first problem of the draft and the row it lives in. If there is one, confirm
 * does not start the search. The reason and the mod come back apart: on a panel
 * 460 px wide they do not fit in one line, and the mod is visible in the list anyway.
 */
export function draftProblem (draft: ModFilter[]): { reason: string, row: ModFilter } | undefined {
  for (const row of draft) {
    if (!row.enabled || !row.id) continue
    const reason = filterProblem(row)
    if (reason) return { reason, row }
  }
  return undefined
}

/**
 * Both bounds sit exactly on the item roll. The price of many items depends on
 * the exact number, not on "at least": a Mageblood with three flasks costs 110 div,
 * with two it costs 30 (run #148, tester).
 */
export function isExact (row: ModFilter): boolean {
  return row.roll != null && row.min === row.roll && row.max === row.roll
}

/** Bound edit step. A fractional roll is edited by tenths, a whole one by units. */
function step (row: ModFilter): number {
  return row.roll != null && !Number.isInteger(row.roll) ? 0.1 : 1
}

/** The value an edit of an empty bound starts from. */
function seed (row: ModFilter, field: 'min' | 'max'): number {
  const roll = row.roll ?? 0
  return field === 'min' ? minRoll(roll) : roll
}

/** Addition without floating garbage: 20.8 − 0.1 must be 20.7, not 20.699999. */
function shift (value: number, by: number): number {
  return Number((value + by).toFixed(2))
}

function bump (editor: Editor, by: number): Editor {
  const slot = slotAt(editor)
  if (slot.kind !== 'min' && slot.kind !== 'max') return editor

  const draft = copyFilters(editor.draft)
  const row = draft[slot.row]!
  const current = row[slot.kind]
  row[slot.kind] = current == null ? seed(row, slot.kind) : shift(current, by * step(row))
  return { ...editor, draft }
}

function moveBy (editor: Editor, by: number): Editor {
  const total = slots(editor.draft).length
  return { ...editor, index: (editor.index + by + total) % total }
}

function apply (editor: Editor): Editor {
  return { ...editor, applied: copyFilters(editor.draft), appliedMode: editor.mode, editing: false }
}

/**
 * One action of the player to a new state and, if the player confirmed, a filter snapshot
 * for exactly one search. `search: null` means "no request": draft edits
 * and navigation do not spend the trade API rate limit. Cancel after
 * confirm searches the auto set again, but that body is already in the price cache.
 *
 * An invalid draft (min above max) does not start the search: from outside this is visible
 * through `draftProblem`, and a person reads the reason on the panel instead of guessing.
 */
export function reduce (
  editor: Editor,
  action: EditorAction
): { editor: Editor, search: EditorSearch | null } {
  const none = (next: Editor) => ({ editor: next, search: null })

  switch (action) {
    case 'open':
      return none({ ...editor, open: true, editing: false })
    // Hiding does not touch the draft: the player hid the panel, but did not drop the edits.
    case 'close':
      return none({ ...editor, open: false, editing: false })

    case 'next':
      return none(editor.editing ? bump(editor, +1) : moveBy(editor, +1))
    case 'prev':
      return none(editor.editing ? bump(editor, -1) : moveBy(editor, -1))

    case 'act': {
      const slot = slotAt(editor)
      if (slot.kind === 'confirm') return reduce({ ...editor, editing: false }, 'confirm')
      if (slot.kind === 'cancel') return reduce({ ...editor, editing: false }, 'cancel')
      // The mode cycles with one action: a dropdown on a 7" touchscreen
      // cannot be hit, and there are only five modes.
      if (slot.kind === 'mode') return none({ ...editor, mode: nextSearchMode(editor.mode), editing: false })

      // The exact value is one action, not an edit of two bounds: in #148 that
      // cost eight taps. A repeat sets it back to the default `N+`.
      if (slot.kind === 'exact') {
        const draft = copyFilters(editor.draft)
        const row = draft[slot.row]!
        const roll = row.roll ?? 0
        if (row.enabled && isExact(row)) {
          delete row.min
          delete row.max
          Object.assign(row, defaultBound(row))
        } else {
          row.enabled = true
          row.min = roll
          row.max = roll
        }
        return none({ ...editor, draft, editing: false })
      }

      if (slot.kind === 'enabled') {
        const draft = copyFilters(editor.draft)
        const row = draft[slot.row]!
        row.enabled = !row.enabled
        // An enabled range needs a reference point, otherwise the filter just means
        // "this mod is present". The default is the same as in the automatic set.
        if (row.enabled && row.kind === 'range' && row.min == null && row.max == null) {
          Object.assign(row, defaultBound(row))
        }
        return none({ ...editor, draft })
      }

      // A bound is edited in a separate mode: otherwise the same two buttons could not
      // both move through the list and change the number.
      if (!editor.editing) {
        const draft = copyFilters(editor.draft)
        const row = draft[slot.row]!
        if (row[slot.kind] == null) row[slot.kind] = seed(row, slot.kind)
        return none({ ...editor, draft, editing: true })
      }
      return none({ ...editor, editing: false })
    }

    case 'clear': {
      const slot = slotAt(editor)
      if (slot.kind !== 'min' && slot.kind !== 'max') return none(editor)
      const draft = copyFilters(editor.draft)
      delete draft[slot.row]![slot.kind]
      return none({ ...editor, draft, editing: false })
    }

    case 'confirm': {
      if (draftProblem(editor.draft)) return none({ ...editor, editing: false })
      const next = apply(editor)
      return { editor: next, search: { stats: toStatFilters(next.applied), mode: next.appliedMode } }
    }

    case 'cancel': {
      // The draft goes back to the auto set, the market to the applied one: the player selects the market
      // for all items, not for this one (it also moves to the next one).
      const next: Editor = {
        ...editor,
        draft: copyFilters(editor.auto),
        mode: editor.appliedMode,
        editing: false
      }
      // The price on the panel is already for the auto set: no need to search, this is just an edit rollback.
      if (filterSignature(editor.applied) === filterSignature(editor.auto)) return none(next)
      // Otherwise the panel has a price for the set of the player, and after cancel it would lie.
      // The search goes out as automatic (no `stats`): the body is the same as on the first
      // press, and with the same market the price comes from the cache, without a request to trade.
      return { editor: { ...next, applied: copyFilters(editor.auto) }, search: { mode: editor.appliedMode } }
    }
  }
}
