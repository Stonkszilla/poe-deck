// Редактор фильтров поиска: черновик, применённый набор и переход между ними.
//
// Этап 1. Здесь нет ни ввода, ни рисования, ни сети — только состояние
// и разрешённые переходы. Так сделано потому, что схема управления на Deck ещё
// НЕ выбрана (ADR 0002 держит только прайс-чек): какой кнопкой ходить по списку
// и какой подтверждать, решается на живом железе. Реализовать сначала действия,
// а привязки — потом, значит не выдумывать раскладку из головы.
//
// ── Почему действий именно столько ─────────────────────────────────────────
//
// Приёмка эпика требует: пройти весь список модов, включить и выключить фильтр,
// задать и очистить обе границы, подтвердить поиск и отменить правки. Это
// минимум — `next`/`prev`/`act`/`clear`/`confirm`/`cancel` плюс вход и выход.
// Кнопок под них на Deck столько не будет: свободны две задние (нижняя правая
// занята шаблоном `gamepad_fps`, нижняя левая — прайс-чеком), а зонд разбирает
// не больше восьми аккордов. Поэтому `confirm` и `cancel` доступны ДВОЯКО:
// отдельным действием и как строки списка, на которых работает `act` — схема с
// двумя кнопками (`next` + `act`) проходит все требования приёмки, а схема с
// отдельными кнопками работает быстрее. Что выбрать — покажет прогон.
//
// ── Что здесь намеренно не решается ───────────────────────────────────────
//
// Одновременная работа с игрой (крестовина продолжает управлять PoE), удержание
// и автоповтор, ответ trade API и память последнего результата — не тут. Это
// либо свойства канала ввода, либо работа демона.

import {
  copyFilters,
  defaultFilters,
  filterProblem,
  filterSignature,
  minRoll,
  toStatFilters,
  type ModFilter
} from './trade/filters'
import {
  DEFAULT_SEARCH_MODE,
  nextSearchMode,
  type PricedItem,
  type SearchMode,
  type StatEntryFilter
} from './trade/query'

/**
 * Поиск по решению игрока. `stats` нет — автоматический набор, как у первого
 * нажатия кнопки: так его видит кэш цены и так он подписан на панели.
 */
export interface EditorSearch { stats?: StatEntryFilter[], mode: SearchMode }

export type EditorAction =
  | 'open' | 'close'
  | 'next' | 'prev'
  | 'act' | 'clear'
  | 'confirm' | 'cancel'

/** Куда указывает курсор. Недоступные моды сюда не попадают: делать с ними нечего. */
export type Slot =
  | { kind: 'enabled' | 'min' | 'max' | 'exact', row: number }
  | { kind: 'mode' }
  | { kind: 'confirm' }
  | { kind: 'cancel' }

export interface Editor {
  /** Панель редактора на экране. Закрытый редактор черновик не теряет. */
  open: boolean
  /** Черновик: что игрок навёл. В поиск не уходит до подтверждения. */
  draft: ModFilter[]
  /** Применённый набор: по нему получена цена, которая сейчас на панели. */
  applied: ModFilter[]
  /**
   * Автонабор — с ним цена показалась после нажатия кнопки. К нему возвращает
   * отмена: после подтверждения откатывать к применённому набору нечего, а
   * игрок нажимает cancel, чтобы снять свой выбор (тестер, прогон #145).
   */
  auto: ModFilter[]
  index: number
  /** Правка значения: `next`/`prev` меняют число, а не двигают курсор. */
  editing: boolean
  /**
   * Режим поиска черновика — четвёртый рынок в списке трейда, а не настройка.
   * Инстант-баяут и сделка из рук в руки дают на одном предмете цены, разные
   * в разы, поэтому режим правится там же, где фильтры, и применяется тем же
   * подтверждением.
   */
  mode: SearchMode
  /** Режим, которым получена цена, что сейчас на панели. */
  appliedMode: SearchMode
}

