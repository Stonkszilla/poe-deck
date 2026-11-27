// From a parsed item to a query. The fork of the epic lives here.
//
// No borrowed code here — only rules, taken from the donor as ideas and named
// out loud. Donor: SnosMe/awakened-poe-trade (MIT), see licenses/.
//
// ── The fork ────────────────────────────────────────────────────────────────
//
// The donor calls it `apiToSatisfySearch` (trade/common.ts:25-31), and it says:
// enabled stat filters exist → search by stats; none → exchange, if the item
// has an exchange tag. We take it as is, because it holds the invariant of the
// epic: **no mods is not a failure, it is the entry into another branch**.
// Currency, a key, a map, an unidentified item — none of them have mods or ever
// will, and all of them have a price.
//
// Different branches are also different GGG rate-limit groups:
//   search   → POST /api/trade/search + GET /api/trade/fetch   (SEARCH + FETCH)
//   exchange → POST /api/trade/exchange                        (EXCHANGE)
// So the fork is chosen BEFORE the request, not from an empty response.
//
// ── Who picks the mods ──────────────────────────────────────────────────────
//
// The donor defaults (explicit of tier ≤ 2, other types in full, roll threshold
// minus 10%) live in `./filters.ts` with the rest of the mod list: with the filter
// editor the player changes them, and this file must not hold a second rule. `statFilters`
// below is the same defaults, applied without the editor.
//
// Not ported from the donor: pseudo stats (total resistances and similar), the
// map of categories to trade ids. They refine the query, they do not make it possible.
// Defence properties and weapon dps are ported — as rows of the `properties` group.

import { BASE_TYPE_ID, baseCategory, defaultFilters, toStatFilters } from './filters'

/** Is this a map. Donor category — `ItemCategory.Map` = `'Map'` (`parser/meta.ts:2`). */
export function isMapItem (item: Pick<PricedItem, 'category' | 'mapTier'>): boolean {
  return item.category === 'Map' || item.mapTier != null
}

/** The part of the donor `ParsedItem` that query building uses. */
export interface PricedItem {
  rarity?: string
  itemLevel?: number
  /**
   * The donor parser (3.30 pin) gives an object, `{}` or `{ twice: true }`, and leaves the
   * field out for an item that is not corrupted. The boolean is the older form.
   */
  isCorrupted?: boolean | { twice?: boolean }
  isUnidentified?: boolean
  info: {
    name?: string
    refName: string
    /** Exchange tag. Currency and shards have it — it sends us to the rate branch. */
    tradeTag?: string
  }
  uniqueBase?: { refName: string }
  /** Donor category: `Map`, `Jewel`, `Flask`, … Needed where the query has a different shape. */
  category?: string
  /** Map tier. Only maps have it, and on trade it is a separate filter. */
  mapTier?: number
  /** Stack from the item tooltip: "Stack Size: 20/5000". Currency and shards have it. */
  stackSize?: { value: number, max: number }
  /** Defence properties — armour, evasion, shield, ward, block. Donor parser fields. */
  armourAR?: number
  armourEV?: number
  armourES?: number
  armourWARD?: number
  armourBLOCK?: number
  /** Weapon properties from the buffer: attacks per second, average physical and elemental damage per hit. */
  weaponAS?: number
  weaponPHYSICAL?: number
  weaponELEMENTAL?: number
  /** Quality, %. Needed to bring physical damage to Q20, as trade computes it. */
  quality?: number
  /** The full buffer, as the game gave it. Source for what the donor parser does not parse. */
  rawText?: string
  statsByType: Array<{
    stat: {
      ref: string
      /**
       * Which direction of the roll is better: 1 — higher, -1 — lower, 0 — neither
       * (donor `StatBetter`). Decides which bound a filter gets.
       */
      better?: number
      /**
       * How the game writes the mod. A `negate` matcher reads a negative roll:
       * "20% reduced Flask Charges used" is the roll −20 of the ref "#% increased …".
       */
      matchers?: Array<{ string: string, negate?: true, value?: number }>
      /**
       * `inverted`: trade keeps the value with the opposite sign to the parser roll. The
       * parser reads "20% reduced Flask Charges used" as −20, trade keeps it as 20.
       * Donor `trade.inverted`.
       */
      trade: { ids: Record<string, string[] | undefined>, option?: true, inverted?: true }
    }
    /** Donor ModifierType: explicit | implicit | enchant | fractured | crafted | … */
    type: string
    sources: Array<{
      modifier: { info: { tier?: number } }
      /** The matcher the parser used on the item line: "#% reduced Flask Charges used". */
      stat?: { translation: { string: string } }
      contributes?: { value: number, min: number, max: number }
    }>
  }>
}

