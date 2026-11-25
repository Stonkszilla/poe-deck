// Player config: one file `~/.config/poe-deck/poe-deck.conf`.
//
// The environment variables from docs/ops/deck-daemon.md stay: job runs and
// debugging over SSH use them. The player cannot use them: the player does not
// edit the `systemd --user` unit, and Game Mode has no terminal at all. So the
// player gets a file that any editor can change in Desktop Mode.
//
// Precedence: environment variable > config > default. A job run must
// reproduce no matter what is in $HOME on the Deck.
//
// The format is `key = value` with `#` comments, not TOML. A person without
// experience edits the file, and an error must name the line: `Bun.TOML.parse`
// answers "line 2" for the one line `foo bar`, and line zero for a missing value.
// Our own grammar for three keys is shorter than a wrapper that fixes another one.

import { existsSync, readFileSync } from 'node:fs'
import { parseSearchMode, type SearchMode } from './trade/query'

export interface Settings {
  /** Trade league. If absent, the current softcore trade league from `/api/leagues`. */
  league?: string
  /** Default price market. */
  priceMode?: SearchMode
  /** How many seconds to keep the panel on screen. */
  panelTtl?: number
}

/** File keys → settings field. The order is the order in the error hint. */
const KEYS = {
  league: 'league',
  price_mode: 'priceMode',
  panel_ttl: 'panelTtl'
} as const satisfies Record<string, keyof Settings>

type Key = keyof typeof KEYS

/** TTL limit: after ten minutes the panel is not a "price" but a forgotten window. */
const TTL_MAX = 600

/** Parse result: settings and per-line errors. An error does not drop the rest. */
export interface ParsedConfig {
  settings: Settings
  errors: string[]
}

/** Config directory: `$XDG_CONFIG_HOME/poe-deck`, else `~/.config/poe-deck`. */
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
 * File text → settings. Each line is parsed on its own: a typo in one key
 * does not cancel the league in the next one, it is reported with its line number.
 * An empty value (`league =`) is the same as no line: so in the example,
 * "uncommented and erased" does not become an error.
 */
export function parseConfig (text: string): ParsedConfig {
  const settings: Settings = {}
  const errors: string[] = []
  const seen = new Set<string>()

  text.split('\n').forEach((source, index) => {
    const at = `line ${index + 1}`
    // A comment starts at the line start or after a space: a league name has no `#`,
    // and we do not count `a#b` without a space as a comment.
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

/** What was read from disk: the path, whether the file existed, and the parse. */
export interface LoadedConfig extends ParsedConfig {
  path: string
  exists: boolean
}

/**
 * The file from disk. No file is not an error: defaults are the first run. If the
 * file exists but cannot be read (a directory instead of a file, permissions), the
 * error is in words, not a stack trace from `readFileSync`.
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
 * Environment over the config. Variable errors go to the same list as file
 * errors: the player or the run sees both the same way, as a line with a reason.
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
