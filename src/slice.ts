// End-to-end slice: Deck button → gamescope hotkey → clipboard → donor parser → log.
//
// The exit of the input epic. There is no overlay and no trade API here on purpose:
// the input path is proven, not the interface.
//
// The whole chain; each link was checked separately on a live Deck (stage 1),
// and this file connects them:
//
//   button_back_left (Steam Input) → Ctrl+Alt+C, ONE output
//     ├─→ the game puts the advanced item description into CLIPBOARD (#52)
//     └─→ gamescope_action_binding hears the same chord             (#56)
//           → we read CLIPBOARD from the session :0, gamescope bridges
//             selections between its Xwayland contexts               (#45)
//           → the parser from the donor pin parses the text
//
// This file does not listen to the hotkey itself; the ready probe from docs/spikes/gamescope-hotkey does:
// the protocol is private, and a client for it is already written in C and checked on hardware.
// There is no reason to rewrite it with FFI for the slice: we read its stdout line by line.
//
// Run on the Deck (ci/Jenkinsfile.deck, MODE=SLICE):
//   DISPLAY=:0 bun src/slice.ts --seconds 90
//
// Environment variables:
//   POE_DECK_PROBE    path to gs-hotkey-probe (default: as for POE_DECK_CLIP)
//   POE_DECK_KEYS     hotkey chord (default Control_L+Alt_L+C: Steam Input
//                     sends the LEFT Control, and the set comparison is exact)
//   POE_DECK_CLIP     path to gs-clip (default: next to the built daemon or
//                     ~/poe-deck-tools/gs-clip)
//   POE_DECK_TOOLBOX  distrobox with xclip, a fallback if there is no gs-clip (gs-probe)
//   POE_DECK_DUMP     directory to store raw clipboards as fixtures (empty = do not store)
//   DISPLAY           session display; the clipboard is read from it, not from the game display

import { existsSync } from 'node:fs'
import { loadDonorParser } from './donor'
import { gameFeatures } from './game-features'
import { toolPath } from './runtime'

const TOOLBOX = process.env.POE_DECK_TOOLBOX ?? 'gs-probe'

/** A trigger line of the hotkey probe: `  ★ [Control_L+Alt_L+C] #1  seq=…`. */
export function isTriggerLine (line: string): boolean {
  return line.includes('★')
}

/**
 * The advanced item description is why we read `Ctrl+Alt+C` and not `Ctrl+C`:
 * without it the item arrives without mods, the parser silently returns an empty statsByType,
 * and the slice would look working without being so.
 *
 * The block marker is taken from the donor, not made up: `advanced-mod-desc.ts:111-113`:
 * `isModInfoLine = line.startsWith('{') && line.endsWith('}')`.
 */
export function hasAdvancedBlock (text: string): boolean {
  return text.split('\n').some(line => {
    const trimmed = line.trim() // also cuts \r: the text arrives through Proton
    return trimmed.length > 1 && trimmed.startsWith('{') && trimmed.endsWith('}')
  })
}

interface LoggedItem {
  rarity?: string
  itemLevel?: number
  info: { name?: string, refName?: string }
  statsByType: Array<{
    stat: { ref: string }
    sources: Array<{ stat: { roll?: { value: number } } }>
  }>
}

/** What goes to the log for a parsed item. The whole slice exists for these lines. */
export function formatItem (item: LoggedItem): string[] {
  const head = [item.rarity, item.info.name ?? item.info.refName]
    .filter(Boolean)
    .join(' ')
  const lines = [`item: ${head || '(unnamed)'}  ilvl ${item.itemLevel ?? '-'}`]

  if (!item.statsByType.length) {
    // An item without mods is a normal state, not a copy failure: currency,
    // keys, maps and unidentified items have no mods at all, and they need the price check
    // just the same, by name and base, not by mods.
    lines.push('  no mods — normal for currency, keys and unidentified items')
    return lines
  }
  for (const { stat, sources } of item.statsByType) {
    const rolls = sources.map(s => s.stat.roll?.value).filter(v => v !== undefined)
    lines.push(`  ${stat.ref}${rolls.length ? `  = ${rolls.join(', ')}` : ''}`)
  }
  return lines
}

