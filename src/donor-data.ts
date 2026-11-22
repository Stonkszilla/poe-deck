// Справочники донора с нашей дельтой поверх.
//
// Парсер по-прежнему берётся из пина. Справочники — тоже из пина, но поверх
// них ложится дельта `data/<игра>/<язык>/*.delta.ndjson`. Её пишет наш
// генератор (`tools/datagen/`) из файлов игры и данных трейда, когда донор
// ещё не выпустил данные под новую лигу.
//
// Слияние — upsert по ключу. Строка дельты с ключом, который есть в пине,
// заменяет строку пина на том же месте. Строка с новым ключом дописывается в
// конец. Ключ предмета — `namespace::refName`, ключ стата — `ref`. Так дельта
// и дописывает новые базы, и добавляет trade id к статам, которые пин уже знает.
//
// Бинарные индексы к результату строятся тем же алгоритмом, что генератор
// донора `renderer/src/assets/make-index-files.mjs` (SnosMe/awakened-poe-trade,
// MIT, licenses/awakened-poe-trade.LICENSE). Его самого позвать нельзя: он
// пишет в каталог пина по жёсткому пути и только для всех четырёх языков.

import fnv1a from '@sindresorhus/fnv1a'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Файлы `public/data`, которые едут из пина как есть. */
const DATA_FILES = ['item-drop.json', 'patrons.json']
/** Файлы `public/data/<язык>`, которые едут из пина как есть. */
const LANG_FILES = ['client_strings.js', 'app_i18n.json']

export type KeyOf = (row: Record<string, unknown>) => string

export const itemKey: KeyOf = row => `${String(row.namespace)}::${String(row.refName)}`
/** Ключ стата. У группы статов (`{ resolve, stats }`) ключ — ref первого. */
export const statKey: KeyOf = row => {
  const stats = row.stats as Array<{ ref: string }> | undefined
  return stats ? `group::${stats[0]?.ref ?? ''}` : String(row.ref)
}

function lines (ndjson: string): string[] {
  return ndjson.split('\n').filter(line => line.length > 0)
}

/**
 * Upsert дельты в базу. Порядок базы сохраняется, новые строки идут в конец.
 *
 * Строка дельты может нести `_key` — ключ строки пина, которую она заменяет.
 * Он нужен, когда игра переписала текст мода: ref стата сменился, а заменить
 * надо прежнюю строку, а не дописать вторую. В результат `_key` не попадает.
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

/** Пары (хеш, смещение строки), отсортированные по хешу, — формат индекса донора. */
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
 * Смещения строк считаются в UTF-16, а не в байтах: донор ищет по ним
 * `ndjson.slice(start)` в строке JS. Так же считает и его генератор.
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
  // Первая строка ключа — точка входа: дальше донор идёт подряд по строкам
  // с тем же именем (варианты одной уникалки).
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
  /** `renderer/public/` пина донора. */
  pinPublicDir: string
  /** Каталог дельты одного языка: `data/poe1/en/`. */
  deltaDir: string
  /** Куда собрать `public/` — с `data/<язык>/` и индексами. */
  outPublicDir: string
  lang: string
}

/**
 * Версия формата сборки. Поднимается, когда меняется то, как этот файл
 * собирает справочники или индексы: иначе старая сборка выглядит свежей.
 */
const FORMAT = 1

/**
 * Собирает `public/` для донора: файлы пина, ndjson с дельтой и индексы.
 * Возвращает `true`, если что-то пересобрано, `false` — если вход тот же.
 *
 * Отпечаток покрывает всё, что едет в сборку, — и ndjson, и файлы пина,
 * которые копируются как есть: донор меняет `client_strings.js` отдельными
 * коммитами, и после бампа пина старая копия молча испортила бы разбор.
 *
 * Сборка пишется во временный каталог и подменяет прежнюю переименованием:
 * демон и CLI, запущенные разом на холодном кэше, не прочтут полузаписанный файл.
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

  // Прежняя сборка уходит в сторону, новая встаёт на её место: окно, в котором
  // каталога нет, — между двумя rename, без записи файлов внутри.
  // Второй процесс, собравший то же самое, может успеть первым — тогда его
  // сборка и остаётся, а наша выбрасывается: вход у них один.
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
