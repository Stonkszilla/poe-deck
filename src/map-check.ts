// Map check: a copied map to its mods, each marked deadly, warning or good.
//
// The player looks at a map and decides whether to run it. The price does not help
// with that decision: "Monsters reflect 18% of Physical Damage" kills a physical
// build no matter what the map costs. So for a map with mods the panel shows this
// check instead of the price.
//
// The marks come from a profile, and the profile is data, not code: a text file
// `mark = pattern` that the player edits in Desktop Mode like `poe-deck.conf`. The
// default ships embedded in the executable (`map-check.default.txt`). A file
// `~/.config/poe-deck/map-check.profile` replaces it whole.
//
// The mods are read from the clipboard text, not from the donor parser: the advanced
// description already gives every explicit mod its own `{ Prefix Modifier … }`
// header, and a mod is the unit the player judges. The donor maps lines to stat ids,
// which is what trade needs, but a profile written by a person names the text the
// person sees. So a pattern matches the normalized line: lower case, numbers as `#`.
//
// The idea comes from Waytrade (GPL-3.0); the code here is our own.

import { existsSync, readFileSync } from 'node:fs'
import { configDir } from './config'
import DEFAULT_PROFILE_TEXT from './map-check.default.txt'

export type Mark = 'deadly' | 'warning' | 'good'

/** Marks from worst to best. A mod with lines of two marks takes the worst one. */
export const MARKS: readonly Mark[] = ['deadly', 'warning', 'good']

export interface ProfileRule { mark: Mark, pattern: string }

export interface Profile {
  /** Where the rules came from: `default` or the file path. Goes to the panel footer and the log. */
  source: string
  rules: ProfileRule[]
}

/** One explicit mod of the map: its lines as the player reads them. */
export interface MapMod {
  /** `prefix`, `suffix` or `unique`: from the header, for the log. */
  kind: string
  /** Lines without roll ranges, tails and reminder text. */
  lines: string[]
  mark?: Mark
  /** The rule that gave the mark. The log names it, so that a wrong mark is traced to its line. */
  rule?: ProfileRule
}

export interface MapCheck {
  /** Rare or unique name, if the map has one. */
  name?: string
  /** Base line: `Map (Tier 16)`, `Shaper Guardian Map`. */
  base: string
  rarity?: string
  mods: MapMod[]
  profile: string
}

// ── profile ──────────────────────────────────────────────────────────────────

/** Mod line → the text a pattern is matched against. */
export function matchKey (line: string): string {
  return line.toLowerCase().replace(/\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim()
}

/**
 * Profile text → rules and per-line errors, the same way as `parseConfig`: a typo in
 * one line is reported with its number and does not drop the others.
 *
 * Comments start only at the line start: `#` inside a pattern is a number
 * (`deadly = reflect #% of physical damage`).
 */
export function parseProfile (text: string, source = 'default'): { profile: Profile, errors: string[] } {
  const rules: ProfileRule[] = []
  const errors: string[] = []

  text.split('\n').forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const at = `line ${index + 1}`
    const eq = line.indexOf('=')
    if (eq < 1) {
      errors.push(`${at}: expected "mark = pattern", got "${line}"`)
      return
    }
    const mark = line.slice(0, eq).trim().toLowerCase()
    const pattern = matchKey(line.slice(eq + 1))
    if (!(MARKS as readonly string[]).includes(mark)) {
      errors.push(`${at}: unknown mark "${mark}" — known marks: ${MARKS.join(', ')}`)
      return
    }
    if (!pattern) {
      errors.push(`${at}: ${mark}: empty pattern`)
      return
    }
    rules.push({ mark: mark as Mark, pattern })
  })

  return { profile: { source, rules }, errors }
}

export function profilePath (env = process.env): string {
  return `${configDir(env)}/map-check.profile`
}

/** The embedded default. It is also what `poe-deck map-profile` prints for the player to copy. */
export const DEFAULT_PROFILE_SOURCE: string = DEFAULT_PROFILE_TEXT

export function defaultProfile (): Profile {
  return parseProfile(DEFAULT_PROFILE_SOURCE).profile
}

/**
 * The player profile if there is one, else the default. A file with errors still
 * applies the lines that parsed: it is the player's choice, and half of it is
 * closer to that choice than the default is.
 */
