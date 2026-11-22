// Сквозной срез: кнопка Deck → хоткей gamescope → буфер обмена → парсер донора → лог.
//
// Выход из эпика ввода. Оверлея и trade API здесь нет намеренно —
// доказывается путь ввода, а не интерфейс.
//
// Цепочка целиком; каждое звено проверено порознь на живом Deck (стадия 1),
// этот файл их соединяет:
//
//   button_back_left (Steam Input) → Ctrl+Alt+C, ОДИН выход
//     ├─→ игра кладёт advanced item description в CLIPBOARD          (#52)
//     └─→ тот же аккорд слышит gamescope_action_binding              (#56)
//           → читаем CLIPBOARD с сессионного :0 — gamescope мостит
//             селекшены между своими Xwayland-контекстами            (#45)
//           → парсер из пина донора разбирает текст
//
// Хоткей слушает не этот файл, а готовый зонд из docs/spikes/gamescope-hotkey:
// протокол приватный, клиент к нему уже написан на C и проверен на железе.
// Переписывать его на FFI ради среза незачем — читаем его stdout построчно.
//
// Запуск на Deck (ci/Jenkinsfile.deck, MODE=SLICE):
//   DISPLAY=:0 bun src/slice.ts --seconds 90
//
// Переменные окружения:
//   POE_DECK_PROBE    путь к gs-hotkey-probe (умолчание — как у POE_DECK_CLIP)
//   POE_DECK_KEYS     аккорд хоткея (умолчание Control_L+Alt_L+C — Steam Input
//                     шлёт ЛЕВЫЙ Control, сравнение наборов точное)
//   POE_DECK_CLIP     путь к gs-clip (умолчание рядом с собранным демоном или
//                     ~/poe-deck-tools/gs-clip)
//   POE_DECK_TOOLBOX  distrobox с xclip — запасной путь, если gs-clip нет (gs-probe)
//   POE_DECK_DUMP     каталог, куда класть сырые буферы фикстурами (пусто = не класть)
//   DISPLAY           дисплей сессии; буфер читается с него, а не с дисплея игры

import { existsSync } from 'node:fs'
import { loadDonorParser } from './donor'
import { gameFeatures } from './game-features'
import { toolPath } from './runtime'

const TOOLBOX = process.env.POE_DECK_TOOLBOX ?? 'gs-probe'

/** Строка срабатывания зонда хоткея: `  ★ [Control_L+Alt_L+C] #1  seq=…`. */
export function isTriggerLine (line: string): boolean {
  return line.includes('★')
}

/**
 * Advanced item description — то, ради чего читается `Ctrl+Alt+C`, а не `Ctrl+C`:
 * без него предмет приезжает без модов, парсер молча вернёт пустой statsByType,
 * и срез выглядел бы рабочим, не будучи им.
 *
 * Признак блока взят у донора, не выдуман — `advanced-mod-desc.ts:111-113`:
 * `isModInfoLine = line.startsWith('{') && line.endsWith('}')`.
 */
