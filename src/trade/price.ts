// What we call a price. One place for the whole project.
//
// The decision and its cost are in docs/decisions/0004-what-is-price.md; this is
// the implementation. In short: **the median of the first N listings in one currency**, and
// next to the number we always give how many listings it came from and how many there are in total.
//
// Why not the minimum: the first listing in the results is most often bait, a typo
// in the zeros or an item that is already gone. A price check that shows the minimum
// shows not the price but the cheapest listing.
//
// Why not the mean: one listing for 500 divines among nine for 5 chaos
// moves the mean beyond recognition, but not the median.
//
// Why "in one currency": trade results mix currencies (2 divine, 40 chaos,
// 1 mirror), and we cannot add them without a rate. We take the currency with
// more listings and say honestly how many listings went into it.

/** A number and a currency: all that the rate lines need. The Faustus rate returns the same. */
export interface Rate {
  amount: number
  currency: string
}

export interface Price {
  /** The median. */
  amount: number
  /**
   * Sample prices in the same currency, ascending: what the median came
   * from. One number does not show the spread: `15 chaos` and `15 chaos` from
   * `5,10,10,15,15,20,20,25` are different claims about the market (a tester request after
   * run #113). The panel prints as many of the first ones as fit.
   */
  quotes: number[]
  /** The currency of the median. */
  currency: string
  /** How many listings went into the median; they are all in one currency. */
  sampled: number
  /** How many listings trade counted in total for the query. */
  total: number
  /** The cheapest of the listings in the median. For a view of the spread. */
  min: number
  /** Whether the listings we looked at included other currencies. */
  mixedCurrencies: boolean
  /** A rate or a listing sample: the branch is visible in the answer, not only in the log. */
  kind: 'listings' | 'exchange'
}

/**
 * How many top listings we look at.
 *
 * It was 10, and that gave not the price but the bottom of the results: a measurement on live trade (15.09,
 * Ambu Charge, 55 listings) showed the first ten as `1,1,1,1,1,2,5,5,5,10`
 * with a median of 1.5 chaos, while the median of twenty is 10 chaos. The bottom
 * listings are bait, typos in the zeros and lots that are already gone; the smaller
 * the sample, the more of it they make up.
 */
export const SAMPLE_SIZE = 20

/**
 * What share of the cheapest listings we drop before the median.
 *
 * Same data: without the cut, the median of twenty drops to 7.5; with a cut of one
 * quarter it is 10, and that is the price at which the item really sells. The cut
 * applies only to a large enough sample (see `withoutBait`), otherwise with three
 * listings we would drop the only real one.
 */
const BAIT_SHARE = 0.25

/** The smallest sample on which the bait cut makes sense. */
const BAIT_MIN_SAMPLE = 8

/**
 * Rounding that survives a currency rate. To hundredths for everything larger than
 * one; to four significant digits for smaller values. Otherwise the chaos rate in divines
 * (0.003125) becomes zero, and the price check honestly shows "0 divine".
 */
function round (value: number): number {
  return Math.abs(value) >= 1
    ? Math.round(value * 100) / 100
    : Number(value.toPrecision(4))
}

/** Inverse rate: "183 per 1 divine". From ten and up, a fraction is rounding noise of the direct rate. */
function inverse (amount: number): number {
  const value = 1 / amount
  return value >= 10 ? Math.round(value) : round(value)
}

/**
 * Bait cut: the bottom quarter of the sorted sample.
 *
 * It does NOT apply everywhere. On the `securable` market (Instant Buyout) a deal closes
 * without the seller, a price fixer has nothing to gain there, and to drop the bottom quarter
 * only inflates the price (a tester remark after run #113, and a correct one). The caller decides
 * who cuts: `bySearch` turns the cut on only for markets
 * where a live human holds the price.
 *
 * The cheapest listing still goes into `Price.min`: the player sees where
 * the results start, and the cut hides nothing from them.
 */
