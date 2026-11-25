// The mods of an item as a list of filters that the player can control.
//
// Before this file, the query contents were a function of the item: `statFilters`
// decided for the player which mods went into the search, and nothing could correct that choice.
// On Impresence this gave two filters, six mods outside the query and one
// listing at 40 chaos: the price of the base, shown as the price of this specific item.
//
// Here the same choice becomes the **initial setting**: each recognised
// mod shows as a row, and the row has the actual roll, a search participation state
// and min/max bounds. The automatic defaults do not change (see `defaultEnabled`),
// so a query without edits by the player stays the same as before this file:
// `statFilters` is now expressed through these defaults, not through a separate rule.
//
// The default rules come from the donor as an idea, no code is borrowed:
// SnosMe/awakened-poe-trade (MIT), `create-stat-filters.ts:98-103`, `percentRoll`.

import { isMapItem, type PricedItem, type StatEntryFilter } from './query'

/** How many percent of the roll to subtract for the filter min. Donor default. */
export const SEARCH_RANGE_PERCENT = 10

/**
 * How a mod is edited. A flag and a variant must not get an invented numeric range:
 * on trade the first has no value at all, and for the second it is a choice, not an interval.
 */
export type ModKind = 'range' | 'flag' | 'option'

export interface ModFilter {
  /** Filter id on trade. If absent, there is nothing to search this mod by. */
  id?: string
  /**
   * The same mod under the other trade types. The clipboard names one type, the trade
   * index can keep the mod under another one; see `tradeIds` below.
   */
  altIds?: string[]
  /** Why the mod is not available for search. Present exactly when `id` is absent. */
  unavailable?: string
  /** Mod text with the actual roll filled in: what the player reads. */
  label: string
  /** Donor ModifierType: explicit | implicit | enchant | fractured | crafted | … */
  type: string
  tier?: number
  kind: ModKind
  /** Actual roll on the item. A flag has none. */
  roll?: number
  /** Mod variant for `kind: 'option'`: on trade this is a choice, not an interval. */
  option?: number
  enabled: boolean
  min?: number
  max?: number
}

/**
 * Fixed defence properties: armour, evasion, energy shield, ward, block.
 *
 * The donor keeps them as a separate layer: they are not mods but item properties, and on
 * trade they live not in `stats` but in `query.filters.armour_filters`
 * (`pathofexile-trade.ts:452-473`). Internally the donor calls them pseudo stats
 * `item.armour`, `item.evasion_rating`, … We take the same name, so that the editor
 * row and the query field have the same name.
 *
 * Why they are in the editor: for armour with a good base, the price depends on the ES or
 * armour number, not on mods, and without these rows there was no way to search by them
 * (tester complaint after run #107: "fixed item stats, search by them is also possible").
 */
const PROPERTIES: Array<{ id: string, label: string, of: (item: PricedItem) => number | undefined }> = [
  { id: 'item.armour', label: 'Armour', of: item => item.armourAR },
  { id: 'item.evasion_rating', label: 'Evasion Rating', of: item => item.armourEV },
  { id: 'item.energy_shield', label: 'Energy Shield', of: item => item.armourES },
  { id: 'item.ward', label: 'Ward', of: item => item.armourWARD },
  { id: 'item.block', label: 'Chance to Block', of: item => item.armourBLOCK }
]

/** The quality percent that trade applies to the physical damage of a weapon. */
const DPS_QUALITY = 20

/**
 * Physical damage per hit, normalised to 20% quality. Trade calculates `pdps`
 * exactly this way: measurement on 09.11 on a Vaal Axe with 3% quality: `226-373` at 1.30 attacks
 * per second give 389 by the clipboard and 453.7 in `extended.pdps` of trade, exactly ×120/103.
 * Without the correction, the filter bound on an item below 20% quality would be lower than
 * the value trade calculates for the same item, and would catch weaker weapons.
 *
 * Quality and local "increased Physical Damage" add up into one multiplier,
 * so their sum both divides and multiplies. The idea is `propAt20Quality` of the donor
 * (`parser/calc-q20.ts:47-65`), the code is our own.
 */
