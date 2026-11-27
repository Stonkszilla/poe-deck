// The whole price check: a parsed item to a price. The network is here, the decisions are next to it
// (src/trade/query.ts decides which request, src/trade/price.ts decides what counts as the price).
//
// There is no overlay here on purpose: the price comes back as a structure and is printed as a line.
// This file does not know who shows it: the daemon, the panel or the run log.

import { currentLeague, exchange, fetchResults, search } from './trade/client'
import {
  changeText,
  formatPrice,
  priceAmountText,
  priceFromExchange,
  priceFromListings,
  priceValueText,
  rateText,
  SAMPLE_SIZE,
  stackPrice,
  type ExchangeEntry,
  type Listing,
  type Price
} from './trade/price'
import { exchangeReference, type ExchangeReference } from './trade/ninja'
import { MODE_LABEL } from './trade/query'
import {
  buildExchangeQuery,
  buildSearchQuery,
  DEFAULT_SEARCH_MODE,
  isPropertyFilter,
  pickFork,
  skippedExplicits,
  statFilters,
  type PricedItem,
  type SearchMode,
  type StatEntryFilter
} from './trade/query'

/**
 * The "what this price is for" caveat. One for the panel and the log: a mismatch
 * between what the player sees and what is written to the log would need an investigation.
 *
 * For a unique it sounds different on purpose: its innate mods have no tiers at all,
 * and "all 5 mods below tier 2" would be false (run #107). A unique is searched by
 * name and base: this is the price of EXACTLY THIS item, only without looking at the rolls.
 */
export function scopeNote (item: PricedItem, skipped: number): string {
  if (item.rarity === 'Unique') return `by name, rolls ignored (${skipped} mods)`
  return statFilters(item).some(stat => !isPropertyFilter(stat.id))
    ? `${skipped} mods outside the filter`
    : `base price: all ${skipped} mods below tier 2`
}

export interface PriceCheck {
  /** Which branch we took. The fork is visible in the answer, not only in the log. */
  fork: 'search' | 'exchange'
  league: string
  price?: Price
  /** No exchange rate was found and we went to listings. Not an error, but useful to know. */
  fellBackToSearch?: boolean
  /**
   * Explicit mods that did not get into the filter (all below tier 2). If there are many of them and
   * the filter is empty, the price found is for the base, not for this item. The number is visible outside,
   * because staying silent about it means showing a foreign price as our own.
   */
  skippedExplicits: number
  /**
   * The mode in which the price was really found. It can differ from the requested one:
   * empty results are a reason to ask a wider market, but not a reason to hide
   * that the shown number is about another market already.
   */
  mode: SearchMode
  /** One mode was requested and another answered: the panel says so out loud. */
  fellBackToMode?: boolean
  /**
   * Filters set by the player in the editor. If present, the price belongs
   * exactly to this set, and the panel must say so: the same item name
   * with another filter set costs different money. If absent, the search used
   * the automatic set, as before the editor.
   */
  manualStats?: StatEntryFilter[]
  /**
   * The in-game Currency Exchange (Faustus) rate from poe.ninja, only for
   * the exchange branch. Trade does not see this market, and the prices differ many times, so
   * the panel shows both numbers. If absent, the source is silent, and the price does not change.
   */
  reference?: ExchangeReference
}

/** API limit: no more than ten listings per `fetch`. */
const FETCH_PAGE = 10

