// Точка входа демона, собранного в один исполняемый файл.
//
//   bun build --compile ci/bundle/entry.ts --root . \
//     --asset-naming '[dir]/[name].[ext]' --outfile dist/poe-deck/poe-deck
//
// Рецепт целиком — ci/bundle/build-daemon.sh. Здесь — то, чего нет у исходников:
//
//  1. Модули донора импортируются СТРОКОЙ. `src/donor.ts` грузит их шаблонным
//     путём от каталога пина, а такой `import()` бандлер не видит, и в файл бы
//     ничего не вшилось.
//  2. Справочники донора вшиваются как файлы (`with { type: 'file' }`). С
//     `--asset-naming '[dir]/[name].[ext]'` они лежат в `/$bunfs/root/` тем же
//     деревом, что в репозитории, — поэтому `fetch` и `import()` донора по
//     `BASE_URL` находят их без единой правки в коде донора.
//  3. Справочники — не пин как есть, а пин с нашей дельтой: их и
//     бинарные индексы к ним собирает в `data/poe1/.public/` build-daemon.sh
//     до сборки, тем же `assembleDonorData`, что исходники при первом запуске.
//     Игроку нечего строить и некуда писать: rootfs read-only, а в `$HOME`
//     демон не кладёт ничего.
//
// Файл лежит вне `src/`, потому что tsc проекта не проверяет код донора
// (tsconfig.json, exclude vendor), а статический импорт затащил бы его в проверку.

import * as data from '../../vendor/awakened-poe-trade/renderer/src/assets/data/index.ts'
import * as parser from '../../vendor/awakened-poe-trade/renderer/src/parser/index.ts'

import items from '../../data/poe1/.public/data/en/items.ndjson' with { type: 'file' }
import '../../data/poe1/.public/data/en/stats.ndjson' with { type: 'file' }
import '../../data/poe1/.public/data/en/client_strings.js' with { type: 'file' }
import '../../data/poe1/.public/data/en/items-name.index.bin' with { type: 'file' }
import '../../data/poe1/.public/data/en/items-ref.index.bin' with { type: 'file' }
import '../../data/poe1/.public/data/en/stats-ref.index.bin' with { type: 'file' }
import '../../data/poe1/.public/data/en/stats-matcher.index.bin' with { type: 'file' }
import '../../data/poe1/.public/data/item-drop.json' with { type: 'file' }
import '../../data/poe1/.public/data/patrons.json' with { type: 'file' }

import { readFileSync } from 'node:fs'
import { effectiveSettings, loadConfig } from '../../src/config'
import { main } from '../../src/daemon'
import { doctor } from '../../src/doctor'
import { loadDonorParser, useBundledDonor } from '../../src/donor'
import { formatPriceCheck, priceOf } from '../../src/price-check'
import { formatItem } from '../../src/slice'

/** Сборка: коммит poe-deck и пин донора. Подставляет `--define` в build-daemon.sh. */
declare const POE_DECK_BUILD: string

useBundledDonor({
  publicDir: items.slice(0, items.lastIndexOf('data/en/items.ndjson')),
  version: 'poe1',
  lang: 'en',
  data,
  parser
})

const argv = process.argv.slice(2)

if (argv[0] === '--version') {
  console.log(`poe-deck ${POE_DECK_BUILD}`)
  process.exit(0)
}

// Самопроверка игрока: звено за звеном, ✓ или ✗ с советом.
if (argv[0] === 'doctor') process.exit(await doctor(POE_DECK_BUILD))

// Проверка набора без Deck и без сессии: парсер из вшитого пина разбирает
// текст предмета из файла. Ей CI проверяет собранный файл в чистом контейнере —
// без bun, без git и без сети.
if (argv[0] === '--check-parser') {
  const file = argv[1]
  if (!file) {
    console.log('usage: poe-deck --check-parser <item.txt>')
    process.exit(2)
  }
  const donor = await loadDonorParser()
  const result = donor.parseClipboard(readFileSync(file, 'utf8'))
  if (result.isErr()) {
    console.log(`✗  parser rejected ${file}: ${String(result.error)}`)
    process.exit(1)
  }
  for (const line of formatItem(result.value)) console.log(line)
  process.exit(0)
}

// Цена из набора без сессии и без жеста: тот же путь priceOf, что у демона
// после нажатия, только текст предмета берётся из файла. Ей набор проверяется
// на Deck до мержа (ci/bundle/deck-verify.sh): цена обеих форм предмета на
// стоковом rootfs, без bun и без контейнера. Коды: 0 — ответ рынка получен,
// 1 — парсер отказал, 2 — нет аргумента, 4 — трейд не ответил.
if (argv[0] === '--check-price') {
  const file = argv[1]
  if (!file) {
    console.log('usage: poe-deck --check-price <item.txt>')
    process.exit(2)
  }
  const donor = await loadDonorParser()
  const result = donor.parseClipboard(readFileSync(file, 'utf8'))
  if (result.isErr()) {
    console.log(`✗  parser rejected ${file}: ${String(result.error)}`)
    process.exit(1)
  }
  const item = result.value
  for (const line of formatItem(item)) console.log(line)
  try {
    // Лига — как у демона: переменная, иначе конфиг игрока, иначе /api/leagues.
    const league = effectiveSettings(loadConfig().settings).settings.league
    const check = await priceOf(item, league ? { league } : {})
    console.log(`price: ${formatPriceCheck(item, check)}`)
    process.exit(0)
  } catch (err) {
    console.log(`✗  trade did not answer: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(4)
  }
}

console.log(`poe-deck ${POE_DECK_BUILD}`)
process.exit(await main())
