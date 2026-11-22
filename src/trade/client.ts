// Транспорт к trade API. Наш код; заимствован здесь только список хостов —
// он у донора (`main/src/proxy.ts:5-12`) и взят идеей, а не строками.
//
// Что здесь заменяет Electron. У донора запросы шли не напрямую, а через прокси
// в хост-процессе: он держал allowlist хостов, вырезал `sec-*`/`host`/`origin`,
// подставлял user-agent Electron и ходил `net.request({ useSessionCookies: true })` —
// то есть куками сессии Electron, куда POESESSID попадал после логина человека
// внутри `<webview>`. Ни Electron, ни `<webview>` у нас нет, поэтому:
//
//   - allowlist — свой и обязательный: без прокси ничто больше не мешает уйти
//     запросу на произвольный хост;
//   - заголовки собираем сами и ровно те, что нужны. Резать `sec-*` не приходится:
//     их добавлял браузер, а `fetch` под bun не добавляет ничего;
//   - user-agent — свой, называющий проект и способ связаться. GGG просят
//     представляться, и на живом API это работает (замер в tools/trade-probe.ts);
//   - cookie jar — одна переменная окружения. Замер показал, что для прайс-чека
//     POESESSID не нужен вовсе (см. docs/recon/poesessid.md), поэтому механизм
//     оставлен минимальным: понадобится — есть куда положить, не понадобится —
//     не мешает.

import {
  RATE_LIMIT_RULES,
  RateLimiter,
  adjustRateLimits,
  preventQueueCreation
} from './rate-limit'

/** Куда вообще разрешено ходить. Всё остальное — исключение, а не молчаливый запрос. */
export const ALLOWED_HOSTS = new Set([
  'www.pathofexile.com',
  'ru.pathofexile.com',
  'pathofexile.tw',
  'poe.kakaogames.com',
  'poe.ninja',
  'www.poeprices.info'
])

/**
 * Сколько ждём ответа GGG, прежде чем признать запрос потерянным.
 *
 * Без предела `fetch` под bun ждёт вечно, и панель вечно показывает «ищу…».
 * Прогон #107: synthesised-кольцо с десятком модов подвешивало прайс-чек
 * насмерть, и выйти из этого состояния можно было только перезапуском демона.
 * Потерянный запрос — нормальная ошибка, о которой надо сказать, а не висеть.
 */
export const REQUEST_TIMEOUT_MS = 12_000

/**
 * Представляемся честно: имя, версия и где нас найти. Форма — из требований GGG
 * к сторонним приложениям (pathofexile.com/developer/docs, § User-Agent):
 * `имя/версия (contact: …)`. Префикса `OAuth <clientId>` нет: OAuth-клиента у
 * нас нет, trade-сайт его не спрашивает. Версия правится вместе с package.json.
 */
export const USER_AGENT = 'poe-deck/0.1.0 (contact: https://github.com/Stonkszilla/poe-deck/issues)'

export type Realm = 'pc' | 'ru' | 'tw' | 'kr'

const REALM_HOST: Record<Realm, string> = {
  pc: 'www.pathofexile.com',
  ru: 'ru.pathofexile.com',
  tw: 'pathofexile.tw',
  kr: 'poe.kakaogames.com'
}

export function tradeEndpoint (realm: Realm = 'pc'): string {
  return `https://${REALM_HOST[realm]}`
}

/**
 * POESESSID, если он вообще задан. Для прайз-чека не требуется — см. шапку файла;
 * переменная существует ради приватных лиг и запросов от имени аккаунта.
 */
export function sessionId (): string | undefined {
  return process.env.POE_DECK_POESESSID || undefined
}

export class BlockedHostError extends Error {
  constructor (public host: string) {
    super(`host not in allowlist: ${host}`)
    this.name = 'BlockedHostError'
  }
}

/** Группа лимитов trade API — так она называется в журнале. */
export type LimitGroup = 'search' | 'fetch' | 'exchange'

