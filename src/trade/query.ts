// От разобранного предмета к запросу. Здесь живёт развилка эпика.
//
// Заимствованного кода нет — только правила, взятые у донора идеей и названные
// вслух. Донор: SnosMe/awakened-poe-trade (MIT), см. licenses/.
//
// ── Развилка ────────────────────────────────────────────────────────────────
//
// У донора она называется `apiToSatisfySearch` (trade/common.ts:25-31) и звучит
// так: есть включённые стат-фильтры → поиск по статам; нет → обмен, если у
// предмета есть тег обмена. Мы берём её дословно, потому что в ней и записан
// инвариант эпика: **отсутствие модов — не сбой, а вход в другую ветку**.
// Валюта, ключ, карта, неопознанный предмет — у всех модов нет и не будет,
// и цена у всех есть.
//
// Разные ветки — это ещё и разные группы лимитов у GGG:
//   поиск  → POST /api/trade/search + GET /api/trade/fetch   (SEARCH + FETCH)
//   обмен  → POST /api/trade/exchange                        (EXCHANGE)
// Поэтому развилка выбирается ДО запроса, а не по факту пустого ответа.
//
// ── Кто выбирает моды ───────────────────────────────────────────────────────
//
// Умолчания донора (explicit тира ≤ 2, остальные типы целиком, порог ролла
// минус 10%) живут в `./filters.ts` вместе с остальным списком модов: с редактором фильтров
// их правит игрок, и второго правила в этом файле быть не должно. `statFilters`
// ниже — те же умолчания, применённые без него.
//
// Не перенесено от донора: псевдо-статы (суммарные сопротивления и т.п.),
// карта категорий в trade-id. Всё это уточняет запрос, а не делает его возможным.
// Свойства защиты и dps оружия перенесены — строками группы `properties`.

import { defaultFilters, toStatFilters } from './filters'

/** Карта ли это. Категория донора — `ItemCategory.Map` = `'Map'` (`parser/meta.ts:2`). */
export function isMapItem (item: Pick<PricedItem, 'category' | 'mapTier'>): boolean {
  return item.category === 'Map' || item.mapTier != null
}

/** Кусок `ParsedItem` донора, которым пользуется построение запроса. */
export interface PricedItem {
  rarity?: string
  itemLevel?: number
  isCorrupted?: boolean
  isUnidentified?: boolean
  info: {
    name?: string
    refName: string
    /** Тег обмена. Есть у валюты и осколков — по нему и уходим в ветку курса. */
    tradeTag?: string
  }
  uniqueBase?: { refName: string }
  /** Категория донора: `Map`, `Jewel`, `Flask`, … Нужна там, где форма запроса иная. */
  category?: string
  /** Тир карты. Есть только у карт, и на трейде это отдельный фильтр. */
  mapTier?: number
  /** Стак из подсказки предмета: «Stack Size: 20/5000». Есть у валюты и осколков. */
  stackSize?: { value: number, max: number }
  /** Свойства защиты — броня, уклонение, щит, вард, блок. Поля парсера донора. */
  armourAR?: number
  armourEV?: number
  armourES?: number
  armourWARD?: number
  armourBLOCK?: number
  /** Свойства оружия из буфера: атак в секунду, средний физ. и стихийный урон за удар. */
  weaponAS?: number
  weaponPHYSICAL?: number
  weaponELEMENTAL?: number
  /** Качество, %. Нужно, чтобы привести физ. урон к Q20, как считает трейд. */
  quality?: number
  /** Буфер целиком, как его отдала игра. Из него берётся то, чего парсер донора не разбирает. */
  rawText?: string
  statsByType: Array<{
    stat: {
      ref: string
      trade: { ids: Record<string, string[] | undefined>, option?: true }
    }
    /** ModifierType донора: explicit | implicit | enchant | fractured | crafted | … */
    type: string
    sources: Array<{
      modifier: { info: { tier?: number } }
      contributes?: { value: number, min: number, max: number }
    }>
  }>
}

