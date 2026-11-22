// Курс внутриигрового Currency Exchange (NPC Faustus) — ориентир рядом с ценой трейда.
//
// Trade API этого рынка не видит: у Faustus свой стакан, и в выдаче instant
// buyout трейда тот же Orb of Scouring стоит в разы иначе. Замер 20.11, лига
// Covens: трейд дал стак 30 за 10 chaos, у Faustus в игре курс 1 : 1.39, то есть
// около 22 chaos за стак.
//
// Источник — poe.ninja: он собирает Currency Exchange через API GGG и отдаёт
// сводку без ключа. Сам API GGG (`/currency-exchange`) требует OAuth-приложения
// со scope `service:cxapi` и без него отвечает 401 — игроку его не получить.
//
// Ориентир, а не цена: число — сводка poe.ninja по сделкам, а не стакан,
// который можно исполнить сейчас. Ошибка источника цену не ломает — ориентира
// просто нет, и об этом пишет журнал.

import { tradeFetch } from './client'
import type { Rate } from './price'
import type { PricedItem } from './query'

export const NINJA_EXCHANGE = 'https://poe.ninja/poe1/api/economy/exchange/current/overview'

/**
 * Разделы сводки, в которых ищем предмет, по порядку. Валюта первой: за ней
 * приходят почти все нажатия, и тогда запрос один. Остальные спрашиваются, только
 * если предмета не нашлось раньше, и каждый живёт в кэше своё время.
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
 * Сколько ждём poe.ninja. Меньше, чем трейд: запрос идёт параллельно с ценой,
 * и ориентир не имеет права задержать её на экране.
 */
export const NINJA_TIMEOUT_MS = 4_000

/** Cloudflare перед poe.ninja держит сводку 30 минут — чаще спрашивать незачем. */
const NINJA_TTL_MS = 30 * 60_000

export interface ExchangeOverview {
  core?: { primary?: string, secondary?: string, rates?: Record<string, number> }
  lines?: Array<{ id: string, primaryValue?: number, volumePrimaryValue?: number }>
  items?: Array<{ id: string, name?: string | null }>
}

/** Курс Faustus за одну штуку. */
export interface ExchangeReference extends Rate {
  /** Оборот по сводке в её основной валюте: ноль — курс никто не исполнял. */
  volume: number
}

/**
 * Предмет в сводке. Id строк poe.ninja совпадают с тегами обмена трейда
 * (`scour`, `chaos`, `divine`) — сначала по тегу, потом по английскому имени:
 * у фрагментов теги и id расходятся.
 *
 * Основная валюта сводки (chaos) сама себе стоит 1, поэтому её курс берётся во
 * второй валюте: «chaos за divine», как и у трейда.
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
  if (line.id === primary && secondary) {
    const rate = overview.core?.rates?.[secondary]
    return rate! > 0 ? { amount: rate!, currency: secondary, volume } : undefined
  }
  return { amount: line.primaryValue!, currency: primary, volume }
}

const cache = new Map<string, { at: number, overview: ExchangeOverview }>()

/** Тесты начинают с пустого кэша, как и новый запуск демона. */
export function resetNinjaCache (): void {
  cache.clear()
}

/**
 * Сводка одного раздела по лиге. Неизвестная лига у poe.ninja — не ошибка, а
 * пустой список, и он тоже кэшируется: спрашивать его снова через минуту незачем.
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
 * Курс Faustus для предмета или `undefined`. Не бросает: ориентир — добавка к
 * цене, и его беда (сеть, таймаут, новая форма ответа) остаётся в журнале.
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
