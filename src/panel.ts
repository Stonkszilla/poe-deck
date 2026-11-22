// Что показывает панель — в командах шва ADR 0003 (`rect`, `text`, `show`).
//
// Стык между прайс-чеком и рендерером. Ни X11, ни сети, ни парсера
// здесь нет: на входе — что случилось, на выходе — строки для stdin gs-panel.
// Поэтому вёрстка проверяется без Deck и без игры, обычным `bun test`.
//
// ГЛАВНОЕ ТРЕБОВАНИЕ ЭТОГО ФАЙЛА — не красота, а то, что **молчащая панель
// неотличима от сломанной**. Нет сети, лимит API, предмет не опознан, цены на
// трейде нет вовсе — у каждого исхода свой кадр со словами. Кадр «ничего не
// показываем» бывает ровно один: `clearFrame`, и он означает «показывать сейчас
// нечего», а не «что-то пошло не так».
//
// Ограничения шва, которые видно прямо в коде:
//
//  - **Координаты абсолютные**, «окна» у оверлея нет (ADR 0003, Решение 2).
//  - **Ширину строки знает только рендерер.** Обратного канала нет, поэтому
//    перенос либо считает он сам (`WRAP`), либо строка режется здесь на глаз.
//  - **Только покрытие Noto Sans** (ADR 0003, Ф4): подмены шрифта у Xft нет,
//    отсутствующий глиф уезжает на экран пустым квадратом. Отсюда `~` вместо
//    `≈` и `...` вместо `…` — рендерер о таких символах кричит в stderr, но
//    кричит уже на живом Deck, а не здесь.

import {
  BlockedHostError,
  MaintenanceError,
  RateLimitError,
  REQUEST_TIMEOUT_MS,
  TradeHttpError,
  TradeTimeoutError,
  UnknownLeagueError
} from './trade/client'
import { draftProblem, isDirty, slotAt, slots, type Editor, type Slot } from './editor'
import {
  NARROW_SAMPLE,
  priceAmountText,
  priceSpreadText,
  priceScopeText,
  priceValueText,
  rateText,
  stackPrice,
  type Price,
  type Rate
} from './trade/price'
import type { ExchangeReference } from './trade/ninja'
import { scopeNote } from './price-check'
import { groupLabel, rollText, type ModFilter } from './trade/filters'
import { MODE_LABEL, type PricedItem } from './trade/query'
import type { PriceCheck } from './price-check'

// ── геометрия и палитра ──────────────────────────────────────────────────────
//
// Место слева выбрано не по вкусу: инвентарь и подсказка предмета в PoE живут
// справа, и панель обязана не закрывать то, что прайс-чекают. Прогон #69
// показал, что на экране стеша это тоже верно не всегда — окончательное место
// выбирается на живом Deck, и правится оно здесь, а не в рендерере.

/** Место и ширина панели. Меняется здесь, не в рендерере (ADR 0003, Решение 2). */
export interface Box { x: number, y: number, w: number }

// Ширина выбрана по строке мода, а не по вкусу: «+29% to Lightning Resistance»
// с границами не влезал в 460 px и уезжал в «...» (прогон #101). Экран 1280,
// панель слева — места хватает, а обрезанный мод нельзя ни прочитать, ни выбрать.
const BOX: Box = { x: 40, y: 90, w: 640 }
const PAD = 20
// Просвет между строками. Был 10 — и список Ambu's Charge (свойство, шесть
// модов, три заголовка групп, два переноса) переставал влезать в экран: моды
// выпадали в «ниже ещё N» прямо во время правки, что на Deck читается как
// «моды пропали» (жалоба тестера по прогону #109). 6 px возвращают четыре строки
// и заодно делают панель плотнее.
const GAP = 6
/** Высота вывода Deck. Окно оверлея всегда на весь экран (ADR 0003, Ф2). */
const SCREEN_H = 800

const BG = '0F1216E6'
const ACCENT = 'C8AA6EFF'
const MUTED = '8A8478FF'
const VALUE = 'FFFFFFFF'
const NOTE = '6FA8DCFF'
const WARN = 'E0A030FF'
const ERROR = 'E5786DFF'
const RULE = '3A3F46FF'

/**
 * Строка кадра: либо текст, либо разделитель. У текста есть метка курсора —
 * полоска слева. Она рисуется `rect`, а не символом: выбранная строка на 7"
 * экране должна быть видна раньше, чем прочитана, а лишний глиф в начале строки
 * съедает ширину и сдвигает текст относительно соседей (`fit` режет пробелы).
 */
type Row =
  | { kind: 'text', text: string, px: number, color: string, marked?: boolean, cells?: string[], stops?: number[] }
  | { kind: 'rule' }

const text = (text: string, px: number, color: string, marked = false): Row =>
  ({ kind: 'text', text, px, color, marked })
/**
 * Строка из колонок равной ширины: каждая надпись стоит в начале своей колонки.
 * Нужна там, где у строки несколько зон наведения: надпись обязана лежать над
 * своей зоной. `confirm · cancel` одной надписью занимал левую треть панели, а
 * зона `cancel` — правую половину, и наведение на слово `cancel` подсвечивало
 * `confirm` (прогон #133).
 */
