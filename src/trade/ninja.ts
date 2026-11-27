// Rate of the in-game Currency Exchange (NPC Faustus): a reference next to the trade price.
//
// The trade API does not see this market: Faustus has its own order book, and in the instant
// buyout results of trade the same Orb of Scouring costs several times different. Measured 20.11,
// league Covens: trade gave a stack of 30 for 10 chaos, the in-game Faustus rate was 1 : 1.39, that is
// about 22 chaos per stack.
//
// Source: poe.ninja. It collects Currency Exchange through the GGG API and returns
// a summary without a key. The GGG API itself (`/currency-exchange`) needs an OAuth application
// with scope `service:cxapi` and without it answers 401. A player cannot get one.
//
// A reference, not a price: the number is the poe.ninja summary of trades, not an order book
// that can be filled now. A source error does not break the price: there is simply
// no reference, and the log says so.

import { tradeFetch } from './client'
import type { Rate } from './price'
import type { PricedItem } from './query'

export const NINJA_EXCHANGE = 'https://poe.ninja/poe1/api/economy/exchange/current/overview'

/**
 * Summary sections to search for the item, in order. Currency is first: almost all
 * presses are for it, and then there is one request. The others are asked only
 * if the item was not found earlier, and each lives in the cache for its own time.
 */
export const NINJA_TYPES = [
  'Currency',
  'Fragment',
  'Essence',
  'Fossil',
  'Resonator',
  'Oil',
  'DeliriumOrb',
  'Omen',
  'Artifact'
] as const

/**
 * How long we wait for poe.ninja. Less than trade: the request runs in parallel with the price,
 * and the reference must not delay the price on screen.
 */
export const NINJA_TIMEOUT_MS = 4_000

/** Cloudflare in front of poe.ninja keeps the summary for 30 minutes: no reason to ask more often. */
const NINJA_TTL_MS = 30 * 60_000

export interface ExchangeOverview {
  core?: { primary?: string, secondary?: string, rates?: Record<string, number> }
  lines?: Array<{
    id: string
    primaryValue?: number
    volumePrimaryValue?: number
    sparkline?: { totalChange?: number | null, data?: Array<number | null> | null } | null
  }>
  items?: Array<{ id: string, name?: string | null }>
}

/** Faustus rate for one item. */
export interface ExchangeReference extends Rate {
  /** Volume in the summary, in its main currency: zero means nobody filled the rate. */
  volume: number
  /** How the rate moved over the last week. Absent when the history says nothing. */
  history?: PriceHistory
}

/**
 * The last week of the rate, from the same summary row: poe.ninja sends it as
 * `sparkline` next to the rate, so the graph costs no extra request.
 *
 * `days` are seven daily points, oldest first. Each is the change in percent
 * against the start of the window, in the same currency as the rate (for chaos it is
 * chaos in divine). `null` is a day without trades: a new item has them at the start.
 */
export interface PriceHistory {
  days: Array<number | null>
  /** Change over the whole window, in percent. */
  change: number
}

/**
 * Fewer known days than this is not a trend: two points are a line, and the graph
 * would draw a crash out of one trade.
 */
export const MIN_HISTORY_DAYS = 3

/**
 * Below this daily volume (in chaos) the history is noise. Measured 25.11 in Covens:
 * essences that trade for under 5 chaos a day jump by +300 % and -80 % from day
 * to day, while every currency row above 400 chaos a day moves smoothly. The bar sits
 * well above the noise and well below the smallest liquid currency.
 */
export const MIN_HISTORY_VOLUME = 50

/** The week graph for a summary row, or `undefined` when it would mislead. */
export function historyFrom (
  sparkline: { totalChange?: number | null, data?: Array<number | null> | null } | null | undefined,
  volume: number
): PriceHistory | undefined {
  if (!(volume >= MIN_HISTORY_VOLUME)) return undefined
  const days = (sparkline?.data ?? []).map(day => Number.isFinite(day) ? day : null)
  const known = days.filter((day): day is number => day != null)
  if (known.length < MIN_HISTORY_DAYS) return undefined
  const total = sparkline?.totalChange
  return { days, change: Number.isFinite(total) ? total! : known.at(-1)! }
}

/**
 * The item in the summary. poe.ninja row ids match the trade exchange tags
 * (`scour`, `chaos`, `divine`). Search by tag first, then by English name:
 * for fragments, tags and ids differ.
 *
 * The main currency of the summary (chaos) costs 1 of itself, so its rate is taken in the
 * second currency: "chaos per divine", as in trade.
 */
export function referenceFrom (overview: ExchangeOverview, item: PricedItem): ExchangeReference | undefined {
  const lines = overview.lines ?? []
  const byName = overview.items?.find(entry => entry.name === item.info.refName)?.id
  const line = lines.find(entry => entry.id === item.info.tradeTag) ??
    (byName ? lines.find(entry => entry.id === byName) : undefined)
  if (!line || !(line.primaryValue! > 0)) return undefined

  const primary = overview.core?.primary ?? 'chaos'
  const secondary = overview.core?.secondary
  const volume = line.volumePrimaryValue ?? 0
  // The chaos row's sparkline is already chaos in divine, the same as the rate below.
  const history = historyFrom(line.sparkline, volume)
  const extra = history ? { history } : {}
  if (line.id === primary && secondary) {
    const rate = overview.core?.rates?.[secondary]
    return rate! > 0 ? { amount: rate!, currency: secondary, volume, ...extra } : undefined
  }
  return { amount: line.primaryValue!, currency: primary, volume, ...extra }
}

const cache = new Map<string, { at: number, overview: ExchangeOverview }>()

/** Tests start with an empty cache, like a new start of the daemon. */
export function resetNinjaCache (): void {
  cache.clear()
}

/**
 * Summary of one section for a league. An unknown league at poe.ninja is not an error but
 * an empty list, and it is cached too: no reason to ask for it again a minute later.
 */
export async function exchangeOverview (league: string, type: string): Promise<ExchangeOverview> {
  const key = `${league}\n${type}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < NINJA_TTL_MS) return hit.overview

  const url = `${NINJA_EXCHANGE}?league=${encodeURIComponent(league)}&type=${encodeURIComponent(type)}`
  const response = await tradeFetch(url, { signal: AbortSignal.timeout(NINJA_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`poe.ninja answered ${response.status}`)
  const overview = await response.json() as ExchangeOverview
  cache.set(key, { at: Date.now(), overview })
  return overview
}

/**
 * Faustus rate for the item, or `undefined`. Does not throw: the reference is an addition to
 * the price, and its failure (network, timeout, new response form) stays in the log.
 */
export async function exchangeReference (
  item: PricedItem,
  league: string,
  log: (line: string) => void = line => console.log(line)
): Promise<ExchangeReference | undefined> {
  try {
    for (const type of NINJA_TYPES) {
      const found = referenceFrom(await exchangeOverview(league, type), item)
      if (found) return found
    }
    log(`   Faustus rate: ${item.info.refName} not on poe.ninja for ${league}`)
  } catch (err) {
    log(`   Faustus rate: poe.ninja unavailable (${err instanceof Error ? err.message : String(err)}) — trade price only`)
  }
  return undefined
}
