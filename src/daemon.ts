// The poe-deck daemon: lives for the whole game session, listens for the hotkey, shows the price.
//
// The whole chain, from the button to the panel over the game:
//
//   button_back_left (Ctrl+Alt+C)
//     ├─→ the game puts the advanced item description into CLIPBOARD
//     └─→ the gamescope hotkey hears the same chord
//          → read CLIPBOARD from the session :0       (slice.ts)
//          → parser from the donor pin                (donor.ts)
//          → price request: mods / name and base      (price-check.ts)
//          → panel over the game                      (panel.ts → src/render)
//
//   left touchpad (mouse behaviour) → cursor on the GAME server
//     └─→ gs-pointer reads it by polling             (src/render/gs-pointer.c)
//          → the cursor on the panel opens the editor (overlay.ts)
//          → L4 (Ctrl+Shift) toggles and confirms
//
// The difference from `src/slice.ts` is not in the functions but in the life cycle: the slice
// proved the chain in 90 seconds and ended there; the daemon survives entering
// the game, leaving to the Steam interface and coming back. Everything the slice already proved on
// hardware (clipboard read, parser start, parsing probe lines) comes from it
// by import and is not rewritten.
//
// Two requirements came here as mandatory, not as nice-to-have, and both follow from
// measurements, not from preference:
//
//  1. PRIVATE PROTOCOL MITIGATION (ADR 0002, § Price). `gamescope_action_binding`
//     is marked "Regular Wayland clients must not use it", Valve does not have to
//     keep it, and a mismatch between the implementation and its own XML WAS ALREADY seen on
//     hardware. Hence: check the global and its version BEFORE work, detect the order of
//     the `triggered` arguments on the fly, and degrade with a clear message instead of
//     a stack trace if the protocol is missing.
//
//  2. AUTO-HIDE BY `GAMESCOPE_FOCUSED_APP` (overlay spike, exp. 6). The daemon
//     is not tied to the life cycle of the game and does not go away with it, so it must
//     hide itself, otherwise it hangs over the Steam interface.
//
// The order of the `triggered` arguments is detected BY THE PROBE ITSELF, in C, and this is not laziness:
// the recipe (build both word layouts and take the one whose timestamp is plausible
// against CLOCK_MONOTONIC) is written and checked on a live Deck, and it
// lives there. The daemon reads its verdict as a line from stdout. It draws no conclusions
// of its own from the event time and flags, so a version mismatch does not
// affect it. The verdict is still printed, because the next person who wants
// to rely on `trigger_flags` will need to know it.
//
// On the Deck it runs as a `systemd --user` unit, installed by `install.sh` from the release archive;
// the full recipe: docs/ops/deck-daemon.md. By hand from SSH it works the same:
//
//   bun src/daemon.ts
//
// Environment variables:
//   POE_DECK_PROBE     path to gs-hotkey-probe. All C binaries share one default:
//                      next to the built daemon, for sources ~/poe-deck-tools
//                      (src/runtime.ts)
//   POE_DECK_PANEL     path to gs-panel.
//                      No renderer: the price goes only to the log, the daemon lives on
// The player sets the league, market and panel TTL in ~/.config/poe-deck/poe-deck.conf
// (src/config.ts); the variables below override the file, test runs use them.
//
//   POE_DECK_PANEL_TTL how many seconds to keep the panel on screen (15). While the cursor
//                      is on the panel, the timer stops: do not hide what a person is editing
//   POE_DECK_POINTER   path to gs-pointer.
//                      None: the price check works as before, the editor does not open
//   POE_DECK_ACT_KEYS  fallback chord for the editor action (off by default)
//   POE_DECK_TOGGLE_KEYS chord "hide the panel / bring the result back" (Control_L+Shift_L, L4)
//   POE_DECK_LEAVE_MS  how long until the editor collapses after the cursor left (1200)
//   POE_DECK_PX_PER_STEP pixels of finger movement per value step while editing (14)
//   POE_DECK_PRICE_MODE price market: securable (default) | available | online | onlineleague | any
//   POE_DECK_KEYS      hotkey chord (default Control_L+Alt_L+C: Steam Input
//                      sends the LEFT Control, the set comparison is exact)
//   POE_DECK_GAME      poe1 | poe2, default poe1
//   POE_DECK_WINDOW    how many seconds the probe stays armed per run (3600)
//   POE_DECK_CLIP      path to gs-clip, the clipboard reader
//   POE_DECK_TOOLBOX   distrobox with xclip, the fallback path without gs-clip (gs-probe, slice.ts)
//   POE_DECK_LEAGUE    override the league (otherwise the config, otherwise /api/leagues once)
//   POE_DECK_POESESSID session cookie, only for private leagues (docs/recon/poesessid.md)
//   POE_DECK_DUMP      directory for raw buffers; fixtures are captured only this way
//   POE_DECK_QUERY_DUMP directory for bodies of outgoing requests (acceptance: screen vs request)
//   POE_DECK_SHOT_HINT hint file for the job "panel is on screen, take the shot" (ci/)
//   XDG_STATE_HOME     where the marker "ready frame already shown" lives (~/.local/state/poe-deck)
//   DISPLAY, GAMESCOPE_WAYLAND_DISPLAY, XDG_RUNTIME_DIR
//                      if not set, they come from /run/user/<uid>/gamescope-environment

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { effectiveSettings, loadConfig } from './config'
import { gameFeatures, type GameVersion } from './game-features'
import { loadDonorParser } from './donor'
import { isPressed, parsePointerLine } from './input/pointer'
import { clearFrame, explainFailure, readyFrame } from './panel'
import {
  describe as describeOverlay,
  describeToggle,
  newOverlay,
  step as overlayStep,
  type Overlay,
  type OverlayEvent
} from './overlay'
import { formatPriceCheck, priceOf } from './price-check'
import { COMPILED, toolPath } from './runtime'
import {
  clipboardAfterTrigger,
  clipboardReader,
  clipHelperPath,
  currentClipboardReader,
  dumpBuffer,
  formatItem,
  hasAdvancedBlock,
  isTriggerLine,
  readClipboard
} from './slice'
import type { EditorSearch } from './editor'
import { currentLeague, UnknownLeagueError } from './trade/client'
import {
  DEFAULT_SEARCH_MODE,
  MODE_LABEL,
  statFilters,
  type SearchMode
} from './trade/query'