const columns = (cells: string[], px: number, color: string, marked = false, stops?: number[]): Row =>
  ({ kind: 'text', text: cells.join(' '), px, color, marked, cells, stops })
const rule = (): Row => ({ kind: 'rule' })

/**
 * Левые края колонок долями ширины строки. Без `stops` колонки равные. Одна
 * формула и для надписи, и для зоны: стоит им посчитаться врозь, и палец
 * наводится не на то, что видит (прогоны #133 и #150).
 */
const edges = (parts: number, stops?: number[]): number[] =>
  stops ?? Array.from({ length: parts }, (_, part) => part / parts)

/** Левый край и ширина колонки `part`. */
const columnSpan = (box: Box, part: number, parts: number, stops?: number[]): { x: number, w: number } => {
  const inner = box.w - PAD * 2
  const at = edges(parts, stops)
  const from = Math.round(inner * at[part]!)
  const to = Math.round(inner * (at[part + 1] ?? 1))
  return { x: box.x + PAD + from, w: to - from }
}

/**
 * Высота строки под кегль. Замер ADR 0003: Noto Sans даёт 31 px при кегле 22,
 * то есть ~1.41 — берём с небольшим запасом, чтобы соседние строки не слипались.
 */
const lineHeight = (px: number): number => Math.round(px * 1.45)

/**
 * Обрезка по прикидке ширины символа.
 *
 * ponytail: настоящую ширину знает только тот, у кого открыт шрифт, а шов
 * однонаправленный (ADR 0003, Решение 2) — метрики оттуда не спросить. Отсюда
 * коэффициент 0.52 средней ширины Noto Sans, снятый с эталонного кадра. Потолок
 * очевиден: строка из одних `W` вылезет, из одних `i` — обрежется рано. Если
 * это начнёт мешать, следующая ступень — не подбор коэффициента, а команда
 * `text` с `WRAP` и расчёт высоты панели рендерером, то есть двусторонний шов.
 */
export function fit (line: string, px: number, width = BOX.w - PAD * 2): string {
  const max = Math.max(4, Math.floor(width / (px * 0.52)))
  const flat = line.replace(/\s+/g, ' ').trim() // перевод строки разорвал бы команду шва
  return flat.length <= max ? flat : `${flat.slice(0, max - 3).trimEnd()}...`
}

/** Сколько символов кегля `px` влезает в строку панели шириной `w`. */
function charBudget (px: number, w: number): number {
  return Math.max(4, Math.floor((w - PAD * 2) / (px * 0.52)))
}

/** Высота содержимого без внешних отступов — по ней растёт подложка. */
function heightOf (rows: Row[]): number {
  return rows.reduce(
    (sum, row) => sum + (row.kind === 'rule' ? GAP * 2 + 1 : lineHeight(row.px) + GAP),
    0
  )
}

/**
 * Строки → кадр: подложка по высоте содержимого, акцентная полоса, текст, `show`.
 *
 * Метки курсора уходят в кадр ДО текста и вместе с подложкой. Порядок не
 * косметический: проверка `experiments/deck-ux/check-linux.sh` считает границей
 * вертикального слота строки следующий за ней `rect`, и метка, вставленная между
 * строками, объявила бы слот нулевой высоты.
 */
export function frame (rows: Row[], box: Box = BOX): string[] {
  return laidOutFrame(rows, box).lines
}

/** Где на экране лежит строка кадра. Нужно тому, кто наводит на неё курсор. */
export interface RowSpan { y: number, height: number }

/**
 * Кадр вместе с координатами своих строк.
 *
 * Отдельная функция, а не второй расчёт геометрии рядом: попадание курсора в
 * строку обязано считаться по тем же числам, по которым строка нарисована.
 * Две формулы одного и того же разъезжаются молча — на экране это выглядит как
 * «палец наводит на соседнюю строку».
 */
export function laidOutFrame (
  rows: Row[],
  box: Box = BOX
): { lines: string[], spans: RowSpan[], height: number } {
  const height = PAD * 2 + Math.max(0, heightOf(rows) - GAP)

  const head = [
    `rect ${box.x} ${box.y} ${box.w} ${height} ${BG}`,
    `rect ${box.x} ${box.y} ${box.w} 4 ${ACCENT}`
  ]
  const out: string[] = []
  const spans: RowSpan[] = []

  let y = box.y + PAD
  for (const row of rows) {
    if (row.kind === 'rule') {
      y += GAP
      out.push(`rect ${box.x + PAD} ${y} ${box.w - PAD * 2} 1 ${RULE}`)
      y += GAP + 1
      continue
    }
    if (row.marked) head.push(`rect ${box.x + 8} ${y} 4 ${lineHeight(row.px)} ${ACCENT}`)
    // WRAP=0: переносов нет намеренно — иначе высота подложки перестала бы
    // считаться здесь, а посчитать её больше некому.
    const cells = row.cells ?? [row.text]
    cells.forEach((cell, part) => {
      const { x, w } = columnSpan(box, part, cells.length, row.stops)
      out.push(`text ${x} ${y} 0 ${row.color} ${row.px} ${fit(cell, row.px, w)}`)
    })
    // Зона строки на полшага шире самой строки: промежуток между строками
    // отдаётся ближайшей, иначе курсор проваливается «между» и выбор мигает.
    spans.push({ y: y - GAP / 2, height: lineHeight(row.px) + GAP })
    y += lineHeight(row.px) + GAP
  }

  return { lines: [...head, ...out, 'show'], spans, height }
}

