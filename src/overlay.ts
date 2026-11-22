// Панель как одно состояние: цена, редактор, беда, пустота — и переходы между ними.
//
// Сборка ежедневного сценария. До этого файла демон сам решал, какой
// кадр показать, и знал про таймеры; теперь он занимается процессами, а решения
// принимаются здесь — без X11, без сети и без часов, поэтому проверяются
// обычным `bun test`.
//
// ── Почему у редактора нет кнопки «открыть» ────────────────────────────────
//
// Свободных задних кнопок на Deck ровно одна (ADR 0002: нижняя левая занята
// прайс-чеком, нижняя правая — шаблоном `gamepad_fps`), и она нужна под
// действие. Поэтому редактор **разворачивается наведением**: курсор заехал на
// панель — появился список модов, увёл палец — панель свернулась обратно в
// цену. Кнопок это не стоит вовсе.
//
// Так можно потому, что замеры дали редкое сочетание: курсор двигает ЛЕВЫЙ
// тачпад и только он (Ф14), то есть у панели свой манипулятор, не отнятый у
// игры, а клик тачпада PoE всё равно игнорирует (Ф12).
//
// ── Два таймера, и они про разное ──────────────────────────────────────────
//
//  - `hideAt` — сколько цена висит на экране (POE_DECK_PANEL_TTL). Пока палец
//    на панели, он не тикает: гасить то, что человек читает и правит, нельзя.
//  - `leaveAt` — сколько ждать, прежде чем свернуть редактор обратно. Без
//    задержки панель схлопывалась бы от любого дрожания пальца у края.

import { newEditor, reduce, slots, type Editor, type EditorSearch } from './editor'
import {
  checkingFrame,
  clearFrame,
  editorFrame,
  editorView,
  errorFrame,
  agoText,
  noResultFrame,
  priceFrame,
  rateLimitOverFrame,
  zoneAt,
  type EditorLayout,
  type EditorZone,
  type Failure
} from './panel'
import type { PriceCheck } from './price-check'
import { priceAmountText } from './trade/price'
import { DEFAULT_SEARCH_MODE, type SearchMode } from './trade/query'
import { toStatFilters } from './trade/filters'
import type { PricedItem } from './trade/query'

export type OverlayMode = 'idle' | 'checking' | 'price' | 'editor' | 'error' | 'notice'

export interface Overlay {
  mode: OverlayMode
  item?: PricedItem
  check?: PriceCheck
  editor?: Editor
  /** Когда гасить панель, мс. `0` — срока нет (кадр сменится следующим). */
  hideAt: number
  /** Когда свернуть редактор обратно в цену. `0` — курсор на панели. */
  leaveAt: number
  /**
   * Откуда отсчитывать правку значения: Y курсора на момент входа в неё.
   * В режиме правки палец не выбирает строку, а крутит число — как колесо.
   */
  grabY?: number
  /** Где курсор был в последний раз. Отсюда берётся точка отсчёта правки. */
  lastY?: number
  /**
   * Рынок по умолчанию для нового предмета. Режим правится в редакторе, но
   * следующий предмет начинает с того, что выбрано демоном, а не с заводского:
   * игрок выбирает рынок один раз за сессию, а не на каждую вещь.
   */
  priceMode: SearchMode
  /**
   * Последний завершённый результат сессии. Держится, когда панель погашена —
   * жестом или по сроку, — чтобы вернуть его на экран без нового запроса к
   * трейду (обязательное действие эпика).
   */
  last?: LastResult
  /**
   * Игрок убрал панель сам. Поздний ответ на уже идущий поиск её не открывает:
   * убрал — значит сейчас смотрит в игру, а не в цену.
   */
  hidden?: boolean
  /**
   * Беда на экране. Держится ради лимита: конец его окна — событие, по
   * которому кадр меняется на «можно снова».
   */
  failure?: Failure
}

/** Завершённый результат: что показывали, по какому набору и когда. */
export interface LastResult {
  item: PricedItem
  check: PriceCheck
  editor: Editor
  /** Когда получен. Возраст едет на панель: цена без времени — обещание. */
  at: number
}

export interface OverlayTimes {
  /** Сколько цена живёт на экране без пальца. */
  ttlMs: number
  /** Сколько ждать после ухода курсора, прежде чем свернуть редактор. */
  leaveMs: number
  /** Сколько пикселей движения пальца на один шаг значения. */
  pxPerStep?: number
}

export const DEFAULT_TIMES: OverlayTimes = { ttlMs: 15_000, leaveMs: 1_200, pxPerStep: 14 }