/**
 * Режим поиска — тот самый выпадающий список из четырёх пунктов на сайте трейда.
 * Замер 15.09 на Ambu's Charge в лиге Allflame показывает, насколько это разные
 * рынки, а не оттенки одного:
 *
 * | режим          | что значит                                   | объявлений |
 * |----------------|----------------------------------------------|------------|
 * | `securable`    | Instant Buyout: покупка через стеш, продавец не нужен | 2855 |
 * | `available`    | Instant Buyout и In Person (Online) вместе    | —          |
 * | `online`       | In Person (Online): сделка из рук в руки      | 66         |
 * | `onlineleague` | то же, но только в этой лиге                 | 65         |
 * | `any`          | всё подряд, включая офлайн                   | 5118       |
 *
 * Значение по умолчанию — `securable`: цена, которую можно получить прямо
 * сейчас, не дожидаясь, пока продавец ответит в игре. На том же предмете
 * `online` давал медиану 10 chaos, а инстант-баяут — 1 chaos при 2855 лотах;
 * второе и есть рынок, первое — ценники тех, кто не продаёт.
 *
 * `available` — донорский дефолт вне merchant-режима: оба рынка, где сделку
 * можно закрыть сейчас. Замер 04.10 (Headhunter, Allflame): 1977 = 1974
 * instant + 3 in person. Bulk-обмен его тоже принимает. Стоит вторым в круге,
 * сразу за умолчанием — это ближайший к нему более широкий рынок.
 */
export const SEARCH_MODES = ['securable', 'available', 'online', 'onlineleague', 'any'] as const
export type SearchMode = typeof SEARCH_MODES[number]
export const DEFAULT_SEARCH_MODE: SearchMode = 'securable'

/** Как режим называется на панели. Никаких кодов API перед глазами игрока. */
export const MODE_LABEL: Record<SearchMode, string> = {
  securable: 'instant buyout',
  available: 'buyout or in person',
  online: 'in person (online)',
  onlineleague: 'in person (league)',
  any: 'any, incl. offline'
}

/** Режим из строки — для переменной окружения. Мусор молча не проглатывается. */
export function parseSearchMode (value: string | undefined): SearchMode | undefined {
  if (!value) return undefined
  const found = SEARCH_MODES.find(mode => mode === value)
  if (!found) throw new Error(`unknown search mode "${value}", expected: ${SEARCH_MODES.join(', ')}`)
  return found
}

/** Следующий режим по кругу — одно действие в редакторе, без списка и меню. */
export function nextSearchMode (mode: SearchMode): SearchMode {
  return SEARCH_MODES[(SEARCH_MODES.indexOf(mode) + 1) % SEARCH_MODES.length]!
}

export interface StatEntryFilter {
  id: string
  /** Обе границы — необязательные и независимые: игрок задаёт любую из них. */
  value?: { min?: number, max?: number, option?: number }
  /**
   * Тот же мод под другими типами трейда. У справочника донора один мод часто
   * имеет id и в `explicit`, и в `implicit`, и во `fractured` — например
   * «Trigger Level 20 Death Aura when Equipped» у Ambu's Charge. Буфер говорит
   * ОДИН тип, индекс трейда может держать его под другим, и фильтр по «своему»
   * id не находит ничего (прогон #107: уникал с ценой 5 chaos по имени и ноль
   * по включённому моду). Поэтому такой мод уходит группой «любой из этих id».
   */
  alt?: string[]
}

/** Группа стат-фильтров запроса. `count` с `min: 1` — «любой из перечисленных». */
export interface StatGroup {
  type: 'and' | 'count'
  filters: Array<{ id: string, value?: StatEntryFilter['value'] }>
  value?: { min: number }
}

export interface SearchBody {
  query: {
    status: { option: SearchMode }
    name?: string
    /** База. У карт это `{ option: 'Map', discriminator: 'map' }` — см. ниже. */
    type?: string | { option: string, discriminator: string }
    stats: StatGroup[]
    filters: {
      type_filters?: { filters: { rarity?: { option: string } } }
      map_filters?: {
        filters: {
          map_tier?: { min: number, max: number }
          map_blighted?: { option: string }
          map_uberblighted?: { option: string }
          map_series?: { option: string }
        }
      }
      trade_filters?: { filters: { price?: { option: string }, collapse?: { option: string } } }
      misc_filters?: {
        filters: {
          corrupted?: { option: string }
          identified?: { option: string }
          ilvl?: { min?: number, max?: number }
        }
      }
      armour_filters?: { filters: Record<string, { min?: number, max?: number }> }
      weapon_filters?: { filters: Record<string, { min?: number, max?: number }> }
    }
  }
  sort: { price: 'asc' }
}

export interface ExchangeBody {
  engine: 'new'
  query: {
    status: { option: SearchMode }
    have: string[]
    want: string[]
  }
  sort: { have: 'asc' }
}

