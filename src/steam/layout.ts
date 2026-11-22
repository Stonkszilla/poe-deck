// Раскладка Steam Input глазами `poe-deck doctor`.
//
// Шаблон и демон договариваются только аккордами (ADR 0002 Ф17), и
// игрок поломку договора не видит: нажатие просто не доходит. Поэтому doctor
// сверяет не «какая кнопка», а «есть ли кнопка, которая шлёт аккорд демона», —
// в личной конфигурации игры, которую Steam пишет после Apply:
//
//   $STEAM_DIR/steamapps/common/Steam Controller Configs/<аккаунт>/config/<AppId>/controller_neptune.vdf
//
// Путь снят с живого Deck (спайк steam-input-two-outputs, прогон #54). Номер
// кнопки здесь не проверяется намеренно: игрок вправе перенести жест на другую
// кнопку, и это не поломка.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Узел KeyValues: ключи повторяются (три `Full_Press` подряд), поэтому список пар. */
export type Kv = [string, string | Kv][]

/** Разбор KeyValues Valve: строки в кавычках, блоки в фигурных скобках, `//` — комментарий. */
export function parseKv (text: string): Kv {
  // Комментарий ловится той же регуляркой после строк: «//» внутри строки
  // (`template://…`) комментарием не считается.
  const tokens = [...text.matchAll(/"((?:[^"\\]|\\.)*)"|[{}]|\/\/[^\n]*/g)]
    .filter(match => !match[0].startsWith('//'))
    .map(match => match[1] ?? match[0])
  let at = 0
  const block = (): Kv => {
    const out: Kv = []
    while (at < tokens.length && tokens[at] !== '}') {
      const key = tokens[at++]!
      if (tokens[at] === '{') { at++; out.push([key, block()]); at++ } else out.push([key, tokens[at++]!])
    }
    return out
  }
  return block()
}

const all = (node: Kv, key: string): (string | Kv)[] =>
  node.filter(([k]) => k.toLowerCase() === key.toLowerCase()).map(([, v]) => v)
const blocks = (node: Kv, key: string): Kv[] => all(node, key).filter((v): v is Kv => typeof v !== 'string')
const strings = (node: Kv, key: string): string[] => all(node, key).filter((v): v is string => typeof v === 'string')

/** Имена клавиш Steam Input → keysym, как их называют gamescope и демон. */
const KEYSYM: Record<string, string> = {
  LEFT_CONTROL: 'Control_L',
  RIGHT_CONTROL: 'Control_R',
  LEFT_ALT: 'Alt_L',
  RIGHT_ALT: 'Alt_R',
  LEFT_SHIFT: 'Shift_L',
  RIGHT_SHIFT: 'Shift_R'
}

export const keysym = (steamKey: string): string => KEYSYM[steamKey] ?? steamKey

/** Аккорд одного входа: клавиши `key_press` его активаторов в порядке задержек. */
export interface InputChord {
  input: string
  /** Кнопка Deck, как её зовёт игрок: `L5`, `L3`, `RPad-click`. */
  button: string
  keys: string
  delays: number[]
}

const BACK: Record<string, string> = {
  button_back_left: 'L5',
  button_back_right: 'R5',
  button_back_left_upper: 'L4',
  button_back_right_upper: 'R4'
}
const CLICK: Record<string, string> = {
  joystick: 'L3',
  right_joystick: 'R3',
  left_trackpad: 'LPad-click',
  right_trackpad: 'RPad-click'
}

/**
 * Имя кнопки по входу и источнику группы. Вход `click` есть у стика и у тачпада,
 * поэтому кнопку называет источник, на который пресет вешает группу; задние
 * кнопки живут в группе `switches` и называются по входу.
 */
export function buttonOf (input: string, source?: string): string {
  if (input === 'click') return (source && CLICK[source]) ?? 'click'
  return BACK[input] ?? input
}

/**
 * Аккорды всех входов активных групп. Активная группа — та, что пресет вешает на
 * источник словом `active`; неактивные группы (режимы-модификаторы) в аккорд по
 * кнопке не попадают. Пресета нет — смотрим все группы.
 */