/** Пустой кадр: панели на экране нет. Единственный законный способ промолчать. */
export function clearFrame (): string[] {
  return ['show']
}

// ── что именно показываем ────────────────────────────────────────────────────

/** Имя предмета для заголовка. Уникалу нужны оба имени, остальным хватает базы. */
export function itemTitle (item: PricedItem): string {
  return item.info.name ?? item.info.refName
}

function itemSubtitle (item: PricedItem): string {
  const parts: string[] = []
  if (item.info.name && item.info.name !== item.info.refName) parts.push(item.info.refName)
  if (item.rarity) parts.push(item.rarity)
  // Тир у карты — то, по чему она ищется (`map_tier`), и игрок должен видеть его
  // на панели: без него цена T14 и T16 выглядит одной ценой (тестер).
  if (item.mapTier != null) parts.push(`T${item.mapTier}`)
  if (item.itemLevel) parts.push(`ilvl ${item.itemLevel}`)
  if (item.isCorrupted) parts.push('corrupted')
  if (item.isUnidentified) parts.push('unidentified')
  return parts.join(' · ')
}

/**
 * Кадр ожидания. Между нажатием и ценой проходит секунда-другая: сначала игра
 * дописывает буфер, потом отвечает трейд. Без этого кадра всё это время панель
 * пуста, и вещь выглядит сломанной ровно тогда, когда она работает.
 */
export function checkingFrame (item: PricedItem): string[] {
  return frame([
    text(itemTitle(item), 24, ACCENT),
    text(itemSubtitle(item) || 'item parsed', 18, MUTED),
    rule(),
    text('checking price...', 28, VALUE)
  ])
}

/**
 * Сколько времени прошло, человеческими словами. Нужно ровно одному кадру —
 * возвращённому результату: «5 chaos» без возраста это обещание, а не замер.
 */
export function agoText (ms: number): string {
  if (ms < 60_000) return 'just now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return `${hours} h ago`
}

/**
 * Кадр «показывать нечего». Жест возврата нажат, а результата за сессию ещё не
 * было: показать чужую или выдуманную цену нельзя, промолчать — тоже (иначе
 * жест неотличим от сломанного: на приёмке демо восемь нажатий L4 подряд
 * ничего не дали, и кнопку сочли сломанной). Кнопка — та же `PRICE_BUTTON`,
 * что в кадре ready, чтобы подсказка не разошлась с раскладкой.
 */
export function noResultFrame (): string[] {
  return frame([
    text(`nothing to hide — press ${PRICE_BUTTON} on an item`, 22, VALUE)
  ])
}

/**
 * Какая цена на панели главная, крупным числом. Одно место на весь проект.
 *
 * `trade` — лучший курс instant buyout трейда: его можно исполнить с рук сейчас.
 * `faustus` — курс внутриигрового Currency Exchange по poe.ninja: трейд его не
 * видит, и у дешёвой валюты он расходится с трейдом в разы (Orb of Scouring в
 * Covens: стак 30 — 10 chaos на трейде против ~23 у Faustus). Вторая цена в
 * обоих случаях остаётся на панели строкой ниже. Курса Faustus нет — главной
 * становится цена трейда при любом значении.
 *
 * Умолчание — `faustus`: у валюты игрок меняет у NPC, и цена, которую он видит
 * в игре, — курс Faustus (решение по приёмке).
 */
export type MainPrice = 'trade' | 'faustus'
export const MAIN_PRICE: MainPrice = 'faustus'

/**
 * Крупное число и строка курса под ним. Валюту и осколки продают стаком:
 * крупно — цена всего стака, ниже — курс одной штуки (замечание приёмки:
 * «стак 20 хаосов — 1 дивайн»).
 */
function amountRows (rate: Rate, isExchange: boolean, stack: number | undefined): Row[] {
  const whole = stackPrice(rate, stack)
  // Курс стоит своей строкой — в крупной только число, иначе «(9.15 per 1 divine)»
  // от цены стака обрезается и ничего не значит.
  // Одна штука дороже единицы — курс и есть крупное число, строка курса его бы повторила.
  const rated = whole ?? (isExchange && rate.amount < 1 ? rate : undefined)
  const rows = [text(`~ ${rated ? priceValueText(whole ?? rate) : priceAmountText(rate)}`, 34, VALUE)]
  if (rated) {
    const unit = rateText(rate)
    rows.push(text(whole ? `stack ${stack} · ${unit}` : unit, 18, MUTED))
  }
  return rows
}

/** Курс Faustus второй строкой, когда главная — цена трейда. */
function faustusRow (reference: ExchangeReference, stack: number | undefined): Row {
  const whole = stackPrice(reference, stack)
  return text(`Faustus: ${whole ? `~ ${priceValueText(whole)} · ` : ''}${rateText(reference)}`, 22, VALUE)
}