/**
 * Search mode — the same four-item dropdown as on the trade site.
 * A measurement on 15.09 on Ambu's Charge in the Allflame league shows that these
 * are different markets, not shades of one:
 *
 * | mode           | meaning                                      | listings   |
 * |----------------|----------------------------------------------|------------|
 * | `securable`    | Instant Buyout: buy through the stash, no seller needed | 2855 |
 * | `available`    | Instant Buyout and In Person (Online) together | —        |
 * | `online`       | In Person (Online): a hand-to-hand trade     | 66         |
 * | `onlineleague` | the same, but only in this league            | 65         |
 * | `any`          | everything, offline included                 | 5118       |
 *
 * The default is `securable`: the price you can get right now, without
 * waiting for a seller to answer in game. On the same item `online` gave
 * a median of 10 chaos, and instant buyout gave 1 chaos with 2855 lots;
 * the second is the market, the first is price tags of people who do not sell.
 *
 * `available` is the donor default outside merchant mode: both markets where
 * a trade can close now. Measurement 04.10 (Headhunter, Allflame): 1977 = 1974
 * instant + 3 in person. Bulk exchange accepts it too. It is second in the cycle,
 * right after the default — it is the nearest wider market.
 */
export const SEARCH_MODES = ['securable', 'available', 'online', 'onlineleague', 'any'] as const
export type SearchMode = typeof SEARCH_MODES[number]
export const DEFAULT_SEARCH_MODE: SearchMode = 'securable'

/** How the mode is named on the panel. No API codes in front of the player. */
export const MODE_LABEL: Record<SearchMode, string> = {
  securable: 'instant buyout',
  available: 'buyout or in person',
  online: 'in person (online)',
  onlineleague: 'in person (league)',
  any: 'any, incl. offline'
}

/** Mode from a string — for an environment variable. Garbage is not silently accepted. */
export function parseSearchMode (value: string | undefined): SearchMode | undefined {
  if (!value) return undefined
  const found = SEARCH_MODES.find(mode => mode === value)
  if (!found) throw new Error(`unknown search mode "${value}", expected: ${SEARCH_MODES.join(', ')}`)
  return found
}

/** The next mode in the cycle — one action in the editor, no list and no menu. */
export function nextSearchMode (mode: SearchMode): SearchMode {
  return SEARCH_MODES[(SEARCH_MODES.indexOf(mode) + 1) % SEARCH_MODES.length]!
}

export interface StatEntryFilter {
  id: string
  /** Both bounds are optional and independent: the player sets either of them. */
  value?: { min?: number, max?: number, option?: number }
  /**
   * The same mod under other trade types. In the donor reference one mod often
   * has an id in `explicit`, in `implicit`, and in `fractured` — for example
   * "Trigger Level 20 Death Aura when Equipped" on Ambu's Charge. The buffer gives
   * ONE type, the trade index can hold the mod under another, and a filter by the
   * "own" id finds nothing (run #107: a unique priced at 5 chaos by name and zero
   * with the mod enabled). So such a mod goes as an "any of these ids" group.
   */
  alt?: string[]
}