export function physicalAtQ20 (item: PricedItem): number | undefined {
  if (item.weaponPHYSICAL == null) return undefined
  const quality = item.quality ?? 0
  if (quality >= DPS_QUALITY) return item.weaponPHYSICAL

  const increased = item.statsByType
    .filter(calc => calc.stat.ref === '#% increased Physical Damage')
    .reduce((sum, calc) => sum + (rollValue(calc.sources) ?? 0), 0)
  return item.weaponPHYSICAL * (100 + increased + DPS_QUALITY) / (100 + increased + quality)
}

/** To tenths: trade shows dps the same way. */
function dpsValue (value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Average chaos damage per hit from the clipboard line `Chaos Damage: 98-120`. The donor parser
 * does not parse this line (`Parser.ts`, `parseWeapon`), but trade counts chaos in `dps`.
 * Measurement on 09.11, Rebuke of the Vaal: `pdps 304.41 + edps 391.28` and chaos
 * 91-140 at 1.46 attacks per second give exactly `dps 864.32` of trade.
 */
export function chaosPerHit (item: PricedItem): number | undefined {
  const match = /^Chaos Damage: (\d+)-(\d+)/m.exec(item.rawText ?? '')
  if (!match) return undefined
  return (Number(match[1]) + Number(match[2])) / 2
}

/**
 * Weapon dps rows. Order and conditions are as in the donor (`item-property.ts:145-210`):
 * `Total DPS` only for a weapon with two or more damage kinds, otherwise it equals
 * the single one and duplicates its row. Elemental damage is not normalised to quality:
 * trade does not normalise it either (`edps` in the same measurement equals the clipboard).
 *
 * The difference from the donor is chaos: in the donor `Total DPS` is physical plus elemental, in trade
 * `dps` also includes chaos. Trade has no separate chaos filter, so chaos
 * goes only into `Total DPS`.
 */
function weaponFilters (item: PricedItem): Array<{ id: string, label: string, value: number }> {
  if (!item.weaponAS) return []
  const pdps = physicalAtQ20(item)
  const edps = item.weaponELEMENTAL
  const cdps = chaosPerHit(item)
  const kinds = [pdps, edps, cdps].filter(value => value != null)
  const rows: Array<{ id: string, label: string, value: number }> = []

  if (kinds.length > 1) {
    const total = kinds.reduce((sum, value) => sum + value, 0)
    rows.push({ id: 'item.total_dps', label: 'Total DPS', value: dpsValue(total * item.weaponAS) })
  }
  if (pdps != null) rows.push({ id: 'item.physical_dps', label: 'Physical DPS (Q20)', value: dpsValue(pdps * item.weaponAS) })
  if (edps != null) rows.push({ id: 'item.elemental_dps', label: 'Elemental DPS', value: dpsValue(edps * item.weaponAS) })
  return rows
}

/**
 * Categories where the item level does not set the price or means something else.
 * The list is from the donor (`create-item-filters.ts:347-358`): for a map it is the tier, for
 * a normal jewel the affix pool does not depend on level, blueprints, atlas charts
 * and relics have their own zone level.
 */
const NO_ILVL = new Set([
  'Map', 'Jewel', 'Heist Blueprint', 'Heist Contract', 'Chart', 'Memory Line',
  'Sanctum Relic', 'Charm', 'Idol'
])

/** Flasks: the level exists, but it barely moves the price, so the row is visible but off. */
const ILVL_OFF = new Set(['Flask', 'Tincture'])

/** Above 86 the level unlocks no new mods: 86 and 100 are one market (donor rule). */
const ILVL_CAP = 86

/**
 * Item level as a `properties` row → `misc_filters.ilvl` of trade (tester:
 * "ilvl on gear is an important aspect"). Absent for uniques (their level does not
 * change the price, and the donor does not set it either) and for categories in `NO_ILVL`.
 *
 * Whether it is on is decided by `defaultFilters` from the rest of the set, not by this function:
 * in the donor the row turns on in base search mode (`opts.exact`), for us it is
 * the same case: no mod is in the filter, and the price comes from the base. Then
 * ilvl 86 and ilvl 70 are different bases and different money. When mods are in the filter, they
 * already tell more about the item than the level does.
 */
function itemLevelFilter (item: PricedItem): ModFilter | undefined {
  if (!item.itemLevel || item.rarity === 'Unique') return undefined
  if (isMapItem(item) || (item.category && NO_ILVL.has(item.category))) return undefined
  // Outside equipment (currency, divination cards, gems) the clipboard has no level at all,
  // so this row is stopped by the first check.

  const cluster = item.category === 'Cluster Jewel'
  const value = cluster ? floorToBracket(item.itemLevel, [1, 50, 68, 75, 84]) : Math.min(item.itemLevel, ILVL_CAP)
  return {
    id: 'item.ilvl',
    label: `Item Level ${item.itemLevel}`,
    type: 'property',
    kind: 'range',
    roll: value,
    // The bound is the level itself, not roll minus 10% as for a mod: "ilvl from 66" for
    // an item of level 74 is a different market. The editor sets `minRoll` only on an empty row,
    // so the bound is set here, and a row turned on at the Deck goes out as is.
    min: value,
    enabled: false,
    // Cluster jewel: the number of passives depends on the level bracket, and the upper bound
    // of the bracket is as much a part of the description as the lower one (donor: `ceilToBracket`).
    ...(cluster ? { max: ceilToBracket(item.itemLevel, [100, 74, 67, 49]) } : {})
  }
}

/** The largest step that does not exceed the value. */
function floorToBracket (value: number, brackets: number[]): number {
  return brackets.filter(step => step <= value).at(-1) ?? brackets[0]!
}

/** The smallest step (the list is in descending order) that is not less than the value. */
function ceilToBracket (value: number, brackets: number[]): number {
  return brackets.filter(step => step >= value).at(-1) ?? brackets[0]!
}

/**
 * Item property rows: defence for armour and shields, dps for weapons. For everything else
 * the list is empty. All are off: a property that is on changes the meaning of the query, and that is
 * the decision of the player.
 */
function propertyFilters (item: PricedItem): ModFilter[] {
  const weapon = weaponFilters(item).map(row => ({
    id: row.id,
    label: `${row.label} ${rollText(row.value)}`,
    type: 'property',
    kind: 'range' as ModKind,
    roll: row.value,
    enabled: false
  }))

  return [...weapon, ...PROPERTIES.flatMap(prop => {
    const value = prop.of(item)
    if (value == null) return []
    return [{
      id: prop.id,
      label: `${prop.label} ${rollText(value)}`,
      type: 'property',
      kind: 'range' as ModKind,
      roll: value,
      enabled: false
    }]
  })]
}

/**
 * Group order in the editor. Properties go on top, because they are about the item itself; then comes what
 * the player reads in the description, in the same order in which PoE prints it.
 * The grouping is visual and does not affect the query: the panel draws a header where
 * the type changes, and for this the list must be sorted here, not in the panel.
 */
const GROUP_ORDER = ['property', 'enchant', 'implicit', 'fractured', 'explicit', 'crafted']

/** Group labels in the editor. A type that is not here is shown as is. */
const GROUP_LABEL: Record<string, string | undefined> = {
  property: 'properties',
  enchant: 'enchant',
  implicit: 'implicit',
  fractured: 'fractured',
  explicit: 'explicit',
  crafted: 'crafted'
}

export function groupLabel (type: string): string {
  return GROUP_LABEL[type] ?? type
}

export function groupRank (type: string): number {
  const at = GROUP_ORDER.indexOf(type)
  return at === -1 ? GROUP_ORDER.length : at
}

/** Total roll of a mod across all sources: `statSourcesTotal(sources, 'sum')` of the donor. */
export function rollValue (sources: PricedItem['statsByType'][number]['sources']): number | undefined {
  if (sources.every(source => !source.contributes)) return undefined
  return sources.reduce((sum, source) => sum + (source.contributes?.value ?? 1), 0)
}

/** Roll minus 10%, rounded down. Integers stay integers, fractions are cut to hundredths. */
export function minRoll (value: number): number {
  const lowered = value - Math.abs(value) * SEARCH_RANGE_PERCENT / 100
  return Number.isInteger(value)
    ? Math.floor(lowered)
    : Math.floor((lowered + Number.EPSILON) * 100) / 100
}

/** A number for a human: an integer stays an integer, a fraction is cut to hundredths. */
export function rollText (value: number): string {
  return String(Number(value.toFixed(2)))
}

/**
 * Mod with the roll filled in. In the donor `stat.ref` contains `#`: one for a normal
 * mod, two for "Adds # to # Physical Damage". We fill in only when there is one place:
 * otherwise the sum of two numbers spread over two places would lie twice.
 */
export function modLabel (ref: string, roll?: number): string {
  if (roll === undefined) return ref
  const places = ref.split('#').length - 1
  return places === 1 ? ref.replace('#', rollText(roll)) : `${ref} — ${rollText(roll)}`
}

/**
 * Initial search participation of a mod. The donor defaults live here and only here:
 *
 *   1. from explicit, only top tiers (≤ 2) go into the filter; otherwise six mods
 *      of a rare item narrow down to exactly one listing, the item itself;
 *   2. the other types (implicit, enchant, fractured, crafted) go in fully;
 *   3. **for a unique, nothing is turned on.**
 *
 * Rule 3 cost two runs. A unique item is identified unambiguously by its
 * name, and trade indexes its innate mods under a DIFFERENT type than the one
 * the clipboard uses: a mod that the item description shows as implicit lives on trade
 * as explicit, and `implicit.stat_…` finds nothing. In run #104
 * Ambu's Charge and Soul Mantle both went empty silently this way: both "with mods (1 in
 * filter)" and both "no listings", with a correct league and a live trade.
 *
 * The donor comes to the same result from the other side: for a unique, `hideNotVariableStat`
 * hides and turns off a filter without a roll range, and the innate mods of a unique
 * are exactly the constant ones (`create-stat-filters.ts:371-385`).
 *
 * Off does not mean lost: in the editor they are all in place, and the player
 * turns them on when the price by name does not suit them.
 */
function defaultEnabled (
  type: string,
  kind: ModKind,
  tier: number | undefined,
  unique: boolean,
  map: boolean
): boolean {
  // Map mods are zone modifiers ("Monsters deal 102% extra Physical
  // Damage as Cold"), and a search by them makes no sense: a map is priced by tier and, sometimes,
  // by a few key mods that the player selects. Run #115: nine
  // mods turned on gave zero on every map.
  //
  // The exception is an implicit without a number. It is not a zone modifier, but WHAT the map is:
  // whose influence is on it and who occupies it. An Elder guardian map has `Area is influenced
  // by The Elder` and `Map is occupied by The Enslaver`, a Conqueror map has `Map
  // contains Baran's Citadel`, and both have the same base `Map (Tier 16)` as a normal
  // map. Without these rows in the query, a guardian map gets the price of any T16. Measurement on the
  // live API (22.11, league Covens, T16, instant buyout): normal is 2 chaos,
  // Elder with Enslaver is 9, Baran's Citadel is 33. The criterion is the mod form, not a list
  // of names: the influence of the next league will come in the same form.
  if (map) return type === 'implicit' && kind === 'flag'
  if (unique) return false
  if (type !== 'explicit') return true
  return tier != null && tier <= 2
}

/**
 * All trade ids of a mod: its own type first, the others as fallbacks.
 *
 * The donor sends the whole id array of ITS OWN type into the query (`everyTradeIdToQuery`,
 * `pathofexile-trade.ts:902-905`), and we repeat this rule. Other types go
 * only when the own type is absent: a measurement on live trade (15.09) showed
 * that the id of the own type is correct: `implicit.stat_825352061` on Ambu's Charge finds
 * 125 listings with `status: any`. The zero in run #109 came not from the type but from
 * `status: online`: the sellers of this item are offline, and the fix is a branch of the
 * query, not a wider filter.
 *
 * Why not "all types always", as it was after #107: each mod with several ids
 * goes as a separate `count` group, and with five mods turned on GGG answers
 * "Query is too complex. Please reduce the amount of filters used" (run #109,
 * Snowblind Grace).
 *
 * We deliberately do not take `pseudo` as a fallback: it is an aggregate ("total resistance"),
 * and giving it the bound of a specific mod would lie about what we search for.
 */
function tradeIds (
  trade: PricedItem['statsByType'][number]['stat']['trade'],
  type: string
): { id?: string, alt: string[] } {
  const own = trade.ids[type] ?? []
  if (own.length) return { id: own[0], alt: own.slice(1) }

  const rest = Object.entries(trade.ids)
    .filter(([key]) => key !== 'pseudo')
    .flatMap(([, ids]) => ids ?? [])
  return { id: rest[0], alt: rest.slice(1) }
}

/** The minimum (best) tier among the mod sources. */
function bestTier (sources: PricedItem['statsByType'][number]['sources']): number | undefined {
  const tiers = sources.map(s => s.modifier.info.tier).filter((t): t is number => t != null)
  return tiers.length ? Math.min(...tiers) : undefined
}

/**
 * All recognised item mods as editor rows, including the ones that cannot be
 * searched: for the player, a mod that disappears silently looks the same as a mod that
 * is counted. An empty list is a valid state, not a failure: currency, maps and keys
 * have no mods and never will.
 */
export function defaultFilters (item: PricedItem): ModFilter[] {
  const unique = item.rarity === 'Unique'
  const map = isMapItem(item)

  const mods = item.statsByType.map(calc => {
    const { id, alt } = tradeIds(calc.stat.trade, calc.type)
    const roll = rollValue(calc.sources)
    const tier = bestTier(calc.sources)
    const kind: ModKind = calc.stat.trade.option ? 'option' : roll === undefined ? 'flag' : 'range'

    const row: ModFilter = {
      label: modLabel(calc.stat.ref, kind === 'option' ? undefined : roll),
      type: calc.type,
      tier,
      kind,
      roll,
      enabled: false
    }

    if (!id) {
      row.unavailable = 'no such filter on trade'
      return row
    }
    if (kind === 'option') {
      // The variant is sent as a number. If it is not recognised, there is nothing to send,
      // and we must not pretend that the mod is counted.
      if (roll === undefined) {
        row.unavailable = 'mod variant not recognised'
        return row
      }
      row.option = roll
    }

    row.id = id
    if (alt.length) row.altIds = alt
    row.enabled = defaultEnabled(calc.type, kind, tier, unique, map)
    if (kind === 'range' && row.enabled) row.min = minRoll(roll!)
    return row
  })

  // The sort is stable: inside a group the order stays the same as the order of the mods
  // on the item, because the player compares the list with the in-game description line by line.
  // The item level is turned on when the price comes from the base: no mod is in
  // the filter. Flasks are a donor exception: the row exists, but it is off.
  const ilvl = itemLevelFilter(item)
  if (ilvl && !mods.some(row => row.enabled) && !ILVL_OFF.has(item.category ?? '')) {
    ilvl.enabled = true
  }

  return [...(ilvl ? [ilvl] : []), ...propertyFilters(item), ...mods]
    .map((row, at) => ({ row, at }))
    .sort((a, b) => groupRank(a.row.type) - groupRank(b.row.type) || a.at - b.at)
    .map(entry => entry.row)
}

/**
 * What is wrong with the row. An empty answer means the row can be sent.
 *
 * The bounds are checked here, not when the query is built: the player edits them one
 * at a time, and min > max is a normal intermediate state of the draft. What must be blocked
 * is not the input but sending such a filter to the search.
 */
export function filterProblem (row: ModFilter): string | undefined {
  if (row.unavailable) return row.unavailable
  if (row.min != null && row.max != null && row.min > row.max) return 'min above max'
  return undefined
}

/**
 * Rows → query filters. A mod that is off is absent from the query; an available mod that is on
 * is not lost. Both bounds go out; a single bound is also a valid filter,
 * and so is a mod that is on with no bounds at all ("this mod is present").
 */
export function toStatFilters (rows: ModFilter[]): StatEntryFilter[] {
  const out: StatEntryFilter[] = []

  for (const row of rows) {
    if (!row.enabled || !row.id || filterProblem(row)) continue

    const alt = row.altIds?.length ? { alt: row.altIds } : {}

    if (row.kind === 'option') {
      out.push({ id: row.id, value: { option: row.option }, ...alt })
      continue
    }
    if (row.kind === 'flag' || (row.min == null && row.max == null)) {
      out.push({ id: row.id, ...alt })
      continue
    }

    const value: NonNullable<StatEntryFilter['value']> = {}
    if (row.min != null) value.min = row.min
    if (row.max != null) value.max = row.max
    out.push({ id: row.id, value, ...alt })
  }

  return out
}

/** A snapshot of the set for comparison: the price belongs to what went into the query. */
export function filterSignature (rows: ModFilter[]): string {
  return JSON.stringify(toStatFilters(rows))
}

/** A copy of the rows. The draft and the applied set must not share objects. */
export function copyFilters (rows: ModFilter[]): ModFilter[] {
  return rows.map(row => ({ ...row }))
}