/**
 * Кадр цены. Он же кадр «цены нет» — это ответ трейда, а не сбой.
 *
 * `previousMs` — возраст результата, когда его вернули жестом. Возвращённая
 * цена обязана выглядеть иначе, чем свежая: она про тот же предмет и тот же
 * набор фильтров, но рынок с тех пор мог уехать.
 *
 * `main` — какая цена крупная, по умолчанию `MAIN_PRICE`.
 */
export function priceFrame (item: PricedItem, check: PriceCheck, previousMs?: number, main: MainPrice = MAIN_PRICE): string[] {
  const rows: Row[] = [
    text(itemTitle(item), 24, ACCENT),
    text(itemSubtitle(item) || 'item parsed', 18, MUTED),
    rule()
  ]
  if (previousMs != null) {
    rows.push(text(`previous result · ${agoText(previousMs)}`, 18, WARN))
  }

  const stack = item.stackSize?.value
  if (main === 'faustus' && check.reference) {
    // Главная — курс Faustus: крупно он, цена трейда — строкой ниже.
    rows.push(...amountRows(check.reference, true, stack))
    rows.push(text(`Faustus exchange (poe.ninja), ${check.league}`, 18, NOTE))
    rows.push(check.price
      ? text(`trade: ~ ${priceValueText(stackPrice(check.price, stack) ?? check.price)} · ${priceScopeText(check.price)}`, 18, MUTED)
      : text(`trade: no listings in ${check.league}`, 18, WARN))
  } else if (check.price) {
    rows.push(...amountRows(check.price, check.price.kind === 'exchange', stack))
    rows.push(text(`${priceScopeText(check.price)}, ${check.league}`, 18, NOTE))
    // Разброс: где рынок стоит и насколько он широк. Одно число не отличает
    // рынок «5,5,6,6,7» от рынка «1,1,40,40,80», а решение продавать это меняет.
    // У обмена разброса нет: цена — лучший курс, а хвост выдачи — завышенные лоты.
    const spread = check.price.kind === 'exchange' ? '' : priceSpreadText(check.price)
    if (spread) rows.push(text(spread, 18, MUTED))
    // Четыре лота на весь трейд — это цена четырёх конкретных предметов, а не
    // предмета: на прогоне #113 Cane of Kulemak с четырьмя включёнными модами
    // дал 37.5 divine из четырёх лотов при рыночных 6–10.
    if (check.price.total < NARROW_SAMPLE) {
      rows.push(text(`only ${check.price.total} listings — the filter is narrow`, 18, WARN))
    }
    if (check.reference) rows.push(faustusRow(check.reference, stack))
  } else {
    rows.push(text('no price', 28, WARN))
    rows.push(text(`no listings in ${check.league}`, 18, NOTE))
    if (check.reference) rows.push(faustusRow(check.reference, stack))
  }

  // Оговорки. Молчать о них нельзя: пустой фильтр при пяти модах — это цена
  // базы, и показывать её как цену предмета значит показать чужое число.
  if (check.fellBackToSearch) {
    rows.push(text('no exchange rate — price from listings', 18, WARN))
  }
  // Режим поиска — часть ответа, а не настройка где-то в стороне: инстант-баяут
  // и сделка из рук в руки на одном предмете отличаются в разы (замер 15.09,
  // Ambu's Charge: 1 chaos против 10). Заказанный режим пуст — говорим, каким
  // рынком отвечаем вместо него.
  rows.push(text(
    check.fellBackToMode
      ? `nothing in the chosen mode — showing ${MODE_LABEL[check.mode]}`
      : `mode: ${MODE_LABEL[check.mode]}`,
    18,
    check.fellBackToMode ? WARN : MUTED
  ))
  // Набор игрока сказан вместо автоматической оговорки: «6 модов вне фильтра»
  // после ручной правки означало бы не то, что игрок сделал.
  if (check.manualStats) {
    rows.push(text(
      check.manualStats.length
        ? `by ${check.manualStats.length} selected filters`
        : 'no stat filters: base price',
      18,
      check.manualStats.length ? NOTE : WARN
    ))
    // Пустая выдача при выбранных фильтрах читается как «поиск не работает»
    // (прогон #101). Это не поломка, а слишком узкий набор — и сказать об этом
    // должна панель, а не журнал, которого игрок не видит.
    if (!check.price && check.manualStats.length) {
      rows.push(text('filters narrowed it to nothing — drop some and confirm again', 18, WARN))
    }
  } else if (check.fork === 'search' && check.skippedExplicits) {
    rows.push(text(scopeNote(item, check.skippedExplicits), 18, WARN))
  }

  return frame(rows)
}

// ── редактор фильтров ────────────────────────────────────────────────────────
//
// Список модов длиннее экрана по определению: у редкого предмета их
// шесть-восемь, у каждого числового мода три слота курсора, а панель не имеет
// права закрыть игру целиком. Поэтому список едет окном вокруг курсора, а то,
// что за окном, названо числом, а не молча обрезано — «доступен целиком с
// геймпада» из приёмки эпика иначе не проверить.

/** Место панели редактора и кегли. Окончательные выбираются на живом Deck. */
export interface EditorLayout extends Box { title: number, body: number }
export const EDITOR_LAYOUT: EditorLayout = { ...BOX, title: 22, body: 18 }