async function bySearch (
  item: PricedItem,
  league: string,
  stats: StatEntryFilter[] | undefined,
  mode: SearchMode
): Promise<{ price?: Price, mode: SearchMode, fellBackToMode?: boolean }> {
  let status = mode
  const body = buildSearchQuery(item, { stats, status })
  await dumpQuery(body, stats ? 'manual' : 'auto')
  let found = await search(body, league)

  // Empty results in a narrow mode do not mean "this does not exist". Measured on live
  // trade (15.09): Ambu's Charge with the Death Aura implicit gives zero with `online`
  // and 125 listings with `any`. Exactly this looked like "search by
  // mod does not work" in run #109. The second request costs one SEARCH limit and is made
  // only when the first one is empty.
  if (!found.result.length && mode !== 'any') {
    status = 'any'
    try {
      found = await search(buildSearchQuery(item, { stats, status }), league)
    } catch {
      // The second request is a courtesy, not a duty: hitting the limit on it
      // means staying without an answer where the first answer already exists.
      return { mode }
    }
  }
  if (!found.result.length) return { mode }

  const ids = found.result.slice(0, SAMPLE_SIZE)
  const listings: Listing[] = []
  for (let at = 0; at < ids.length; at += FETCH_PAGE) {
    listings.push(...await fetchResults<Listing>(found.id, ids.slice(at, at + FETCH_PAGE)))
  }

  return {
    // Instant buyout closes the deal without a seller, and keeping bait there
    // makes no sense: cutting the lower quarter on this market only raises the price
    // (tester remark after run #113). On markets where a live person holds the price,
    // the cut stays.
    price: priceFromListings(listings, found.total, undefined, { dropBait: status !== 'securable' }),
    mode: status,
    ...(status === mode ? {} : { fellBackToMode: true })
  }
}

/**
 * The item price. The branch is chosen by the item itself: with mods we search by them,
 * without mods we use the currency rate or listings by name and base.
 *
 * `opts.stats` is the filter set the player confirmed in the editor. It goes
 * to the request as is and comes back in the answer: a price without its filter set is
 * a number without an item. An empty array is also a choice of the player ("no stat filters"),
 * and it does not change the fork: for a rare item it is the base price, not the exchange rate.
 *
 * An empty result is `price: undefined`, not an exception: "nobody sells this
 * now" is a legal trade answer, and it must go up the same way.
 */
/**
 * Where to store the bodies of outgoing requests. The epic acceptance requires comparing what
 * the player selected on the screen with what really went to trade, and the log cannot
 * do that: it prints filter ids, but not the bounds and not the other request fields.
 * Empty means do not store (normal play writes nothing to disk).
 */
async function dumpQuery (body: unknown, kind: 'auto' | 'manual'): Promise<void> {
  const dir = process.env.POE_DECK_QUERY_DUMP
  if (!dir) return

  queries += 1
  const path = `${dir}/query-${String(queries).padStart(2, '0')}-${kind}.json`
  await Bun.write(path, JSON.stringify(body, null, 2))
  console.log(`   query body saved: ${path}`)
}

let queries = 0

/**
 * How long the answer to one request body lives. The trade limit hits SEARCH
 * (5 per 10 s, 15 per minute), not FETCH: in run #143 all seven refusals came from
 * our limiter on search, the server did not refuse once. Of 28 auto requests in the same
 * run, only 10 had different bodies: the player presses the button on the same item again, and
 * each press cost a search and two FETCH pages. Three minutes is less than
 * the market needs to move the price, and more than the player needs to check one item.
 */
const CACHE_TTL_MS = 3 * 60_000

/**
 * The market answer without what belongs to the call itself. The set of the player and the number
 * of skipped mods come from the current press: for a unique without stats
 * the automatic estimate and a confirmed editor with `stats: []` give one request
 * body, but the second price must say "player filters" and the first must not.
 */
type MarketAnswer = Omit<PriceCheck, 'skippedExplicits' | 'manualStats'>

const cache = new Map<string, { at: number, market: MarketAnswer }>()

/** Tests start with an empty cache, as a new daemon start does. */
export function resetPriceCache (): void {
  cache.clear()
}

/**
 * The key is the league and the body of the first request of the branch. The body already holds everything
 * the answer depends on: base, tier, map flags, market mode and the filter set of the player.
 * Two items with one body get one answer from trade, and from us too.
 */
function cacheKey (item: PricedItem, league: string, fork: PriceCheck['fork'], stats: StatEntryFilter[] | undefined, mode: SearchMode): string {
  const body = fork === 'exchange'
    ? buildExchangeQuery(item, { status: mode })
    : buildSearchQuery(item, { stats, status: mode })
  return JSON.stringify([league, fork, body])
}

