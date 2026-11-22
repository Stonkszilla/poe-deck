// `poe-deck doctor` — самопроверка словами.
//
// Игрок без нас не прочитает `journalctl` и не поймёт, какое звено отвалилось.
// doctor проходит цепочку по порядку и на каждое звено печатает одну строку:
// ✓ — работает, ✗ — что сломано и что сделать. Код выхода 0 только при всех ✓.
//
//   конфиг → протокол gamescope → бинари → раскладка Steam Input → сеть → лига
//   → курс Faustus (poe.ninja)
//
// Конфиг идёт первым: лига проверяется по тому, что в нём написано. Звенья не
// обрываются на первом ✗ — игроку нужен весь список, а не первая беда.
//
// Запуск: `poe-deck doctor` у собранного файла (ci/bundle/entry.ts), из
// исходников — `bun src/doctor.ts`. По SSH с mini:
//
//   ssh deck@<Deck> 'bash -c "~/poe-deck/poe-deck doctor"'
//
// Переменные сессии gamescope doctor берёт так же, как демон, — из
// /run/user/<uid>/gamescope-environment, поэтому SSH-сессии они не нужны.

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
  /** Что видно: версия, путь, лига. */
  detail: string
  /** Что сделать. Только у ✗ — у ✓ делать нечего. */
  fix?: string
}

/**
 * Строки вывода одного звена. Подробность бывает многострочной (ошибки конфига —
 * по одной на строку файла); совет — отдельной строкой с отступом: его ищут глазами.
 */
export function formatCheck (check: Check): string[] {
  const pad = ' '.repeat(13)
  const [first, ...rest] = check.detail.split('\n')
  const out = [`${check.ok ? '✓' : '✗'}  ${check.name.padEnd(9)} ${first}`, ...rest.map(line => pad + line)]
  if (check.fix && !check.ok) out.push(`${pad}fix: ${check.fix}`)
  return out
}

/** Пример конфига: в наборе — рядом с poe-deck, в исходниках — в config/. */
function exampleConfig (): string {
  return COMPILED
    ? `${dirname(process.execPath)}/poe-deck.conf.example`
    : new URL('../config/poe-deck.conf.example', import.meta.url).pathname
}

const APPLY_TEMPLATE = 'Game Mode: Path of Exile → gear → Controller Settings → Browse Layouts → Templates → poe-deck → Apply'

/** Аккорды, которые раскладка обязана слать: те же умолчания, что у демона. */
export function wantedChords (env = process.env): Array<{ chord: string, what: string }> {
  return [
    { chord: env.POE_DECK_KEYS ?? 'Control_L+Alt_L+C', what: 'price check' },
    { chord: env.POE_DECK_TOGGLE_KEYS ?? 'Control_L+Shift_L', what: 'hide / bring back' }
  ]
}

// ── звенья ───────────────────────────────────────────────────────────────────

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
  // Подсказка зонда «полный вывод выше» doctor не годится: вывода он не печатает.
  // Код 127 — загрузчик не нашёл библиотеку: причина в звене binaries ниже, а не в протоколе.
  const fix = /returned 127\b/.test(verdict.message)
    ? 'the probe cannot start — see the binaries line below'
    : verdict.kind === 'unclear' && verdict.hint.startsWith('full probe output')
    ? `run ${toolPath('gs-hotkey-probe', process.env.POE_DECK_PROBE)} --dump in Game Mode and attach its output to a bug report`
    : verdict.hint
  return { name: 'protocol', ok: false, detail: verdict.message, fix }
}

/**
 * Что `ldd` не нашёл у бинаря. `null` — `ldd` нет вовсе, проверить нечем.
 * Отказ самого `ldd` («not a dynamic executable» у битого файла или чужой
 * архитектуры) — тоже беда: такой бинарь не запустится, хоть «not found» и нет.
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
  // Собранный демон — такой же ELF: libc ему тоже нужна со стокового rootfs.
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

  // Без ldd «все библиотеки на месте» не доказано: ✓ здесь был бы ложным.
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
    // Кнопку называем: «аккорд привязан» без кнопки не отличал L5 шаблона от L3
    // в забытом файле, который Steam не применяет.
    const on = wanted.map(w => `${w.what} on ${good.buttons[w.chord]!.join('/')}`).join(', ')
    const unused = stale.length ? `; not applied by Steam: ${stale.map(shortPath).join(', ')}` : ''
    return { name: 'layout', ok: true, detail: `${on} (${shortPath(good.path)})${unused}` }
  }
  // Аккаунтов на Deck бывает несколько — говорим про тот, где недостаёт меньше.
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
 * Ответ сети: живой ли хост и что он сказал. Любой HTTP-ответ — сеть есть.
 * Слова свои, а не кадра панели: у кадра совет «нажми снова», а здесь жать нечего.
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
    // Хост ответил — значит Wi-Fi жив; беда на стороне GGG, и совет другой.
    const failure = explainFailure(trade.response.status === 503
      ? new MaintenanceError(503)
      : new TradeHttpError(trade.response.status))
    problems.push(`pathofexile.com — ${failure.title}: ${failure.detail}`)
    fix = failure.todo
  } else {
    // 200 с HTML — портал Wi-Fi или прокси подменили ответ: это сеть, а не баг.
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
    // Приватной лиги в публичном списке нет: её видно только с cookie сессии.
    // Проверяем тем же поиском, что делает прайс-чек, — иначе любая опечатка
    // при заданной переменной прошла бы за приватную лигу.
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

/** Самый широкий поиск: проверяем лигу, а не предмет. */
const PROBE_QUERY = { query: { status: { option: 'any' } }, sort: { price: 'asc' } }

/**
 * Приватная лига: один поиск с cookie сессии. Ответил — лига есть и cookie её
 * видит. Отказ трейда по лиге — опечатка или протухшая cookie, сказать, какое
 * из двух, трейд не даёт. Любая другая беда — звено не проверено, а не ✓.
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
 * Курс Faustus: сводка Currency Exchange с poe.ninja по лиге прайс-чека. Пустая
 * сводка — лига, которой poe.ninja не ведёт (приватная, только что начавшаяся):
 * цена трейда при этом работает, второй строки на панели не будет, и чинить тут
 * нечего — поэтому ✓ со словами, а не ✗.
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

// ── прогон ───────────────────────────────────────────────────────────────────

/** Все звенья по порядку. Печатает по мере проверки: сеть может думать секунды. */
export async function doctor (build: string, print = (line: string) => console.log(line)): Promise<number> {
  const version = (process.env.POE_DECK_GAME ?? 'poe1') as GameVersion
  print(`poe-deck doctor — ${build}, ${version}`)
  // И это словами: игра, которой нет в таблице, или нечитаемый файл сессии не
  // должны превращать doctor в стектрейс.
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
  // Звено, которое само упало, — тоже ✗ словами: doctor не имеет права ответить
  // игроку стектрейсом, даже если сломался он сам.
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