export function loadProfile (path = profilePath()): { profile: Profile, errors: string[] } {
  if (!existsSync(path)) return { profile: defaultProfile(), errors: [] }
  try {
    return parseProfile(readFileSync(path, 'utf8'), path)
  } catch (err) {
    return { profile: defaultProfile(), errors: [`cannot read ${path}: ${(err as Error).message} — using the default profile`] }
  }
}

// ── clipboard ────────────────────────────────────────────────────────────────

const SEPARATOR = '--------'
const MOD_HEADER = /^\{ (Prefix|Suffix|Unique) Modifier\b/

/**
 * One mod line as the player reads it. The game writes the roll range next to the
 * value (`35(31-35)%`), a `— Unscalable Value` tail and `(...)` for a cut name;
 * none of it changes what the mod does.
 */
export function cleanLine (line: string): string {
  return line
    .replace(/(\d+(?:\.\d+)?)\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g, '$1')
    .replace(/\s+— Unscalable Value$/, '')
    .replace(/\(\.\.\.\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Reminder text the game puts under a mod: `(Enfeeble is a Hex which …)`. */
const isReminder = (line: string): boolean => /^\(.*\)$/.test(line)

/**
 * The map from the clipboard, without marks. `undefined` when the clipboard is not a map:
 * the caller goes on to the price as before.
 */
export function readMap (text: string): Omit<MapCheck, 'profile'> | undefined {
  const lines = text.replace(/\r/g, '').split('\n').map(line => line.trimEnd())
  if (!/^Item Class: Maps$/.test(lines[0] ?? '')) return undefined

  const end = lines.indexOf(SEPARATOR)
  const head = lines.slice(0, end < 0 ? lines.length : end)
  const rarity = head.find(line => line.startsWith('Rarity: '))?.slice('Rarity: '.length)
  const names = head.filter(line => line && !line.includes(': '))
  const base = names.at(-1) ?? 'Map'
  const name = names.length > 1 ? names[0] : undefined

  const mods: MapMod[] = []
  let current: MapMod | undefined
  for (const line of lines) {
    const header = MOD_HEADER.exec(line)
    if (header) {
      current = { kind: header[1]!.toLowerCase(), lines: [] }
      mods.push(current)
      continue
    }
    if (line === SEPARATOR || line.startsWith('{')) {
      current = undefined
      continue
    }
    if (current && line && !isReminder(line)) current.lines.push(cleanLine(line))
  }

  return { ...(name ? { name } : {}), base, ...(rarity ? { rarity } : {}), mods }
}

/** The worst rule that matches any line of the mod. */
export function markMod (mod: MapMod, profile: Profile): MapMod {
  const keys = mod.lines.map(matchKey)
  for (const mark of MARKS) {
    const rule = profile.rules.find(rule => rule.mark === mark && keys.some(key => key.includes(rule.pattern)))
    if (rule) return { ...mod, mark, rule }
  }
  return mod
}

/**
 * The map check of a clipboard, or `undefined` if there is nothing to check: not a map,
 * or a map without explicit mods (normal, unidentified). Those go to the price, so that
 * a white T16 or a guardian map keeps its price as before.
 */
export function mapCheckOf (text: string, profile: Profile): MapCheck | undefined {
  const map = readMap(text)
  if (!map || !map.mods.length) return undefined
  return { ...map, mods: map.mods.map(mod => markMod(mod, profile)), profile: profile.source }
}

/** How many mods of each mark. */
export function countMarks (check: MapCheck): Record<Mark, number> {
  const counts: Record<Mark, number> = { deadly: 0, warning: 0, good: 0 }
  for (const mod of check.mods) if (mod.mark) counts[mod.mark] += 1
  return counts
}

/** The answer to "do I run it", in words. One for the panel and the log. */
export function verdictText (check: MapCheck): string {
  const { deadly, warning } = countMarks(check)
  if (deadly) return `do not run: ${deadly} deadly`
  if (warning) return `run with care: ${warning} warning${warning > 1 ? 's' : ''}`
  return 'nothing dangerous'
}

/** Log lines: verdict, then each mod with its mark and the rule behind it. */
export function formatMapCheck (check: MapCheck): string[] {
  return [
    `map check [${check.profile}]: ${check.name ? `${check.name} / ` : ''}${check.base} — ${verdictText(check)}`,
    ...check.mods.map(mod =>
      `   ${(mod.mark ?? '-').padEnd(7)} ${mod.lines.join(' / ')}${mod.rule ? `  [${mod.rule.pattern}]` : ''}`)
  ]
}