/** Degradation exit code: the protocol is missing, but the daemon is not broken. */
export const EXIT_NO_PROTOCOL = 3

// ── session environment ──────────────────────────────────────────────────────

/**
 * Parse `/run/user/<uid>/gamescope-environment`. The file is needed because the
 * `systemd --user` unit starts before Game Mode and does not see the session variables, and
 * they cannot be read from `/proc/<pid>/environ` of gamescope itself: the binary has a
 * file capability, the process is non-dumpable (a pitfall from docs/ops).
 */
export function parseSessionEnv (text: string): Record<string, string> {
  const wanted = ['DISPLAY', 'WAYLAND_DISPLAY', 'GAMESCOPE_WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    if (wanted.includes(key)) out[key] = line.slice(eq + 1).trim()
  }
  return out
}

/** Fills in missing session variables from the gamescope file. Does not overwrite the set ones. */
export function adoptSessionEnv (): string | null {
  const path = `/run/user/${process.getuid?.() ?? 1000}/gamescope-environment`
  if (!existsSync(path)) return null
  const env = parseSessionEnv(readFileSync(path, 'utf8'))
  for (const [key, value] of Object.entries(env)) {
    if (!process.env[key]) process.env[key] = value
  }
  return path
}

// ── private protocol mitigation ──────────────────────────────────────────────

export type DumpVerdict =
  | { kind: 'ok', version: number }
  | { kind: 'no-probe' | 'no-socket' | 'no-manager' | 'unclear', message: string, hint: string }

/**
 * Parse `gs-hotkey-probe --dump`: is the global there, and which version is it.
 *
 * The probe tells the outcomes apart itself and prints them as text; here we only classify
 * its output, so that the daemon can say "no protocol" separately from "this is not a
 * gamescope session at all". Different causes mean different actions for the log reader.
 */
export function parseDumpVerdict (stdout: string, code: number): DumpVerdict {
  const version = stdout.match(/gamescope_action_binding_manager present, version (\d+)/)
  if (code === 0 && version) return { kind: 'ok', version: Number(version[1]) }

  // The patterns below match the output of the C probe (docs/spikes/gamescope-hotkey):
  // change these strings together with it, in one commit,
  // otherwise the daemon stops recognizing its own probe.
  if (stdout.includes('could not connect to socket')) {
    return {
      kind: 'no-socket',
      message: 'no gamescope socket — this is not a Game Mode session',
      hint: 'the daemon targets Game Mode; there is nothing to do in Desktop Mode. Socket name lives in /run/user/<uid>/gamescope-environment'
    }
  }
  if (stdout.includes('NOT in the registry')) {
    return {
      kind: 'no-manager',
      message: 'gamescope is here, gamescope_action_binding_manager is not in the registry',
      hint: 'the protocol is private with no ABI promise (ADR 0002 § Price): a SteamOS update may have dropped it or filtered clients out. Fallback paths are in the same ADR'
    }
  }
  return {
    kind: 'unclear',
    message: `probe returned ${code}, could not parse its answer`,
    hint: 'full probe output is above; check by hand with gs-hotkey-probe --dump'
  }
}

/**
 * The probe verdict on the order of the `triggered` arguments. The value is not cosmetic:
 * on gamescope ≤3.16.24 (and the Deck runs 3.16.23.4) the flags and the time are swapped
 * against the XML of the same tag, and `trigger_flags` cannot be read without this check.
 * The daemon uses neither the time nor the flags, but to keep silent about it
 * would leave a pitfall for the next person.
 */
export function argOrderFromLine (line: string): 'xml' | 'swapped' | 'unknown' | null {
  if (!line.includes('triggered argument order')) return null
  if (line.includes('NOT RECOGNIZED')) return 'unknown'
  return line.includes('≤3.16.24') ? 'swapped' : 'xml'
}

/**
 * A probe complaint as opposed to its routine output. The probe prints an "alive" tick every few
 * seconds; per session that is thousands of lines, and there is no reason to copy them to the log. But
 * `✗`/`⚠` must be copied: that is where "the hotkey manager left the registry" lives,
 * that is, the protocol was taken away while running.
 */
export function isProbeComplaint (line: string): boolean {
  const trimmed = line.trim()
  return (trimmed.startsWith('✗') || trimmed.startsWith('⚠')) && !isTriggerLine(trimmed)
}

/**
 * Is the protocol there, and which version: `gs-hotkey-probe --dump`. One check for
 * the daemon and `poe-deck doctor`: two implementations of one question would one day
 * answer differently. Only doctor sets a timeout: a probe stuck on the socket does not
 * hang it. The daemon sets no timeout: at Game Mode start gamescope can be slow,
 * and waiting for it is correct.
 */
