// Donor reference data with our delta on top.
//
// The parser still comes from the pin. The reference data also comes from the pin,
// but the delta `data/<game>/<language>/*.delta.ndjson` goes on top of it. Our
// generator (`tools/datagen/`) writes it from the game files and trade data when
// the donor has not released data for a new league yet.
//
// The merge is an upsert by key. A delta line with a key that exists in the pin
// replaces the pin line in the same place. A line with a new key is appended at
// the end. The item key is `namespace::refName`, the stat key is `ref`. So the delta
// both appends new bases and adds trade ids to stats that the pin already knows.
//
// The binary indexes for the result use the same algorithm as the donor generator
// `renderer/src/assets/make-index-files.mjs` (SnosMe/awakened-poe-trade,
// MIT, licenses/awakened-poe-trade.LICENSE). We cannot call it directly: it
// writes to the pin directory by a hardcoded path and only for all four languages.

import fnv1a from '@sindresorhus/fnv1a'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Files of `public/data` that come from the pin as is. */
const DATA_FILES = ['item-drop.json', 'patrons.json']
/** Files of `public/data/<language>` that come from the pin as is. */
const LANG_FILES = ['client_strings.js', 'app_i18n.json']

export type KeyOf = (row: Record<string, unknown>) => string

export const itemKey: KeyOf = row => `${String(row.namespace)}::${String(row.refName)}`
/** Stat key. For a stat group (`{ resolve, stats }`) the key is the ref of the first stat. */
export const statKey: KeyOf = row => {
  const stats = row.stats as Array<{ ref: string }> | undefined
  return stats ? `group::${stats[0]?.ref ?? ''}` : String(row.ref)
}

function lines (ndjson: string): string[] {
  return ndjson.split('\n').filter(line => line.length > 0)
}

/**
 * Upsert of the delta into the base. The base order stays, new lines go to the end.
 *
 * A delta line can carry `_key`: the key of the pin line that it replaces.
 * It is needed when the game rewrote a mod text: the stat ref changed, and the old
 * line must be replaced, not a second one appended. `_key` does not go to the result.
 */
export function mergeNdjson (base: string, delta: string, keyOf: KeyOf): string {
  const upserts = new Map<string, string>()
  const replaces: string[] = []
  for (const line of lines(delta)) {
    const row = JSON.parse(line) as Record<string, unknown>
    if (typeof row._key === 'string') {
      const key = row._key
      delete row._key
      replaces.push(key)
      upserts.set(key, JSON.stringify(row))
    } else {
      upserts.set(keyOf(row), line)
    }
  }

  const out: string[] = []
  for (const line of lines(base)) {
    const key = keyOf(JSON.parse(line))
    const replacement = upserts.get(key)
    if (replacement !== undefined) {
      out.push(replacement)
      upserts.delete(key)
    } else {
      out.push(line)
    }
  }
  for (const key of replaces) {
    if (upserts.has(key)) {
      throw new Error(`delta replaces "${key}", but the pin has no such line — the delta was built against another pin (data/*/SOURCES.json)`)
    }
  }
  out.push(...upserts.values())
  return out.join('\n') + '\n'
}

function hash (text: string): number {
  return Number(fnv1a(text, { size: 32 }))
}

/** Pairs (hash, line offset) sorted by hash: the donor index format. */
function toIndex (rows: Array<{ hash: number, start: number }>): Uint32Array {
  rows.sort((a, b) => a.hash - b.hash)
  const index = new Uint32Array(rows.length * 2)
  rows.forEach((row, i) => {
    index[i * 2] = row.hash
    index[i * 2 + 1] = row.start
  })
  return index
}

/**
 * Line offsets are counted in UTF-16, not in bytes: the donor uses them for
 * `ndjson.slice(start)` on a JS string. Its generator counts the same way.
 */
function eachLine (ndjson: string, fn: (row: Record<string, unknown>, start: number) => void): void {
  let start = 0
  while (start !== ndjson.length) {
    const end = ndjson.indexOf('\n', start)
    fn(JSON.parse(ndjson.slice(start, end)), start)
    start = end + 1
  }
}

export function statIndexes (ndjson: string): { ref: Uint32Array, matcher: Uint32Array } {
  const byRef: Array<{ hash: number, start: number }> = []
  const byMatcher: Array<{ hash: number, start: number }> = []
  eachLine(ndjson, (row, start) => {
    type Stat = { ref: string, matchers: Array<{ string: string, advanced?: string }> }
    const stats = (row.stats as Stat[] | undefined) ?? [row as unknown as Stat]
    for (const stat of stats) {
      byRef.push({ start, hash: hash(stat.ref) })
      for (const matcher of stat.matchers) {
        byMatcher.push({ start, hash: hash(matcher.advanced ?? matcher.string) })
      }
    }
  })
  return { ref: toIndex(byRef), matcher: toIndex(byMatcher) }
}

