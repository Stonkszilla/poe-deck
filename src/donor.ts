// Шов к пину донора.
//
// Заимствованного кода в этом файле нет — только клей: донор грузит справочники
// через `fetch` относительно `import.meta.env.BASE_URL` (он рассчитан на Vite),
// а мы читаем их с диска. Сам парсер и `assets/data` берутся из пина как есть,
// без правок.
//
// Донор: SnosMe/awakened-poe-trade, MIT — см. licenses/awakened-poe-trade.LICENSE.
// Пин: сабмодуль `vendor/awakened-poe-trade`, каталог берётся из GameFeatures.
// Справочники — пин с нашей дельтой поверх (`./donor-data.ts`): так
// новая лига приезжает без нового релиза донора. Дельта пишется против
// конкретного пина, и `data/<игра>/SOURCES.json` этот пин называет.
//
// Две формы запуска:
//   - исходники: модули грузятся из пина, справочники собираются в
//     `data/<игра>/.public/` при первом запуске и после смены пина или дельты;
//   - один исполняемый файл (`bun build --compile`, ci/bundle/entry.ts): модули
//     и собранные справочники вшиты в него, точка входа отдаёт их сюда
//     `useBundledDonor`. Ни git, ни сети до GitHub, ни записи на диск.

import { normalizeClipboard } from './clipboard-quirks'
import { assembleDonorData } from './donor-data'
import { gameFeatures, type GameVersion } from './game-features'

const REPO_ROOT = new URL('..', import.meta.url).pathname

/** Донор, вшитый в исполняемый файл: модули уже загружены, справочники в `/$bunfs/`. */
export interface BundledDonor {
  /** Версия игры, чей донор вшит. Другой в файле нет. */
  version: GameVersion
  /** Каталог `public/` пина внутри исполняемого файла, со слешем на конце. */
  publicDir: string
  /** Язык, справочники которого вшиты. Других в наборе нет. */
  lang: string
  data: { init: (lang: string) => Promise<void> }
  parser: Record<string, unknown>
}

let bundled: BundledDonor | null = null

/** Точка входа собранного демона отдаёт сюда вшитого донора — до первого `loadDonorParser`. */
export function useBundledDonor (donor: BundledDonor): void {
  bundled = donor
}

/** Перехват `fetch` донора: адреса внутри `publicDir` читаются как файлы. */
function serveFromDisk (publicDir: string): void {
  ;(process.env as Record<string, string>).BASE_URL = publicDir
  const realFetch = globalThis.fetch
  globalThis.fetch = ((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ) => {
    const url = String(input)
    return url.startsWith(publicDir)
      ? Promise.resolve(new Response(Bun.file(url)))
      : realFetch(input, init)
  }) as typeof fetch
}

/**
 * Поднимает парсер предметов из пина донора и возвращает его модуль.
 * Справочники читаются из того же пина — рассинхрона между ними быть не может.
 */
export async function loadDonorParser (version: GameVersion = 'poe1', lang = 'en') {
  if (bundled) {
    if (version !== bundled.version || lang !== bundled.lang) {
      throw new Error(`this poe-deck build carries the ${bundled.version} donor with "${bundled.lang}" data only, not ${version} "${lang}"`)
    }
    serveFromDisk(bundled.publicDir)
    await bundled.data.init(lang)
    // Тот же модуль, что `import()` ниже отдаёт исходникам, — тип общий.
    return withQuirks(bundled.parser as Awaited<ReturnType<typeof loadFromPin>>)
  }
  return withQuirks(await loadFromPin(version, lang))
}

/**
 * Парсер пина с поправками буфера (`./clipboard-quirks.ts`) перед разбором:
 * все потребители — демон, slice, CLI набора — получают их, не зная о них.
 */
function withQuirks<T extends { parseClipboard: (text: string) => unknown }> (parser: T): T {
  return { ...parser, parseClipboard: (text: string) => parser.parseClipboard(normalizeClipboard(text)) }
}

async function loadFromPin (version: GameVersion, lang: string) {
  const features = gameFeatures(version)
  const donorRoot = `${REPO_ROOT}${features.donorDir}/renderer/`
  // Справочники — пин с нашей дельтой поверх. Сборка перестраивается,
  // только когда сменился пин или дельта; индексы строятся вместе с ней.
  const publicDir = `${REPO_ROOT}${features.dataDir}/.public/`
  assembleDonorData({
    pinPublicDir: `${donorRoot}public/`,
    deltaDir: `${REPO_ROOT}${features.dataDir}/${lang}/`,
    outPublicDir: publicDir,
    lang
  })

  // Весь клей к окружению — эти несколько строк.
  serveFromDisk(publicDir)

  const data = await import(`${donorRoot}src/assets/data/index.ts`)
  await data.init(lang)

  return await import(`${donorRoot}src/parser/index.ts`)
}