/**
 * Отказ по лимиту — с моментом, когда можно повторить. Игроку нужно
 * не «подожди», а «сколько»: сервер это число присылает, и молчать о нём значит
 * заставить жать кнопку наугад. `source` различает отказ сервера (429) и отказ
 * нашего лимитера, который до сети не дошёл: в журнале прогона #121 они
 * выглядели одинаково.
 *
 * Сообщение оставлено прежним, «Retry after N seconds»: его читают строки
 * журнала, написанные до типа.
 */
export class RateLimitError extends Error {
  constructor (
    public retryAt: number,
    public source: 'server' | 'client',
    public group: LimitGroup,
    now = Date.now()
  ) {
    super(`Retry after ${Math.max(1, Math.ceil((retryAt - now) / 1000))} seconds`)
    this.name = 'RateLimitError'
  }
}

/**
 * Техработы GGG: 503 или страница maintenance вместо JSON. От «нет сети» это
 * отличается тем, что делать: Wi-Fi тут ни при чём, ждать надо GGG.
 */
export class MaintenanceError extends Error {
  constructor (public status: number) {
    super(`pathofexile.com is under maintenance (HTTP ${status})`)
    this.name = 'MaintenanceError'
  }
}

/**
 * Лига, которой трейд не знает: кончилась, переименована или задана с опечаткой.
 * Сам трейд отвечает на неё `400 {"code":2,"message":"Invalid query"}` — тем же,
 * что на кривой запрос (замер 12.11.2026, лига Necropolis). Поэтому тип ставится
 * только после сверки со списком лиг трейда, а не по коду ответа.
 */
export class UnknownLeagueError extends Error {
  constructor (public league: string) {
    super(`trade does not know the league "${league}"`)
    this.name = 'UnknownLeagueError'
  }
}

/** Ответ пришёл, но не JSON и не техработы — например, 502 от Cloudflare. */
export class TradeHttpError extends Error {
  constructor (public status: number) {
    super(`trade answered HTTP ${status}`)
    this.name = 'TradeHttpError'
  }
}

/** Запрос ушёл, ответа нет за `REQUEST_TIMEOUT_MS`. */
export class TradeTimeoutError extends Error {
  constructor () {
    super(`trade did not answer in ${REQUEST_TIMEOUT_MS / 1000}s`)
    this.name = 'TradeTimeoutError'
  }
}

/**
 * Единственная дверь наружу. Проверяет хост, собирает заголовки, подставляет
 * сессию, если она есть. Лимиты здесь НЕ трогаются — это транспорт, а вежливость
 * живёт уровнем выше (`search`/`fetchResults`), потому что группа лимита зависит
 * от эндпойнта, а не от того, что мы куда-то пошли.
 */