export type ClipboardReader = 'gs-clip' | 'xclip' | 'distrobox'

/**
 * What reads the X11 CLIPBOARD. The main path is our own `gs-clip` (src/render/gs-clip.c):
 * only libX11, which is on the stock rootfs, no container.
 *
 * `xclip` stays as a fallback: stock SteamOS does not have it and never will, the rootfs
 * is read-only, and the standard place for the tool is distrobox (the same decision as in
 * tools/probe-deck-input.sh). The fallback is for a developer whose
 * reader is not built yet, not for the player.
 */
export function clipboardReader (helperExists: boolean, has: (cmd: string) => boolean): ClipboardReader | null {
  if (helperExists) return 'gs-clip'
  if (has('xclip')) return 'xclip'
  if (has('distrobox')) return 'distrobox'
  return null
}

/**
 * The read command for the chosen path.
 *
 * `timeout` on xclip is not decoration: xclip hangs forever if the selection owner does not
 * answer, and the first `distrobox enter` also starts the container. `gs-clip`
 * has its own deadline inside, so it does not need an outer `timeout`.
 */
export function clipboardCommand (reader: ClipboardReader, display: string, helper: string): string[] {
  switch (reader) {
    case 'gs-clip':
      return [helper, '--display', display, '--timeout-ms', '2000']
    case 'xclip':
      return ['timeout', '5', 'xclip', '-o', '-selection', 'clipboard']
    case 'distrobox':
      return ['timeout', '30', 'distrobox', 'enter', TOOLBOX, '--', 'bash', '-lc',
        `DISPLAY='${display}' xclip -o -selection clipboard`]
  }
}

/** Path to `gs-clip`: next to the built daemon or in ~/poe-deck-tools. */
export const clipHelperPath = (): string => toolPath('gs-clip', process.env.POE_DECK_CLIP)

/** Which path reads the clipboard now, for the log line at start. */
export function currentClipboardReader (): ClipboardReader | null {
  return clipboardReader(existsSync(clipHelperPath()), cmd => Bun.which(cmd) !== null)
}

/** Reads the X11 CLIPBOARD. An empty string means the clipboard is empty, unreadable or there is nothing to read it with. */
export async function readClipboard (display: string): Promise<string> {
  const reader = currentClipboardReader()
  if (!reader) return ''

  const proc = Bun.spawn(clipboardCommand(reader, display, clipHelperPath()), {
    env: { ...process.env, DISPLAY: display },
    stdout: 'pipe',
    stderr: 'ignore'
  })
  const text = await new Response(proc.stdout).text()
  return (await proc.exited) === 0 ? text : ''
}

/**
 * The game puts the text into the clipboard asynchronously, so we cannot read right on the
 * `triggered` event (input recon, § 3.3). We wait for a change, but **do not require** it.
 *
 * Run #63 cost exactly this difference: the item copied was the same one that was already
 * in the clipboard, the text matched byte for byte, and the slice reported six times in a row
 * "the game did not give the item", although it did. A clipboard change is a sign
 * of freshness, not a sign that the copy happened.
 *
 * ponytail: freshness cannot be found from matching text in principle. If
 * we need to tell a new copy from an old one, put our own marker before arming
 * and measure the change against it; xclip must stay alive for that, because it
 * OWNS the selection, and on the Deck this already failed (tools/probe-deck-input.sh,
 * run #52). The slice does not need such precision: it needs the item in the log.
 */
export async function clipboardAfterTrigger (
  before: string,
  read: () => Promise<string>,
  timeoutMs = 3000
): Promise<{ text: string, fresh: boolean }> {
  const deadline = Date.now() + timeoutMs
  let text = before
  do {
    text = await read()
    if (text && text !== before) return { text, fresh: true }
    await Bun.sleep(200)
  } while (Date.now() < deadline)
  return { text, fresh: false }
}

/**
 * Raw clipboard to disk, if asked. Price check fixtures are taken from a live
 * Deck and only from it: text made up for the game checks the fantasy of the author,
 * not the parser. The name is by order, the content is byte for byte what the game gave.
 */