/** A stat filter group of the query. `count` with `min: 1` means "any of the listed". */
export interface StatGroup {
  type: 'and' | 'count'
  filters: Array<{ id: string, value?: StatEntryFilter['value'] }>
  value?: { min: number }
}

export interface SearchBody {
  query: {
    status: { option: SearchMode }
    name?: string
    /** Base. For maps it is `{ option: 'Map', discriminator: 'map' }` — see below. */
    type?: string | { option: string, discriminator: string }
    stats: StatGroup[]
    filters: {
      type_filters?: { filters: { rarity?: { option: string }, category?: { option: string } } }
      map_filters?: {
        filters: {
          map_tier?: { min: number, max: number }
          map_blighted?: { option: string }
          map_uberblighted?: { option: string }
          map_series?: { option: string }
        }
      }
      trade_filters?: { filters: { price?: { option: string }, collapse?: { option: string } } }
      misc_filters?: {
        filters: {
          corrupted?: { option: string }
          identified?: { option: string }
          ilvl?: { min?: number, max?: number }
        }
      }
      armour_filters?: { filters: Record<string, { min?: number, max?: number }> }
      weapon_filters?: { filters: Record<string, { min?: number, max?: number }> }
    }
  }
  sort: { price: 'asc' }
}

export interface ExchangeBody {
  engine: 'new'
  query: {
    status: { option: SearchMode }
    have: string[]
    want: string[]
  }
  sort: { have: 'asc' }
}

/**
 * Item mods that go into the search filter by default — that is, before the
 * player changes anything in the editor. An empty array is a valid answer, not
 * a sign that something failed: currency, a map, a key and an unidentified
 * item have no mods at all.
 */
export function statFilters (item: PricedItem): StatEntryFilter[] {
  return toStatFilters(defaultFilters(item))
}

/**
 * How many explicit mods the default filter left out. Not diagnostics for its
 * own sake: if all mods of a rare item are below tier 2, the query goes by the
 * base only, and the found price is the price of the base, not of this item.
 * This must not stay silent; the number goes into the result line.
 *
 * With the filter editor the number has a second meaning: this many editor rows the player
 * can enable by hand. All rows are visible, including unavailable ones — `defaultFilters`.
 */
export function skippedExplicits (item: PricedItem): number {
  return defaultFilters(item).filter(row => row.type === 'explicit' && row.id && !row.enabled).length
}

/**
 * Which branch to take for the price. Donor rule: mods decide, the exchange tag
 * is the fallback, search by name and base is the common denominator.
 *
 * `stats` is the set the player chose. It affects the fork in one direction
 * only: an enabled mod sends the item to search. The reverse is intentionally
 * absent — when the player disables all filters on a rare item, the player asks
 * for the price of the base, not an exchange rate.
 */
export function pickFork (item: PricedItem, stats?: StatEntryFilter[]): 'search' | 'exchange' {
  // The base row is not a mod: an equipment item that has it is searched anyway.
  const mods = (set: StatEntryFilter[]) => set.some(stat => stat.id !== BASE_TYPE_ID)
  if (mods(stats ?? []) || mods(statFilters(item))) return 'search'
  return item.info.tradeTag ? 'exchange' : 'search'
}

/**
 * Search by stats, which is also search by name and base when there are no stats.
 * `type` is the item base; for currency, maps and divination cards the base is the
 * name, so one string works for all shapes (donor: `baseType`,
 * `create-item-filters.ts:98-104`).
 *
 * `opts.stats` is the set the player chose in the editor. Not set — the defaults go.
 * An empty array is also a set: "search by name and base, with no stat filters".
 */
