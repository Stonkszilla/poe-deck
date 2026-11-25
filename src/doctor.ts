// `poe-deck doctor`: a self-check in words.
//
// Without us, the player will not read `journalctl` and will not see which link broke.
// doctor walks the chain in order and prints one line for each link:
// ✓ means it works, ✗ means what is broken and what to do. Exit code 0 only if all are ✓.
//
//   config → gamescope protocol → binaries → Steam Input layout → network → league
//   → Faustus rates (poe.ninja)
//
// The config goes first: the league check uses what the config says. The chain does
// not stop at the first ✗: the player needs the full list, not the first problem.
//
// Run: `poe-deck doctor` for the built file (ci/bundle/entry.ts), from the
// sources: `bun src/doctor.ts`. Over SSH from mini:
//
//   ssh deck@<Deck> 'bash -c "~/poe-deck/poe-deck doctor"'
//
// doctor gets the gamescope session variables the same way as the daemon, from
// /run/user/<uid>/gamescope-environment, so the SSH session does not need them.

import { accessSync, constants, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { configPath, effectiveSettings, loadConfig } from './config'
import { adoptSessionEnv, HOW_TO_GET_TOOLS, missingTools, probeProtocol } from './daemon'
import { gameFeatures, type GameVersion } from './game-features'
import { explainFailure } from './panel'
import { COMPILED, toolPath, toolsDir } from './runtime'
import { checkLayout, layoutChoice, steamDir, templateInstalled } from './steam/layout'
import {
  MaintenanceError,
  pickTradeLeague,
  REQUEST_TIMEOUT_MS,
  search,
  TradeTimeoutError,
  TradeHttpError,
  tradeEndpoint,
  tradeFetch,
  UnknownLeagueError,
  type LeagueEntry
} from './trade/client'
import { exchangeOverview } from './trade/ninja'

export interface Check {
  name: string
  ok: boolean
  /** What is seen: version, path, league. */
  detail: string
  /** What to do. Only for ✗: for ✓ there is nothing to do. */
  fix?: string
}

/**
 * Output lines of one link. The detail can be multi-line (config errors, one per
 * file line); the fix is a separate indented line: the eye looks for it.
 */
export function formatCheck (check: Check): string[] {
  const pad = ' '.repeat(13)
  const [first, ...rest] = check.detail.split('\n')
  const out = [`${check.ok ? '✓' : '✗'}  ${check.name.padEnd(9)} ${first}`, ...rest.map(line => pad + line)]
  if (check.fix && !check.ok) out.push(`${pad}fix: ${check.fix}`)
  return out
}

/** Example config: in the bundle it is next to poe-deck, in the sources it is in config/. */
function exampleConfig (): string {
  return COMPILED
    ? `${dirname(process.execPath)}/poe-deck.conf.example`
    : new URL('../config/poe-deck.conf.example', import.meta.url).pathname
}

const APPLY_TEMPLATE = 'Game Mode: Path of Exile → gear → Controller Settings → Browse Layouts → Templates → poe-deck → Apply'

/** Chords that the layout must send: the same defaults as in the daemon. */
export function wantedChords (env = process.env): Array<{ chord: string, what: string }> {
  return [
    { chord: env.POE_DECK_KEYS ?? 'Control_L+Alt_L+C', what: 'price check' },
    { chord: env.POE_DECK_TOGGLE_KEYS ?? 'Control_L+Shift_L', what: 'hide / bring back' }
  ]
}

// ── links ──────────────────────────────────────────────────────────────────────

function checkConfig (): { check: Check, league?: string } {
  const config = loadConfig()
  const effective = effectiveSettings(config.settings)
  const errors = [...config.errors, ...effective.errors]
  const league = effective.settings.league
  if (errors.length) {
    return {
      league,
      check: {
        name: 'config',
        ok: false,
        detail: [config.path, ...errors].join('\n'),
        fix: 'fix these lines in any text editor in Desktop Mode; an empty file means defaults'
      }
    }
  }
  return {
    league,
    check: {
      name: 'config',
      ok: true,
      detail: config.exists
        ? config.path
        : `none yet, defaults in use; to change the league copy ${exampleConfig()} to ${configPath()}`
    }
  }
}

async function checkProtocol (): Promise<Check> {
  const verdict = await probeProtocol(toolPath('gs-hotkey-probe', process.env.POE_DECK_PROBE), 10_000)
  if (verdict.kind === 'ok') {
    return {
      name: 'protocol',
      ok: true,
      detail: `gamescope_action_binding_manager version ${verdict.version}${verdict.version > 1 ? ' (newer than 1 — the probe binds 1)' : ''}`
    }
  }
  if (verdict.kind === 'no-socket') {
    return {
      name: 'protocol',
      ok: false,
      detail: verdict.message,
      fix: 'run doctor while the Deck is in Game Mode — the daemon only works there'
    }
  }
  // The probe hint "full output above" does not fit doctor: doctor does not print that output.
  // Code 127 means the loader did not find a library: the cause is in the binaries link below, not in the protocol.
  const fix = /returned 127\b/.test(verdict.message)
    ? 'the probe cannot start — see the binaries line below'
    : verdict.kind === 'unclear' && verdict.hint.startsWith('full probe output')
    ? `run ${toolPath('gs-hotkey-probe', process.env.POE_DECK_PROBE)} --dump in Game Mode and attach its output to a bug report`
    : verdict.hint
  return { name: 'protocol', ok: false, detail: verdict.message, fix }
}

/**
 * What `ldd` did not find for a binary. `null` means there is no `ldd`, nothing to check with.
 * A failure of `ldd` itself ("not a dynamic executable" for a broken file or another
 * architecture) is also a problem: such a binary will not start, even without "not found".
 */
function unresolvedLibs (path: string): string[] | null {
  if (!Bun.which('ldd')) return null
  const out = Bun.spawnSync(['ldd', path], { stdout: 'pipe', stderr: 'pipe' })
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr)
  const missing = text.split('\n').filter(line => line.includes('not found')).map(line => line.trim().split(/\s+/)[0]!)
  if (!missing.length && out.exitCode !== 0) return [`(ldd: ${text.trim().split('\n')[0] || `exit ${out.exitCode}`})`]
  return missing
}

