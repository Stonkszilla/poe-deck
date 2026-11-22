// Конфиг игрока: один файл `~/.config/poe-deck/poe-deck.conf`.
//
// Переменные окружения из docs/ops/deck-daemon.md остаются — ими живут прогоны
// джоба и отладка из SSH. Игроку они недоступны: юнит `systemd --user` он не
// правит, а в Game Mode нет даже терминала. Поэтому для игрока — файл, который
// правится в Desktop Mode любым редактором.
//
// Старшинство: переменная окружения > конфиг > умолчание. Прогон джоба обязан
// воспроизводиться независимо от того, что лежит в $HOME у Deck.
//
// Формат — `ключ = значение` с комментариями `#`, а не TOML. Файл правит человек
// без опыта, и ошибка обязана называть строку: `Bun.TOML.parse` на одной строке
// `foo bar` отвечает «line 2», а на отсутствующем значении — нулевой строкой.
// Своя грамматика на три ключа короче, чем обёртка, которая исправляет чужую.

import { existsSync, readFileSync } from 'node:fs'
import { parseSearchMode, type SearchMode } from './trade/query'

export interface Settings {
  /** Лига trade. Нет — текущая софткор trade-лига из `/api/leagues`. */
  league?: string
  /** Рынок цены по умолчанию. */
  priceMode?: SearchMode
  /** Сколько секунд держать панель на экране. */
  panelTtl?: number
}

/** Ключи файла → поле настроек. Порядок — порядок в подсказке об ошибке. */
const KEYS = {
  league: 'league',
  price_mode: 'priceMode',
  panel_ttl: 'panelTtl'
} as const satisfies Record<string, keyof Settings>

type Key = keyof typeof KEYS

/** Предел TTL: дольше десяти минут панель висит уже не «цена», а забытое окно. */
const TTL_MAX = 600

/** Результат разбора: настройки и ошибки по строкам. Ошибка не роняет остальное. */
export interface ParsedConfig {
  settings: Settings
  errors: string[]
}

/** Каталог конфига: `$XDG_CONFIG_HOME/poe-deck`, иначе `~/.config/poe-deck`. */
export function configDir (env = process.env): string {
  return `${env.XDG_CONFIG_HOME || `${env.HOME}/.config`}/poe-deck`
}

export function configPath (env = process.env): string {
  return `${configDir(env)}/poe-deck.conf`
}

function value (key: Key, raw: string): Settings[keyof Settings] {
  switch (key) {
    case 'league':
      return raw
    case 'price_mode':
      return parseSearchMode(raw)
    case 'panel_ttl': {
      const seconds = Number(raw)
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > TTL_MAX) {
        throw new Error(`"${raw}" is not a number of seconds from 1 to ${TTL_MAX}`)
      }
      return seconds
    }
  }
}

/**
 * Текст файла → настройки. Каждая строка разбирается сама по себе: опечатка в
 * одном ключе не отменяет лигу в соседнем, а называется со своим номером.
 * Пустое значение (`league =`) — то же, что строки нет: так в примере
 * «раскомментировал и стёр» не превращается в ошибку.
 */
export function parseConfig (text: string): ParsedConfig {
  const settings: Settings = {}
  const errors: string[] = []
  const seen = new Set<string>()

  text.split('\n').forEach((source, index) => {
    const at = `line ${index + 1}`
    // Комментарий — с начала строки или после пробела: в имени лиги `#` не
    // встречается, а `a#b` без пробела комментарием не считаем.
    const line = source.replace(/(^|\s)#.*$/, '').trim()
    if (!line) return

    const eq = line.indexOf('=')
    if (eq < 1) {
      errors.push(`${at}: expected "key = value", got "${line}"`)
      return
    }
    const key = line.slice(0, eq).trim()
    const raw = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')

    if (!Object.hasOwn(KEYS, key)) {
      errors.push(`${at}: unknown key "${key}" — known keys: ${Object.keys(KEYS).join(', ')}`)
      return
    }
    if (seen.has(key)) {
      errors.push(`${at}: "${key}" is set twice — keep one line`)
      return
    }
    seen.add(key)
    if (!raw) return

    try {
      Object.assign(settings, { [KEYS[key as Key]]: value(key as Key, raw) })
    } catch (err) {
      errors.push(`${at}: ${key}: ${(err as Error).message}`)
    }
  })

  return { settings, errors }
}

/** Что прочитано с диска: путь, был ли файл, и разбор. */
export interface LoadedConfig extends ParsedConfig {
  path: string
  exists: boolean
}

/**
 * Файл с диска. Нет файла — не ошибка: умолчания и есть первый запуск. Файл
 * есть, но не читается (каталог вместо файла, права) — ошибка словами, а не
 * стектрейс из `readFileSync`.
 */
export function loadConfig (path = configPath()): LoadedConfig {
  if (!existsSync(path)) return { path, exists: false, settings: {}, errors: [] }
  try {
    return { path, exists: true, ...parseConfig(readFileSync(path, 'utf8')) }
  } catch (err) {
    return { path, exists: true, settings: {}, errors: [`cannot read the file: ${(err as Error).message}`] }
  }
}

/**
 * Окружение поверх конфига. Ошибки переменных — в тот же список, что ошибки
 * файла: и то и другое игрок или прогон увидит одинаково, строкой с причиной.
 */
export function effectiveSettings (file: Settings, env = process.env): ParsedConfig {
  const errors: string[] = []
  const out: Settings = { ...file }
  if (env.POE_DECK_LEAGUE) out.league = env.POE_DECK_LEAGUE
  try {
    const mode = parseSearchMode(env.POE_DECK_PRICE_MODE)
    if (mode) out.priceMode = mode
  } catch (err) {
    errors.push(`POE_DECK_PRICE_MODE: ${(err as Error).message}`)
  }
  if (env.POE_DECK_PANEL_TTL) {
    try {
      out.panelTtl = value('panel_ttl', env.POE_DECK_PANEL_TTL) as number
    } catch (err) {
      errors.push(`POE_DECK_PANEL_TTL: ${(err as Error).message}`)
    }
  }
  return { settings: out, errors }
}