export type OverlayEvent =
  | { kind: 'checking', item: PricedItem }
  | { kind: 'price', item: PricedItem, check: PriceCheck }
  /**
   * `press` — отказ на само нажатие L5, а не поздний ответ поиска: игрок только
   * что попросил панель, и прежнее «убрал жестом» его не глушит.
   */
  | { kind: 'failure', failure: Failure, press?: boolean }
  | { kind: 'pointer', x: number, y: number }
  | { kind: 'act' }
  /** Второй жест: убрать панель или вернуть последний результат, без запроса. */
  | { kind: 'toggle' }
  /**
   * L5 по тому же буферу, по которому уже есть результат: показать его, как
   * возврат L4, без запроса. Нового предмета нет — нового вопроса к трейду тоже.
   */
  | { kind: 'recall' }
  | { kind: 'focus', inGame: boolean }
  /** Сообщение демона, не связанное с предметом: кадр «ready» первого запуска. */
  | { kind: 'notice', frame: string[] }
  | { kind: 'tick' }

export interface OverlayStep {
  overlay: Overlay
  /** Кадр, если он изменился. Нет — значит перерисовывать нечего. */
  frame?: string[]
  /** Подтверждённый набор: фильтры и режим рынка, ровно на один поиск. */
  search?: EditorSearch
}

export const newOverlay = (mode: SearchMode = DEFAULT_SEARCH_MODE): Overlay =>
  ({ mode: 'idle', hideAt: 0, leaveAt: 0, priceMode: mode })

/**
 * Последний результат обратно на панель: тот же предмет, тот же набор, возраст.
 * Общий для L4 и повторного L5, чтобы два пути возврата не разошлись.
 */
function restore (overlay: Overlay, last: LastResult, now: number, times: OverlayTimes): OverlayStep {
  return {
    overlay: {
      mode: 'price',
      item: last.item,
      check: last.check,
      editor: last.editor,
      hideAt: now + times.ttlMs,
      leaveAt: 0,
      priceMode: overlay.priceMode,
      last,
      hidden: false
    },
    frame: priceFrame(last.item, last.check, Math.max(0, now - last.at))
  }
}

/** Кадр редактора и его геометрия — одним вызовом, чтобы они не разъехались. */
function view (overlay: Overlay, layout?: EditorLayout): { lines: string[], zones: EditorZone[], box: EditorZone } {
  return editorView(overlay.item!, overlay.editor!, layout, overlay.check)
}

/**
 * Событие → новое состояние панели.
 *
 * `now` передаётся снаружи: часы — это тоже внешний мир, и без них переходы
 * проверяются тестом, а не прогоном на железе.
 */