export async function probeProtocol (probePath: string, timeoutMs?: number): Promise<DumpVerdict> {
  if (!existsSync(probePath)) {
    return { kind: 'no-probe', message: `no hotkey probe: ${probePath}`, hint: HOW_TO_GET_TOOLS }
  }
  try {
    const dump = Bun.spawn([probePath, '--dump'], { env: process.env, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs })
    const out = await new Response(dump.stdout).text()
    const code = await dump.exited
    if (dump.signalCode && timeoutMs) {
      return {
        kind: 'unclear',
        message: `probe gave no answer in ${timeoutMs / 1000}s`,
        hint: 'gamescope may still be starting — wait a minute in Game Mode and check again'
      }
    }
    return parseDumpVerdict(out, code)
  } catch (err) {
    // The file exists but does not start (permissions, wrong architecture): the tool set
    // is broken, the protocol is not missing. Say it in words, not with a stack trace.
    return { kind: 'unclear', message: `probe did not start: ${(err as Error).message}`, hint: HOW_TO_GET_TOOLS }
  }
}

// ── first start ──────────────────────────────────────────────────────────────

/**
 * The marker "ready frame already shown". It lives in `$XDG_STATE_HOME`, not next to the
 * config: it is daemon state, not a player setting, and it can be deleted
 * without losing the league. Delete the marker and the frame shows again; this is the way
 * to repeat the first start.
 */
export function readyMarkerPath (env = process.env): string {
  return `${env.XDG_STATE_HOME || `${env.HOME}/.local/state`}/poe-deck/ready-shown`
}