const NOT_STOCK = 'this does not look like a stock SteamOS'

export function checkBinaries (): Check {
  const tools: Array<[string, string | undefined]> = [
    ['gs-hotkey-probe', process.env.POE_DECK_PROBE],
    ['gs-panel', process.env.POE_DECK_PANEL],
    ['gs-pointer', process.env.POE_DECK_POINTER],
    ['gs-clip', process.env.POE_DECK_CLIP]
  ]
  const paths = tools.map(([name, override]) => toolPath(name, override))
  // The built daemon is also an ELF: it also needs libc from the stock rootfs.
  if (COMPILED) paths.unshift(process.execPath)

  const problems: string[] = []
  let lddMissing = false
  for (const path of paths) {
    const name = path.split('/').pop()
    try {
      accessSync(path, constants.X_OK)
    } catch {
      problems.push(existsSync(path) ? `${name} is not executable` : `${name} missing`)
      continue
    }
    const libs = unresolvedLibs(path)
    if (libs === null) lddMissing = true
    else if (libs.length) problems.push(`${name} lacks ${libs.join(', ')}`)
  }
  const missing = missingTools(cmd => Bun.which(cmd) !== null, true)
  if (missing.length) problems.push(`system commands missing: ${missing.join(', ')}`)

  // Without ldd, "all libraries present" is not proven: a ✓ here would be false.
  if (lddMissing) problems.push('ldd not found — libraries not checked')

  if (problems.length) {
    return {
      name: 'binaries',
      ok: false,
      detail: problems.join('; '),
      fix: problems.length > 1 ? HOW_TO_GET_TOOLS
        : missing.length ? `${missing.join(' and ')} ship with SteamOS — ${NOT_STOCK}`
        : lddMissing ? `ldd ships with glibc on SteamOS — ${NOT_STOCK}`
        : HOW_TO_GET_TOOLS
    }
  }
  return {
    name: 'binaries',
    ok: true,
    detail: `${paths.length} in ${toolsDir()}, ldd: all libraries found`
  }
}

const shortPath = (path: string): string =>
  path.split('/Steam Controller Configs/')[1] ?? path.split('/controller_base/')[1] ?? path

function checkLayoutLink (appId: number): Check {
  const steam = steamDir()
  const template = templateInstalled(steam)
    ? ''
    : ' (the poe-deck template is not installed either — run the installer again)'
  const { applied: configs, stale } = layoutChoice(appId, steam)
  if (!configs.length) {
    return {
      name: 'layout',
      ok: false,
      detail: `Path of Exile has no Steam Input layout of its own yet${template}`,
      fix: APPLY_TEMPLATE
    }
  }

  const wanted = wantedChords()
  const verdicts = configs.map(path => checkLayout(path, wanted.map(w => w.chord)))
  const good = verdicts.find(verdict => !verdict.missing.length)
  if (good) {
    // We name the button: "chord bound" without a button did not tell L5 of the template
    // from L3 in a forgotten file that Steam does not apply.
    const on = wanted.map(w => `${w.what} on ${good.buttons[w.chord]!.join('/')}`).join(', ')
    const unused = stale.length ? `; not applied by Steam: ${stale.map(shortPath).join(', ')}` : ''
    return { name: 'layout', ok: true, detail: `${on} (${shortPath(good.path)})${unused}` }
  }
  // A Deck can have several accounts: we report the one with the fewest missing chords.
  const best = verdicts.sort((a, b) => a.missing.length - b.missing.length)[0]!
  const what = best.missing.map(chord => `${wanted.find(w => w.chord === chord)?.what} (${chord})`)
  return {
    name: 'layout',
    ok: false,
    detail: `no button sends ${what.join(' or ')}${template}`,
    fix: APPLY_TEMPLATE
  }
}

