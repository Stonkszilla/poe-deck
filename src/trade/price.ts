// Что называется ценой. Одно место на весь проект.
//
// Решение и его цена разобраны в docs/decisions/0004-what-is-price.md; здесь —
// исполнение. Коротко: **медиана первых N листингов в одной валюте**, и рядом
// с числом всегда едет, из скольких листингов оно получено и сколько их всего.
//
// Почему не минимум: первый листинг в выдаче — это чаще всего приманка, ошибка
// в нолях или предмет, которого уже нет. Прайс-чек, который показывает минимум,
// показывает не цену, а самое дешёвое объявление.
//
// Почему не среднее: одно объявление за 500 дивайнов среди девяти по 5 хаосов
// сдвигает среднее до неузнаваемости, а медиану — нет.
//
// Почему «в одной валюте»: выдача трейда смешивает валюты (2 divine, 40 chaos,
// 1 mirror), и складывать их без курса нельзя. Берём ту валюту, в которой
// объявлений больше, и честно говорим, сколько листингов в неё легло.

/** Число и валюта — всё, что нужно строкам курса. Его же отдаёт курс Faustus. */
export interface Rate {
  amount: number
  currency: string
}

export interface Price {
  /** Медиана. */
  amount: number
  /**
   * Цены выборки в той же валюте, по возрастанию — то, из чего сложилась
   * медиана. Одно число разброса не показывает: `15 chaos` и `15 chaos` из
   * `5,10,10,15,15,20,20,25` — разные утверждения о рынке (просьба тестера по
   * прогону #113). Панель печатает первые сколько влезет.
   */
  quotes: number[]
  /** Валюта, в которой медиана посчитана. */
  currency: string
  /** Сколько листингов легло в медиану — они же в одной валюте. */
  sampled: number
  /** Сколько объявлений трейд насчитал всего по запросу. */
  total: number
  /** Самое дешёвое из тех, что легли в медиану. Для оценки разброса. */
  min: number
  /** Были ли среди рассмотренных листинги в других валютах. */
  mixedCurrencies: boolean
  /** Курс это или выборка листингов — ветка видна в ответе, а не только в логе. */
  kind: 'listings' | 'exchange'
}

/**
 * Сколько верхних листингов рассматриваем.
 *
 * Было 10 — и это давало не цену, а дно выдачи: замер на живом трейде (15.09,
 * Ambu's Charge, 55 объявлений) показал первые десять как `1,1,1,1,1,2,5,5,5,10`
 * с медианой 1.5 chaos, при том что медиана двадцати равна 10 chaos. Нижние
 * листинги — приманки, ошибки в нолях и лоты, которых уже нет; чем меньше
 * выборка, тем полнее она из них состоит.
 */
export const SAMPLE_SIZE = 20

/**
 * Какую долю самых дешёвых листингов выбрасываем перед медианой.
 *
 * Те же данные: без отсечки медиана двадцати опускается к 7.5, с отсечкой
 * четверти — 10, и это цена, по которой предмет действительно уходит. Отсечка
 * применяется только к достаточной выборке (см. `withoutBait`), иначе на трёх
 * объявлениях мы выбросили бы единственное настоящее.
 */
const BAIT_SHARE = 0.25

/** Наименьшая выборка, на которой отсечка приманок осмысленна. */
const BAIT_MIN_SAMPLE = 8

/**
 * Округление, переживающее курс валюты. До сотых — для всего, что крупнее
 * единицы; до четырёх значащих — для меньшего. Иначе курс хаоса в дивайнах
 * (0.003125) превращается в ноль, и прайс-чек честно показывает «0 divine».
 */
function round (value: number): number {
  return Math.abs(value) >= 1
    ? Math.round(value * 100) / 100
    : Number(value.toPrecision(4))
}

/** Обратный курс: «183 per 1 divine». От десяти и выше дробь — шум округления прямого курса. */
function inverse (amount: number): number {
  const value = 1 / amount
  return value >= 10 ? Math.round(value) : round(value)
}

/**
 * Отсечка приманок: нижняя четверть отсортированной выборки.
 *
 * Применяется НЕ везде. На рынке `securable` (Instant Buyout) сделка закрывается
 * без продавца, прайсфиксеру там нечего ловить, и отбрасывать нижнюю четверть
 * значит просто завышать (замечание тестера по прогону #113 — верное). Кто именно
 * отсекает, решает вызывающий: `bySearch` включает отсечку только для рынков,
 * где цену держит живой человек.
 *
 * Самое дешёвое объявление всё равно уезжает в `Price.min` — игрок видит, с
 * чего начинается выдача, и отсечка ничего от него не прячет.
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

/** Пары «сколько — чего» → цена. Общая половина обеих веток. */
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
    if (!(amount > 0)) continue // 0 и отрицательные — не цена, а мусор в объявлении
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