/**
 * Моды предмета, уходящие в фильтр поиска по умолчанию — то есть до того, как
 * игрок что-то поправил в редакторе. Пустой массив — законный ответ, а не
 * признак того, что что-то не удалось: у валюты, карты, ключа и неопознанного
 * предмета модов нет вовсе.
 */
export function statFilters (item: PricedItem): StatEntryFilter[] {
  return toStatFilters(defaultFilters(item))
}

/**
 * Сколько explicit-модов осталось за бортом фильтра по умолчанию. Не диагностика
 * ради диагностики: если у редкого предмета все моды ниже тира 2, запрос уходит
 * по одной базе, и найденная цена — это цена базы, а не этого предмета.
 * Молчать об этом нельзя, число уезжает в строку результата.
 *
 * С редактором фильтров у числа появился второй смысл: столько строк редактора игрок может
 * включить руками. Строки видны все, включая недоступные, — `defaultFilters`.
 */
export function skippedExplicits (item: PricedItem): number {
  return defaultFilters(item).filter(row => row.type === 'explicit' && row.id && !row.enabled).length
}

/**
 * Какой веткой идти за ценой. Правило донора: моды решают, тег обмена —
 * запасной путь, поиск по имени и базе — общий знаменатель.
 *
 * `stats` — набор, выбранный игроком. Он влияет на развилку только в одну
 * сторону: включённый мод уводит в поиск. Обратного нет намеренно — выключив
 * все фильтры у редкого предмета, игрок просит цену базы, а не курс обмена.
 */
export function pickFork (item: PricedItem, stats?: StatEntryFilter[]): 'search' | 'exchange' {
  if ((stats ?? []).length || statFilters(item).length) return 'search'
  return item.info.tradeTag ? 'exchange' : 'search'
}

/**
 * Поиск по статам, он же поиск по имени и базе, когда статов нет.
 * `type` — база предмета; у валюты, карт и дивинационных карт база и есть имя,
 * поэтому одна и та же строка работает для всех форм (у донора — `baseType`,
 * `create-item-filters.ts:98-104`).
 *
 * `opts.stats` — набор, выбранный игроком в редакторе. Не задан — едут умолчания.
 * Пустой массив тоже набор: «искать по имени и базе, без стат-фильтров».
 */