const CHECK_WIFI = 'check Wi-Fi (Steam button → Settings → Internet), then run doctor again'

/**
 * Network answer: is the host alive and what did it say. Any HTTP answer means the network works.
 * The words are our own, not the panel frame: the frame says "press again", here there is nothing to press.
 */
async function reach (url: string): Promise<{ ok: true, response: Response } | { ok: false, why: string, fix: string }> {
  try {
    return { ok: true, response: await tradeFetch(url) }
  } catch (err) {
    const why = err instanceof TradeTimeoutError
      ? `no answer in ${REQUEST_TIMEOUT_MS / 1000}s`
      : `cannot connect (${err instanceof Error ? err.message : String(err)})`
    return { ok: false, why, fix: CHECK_WIFI }
  }
}

async function checkNetwork (): Promise<{ check: Check, tradeLeagues?: Array<{ id: string, realm?: string }>, leagues?: LeagueEntry[] }> {
  const trade = await reach(`${tradeEndpoint('pc')}/api/trade/data/leagues`)
  const ninja = await reach('https://poe.ninja/')
  const problems: string[] = []
  let fix = ''

  let tradeLeagues: Array<{ id: string, realm?: string }> | undefined
  if (!trade.ok) {
    problems.push(`pathofexile.com — ${trade.why}`)
    fix = trade.fix
  } else if (!trade.response.ok) {
    // The host answered, so Wi-Fi works; the problem is on the GGG side, and the fix is different.
    const failure = explainFailure(trade.response.status === 503
      ? new MaintenanceError(503)
      : new TradeHttpError(trade.response.status))
    problems.push(`pathofexile.com — ${failure.title}: ${failure.detail}`)
    fix = failure.todo
  } else {
    // 200 with HTML means a Wi-Fi portal or a proxy replaced the answer: this is the network, not a bug.
    tradeLeagues = await trade.response.json()
      .then(data => (data as { result?: Array<{ id: string, realm?: string }> }).result)
      .catch(() => undefined)
    if (!tradeLeagues) {
      problems.push('pathofexile.com answered, but not with the trade API — a Wi-Fi login page or a proxy?')
      fix = 'open any web page in Desktop Mode to finish the Wi-Fi login, then run doctor again'
    }
  }
  if (!ninja.ok) {
    problems.push(`poe.ninja — ${ninja.why}`)
    fix ||= ninja.fix
  }

  if (problems.length) {
    return { check: { name: 'network', ok: false, detail: problems.join('\n'), fix: fix || CHECK_WIFI } }
  }
  return { check: { name: 'network', ok: true, detail: 'trade API and poe.ninja reachable' }, tradeLeagues }
}

async function checkLeague (configured: string | undefined, tradeLeagues: Array<{ id: string, realm?: string }> | undefined): Promise<Check & { league?: string }> {
  if (!tradeLeagues) {
    return { name: 'league', ok: false, detail: 'not checked — the trade API is unreachable (see network)', fix: 'fix the network first' }
  }
  const pc = tradeLeagues.filter(entry => (entry.realm ?? 'pc') === 'pc').map(entry => entry.id)

  if (configured) {
    if (pc.includes(configured)) return { name: 'league', ok: true, detail: `${configured} (set by hand)`, league: configured }
    // A private league is not in the public list: only the session cookie shows it.
    // We check with the same search that the price check does; otherwise any typo
    // with the variable set would pass as a private league.
    if (process.env.POE_DECK_POESESSID) {
      const check = await checkPrivateLeague(configured)
      return check.ok ? { ...check, league: configured } : check
    }
    return {
      name: 'league',
      ok: false,
      detail: `"${configured}" is not a trade league — trade knows: ${pc.join(', ')}`,
      fix: process.env.POE_DECK_LEAGUE
        ? 'POE_DECK_LEAGUE is set in the environment and wins over the config — fix or unset it'
        : `fix the league line in ${configPath()}, or empty it for the current league`
    }
  }

  const reached = await reach(`${tradeEndpoint('pc')}/api/leagues?type=main&realm=pc`)
  if (!reached.ok || !reached.response.ok) {
    return { name: 'league', ok: false, detail: 'the league list did not come', fix: reached.ok ? 'try again in a minute' : reached.fix }
  }
  try {
    const league = pickTradeLeague(await reached.response.json() as LeagueEntry[])
    return { name: 'league', ok: true, detail: `${league} (current softcore trade league)`, league }
  } catch (err) {
    return { name: 'league', ok: false, detail: (err as Error).message, fix: `set league in ${configPath()}` }
  }
}