/** Ветка поиска: цена берётся из объявлений. */
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
 * Курс обмена — лучший исполнимый, то есть первый с выгодного края.
 *
 * Трейд отдаёт выдачу обмена отсортированной (`sort: { have: 'asc' }`), и в
 * режиме instant buyout каждый курс исполним сразу. Завышенные лоты («1 divine
 * за 1 chaos») висят без сделок, и на тонком рынке их больше, чем честных. Сырая
 * выдача с Deck (лига Covens): Chaos Orb — 14 объявлений, честных два, 183 и 182
 * chaos за divine, дальше девять по «1 за 1». Медиана любой ширины ложится на
 * мусор: пять выгодных тоже дали «1 divine». Поэтому цена — минимум, а не медиана.
 */
export const EXCHANGE_CHEAPEST = 1

/**
 * Ветка обмена: цена — это курс, то есть отношение «сколько дают» к «сколько
 * берут». Объявление `250 chaos за 1 divine` и `500 chaos за 2 divine` — один
 * и тот же курс, и складывать их можно только после деления.
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
 * Само число: сколько и чего. Отделено от контекста, потому что на панели они
 * живут разными кеглями — цена крупно, откуда она взялась мелко (ADR 0003).
 */
export function priceAmountText (price: Rate): string {
  const parts = [`${price.amount} ${price.currency}`]
  // Курс дешёвой валюты в дорогой читается только наизнанку: «0.0031 divine»
  // ни о чём не говорит, «320 per 1 divine» — говорит.
  if (price.amount < 1) parts.push(`(${inverse(price.amount)} per 1 ${price.currency})`)
  return parts.join(' ')
}

/** Откуда число взялось. Без этой половины цена — утверждение, а не замер. */
export function priceScopeText (price: Price): string {
  // Курс обмена — лучший из выдачи, а не медиана: «best of N» и есть его происхождение.
  const line = price.kind === 'exchange'
    ? `best of ${price.total} offers`
    : `median of ${price.sampled}/${price.total}, from ${price.min}`
  return price.mixedCurrencies ? `${line} | other currencies in results` : line
}

/**
 * Сколько объявлений считаем узкой выдачей. Четыре лота на весь трейд — это не
 * цена предмета, а цена четырёх конкретных предметов: прогон #113, Cane of
 * Kulemak с четырьмя включёнными модами дал `37.5 divine` из четырёх лотов при
 * рыночных 6–10. Панель обязана назвать это вслух.
 */
export const NARROW_SAMPLE = 5

/**
 * Разброс словами: где рынок стоит и насколько он широк.
 *
 * Прежний вид — перечисление лотов `5, 10x7, 15x6, 19, 20x5 chaos` — читать на
 * ходу невозможно (тестер, прогон #115: «порнография, неочевидная и не
 * информативная»). Вопрос у игрока один: «сколько за неё дадут и насколько это
 * твёрдо». На него отвечают две величины: коридор, в котором лежит половина
 * лотов (межквартильный), и полный размах выборки.
 *
 *   typical 10-15 · range 5-20
 *   all 20 lots at 1              — когда рынок стоит в одну цену
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

/** Квантиль по отсортированной выборке, ближайший отсчёт. Без интерполяции. */
function quantile (sorted: number[], at: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * at)))
  return sorted[index]!
}

/** Одна строка в лог. Обе половины подряд. */
export function formatPrice (price: Price | undefined): string {
  if (!price) return 'no price: no listings at all'
  return `${priceAmountText(price)} — ${priceScopeText(price)}`
}

/**
 * Курс одной штуки словами, в ту сторону, в какую его читают. Без имени
 * предмета: оно уже в заголовке панели, а длинное имя фрагмента в строку не влезет.
 *
 *   1 chaos each
 *   183 per 1 divine      — дешёвое в дорогом читается наизнанку
 */
export function rateText (price: Rate): string {
  return price.amount >= 1
    ? `${price.amount} ${price.currency} each`
    : `${inverse(price.amount)} per 1 ${price.currency}`
}

/** Число без обратного курса — для строки, где курс стоит отдельно. */
export function priceValueText (price: Rate): string {
  return `${price.amount} ${price.currency}`
}

/**
 * Сколько стоит весь стак. Меньше двух в стаке — считать нечего. Дробь — до двух
 * значащих: «0.11 divine» за двадцать хаосов, а не «0.1093».
 */
export function stackPrice<T extends Rate> (price: T, stack: number | undefined): T | undefined {
  if (!stack || stack < 2) return undefined
  const value = price.amount * stack
  return { ...price, amount: Math.abs(value) >= 1 ? round(value) : Number(value.toPrecision(2)) }
}