export function step (
  overlay: Overlay,
  event: OverlayEvent,
  now: number,
  times: OverlayTimes = DEFAULT_TIMES,
  layout?: EditorLayout
): OverlayStep {
  switch (event.kind) {
    case 'checking':
      // Нажатие прайс-чека — сам по себе возврат панели: игрок смотрит на цену.
      return {
        overlay: {
          mode: 'checking',
          item: event.item,
          hideAt: 0,
          leaveAt: 0,
          priceMode: overlay.priceMode,
          last: overlay.last
        },
        frame: checkingFrame(event.item)
      }

    case 'price': {
      // Новый предмет — новый черновик: фильтры прошлого предмета не переносятся
      // (требование эпика). Тот же предмет после подтверждения — состояние
      // редактора сохраняется, иначе правки исчезали бы вместе с ответом.
      const same = overlay.item === event.item && overlay.editor
      const editor = same ? overlay.editor! : newEditor(event.item, overlay.priceMode)
      const next: Overlay = {
        mode: overlay.mode === 'editor' ? 'editor' : 'price',
        item: event.item,
        check: event.check,
        editor,
        hideAt: overlay.mode === 'editor' ? 0 : now + times.ttlMs,
        leaveAt: overlay.mode === 'editor' ? overlay.leaveAt : 0,
        // Выбранный игроком рынок переживает ответ и переезжает на следующий
        // предмет: менять его заново на каждую вещь — работа, а не настройка.
        priceMode: editor.appliedMode
      }
      const last: LastResult = { item: event.item, check: event.check, editor, at: now }

      // Поздний ответ на поиск, который игрок уже «отменил» жестом: результат
      // запоминаем, но панель сама не поднимаем (требование эпика).
      if (overlay.hidden) {
        return { overlay: { ...newOverlay(overlay.priceMode), last, hidden: true } }
      }

      return {
        overlay: { ...next, last },
        frame: next.mode === 'editor'
          ? view(next, layout).lines
          : priceFrame(event.item, event.check)
      }
    }

    case 'failure':
      if (overlay.hidden && !event.press) return { overlay }
      return {
        overlay: {
          mode: 'error',
          hideAt: now + times.ttlMs,
          leaveAt: 0,
          priceMode: overlay.priceMode,
          last: overlay.last,
          failure: event.failure
        },
        frame: errorFrame(event.failure, now)
      }

    case 'pointer': {
      if (!overlay.item || !overlay.editor) return { overlay }
      if (overlay.mode !== 'price' && overlay.mode !== 'editor') return { overlay }

      // Правка границы: палец крутит число, а не выбирает строку. Панель при
      // этом не сворачивается, даже если курсор уехал за её край — иначе
      // значение нельзя было бы докрутить до конца.
      if (overlay.editor.editing) {
        const px = times.pxPerStep ?? 14
        const from = overlay.grabY ?? event.y
        const steps = Math.trunc((from - event.y) / px) // вверх — больше
        if (!steps) return { overlay }
        const editor = Array.from({ length: Math.abs(steps) })
          .reduce<Editor>(state => reduce(state, steps > 0 ? 'next' : 'prev').editor, overlay.editor)
        const next: Overlay = {
          ...overlay, editor, grabY: from - steps * px, lastY: event.y, hideAt: 0, leaveAt: 0
        }
        return { overlay: next, frame: view(next, layout).lines }
      }

      const { zones, box } = view(overlay, layout)
      const onPanel = event.x >= box.x && event.x < box.x + box.w &&
                      event.y >= box.y && event.y < box.y + box.h

      if (!onPanel) {
        // Курсор ушёл — не сворачиваем сразу: у относительного указателя (Ф14)
        // край панели задевается любым лишним движением пальца.
        if (overlay.mode !== 'editor' || overlay.leaveAt) return { overlay: { ...overlay, lastY: event.y } }
        return { overlay: { ...overlay, lastY: event.y, leaveAt: now + times.leaveMs } }
      }

      const slot = zoneAt(zones, event.x, event.y)
      const editor: Editor = {
        ...overlay.editor,
        open: true,
        index: slot ?? overlay.editor.index
      }
      const next: Overlay = { ...overlay, mode: 'editor', editor, lastY: event.y, hideAt: 0, leaveAt: 0 }

      // Перерисовываем только когда что-то изменилось: курсор шевелится
      // десятки раз в секунду, и слать кадр на каждое движение незачем.
      const changed = overlay.mode !== 'editor' || editor.index !== overlay.editor.index
      return changed ? { overlay: next, frame: view(next, layout).lines } : { overlay: next }
    }

    case 'act': {
      if (overlay.mode !== 'editor' || !overlay.editor) return { overlay }
      const done = reduce(overlay.editor, 'act')
      // Вход в правку: дальше палец крутит значение, и отсчёт ведётся от точки,
      // где он был в этот момент. Выход — та же кнопка, точка отсчёта сбрасывается.
      const next: Overlay = {
        ...overlay,
        editor: done.editor,
        grabY: done.editor.editing ? overlay.lastY ?? 0 : undefined
      }
      if (!done.search) return { overlay: next, frame: view(next, layout).lines }

      // Подтверждение: панель честно говорит «ищу цену», а поиск уходит наружу.
      // Предмет остаётся тем же — значит черновик переживёт ответ.
      return {
        overlay: { ...next, mode: 'checking', hideAt: 0, leaveAt: 0 },
        frame: checkingFrame(overlay.item!),
        search: done.search
      }
    }

    case 'toggle': {
      // Панель на экране — убрать. Последний результат при этом не теряется:
      // тем же жестом он возвращается.
      if (overlay.mode !== 'idle') {
        return {
          overlay: { ...newOverlay(overlay.priceMode), last: overlay.last, hidden: true },
          frame: clearFrame()
        }
      }

      // Возврат. Нового запроса нет и быть не должно: показываем ровно то, что
      // уже получено, вместе с возрастом и набором фильтров, по которому оно
      // получено.
      // Возвращать нечего — подсказка вместо молчания. Это сообщение, а не
      // цена: живёт тот же срок, что кадр ready, и гасится тем же L4.
      const last = overlay.last
      if (!last) {
        return {
          overlay: { ...newOverlay(overlay.priceMode), mode: 'notice', hideAt: now + times.ttlMs },
          frame: noResultFrame()
        }
      }

      return restore(overlay, last, now, times)
    }

    case 'recall': {
      // Тот же предмет по L5 после L4 молчал: буфер не сменился, отказ
      // «game did not copy» глушила убранная панель (rc6, замечание 15).
      // Показываем то же, что вернул бы L4, — с возрастом, чтобы старую цену
      // нельзя было принять за свежую. Без результата показывать нечего: демон
      // такое событие не шлёт.
      const last = overlay.last
      if (!last) return { overlay }
      return restore(overlay, last, now, times)
    }

    case 'notice':
      // Сообщение не перебивает цену или правку: игрок, который уже жмёт
      // кнопку, знает, что poe-deck работает. Убранная жестом панель тоже
      // остаётся убранной. Живёт сообщение тот же срок, что и цена, и гасится
      // тем же L4.
      if (overlay.mode !== 'idle' || overlay.hidden) return { overlay }
      return {
        overlay: { ...newOverlay(overlay.priceMode), last: overlay.last, mode: 'notice', hideAt: now + times.ttlMs },
        frame: event.frame
      }

    case 'focus':
      if (event.inGame) return { overlay }
      // За пределами PoE панели нет вовсе: она не имеет права висеть поверх
      // интерфейса Steam (спайк по оверлею, эксп. 6).
      return { overlay: { ...newOverlay(overlay.priceMode), last: overlay.last }, frame: clearFrame() }

    case 'tick': {
      // Окно лимита кончилось, пока его кадр на экране: «retry in 42s» без
      // перерисовки так и висел бы, хотя жать уже можно. Это смена состояния,
      // а не секундомер — кадр уходит один раз, срок гашения начинается заново.
      const retryAt = overlay.failure?.retryAt
      if (overlay.mode === 'error' && retryAt != null && now >= retryAt) {
        return {
          overlay: { ...overlay, failure: undefined, hideAt: now + times.ttlMs },
          frame: rateLimitOverFrame()
        }
      }
      if (overlay.mode === 'editor' && overlay.leaveAt && now >= overlay.leaveAt) {
        const next: Overlay = { ...overlay, mode: 'price', leaveAt: 0, hideAt: now + times.ttlMs }
        return { overlay: next, frame: priceFrame(overlay.item!, overlay.check!) }
      }
      if (overlay.hideAt && now >= overlay.hideAt) {
        // Срок вышел — панель гаснет, но результат остаётся возвращаемым:
        // гашение по таймеру не то же самое, что «игрок убрал».
        return { overlay: { ...newOverlay(overlay.priceMode), last: overlay.last }, frame: clearFrame() }
      }
      return { overlay }
    }
  }
}

