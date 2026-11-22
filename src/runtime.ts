// Где демон берёт свои C-бинари.
//
// Две формы запуска, и разница между ними — только в этом:
//
//   bun src/daemon.ts      исходники; бинари собраны на Deck в ~/poe-deck-tools
//                          (tools/dev-workspace.sh, путь разработчика)
//   ./poe-deck             один исполняемый файл `bun build --compile`; бинари
//                          собраны в CI и лежат в том же каталоге, что и он
//
// Переменные POE_DECK_PROBE / _PANEL / _POINTER / _CLIP перебивают обе формы.

import { dirname } from 'node:path'

/**
 * Собран ли демон в один файл. У скомпилированного bun модули живут в
 * виртуальной ФС `/$bunfs/`, у исходников — на диске.
 */
export const COMPILED = Bun.main.startsWith('/$bunfs/')

/** Каталог C-бинарей по умолчанию для данной формы запуска. */
export function toolsDir (compiled = COMPILED, execPath = process.execPath, home = process.env.HOME): string {
  return compiled ? dirname(execPath) : `${home}/poe-deck-tools`
}

/** Путь к бинарю: переменная окружения, иначе каталог по умолчанию. */
export function toolPath (name: string, override?: string): string {
  return override || `${toolsDir()}/${name}`
}
