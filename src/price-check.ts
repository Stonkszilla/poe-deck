// Прайс-чек целиком: разобранный предмет → цена. Сеть здесь, решения — рядом
// (src/trade/query.ts — какой запрос, src/trade/price.ts — что считать ценой).
//
// Оверлея тут нет намеренно: цена возвращается структурой и печатается строкой.
// Кто её покажет — демон, панель или лог прогона — этот файл не знает.

import { currentLeague, exchange, fetchResults, search } from './trade/client'
import {
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
 * Оговорка «к чему относится эта цена». Одна на панель и журнал — расхождение
 * между тем, что видит игрок, и тем, что записано в лог, стоило бы разбора.
 *
 * У уникала она звучит иначе намеренно: тиров у его врождённых модов нет вовсе,
 * и «все 5 модов ниже тира 2» было бы неправдой (прогон #107). Уникал ищется
 * именем и базой — это цена ИМЕННО ЭТОГО предмета, просто без разбора роллов.
 */
export function scopeNote (item: PricedItem, skipped: number): string {
  if (item.rarity === 'Unique') return `by name, rolls ignored (${skipped} mods)`
  return statFilters(item).some(stat => !isPropertyFilter(stat.id))
    ? `${skipped} mods outside the filter`
    : `base price: all ${skipped} mods below tier 2`
}

export interface PriceCheck {
  /** Какой веткой пошли. Развилка видна в ответе, а не только в логе. */
  fork: 'search' | 'exchange'
  league: string
  price?: Price
  /** Курса не нашлось и мы ушли в объявления. Не ошибка, но знать полезно. */
  fellBackToSearch?: boolean
  /**
   * Explicit-моды, не попавшие в фильтр (все ниже тира 2). Если их много, а в
   * фильтре пусто — найдена цена базы, а не этого предмета. Число видно снаружи,
   * потому что молчать об этом значит показать чужую цену как свою.
   */
  skippedExplicits: number
  /**
   * Режим, в котором цена действительно найдена. Может отличаться от заказанного:
   * пустая выдача — повод переспросить у рынка шире, но не повод молчать о том,
   * что показанное число уже про другой рынок.
   */
  mode: SearchMode
  /** Заказывали один режим, ответил другой — на панели это говорится вслух. */
  fellBackToMode?: boolean
  /**
   * Фильтры, заданные игроком в редакторе. Есть — цена относится
   * именно к этому набору, и панель обязана сказать об этом: то же название
   * предмета с другим набором фильтров стоит других денег. Нет — искали
   * автоматическим набором, как до редактора.
   */
  manualStats?: StatEntryFilter[]
  /**
   * Курс внутриигрового Currency Exchange (Faustus) по poe.ninja — только у
   * ветки обмена. Трейд этого рынка не видит, и цены расходятся в разы, поэтому
   * панель показывает оба числа. Нет — источник молчит, цена от этого не меняется.
   */
  reference?: ExchangeReference
}

/** Предел API: не больше десяти объявлений за один `fetch`. */
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

  // Пустая выдача в узком режиме — не «такого не существует». Замер на живом
  // трейде (15.09): Ambu's Charge с имплицитом Death Aura — ноль при `online`
  // и 125 объявлений при `any`. Ровно это в прогоне #109 выглядело как «поиск
  // по моду не работает». Второй запрос стоит одного лимита SEARCH и делается
  // только когда первый пуст.
  if (!found.result.length && mode !== 'any') {
    status = 'any'
    try {
      found = await search(buildSearchQuery(item, { stats, status }), league)
    } catch {
      // Второй запрос — вежливость, а не обязанность: упереться в лимит на нём
      // значит остаться без ответа там, где первый ответ уже есть.
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
    // Инстант-баяут закрывает сделку без продавца, и держать там приманку
    // бессмысленно — отсечка нижней четверти на этом рынке только завышает
    // (замечание тестера по прогону #113). На рынках, где цену держит живой
    // человек, она остаётся.
    price: priceFromListings(listings, found.total, undefined, { dropBait: status !== 'securable' }),
    mode: status,
    ...(status === mode ? {} : { fellBackToMode: true })
  }
}

/**
 * Цена предмета. Ветка выбирается по самому предмету: моды есть — ищем по ним,
 * модов нет — курс валюты или объявления по имени и базе.
 *
 * `opts.stats` — набор фильтров, подтверждённый игроком в редакторе. Он уезжает
 * в запрос как есть и возвращается в ответе: цена без своего набора фильтров —
 * число без предмета. Пустой массив — тоже выбор игрока («без стат-фильтров»),
 * и развилку он не меняет: у редкого предмета это цена базы, а не курс обмена.
 *
 * Пустой результат — это `price: undefined`, а не исключение: «такого сейчас
 * никто не продаёт» — законный ответ трейда, и наверх он должен уехать таким же.
 */
/**
 * Куда складывать тела уходящих запросов. Приёмка эпика требует сверить то, что
 * игрок выбрал на экране, с тем, что реально уехало в трейд, — по логу этого не
 * сделать: он печатает id фильтров, но не границы и не остальные поля запроса.
 * Пусто — не складывать (обычная игра ничего на диск не пишет).
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
 * Сколько живёт ответ на одно тело запроса. Лимит трейда упирается в SEARCH
 * (5 за 10 с, 15 за минуту), а не в FETCH: в прогоне #143 все семь отказов дал
 * наш лимитер на поиске, сервер не отказал ни разу. Из 28 автозапросов того же
 * прогона разных тел было 10 — игрок жмёт кнопку на том же предмете снова, и
 * каждое нажатие стоило поиска и двух страниц FETCH. Три минуты — меньше, чем
 * рынок успевает сдвинуть цену, и больше, чем игрок сверяет один предмет.
 */
const CACHE_TTL_MS = 3 * 60_000

/**
 * Ответ рынка без того, что принадлежит самому вызову. Набор игрока и число
 * пропущенных модов берутся из текущего нажатия: у уникала без статов
 * автоматическая оценка и подтверждённый редактор с `stats: []` дают одно тело
 * запроса, но вторая цена обязана сказать «player filters», а первая — нет.
 */
type MarketAnswer = Omit<PriceCheck, 'skippedExplicits' | 'manualStats'>

const cache = new Map<string, { at: number, market: MarketAnswer }>()

/** Тесты начинают с пустого кэша, как и новый запуск демона. */
export function resetPriceCache (): void {
  cache.clear()
}

/**
 * Ключ — лига и тело первого запроса ветки. Тело уже содержит всё, от чего
 * зависит ответ: базу, тир, флаги карты, режим рынка и набор фильтров игрока.
 * Два предмета с одним телом получают у трейда один ответ — и у нас тоже.
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

  // Ошибка (лимит, сеть) в кэш не попадает: она уходит исключением мимо записи.
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

/** Ответ рынка плюс то, что принадлежит этому нажатию, а не прошлому. */
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
    // Курс Faustus идёт параллельно с трейдом и не бросает: ориентир не имеет
    // права ни задержать цену, ни отменить её своей ошибкой.
    const faustus = exchangeReference(item, league)
    const found = await exchange<ExchangeEntry>(buildExchangeQuery(item, { status: mode }), league)
    const price = priceFromExchange(Object.values(found.result), found.total)
    const reference = await faustus
    const withReference = reference ? { ...base, reference } : base
    if (price) return { ...withReference, price }

    // Курса нет — так бывает на старте лиги и у валюты, которую на обмен просто
    // не выставляют. Объявления при этом есть, и они тоже цена.
    return { ...withReference, ...await bySearch(item, league, stats, mode), fellBackToSearch: true }
  }

  return { ...base, ...await bySearch(item, league, stats, mode) }
}

