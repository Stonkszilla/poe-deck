// The Steam Input layout as `poe-deck doctor` sees it.
//
// The template and the daemon agree only on chords (ADR 0002 F17), and
// the player does not see a broken contract: the press simply does not arrive. So doctor
// checks not "which button" but "is there a button that sends the daemon chord",
// in the personal game configuration that Steam writes after Apply:
//
//   $STEAM_DIR/steamapps/common/Steam Controller Configs/<account>/config/<AppId>/controller_neptune.vdf
//
// The path comes from a live Deck (spike steam-input-two-outputs, run #54). The button
// is not checked here on purpose: the player may move the gesture to another
// button, and that is not a breakage.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** A KeyValues node: keys repeat (three `Full_Press` in a row), so it is a list of pairs. */
export type Kv = [string, string | Kv][]

/** Parses Valve KeyValues: quoted strings, blocks in curly braces, `//` is a comment. */
export function parseKv (text: string): Kv {
  // The same regex catches comments after strings: "//" inside a string
  // (`template://…`) is not a comment.
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

/** Steam Input key names → keysym, as gamescope and the daemon name them. */
const KEYSYM: Record<string, string> = {
  LEFT_CONTROL: 'Control_L',
  RIGHT_CONTROL: 'Control_R',
  LEFT_ALT: 'Alt_L',
  RIGHT_ALT: 'Alt_R',
  LEFT_SHIFT: 'Shift_L',
  RIGHT_SHIFT: 'Shift_R'
}

export const keysym = (steamKey: string): string => KEYSYM[steamKey] ?? steamKey

/** The chord of one input: the `key_press` keys of its activators, in delay order. */
export interface InputChord {
  input: string
  /** The Deck button as the player names it: `L5`, `L3`, `RPad-click`. */
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
 * The button name from the input and the group source. Both the stick and the trackpad
 * have a `click` input, so the source that the preset binds the group to names the
 * button; the back buttons live in the `switches` group and take the input name.
 */
export function buttonOf (input: string, source?: string): string {
  if (input === 'click') return (source && CLICK[source]) ?? 'click'
  return BACK[input] ?? input
}

/**
 * Chords of all inputs of the active groups. An active group is one that the preset binds
 * to a source with the word `active`; inactive groups (modifier modes) do not add to the
 * chord of a button. With no preset, all groups count.
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
        // Any activator type, not only Full_Press: a gesture that the player
        // moved to a long or double press still sends the chord.
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

/** Where Steam keeps its data: `STEAM_DIR`, by default the SteamOS location. */
export function steamDir (env = process.env): string {
  return env.STEAM_DIR || `${env.HOME}/.local/share/Steam`
}

/**
 * The game layouts across all Steam accounts on the device: the ones that Steam
 * applies.
 *
 * Acceptance on the Deck showed that `controller_neptune.vdf` alone is not enough. Steam also
 * writes the layout to a file named after the controller serial number (`FYZZ5510192C.vdf` next to it),
 * and keeps a reference to the selection in `config/configset_<serial>.vdf`:
 * `"238960" { "template" "…" }`. After Apply of a template the reference points into the
 * templates directory, and the game may have no file of its own at all; doctor then said
 * "no layout" although the template was applied. A cloud reference (`CLOUD_<AppId>/…`) cannot
 * be read from disk and is skipped.
 *
 * A file in `config/<AppId>` means nothing by itself. On the Deck on 20.11,
 * `FYZZ5510192C.vdf` held a price check on L3 from template rc3, while the configset of the same
 * serial selected the template with the price check on L5, and L5 gave the price. So only
 * what the configset points to counts as applied: the template by
 * `template`, and with `"autosave" "1"` the file `config/<AppId>/<configset name>.vdf`
 * (this is how Steam writes `controller_neptune.vdf` with `url autosave://…`). The other game
 * files are `stale`. If the configset selected nothing readable (no entry or a
 * cloud reference), the applied layout is unknown, and `applied` gets all game files.
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

/** The layouts that Steam applies to the game (`layoutChoice`). */
export function appliedLayouts (appId: number, steam = steamDir()): string[] {
  return layoutChoice(appId, steam).applied
}

/** The `"<AppId>" { … }` entry from a Steam configset: what is selected for the game. */
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

/** The template reference from a Steam configset, if a template is selected. */
export function configsetTemplate (text: string, appId: number): string | undefined {
  const choice = configsetChoice(text, appId)
  return choice && 'template' in choice ? choice.template : undefined
}

/** Is the poe-deck template where Steam takes templates from (tools/steam-template.sh). */
export function templateInstalled (steam = steamDir()): boolean {
  return existsSync(join(steam, 'controller_base/templates/controller_neptune_poe_deck.vdf'))
}

/** The verdict for one personal configuration: which daemon chords it lacks and where the others are. */
export interface LayoutVerdict {
  path: string
  missing: string[]
  /** Chord → the buttons that send it, in `wanted` order. */
  buttons: Record<string, string[]>
}

/** A chord as a set of keys: gamescope compares sets of pressed keys, not their order. */
const asSet = (chord: string): string => chord.split('+').sort().join('+')

/**
 * Which of the wanted chords no button sends. Key sets are compared:
 * gamescope fires on the exact set of pressed keys, and in any press order
 * the last step gives the same set. The template spreads the delays for
 * reliable delivery, not for order; tools/steam-template.test.ts holds that
 * contract, not doctor.
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