/** Новый редактор под предмет. На каждый предмет свой — черновик не переезжает. */
export function newEditor (item: PricedItem, mode: SearchMode = DEFAULT_SEARCH_MODE): Editor {
  const rows = defaultFilters(item)
  return {
    open: false,
    draft: rows,
    applied: copyFilters(rows),
    auto: copyFilters(rows),
    index: 0,
    editing: false,
    mode,
    appliedMode: mode
  }
}

/** Слоты курсора по черновику: у диапазона четыре, у флага и варианта один. */
export function slots (draft: ModFilter[]): Slot[] {
  const out: Slot[] = []
  draft.forEach((row, index) => {
    if (!row.id) return // недоступный мод показывается, но крутить в нём нечего
    out.push({ kind: 'enabled', row: index })
    if (row.kind === 'range') {
      out.push({ kind: 'min', row: index }, { kind: 'max', row: index }, { kind: 'exact', row: index })
    }
  })
  out.push({ kind: 'mode' }, { kind: 'confirm' }, { kind: 'cancel' })
  return out
}

export function slotAt (editor: Editor): Slot {
  const all = slots(editor.draft)
  return all[Math.min(editor.index, all.length - 1)]!
}

/** Черновик расходится с применённым набором — цена на панели относится к прежнему. */
export function isDirty (editor: Editor): boolean {
  return editor.mode !== editor.appliedMode ||
    filterSignature(editor.draft) !== filterSignature(editor.applied)
}

/**
 * Первая беда черновика и строка, в которой она живёт. Есть — подтверждение
 * поиск не запускает. Причина и мод возвращаются порознь: на панели шириной в
 * 460 px они не помещаются одной строкой, а мод и так виден в списке.
 */
export function draftProblem (draft: ModFilter[]): { reason: string, row: ModFilter } | undefined {
  for (const row of draft) {
    if (!row.enabled || !row.id) continue
    const reason = filterProblem(row)
    if (reason) return { reason, row }
  }
  return undefined
}

/**
 * Обе границы стоят ровно на роле предмета. Цена многих вещей зависит от
 * точного числа, а не от «не меньше»: у Mageblood три фласки стоят 110 div,
 * две — 30 (прогон #148, тестер).
 */
export function isExact (row: ModFilter): boolean {
  return row.roll != null && row.min === row.roll && row.max === row.roll
}

/** Шаг правки границы. Дробный ролл правится десятыми, целый — единицами. */
function step (row: ModFilter): number {
  return row.roll != null && !Number.isInteger(row.roll) ? 0.1 : 1
}

/** Значение, с которого начинается правка пустой границы. */
function seed (row: ModFilter, field: 'min' | 'max'): number {
  const roll = row.roll ?? 0
  return field === 'min' ? minRoll(roll) : roll
}

/** Сложение без плавающего мусора: 20.8 − 0.1 должно быть 20.7, а не 20.699999. */
function shift (value: number, by: number): number {
  return Number((value + by).toFixed(2))
}

function bump (editor: Editor, by: number): Editor {
  const slot = slotAt(editor)
  if (slot.kind !== 'min' && slot.kind !== 'max') return editor

  const draft = copyFilters(editor.draft)
  const row = draft[slot.row]!
  const current = row[slot.kind]
  row[slot.kind] = current == null ? seed(row, slot.kind) : shift(current, by * step(row))
  return { ...editor, draft }
}

function moveBy (editor: Editor, by: number): Editor {
  const total = slots(editor.draft).length
  return { ...editor, index: (editor.index + by + total) % total }
}

function apply (editor: Editor): Editor {
  return { ...editor, applied: copyFilters(editor.draft), appliedMode: editor.mode, editing: false }
}

/**
 * Одно действие игрока → новое состояние и, если он подтвердил, снимок фильтров
 * для ровно одного поиска. `search: null` значит «запроса нет» — правка
 * черновика и навигация лимит trade API не расходуют. Отмена после
 * подтверждения ищет автонабор заново, но это тело уже лежит в кэше цены.
 *
 * Некорректный черновик (min больше max) поиск не запускает: снаружи это видно
 * через `draftProblem`, и человек читает причину с панели, а не догадывается.
 */
