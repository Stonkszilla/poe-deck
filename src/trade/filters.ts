// Моды предмета как список фильтров, которым можно управлять.
//
// До этого файла состав запроса был функцией предмета: `statFilters`
// решала за игрока, какие моды поедут в поиск, и исправить её выбор было нечем.
// На Impresence это давало два фильтра, шесть модов вне запроса и одно
// объявление за 40 chaos — цену базы, выданную за цену конкретного предмета.
//
// Здесь тот же выбор становится **начальной настройкой**: каждый распознанный
// мод виден строкой, у строки есть фактический ролл, состояние участия в поиске
// и границы min/max. Автоматические умолчания не меняются (см. `defaultEnabled`),
// поэтому запрос без правок игрока остаётся тем же, что и до этого файла —
// `statFilters` теперь выражается через эти умолчания, а не отдельным правилом.
//
// Правила умолчаний взяты у донора идеей, кодом ничего не заимствовано:
// SnosMe/awakened-poe-trade (MIT), `create-stat-filters.ts:98-103`, `percentRoll`.

import { isMapItem, type PricedItem, type StatEntryFilter } from './query'

/** Минус сколько процентов от ролла ставится в min фильтра. Умолчание донора. */
export const SEARCH_RANGE_PERCENT = 10

/**
 * Чем мод редактируется. Флагу и варианту числовой диапазон придумывать нельзя:
 * на трейде у первого нет значения вовсе, у второго это выбор, а не интервал.
 */
export type ModKind = 'range' | 'flag' | 'option'

export interface ModFilter {
  /** id фильтра на трейде. Нет — искать по этому моду нечем. */
  id?: string
  /**
   * Тот же мод под остальными типами трейда. Буфер называет один тип, индекс
   * трейда может держать мод под другим — см. `tradeIds` ниже.
   */
  altIds?: string[]
  /** Почему мод недоступен для поиска. Есть ровно тогда, когда нет `id`. */
  unavailable?: string
  /** Текст мода с подставленным фактическим роллом — то, что читает игрок. */
  label: string
  /** ModifierType донора: explicit | implicit | enchant | fractured | crafted | … */
  type: string
  tier?: number
  kind: ModKind
  /** Фактический ролл на предмете. У флага его нет. */
  roll?: number
  /** Вариант мода для `kind: 'option'` — на трейде это выбор, не интервал. */
  option?: number
  enabled: boolean
  min?: number
  max?: number
}

/**
 * Фиксированные свойства защиты — броня, уклонение, щит, вард, блок.
 *
 * Донор держит их отдельным слоем: это не моды, а свойства предмета, и на
 * трейде они живут не в `stats`, а в `query.filters.armour_filters`
 * (`pathofexile-trade.ts:452-473`). Внутри себя донор называет их псевдо-статами
 * `item.armour`, `item.evasion_rating`, … — то же имя берём и мы, чтобы строка
 * редактора и поле запроса назывались одинаково.
 *
 * Зачем они в редакторе: у брони с хорошей базой цена определяется числом ES или
 * брони, а не модами, и без этих строк искать по ним было нечем (претензия
 * тестера после прогона #107 — «фикс статы шмоток, по ним тоже возможен поиск»).
 */
const PROPERTIES: Array<{ id: string, label: string, of: (item: PricedItem) => number | undefined }> = [
  { id: 'item.armour', label: 'Armour', of: item => item.armourAR },
  { id: 'item.evasion_rating', label: 'Evasion Rating', of: item => item.armourEV },
  { id: 'item.energy_shield', label: 'Energy Shield', of: item => item.armourES },
  { id: 'item.ward', label: 'Ward', of: item => item.armourWARD },
  { id: 'item.block', label: 'Chance to Block', of: item => item.armourBLOCK }
]

/** Сколько процентов качества трейд подставляет в физ. урон оружия. */
const DPS_QUALITY = 20

/**
 * Физический урон за удар, приведённый к качеству 20%. Трейд считает `pdps`
 * именно так: замер 09.11 на Vaal Axe с качеством 3% — `226-373` при 1.30 атаки
 * в секунду дают 389 по буферу и 453.7 в `extended.pdps` трейда, ровно ×120/103.
 * Без поправки граница фильтра на предмете ниже 20% качества стояла бы ниже, чем
 * трейд считает этот же предмет, и ловила бы оружие слабее.
 *
 * Качество и локальное «increased Physical Damage» складываются в один множитель,
 * поэтому их сумма и делит, и умножает. Идея — `propAt20Quality` донора
 * (`parser/calc-q20.ts:47-65`), код свой.
 */