export function buildSearchQuery (
  item: PricedItem,
  opts: { status?: SearchMode, stats?: StatEntryFilter[] } = {}
): SearchBody {
  const isUnique = item.rarity === 'Unique'

  // On trade `type` is the BASE, and the name of a unique cannot be there. While
  // the base is not recognized, the field is not sent at all: the donor rule is to
  // search a unique by name and base only when the base is known
  // (`create-item-filters.ts:214`), otherwise `name` and `type` would match, and the
  // result would always be empty. This is exactly how Ambu's Charge was silently
  // lost in run #101: dozens of listings on trade, zero for us.
  const base = isUnique ? item.uniqueBase?.refName : (visceraBase(item) ?? item.info.refName)
  const isMap = isMapItem(item)

  const chosen = opts.stats ?? statFilters(item)
  const body: SearchBody = {
    query: {
      status: { option: opts.status ?? DEFAULT_SEARCH_MODE },
      stats: statGroups(chosen.filter(stat => !isPropertyFilter(stat.id))),
      filters: {}
    },
    sort: { price: 'asc' }
  }

  // Defence properties, weapon dps and item level are not stats: trade has its own query fields for them.
  // The split happens here, because the editor shows them in one table
  // with the mods, and only the address in the query makes them different.
  const props: Record<PropertyGroup, Record<string, { min?: number, max?: number }>> = {
    armour_filters: {},
    weapon_filters: {},
    misc_filters: {}
  }
  for (const stat of chosen) {
    const address = PROPERTY_FIELD[stat.id]
    if (!address) continue
    const { min, max } = stat.value ?? {}
    if (min == null && max == null) continue
    props[address.group][address.field] = { ...(min != null ? { min } : {}), ...(max != null ? { max } : {}) }
  }
  for (const group of ['armour_filters', 'weapon_filters'] as const) {
    if (Object.keys(props[group]).length) body.query.filters[group] = { filters: props[group] }
  }

  // On trade a map is not "Bone Crypt Map", but `Map` with a discriminator. Measured on
  // the live API (15.09, Allflame league, T16):
  //
  //   type: { option: 'Map', discriminator: 'map' }  → 10000 listings
  //   type: 'Bone Crypt Map'                         → 0
  //   type: 'Map'                                    → 0
  //
  // Trade does not index the map area at all: it rejects `name: 'Bone Crypt'`
  // as "Unknown item name". A map is identified by tier and mods, not by where it
  // takes place. Run #115 sent `type: 'Map'` and got zero on every map.
  //
  // A blight map is the same `Map`, not a base of its own. The buffer names it
  // `Blighted Map (Tier 14)`, and the parser gives the base `Blighted Map`, but trade
  // does not know such a base. Measured on the live API (09.11, Allflame league, T14):
  //
  //   type: 'Blighted Map'                                  → 0
  //   type: { option: 'Blighted Map', discriminator: 'map' } → 4489 — all T14,
  //                                                            blight ignored
  //   type: { option: 'Map', … } + map_blighted: true       → 414
  //
  // Before this fix a blight map got the price of an ordinary map of the same tier.
  //
  // The discriminator is only for the common base `Map` and its blight variants. A map
  // with its own base is searched by that base: `Shaper Guardian Map` is a separate trade
  // type with no tier in the name, the buffer names it the same way, and it has no tier.
  // With `Map` and no tier the query searched any map of any tier. Measured on the live
  // API (22.11, Covens league, query from the buffer of an unidentified map):
  // `type: 'Shaper Guardian Map'` — 6569 listings, all Shaper Guardian Map, from 3 chaos
  // against 2 chaos for an ordinary T16. Donor rule: the discriminator is set only when
  // the base is `Map` (`create-item-filters.ts:175`).
  //
  // The player can switch the base off in the editor (the `item.base_type` row). Then the
  // query names the trade category instead, as the donor does with its base checkbox
  // (`pathofexile-trade.ts:329-333`): the same mods on any ring, not on any item.
  const category = baseCategory(item)
  const anyBase = category != null && opts.stats != null && !opts.stats.some(stat => stat.id === BASE_TYPE_ID)
  const blight = isMap ? mapBlight(item) : undefined
  if (isMap && (blight || !base || base === 'Map')) body.query.type = { option: 'Map', discriminator: 'map' }
  else if (base && !anyBase) body.query.type = base
  if (isUnique && item.info.name) body.query.name = item.info.name

  body.query.filters.type_filters = {
    filters: {
      rarity: { option: isUnique ? 'unique' : 'nonunique' },
      ...(anyBase ? { category: { option: category } } : {})
    }
  }

  // Tier is the main thing that makes one map different from another: T16 and T3 with
  // the same mods are different items and different money (`map_filters`, donor —
  // `pathofexile-trade.ts:382`).
  //
  // Blight is the second sign, and it works both ways, as in the donor
  // (`pathofexile-trade.ts:386-395`): an ordinary map is searched with both flags
  // `false`, otherwise blight maps of the same tier mix into the result (09.11,
  // Allflame, T3: 3825 without the flags, 3775 with them).
  //
  // Series is always `current`. This is not a guess about the item: the pinned parser
  // knows only the current form `Map (Tier N)`, and a map of an old series (`Bone Crypt
  // Map`) is not recognized at all. In a temporary league the filter changes nothing, and
  // in Standard without it the result includes maps of all past atlases: T3 — 10000
  // listings without the series and 479 with `current` (measured 09.11). The donor does
  // not set this filter; the rule is ours.
  if (isMap) {
    const map: NonNullable<SearchBody['query']['filters']['map_filters']>['filters'] = {}
    if (item.mapTier != null) map.map_tier = { min: item.mapTier, max: item.mapTier }
    map.map_blighted = { option: String(blight === 'blighted') }
    map.map_uberblighted = { option: String(blight === 'ravaged') }
    map.map_series = { option: 'current' }
    body.query.filters.map_filters = { filters: map }
  }

  // Prices only in chaos and divine, and lots of one account are collapsed. Both
  // rules are from the donor (`pathofexile-trade.ts:283-291`) and both are about one
  // thing: a result that mixes five currencies and ten lots of one bot gives no median.
  body.query.filters.trade_filters = {
    filters: { price: { option: 'chaos_divine' }, collapse: { option: 'true' } }
  }

  // Corruption and identification change the price many times over, and for the item
  // in hand they are known exactly — so this is not a guess, but part of what we hold.
  const misc: NonNullable<SearchBody['query']['filters']['misc_filters']>['filters'] = {}
  // `String(item.isCorrupted)` sent `"[object Object]"` for the object form of the parser. Trade read
  // it as true by accident: on a live search it gave the same count as `"true"`.
  if (item.isCorrupted !== undefined) misc.corrupted = { option: String(Boolean(item.isCorrupted)) }
  if (item.isUnidentified) misc.identified = { option: 'false' }
  // Item level comes from the editor as a `properties` row, and lives in the same
  // query group as corruption and identification.
  if (props.misc_filters.ilvl) misc.ilvl = props.misc_filters.ilvl
  if (Object.keys(misc).length) body.query.filters.misc_filters = { filters: misc }

  return body
}