export async function tradeFetch (url: string, init: RequestInit = {}): Promise<Response> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.host)) {
    throw new BlockedHostError(parsed.host)
  }

  const headers = new Headers(init.headers)
  headers.set('user-agent', USER_AGENT)
  if (!headers.has('accept')) headers.set('accept', 'application/json')
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  // Cookie сессии — только хостам GGG: poe.ninja и poeprices она не нужна, а
  // отдать её чужому сервису значит отдать вход в аккаунт игрока.
  const poesessid = sessionId()
  if (poesessid && Object.values(REALM_HOST).includes(parsed.host)) headers.set('cookie', `POESESSID=${poesessid}`)

  try {
    return await fetch(url, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (err) {
    // `TimeoutError`/`AbortError` наружу уходят своим типом: у потерянного
    // ответа свой кадр, а не общий «request failed».
    const name = (err as { name?: string }).name
    if (name === 'TimeoutError' || name === 'AbortError') throw new TradeTimeoutError()
    throw err
  }
}

/**
 * Строка журнала с заголовками лимита из ответа GGG. Пишется на КАЖДЫЙ ответ
 * trade API, а не только на отказ: правило лимитера видно и в успешном ответе,
 * а отказ, ради которого всё затевалось (прогон #121), не воспроизводится по
 * заказу.
 *
 * Значения выводятся как есть, без пересчёта: `ip=5:10:60` — 5 запросов за
 * 10 с, штраф 60 с; `ip-state=1:10:0` — сколько из них уже потрачено и сколько
 * секунд штрафа осталось. Ответ без заголовков (не trade-эндпойнт) строки не даёт.
 */
export function rateLimitLine (group: LimitGroup, response: Pick<Response, 'status' | 'headers'>): string | undefined {
  const { headers } = response
  const rules = headers.get('x-rate-limit-rules')
  if (!rules) return undefined

  const parts = [`policy=${headers.get('x-rate-limit-policy') ?? '?'}`]
  for (const rule of rules.split(',').map(r => r.trim().toLowerCase())) {
    parts.push(`${rule}=${headers.get(`x-rate-limit-${rule}`) ?? '?'}`)
    parts.push(`${rule}-state=${headers.get(`x-rate-limit-${rule}-state`) ?? '?'}`)
  }
  if (response.status !== 200) parts.push(`http=${response.status}`)
  const retry = headers.get('retry-after')
  if (retry) parts.push(`retry-after=${retry}`)
  return `   rate limit ${group}: ${parts.join(' ')}`
}

function logRateLimit (group: LimitGroup, response: Response): void {
  const line = rateLimitLine(group, response)
  if (line) console.log(line)
}

/**
 * Отказ нашего лимитера — без запроса в сеть. Его тоже надо отличать от отказа
 * сервера: в журнале прогона #121 оба выглядели бы одинаковым `rate limit`.
 */
function guardQueue (
  group: LimitGroup,
  targets: Parameters<typeof preventQueueCreation>[0],
  penalties: LimitGroup[] = [group]
): void {
  guardPenalty(group, penalties)
  try {
    preventQueueCreation(targets)
  } catch (err) {
    const limiters = targets.flatMap(target => Array.from(target.limiters, String)).join(', ')
    console.log(`   rate limit ${group}: refused by the client (${(err as Error).message}); ${limiters}`)
    const seconds = Number((err as Error).message.match(/Retry after (\d+) seconds/)?.[1])
    if (!Number.isFinite(seconds)) throw err
    throw new RateLimitError(Date.now() + seconds * 1000, 'client', group)
  }
}

// ── окно штрафа после 429 ────────────────────────────────────────────────────
//
// Лимитер донора знает правила, но не штраф: после 429 сервер не принимает
// ничего, пока не выйдет `Retry-After`, а наш стек к этому времени может
// считать себя свободным. Без окна каждое нажатие в штрафе уходило бы в сеть
// и продлевало штраф (у правила `5:10:60` он 60 с за превышение).

/** До какого момента группа под штрафом сервера, мс эпохи. */
const penaltyUntil = new Map<LimitGroup, number>()

/** Тесты начинают без штрафа, как и новый запуск демона. */
export function resetPenalties (): void {
  penaltyUntil.clear()
}

/** В окне штрафа запрос не уходит вовсе: отказ без сети с тем же сроком. */
function guardPenalty (group: LimitGroup, groups: LimitGroup[]): void {
  const now = Date.now()
  const until = Math.max(0, ...groups.map(name => penaltyUntil.get(name) ?? 0))
  if (until <= now) return
  console.log(`   rate limit ${group}: inside the server penalty, ${Math.ceil((until - now) / 1000)}s left — not sent`)
  throw new RateLimitError(until, 'server', group, now)
}

/**
 * Сколько ждать после 429, мс. `Retry-After` главнее; без него — остаток
 * штрафа из третьего поля `x-rate-limit-<rule>-state` (`6:10:60` — 60 с).
 * Ни того, ни другого — минута: столько штрафует самое короткое правило поиска.
 */
export function retryAfterMs (headers: Headers): number {
  const header = Number(headers.get('retry-after'))
  if (Number.isFinite(header) && header > 0) return header * 1000

  const rules = (headers.get('x-rate-limit-rules') ?? '')
    .split(',').map(rule => rule.trim().toLowerCase()).filter(Boolean)
  const penalty = Math.max(0, ...rules.flatMap(rule =>
    (headers.get(`x-rate-limit-${rule}-state`) ?? '').split(',').map(state => Number(state.split(':')[2]) || 0)
  ))
  return (penalty || 60) * 1000
}

/**
 * Ответ → JSON или типизированный отказ. Статус смотрится ДО разбора тела:
 * на 429 срок повтора живёт в заголовках, а не в теле, а на 503 JSON-а нет
 * вовсе — `response.json()` бросил бы `JSON Parse error`, и на панели это
 * читалось бы как поломка poe-deck, а не техработы GGG.
 */
async function answerOf<T> (group: LimitGroup | undefined, response: Response): Promise<T & TradeError> {
  if (response.status === 429 && group) {
    const until = Date.now() + retryAfterMs(response.headers)
    penaltyUntil.set(group, until)
    throw new RateLimitError(until, 'server', group)
  }
  if (response.status === 503) throw new MaintenanceError(response.status)

  const body = await response.text()
  try {
    return JSON.parse(body) as T & TradeError
  } catch {
    // Страница техработ приходит HTML-ем и не обязательно с 503.
    if (/maintenance/i.test(body)) throw new MaintenanceError(response.status)
    throw new TradeHttpError(response.status)
  }
}

/**
 * Знает ли трейд эту лигу. Спрашиваем `/api/trade/data/leagues` — список самого
 * трейда, а не `/api/leagues`: второй как раз и отдаёт лигу, которой трейд уже
 * не знает. Ответ без лимитных заголовков и кэшируется на 120 с (замер
 * 12.11.2026) — на отказе спросить его дёшево. Не ответил — `undefined`.
 */
export async function tradeKnowsLeague (league: string, realm: Realm): Promise<boolean | undefined> {
  try {
    const response = await tradeFetch(`${tradeEndpoint(realm)}/api/trade/data/leagues`)
    if (!response.ok) return undefined
    const data = await response.json() as { result?: Array<{ id: string, realm?: string }> }
    if (!data.result) return undefined
    return data.result.some(entry => entry.id === league && (entry.realm ?? 'pc') === realm)
  } catch {
    return undefined
  }
}

/** Отказ с кодом 2 «Invalid query» сверяется с лигами трейда; прочие уходят как были. */
async function unwrapForLeague<T> (data: T & TradeError, league: string, realm: Realm): Promise<T> {
  if (data.error?.code === 2 && await tradeKnowsLeague(league, realm) === false) {
    throw new UnknownLeagueError(league)
  }
  return unwrap(data)
}

export interface TradeError { error?: { code: number, message: string } | null }

function unwrap<T> (data: T & TradeError): T {
  if (data.error) throw new Error(`trade API: ${data.error.message} (${data.error.code})`)
  return data
}

export interface SearchResult { id: string, result: string[], total: number }

/**
 * `POST /api/trade/search/<league>`. Тело приходит готовым — его построение
 * из разобранного предмета живёт отдельно и в этот файл не заглядывает.
 */
export async function search (
  body: unknown,
  leagueId: string,
  realm: Realm = 'pc'
): Promise<SearchResult> {
  // Проверяем не только SEARCH: за поиском всегда идёт fetch, и упереться
  // в его лимит уже после того, как поиск потрачен, — худший из вариантов.
  guardQueue('search', [
    { count: 1, limiters: RATE_LIMIT_RULES.SEARCH },
    { count: 1, limiters: RATE_LIMIT_RULES.FETCH }
  ], ['search', 'fetch'])
  await RateLimiter.waitMulti(RATE_LIMIT_RULES.SEARCH)

  const response = await tradeFetch(
    `${tradeEndpoint(realm)}/api/trade/search/${encodeURIComponent(leagueId)}`,
    { method: 'POST', body: JSON.stringify(body) }
  )
  logRateLimit('search', response)
  adjustRateLimits(RATE_LIMIT_RULES.SEARCH, response.headers)

  return unwrapForLeague(await answerOf<SearchResult>('search', response), leagueId, realm)
}

export interface ExchangeResult<T = unknown> { id: string, result: Record<string, T>, total: number }

/**
 * `POST /api/trade/exchange/<league>` — ветка курса валюты. Своя группа лимитов
 * (EXCHANGE) и своя форма ответа: объявления приезжают прямо здесь, отдельного
 * `fetch` не нужно. Ради этого развилка и выбирается ДО запроса.
 */
export async function exchange<T = unknown> (
  body: unknown,
  leagueId: string,
  realm: Realm = 'pc'
): Promise<ExchangeResult<T>> {
  guardQueue('exchange', [{ count: 1, limiters: RATE_LIMIT_RULES.EXCHANGE }])
  await RateLimiter.waitMulti(RATE_LIMIT_RULES.EXCHANGE)

  const response = await tradeFetch(
    `${tradeEndpoint(realm)}/api/trade/exchange/${encodeURIComponent(leagueId)}`,
    { method: 'POST', body: JSON.stringify(body) }
  )
  logRateLimit('exchange', response)
  adjustRateLimits(RATE_LIMIT_RULES.EXCHANGE, response.headers)

  return unwrapForLeague(await answerOf<ExchangeResult<T>>('exchange', response), leagueId, realm)
}

/** Лига в ответе `/api/leagues`: только то, что нужно выбору. */
export interface LeagueEntry { id: string, event?: boolean | null, rules: Array<{ id: string }> }

/**
 * Текущая софткор trade-лига из ответа `/api/leagues`. Правило донора
 * (`background/Leagues.ts:57-75`) — выкинуть SSF (`NoParties`) и Ruthless
 * (`HardMode`, кроме событий) — дополнено: отсеивается ЛЮБАЯ лига с правилом
 * `Hardcore`, а не одна постоянная. Донор брал второй элемент списка и полагался
 * на то, что временная HC идёт после временной SC; игроку обещана именно
 * софткор, и это обещание держит фильтр, а не порядок ответа.
 *
 * Временной лиги нет (между лигами, замер 12.11.2026) — Standard.
 */
export function pickTradeLeague (leagues: LeagueEntry[]): string {
  const trade = leagues.filter(league =>
    !league.rules.some(rule =>
      rule.id === 'Hardcore' || rule.id === 'NoParties' || (rule.id === 'HardMode' && !league.event))
  )
  const league = trade.find(entry => entry.id !== 'Standard') ?? trade[0]
  if (!league) throw new Error('/api/leagues left no tradeable league')
  return league.id
}

/**
 * Лига для поиска. `fixed` — лига, заданная руками: переменной
 * `POE_DECK_LEAGUE` или строкой `league` в конфиге игрока (src/config.ts).
 * Приватные лиги и «хочу посмотреть Standard» в правило выбора не укладываются
 * и укладываться не должны.
 */
export async function currentLeague (realm: Realm = 'pc', fixed = process.env.POE_DECK_LEAGUE): Promise<string> {
  if (fixed) return fixed

  const response = await tradeFetch(`${tradeEndpoint(realm)}/api/leagues?type=main&realm=${realm}`)
  return pickTradeLeague(await answerOf<LeagueEntry[]>(undefined, response))
}

/** `GET /api/trade/fetch/<ids>?query=<id>`. Не больше 10 идентификаторов за раз — предел API. */
export async function fetchResults<T = unknown> (
  queryId: string,
  resultIds: string[],
  realm: Realm = 'pc'
): Promise<T[]> {
  guardPenalty('fetch', ['fetch'])
  await RateLimiter.waitMulti(RATE_LIMIT_RULES.FETCH)

  const response = await tradeFetch(
    `${tradeEndpoint(realm)}/api/trade/fetch/${resultIds.join(',')}?query=${encodeURIComponent(queryId)}`
  )
  logRateLimit('fetch', response)
  adjustRateLimits(RATE_LIMIT_RULES.FETCH, response.headers)

  const data = unwrap(await answerOf<{ result: T[] }>('fetch', response))
  return data.result.filter(res => res != null)
}