/** Writes the marker. If that fails (no permissions, full disk), the frame shows once more, nothing else. */
function markReadyShown (path: string): string | null {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${new Date().toISOString()}\n`)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

// ── auto-hide ────────────────────────────────────────────────────────────────

/**
 * AppId from `xprop -root GAMESCOPE_FOCUSED_APP`. `null` means no game on screen:
 * the atom is either empty (Steam interface) or missing entirely.
 */
export function parseFocusedApp (xpropOut: string): number | null {
  const match = xpropOut.match(/=\s*(\d+)/)
  return match ? Number(match[1]) : null
}

async function focusedApp (display: string): Promise<number | null> {
  // The try/catch is not about a missing xprop (the preflight below catches that). It is
  // because this call lives in setInterval: there any spawn failure would become an
  // unhandled promise rejection and kill the whole daemon. Silently returning "no game"
  // is worse than a crash only if nobody says so, so we say it.
  try {
    const proc = Bun.spawn(['timeout', '5', 'xprop', '-root', 'GAMESCOPE_FOCUSED_APP'], {
      env: { ...process.env, DISPLAY: display },
      stdout: 'pipe',
      stderr: 'ignore'
    })
    const text = await new Response(proc.stdout).text()
    return (await proc.exited) === 0 ? parseFocusedApp(text) : null
  } catch (err) {
    log(`⚠  could not read GAMESCOPE_FOCUSED_APP: ${String(err)}`)
    return null
  }
}

/**
 * `DISPLAY` of the GAME server. The left touchpad cursor lives there, not on the session
 * `:0` where the panel is drawn (ADR 0002, F11 and F13): we draw on our side and take the
 * coordinates from there. There is no session variable for this: the game server is visible only in
 * the environment of its own process.
 */
export function gameDisplayFrom (environ: string): string | null {
  for (const entry of environ.split('\0')) {
    if (entry.startsWith('DISPLAY=')) return entry.slice('DISPLAY='.length) || null
  }
  return null
}

/**
 * What to do with the cursor reader, given which server it reads from
 * (`running`) and where the game is now (`found`).
 *
 * The daemon starts with the session login, usually before the game, and the game can
 * restart on another server. So the server is not looked up once at
 * start but again while the game is on screen: otherwise after a Deck reboot
 * the editor would not open until the daemon restarts. A missing game does not stop
 * the reader, because `pgrep` may only have missed the server; the daemon forgets a dead
 * reader itself, and the next pass starts it again.
 */
export type PointerAction = 'wait' | 'keep' | 'start' | 'restart'
export function pointerAction (running: string | null, found: string | null): PointerAction {
  if (!found) return running ? 'keep' : 'wait'
  if (!running) return 'start'
  return running === found ? 'keep' : 'restart'
}

async function gameDisplay (appId: number | string): Promise<string | null> {
  try {
    const found = Bun.spawnSync(['pgrep', '-f', `SteamLaunch AppId=${appId}( |$)`])
    const pid = new TextDecoder().decode(found.stdout).split('\n')[0]?.trim()
    if (!pid) return null
    return gameDisplayFrom(readFileSync(`/proc/${pid}/environ`, 'utf8'))
  } catch {
    return null
  }
}

/**
 * External commands the daemon cannot work without. They are checked BEFORE work
 * as one list: `Bun.spawn` throws on a missing binary, and without this
 * check a missing `xprop` crashes the daemon with a stack trace, exactly what ADR 0002
 * forbids (found by a run on mini, which has no `timeout` from coreutils at all).
 *
 * The clipboard is read by our own `gs-clip`; `xclip` on the host or in distrobox is
 * the developer fallback, so any one of the three is enough.
 */
export function missingTools (has: (cmd: string) => boolean, clipHelper = false): string[] {
  const missing = ['timeout', 'xprop'].filter(cmd => !has(cmd))
  if (!clipboardReader(clipHelper, has)) missing.push('gs-clip (or xclip as a fallback)')
  return missing
}

/**
 * An L5 press on a clipboard that did not change is a repeat of an already checked
 * item, if the price came from exactly this text and the result is still held.
 * Otherwise it is the old refusal "the game did not copy": showing the price of a different item
 * is worse than an honest refusal (#147).
 */
export function isRepeatOfPriced (text: string, pricedBuffer: string | undefined, last: unknown): boolean {
  return Boolean(text) && text === pricedBuffer && Boolean(last)
}

// ── daemon ───────────────────────────────────────────────────────────────────

/**
 * Where the C binaries come from: the hint for any missing one. With the built daemon
 * they ship in the same set; with sources they are built on the Deck.
 */
export const HOW_TO_GET_TOOLS = COMPILED
  ? 'it ships next to the poe-deck executable — the install is incomplete, run install.sh from the release archive again'
  : 'build it on the Deck: MODE=SETUP of poe-deck/deck-probe, or tools/dev-workspace.sh'

const now = () => new Date().toTimeString().slice(0, 8)
const log = (line: string) => { console.log(`${now()}  ${line}`) }

// ── panel ────────────────────────────────────────────────────────────────────

/**
 * The display layer: one long-lived `gs-panel` for the whole session, frames go to its
 * stdin. We do not start a process per item: the X11 window and opening the font
 * cost more than the frame itself (0.43 ms, ADR 0003 F3), and the panel is cleared with an empty
 * frame, not by killing the process.
 *
 * **A missing renderer does not crash the daemon.** The price check stays:
 * the price goes to the log. It is the same rule as with the private protocol: do not keep
 * silent, and there is no reason to crash.
 */
interface Panel {
  show: (lines: string[]) => void
  clear: () => void
  close: () => void
  readonly live: boolean
}

function openPanel (path: string): Panel {
  if (!existsSync(path)) {
    log(`⚠  no renderer: ${path} — price will only reach the log`)
    log(`   ${HOW_TO_GET_TOOLS}`)
    return { show: () => {}, clear: () => {}, close: () => {}, live: false }
  }

  // --seconds 0: it lives until killed. We do not set --hz at all: redraws
  // happen on events (ADR 0003, Decision 3), and the rate there is a measurement mode.
  const proc = Bun.spawn([path, '--seconds', '0'], {
    env: process.env,
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit'
  })

  let alive = true
  let closing = false
  void proc.exited.then(code => {
    alive = false
    // Do not complain about our own stop: `close()` killed it.
    // Otherwise every normal daemon exit would look like a failure in the log.
    if (!closing) log(`⚠  renderer exited with ${code} — no panel any more, price stays in the log`)
  })

  const write = (lines: string[]): void => {
    if (!alive) return
    proc.stdin.write(`${lines.join('\n')}\n`)
    proc.stdin.flush()
  }

  return {
    show: write,
    clear: () => write(clearFrame()),
    // No need to clear with a frame before exit: the window goes away with the process.
    close: () => { closing = true; alive = false; proc.kill() },
    get live () { return alive }
  }
}

/**
 * A hint for the job: the price panel is on screen, time for a screenshot. A file, not
 * our own `xprop` call: the job shell already takes the shot (`screenshot()` in
 * ci/Jenkinsfile.deck), and it does not need a second implementation of the same.
 */
async function hintScreenshot (label: string): Promise<void> {
  const path = process.env.POE_DECK_SHOT_HINT
  if (!path) return
  await Bun.write(path, `${label}\n`)
}

export async function main (): Promise<number> {
  const version = (process.env.POE_DECK_GAME ?? 'poe1') as GameVersion
  const features = gameFeatures(version)
  const probePath = toolPath('gs-hotkey-probe', process.env.POE_DECK_PROBE)
  const panelPath = toolPath('gs-panel', process.env.POE_DECK_PANEL)
  const keys = process.env.POE_DECK_KEYS ?? 'Control_L+Alt_L+C'
  // The editor action is a touchpad click (F15): it arrives as a mask in the same
  // lines as the coordinates. The chord stays a fallback in case
  // the click is removed from the layout; L4 turned out awkward on live run #98.
  // The editor action is a touchpad click (F15). The chord stays a fallback and
  // is off by default: L4 turned out awkward on live run #98, and the button itself
  // is needed more for the second gesture (see `toggleKeys`).
  const actKeys = process.env.POE_DECK_ACT_KEYS ?? ''
  // The second gesture of the epic: hide the panel / bring back the last result with no
  // trade request. It lives on L4, the only free back button.
  const toggleKeys = process.env.POE_DECK_TOGGLE_KEYS ?? 'Control_L+Shift_L'
  const pointerPath = toolPath('gs-pointer', process.env.POE_DECK_POINTER)
  const window = Number(process.env.POE_DECK_WINDOW) || 3600
  // The player config, with the run variables on top (src/config.ts). A broken
  // file does not crash the daemon: errors go to the log, and everything that
  // parsed stays in force. Under `Restart=always` an exit on a config typo would be
  // an endless restart with no price.
  const config = loadConfig()
  const effective = effectiveSettings(config.settings)
  const settings = effective.settings
  const panelTtl = (settings.panelTtl ?? 15) * 1000
  // How long to wait before the editor collapses back to the price: with a relative
  // pointer (F14) any extra finger movement touches the panel edge.
  const leaveMs = Number(process.env.POE_DECK_LEAVE_MS ?? 1200)
  // How many pixels of finger movement per value step in bound edit mode.
  const pxPerStep = Number(process.env.POE_DECK_PX_PER_STEP ?? 14)
  // The market the price comes from. The default is instant buyout: it does not need
  // the seller online, so it answers with a price you can get now.
  const priceMode: SearchMode = settings.priceMode ?? DEFAULT_SEARCH_MODE

  const envFile = adoptSessionEnv()
  const display = process.env.DISPLAY ?? ':0'
  log(`poe-deck daemon: ${version}, app ${features.steamAppId}, chord ${keys} (${features.copyItemChord} from a Steam Input button)`)
  log(`hide/restore gesture: ${toggleKeys} (no trade request either way)`)
  log(`config: ${config.exists ? config.path : `${config.path} not found — defaults`}`)
  for (const error of [...config.errors, ...effective.errors]) log(`✗  config: ${error} — ignored, run poe-deck doctor`)
  log(`price mode: ${MODE_LABEL[priceMode]} (${priceMode}); change with price_mode in the config or in the editor`)
  log(`session environment: ${envFile ?? 'no gamescope file, using what is set'}; DISPLAY=${display}`)

  // ── check the environment and the protocol BEFORE everything else ─────────
  const missing = missingTools(cmd => Bun.which(cmd) !== null, existsSync(clipHelperPath()))
  if (missing.length) {
    log(`✗  missing external commands: ${missing.join(', ')}`)
    log('   without xprop the GAMESCOPE_FOCUSED_APP auto-hide does not work, and it is mandatory')
    log('   (overlay spike, exp. 6): otherwise the daemon hangs over the Steam UI')
    if (missing.some(tool => tool.startsWith('gs-clip'))) log(`   gs-clip: ${HOW_TO_GET_TOOLS}`)
    return EXIT_NO_PROTOCOL
  }
  // Log the clipboard read path right away: the fallback xclip on the player Deck means
  // the tool set is not fully unpacked, and there is no reason to find that through a missing price.
  log(`clipboard reader: ${currentClipboardReader()} (${clipHelperPath()})`)

  const verdict = await probeProtocol(probePath)
  if (verdict.kind !== 'ok') {
    log(`✗  ${verdict.message}`)
    log(`   ${verdict.hint}`)
    if (verdict.kind !== 'no-probe') log('   the daemon does not start — this is degradation, not a crash')
    return EXIT_NO_PROTOCOL
  }
  log(`✓  protocol in place: gamescope_action_binding_manager version ${verdict.version}`)
  if (verdict.version > 1) {
    log(`⚠  global version ${verdict.version} is newer than the probe targets (1) — the probe will bind 1`)
    log('   harmless for now, but look here first if something behaves oddly')
  }

  // The parser starts BEFORE listening: the first start builds the binary indexes of
  // the donor, that takes seconds. On the first press it would be too late: the clipboard moves on.
  const parser = await loadDonorParser(version)
  log('✓  donor parser loaded from the pin')

  const panel = openPanel(panelPath)
  if (panel.live) log('✓  renderer up, panel clears with an empty frame')

  // The league is asked ONCE per session, not on every press: `/api/leagues`
  // is the same kind of GGG request as the search itself, and there is no reason to spend it per button.
  // A failure here does not crash the daemon: the league is asked again on the first item.
  let league: string | undefined
  try {
    league = await currentLeague('pc', settings.league)
    log(`✓  league: ${league}`)
  } catch (err) {
    const { title, detail } = explainFailure(err)
    log(`⚠  could not resolve the league (${title}: ${detail}) — will ask again on the first item`)
  }

  // ── auto-hide ─────────────────────────────────────────────────────────────
  // Poll, do not subscribe: `xprop -spy` would keep one more long-lived
  // process for a state that changes once a minute. A second of delay
  // costs nothing: items are price-checked in the game, not in the QAM.
  let inGame = await focusedApp(display) === features.steamAppId
  log(inGame ? '▶  game focused — handling presses' : '⏸  game is not on screen — hiding, still listening for the hotkey')

  // The "ready" frame shows once per device, on the first entry into the game after
  // install. Only over the game and only with a live renderer: a frame
  // sent nowhere must not set the marker, otherwise the player never sees it.
  const readyMarker = readyMarkerPath()
  let readyPending = panel.live && !existsSync(readyMarker)
  const showReady = (): void => {
    if (!readyPending || !inGame || !panel.live) return
    send({ kind: 'notice', frame: readyFrame() })
    // The panel is busy with a price, so the player is already pressing the button; the frame waits for the next game entry.
    if (overlay.mode !== 'notice') return
    readyPending = false
    const failed = markReadyShown(readyMarker)
    log(failed
      ? `⚠  ready frame shown, but the marker was not written (${failed}) — it will show again next start`
      : `★  first start: ready frame shown once, marker ${readyMarker}`)
    hintScreenshot('ready').catch(err => log(`⚠  screenshot hint not written: ${String(err)}`))
  }

  // ── life for the whole session ────────────────────────────────────────────
  let running = true
  let parsed = 0
  let priced = 0
  let before = await readClipboard(display)
  let restarts = 0
  let probe: ReturnType<typeof Bun.spawn> | null = null

  // What is on the panel and when to clear it is one state (src/overlay.ts), not
  // timers scattered over the daemon. Only delivery stays here: event in,
  // frame out, confirmed search to the network.
  let overlay: Overlay = newOverlay(priceMode)
  let searching = false
  let lastSearch = { stats: '', at: 0 }
  // The clipboard that `overlay.last` came from. A repeat L5 on it is not
  // "the game did not copy" but "show it again".
  let pricedBuffer: string | undefined

  const send = (event: OverlayEvent): void => {
    const was = overlay.mode
    const done = overlayStep(overlay, event, Date.now(), { ttlMs: panelTtl, leaveMs, pxPerStep })
    overlay = done.overlay
    if (done.frame) panel.show(done.frame)
    // Clearing by TTL is not the same as "the player hid it": the result can still
    // be brought back, and acceptance needs to see that the TTL really fired
    // (run #125 had no such lines at all).
    if (event.kind === 'tick' && was !== 'idle' && overlay.mode === 'idle') {
      log(`⏸  panel cleared by ttl (${panelTtl / 1000}s) — L4 still brings the result back`)
    }
    if (done.search) void runSearch(done.search)
  }

  /**
   * A repeat search with the confirmed filters. One operation at a time: a series of
   * presses must not build a queue of GGG requests (an epic requirement).
   */
  const runSearch = async (confirmed: EditorSearch): Promise<void> => {
    const item = overlay.item
    const { stats, mode } = confirmed
    if (!item) return
    if (searching) { log('⚠  a search is already running — skipping this confirm'); return }

    // The same set twice in a row is no reason to go to GGG again: on run #101 ten
    // clicks on "confirm" gave ten identical requests. After a pause
    // a repeat is allowed: rechecking the price with the same set is a fair wish.
    // The mode is part of the signature: changing the market and asking again is a different question.
    const signature = JSON.stringify(confirmed)
    if (signature === lastSearch.stats && Date.now() - lastSearch.at < 3000) {
      log('⚠  the same filter set was just searched — skipping the repeat')
      // The click already moved the panel to "checking…", and the dropped repeat gets no
      // answer, so the panel would hang waiting until the next back button (run
      // #133, 18:58:39). The answer to the same question already exists: show it.
      if (overlay.check) send({ kind: 'price', item, check: overlay.check })
      return
    }
    lastSearch = { stats: signature, at: Date.now() }
    searching = true
    try {
      league ??= await currentLeague('pc', settings.league)
      const t0 = Date.now()
      const check = await priceOf(item, { league, stats, mode })
      log(`   ${formatPriceCheck(item, check)}`)
      // A search without `stats` means cancel brought back the auto set: the log shows it
      // as a word, not as an empty filter list.
      const label = stats ? `filters ${stats.length}` : 'auto set (cancel)'
      // Which ids exactly went out: without this an empty result is ambiguous: the
      // player set is too narrow, or a mod is searched with the wrong id. On run #107 the second
      // was visible only from the filters of the auto set.
      if (stats) log(`   filters: ${stats.map(stat => [stat.id, ...(stat.alt ?? [])].join('|')).join(', ')}`)
      log(`⏱  confirm -> price: ${Date.now() - t0} ms, ${label}, mode ${mode}`)
      send({ kind: 'price', item, check })
    } catch (err) {
      const failure = explainFailure(err)
      log(`✗  filtered search failed: ${failure.title} — ${failure.detail}`)
      if (err instanceof UnknownLeagueError) league = undefined
      send({ kind: 'failure', failure })
    } finally {
      searching = false
    }
  }

  // The panel clock: clearing by TTL and collapsing the editor when the finger left.
  const overlayTimer = setInterval(() => send({ kind: 'tick' }), 200)

  // The focus timer starts only here, when `send` and `overlay` already exist:
  // before, until the first clipboard read (up to 30 s through distrobox), entering the game
  // called `send` before its declaration: ReferenceError and a daemon crash.
  const focusTimer = setInterval(() => {
    void focusedApp(display).then(app => {
      const next = app === features.steamAppId
      if (next === inGame) return
      inGame = next
      // The panel must not hang over the Steam interface: collapse everything,
      // including an open editor (overlay spike, exp. 6).
      if (!inGame) send({ kind: 'focus', inGame: false })
      showReady()
      log(inGame
        ? '▶  game is focused again — handling presses'
        : `⏸  focus left the game (${app ?? 'empty'}) — hiding, still listening for the hotkey`)
    })
  }, 2000)
  showReady()

  // ── cursor ────────────────────────────────────────────────────────────────
  //
  // The left touchpad moves the pointer on the GAME server (ADR 0002, F13 and F14), and
  // it is read by polling: the overlay layer needs neither focus nor events.
  // A missing reader does not crash the daemon: the price check works as before, only
  // the editor does not open.
  let pointer: ReturnType<typeof Bun.spawn> | null = null
  // The server the current reader reads from. `null` means no reader.
  let pointerDisp: string | null = null
  let pointerBusy = false
  let warnedNoGame = false

  const readPointer = (proc: ReturnType<typeof Bun.spawn>, disp: string): void => {
    void (async () => {
      let tail = ''
      // The press comes from the same line as the coordinates: the touchpad click is bound
      // to the left mouse button, and it arrives as the XQueryPointer mask (F15).
      // The action fires on the press EDGE: holding must not fire it again and again.
      let held = false
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        const lines = (tail + new TextDecoder().decode(chunk)).split('\n')
        tail = lines.pop() ?? ''
        for (const line of lines) {
          const at = parsePointerLine(line)
          if (!at) continue
          // The cursor touches the panel only in the game: a gesture in the Steam interface
          // must not edit a draft nobody can see.
          if (!inGame) { held = isPressed(at.mask); continue }
          send({ kind: 'pointer', x: at.x, y: at.y })
          const now = isPressed(at.mask)
          if (now && !held) {
            send({ kind: 'act' })
            log(`★  click: ${describeOverlay(overlay)}`)
          }
          held = now
        }
      }
    })().catch(err => log(`⚠  pointer reading broke off: ${String(err)}`))
      .finally(() => {
        // The reader went away with the game server (PoE exit, restart):
        // forget it, and the next focus pass finds the game again.
        if (pointer !== proc) return
        pointer = null
        pointerDisp = null
        if (running) log(`⚠  cursor reader on ${disp} stopped — looking for the game again`)
      })
  }

  /** Find the game server and keep the cursor reader on it. */
  const ensurePointer = async (): Promise<void> => {
    if (pointerBusy || !running) return
    pointerBusy = true
    try {
      const found = await gameDisplay(features.steamAppId)
      const action = pointerAction(pointerDisp, found)
      if (action === 'wait') {
        if (!warnedNoGame) log('⏸  game server not found yet — the editor opens once the game is running')
        warnedNoGame = true
        return
      }
      if (action === 'keep' || !found) return
      if (action === 'restart') {
        log(`↻  the game moved from ${pointerDisp} to ${found} — re-reading the cursor there`)
        stopPointer()
      }
      warnedNoGame = false
      log(`✓  reading the cursor from ${found}; act is a touchpad click${actKeys ? `, fallback is the ${actKeys} chord` : ''}`)
      const proc = Bun.spawn([pointerPath, '--display', found, '--hz', '60', '--seconds', '0'],
        { env: process.env, stdout: 'pipe', stderr: 'inherit' })
      pointer = proc
      pointerDisp = found
      readPointer(proc, found)
    } finally {
      pointerBusy = false
    }
  }

  /** Stop the cursor reader. Done in a function because the `pointer` assignments live in closures. */
  const stopPointer = (): void => {
    const proc = pointer
    pointer = null
    pointerDisp = null
    proc?.kill()
  }

  const hasPointerReader = existsSync(pointerPath)
  if (!hasPointerReader) {
    log(`⚠  no pointer reader: ${pointerPath} — the filter editor will not open`)
    log('   it builds with the same recipe as the renderer (src/render/build.sh)')
  } else {
    await ensurePointer()
  }
  // While the game is on screen, its server is looked up again: the daemon starts before the game, and
  // the game can restart on another server (see `pointerAction`).
  const pointerTimer = hasPointerReader
    ? setInterval(() => { if (inGame) void ensurePointer() }, 2000)
    : undefined

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      running = false
      log(`${signal} — shutting down cleanly, items this session: ${parsed}, prices: ${priced}`)
      clearInterval(overlayTimer)
      clearInterval(pointerTimer)
      panel.close()
      stopPointer()
      probe?.kill()
    })
  }

  /** One press of the price check button: clipboard → parser → trade → panel. */
  const handlePress = async (line: string): Promise<void> => {
    log(line.trim())
    // The response time count starts HERE, on the probe line: before that the daemon
    // has nothing, and the probe prints the line right on the event.
    const t0 = Date.now()
    const { text, fresh } = await clipboardAfterTrigger(before, () => readClipboard(display))
    if (!text) {
      log('✗  clipboard empty — nothing to read')
      send({ kind: 'failure', press: true, failure: { title: 'clipboard empty', detail: 'the game copied nothing', todo: 'hover an item and press again' } })
      return
    }
    // The clipboard did not change, so the game client did not give the item, and the clipboard holds
    // the previous one. Parsing it means showing the price of a different item: on #147 seven
    // presses out of 13 gave Orb of Alchemy this way instead of the hovered item.
    // A repeat on the same item lands here too: the text matches byte for byte,
    // nothing tells them apart; the tester chose an honest refusal (10.11).
    //
    // The exception is a clipboard that already has a price (rc6, remark 15):
    // L5 → L4 → L5 on the same item was silent, because the hidden panel swallowed
    // the refusal. So we show the previous result the way L4 would bring it back:
    // with no request, with the item name and the price age. If the game in fact
    // did not copy another item, the player sees the old name and
    // "N min ago" on the panel, not a fresh price under a different item, as on #147.
    if (!fresh) {
      if (isRepeatOfPriced(text, pricedBuffer, overlay.last)) {
        if (!inGame) { log('⏸  the game left the screen while reading the clipboard — not showing the item'); return }
        const was = overlay
        send({ kind: 'recall' })
        log(`★  same item again, no request: ${describeToggle(was, overlay, Date.now())}`)
        return
      }
      log('✗  clipboard did not change in 3s — the game client did not copy the item')
      send({ kind: 'failure', press: true, failure: { title: 'game did not copy the item', detail: 'the clipboard did not change in 3s', todo: 'hover the item and press again' } })
      return
    }
    before = text
    const tClip = Date.now()

    // The focus is read again AFTER the clipboard wait, not only before the press:
    // up to three seconds pass between them, and in that time the player can leave
    // to the Steam interface. A check "at the entry" would let such an item through to
    // display. Now that is one extra log line, but with the overlay it is exactly
    // what the daemon must not do: draw over the Steam interface.
    if (!inGame) {
      log('⏸  the game left the screen while reading the clipboard — not showing the item')
      return
    }

    const result = parser.parseClipboard(text)
    if (result.isErr()) {
      log(`✗  parser rejected the clipboard: ${String(result.error)}`)
      send({ kind: 'failure', press: true, failure: { title: 'item not recognised', detail: 'the clipboard holds no item description', todo: 'hover an item and press again' } })
      return
    }
    const item = result.value
    for (const out of formatItem(item)) log(out)
    parsed++
    await dumpBuffer(text, parsed)
    const sent = statFilters(item)
    const withMods = sent.length
    log(`✓  item parsed${hasAdvancedBlock(text) ? '' : ' (no mod block — normal for currency and maps)'}`)
    log(`   shape: ${withMods ? `with mods (${withMods} in filter)` : 'no mods'}`)
    // The filter ids themselves, not only their count: an empty result with a live trade
    // is read from them at once. On run #104 the request carried an `implicit.…`
    // mod of a unique that the trade does not have under this type.
    if (withMods) log(`   filters: ${sent.map(f => [f.id, ...(f.alt ?? [])].join('|')).join(', ')}`)

    // The waiting frame goes out AT ONCE: the network comes next, and without it the panel is silent
    // for exactly the time in which the user decides the thing is broken.
    const tParse = Date.now()
    send({ kind: 'checking', item })

    try {
      league ??= await currentLeague('pc', settings.league)
      const check = await priceOf(item, { league, mode: priceMode })
      const tPrice = Date.now()
      log(`   ${formatPriceCheck(item, check)}`)
      send({ kind: 'price', item, check })
      pricedBuffer = text
      priced++
      log(`⏱  press -> price: ${tPrice - t0} ms (clipboard ${tClip - t0}, parser ${tParse - tClip}, trade ${tPrice - tParse})`)
      log(`✓  price shown [${withMods ? 'with mods' : 'no mods'}]`)
      await hintScreenshot(withMods ? 'mods' : 'nomods')
    } catch (err) {
      // A trade failure is NOT a daemon failure: the daemon stays alive, and the person
      // learns what happened from the panel, not from the log, which they
      // do not read. A silent overlay looks the same as a broken one.
      const failure = explainFailure(err)
      log(`✗  no price: ${failure.title} — ${failure.detail}`)
      // A league the trade does not know must not live until the session ends: the next
      // press asks for it again, from GGG or from the config.
      if (err instanceof UnknownLeagueError) league = undefined
      send({ kind: 'failure', failure })
      await hintScreenshot('error')
    }
  }
  let presses: Promise<void> = Promise.resolve()

  while (running) {
    // The probe arms for a window and exits: that is how it is written, and there is no reason
    // to rewrite it for the daemon: a restart once an hour is cheaper than editing code checked on
    // hardware. The gap in listening is a fraction of a second between processes.
    const startedAt = Date.now()
    const chords = [keys, toggleKeys, actKeys].filter(Boolean)
    probe = Bun.spawn([probePath, '--seconds', String(window), ...chords.flatMap(chord => ['--keys', chord])], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'inherit'
    })

    let tail = ''
    for await (const chunk of probe.stdout as ReadableStream<Uint8Array>) {
      const lines = (tail + new TextDecoder().decode(chunk)).split('\n')
      tail = lines.pop() ?? ''

      for (const line of lines) {
        const order = argOrderFromLine(line)
        if (order) {
          log(`triggered argument order: ${order}${order === 'unknown'
            ? ' — event time and flags are unreadable; the daemon does not use them anyway'
            : ''}`)
          continue
        }
        // Probe complaints are copied, everything else ("alive" ticks, the arming
        // banner) is not: otherwise the log grows by eight thousand
        // "alive" lines a day. The filter is not cosmetic: among the complaints is "the hotkey
        // manager left the registry", and that is the very event for
        // which the private protocol mitigation was written. Swallowing it
        // silently would mean not noticing that the protocol was taken away.
        if (isProbeComplaint(line)) {
          log(`probe: ${line.trim()}`)
          continue
        }
        if (!isTriggerLine(line)) continue
        // The action chord and the price check chord arrive as one line from one
        // probe: they differ by the chord name in it, not by order.
        // The second gesture: hide the panel or bring back the last result. It never makes
        // a trade request, neither on hide nor on restore.
        if (toggleKeys && line.includes(`[${toggleKeys}]`)) {
          if (!inGame) { log('★  toggle outside the game — skipping'); continue }
          // What exactly the gesture did, not which state the panel is left in:
          // "brought back the price of such an item, N minutes old" is the
          // proof of the cycle for acceptance (run #121 did not leave it).
          const was = overlay
          send({ kind: 'toggle' })
          log(`★  toggle: ${describeToggle(was, overlay, Date.now())}`)
          continue
        }
        if (actKeys && line.includes(`[${actKeys}]`)) {
          if (!inGame) { log('★  act outside the game — skipping'); continue }
          send({ kind: 'act' })
          log(`★  act: ${describeOverlay(overlay)}`)
          continue
        }
        if (!inGame) {
          log('★  press outside the game — skipping (daemon hidden)')
          continue
        }

        // The price check goes to a queue and is not awaited here: while it reads the clipboard
        // (up to three seconds) and goes to the trade, the loop must keep reading probe lines.
        // Otherwise an L4 pressed during a search was handled only after
        // the answer: run #130 had no `hidden during a search`, and three L4 presses during
        // the clipboard wait landed as one batch in one second. The queue is sequential:
        // two price checks in a row still run one after the other.
        const pressLine = line
        presses = presses.then(() => handlePress(pressLine))
          .catch(err => log(`✗  price check broke off: ${String(err)}`))
      }
    }
    await probe.exited
    if (!running) break

    // A probe that dies at once is not "the window expired" but a failure: gamescope
    // went away, the protocol was taken away, the binary broke. Without this branch the daemon
    // would spin on it in a loop silently and look alive.
    if (Date.now() - startedAt < 10_000) {
      restarts++
      if (restarts >= 3) {
        log('✗  the probe died three times in a row — nothing left to retry')
        log('   look at: is gamescope alive (session_env), was the protocol removed by a SteamOS update')
        clearInterval(focusTimer)
        clearInterval(overlayTimer)
        clearInterval(pointerTimer)
        stopPointer()
        panel.close()
        return EXIT_NO_PROTOCOL
      }
      log(`⚠  the probe lived less than 10s (attempt ${restarts}/3) — waiting 5s and restarting`)
      await Bun.sleep(5000)
    } else {
      restarts = 0
      log('probe window expired — re-arming')
    }
  }

  clearInterval(focusTimer)
  clearInterval(overlayTimer)
  clearInterval(pointerTimer)
  stopPointer()
  panel.close()
  log(`daemon stopped, items this session: ${parsed}, prices shown: ${priced}`)
  return 0
}

if (import.meta.main) process.exit(await main())