function withoutBait (sorted: number[]): number[] {
  if (sorted.length < BAIT_MIN_SAMPLE) return sorted
  return sorted.slice(Math.floor(sorted.length * BAIT_SHARE))
}

function median (sorted: number[]): number {
  const mid = sorted.length >> 1
  const value = (sorted.length % 2)
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2
  return round(value)
}

/** Pairs "how much, of what" → price. The shared half of both branches. */
function summarize (
  quotes: Array<{ amount: number, currency: string }>,
  total: number,
  kind: Price['kind'],
  dropBait = true,
  cheapest = Infinity
): Price | undefined {
  if (!quotes.length) return undefined

  const byCurrency = new Map<string, number[]>()
  for (const { amount, currency } of quotes) {
    if (!(amount > 0)) continue // 0 and negative values are not a price but junk in the listing
    const bucket = byCurrency.get(currency)
    if (bucket) bucket.push(amount)
    else byCurrency.set(currency, [amount])
  }
  if (!byCurrency.size) return undefined

  const [currency, amounts] = [...byCurrency.entries()]
    .sort((a, b) => b[1].length - a[1].length)[0]!
  amounts.sort((a, b) => a - b)
  const priced = (dropBait ? withoutBait(amounts) : amounts).slice(0, cheapest)

  return {
    amount: median(priced),
    quotes: amounts.map(round),
    currency,
    sampled: priced.length,
    total,
    min: round(amounts[0]!),
    mixedCurrencies: byCurrency.size > 1,
    kind
  }
}

export interface Listing {
  listing?: { price?: { amount: number, currency: string } | null }
}

/** Search branch: the price comes from the listings. */
export function priceFromListings (
  listings: Listing[],
  total: number,
  take = SAMPLE_SIZE,
  opts: { dropBait?: boolean } = {}
): Price | undefined {
  const quotes = listings
    .slice(0, take)
    .map(entry => entry.listing?.price)
    .filter((price): price is { amount: number, currency: string } => price != null)

  return summarize(quotes, total, 'listings', opts.dropBait ?? true)
}

export interface ExchangeEntry {
  listing?: {
    offers?: Array<{
      exchange: { currency: string, amount: number }
      item: { amount: number, stock: number }
    }>
  }
}

/**
 * The exchange rate is the best executable one, that is, the first from the good end.
 *
 * Trade returns exchange results sorted (`sort: { have: 'asc' }`), and in
 * instant buyout mode every rate executes at once. Inflated lots ("1 divine
 * for 1 chaos") sit without deals, and on a thin market there are more of them than honest ones. Raw
 * results from the Deck (league Covens): Chaos Orb, 14 listings, two honest, 183 and 182
 * chaos per divine, then nine at "1 for 1". A median of any width lands on
 * junk: the five best also gave "1 divine". So the price is the minimum, not the median.
 */
export const EXCHANGE_CHEAPEST = 1

/**
 * Exchange branch: the price is a rate, that is, the ratio of "how much they give" to "how much
 * they take". The listings `250 chaos for 1 divine` and `500 chaos for 2 divine` are one
 * and the same rate, and we can combine them only after the division.
 */
export function priceFromExchange (
  entries: ExchangeEntry[],
  total: number,
  take = SAMPLE_SIZE
): Price | undefined {
  const quotes: Array<{ amount: number, currency: string }> = []

  for (const entry of entries.slice(0, take)) {
    const offer = entry.listing?.offers?.[0]
    if (!offer || !(offer.item.amount > 0)) continue
    quotes.push({
      amount: offer.exchange.amount / offer.item.amount,
      currency: offer.exchange.currency
    })
  }

  return summarize(quotes, total, 'exchange', false, EXCHANGE_CHEAPEST)
}

/**
 * The number itself: how much and of what. It is separate from the context, because on the panel they
 * use different font sizes: the price is large, where it came from is small (ADR 0003).
 */