/** Строка результата: что за предмет, какой веткой шли, сколько стоит. */
export function formatPriceCheck (item: PricedItem, check: PriceCheck): string {
  const name = [item.info.name, item.info.refName]
    .filter((part, index, all) => part && all.indexOf(part) === index)
    .join(' / ')
  const via = check.fellBackToSearch
    ? 'exchange -> listings'
    : (check.fork === 'exchange' ? 'exchange' : 'listings')

  // Тир карты — часть того, что искали: в журнале T14 и T16 иначе неразличимы.
  const tier = item.mapTier != null ? ` T${item.mapTier}` : ''
  const whole = check.price ? stackPrice(check.price, item.stackSize?.value) : undefined
  const stack = whole ? ` | stack ${item.stackSize!.value}: ${priceAmountText(whole)}` : ''
  const line = `${name}${tier} [${check.league}, ${MODE_LABEL[check.mode]}, ${via}]: ${formatPrice(check.price)}${stack}${faustusText(item, check)}`

  // Набор игрока называется вслух и в журнале: по нему потом сверяют тело
  // запроса с тем, что было выбрано на экране (приёмка редактора фильтров).
  if (check.manualStats) {
    return `${line} [player filters: ${check.manualStats.length}]`
  }
  if (check.fork === 'exchange' || !check.skippedExplicits) return line

  // Явная оговорка вместо тихого «цена такая». Пустой фильтр при пяти модах —
  // это цена базы, и на панели она обязана выглядеть иначе, чем цена предмета.
  return `${line} [${scopeNote(item, check.skippedExplicits)}]`
}

/** Хвост строки журнала: курс Faustus за штуку и за стак, если он есть. */
function faustusText (item: PricedItem, check: PriceCheck): string {
  if (!check.reference) return ''
  const whole = stackPrice(check.reference, item.stackSize?.value)
  return ` | Faustus (poe.ninja): ${rateText(check.reference)}${whole ? `, stack ${item.stackSize!.value}: ${priceValueText(whole)}` : ''}`
}