const boundText = (value?: number): string => value == null ? '-' : rollText(value)

/** Выбранное значение в скобках, правимое — в угловых. Только ASCII (ADR 0003, Ф4). */
const focusMark = (value: string, focused: boolean, editing: boolean): string =>
  focused ? (editing ? `<${value}>` : `[${value}]`) : value

/**
 * Строка списка: слева состояние и мод, справа границы или причина недоступности.
 *
 * Название, не влезающее в строку, переносится на вторую, а не режется: «Trigger
 * Level 20 Death Au...» нельзя ни прочитать, ни сверить с описанием в игре
 * (претензия тестера после прогонов #101 и #107 — «текст модов всё ещё не
 * помещается»). Вторая строка идёт с отступом под название и без хвоста: флажок
 * и границы уже сказаны в первой.
 */
function listLines (px: number, width: number, head: string, label: string, tail: string, labelW = width): string[] {
  const room = charBudget(px, labelW) - head.length - tail.length - 2
  if (label.length <= room) return [`${head} ${label} ${tail}`.trim()]

  // Переносим по словам — разрыв посреди слова читается хуже, чем короткая строка.
  const words = label.split(' ')
  let first = ''
  while (words.length && `${first} ${words[0]!}`.trim().length <= room) {
    first = `${first} ${words.shift()!}`.trim()
  }
  if (!first) first = label.slice(0, room) // одно слово длиннее строки — редкость, но не падаем

  // Отступом продолжение не пометить: `fit` схлопывает пробелы (перевод строки
  // разорвал бы команду шва), поэтому ведущий пробел до экрана не доедет.
  // Точка — тот же символ, что уже разделяет части заголовка, и она сразу
  // говорит, что строка не начинает новый мод.
  const mark = '· '
  const restRoom = charBudget(px, width) - mark.length
  const rest = words.join(' ') || label.slice(first.length).trim()
  const second = rest.length > restRoom ? `${rest.slice(0, Math.max(1, restRoom - 3)).trimEnd()}...` : rest
  return [`${head} ${first} ${tail}`.trim(), `${mark}${second}`]
}

/**
 * Колонки строки мода с диапазоном: название, min, max, `=`. Колонки границ
 * узкие и стоят у правого края всегда, а не сразу за названием: зона наведения
 * обязана лежать под своей надписью. Прежде зоны были четвертями строки, а
 * `2+ =` шли за названием — у короткого мода над зоной `=` было пусто, а
 * min и max попадали на название (прогон #150). Ширина — под `<12.5>` и `[=]`.
 */
const BOUND_CHARS = 8
const EXACT_CHARS = 4
function modStops (px: number, width: number): number[] {
  const inner = width - PAD * 2
  const bound = BOUND_CHARS * px * 0.52 / inner
  const exact = EXACT_CHARS * px * 0.52 / inner
  return [0, 1 - exact - bound * 2, 1 - exact - bound, 1 - exact]
}

function modLines (
  row: ModFilter,
  px: number,
  width: number,
  focus: { field?: Slot['kind'], editing: boolean }
): { lines: string[], controls?: string[] } {
  const box = row.unavailable ? '[-]' : row.enabled ? '[x]' : '[ ]'
  if (row.kind === 'range' && !row.unavailable) {
    // Подпись пустой границы видна всегда, а не только под курсором: надпись,
    // которая появляется при наведении, перекладывает строку, и она моргает.
    const bound = (value: number | undefined, name: 'min' | 'max'): string =>
      focusMark(value == null ? name : rollText(value), focus.field === name, focus.editing)
    const labelW = Math.round((width - PAD * 2) * modStops(px, width)[1]!) + PAD * 2
    return {
      lines: listLines(px, width, box, row.label, '', labelW),
      controls: [bound(row.min, 'min'), bound(row.max, 'max'), focusMark('=', focus.field === 'exact', false)]
    }
  }
  const tail = row.unavailable
    ? `(${row.unavailable})`
    : row.kind === 'option'
      ? `variant ${rollText(row.option ?? 0)}`
      // У мода-флага значения нет, и флажок слева уже сказал всё: слово
      // «есть/нет» отнимало у названия девять символов ни за что.
      : ''
  // Флажок в скобки не заворачиваем: он сам из скобок, а выбранная строка уже
  // помечена полоской и цветом.
  return { lines: listLines(px, width, box, row.label, tail) }
}

/**
 * Кадр редактора: что уедет в поиск и что игрок правит прямо сейчас.
 *
 * `last` — цена, которая уже получена. Пока черновик не применён, она названа
 * прежней: приписать старое число новому набору фильтров значит соврать о том,
 * за что эта цена. Это требование эпика, а не оформление.
 */
export function editorFrame (
  item: PricedItem,
  editor: Editor,
  layout: EditorLayout = EDITOR_LAYOUT,
  last?: PriceCheck
): string[] {
  return editorView(item, editor, layout, last).lines
}

/** Зона экрана, под которой лежит слот курсора. Пустая — не кликабельная строка. */
export interface EditorZone { slot: number, x: number, y: number, w: number, h: number }