/** The widest search: we check the league, not an item. */
const PROBE_QUERY = { query: { status: { option: 'any' } }, sort: { price: 'asc' } }

/**
 * Private league: one search with the session cookie. An answer means the league exists
 * and the cookie sees it. A trade refusal for the league is a typo or a stale cookie; trade
 * does not tell which of the two. Any other problem means the link is not checked, not ✓.
 */
export async function checkPrivateLeague (league: string): Promise<Check> {
  try {
    await search(PROBE_QUERY, league)
    return { name: 'league', ok: true, detail: `${league} (private — found with POE_DECK_POESESSID)` }
  } catch (err) {
    if (err instanceof UnknownLeagueError) {
      return {
        name: 'league',
        ok: false,
        detail: `"${league}" is not found even with POE_DECK_POESESSID`,
        fix: 'check the league name, or copy a fresh POESESSID cookie from a browser logged in to pathofexile.com'
      }
    }
    const failure = explainFailure(err)
    return {
      name: 'league',
      ok: false,
      detail: `${league} — not checked: ${failure.title}: ${failure.detail}`,
      fix: failure.todo
    }
  }
}

/**
 * Faustus rates: the Currency Exchange overview from poe.ninja for the price check league.
 * An empty overview is a league that poe.ninja does not track (private, just started):
 * the trade price still works, the panel has no second line, and there is nothing
 * to fix, so it is ✓ with words, not ✗.
 */
export async function checkExchangeRates (league: string | undefined): Promise<Check> {
  const name = 'faustus'
  if (!league) {
    return { name, ok: false, detail: 'not checked — no league (see league)', fix: 'fix the league first' }
  }
  try {
    const overview = await exchangeOverview(league, 'Currency')
    const lines = overview.lines?.length ?? 0
    if (!lines) {
      return {
        name,
        ok: true,
        detail: `poe.ninja has no Currency Exchange rates for ${league} — the panel shows the trade price only`
      }
    }
    return { name, ok: true, detail: `Currency Exchange rates from poe.ninja: ${lines} currencies in ${league}` }
  } catch (err) {
    return {
      name,
      ok: false,
      detail: `poe.ninja — ${err instanceof Error ? err.message : String(err)}; the panel shows the trade price only`,
      fix: CHECK_WIFI
    }
  }
}

// ── run ──────────────────────────────────────────────────────────────────────

/** All links in order. Prints as it checks: the network can take seconds. */
export async function doctor (build: string, print = (line: string) => console.log(line)): Promise<number> {
  const version = (process.env.POE_DECK_GAME ?? 'poe1') as GameVersion
  print(`poe-deck doctor — ${build}, ${version}`)
  // This too in words: a game that is not in the table, or an unreadable session file,
  // must not turn doctor into a stack trace.
  let appId: number
  try {
    appId = gameFeatures(version).steamAppId
    adoptSessionEnv()
  } catch (err) {
    print(`✗  ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  const checks: Check[] = []
  const add = (check: Check): void => { checks.push(check); formatCheck(check).forEach(line => print(line)) }
  // A link that crashed itself is also ✗ in words: doctor must not answer
  // the player with a stack trace, even if doctor itself broke.
  const run = async <T extends { check: Check }>(name: string, body: () => T | Promise<T>): Promise<Partial<T>> => {
    try {
      const done = await body()
      add(done.check)
      return done
    } catch (err) {
      add({ name, ok: false, detail: `could not check: ${err instanceof Error ? err.message : String(err)}`, fix: 'this is a poe-deck bug — report it with this output' })
      return {}
    }
  }

  const config = await run('config', checkConfig)
  await run('protocol', async () => ({ check: await checkProtocol() }))
  await run('binaries', () => ({ check: checkBinaries() }))
  await run('layout', () => ({ check: checkLayoutLink(appId) }))
  const network = await run('network', checkNetwork)
  const league = await run('league', async () => {
    const check = await checkLeague(config.league, network.tradeLeagues)
    return { check, league: check.league }
  })
  await run('faustus', async () => ({ check: await checkExchangeRates(league.league) }))

  const failed = checks.filter(check => !check.ok).length
  print(failed ? `✗  ${failed} of ${checks.length} need attention` : `✓  all ${checks.length} checks passed`)
  return failed ? 1 : 0
}

if (import.meta.main) process.exit(await doctor('source'))