/**
 * Viscera base (Covens league, 3.30) — from the buffer, not from the parser. The donor
 * parser gives every Viscera one name `Viscera` and tells them apart by body part
 * (`Head Viscera`, `Upper Limb Viscera`). Trade does not know such a base, but it has
 * its own bases: "Scorched Arm", "Coven Queen's Crown". Measured on the live API
 * (17.11, Covens league): `type: 'Scorched Arm'` — 189 listings, Lesser and
 * Greater in one result. So the name from the buffer is taken without the prefix.
 */
export function visceraBase (item: PricedItem): string | undefined {
  if (item.info.refName !== 'Viscera' || !item.rawText) return undefined
  const lines = item.rawText.split(/\r?\n/)
  const name = lines[1]?.startsWith('Rarity: ') ? lines[2] : lines[1]
  return name?.replace(/^(?:Lesser|Greater) /, '') || undefined
}

/**
 * Blight map or not. The sign is the base from the buffer: for `Blighted Map (Tier 14)`
 * the parser gives the base `Blighted Map`, for `Blight-ravaged Map (Tier 16)` —
 * `Blight-ravaged Map` (both are in the pinned `items.ndjson`). Donor rule,
 * `create-item-filters.ts:169-175`.
 */
export function mapBlight (item: PricedItem): 'blighted' | 'ravaged' | undefined {
  const base = item.uniqueBase?.refName ?? item.info.refName
  if (base === 'Blighted Map') return 'blighted'
  if (base === 'Blight-ravaged Map') return 'ravaged'
  return undefined
}