export function reduce (
  editor: Editor,
  action: EditorAction
): { editor: Editor, search: EditorSearch | null } {
  const none = (next: Editor) => ({ editor: next, search: null })

  switch (action) {
    case 'open':
      return none({ ...editor, open: true, editing: false })
    // Скрытие черновик не трогает: игрок убрал панель, а не отказался от правок.
    case 'close':
      return none({ ...editor, open: false, editing: false })

    case 'next':
      return none(editor.editing ? bump(editor, +1) : moveBy(editor, +1))
    case 'prev':
      return none(editor.editing ? bump(editor, -1) : moveBy(editor, -1))

    case 'act': {
      const slot = slotAt(editor)
      if (slot.kind === 'confirm') return reduce({ ...editor, editing: false }, 'confirm')
      if (slot.kind === 'cancel') return reduce({ ...editor, editing: false }, 'cancel')
      // Режим перебирается по кругу одним действием: выпадающий список на 7"
      // тачскрине попасть нечем, а режимов всего пять.
      if (slot.kind === 'mode') return none({ ...editor, mode: nextSearchMode(editor.mode), editing: false })

      // Точное значение — одно действие, а не правка двух границ: на #148 это
      // стоило восьми тапов. Повтор снимает его обратно к умолчанию `N+`.
      if (slot.kind === 'exact') {
        const draft = copyFilters(editor.draft)
        const row = draft[slot.row]!
        const roll = row.roll ?? 0
        if (row.enabled && isExact(row)) {
          row.min = minRoll(roll)
          delete row.max
        } else {
          row.enabled = true
          row.min = roll
          row.max = roll
        }
        return none({ ...editor, draft, editing: false })
      }

      if (slot.kind === 'enabled') {
        const draft = copyFilters(editor.draft)
        const row = draft[slot.row]!
        row.enabled = !row.enabled
        // Включённому диапазону нужна точка отсчёта, иначе фильтр значит просто
        // «такой мод есть». Умолчание то же, что у автоматического набора.
        if (row.enabled && row.kind === 'range' && row.min == null && row.max == null) {
          row.min = minRoll(row.roll ?? 0)
        }
        return none({ ...editor, draft })
      }

      // Границу правим в отдельном режиме: те же две кнопки иначе не смогли бы
      // и ходить по списку, и менять число.
      if (!editor.editing) {
        const draft = copyFilters(editor.draft)
        const row = draft[slot.row]!
        if (row[slot.kind] == null) row[slot.kind] = seed(row, slot.kind)
        return none({ ...editor, draft, editing: true })
      }
      return none({ ...editor, editing: false })
    }

    case 'clear': {
      const slot = slotAt(editor)
      if (slot.kind !== 'min' && slot.kind !== 'max') return none(editor)
      const draft = copyFilters(editor.draft)
      delete draft[slot.row]![slot.kind]
      return none({ ...editor, draft, editing: false })
    }

    case 'confirm': {
      if (draftProblem(editor.draft)) return none({ ...editor, editing: false })
      const next = apply(editor)
      return { editor: next, search: { stats: toStatFilters(next.applied), mode: next.appliedMode } }
    }

    case 'cancel': {
      // Черновик — к автонабору, рынок — к применённому: рынок игрок выбирает
      // для всех предметов, а не для этого (он и переезжает на следующий).
      const next: Editor = {
        ...editor,
        draft: copyFilters(editor.auto),
        mode: editor.appliedMode,
        editing: false
      }
      // Цена на панели уже по автонабору — искать незачем, это просто откат правок.
      if (filterSignature(editor.applied) === filterSignature(editor.auto)) return none(next)
      // Иначе на панели цена по набору игрока, и после отмены она врала бы.
      // Поиск уходит как автоматический (`stats` нет): тело то же, что у первого
      // нажатия, и при том же рынке цена приходит из кэша, без запроса к трейду.
      return { editor: { ...next, applied: copyFilters(editor.auto) }, search: { mode: editor.appliedMode } }
    }
  }
}