export async function priceOf (
  item: PricedItem,
  opts: { league?: string, stats?: StatEntryFilter[], mode?: SearchMode } = {}
): Promise<PriceCheck> {
  const league = opts.league ?? await currentLeague()
  const fork = pickFork(item, opts.stats)
  const mode = opts.mode ?? DEFAULT_SEARCH_MODE
  const base = {
    fork,
    league,
    mode,
    skippedExplicits: skippedExplicits(item),
    ...(opts.stats ? { manualStats: opts.stats } : {})
  }

  // An error (rate limit, network) does not get into the cache: it goes past the write as an exception.
  const key = cacheKey(item, league, fork, opts.stats, mode)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    console.log(`   price from cache, ${Math.round((Date.now() - hit.at) / 1000)}s old: no trade request`)
    return ownedBy(hit.market, base)
  }
  const { manualStats: _, skippedExplicits: __, ...market } = await lookUp(item, league, fork, opts.stats, mode, base)
  cache.set(key, { at: Date.now(), market })
  return ownedBy(market, base)
}

/** The market answer plus what belongs to this press, not to the previous one. */
function ownedBy (market: MarketAnswer, call: PriceCheck): PriceCheck {
  return {
    ...market,
    skippedExplicits: call.skippedExplicits,
    ...(call.manualStats ? { manualStats: call.manualStats } : {})
  }
}

async function lookUp (
  item: PricedItem,
  league: string,
  fork: PriceCheck['fork'],
  stats: StatEntryFilter[] | undefined,
  mode: SearchMode,
  base: PriceCheck
): Promise<PriceCheck> {
  if (fork === 'exchange') {
    // The Faustus rate runs in parallel with trade and does not throw: a reference must
    // neither delay the price nor cancel it with its own error.
    const faustus = exchangeReference(item, league)
    const found = await exchange<ExchangeEntry>(buildExchangeQuery(item, { status: mode }), league)
    const price = priceFromExchange(Object.values(found.result), found.total)
    const reference = await faustus
    const withReference = reference ? { ...base, reference } : base
    if (price) return { ...withReference, price }

    // No rate: this happens at league start and for currency that nobody puts
    // on the exchange. There are listings, and they are a price too.
    return { ...withReference, ...await bySearch(item, league, stats, mode), fellBackToSearch: true }
  }

  return { ...base, ...await bySearch(item, league, stats, mode) }
}

/** Result line: which item, which branch, how much it costs. */
export function formatPriceCheck (item: PricedItem, check: PriceCheck): string {
  const name = [item.info.name, item.info.refName]
    .filter((part, index, all) => part && all.indexOf(part) === index)
    .join(' / ')
  const via = check.fellBackToSearch
    ? 'exchange -> listings'
    : (check.fork === 'exchange' ? 'exchange' : 'listings')

  // The map tier is part of what was searched: otherwise T14 and T16 cannot be told apart in the log.
  const tier = item.mapTier != null ? ` T${item.mapTier}` : ''
  const whole = check.price ? stackPrice(check.price, item.stackSize?.value) : undefined
  const stack = whole ? ` | stack ${item.stackSize!.value}: ${priceAmountText(whole)}` : ''
  const line = `${name}${tier} [${check.league}, ${MODE_LABEL[check.mode]}, ${via}]: ${formatPrice(check.price)}${stack}${faustusText(item, check)}`

  // The set of the player is named out loud in the log too: later the request body is compared
  // with what was selected on the screen by it (filter editor acceptance).
  if (check.manualStats) {
    return `${line} [player filters: ${check.manualStats.length}]`
  }
  if (check.fork === 'exchange' || !check.skippedExplicits) return line

  // An explicit caveat instead of a silent "the price is this". An empty filter with five mods
  // is the base price, and on the panel it must look different from the item price.
  return `${line} [${scopeNote(item, check.skippedExplicits)}]`
}

/** The tail of the log line: the Faustus rate per unit and per stack and its week, if there is one. */
function faustusText (item: PricedItem, check: PriceCheck): string {
  if (!check.reference) return ''
  const whole = stackPrice(check.reference, item.stackSize?.value)
  const week = check.reference.history ? `, 7 days ${changeText(check.reference.history.change)}` : ''
  return ` | Faustus (poe.ninja): ${rateText(check.reference)}${whole ? `, stack ${item.stackSize!.value}: ${priceValueText(whole)}` : ''}${week}`
}