export async function dumpBuffer (text: string, index: number): Promise<void> {
  const dir = process.env.POE_DECK_DUMP
  if (!dir) return

  const path = `${dir}/buffer-${String(index).padStart(2, '0')}.txt`
  await Bun.write(path, text)
  console.log(`   raw clipboard saved: ${path}`)
}

async function main (): Promise<number> {
  const argv = process.argv.slice(2)
  const seconds = Number(argv[argv.indexOf('--seconds') + 1]) || 90
  const display = process.env.DISPLAY ?? ':0'
  const probePath = toolPath('gs-hotkey-probe', process.env.POE_DECK_PROBE)
  const chord = gameFeatures('poe1').copyItemChord
  const keys = process.env.POE_DECK_KEYS ?? 'Control_L+Alt_L+C'

  console.log(`slice: listening for ${keys} (${chord} from a Steam Input button), clipboard from DISPLAY=${display}, ${seconds}s`)

  // The parser starts BEFORE listening: the first start builds the donor binary
  // indexes, which takes seconds. Starting it on the first press would mean losing
  // the clipboard while the indexes are built.
  const parser = await loadDonorParser()
  console.log('donor parser loaded from the pin, waiting for a press')

  const probe = Bun.spawn([probePath, '--seconds', String(seconds), '--keys', keys], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'inherit'
  })

  // Both values are counted, and the FIRST one counts as the slice working. Currency,
  // keys and maps need the price check too: they have no mods and never will, but they have a price.
  // The second value is not a criterion but insurance against Ctrl+C: if no
  // item with mods arrived in a run, look at the button layout.
  let parsed = 0
  let withMods = 0
  let dumped = 0
  let before = await readClipboard(display)
  let tail = ''

  // What is in the clipboard BEFORE the press is printed and does not count for the slice. The point
  // is not the item, but that a run without a person at the Deck still shows
  // whether the clipboard read and the parser work on the device: otherwise "zero triggers"
  // cannot be told apart from "a link broke earlier".
  console.log(`clipboard before the press: ${before ? `${before.split('\n').length} lines, advanced block ${hasAdvancedBlock(before) ? 'present' : 'absent'}` : 'empty'}`)
  // It is a fixture too: an item copied in a previous run is as much
  // a real clipboard from the Deck as one taken with the gesture now.
  if (before) await dumpBuffer(before, 0)

  for await (const chunk of probe.stdout) {
    const lines = (tail + new TextDecoder().decode(chunk)).split('\n')
    tail = lines.pop() ?? ''

    for (const line of lines) {
      console.log(line)
      if (!isTriggerLine(line)) continue

      const { text, fresh } = await clipboardAfterTrigger(before, () => readClipboard(display))
      if (!text) {
        console.log('✗  clipboard empty — nothing to read')
        console.log('   look at: does the clipboard reader reach the session DISPLAY, and does the game copy at all')
        continue
      }
      if (!fresh) {
        console.log('⚠  clipboard did not change in 3s — parsing whatever is in it.')
        console.log('   The same item copies to byte-identical text, so this does not')
        console.log('   mean "nothing was copied"; only "new is indistinguishable from old".')
      }
      before = text
      await dumpBuffer(text, ++dumped)

      const result = parser.parseClipboard(text)
      if (result.isErr()) {
        console.log(`✗  parser rejected the clipboard: ${String(result.error)}`)
        console.log(`   first clipboard line: ${text.split('\n')[0]}`)
        continue
      }
      for (const out of formatItem(result.value)) console.log(out)
      parsed++
      if (hasAdvancedBlock(text)) withMods++
      console.log('✓  item parsed')
    }
  }
  await probe.exited

  console.log('')
  if (parsed > 0) {
    console.log(`RESULT: the slice works. Items parsed: ${parsed}, of them with mods: ${withMods}.`)
    // Zero items with mods in a run is not a failure, but it is not normal either: this is how
    // a series of items without mods looks, and also a plain Ctrl+C on the button layout.
    if (withMods === 0) {
      console.log('      No mod block in the whole run. If any of the items should have had')
      console.log('      mods, check the button layout in Steam Input.')
    }
    return 0
  }
  console.log('RESULT: no items at all. Either nothing was pressed or a link broke — see above.')
  return 1
}

if (import.meta.main) process.exit(await main())