export function itemIndexes (ndjson: string): { name: Uint32Array, ref: Uint32Array } {
  // The first line of a key is the entry point: from there the donor walks the
  // following lines with the same name (variants of one unique).
  const firstByKey = new Map<string, { name: number, ref: number, start: number }>()
  eachLine(ndjson, (row, start) => {
    const key = itemKey(row)
    if (firstByKey.has(key)) return
    firstByKey.set(key, {
      name: hash(`${String(row.namespace)}::${String(row.name)}`),
      ref: hash(key),
      start
    })
  })
  const rows = [...firstByKey.values()]
  return {
    name: toIndex(rows.map(row => ({ hash: row.name, start: row.start }))),
    ref: toIndex(rows.map(row => ({ hash: row.ref, start: row.start })))
  }
}

export interface AssembleArgs {
  /** `renderer/public/` of the donor pin. */
  pinPublicDir: string
  /** Delta directory of one language: `data/poe1/en/`. */
  deltaDir: string
  /** Where to assemble `public/`, with `data/<language>/` and the indexes. */
  outPublicDir: string
  lang: string
}

/**
 * Assembly format version. Bump it when the way this file assembles the reference
 * data or the indexes changes: otherwise an old assembly looks fresh.
 */
const FORMAT = 1

/**
 * Assembles `public/` for the donor: pin files, ndjson with the delta, and indexes.
 * Returns `true` if something was rebuilt, `false` if the input is the same.
 *
 * The stamp covers everything that goes into the assembly: the ndjson and the pin
 * files that are copied as is. The donor changes `client_strings.js` in separate
 * commits, and after a pin bump an old copy would silently break parsing.
 *
 * The assembly is written to a temporary directory and replaces the old one by rename:
 * a daemon and a CLI started together on a cold cache do not read a half-written file.
 */
export function assembleDonorData ({ pinPublicDir, deltaDir, outPublicDir, lang }: AssembleArgs): boolean {
  const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : ''
  const pinFiles = [
    ...DATA_FILES.map(file => join('data', file)),
    ...[...new Set(['en', lang])].flatMap(dir => LANG_FILES.map(file => join('data', dir, file)))
  ].filter(file => existsSync(join(pinPublicDir, file)))
  const baseItems = readFileSync(join(pinPublicDir, 'data', lang, 'items.ndjson'), 'utf8')
  const baseStats = readFileSync(join(pinPublicDir, 'data', lang, 'stats.ndjson'), 'utf8')
  const deltaItems = read(join(deltaDir, 'items.delta.ndjson'))
  const deltaStats = read(join(deltaDir, 'stats.delta.ndjson'))

  const stampFile = join(outPublicDir, 'data', lang, '.stamp')
  const stamp = [
    `format:${FORMAT}`,
    ...[baseItems, baseStats, deltaItems, deltaStats, ...pinFiles.map(file => read(join(pinPublicDir, file)))]
      .map(text => `${text.length}:${hash(text)}`)
  ].join(' ')
  if (read(stampFile) === stamp) return false

  const tmp = `${outPublicDir.replace(/\/$/, '')}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  const tmpLang = join(tmp, 'data', lang)
  mkdirSync(tmpLang, { recursive: true })
  for (const file of pinFiles) {
    mkdirSync(dirname(join(tmp, file)), { recursive: true })
    copyFileSync(join(pinPublicDir, file), join(tmp, file))
  }

  const items = mergeNdjson(baseItems, deltaItems, itemKey)
  const stats = mergeNdjson(baseStats, deltaStats, statKey)
  writeFileSync(join(tmpLang, 'items.ndjson'), items)
  writeFileSync(join(tmpLang, 'stats.ndjson'), stats)

  const itemIdx = itemIndexes(items)
  const statIdx = statIndexes(stats)
  writeFileSync(join(tmpLang, 'items-name.index.bin'), itemIdx.name)
  writeFileSync(join(tmpLang, 'items-ref.index.bin'), itemIdx.ref)
  writeFileSync(join(tmpLang, 'stats-ref.index.bin'), statIdx.ref)
  writeFileSync(join(tmpLang, 'stats-matcher.index.bin'), statIdx.matcher)
  writeFileSync(join(tmpLang, '.stamp'), stamp)

  // The old assembly moves aside, the new one takes its place: the window without
  // the directory is between two renames, with no file writes inside it.
  // A second process that built the same thing can be first: then its assembly
  // stays and ours is discarded, because both have the same input.
  const old = `${tmp}.old`
  try { renameSync(outPublicDir, old) } catch {}
  try {
    renameSync(tmp, outPublicDir)
  } catch {
    rmSync(tmp, { recursive: true, force: true })
  }
  rmSync(old, { recursive: true, force: true })
  return true
}