export function physicalAtQ20 (item: PricedItem): number | undefined {
  if (item.weaponPHYSICAL == null) return undefined
  const quality = item.quality ?? 0
  if (quality >= DPS_QUALITY) return item.weaponPHYSICAL

  const increased = item.statsByType
    .filter(calc => calc.stat.ref === '#% increased Physical Damage')
    .reduce((sum, calc) => sum + (rollValue(calc.sources) ?? 0), 0)
  return item.weaponPHYSICAL * (100 + increased + DPS_QUALITY) / (100 + increased + quality)
}

/** До десятых: так dps показывает и трейд. */
function dpsValue (value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Средний хаос-урон за удар из строки буфера `Chaos Damage: 98-120`. Парсер донора
 * эту строку не разбирает (`Parser.ts`, `parseWeapon`), а трейд хаос в `dps`
 * считает. Замер 09.11, Rebuke of the Vaal: `pdps 304.41 + edps 391.28` и хаос
 * 91-140 при 1.46 атаки в секунду дают ровно `dps 864.32` трейда.
 */
export function chaosPerHit (item: PricedItem): number | undefined {
  const match = /^Chaos Damage: (\d+)-(\d+)/m.exec(item.rawText ?? '')
  if (!match) return undefined
  return (Number(match[1]) + Number(match[2])) / 2
}

/**
 * Строки dps оружия. Порядок и условия — как у донора (`item-property.ts:145-210`):
 * `Total DPS` только у оружия с двумя видами урона и больше, иначе он равен
 * единственному из них и дублирует строку. Стихийный урон к качеству не
 * приводится — трейд его тоже не приводит (`edps` в том же замере равен буферу).
 *
 * От донора отличается хаосом: у донора `Total DPS` — физ. и стихии, у трейда
 * `dps` — ещё и хаос. Отдельного фильтра хаоса на трейде нет, поэтому хаос
 * входит только в `Total DPS`.
 */
function weaponFilters (item: PricedItem): Array<{ id: string, label: string, value: number }> {
  if (!item.weaponAS) return []
  const pdps = physicalAtQ20(item)
  const edps = item.weaponELEMENTAL
  const cdps = chaosPerHit(item)
  const kinds = [pdps, edps, cdps].filter(value => value != null)
  const rows: Array<{ id: string, label: string, value: number }> = []

  if (kinds.length > 1) {
    const total = kinds.reduce((sum, value) => sum + value, 0)
    rows.push({ id: 'item.total_dps', label: 'Total DPS', value: dpsValue(total * item.weaponAS) })
  }
  if (pdps != null) rows.push({ id: 'item.physical_dps', label: 'Physical DPS (Q20)', value: dpsValue(pdps * item.weaponAS) })
  if (edps != null) rows.push({ id: 'item.elemental_dps', label: 'Elemental DPS', value: dpsValue(edps * item.weaponAS) })
  return rows
}

/**
 * Категории, у которых уровень предмета цену не определяет или значит другое.
 * Список — донора (`create-item-filters.ts:347-358`): у карты это тир, у
 * обычного джуела набор аффиксов от уровня не зависит, у чертежей, карт атласа
 * и реликвий свой уровень зоны.
 */
const NO_ILVL = new Set([
  'Map', 'Jewel', 'Heist Blueprint', 'Heist Contract', 'Chart', 'Memory Line',
  'Sanctum Relic', 'Charm', 'Idol'
])

/** Склянки: уровень есть, но цену он почти не двигает — строка видна, но выключена. */
const ILVL_OFF = new Set(['Flask', 'Tincture'])

/** Выше 86 уровень новых модов не открывает: 86 и 100 — один рынок (правило донора). */
const ILVL_CAP = 86

/**
 * Уровень предмета строкой `properties` → `misc_filters.ilvl` трейда (тестер:
 * «ilvl у шмоток — важный аспект»). Нет у уникалов (их уровень цену
 * не меняет, донор его тоже не ставит) и у категорий из `NO_ILVL`.
 *
 * Включён ли — решает `defaultFilters` по остальному набору, а не эта функция:
 * у донора строка включается в режиме поиска базы (`opts.exact`), у нас это
 * тот же случай — ни один мод не вошёл в фильтр, и цена идёт по базе. Тогда
 * ilvl 86 и ilvl 70 — разные базы и разные деньги. Когда в фильтре моды, они
 * уже говорят о предмете больше, чем уровень.
 */
function itemLevelFilter (item: PricedItem): ModFilter | undefined {
  if (!item.itemLevel || item.rarity === 'Unique') return undefined
  if (isMapItem(item) || (item.category && NO_ILVL.has(item.category))) return undefined
  // Вне экипировки (валюта, карты гадания, камни) уровня в буфере нет вовсе —
  // туда эта строка не доходит по первой проверке.

  const cluster = item.category === 'Cluster Jewel'
  const value = cluster ? floorToBracket(item.itemLevel, [1, 50, 68, 75, 84]) : Math.min(item.itemLevel, ILVL_CAP)
  return {
    id: 'item.ilvl',
    label: `Item Level ${item.itemLevel}`,
    type: 'property',
    kind: 'range',
    roll: value,
    // Граница — сам уровень, а не ролл минус 10%, как у мода: «ilvl от 66» у
    // предмета 74 — чужой рынок. Редактор ставит `minRoll` только пустой строке,
    // поэтому граница задаётся здесь, и включённая на Deck строка уходит как есть.
    min: value,
    enabled: false,
    // Кластер-джуел: число пассивов зависит от вилки уровня, и верхняя граница
    // вилки — такая же часть описания, как нижняя (донор: `ceilToBracket`).
    ...(cluster ? { max: ceilToBracket(item.itemLevel, [100, 74, 67, 49]) } : {})
  }
}

/** Наибольшая ступень, не превышающая значение. */
function floorToBracket (value: number, brackets: number[]): number {
  return brackets.filter(step => step <= value).at(-1) ?? brackets[0]!
}

/** Наименьшая ступень (по убыванию списка), не меньшая значения. */
function ceilToBracket (value: number, brackets: number[]): number {
  return brackets.filter(step => step >= value).at(-1) ?? brackets[0]!
}

/**
 * Строки свойств предмета: защита у брони и щитов, dps у оружия. У остального
 * список пустой. Все выключены: включённое свойство меняет смысл запроса, и это
 * решение игрока.
 */
function propertyFilters (item: PricedItem): ModFilter[] {
  const weapon = weaponFilters(item).map(row => ({
    id: row.id,
    label: `${row.label} ${rollText(row.value)}`,
    type: 'property',
    kind: 'range' as ModKind,
    roll: row.value,
    enabled: false
  }))

  return [...weapon, ...PROPERTIES.flatMap(prop => {
    const value = prop.of(item)
    if (value == null) return []
    return [{
      id: prop.id,
      label: `${prop.label} ${rollText(value)}`,
      type: 'property',
      kind: 'range' as ModKind,
      roll: value,
      enabled: false
    }]
  })]
}

/**
 * Порядок групп в редакторе. Свойства сверху — они про сам предмет; дальше то,
 * что игрок читает в описании в том же порядке, в каком PoE это печатает.
 * Группировка визуальная, на запрос не влияет: панель рисует заголовок там, где
 * тип сменился, и для этого список должен быть отсортирован здесь, а не в ней.
 */
const GROUP_ORDER = ['property', 'enchant', 'implicit', 'fractured', 'explicit', 'crafted']

/** Подписи групп в редакторе. Тип, которого здесь нет, называется как есть. */
const GROUP_LABEL: Record<string, string | undefined> = {
  property: 'properties',
  enchant: 'enchant',
  implicit: 'implicit',
  fractured: 'fractured',
  explicit: 'explicit',
  crafted: 'crafted'
}

export function groupLabel (type: string): string {
  return GROUP_LABEL[type] ?? type
}

export function groupRank (type: string): number {
  const at = GROUP_ORDER.indexOf(type)
  return at === -1 ? GROUP_ORDER.length : at
}

/** Суммарный ролл мода по всем источникам — `statSourcesTotal(sources, 'sum')` донора. */
export function rollValue (sources: PricedItem['statsByType'][number]['sources']): number | undefined {
  if (sources.every(source => !source.contributes)) return undefined
  return sources.reduce((sum, source) => sum + (source.contributes?.value ?? 1), 0)
}

/** Ролл минус 10%, вниз. Целые остаются целыми, дробные режутся до сотых. */
export function minRoll (value: number): number {
  const lowered = value - Math.abs(value) * SEARCH_RANGE_PERCENT / 100
  return Number.isInteger(value)
    ? Math.floor(lowered)
    : Math.floor((lowered + Number.EPSILON) * 100) / 100
}

/** Число для человека: целое остаётся целым, дробное режется до сотых. */
export function rollText (value: number): string {
  return String(Number(value.toFixed(2)))
}

/**
 * Мод с подставленным роллом. У донора в `stat.ref` стоят `#` — один на обычный
 * мод, два на «Adds # to # Physical Damage». Подставляем только когда место одно:
 * иначе сумма двух чисел, разложенная по двум местам, соврала бы дважды.
 */
export function modLabel (ref: string, roll?: number): string {
  if (roll === undefined) return ref
  const places = ref.split('#').length - 1
  return places === 1 ? ref.replace('#', rollText(roll)) : `${ref} — ${rollText(roll)}`
}

/**
 * Начальное участие мода в поиске. Здесь и только здесь живут умолчания донора:
 *
 *   1. из explicit в фильтр идут только верхние тиры (≤ 2) — иначе шесть модов
 *      редкого предмета сойдутся ровно в один листинг, его же;
 *   2. остальные типы (implicit, enchant, fractured, crafted) идут целиком;
 *   3. **у уникала не включается ничего.**
 *
 * Правило 3 стоило двух прогонов. У уникала предмет однозначно опознаётся
 * именем, а его врождённые моды на трейде индексируются НЕ ТЕМ типом, каким их
 * называет буфер: мод, который в описании предмета идёт имплицитом, на трейде
 * живёт как explicit, и `implicit.stat_…` не находит ничего. На прогоне #104
 * так молча пустели и Ambu's Charge, и Soul Mantle — оба «с модами (1 в
 * фильтре)» и оба «ни одного объявления», при исправной лиге и живом трейде.
 *
 * Донор приходит к тому же с другой стороны: `hideNotVariableStat` у уникала
 * скрывает и выключает фильтр без диапазона ролла — а врождённые моды уникала
 * как раз константные (`create-stat-filters.ts:371-385`).
 *
 * Выключены — не значит потеряны: в редакторе они все на месте, и игрок
 * включает их сам, когда цена по имени его не устраивает.
 */
function defaultEnabled (type: string, tier: number | undefined, unique: boolean, map: boolean): boolean {
  // Моды карты — это модификаторы зоны («Monsters deal 102% extra Physical
  // Damage as Cold»), и искать по ним бессмысленно: карта стоит тиром и, изредка,
  // парой ключевых модов, которые игрок выберет сам. Прогон #115: девять
  // включённых модов давали ноль на каждой карте.
  if (map) return false
  if (unique) return false
  if (type !== 'explicit') return true
  return tier != null && tier <= 2
}

/**
 * Все id мода на трейде: свой тип первым, остальные — запасными.
 *
 * Донор шлёт в запрос весь массив id СВОЕГО типа (`everyTradeIdToQuery`,
 * `pathofexile-trade.ts:902-905`), и это правило мы повторяем. Чужие типы едут
 * только тогда, когда своего нет вовсе: замер на живом трейде (15.09) показал,
 * что id своего типа верен — `implicit.stat_825352061` у Ambu's Charge находит
 * 125 объявлений при `status: any`. Ноль в прогоне #109 давал не тип, а
 * `status: online`: продавцы этого предмета офлайн, и лечится это ветвлением
 * запроса, а не расширением фильтра.
 *
 * Почему не «все типы всегда», как было после #107: каждый мод с несколькими id
 * уезжает отдельной группой `count`, и на пяти включённых модах GGG отвечает
 * «Query is too complex. Please reduce the amount of filters used» (прогон #109,
 * Snowblind Grace).
 *
 * `pseudo` в запасные не берём намеренно: это агрегат («суммарное сопротивление»),
 * и подставлять ему границу конкретного мода — врать о том, что ищем.
 */
function tradeIds (
  trade: PricedItem['statsByType'][number]['stat']['trade'],
  type: string
): { id?: string, alt: string[] } {
  const own = trade.ids[type] ?? []
  if (own.length) return { id: own[0], alt: own.slice(1) }

  const rest = Object.entries(trade.ids)
    .filter(([key]) => key !== 'pseudo')
    .flatMap(([, ids]) => ids ?? [])
  return { id: rest[0], alt: rest.slice(1) }
}

/** Минимальный (лучший) тир среди источников мода. */
function bestTier (sources: PricedItem['statsByType'][number]['sources']): number | undefined {
  const tiers = sources.map(s => s.modifier.info.tier).filter((t): t is number => t != null)
  return tiers.length ? Math.min(...tiers) : undefined
}

/**
 * Все распознанные моды предмета строками редактора — включая те, по которым
 * поиск невозможен: мод, пропавший молча, для игрока неотличим от мода, который
 * учтён. Пустой список — законное состояние, а не сбой: у валюты, карты и ключа
 * модов нет и не будет.
 */
export function defaultFilters (item: PricedItem): ModFilter[] {
  const unique = item.rarity === 'Unique'
  const map = isMapItem(item)

  const mods = item.statsByType.map(calc => {
    const { id, alt } = tradeIds(calc.stat.trade, calc.type)
    const roll = rollValue(calc.sources)
    const tier = bestTier(calc.sources)
    const kind: ModKind = calc.stat.trade.option ? 'option' : roll === undefined ? 'flag' : 'range'

    const row: ModFilter = {
      label: modLabel(calc.stat.ref, kind === 'option' ? undefined : roll),
      type: calc.type,
      tier,
      kind,
      roll,
      enabled: false
    }

    if (!id) {
      row.unavailable = 'no such filter on trade'
      return row
    }
    if (kind === 'option') {
      // Вариант отправляется числом. Не распознали его — отправлять нечего,
      // и делать вид, что мод учтён, нельзя.
      if (roll === undefined) {
        row.unavailable = 'mod variant not recognised'
        return row
      }
      row.option = roll
    }

    row.id = id
    if (alt.length) row.altIds = alt
    row.enabled = defaultEnabled(calc.type, tier, unique, map)
    if (kind === 'range' && row.enabled) row.min = minRoll(roll!)
    return row
  })

  // Сортировка стабильная: внутри группы порядок остаётся тем, в каком моды
  // стоят на предмете, — игрок сверяет список с описанием в игре построчно.
  // Уровень предмета включается, когда цена идёт по базе: ни один мод не вошёл
  // в фильтр. Склянки — исключение донора: строка есть, но выключена.
  const ilvl = itemLevelFilter(item)
  if (ilvl && !mods.some(row => row.enabled) && !ILVL_OFF.has(item.category ?? '')) {
    ilvl.enabled = true
  }

  return [...(ilvl ? [ilvl] : []), ...propertyFilters(item), ...mods]
    .map((row, at) => ({ row, at }))
    .sort((a, b) => groupRank(a.row.type) - groupRank(b.row.type) || a.at - b.at)
    .map(entry => entry.row)
}

/**
 * Что не так со строкой. Пустой ответ — строку можно отправлять.
 *
 * Границы проверяются здесь, а не в построении запроса: игрок правит их по
 * одной, и min > max — нормальное промежуточное состояние черновика. Запретить
 * надо не ввод, а отправку такого фильтра в поиск.
 */
export function filterProblem (row: ModFilter): string | undefined {
  if (row.unavailable) return row.unavailable
  if (row.min != null && row.max != null && row.min > row.max) return 'min above max'
  return undefined
}

/**
 * Строки → фильтры запроса. Выключенный мод в запросе отсутствует, включённый
 * доступный — не теряется. Границы едут обе; заданная только одна — тоже
 * законный фильтр, как и включённый мод вообще без границ («такой мод есть»).
 */
export function toStatFilters (rows: ModFilter[]): StatEntryFilter[] {
  const out: StatEntryFilter[] = []

  for (const row of rows) {
    if (!row.enabled || !row.id || filterProblem(row)) continue

    const alt = row.altIds?.length ? { alt: row.altIds } : {}

    if (row.kind === 'option') {
      out.push({ id: row.id, value: { option: row.option }, ...alt })
      continue
    }
    if (row.kind === 'flag' || (row.min == null && row.max == null)) {
      out.push({ id: row.id, ...alt })
      continue
    }

    const value: NonNullable<StatEntryFilter['value']> = {}
    if (row.min != null) value.min = row.min
    if (row.max != null) value.max = row.max
    out.push({ id: row.id, value, ...alt })
  }

  return out
}

/** Снимок набора для сравнения: цена относится к тому, что уехало в запрос. */
export function filterSignature (rows: ModFilter[]): string {
  return JSON.stringify(toStatFilters(rows))
}

/** Копия строк. Черновик и применённый набор не должны делить объекты. */
export function copyFilters (rows: ModFilter[]): ModFilter[] {
  return rows.map(row => ({ ...row }))
}