/**
 * Кадр редактора вместе с зонами наведения.
 *
 * Зоны нужны с тех пор, как курсор стал каналом ввода: замер #94
 * показал, что левый тачпад двигает указатель на сервере игры, а правый — нет, то есть у
 * панели есть свой манипулятор, не отнятый у игрока. Палец наводит на строку,
 * задняя кнопка действует.
 *
 * Строка мода делится по горизонтали на четыре зоны: флажок, min, max и `=` — ровно те
 * слоты, которые до этого перебирались кнопкой. Строка подвала — подтверждение
 * и отмена. Недоступные моды и служебные строки зон не получают: делать с ними
 * нечего, а «нажал и ничего не произошло» хуже, чем «туда не наводится».
 */
export function editorView (
  item: PricedItem,
  editor: Editor,
  layout: EditorLayout = EDITOR_LAYOUT,
  last?: PriceCheck
): { lines: string[], zones: EditorZone[], box: EditorZone } {
  const all = slots(editor.draft)
  const slot = slotAt(editor)
  const dirty = isDirty(editor)
  const problem = draftProblem(editor.draft)
  const width = layout.w

  const sent = editor.draft.filter(row => row.enabled && row.id).length
  const available = editor.draft.filter(row => row.id).length

  // Две строки вместо трёх: цена и состояние фильтров живут в одной. Место на
  // 7" экране дороже симметрии, а разделителей и так хватает.
  const status = `searching ${sent} of ${available} · ${dirty ? 'draft' : 'applied'}`
  const head: Row[] = [text(itemTitle(item), layout.title, ACCENT)]
  if (last?.price) {
    head.push(text(
      dirty
        ? `previous ~ ${priceAmountText(last.price)} · ${status}`
        : `~ ${priceAmountText(last.price)}, ${last.league} · ${status}`,
      layout.body,
      dirty ? WARN : VALUE
    ))
  } else {
    head.push(text(status, layout.body, dirty ? WARN : NOTE))
  }
  head.push(rule())

  const foot: Row[] = [rule()]
  // Рынок стоит отдельной строкой над кнопками: это часть вопроса, который
  // уедет в трейд, а не настройка где-то в стороне. Клик по ней перебирает
  // пять режимов по кругу — выпадающий список пальцем не берётся.
  foot.push(text(
    `${focusMark(`mode: ${MODE_LABEL[editor.mode]}`, slot.kind === 'mode', false)}`,
    layout.body,
    slot.kind === 'mode' ? ACCENT : editor.mode === editor.appliedMode ? MUTED : WARN,
    slot.kind === 'mode'
  ))
  const onAction = slot.kind === 'confirm' || slot.kind === 'cancel'
  foot.push(columns(
    [focusMark('confirm', slot.kind === 'confirm', false), focusMark('cancel', slot.kind === 'cancel', false)],
    layout.body,
    onAction ? ACCENT : MUTED,
    onAction
  ))
  if (problem) foot.push(text(`${problem.reason} — cannot search like that`, layout.body, ERROR))
  if (!editor.draft.length) {
    // Форма без модов — валюта, карта, ключ. Редактировать нечего, и это не сбой.
    foot.push(text('item has no mods — searching by name and base', layout.body, MUTED))
  }

  // Сколько СТРОК влезет между шапкой и подвалом, не вылезая за низ экрана.
  // Считаем строки, а не моды: длинное название занимает две, и каждая смена
  // группы добавляет заголовок.
  const step = lineHeight(layout.body) + GAP
  const room = SCREEN_H - layout.y - PAD * 2 - heightOf([...head, ...foot])
  // Минус две строки: «выше ещё N» и «ниже ещё N» тоже занимают место.
  const budget = Math.max(2, Math.floor(room / step) - 2)
  // Грубая оценка «сколько это модов» нужна только чтобы прицелить окно на
  // выбранную строку; сколько войдёт на самом деле, решает бюджет ниже.
  const visible = Math.max(1, Math.floor(budget / 1.4))

  // Курсор на подтверждении не сбрасывает список к началу: окно держится за
  // последний мод, который игрок смотрел.
  let anchor = 0
  for (let i = Math.min(editor.index, all.length - 1); i >= 0; i--) {
    const seen = all[i]!
    if ('row' in seen) { anchor = seen.row; break }
  }
  let start = Math.max(0, Math.min(anchor - Math.floor(visible / 2), editor.draft.length - visible))

  /** Что влезает в бюджет строк, начиная с мода `from`. */
  const pick = (from: number): Array<{ index: number, lines: string[], controls?: string[], group?: string }> => {
    const out: Array<{ index: number, lines: string[], controls?: string[], group?: string }> = []
    let used = 0
    let prevType: string | undefined
    for (let i = from; i < editor.draft.length; i++) {
      const row = editor.draft[i]!
      const focused = 'row' in slot && slot.row === i
      const { lines, controls } = modLines(row, layout.body, width, {
        field: focused ? slot.kind : undefined,
        editing: focused && editor.editing
      })
      const group = row.type === prevType ? undefined : groupLabel(row.type)
      const cost = lines.length + (group ? 1 : 0)
      if (out.length && used + cost > budget) break
      out.push({ index: i, lines, controls, group })
      used += cost
      prevType = row.type
    }
    return out
  }

  let shown = pick(start)
  // Выбранная строка обязана быть на экране: иначе курсор уезжает за край окна
  // и палец водит вслепую.
  // Окно тогда заканчивается на ней, а не начинается с неё: прежнее `start =
  // anchor` на последнем моде оставляло его одного и прятало семь остальных за
  // «more above» (прогон #145, Large Cluster Jewel).
  if (!shown.some(entry => entry.index === anchor)) {
    start = anchor
    while (start > 0 && pick(start - 1).some(entry => entry.index === anchor)) start--
    shown = pick(start)
  }

  const list: Row[] = []
  /** Первая строка мода — к ней привязаны зоны наведения. */
  const headRow = new Map<number, Row>()
  if (start > 0) list.push(text(`... ${start} more above`, layout.body, MUTED))
  for (const entry of shown) {
    const row = editor.draft[entry.index]!
    const focused = 'row' in slot && slot.row === entry.index
    if (entry.group) list.push(text(`-- ${entry.group} --`, layout.body, MUTED))
    entry.lines.forEach((line, at) => {
      const color = focused ? ACCENT : row.enabled ? VALUE : MUTED
      const made = at === 0 && entry.controls
        ? columns([line, ...entry.controls], layout.body, color, focused, modStops(layout.body, width))
        : text(line, layout.body, color, focused && at === 0)
      if (at === 0) headRow.set(entry.index, made)
      list.push(made)
    })
  }
  const below = editor.draft.length - (start + shown.length)
  if (below > 0) list.push(text(`... ${below} more below`, layout.body, MUTED))

  const rows = [...head, ...list, ...foot]
  const { lines, spans, height } = laidOutFrame(rows, layout)

  // Зоны считаются по ТЕМ ЖЕ пролётам, что нарисованы: индекс строки списка
  // переводится в индекс пролёта, а не в отдельно посчитанный y.
  const textRows: Row[] = rows.filter(row => row.kind === 'text')
  const zones: EditorZone[] = []
  const zoneOf = (row: Row, slot: number, part = 0, parts = 1): void => {
    const at = textRows.indexOf(row)
    const span = spans[at]
    if (!span || slot < 0) return
    const { x, w } = columnSpan(layout, part, parts, row.kind === 'text' ? row.stops : undefined)
    zones.push({ slot, x, y: span.y, w, h: span.height })
  }

  shown.forEach(entry => {
    const index = entry.index
    const row = editor.draft[index]!
    const line = headRow.get(index)
    if (!line || !row.id) return // недоступный мод трогать нечем
    const fields: Array<Slot['kind']> = row.kind === 'range'
      ? ['enabled', 'min', 'max', 'exact']
      : ['enabled']
    fields.forEach((field, part) => {
      zoneOf(line, all.findIndex(s => 'row' in s && s.row === index && s.kind === field), part, fields.length)
    })
  })

  const footRows: Row[] = foot.filter(row => row.kind === 'text')
  const [modeRow, actionRow] = footRows
  if (modeRow) zoneOf(modeRow, all.findIndex(s => s.kind === 'mode'))
  if (actionRow) {
    zoneOf(actionRow, all.findIndex(s => s.kind === 'confirm'), 0, 2)
    zoneOf(actionRow, all.findIndex(s => s.kind === 'cancel'), 1, 2)
  }

  // Прямоугольник всей панели, а не только строк: «курсор ушёл с панели»
  // считается по нему, иначе палец, попавший между строк, читался бы как уход.
  const box: EditorZone = { slot: -1, x: layout.x, y: layout.y, w: layout.w, h: height }
  return { lines, zones, box }
}