export function hasAdvancedBlock (text: string): boolean {
  return text.split('\n').some(line => {
    const trimmed = line.trim() // заодно режет \r: текст приезжает через Proton
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

/** Что печатается в лог по разобранному предмету. Ради этих строк весь срез. */
export function formatItem (item: LoggedItem): string[] {
  const head = [item.rarity, item.info.name ?? item.info.refName]
    .filter(Boolean)
    .join(' ')
  const lines = [`item: ${head || '(unnamed)'}  ilvl ${item.itemLevel ?? '-'}`]

  if (!item.statsByType.length) {
    // Предмет без модов — нормальное состояние, а не сбой копирования: у валюты,
    // ключей, карт и неопознанных модов не бывает вовсе, и прайс-чек им нужен
    // ровно так же — по имени и базе, а не по модам.
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
 * Чем читать X11 CLIPBOARD. Основной путь — свой `gs-clip` (src/render/gs-clip.c):
 * только libX11, которая есть на стоковом rootfs, без контейнера.
 *
 * `xclip` остался запасным: на стоковой SteamOS его нет и не будет — rootfs
 * read-only, штатное место инструмента — distrobox (то же решение, что в
 * tools/probe-deck-input.sh). Запасной путь нужен разработчику, у которого
 * читалка ещё не собрана, а не игроку.
 */
export function clipboardReader (helperExists: boolean, has: (cmd: string) => boolean): ClipboardReader | null {
  if (helperExists) return 'gs-clip'
  if (has('xclip')) return 'xclip'
  if (has('distrobox')) return 'distrobox'
  return null
}

/**
 * Команда чтения для выбранного пути.
 *
 * `timeout` у xclip не украшение: он висит вечно, если владелец селекшена не
 * отвечает, а первый `distrobox enter` ещё и поднимает контейнер. У `gs-clip`
 * срок свой, внутри, — внешний `timeout` ему не нужен.
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

/** Путь к `gs-clip`: рядом с собранным демоном или в ~/poe-deck-tools. */
export const clipHelperPath = (): string => toolPath('gs-clip', process.env.POE_DECK_CLIP)

/** Каким путём сейчас читается буфер — для строки в журнале на старте. */
export function currentClipboardReader (): ClipboardReader | null {
  return clipboardReader(existsSync(clipHelperPath()), cmd => Bun.which(cmd) !== null)
}

/** Чтение X11 CLIPBOARD. Пустая строка — буфер пуст, нечитаем или читать нечем. */
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
 * Игра кладёт текст в буфер асинхронно, поэтому читать сразу по событию
 * `triggered` нельзя (разведка ввода, § 3.3). Ждём смены — но **не требуем** её.
 *
 * Прогон #63 стоил ровно этой разницы: предмет копировался тот же, что уже
 * лежал в буфере, текст совпал побайтово, и срез шесть раз подряд сообщил
 * «игра предмет не отдала», хотя она его отдавала. Смена буфера — признак
 * свежести, а не признак того, что копирование состоялось.
 *
 * ponytail: свежесть по совпадению текста не определяется в принципе. Если
 * понадобится отличать новую копию от старой — класть перед вооружением свой
 * маркер и мерить смену относительно него; xclip при этом обязан жить, он
 * ВЛАДЕЕТ селекшеном, и на Deck это уже подводило (tools/probe-deck-input.sh,
 * прогон #52). Срезу такая точность не нужна: ему нужен предмет в логе.
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
 * Сырой буфер на диск, если попросили. Фикстуры прайс-чека снимаются с живого
 * Deck и только с него: текст, придуманный за игру, проверяет фантазию автора,
 * а не парсер. Имя — по порядку, содержимое — байт в байт то, что отдала игра.
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

  // Парсер поднимается ДО прослушивания: первый запуск строит бинарные индексы
  // донора, это секунды. Поднимать его по первому нажатию значило бы потерять
  // буфер, пока индексы строятся.
  const parser = await loadDonorParser()
  console.log('donor parser loaded from the pin, waiting for a press')

  const probe = Bun.spawn([probePath, '--seconds', String(seconds), '--keys', keys], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'inherit'
  })

  // Считаются обе величины, и работой среза считается ПЕРВАЯ. Прайс-чек нужен и
  // валюте, и ключу, и карте — у них модов нет и не будет, но цена у них есть.
  // Вторая величина — не критерий, а страховка от Ctrl+C: если за прогон не
  // приехало ни одного предмета с модами, стоит посмотреть на раскладку кнопки.
  let parsed = 0
  let withMods = 0
  let dumped = 0
  let before = await readClipboard(display)
  let tail = ''

  // Что лежит в буфере ДО нажатия — печатается и в зачёт среза не идёт. Смысл
  // не в предмете, а в том, что прогон без человека у Deck всё равно показывает,
  // работают ли на устройстве чтение буфера и парсер: иначе «ноль срабатываний»
  // не отличить от «звено оборвалось раньше».
  console.log(`clipboard before the press: ${before ? `${before.split('\n').length} lines, advanced block ${hasAdvancedBlock(before) ? 'present' : 'absent'}` : 'empty'}`)
  // Он тоже фикстура: предмет, скопированный в прошлом прогоне, — такой же
  // настоящий буфер с Deck, как и снятый жестом сейчас.
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
    // Ноль предметов с модами за прогон — не провал, но и не норма: так выглядит
    // и связка предметов без модов подряд, и обычный Ctrl+C на раскладке кнопки.
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