export function buildSearchQuery (
  item: PricedItem,
  opts: { status?: SearchMode, stats?: StatEntryFilter[] } = {}
): SearchBody {
  const isUnique = item.rarity === 'Unique'

  // У трейда `type` — это БАЗА, и имени уникала там быть не может. Пока база
  // не распознана, поле не отправляется вовсе: правило донора — искать уникал
  // именем и базой только когда база известна (`create-item-filters.ts:214`),
  // иначе `name` и `type` совпали бы, и выдача была бы пустой всегда. Ровно на
  // этом молча терялся Ambu's Charge в прогоне #101: десятки объявлений на
  // трейде, ноль у нас.
  const base = isUnique ? item.uniqueBase?.refName : (visceraBase(item) ?? item.info.refName)
  const isMap = isMapItem(item)

  const chosen = opts.stats ?? statFilters(item)
  const body: SearchBody = {
    query: {
      status: { option: opts.status ?? DEFAULT_SEARCH_MODE },
      stats: statGroups(chosen.filter(stat => !PROPERTY_FIELD[stat.id])),
      filters: {}
    },
    sort: { price: 'asc' }
  }

  // Свойства защиты, dps оружия и уровень предмета — не статы: на трейде у них свои поля запроса.
  // Разделение делается здесь, потому что редактор показывает их одной таблицей
  // с модами, а разными их делает только адрес в запросе.
  const props: Record<PropertyGroup, Record<string, { min?: number, max?: number }>> = {
    armour_filters: {},
    weapon_filters: {},
    misc_filters: {}
  }
  for (const stat of chosen) {
    const address = PROPERTY_FIELD[stat.id]
    if (!address) continue
    const { min, max } = stat.value ?? {}
    if (min == null && max == null) continue
    props[address.group][address.field] = { ...(min != null ? { min } : {}), ...(max != null ? { max } : {}) }
  }
  for (const group of ['armour_filters', 'weapon_filters'] as const) {
    if (Object.keys(props[group]).length) body.query.filters[group] = { filters: props[group] }
  }

  // Карта на трейде — не «Bone Crypt Map», а `Map` с дискриминатором. Замер на
  // живом API (15.09, лига Allflame, T16):
  //
  //   type: { option: 'Map', discriminator: 'map' }  → 10000 объявлений
  //   type: 'Bone Crypt Map'                         → 0
  //   type: 'Map'                                    → 0
  //
  // Область карты трейд не индексирует вовсе: `name: 'Bone Crypt'` он отвергает
  // как «Unknown item name». Карта опознаётся тиром и модами, а не тем, где она
  // происходит. Прогон #115 слал `type: 'Map'` и получал ноль на каждой карте.
  //
  // Блайт-карта — та же `Map`, а не своя база. Буфер называет её
  // `Blighted Map (Tier 14)`, и парсер отдаёт базу `Blighted Map`, но трейд такой
  // базы не знает. Замер на живом API (09.11, лига Allflame, T14):
  //
  //   type: 'Blighted Map'                                  → 0
  //   type: { option: 'Blighted Map', discriminator: 'map' } → 4489 — все T14,
  //                                                            блайт не учтён
  //   type: { option: 'Map', … } + map_blighted: true       → 414
  //
  // До этой правки блайт-карта получала цену обычной карты того же тира.
  const blight = isMap ? mapBlight(item) : undefined
  if (isMap) body.query.type = { option: 'Map', discriminator: 'map' }
  else if (base) body.query.type = base
  if (isUnique && item.info.name) body.query.name = item.info.name

  body.query.filters.type_filters = {
    filters: { rarity: { option: isUnique ? 'unique' : 'nonunique' } }
  }

  // Тир — главное, чем карта отличается от карты: T16 и T3 с одинаковыми модами
  // это разные предметы и разные деньги (`map_filters`, донор — `pathofexile-trade.ts:382`).
  //
  // Блайт — второй признак, и он работает в обе стороны, как у донора
  // (`pathofexile-trade.ts:386-395`): обычная карта ищется с обоими флагами
  // `false`, иначе в выдачу подмешиваются блайт-карты того же тира (09.11,
  // Allflame, T3: 3825 без флагов, 3775 с ними).
  //
  // Серия — всегда `current`. Это не догадка о предмете: парсер пина знает
  // только нынешнюю запись `Map (Tier N)`, а карта старой серии (`Bone Crypt
  // Map`) не распознаётся вовсе. Во временной лиге фильтр ничего не меняет, а в
  // Standard без него в выдачу идут карты всех прошлых атласов: T3 — 10000
  // объявлений без серии и 479 с `current` (замер 09.11). Донор этот фильтр не
  // ставит; правило наше.
  if (isMap) {
    const map: NonNullable<SearchBody['query']['filters']['map_filters']>['filters'] = {}
    if (item.mapTier != null) map.map_tier = { min: item.mapTier, max: item.mapTier }
    map.map_blighted = { option: String(blight === 'blighted') }
    map.map_uberblighted = { option: String(blight === 'ravaged') }
    map.map_series = { option: 'current' }
    body.query.filters.map_filters = { filters: map }
  }

  // Цены только в хаосах и дивайнах, и лоты одного аккаунта схлопнуты. Оба
  // правила донорские (`pathofexile-trade.ts:283-291`) и оба про одно: выдача,
  // смешавшая пять валют и десять лотов одного бота, медиану не считает.
  body.query.filters.trade_filters = {
    filters: { price: { option: 'chaos_divine' }, collapse: { option: 'true' } }
  }

  // Порча и опознанность меняют цену в разы, а у предмета в руке они известны
  // точно — значит это не догадка, а часть описания того, что мы держим.
  const misc: NonNullable<SearchBody['query']['filters']['misc_filters']>['filters'] = {}
  if (item.isCorrupted !== undefined) misc.corrupted = { option: String(item.isCorrupted) }
  if (item.isUnidentified) misc.identified = { option: 'false' }
  // Уровень предмета приезжает из редактора строкой `properties`, а живёт в той
  // же группе запроса, что порча и опознанность.
  if (props.misc_filters.ilvl) misc.ilvl = props.misc_filters.ilvl
  if (Object.keys(misc).length) body.query.filters.misc_filters = { filters: misc }

  return body
}

/**
 * База Viscera (лига Covens, 3.30) — из буфера, а не из парсера. Парсер донора
 * называет любую Viscera одним именем `Viscera` и различает их частью тела
 * (`Head Viscera`, `Upper Limb Viscera`). Трейд такой базы не знает, а свои
 * базы у него есть: «Scorched Arm», «Coven Queen's Crown». Замер на живом API
 * (17.11, лига Covens): `type: 'Scorched Arm'` — 189 объявлений, и Lesser, и
 * Greater в одной выдаче. Поэтому имя из буфера берётся без приставки.
 */