/**
 * Слот под курсором. `null` — курсор вне панели: выбор при этом НЕ сбрасывается
 * (за это отвечает вызывающий), потому что указатель относительный и уезжает за
 * край панели от любого лишнего движения пальцем.
 */
export function zoneAt (zones: EditorZone[], x: number, y: number): number | null {
  for (const zone of zones) {
    if (x >= zone.x && x < zone.x + zone.w && y >= zone.y && y < zone.y + zone.h) return zone.slot
  }
  return null
}

/**
 * Беда словами для игрока. Кадр читают в бою, поэтому у каждой беды
 * три ответа: что случилось, подробность и **что делать** — без последнего
 * игрок жмёт кнопку наугад или решает, что poe-deck сломан.
 *
 * `retryAt` есть только у лимита: момент, когда трейд снова примет запрос.
 * Секунды до него считаются в момент рисования, а не хранятся числом —
 * иначе повторное нажатие показало бы прежний остаток.
 */
export interface Failure {
  title: string
  detail: string
  todo: string
  retryAt?: number
}

/** Секунды до повтора, округлённые вверх: «0s» при живом окне было бы враньём. */
export function secondsLeft (retryAt: number, now: number): number {
  return Math.max(1, Math.ceil((retryAt - now) / 1000))
}

/**
 * Кадр беды. Заголовок — что случилось, ниже подробность и одна строка «что
 * делать» своим цветом: её ищут глазами первой.
 *
 * Кадр лимита перерисовывается по событию (ADR 0003, Решение 3), а не по
 * таймеру кадров: новое нажатие рисует его заново с новым остатком, а конец
 * окна сменяет его кадром `rateLimitOverFrame`. Секундомера, тикающего раз в
 * секунду, нет намеренно.
 */