/**
 * Что сделал жест — строкой в журнал. `describe` говорит только про состояние
 * панели, и по нему нельзя отличить «вернули прежний результат» от «на панели и
 * так была цена»: в прогоне #121 одиннадцать нажатий L4 дали `toggle: price` и
 * `toggle: idle`, а доказательства возврата не осталось. Приёмка эпика требует
 * десять циклов — значит цикл должен быть виден в журнале.
 */
export function describeToggle (before: Overlay, after: Overlay, now: number): string {
  if (after.mode === 'idle') {
    if (before.mode === 'idle') return 'nothing to hide'
    // Скрытие во время поиска — отдельный случай приёмки: именно с него поздний
    // ответ не имеет права поднять панель обратно. По голому `hidden` его от
    // обычного скрытия не отличить (прогон #125).
    return before.mode === 'checking' ? 'hidden during a search' : 'hidden'
  }
  const last = after.last
  if (!last) return before.mode === 'idle' ? 'nothing to hide — hint shown' : `restored ${after.mode}`
  const name = last.item.info.name ?? last.item.info.refName
  const price = last.check.price ? priceAmountText(last.check.price) : 'no price'
  return `restored ${name}: ${price}, age ${agoText(Math.max(0, now - last.at))}`
}

/** Строка журнала о том, что сейчас на панели. Для прогонов на железе. */
export function describe (overlay: Overlay): string {
  if (overlay.mode !== 'editor' || !overlay.editor) return overlay.mode
  const all = slots(overlay.editor.draft)
  const slot = all[Math.min(overlay.editor.index, all.length - 1)]
  const where = slot && 'row' in slot ? `mod ${slot.row + 1}, ${slot.kind}` : slot?.kind ?? '—'
  return `editor: ${where}, filters ${toStatFilters(overlay.editor.draft).length}`
}

/** Кадр текущего состояния. Нужен, когда кадр потерян — например, рендерер перезапущен. */
export function currentFrame (overlay: Overlay, layout?: EditorLayout): string[] {
  if (overlay.mode === 'editor' && overlay.item && overlay.editor) return view(overlay, layout).lines
  if (overlay.mode === 'price' && overlay.item && overlay.check) return priceFrame(overlay.item, overlay.check)
  if (overlay.mode === 'checking' && overlay.item) return checkingFrame(overlay.item)
  if (overlay.mode === 'error' && overlay.failure) return errorFrame(overlay.failure)
  return clearFrame()
}

export { editorFrame }
