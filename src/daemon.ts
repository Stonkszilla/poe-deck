// Демон poe-deck: живёт всю игровую сессию, слушает хоткей, показывает цену.
//
// Цепочка целиком — от кнопки до панели поверх игры:
//
//   button_back_left (Ctrl+Alt+C)
//     ├─→ игра кладёт advanced item description в CLIPBOARD
//     └─→ хоткей gamescope слышит тот же аккорд
//          → читаем CLIPBOARD с сессионного :0        (slice.ts)
//          → парсер из пина донора                    (donor.ts)
//          → запрос цены: моды / имя и база           (price-check.ts)
//          → панель поверх игры                       (panel.ts → src/render)
//
//   левый тачпад (mouse behaviour) → курсор на сервере ИГРЫ
//     └─→ gs-pointer читает его опросом              (src/render/gs-pointer.c)
//          → курсор на панели разворачивает редактор (overlay.ts)
//          → L4 (Ctrl+Shift) переключает и подтверждает
//
// Отличие от `src/slice.ts` — не в функциях, а в жизненном цикле: срез
// доказывал цепочку за 90 секунд и на этом заканчивался, демон переживает вход
// в игру, выход в интерфейс Steam и возврат. Всё, что срез уже доказал на
// железе (чтение буфера, подъём парсера, разбор строк зонда), берётся у него
// импортом, а не переписывается.
//
// Два требования сюда пришли обязательными, а не желательными, и оба — следствие
// замеров, а не предпочтений:
//
//  1. МИТИГАЦИЯ ПРИВАТНОГО ПРОТОКОЛА (ADR 0002, § Цена). `gamescope_action_binding`
//     помечен «Regular Wayland clients must not use it», Valve не обязана его
//     сохранять, и расхождение реализации с собственным XML УЖЕ наблюдалось на
//     железе. Отсюда: проверка глобала и версии ДО работы, распознавание порядка
//     аргументов `triggered` на лету, и деградация внятным сообщением вместо
//     стектрейса, если протокола нет.
//
//  2. АВТОГАШЕНИЕ ПО `GAMESCOPE_FOCUSED_APP` (спайк по оверлею, эксп. 6). Демон
//     не связан с жизненным циклом игры и с ней не исчезает — значит обязан
//     гаснуть сам, иначе повиснет поверх интерфейса Steam.
//
// Порядок аргументов `triggered` распознаёт САМ ЗОНД, на C, и это не лень:
// рецепт (собрать обе раскладки слов и взять ту, чья метка правдоподобна
// относительно CLOCK_MONOTONIC) написан и проверен на живом Deck — там он и
// живёт. Демон читает его вердикт строкой из stdout. Своих выводов из времени
// и флагов события он не делает вовсе, поэтому расхождение версий на него
// не влияет — но вердикт печатается, потому что следующему, кто захочет
// опереться на `trigger_flags`, знать его придётся.
//
// Запуск на Deck — юнит `systemd --user`, ставится `install.sh` из архива релиза;
// рецепт целиком: docs/ops/deck-daemon.md. Руками из SSH работает так же:
//
//   bun src/daemon.ts
//
// Переменные окружения:
//   POE_DECK_PROBE     путь к gs-hotkey-probe. Умолчание у всех C-бинарей одно:
//                      рядом с собранным демоном, у исходников ~/poe-deck-tools
//                      (src/runtime.ts)
//   POE_DECK_PANEL     путь к gs-panel.
//                      Рендерера нет — цена уходит только в журнал, демон живёт
// Лига, рынок и TTL панели игрок задаёт файлом ~/.config/poe-deck/poe-deck.conf
// (src/config.ts); переменные ниже главнее файла — ими живут прогоны.
//
//   POE_DECK_PANEL_TTL сколько секунд держать панель на экране (15). Пока курсор
//                      на панели, срок не идёт: гасить то, что человек правит, нельзя
//   POE_DECK_POINTER   путь к gs-pointer.
//                      Нет — прайс-чек работает как раньше, редактор не открывается
//   POE_DECK_ACT_KEYS  запасной аккорд действия редактора (по умолчанию выключен)
//   POE_DECK_TOGGLE_KEYS аккорд «убрать панель / вернуть результат» (Control_L+Shift_L — L4)
//   POE_DECK_LEAVE_MS  через сколько свернуть редактор, когда курсор ушёл (1200)
//   POE_DECK_PX_PER_STEP пикселей движения пальца на шаг значения в правке (14)
//   POE_DECK_PRICE_MODE рынок цены: securable (умолчание) | available | online | onlineleague | any
//   POE_DECK_KEYS      аккорд хоткея (умолчание Control_L+Alt_L+C — Steam Input
//                      шлёт ЛЕВЫЙ Control, сравнение наборов точное)
//   POE_DECK_GAME      poe1 | poe2, умолчание poe1
//   POE_DECK_WINDOW    на сколько секунд вооружается зонд за один запуск (3600)
//   POE_DECK_CLIP      путь к gs-clip, читалке буфера
//   POE_DECK_TOOLBOX   distrobox с xclip — запасной путь без gs-clip (gs-probe, slice.ts)
//   POE_DECK_LEAGUE    перебить лигу (иначе конфиг, иначе /api/leagues один раз)
//   POE_DECK_POESESSID cookie сессии — только для приватных лиг (docs/recon/poesessid.md)
//   POE_DECK_DUMP      каталог для сырых буферов — фикстуры снимаются только так
//   POE_DECK_QUERY_DUMP каталог для тел уходящих запросов (приёмка: экран vs запрос)
//   POE_DECK_SHOT_HINT файл-подсказка джобу «панель на экране, снимай» (ci/)
//   XDG_STATE_HOME     где метка «кадр ready уже показан» (~/.local/state/poe-deck)
//   DISPLAY, GAMESCOPE_WAYLAND_DISPLAY, XDG_RUNTIME_DIR
//                      если не заданы — берутся из /run/user/<uid>/gamescope-environment

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