export function priceAmountText (price: Rate): string {
  const parts = [`${price.amount} ${price.currency}`]
  // A rate of a cheap currency in an expensive one reads only inverted: "0.0031 divine"
  // says nothing, "320 per 1 divine" says something.
  if (price.amount < 1) parts.push(`(${inverse(price.amount)} per 1 ${price.currency})`)
  return parts.join(' ')
}

/** Where the number came from. Without this half, the price is a claim, not a measurement. */
export function priceScopeText (price: Price): string {
  // The exchange rate is the best of the results, not a median: "best of N" is its origin.
  const line = price.kind === 'exchange'
    ? `best of ${price.total} offers`
    : `median of ${price.sampled}/${price.total}, from ${price.min}`
  return price.mixedCurrencies ? `${line} | other currencies in results` : line
}

/**
 * How many listings count as narrow results. Four lots on the whole trade are not
 * the price of the item but the price of four specific items: run #113, Cane of
 * Kulemak with four enabled mods gave `37.5 divine` from four lots while
 * the market was at 6–10. The panel must say this out loud.
 */
export const NARROW_SAMPLE = 5

/**
 * The spread in words: where the market is and how wide it is.
 *
 * The old view, a list of lots `5, 10x7, 15x6, 19, 20x5 chaos`, is impossible to read
 * on the go (tester, run #115: "a mess, not obvious and not
 * informative"). The player has one question: "how much will I get for it and how
 * firm is that". Two values answer it: the band that holds half of the
 * lots (interquartile), and the full range of the sample.
 *
 *   typical 10-15 · range 5-20
 *   all 20 lots at 1              — when the whole market is at one price
 */
export function priceSpreadText (price: Price): string {
  const quotes = price.quotes
  if (quotes.length < 2) return ''

  const low = quantile(quotes, 0.25)
  const high = quantile(quotes, 0.75)
  const min = quotes[0]!
  const max = quotes.at(-1)!

  if (min === max) return `all ${quotes.length} lots at ${min} ${price.currency}`

  const core = low === high
    ? `most at ${low}`
    : `typical ${low}-${high}`
  return `${core} · range ${min}-${max} ${price.currency}`
}

/** Quantile of a sorted sample, nearest rank. No interpolation. */
function quantile (sorted: number[], at: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * at)))
  return sorted[index]!
}

/** One line for the log. Both halves in a row. */
export function formatPrice (price: Price | undefined): string {
  if (!price) return 'no price: no listings at all'
  return `${priceAmountText(price)} — ${priceScopeText(price)}`
}

/**
 * The rate of one unit in words, in the direction people read it. Without the item
 * name: it is already in the panel title, and a long fragment name does not fit the line.
 *
 *   1 chaos each
 *   183 per 1 divine      — a cheap currency in an expensive one reads inverted
 */
export function rateText (price: Rate): string {
  return price.amount >= 1
    ? `${price.amount} ${price.currency} each`
    : `${inverse(price.amount)} per 1 ${price.currency}`
}

/** The number without the inverse rate, for a line where the rate stands separately. */
export function priceValueText (price: Rate): string {
  return `${price.amount} ${price.currency}`
}

/**
 * What the whole stack costs. Fewer than two in the stack: nothing to compute. A fraction gets two
 * significant digits: "0.11 divine" for twenty chaos, not "0.1093".
 */
export function stackPrice<T extends Rate> (price: T, stack: number | undefined): T | undefined {
  if (!stack || stack < 2) return undefined
  const value = price.amount * stack
  return { ...price, amount: Math.abs(value) >= 1 ? round(value) : Number(value.toPrecision(2)) }
}

/** A change in percent with its sign, ASCII only (Noto Sans, ADR 0003 F4): `-16.4%`, `+142%`. */
export function changeText (change: number): string {
  const size = Math.abs(change)
  const shown = size < 10 ? size.toFixed(1) : String(Math.round(size))
  if (Number(shown) === 0) return '0%'
  return `${change > 0 ? '+' : '-'}${shown}%`
}