export function visceraBase (item: PricedItem): string | undefined {
  if (item.info.refName !== 'Viscera' || !item.rawText) return undefined
  const lines = item.rawText.split(/\r?\n/)
  const name = lines[1]?.startsWith('Rarity: ') ? lines[2] : lines[1]
  return name?.replace(/^(?:Lesser|Greater) /, '') || undefined
}

/**
 * Блайт-карта или нет. Признак — база из буфера: `Blighted Map (Tier 14)` парсер
 * отдаёт базой `Blighted Map`, `Blight-ravaged Map (Tier 16)` — `Blight-ravaged
 * Map` (обе есть в `items.ndjson` пина). Правило донора,
 * `create-item-filters.ts:169-175`.
 */
export function mapBlight (item: PricedItem): 'blighted' | 'ravaged' | undefined {
  const base = item.uniqueBase?.refName ?? item.info.refName
  if (base === 'Blighted Map') return 'blighted'
  if (base === 'Blight-ravaged Map') return 'ravaged'
  return undefined
}

/**
 * Свойство ли это предмета (защита, dps, уровень), а не мод. Нужно тем, кто
 * спрашивает «вошёл ли в фильтр хоть один мод»: включённый ilvl у предмета,
 * который ищется по базе, модом не является и цену базы ценой предмета не делает.
 */
export function isPropertyFilter (id: string): boolean {
  return PROPERTY_FIELD[id] != null
}

type PropertyGroup = 'armour_filters' | 'weapon_filters' | 'misc_filters'

/**
 * Внутреннее имя свойства → группа и поле трейда. Имена слева взяты у донора
 * (`_INTERNAL_TRADE_IDS`, `filters/interfaces.ts:142-154`), справа — то, что
 * понимает API (`pathofexile-trade.ts:452-490`).
 */
const PROPERTY_FIELD: Record<string, { group: PropertyGroup, field: string } | undefined> = {
  'item.armour': { group: 'armour_filters', field: 'ar' },
  'item.evasion_rating': { group: 'armour_filters', field: 'ev' },
  'item.energy_shield': { group: 'armour_filters', field: 'es' },
  'item.ward': { group: 'armour_filters', field: 'ward' },
  'item.block': { group: 'armour_filters', field: 'block' },
  'item.total_dps': { group: 'weapon_filters', field: 'dps' },
  'item.physical_dps': { group: 'weapon_filters', field: 'pdps' },
  'item.elemental_dps': { group: 'weapon_filters', field: 'edps' },
  'item.ilvl': { group: 'misc_filters', field: 'ilvl' }
}

/**
 * Фильтры → группы запроса. Мод с одним id живёт в общей группе `and`; мод,
 * который на трейде существует под несколькими типами, уходит отдельной группой
 * `count` с `min: 1` — «любой из этих id». Иначе выбор типа из буфера решал бы
 * судьбу поиска, а он у уникалов расходится с индексом трейда.
 */
export function statGroups (stats: StatEntryFilter[]): StatGroup[] {
  const and: StatGroup = { type: 'and', filters: [] }
  const groups: StatGroup[] = [and]

  for (const stat of stats) {
    const ids = [stat.id, ...(stat.alt ?? [])]
    const entry = stat.value ? { value: stat.value } : {}
    if (ids.length === 1) {
      and.filters.push({ id: stat.id, ...entry })
      continue
    }
    groups.push({
      type: 'count',
      value: { min: 1 },
      filters: ids.map(id => ({ id, ...entry }))
    })
  }

  return groups
}

/**
 * За что меняют — валюта считается курсом, а не листингами.
 *
 * Курс считаем в хаосах: одна валюта на все предметы даёт одно число, которое
 * можно сравнивать. Для самого Chaos Orb хаос бессмыслен — его меряем дивайном
 * (правило донора, `TradeBulk.vue:137-141`, там же и причина: на старте лиги
 * половина игроков выставляет курс наугад).
 */
export function buildExchangeQuery (
  item: PricedItem,
  opts: { status?: SearchMode, have?: string[] } = {}
): ExchangeBody {
  const tag = item.info.tradeTag
  if (!tag) throw new Error(`${item.info.refName} has no exchange tag — this branch is not about it`)

  return {
    engine: 'new',
    query: {
      status: { option: opts.status ?? DEFAULT_SEARCH_MODE },
      have: opts.have ?? (tag === 'chaos' ? ['divine'] : ['chaos']),
      want: [tag]
    },
    sort: { have: 'asc' }
  }
}