/** Код выхода деградации: протокола нет, но это не поломка демона. */
export const EXIT_NO_PROTOCOL = 3

// ── окружение сессии ─────────────────────────────────────────────────────────

/**
 * Разбор `/run/user/<uid>/gamescope-environment`. Файл нужен потому, что юнит
 * `systemd --user` поднимается раньше Game Mode и переменных сессии не видит, а
 * из `/proc/<pid>/environ` самого gamescope их не прочитать: у бинаря стоит
 * файловая capability, процесс non-dumpable (грабля из docs/ops).
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

/** Заполняет недостающие переменные сессии из файла gamescope. Не перетирает заданные. */
export function adoptSessionEnv (): string | null {
  const path = `/run/user/${process.getuid?.() ?? 1000}/gamescope-environment`
  if (!existsSync(path)) return null
  const env = parseSessionEnv(readFileSync(path, 'utf8'))
  for (const [key, value] of Object.entries(env)) {
    if (!process.env[key]) process.env[key] = value
  }
  return path
}

// ── митигация приватного протокола ───────────────────────────────────────────

export type DumpVerdict =
  | { kind: 'ok', version: number }
  | { kind: 'no-probe' | 'no-socket' | 'no-manager' | 'unclear', message: string, hint: string }

/**
 * Разбор `gs-hotkey-probe --dump`: есть ли глобал и какой он версии.
 *
 * Зонд различает исходы сам и печатает их по-русски — здесь только классификация
 * его вывода, чтобы демон мог сказать «протокола нет» отдельно от «это вообще не
 * сессия gamescope». Разные причины — разные действия у того, кто читает лог.
 */