export function errorFrame (failure: Failure, now = Date.now()): string[] {
  const detail = failure.retryAt != null
    ? `${failure.detail}: retry in ${secondsLeft(failure.retryAt, now)}s`
    : failure.detail
  return frame([
    text('price check failed', 24, ERROR),
    rule(),
    text(failure.title, 26, VALUE),
    text(detail, 18, MUTED),
    text(failure.todo, 18, NOTE)
  ])
}

/**
 * Кнопка прайс-чека в шаблоне раскладки — словом для игрока. Шаблон вешает
 * аккорд `POE_DECK_KEYS` на нижнюю левую заднюю кнопку (ADR 0002, Ф17): L3
 * остаётся игре — клик стика показывает расширенный текст предмета. Договор
 * держит tools/steam-template.test.ts.
 */
export const PRICE_BUTTON = 'L5'
/** Кнопка «убрать / вернуть» в шаблоне раскладки (`POE_DECK_TOGGLE_KEYS`). */
export const TOGGLE_BUTTON = 'L4'

/**
 * Первый запуск после установки: один кадр «всё готово» и какую
 * кнопку жать. Показывается один раз на устройство — метку ставит демон.
 * Без него первое, что игрок видит от poe-deck, — ничего, а ничего неотличимо
 * от «не поставилось».
 */
export function readyFrame (): string[] {
  return frame([
    text('poe-deck ready', 24, ACCENT),
    rule(),
    text(`select an item and press ${PRICE_BUTTON}`, 22, VALUE),
    text(`${TOGGLE_BUTTON} hides the panel or brings it back`, 18, MUTED),
    text('no price? run poe-deck doctor in Desktop Mode', 18, NOTE)
  ])
}

/** Окно лимита кончилось, пока кадр лимита был на экране: можно жать снова. */
export function rateLimitOverFrame (): string[] {
  return frame([
    text('trade is ready again', 24, ACCENT),
    rule(),
    text('the rate limit window is over', 18, MUTED),
    text('press the price-check button again', 18, NOTE)
  ])
}

/** Подсказка про лигу: файл конфига игрока и самопроверка (src/config.ts). */
// Влезает в строку кегля 18 (64 символа): длиннее — и совет уйдёт в «...».
// Полный путь к файлу называет doctor.
const LEAGUE_TODO = 'fix league in poe-deck.conf or run poe-deck doctor'

/**
 * Отказ → слова для человека. Разные причины требуют разных действий, поэтому
 * «что-то пошло не так» здесь запрещено: оно неотличимо от молчания.
 */
export function explainFailure (err: unknown): Failure {
  if (err instanceof RateLimitError) {
    return {
      title: 'trade rate limit',
      // Отказ нашего лимитера и отказ сервера просят одного и того же, но
      // первый — вежливость, второй — штраф, и игроку полезно знать разницу.
      detail: err.source === 'server' ? 'GGG asked to wait' : 'holding requests under the GGG limit',
      todo: 'press again after that — earlier presses are not sent',
      retryAt: err.retryAt
    }
  }
  if (err instanceof MaintenanceError) {
    return {
      title: 'GGG servers are down',
      detail: `pathofexile.com answers ${err.status}: maintenance or a patch`,
      todo: 'not your Wi-Fi — try again when pathofexile.com is back'
    }
  }
  if (err instanceof UnknownLeagueError) {
    return {
      title: 'league not found',
      detail: `"${err.league}" ended or was renamed`,
      todo: LEAGUE_TODO
    }
  }
  if (err instanceof TradeTimeoutError) {
    return {
      title: 'trade did not answer',
      detail: `no reply in ${REQUEST_TIMEOUT_MS / 1000}s`,
      todo: 'press again; if it repeats, check Wi-Fi'
    }
  }
  if (err instanceof TradeHttpError) {
    return {
      title: 'trade server error',
      detail: `pathofexile.com answered HTTP ${err.status}`,
      todo: 'press again in a minute'
    }
  }
  if (err instanceof BlockedHostError) {
    return {
      title: 'request never left',
      detail: `host ${err.host} is not allowlisted`,
      todo: 'this is a poe-deck bug — report it with the daemon log'
    }
  }

  const message = err instanceof Error ? err.message : String(err)

  if (/trade API:/.test(message)) {
    return {
      title: 'trade returned an error',
      detail: message.replace(/^trade API:\s*/, ''),
      todo: 'press again; if it repeats, report the item'
    }
  }
  if (/unable to connect|connection|failed to fetch|fetch failed|dns|getaddrinfo|socket|timeout|network/i.test(message)) {
    return {
      title: 'no network',
      detail: 'cannot reach pathofexile.com',
      todo: 'check Wi-Fi, then press again'
    }
  }
  if (/no tradeable league/.test(message)) {
    return { title: 'league not found', detail: 'pathofexile.com lists no trade league', todo: LEAGUE_TODO }
  }

  return { title: 'request failed', detail: message, todo: 'press again; if it repeats, run poe-deck doctor' }
}