export function chordsOf (root: Kv): InputChord[] {
  const groups = blocks(root, 'group')
  const preset = blocks(root, 'preset')[0]
  const bindings = preset ? blocks(preset, 'group_source_bindings')[0] : undefined
  const source = new Map<string, string>()
  for (const [id, v] of bindings ?? []) {
    if (typeof v === 'string' && v.endsWith(' active')) source.set(id, v.split(' ')[0]!)
  }
  const active = groups.filter(group => !bindings || source.has(strings(group, 'id')[0] ?? ''))

  const out: InputChord[] = []
  for (const group of active) {
    const from = source.get(strings(group, 'id')[0] ?? '')
    for (const inputs of blocks(group, 'inputs')) {
      for (const [input, node] of inputs) {
        if (typeof node === 'string') continue
        const presses: Array<{ key: string, delay: number }> = []
        // Любой тип активатора, не только Full_Press: жест, перенесённый
        // игроком на долгое или двойное нажатие, всё равно шлёт аккорд.
        for (const activators of blocks(node, 'activators')) {
          for (const press of activators.flatMap(([, v]) => typeof v === 'string' ? [] : [v])) {
            const settings = blocks(press, 'settings')[0]
            const delay = Number(settings ? strings(settings, 'delay_start')[0] ?? 0 : 0) || 0
            for (const binding of blocks(press, 'bindings').flatMap(b => strings(b, 'binding'))) {
              const key = binding.match(/^key_press (\w+)/)?.[1]
              if (key) presses.push({ key: keysym(key), delay })
            }
          }
        }
        if (!presses.length) continue
        presses.sort((a, b) => a.delay - b.delay)
        out.push({ input, button: buttonOf(input, from), keys: presses.map(p => p.key).join('+'), delays: presses.map(p => p.delay) })
      }
    }
  }
  return out
}

/** Где Steam хранит данные: `STEAM_DIR`, по умолчанию как на SteamOS. */
export function steamDir (env = process.env): string {
  return env.STEAM_DIR || `${env.HOME}/.local/share/Steam`
}

/**
 * Раскладки игры по всем аккаунтам Steam на устройстве — те, что Steam
 * применяет.
 *
 * Приёмка на Deck показала, что одного `controller_neptune.vdf` мало. Steam пишет
 * раскладку и в файл с серийным номером контроллера (`FYZZ5510192C.vdf` рядом), а
 * в `config/configset_<серийник>.vdf` хранит ссылку на то, что выбрано:
 * `"238960" { "template" "…" }`. После Apply шаблона ссылка ведёт в каталог
 * шаблонов, и своего файла у игры может не быть вовсе — doctor тогда говорил
 * «no layout», хотя шаблон применён. Облачная ссылка (`CLOUD_<AppId>/…`) с диска
 * не читается и пропускается.
 *
 * Файл в `config/<AppId>` сам по себе ничего не значит. На Deck 20.11
 * в `FYZZ5510192C.vdf` лежал прайс-чек на L3 от шаблона rc3, а configset того же
 * серийника выбирал шаблон с прайс-чеком на L5 — и цену давал L5. Поэтому
 * применённым считается только то, на что указывает configset: шаблон по
 * `template`, а по `"autosave" "1"` — файл `config/<AppId>/<имя configset>.vdf`
 * (так Steam пишет `controller_neptune.vdf` с `url autosave://…`). Остальные файлы
 * игры — `stale`. Если configset не выбрал ничего читаемого (записи нет или
 * ссылка облачная), применённое не определить, и в `applied` идут все файлы игры.
 */