/**
 * Is this an item property (defence, dps, level), not a mod. Needed by code that
 * asks "did at least one mod go into the filter": an enabled ilvl on an item that
 * is searched by base is not a mod and does not turn the base price into the item price.
 */
export function isPropertyFilter (id: string): boolean {
  return PROPERTY_FIELD[id] != null || id === BASE_TYPE_ID
}

type PropertyGroup = 'armour_filters' | 'weapon_filters' | 'misc_filters'

/**
 * Internal property name → trade group and field. Names on the left come from the donor
 * (`_INTERNAL_TRADE_IDS`, `filters/interfaces.ts:142-154`), on the right is what
 * the API understands (`pathofexile-trade.ts:452-490`).
 */
const PROPERTY_FIELD: Record<string, { group: PropertyGroup, field: string } | undefined> = {
  'item.armour': { group: 'armour_filters', field: 'ar' },
  'item.evasion_rating': { group: 'armour_filters', field: 'ev' },
  'item.energy_shield': { group: 'armour_filters', field: 'es' },
  'item.ward': { group: 'armour_filters', field: 'ward' },
  'item.block': { group: 'armour_filters', field: 'block' },
  'item.total_dps': { group: 'weapon_filters', field: 'dps' },
  'item.physical_dps': { group: 'weapon_filters', field: 'pdps' },
  'item.elemental_dps': { group: 'weapon_filters', field: 'edps' },
  'item.ilvl': { group: 'misc_filters', field: 'ilvl' }
}

/**
 * Filters → query groups. A mod with one id lives in the common `and` group; a mod
 * that exists on trade under several types goes as a separate `count` group
 * with `min: 1` — "any of these ids". Otherwise the type from the buffer would decide
 * the fate of the search, and for uniques it differs from the trade index.
 */
export function statGroups (stats: StatEntryFilter[]): StatGroup[] {
  const and: StatGroup = { type: 'and', filters: [] }
  const groups: StatGroup[] = [and]

  for (const stat of stats) {
    const ids = [stat.id, ...(stat.alt ?? [])]
    const entry = stat.value ? { value: stat.value } : {}
    if (ids.length === 1) {
      and.filters.push({ id: stat.id, ...entry })
      continue
    }
    groups.push({
      type: 'count',
      value: { min: 1 },
      filters: ids.map(id => ({ id, ...entry }))
    })
  }

  return groups
}

/**
 * What to exchange for — currency is priced by a rate, not by listings.
 *
 * We compute the rate in chaos: one currency for all items gives one number that
 * can be compared. For Chaos Orb itself chaos makes no sense — we measure it in divine
 * (donor rule, `TradeBulk.vue:137-141`, with the reason there too: at league start
 * half of the players set a random rate).
 */
export function buildExchangeQuery (
  item: PricedItem,
  opts: { status?: SearchMode, have?: string[] } = {}
): ExchangeBody {
  const tag = item.info.tradeTag
  if (!tag) throw new Error(`${item.info.refName} has no exchange tag — this branch is not about it`)

  return {
    engine: 'new',
    query: {
      status: { option: opts.status ?? DEFAULT_SEARCH_MODE },
      have: opts.have ?? (tag === 'chaos' ? ['divine'] : ['chaos']),
      want: [tag]
    },
    sort: { have: 'asc' }
  }
}