export function parseDumpVerdict (stdout: string, code: number): DumpVerdict {
  const version = stdout.match(/gamescope_action_binding_manager есть, версия (\d+)/)
  if (code === 0 && version) return { kind: 'ok', version: Number(version[1]) }

  // Паттерны ниже сверяются с выводом C-зонда (docs/spikes/gamescope-hotkey),
  // и он пока говорит по-русски: строки переводятся вместе с ним, одним
  // коммитом, иначе демон перестанет узнавать собственный зонд.
  if (stdout.includes('не подключился к сокету')) {
    return {
      kind: 'no-socket',
      message: 'no gamescope socket — this is not a Game Mode session',
      hint: 'the daemon targets Game Mode; there is nothing to do in Desktop Mode. Socket name lives in /run/user/<uid>/gamescope-environment'
    }
  }
  if (stdout.includes('в реестре НЕТ')) {
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
 * Вердикт зонда о порядке аргументов `triggered`. Значение — не косметика:
 * на gamescope ≤3.16.24 (а на Deck стоит 3.16.23.4) флаги и время переставлены
 * относительно XML того же тега, и `trigger_flags` без этой проверки читать
 * нельзя. Демон ни временем, ни флагами не пользуется — но молчать об этом
 * значило бы оставить грабли следующему.
 */
export function argOrderFromLine (line: string): 'xml' | 'swapped' | 'unknown' | null {
  if (!line.includes('порядок аргументов triggered')) return null
  if (line.includes('НЕ РАСПОЗНАН')) return 'unknown'
  return line.includes('≤3.16.24') ? 'swapped' : 'xml'
}

/**
 * Жалоба зонда против его же рутины. Зонд печатает тик «жив» каждые несколько
 * секунд — за сессию это тысячи строк, и пересказывать их в журнал незачем. А вот
 * `✗`/`⚠` пересказать обязательно: там живёт «менеджер хоткеев исчез из реестра»,
 * то есть протокол отобрали прямо во время работы.
 */
export function isProbeComplaint (line: string): boolean {
  const trimmed = line.trim()
  return (trimmed.startsWith('✗') || trimmed.startsWith('⚠')) && !isTriggerLine(trimmed)
}

/**
 * Есть ли протокол и какой версии — `gs-hotkey-probe --dump`. Одна проверка на
 * демон и `poe-deck doctor`: две реализации одного вопроса однажды
 * ответили бы по-разному. Срок — только у doctor: зонд, повисший на сокете, не
 * вешает его. Демон срока не ставит: на старте Game Mode gamescope бывает медленным,
 * и ждать его — правильно.
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
    // Файл есть, но не запускается (права, чужая архитектура): это поломка
    // набора, а не отсутствие протокола, — и словами, а не стектрейсом.
    return { kind: 'unclear', message: `probe did not start: ${(err as Error).message}`, hint: HOW_TO_GET_TOOLS }
  }
}

// ── первый запуск ────────────────────────────────────────────────────────────

/**
 * Метка «кадр ready уже показан». В `$XDG_STATE_HOME`, а не рядом с
 * конфигом: это состояние демона, а не настройка игрока, и удалить его можно,
 * не потеряв лигу. Снесли метку — кадр покажется снова, это и есть способ
 * повторить первый запуск.
 */
export function readyMarkerPath (env = process.env): string {
  return `${env.XDG_STATE_HOME || `${env.HOME}/.local/state`}/poe-deck/ready-shown`
}

/** Ставит метку. Не вышло (нет прав, полный диск) — кадр покажется ещё раз, и только. */
function markReadyShown (path: string): string | null {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${new Date().toISOString()}\n`)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

// ── автогашение ──────────────────────────────────────────────────────────────

/**
 * AppId из `xprop -root GAMESCOPE_FOCUSED_APP`. `null` — игры на экране нет:
 * атом либо пуст (интерфейс Steam), либо отсутствует вовсе.
 */
export function parseFocusedApp (xpropOut: string): number | null {
  const match = xpropOut.match(/=\s*(\d+)/)
  return match ? Number(match[1]) : null
}

async function focusedApp (display: string): Promise<number | null> {
  // try/catch не про отсутствие xprop — его ловит префлайт ниже, — а про то,
  // что этот вызов живёт в setInterval: там любой отказ спавна улетел бы
  // необработанным отказом промиса и убил бы весь демон. Молча вернуть «игры
  // нет» хуже, чем упасть, только если об этом не сказать, — поэтому говорим.
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
 * `DISPLAY` сервера ИГРЫ. Курсор от левого тачпада живёт там, а не на сессионном
 * `:0`, где рисуется панель (ADR 0002, Ф11 и Ф13) — рисуем у себя, координаты
 * берём оттуда. Переменной сессии для этого нет: сервер игры виден только в
 * окружении её собственного процесса.
 */
export function gameDisplayFrom (environ: string): string | null {
  for (const entry of environ.split('\0')) {
    if (entry.startsWith('DISPLAY=')) return entry.slice('DISPLAY='.length) || null
  }
  return null
}

/**
 * Что делать с читалкой курсора, когда известно, на каком сервере она читает
 * (`running`) и где сейчас игра (`found`).
 *
 * Демон стартует со входом в сессию, обычно раньше игры, а игра может
 * перезапуститься на другом сервере. Поэтому сервер ищется не один раз при
 * старте, а снова, пока игра на экране: иначе после перезагрузки Deck
 * редактор не открывался бы до перезапуска демона. Пропавшая игра читалку не
 * гасит — сервер мог лишь не попасться `pgrep`; умершую читалку демон
 * забывает сам, и следующий проход запускает её заново.
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
 * Внешние команды, без которых демон работать не может. Проверяются ДО работы
 * одним списком: `Bun.spawn` на отсутствующий бинарь бросает, и без этой
 * проверки пропавший `xprop` роняет демон стектрейсом — ровно тем, что ADR 0002
 * запрещает (найдено прогоном на mini, где `timeout` из coreutils нет вовсе).
 *
 * Буфер читается своим `gs-clip`; `xclip` на хосте или в distrobox —
 * запасной путь разработчика, поэтому достаточно любого из трёх.
 */
export function missingTools (has: (cmd: string) => boolean, clipHelper = false): string[] {
  const missing = ['timeout', 'xprop'].filter(cmd => !has(cmd))
  if (!clipboardReader(clipHelper, has)) missing.push('gs-clip (or xclip as a fallback)')
  return missing
}

/**
 * Нажатие L5 по буферу, который не сменился, — повтор уже проверенного
 * предмета, если цена получена ровно по этому тексту и результат ещё держится.
 * Иначе это прежний отказ «игра не скопировала»: показать цену чужой вещи
 * хуже, чем честно отказать (#147).
 */
export function isRepeatOfPriced (text: string, pricedBuffer: string | undefined, last: unknown): boolean {
  return Boolean(text) && text === pricedBuffer && Boolean(last)
}

// ── демон ────────────────────────────────────────────────────────────────────

/**
 * Откуда берутся C-бинари — подсказка к любой их нехватке. У собранного демона
 * они едут в том же наборе, у исходников собираются на Deck.
 */
export const HOW_TO_GET_TOOLS = COMPILED
  ? 'it ships next to the poe-deck executable — the install is incomplete, run install.sh from the release archive again'
  : 'build it on the Deck: MODE=SETUP of poe-deck/deck-probe, or tools/dev-workspace.sh'

const now = () => new Date().toTimeString().slice(0, 8)
const log = (line: string) => { console.log(`${now()}  ${line}`) }

// ── панель ───────────────────────────────────────────────────────────────────

/**
 * Слой показа: один долгоживущий `gs-panel` на всю сессию, кадры уезжают ему в
 * stdin. Процесс на каждый предмет не поднимаем — окно X11 и открытие шрифта
 * стоят дороже самого кадра (0.43 мс, ADR 0003 Ф3), а гасится панель пустым
 * кадром, не смертью процесса.
 *
 * **Отсутствие рендерера демон не роняет.** Прайс-чек при этом остаётся —
 * цена уходит в журнал. Это то же правило, что и с приватным протоколом: молчать
 * нельзя, падать не за что.
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

  // --seconds 0: живёт, пока его не убьют. --hz не задаём вовсе — перерисовка
  // идёт по событию (ADR 0003, Решение 3), а частота там измерительный режим.
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
    // Про свою же собственную остановку не жалуемся: `close()` его и убил.
    // Иначе каждый штатный выход демона выглядел бы в журнале как поломка.
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
    // Гасить кадром перед смертью незачем: окно уходит вместе с процессом.
    close: () => { closing = true; alive = false; proc.kill() },
    get live () { return alive }
  }
}

/**
 * Подсказка джобу: панель с ценой на экране, момент для скриншота. Файл, а не
 * свой вызов `xprop`, — снимок уже умеет делать shell джоба (`screenshot()` в
 * ci/Jenkinsfile.deck), и второй реализации того же ему не нужно.
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
  // Действие редактора — клик тачпада (Ф15): он приезжает маской в тех же
  // строках, что координаты. Аккорд остаётся запасным путём на случай, если
  // клик в раскладке снимут; L4 оказался неудобен на живом прогоне #98.
  // Действие редактора — клик тачпада (Ф15). Аккорд остаётся запасным путём и
  // по умолчанию выключен: L4 на живом прогоне #98 оказался неудобен, а сама
  // кнопка нужнее под второй жест (см. `toggleKeys`).
  const actKeys = process.env.POE_DECK_ACT_KEYS ?? ''
  // Второй жест эпика: убрать панель / вернуть последний результат без запроса
  // к трейду. Живёт на L4 — единственной свободной задней кнопке.
  const toggleKeys = process.env.POE_DECK_TOGGLE_KEYS ?? 'Control_L+Shift_L'
  const pointerPath = toolPath('gs-pointer', process.env.POE_DECK_POINTER)
  const window = Number(process.env.POE_DECK_WINDOW) || 3600
  // Конфиг игрока, поверх него — переменные прогона (src/config.ts). Битый
  // файл демон не роняет: ошибки уходят в журнал, а в силе остаётся всё, что
  // разобралось. Под `Restart=always` выход по опечатке в конфиге был бы
  // бесконечным перезапуском без цены.
  const config = loadConfig()
  const effective = effectiveSettings(config.settings)
  const settings = effective.settings
  const panelTtl = (settings.panelTtl ?? 15) * 1000
  // Сколько ждать, прежде чем свернуть редактор обратно в цену: у относительного
  // указателя (Ф14) край панели задевается любым лишним движением пальца.
  const leaveMs = Number(process.env.POE_DECK_LEAVE_MS ?? 1200)
  // Сколько пикселей движения пальца на шаг значения в режиме правки границы.
  const pxPerStep = Number(process.env.POE_DECK_PX_PER_STEP ?? 14)
  // Рынок, с которого берётся цена. Умолчание — инстант-баяут: он не требует
  // продавца онлайн и потому отвечает ценой, которую можно получить сейчас.
  const priceMode: SearchMode = settings.priceMode ?? DEFAULT_SEARCH_MODE

  const envFile = adoptSessionEnv()
  const display = process.env.DISPLAY ?? ':0'
  log(`poe-deck daemon: ${version}, app ${features.steamAppId}, chord ${keys} (${features.copyItemChord} from a Steam Input button)`)
  log(`hide/restore gesture: ${toggleKeys} (no trade request either way)`)
  log(`config: ${config.exists ? config.path : `${config.path} not found — defaults`}`)
  for (const error of [...config.errors, ...effective.errors]) log(`✗  config: ${error} — ignored, run poe-deck doctor`)
  log(`price mode: ${MODE_LABEL[priceMode]} (${priceMode}); change with price_mode in the config or in the editor`)
  log(`session environment: ${envFile ?? 'no gamescope file, using what is set'}; DISPLAY=${display}`)

  // ── проверка окружения и протокола ДО всего остального ────────────────────
  const missing = missingTools(cmd => Bun.which(cmd) !== null, existsSync(clipHelperPath()))
  if (missing.length) {
    log(`✗  missing external commands: ${missing.join(', ')}`)
    log('   without xprop the GAMESCOPE_FOCUSED_APP auto-hide does not work, and it is mandatory')
    log('   (overlay spike, exp. 6): otherwise the daemon hangs over the Steam UI')
    if (missing.some(tool => tool.startsWith('gs-clip'))) log(`   gs-clip: ${HOW_TO_GET_TOOLS}`)
    return EXIT_NO_PROTOCOL
  }
  // Путь чтения буфера — в журнал сразу: запасной xclip на Deck игрока значит,
  // что набор распакован не целиком, и искать это по пропавшей цене незачем.
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

  // Парсер поднимается ДО прослушивания: первый запуск строит бинарные индексы
  // донора, это секунды. По первому нажатию было бы поздно — буфер уедет.
  const parser = await loadDonorParser(version)
  log('✓  donor parser loaded from the pin')

  const panel = openPanel(panelPath)
  if (panel.live) log('✓  renderer up, panel clears with an empty frame')

  // Лига спрашивается ОДИН раз на сессию, а не на каждое нажатие: `/api/leagues`
  // — такой же запрос к GGG, как и сам поиск, и тратить его по кнопке незачем.
  // Отказ здесь демон не роняет: лига переспросится по первому предмету.
  let league: string | undefined
  try {
    league = await currentLeague('pc', settings.league)
    log(`✓  league: ${league}`)
  } catch (err) {
    const { title, detail } = explainFailure(err)
    log(`⚠  could not resolve the league (${title}: ${detail}) — will ask again on the first item`)
  }

  // ── автогашение ───────────────────────────────────────────────────────────
  // Опрашивать, а не подписываться: `xprop -spy` держал бы ещё один долгий
  // процесс ради состояния, которое меняется раз в минуту. Секунда опоздания
  // ничего не стоит — предмет прайс-чекают в игре, а не в QAM.
  let inGame = await focusedApp(display) === features.steamAppId
  log(inGame ? '▶  game focused — handling presses' : '⏸  game is not on screen — hiding, still listening for the hotkey')

  // Кадр «ready» — один раз на устройство, при первом попадании в игру после
  // установки. Только поверх игры и только живым рендерером: кадр,
  // ушедший в никуда, метку ставить не вправе, иначе игрок его так и не увидит.
  const readyMarker = readyMarkerPath()
  let readyPending = panel.live && !existsSync(readyMarker)
  const showReady = (): void => {
    if (!readyPending || !inGame || !panel.live) return
    send({ kind: 'notice', frame: readyFrame() })
    // Панель занята ценой — игрок уже жмёт кнопку; кадр подождёт следующего входа в игру.
    if (overlay.mode !== 'notice') return
    readyPending = false
    const failed = markReadyShown(readyMarker)
    log(failed
      ? `⚠  ready frame shown, but the marker was not written (${failed}) — it will show again next start`
      : `★  first start: ready frame shown once, marker ${readyMarker}`)
    hintScreenshot('ready').catch(err => log(`⚠  screenshot hint not written: ${String(err)}`))
  }

  // ── жизнь всю сессию ──────────────────────────────────────────────────────
  let running = true
  let parsed = 0
  let priced = 0
  let before = await readClipboard(display)
  let restarts = 0
  let probe: ReturnType<typeof Bun.spawn> | null = null

  // Что на панели и когда её гасить — одно состояние (src/overlay.ts), а не
  // россыпь таймеров по демону. Здесь остаётся только доставка: событие внутрь,
  // кадр наружу, подтверждённый поиск — в сеть.
  let overlay: Overlay = newOverlay(priceMode)
  let searching = false
  let lastSearch = { stats: '', at: 0 }
  // Буфер, из которого получен `overlay.last`. Повторный L5 по нему же — не
  // «игра не скопировала», а «покажи ещё раз».
  let pricedBuffer: string | undefined

  const send = (event: OverlayEvent): void => {
    const was = overlay.mode
    const done = overlayStep(overlay, event, Date.now(), { ttlMs: panelTtl, leaveMs, pxPerStep })
    overlay = done.overlay
    if (done.frame) panel.show(done.frame)
    // Гашение по сроку — не то же самое, что «игрок убрал»: результат остаётся
    // возвращаемым, и приёмке нужно видеть, что срок действительно срабатывал
    // (прогон #125 таких строк не имел вовсе).
    if (event.kind === 'tick' && was !== 'idle' && overlay.mode === 'idle') {
      log(`⏸  panel cleared by ttl (${panelTtl / 1000}s) — L4 still brings the result back`)
    }
    if (done.search) void runSearch(done.search)
  }

  /**
   * Повторный поиск по подтверждённым фильтрам. Одна операция за раз: серия
   * нажатий не имеет права выстроить очередь запросов к GGG (требование эпика).
   */
  const runSearch = async (confirmed: EditorSearch): Promise<void> => {
    const item = overlay.item
    const { stats, mode } = confirmed
    if (!item) return
    if (searching) { log('⚠  a search is already running — skipping this confirm'); return }

    // Тот же набор подряд — не повод идти к GGG снова: на прогоне #101 десяток
    // кликов по «подтвердить» дал десяток одинаковых запросов. Через паузу
    // повтор разрешён: перепроверить цену тем же набором — законное желание.
    // Режим входит в подпись: сменить рынок и переспросить — другой вопрос.
    const signature = JSON.stringify(confirmed)
    if (signature === lastSearch.stats && Date.now() - lastSearch.at < 3000) {
      log('⚠  the same filter set was just searched — skipping the repeat')
      // Клик уже перевёл панель в «checking…», а ответа на отброшенный повтор не
      // будет — панель висела бы в ожидании до следующей задней кнопки (прогон
      // #133, 18:58:39). Ответ на тот же вопрос уже есть: его и показываем.
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
      // Поиск без `stats` — отмена вернула автонабор: в журнале это видно
      // словом, а не пустым списком фильтров.
      const label = stats ? `filters ${stats.length}` : 'auto set (cancel)'
      // Какие именно id уехали — без этого пустая выдача неразличима: набор
      // игрока слишком узкий или мод ищется не тем id. На прогоне #107 второе
      // было видно только по фильтрам автоматического набора.
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

  // Часы панели: гашение по сроку и сворачивание редактора, когда палец ушёл.
  const overlayTimer = setInterval(() => send({ kind: 'tick' }), 200)

  // Таймер фокуса заводится только здесь, когда `send` и `overlay` уже есть:
  // раньше, до первого чтения буфера (до 30 с через distrobox), вход в игру
  // звал `send` до его объявления — ReferenceError и падение демона.
  const focusTimer = setInterval(() => {
    void focusedApp(display).then(app => {
      const next = app === features.steamAppId
      if (next === inGame) return
      inGame = next
      // Панель не имеет права висеть поверх интерфейса Steam: сворачиваем всё,
      // включая открытый редактор (спайк по оверлею, эксп. 6).
      if (!inGame) send({ kind: 'focus', inGame: false })
      showReady()
      log(inGame
        ? '▶  game is focused again — handling presses'
        : `⏸  focus left the game (${app ?? 'empty'}) — hiding, still listening for the hotkey`)
    })
  }, 2000)
  showReady()

  // ── курсор ────────────────────────────────────────────────────────────────
  //
  // Левый тачпад двигает указатель на сервере ИГРЫ (ADR 0002, Ф13 и Ф14), и
  // читается он опросом — ни фокуса, ни событий в слой оверлея не нужно.
  // Отсутствие читалки демон не роняет: прайс-чек работает как раньше, просто
  // редактор не разворачивается.
  let pointer: ReturnType<typeof Bun.spawn> | null = null
  // Сервер, на котором читает текущая читалка. `null` — читалки нет.
  let pointerDisp: string | null = null
  let pointerBusy = false
  let warnedNoGame = false

  const readPointer = (proc: ReturnType<typeof Bun.spawn>, disp: string): void => {
    void (async () => {
      let tail = ''
      // Нажатие берётся из той же строки, что координаты: клик тачпада забинден
      // на левую кнопку мыши, и она приезжает маской XQueryPointer (Ф15).
      // Действие — на ФРОНТЕ нажатия: удержание не должно молотить его подряд.
      let held = false
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        const lines = (tail + new TextDecoder().decode(chunk)).split('\n')
        tail = lines.pop() ?? ''
        for (const line of lines) {
          const at = parsePointerLine(line)
          if (!at) continue
          // Курсор трогает панель только в игре: жест в интерфейсе Steam не
          // должен править черновик, которого не видно.
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
        // Читалка ушла вместе с сервером игры (выход из PoE, перезапуск):
        // забываем её, и следующий проход по фокусу найдёт игру заново.
        if (pointer !== proc) return
        pointer = null
        pointerDisp = null
        if (running) log(`⚠  cursor reader on ${disp} stopped — looking for the game again`)
      })
  }

  /** Найти сервер игры и держать читалку курсора на нём. */
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

  /** Погасить читалку курсора. Через функцию: присваивания `pointer` живут в замыканиях. */
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
  // Пока игра на экране, сервер её ищется снова: демон стартует раньше игры, а
  // игра может перезапуститься на другом сервере (см. `pointerAction`).
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

  /** Одно нажатие кнопки прайс-чека: буфер → парсер → трейд → панель. */
  const handlePress = async (line: string): Promise<void> => {
    log(line.trim())
    // Отсчёт времени отклика начинается ЗДЕСЬ, на строке зонда: раньше в
    // распоряжении демона ничего нет, а зонд печатает её сразу по событию.
    const t0 = Date.now()
    const { text, fresh } = await clipboardAfterTrigger(before, () => readClipboard(display))
    if (!text) {
      log('✗  clipboard empty — nothing to read')
      send({ kind: 'failure', press: true, failure: { title: 'clipboard empty', detail: 'the game copied nothing', todo: 'hover an item and press again' } })
      return
    }
    // Буфер не сменился — значит, клиент игры предмет не отдал, а в буфере лежит
    // прошлый. Разбирать его значит показать цену чужой вещи: на #147 семь
    // нажатий из 13 так отдали Orb of Alchemy вместо наведённого предмета.
    // Повтор на том же предмете попадает сюда же — текст совпадает побайтово,
    // отличить его нечем; тестер выбрал честный отказ (10.11).
    //
    // Исключение — буфер, по которому цена уже получена (rc6, замечание 15):
    // L5 → L4 → L5 по тому же предмету молчал вовсе — отказ глушила убранная
    // панель. Тогда показываем прежний результат так, как его вернул бы L4:
    // без запроса, с именем предмета и возрастом цены. Если игра на самом деле
    // не скопировала другую вещь, игрок видит на панели прежнее имя и
    // «N min ago», а не свежую цену под чужим предметом, как на #147.
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

    // Фокус перечитывается ПОСЛЕ ожидания буфера, а не только до нажатия:
    // между ними проходит до трёх секунд, и за это время игрок успевает уйти
    // в интерфейс Steam. Проверка «на входе» пропустила бы такой предмет к
    // показу — сейчас это лишняя строчка в журнале, а с оверлеем это ровно
    // то, что демон обязан не делать: рисовать поверх интерфейса Steam.
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
    // Сами id фильтров, а не только их число: пустая выдача при живом трейде
    // читается по ним сразу — на прогоне #104 в запрос уходил `implicit.…`
    // мод уникала, которого на трейде под этим типом нет.
    if (withMods) log(`   filters: ${sent.map(f => [f.id, ...(f.alt ?? [])].join('|')).join(', ')}`)

    // Кадр ожидания уходит СРАЗУ: дальше идёт сеть, и без него панель молчит
    // ровно то время, за которое пользователь решает, что вещь сломана.
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
      // Отказ трейда — это НЕ отказ демона: он остаётся жить, а человек
      // узнаёт, что случилось, с панели, а не из журнала, которого он
      // не читает. Молчащий оверлей неотличим от сломанного.
      const failure = explainFailure(err)
      log(`✗  no price: ${failure.title} — ${failure.detail}`)
      // Лига, которой трейд не знает, не должна жить до конца сессии: следующее
      // нажатие спросит её заново — у GGG или у конфига.
      if (err instanceof UnknownLeagueError) league = undefined
      send({ kind: 'failure', failure })
      await hintScreenshot('error')
    }
  }
  let presses: Promise<void> = Promise.resolve()

  while (running) {
    // Зонд вооружается на окно и выходит — так он написан, и переписывать его
    // ради демона незачем: перезапуск раз в час дешевле правки проверенного на
    // железе кода. Дыра в прослушивании — доли секунды между процессами.
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
        // Жалобы зонда пересказываются, а всё остальное (тики «жив», баннер
        // вооружения) — нет: иначе журнал за сутки распухнет на восемь тысяч
        // строк «жив». Отбор не косметический — среди жалоб есть «менеджер
        // хоткеев исчез из реестра», а это и есть то самое событие, ради
        // которого писалась митигация приватного протокола. Проглотить его
        // молча значило бы не заметить, что протокол отобрали.
        if (isProbeComplaint(line)) {
          log(`probe: ${line.trim()}`)
          continue
        }
        if (!isTriggerLine(line)) continue
        // Аккорд действия и аккорд прайс-чека приезжают одной строкой от одного
        // зонда — различаются по имени аккорда в ней, а не по порядку.
        // Второй жест: убрать панель или вернуть последний результат. Запроса
        // к трейду он не делает никогда — ни при скрытии, ни при возврате.
        if (toggleKeys && line.includes(`[${toggleKeys}]`)) {
          if (!inGame) { log('★  toggle outside the game — skipping'); continue }
          // Что именно сделал жест, а не в каком состоянии панель осталась:
          // «вернули цену такого-то предмета возрастом N минут» — это и есть
          // доказательство цикла для приёмки (прогон #121 его не оставлял).
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

        // Прайс-чек уходит в очередь, а не ждётся здесь: пока он читает буфер
        // (до трёх секунд) и ходит в трейд, цикл обязан читать строки зонда
        // дальше. Иначе L4, нажатая во время поиска, обрабатывалась только после
        // ответа — прогон #130: ни одного `hidden during a search`, а три L4 за
        // ожидание буфера легли пачкой в одну секунду. Очередь последовательная:
        // два прайс-чека подряд по-прежнему идут один за другим.
        const pressLine = line
        presses = presses.then(() => handlePress(pressLine))
          .catch(err => log(`✗  price check broke off: ${String(err)}`))
      }
    }
    await probe.exited
    if (!running) break

    // Зонд, умирающий сразу, — это не «окно кончилось», а поломка: gamescope
    // ушёл, протокол отобрали, бинарь испортился. Без этой развилки демон
    // крутил бы её в цикле молча и выглядел бы живым.
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