export function layoutChoice (appId: number, steam = steamDir()): { applied: string[], stale: string[] } {
  const root = join(steam, 'steamapps/common/Steam Controller Configs')
  if (!existsSync(root)) return { applied: [], stale: [] }
  const templates = join(steam, 'controller_base/templates')
  const own: string[] = []
  const chosen: string[] = []
  for (const account of readdirSync(root)) {
    const game = join(root, account, 'config', String(appId))
    if (existsSync(game)) {
      for (const file of readdirSync(game).filter(name => name.endsWith('.vdf')).sort()) own.push(join(game, file))
    }
    const config = join(root, account, 'config')
    if (!existsSync(config)) continue
    for (const file of readdirSync(config).filter(name => name.startsWith('configset_') && name.endsWith('.vdf')).sort()) {
      const choice = configsetChoice(readFileSync(join(config, file), 'utf8'), appId)
      if (!choice) continue
      if ('autosave' in choice) {
        const path = join(game, `${file.slice('configset_'.length)}`)
        if (existsSync(path)) chosen.push(path)
        continue
      }
      if (choice.template.startsWith('CLOUD_')) continue
      const name = basename(choice.template.replace(/^template:\/\//, ''))
      const path = [name, `${name}.vdf`].map(candidate => join(templates, candidate)).find(candidate => existsSync(candidate))
      if (path) chosen.push(path)
    }
  }
  if (!chosen.length) return { applied: [...new Set(own)], stale: [] }
  const applied = [...new Set(chosen)]
  return { applied, stale: own.filter(path => !applied.includes(path)) }
}

/** Раскладки, которые Steam применяет к игре (`layoutChoice`). */
export function appliedLayouts (appId: number, steam = steamDir()): string[] {
  return layoutChoice(appId, steam).applied
}

/** Запись `"<AppId>" { … }` из configset Steam: что выбрано для игры. */
export function configsetChoice (text: string, appId: number): { template: string } | { autosave: true } | undefined {
  for (const [, top] of parseKv(text)) {
    if (typeof top === 'string') continue
    for (const [key, game] of top) {
      if (key !== String(appId) || typeof game === 'string') continue
      const template = game.find(([k]) => k === 'template')?.[1]
      if (typeof template === 'string') return { template }
      if (game.some(([k, v]) => k === 'autosave' && v === '1')) return { autosave: true }
    }
  }
  return undefined
}

/** Ссылка на шаблон из configset Steam, если выбран шаблон. */
export function configsetTemplate (text: string, appId: number): string | undefined {
  const choice = configsetChoice(text, appId)
  return choice && 'template' in choice ? choice.template : undefined
}

/** Лежит ли шаблон poe-deck там, откуда Steam берёт шаблоны (tools/steam-template.sh). */
export function templateInstalled (steam = steamDir()): boolean {
  return existsSync(join(steam, 'controller_base/templates/controller_neptune_poe_deck.vdf'))
}

/** Вердикт по одной личной конфигурации: каких аккордов демона в ней нет и где лежат остальные. */
export interface LayoutVerdict {
  path: string
  missing: string[]
  /** Аккорд → кнопки, которые его шлют, в порядке `wanted`. */
  buttons: Record<string, string[]>
}

/** Аккорд как набор клавиш: gamescope сравнивает наборы нажатых клавиш, а не порядок. */
const asSet = (chord: string): string => chord.split('+').sort().join('+')

/**
 * Какие из нужных аккордов не шлёт ни одна кнопка. Сравниваются наборы клавиш:
 * gamescope срабатывает на точный набор нажатых, и при любом порядке нажатия
 * последний шаг даёт тот же набор. Разнос задержек в шаблоне нужен для
 * надёжности доставки, а не для порядка — его договор держит
 * tools/steam-template.test.ts, а не doctor.
 */
export function checkLayout (path: string, wanted: string[]): LayoutVerdict {
  const root = blocks(parseKv(readFileSync(path, 'utf8')), 'controller_mappings')[0] ?? []
  const chords = chordsOf(root)
  const buttons: Record<string, string[]> = {}
  for (const chord of wanted) {
    const on = chords.filter(c => asSet(c.keys) === asSet(chord)).map(c => c.button)
    if (on.length) buttons[chord] = [...new Set(on)]
  }
  return { path, missing: wanted.filter(chord => !buttons[chord]), buttons }
}
