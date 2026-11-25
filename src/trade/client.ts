// Transport to the trade API. Our own code; the only borrowed part is the host
// list. It comes from the donor (`main/src/proxy.ts:5-12`) as an idea, not as lines.
//
// What replaces Electron here. In the donor, requests did not go directly but through
// a proxy in the host process: it kept a host allowlist, removed `sec-*`/`host`/`origin`,
// set the Electron user-agent and called `net.request({ useSessionCookies: true })`,
// that is, with the Electron session cookies, where POESESSID landed after a human
// logged in inside `<webview>`. We have neither Electron nor `<webview>`, so:
//
//   - the allowlist is our own and mandatory: without the proxy nothing else stops
//     a request to an arbitrary host;
//   - we build the headers ourselves, exactly the ones we need. No need to remove `sec-*`:
//     the browser added them, and `fetch` under bun adds nothing;
//   - the user-agent is our own and names the project and a contact. GGG asks apps
//     to identify themselves, and on the live API this works (measured in tools/trade-probe.ts);
//   - the cookie jar is one environment variable. Measurement showed that the price
//     check does not need POESESSID at all (see docs/recon/poesessid.md), so the mechanism
//     stays minimal: if we need it, there is a place for it; if not, it does not
//     get in the way.

import {
  RATE_LIMIT_RULES,
  RateLimiter,
  adjustRateLimits,
  preventQueueCreation
} from './rate-limit'

/** Where requests may go at all. Anything else is an exception, not a silent request. */
export const ALLOWED_HOSTS = new Set([
  'www.pathofexile.com',
  'ru.pathofexile.com',
  'pathofexile.tw',
  'poe.kakaogames.com',
  'poe.ninja',
  'www.poeprices.info'
])

/**
 * How long we wait for a GGG answer before we treat the request as lost.
 *
 * Without a limit, `fetch` under bun waits forever, and the panel shows "searching..." forever.
 * Run #107: a synthesised ring with a dozen mods hung the price check
 * for good, and only a daemon restart got out of that state.
 * A lost request is a normal error that we must report, not hang on.
 */
export const REQUEST_TIMEOUT_MS = 12_000

/**
 * We identify ourselves honestly: name, version and where to find us. The form comes
 * from the GGG rules for third-party apps (pathofexile.com/developer/docs, § User-Agent):
 * `name/version (contact: …)`. There is no `OAuth <clientId>` prefix: we have no
 * OAuth client, and the trade site does not ask for one. Update the version together with package.json.
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
 * POESESSID, if it is set at all. The price check does not need it (see the file header);
 * the variable exists for private leagues and for requests on behalf of an account.
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

/** Rate limit group of the trade API, as the log names it. */
export type LimitGroup = 'search' | 'fetch' | 'exchange'

/**
 * Rate limit refusal, with the moment when a retry is possible. The player needs
 * not "wait" but "how long": the server sends this number, and to hide it means
 * to make the player press the button at random. `source` tells a server refusal (429)
 * from a refusal of our limiter, which never reached the network: in the log of run #121
 * they looked the same.
 *
 * The message stays as before, "Retry after N seconds": log lines written
 * before this type read it.
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
 * GGG maintenance: 503 or a maintenance page instead of JSON. It differs from "no network"
 * in what to do: Wi-Fi is not the cause, the player must wait for GGG.
 */
export class MaintenanceError extends Error {
  constructor (public status: number) {
    super(`pathofexile.com is under maintenance (HTTP ${status})`)
    this.name = 'MaintenanceError'
  }
}

/**
 * A league that trade does not know: it ended, was renamed or has a typo.
 * Trade itself answers it with `400 {"code":2,"message":"Invalid query"}`, the same
 * as for a malformed query (measured 12.11.2026, league Necropolis). So we set this type
 * only after a check against the trade league list, not by the response code.
 */
export class UnknownLeagueError extends Error {
  constructor (public league: string) {
    super(`trade does not know the league "${league}"`)
    this.name = 'UnknownLeagueError'
  }
}

/** A response came, but it is neither JSON nor maintenance, for example a 502 from Cloudflare. */
export class TradeHttpError extends Error {
  constructor (public status: number) {
    super(`trade answered HTTP ${status}`)
    this.name = 'TradeHttpError'
  }
}

/** The request went out, and no answer came within `REQUEST_TIMEOUT_MS`. */
export class TradeTimeoutError extends Error {
  constructor () {
    super(`trade did not answer in ${REQUEST_TIMEOUT_MS / 1000}s`)
    this.name = 'TradeTimeoutError'
  }
}

/**
 * The only door to the outside. It checks the host, builds the headers and adds
 * the session if there is one. Rate limits are NOT handled here: this is transport, and
 * politeness lives one level up (`search`/`fetchResults`), because the limit group depends
 * on the endpoint, not on the fact that we sent a request somewhere.
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
  // The session cookie goes only to GGG hosts: poe.ninja and poeprices do not need it, and
  // to give it to a third-party service means to give away access to the account of the player.
  const poesessid = sessionId()
  if (poesessid && Object.values(REALM_HOST).includes(parsed.host)) headers.set('cookie', `POESESSID=${poesessid}`)

  try {
    return await fetch(url, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (err) {
    // `TimeoutError`/`AbortError` go out as their own type: a lost
    // answer has its own frame, not the generic "request failed".
    const name = (err as { name?: string }).name
    if (name === 'TimeoutError' || name === 'AbortError') throw new TradeTimeoutError()
    throw err
  }
}

/**
 * Log line with the rate limit headers from a GGG response. It is written for EVERY
 * trade API response, not only for a refusal: the limiter rule is visible in a successful
 * response too, and the refusal that started all this (run #121) does not reproduce on
 * demand.
 *
 * Values are printed as is, without conversion: `ip=5:10:60` is 5 requests per
 * 10 s with a 60 s penalty; `ip-state=1:10:0` is how many of them are already used and how many
 * seconds of penalty are left. A response without the headers (not a trade endpoint) gives no line.
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
 * A refusal of our limiter, with no network request. It also must differ from a server
 * refusal: in the log of run #121 both would look like the same `rate limit`.
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

// ── penalty window after 429 ─────────────────────────────────────────────────
//
// The donor limiter knows the rules but not the penalty: after 429 the server accepts
// nothing until `Retry-After` ends, and by then our stack can
// consider itself free. Without the window, each press during the penalty would go to the network
// and extend the penalty (for the rule `5:10:60` it is 60 s per violation).

/** Until what moment the group is under a server penalty, epoch ms. */
const penaltyUntil = new Map<LimitGroup, number>()

/** Tests start without a penalty, as a new daemon start does. */
export function resetPenalties (): void {
  penaltyUntil.clear()
}

/** Inside the penalty window the request does not go out at all: a refusal without network, with the same deadline. */
function guardPenalty (group: LimitGroup, groups: LimitGroup[]): void {
  const now = Date.now()
  const until = Math.max(0, ...groups.map(name => penaltyUntil.get(name) ?? 0))
  if (until <= now) return
  console.log(`   rate limit ${group}: inside the server penalty, ${Math.ceil((until - now) / 1000)}s left — not sent`)
  throw new RateLimitError(until, 'server', group, now)
}

/**
 * How long to wait after 429, ms. `Retry-After` wins; without it, the rest of the
 * penalty from the third field of `x-rate-limit-<rule>-state` (`6:10:60` is 60 s).
 * Neither one: a minute, the penalty of the shortest search rule.
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
 * Response → JSON or a typed refusal. We check the status BEFORE we parse the body:
 * on 429 the retry deadline is in the headers, not in the body, and on 503 there is no JSON
 * at all. `response.json()` would throw `JSON Parse error`, and the panel would show it
 * as a poe-deck failure, not as GGG maintenance.
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
    // The maintenance page comes as HTML and not always with 503.
    if (/maintenance/i.test(body)) throw new MaintenanceError(response.status)
    throw new TradeHttpError(response.status)
  }
}

/**
 * Does trade know this league. We ask `/api/trade/data/leagues`, the list of trade
 * itself, not `/api/leagues`: the latter is exactly the one that returns a league trade
 * no longer knows. The response has no limit headers and is cached for 120 s (measured
 * 12.11.2026), so it is cheap to ask on a refusal. No answer gives `undefined`.
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

/** A refusal with code 2 "Invalid query" is checked against the trade leagues; others go out as they are. */
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
 * `POST /api/trade/search/<league>`. The body comes ready: the code that builds it
 * from the parsed item lives elsewhere and does not look into this file.
 */
export async function search (
  body: unknown,
  leagueId: string,
  realm: Realm = 'pc'
): Promise<SearchResult> {
  // We check not only SEARCH: a fetch always follows a search, and to hit
  // its limit after the search is already spent is the worst case.
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
 * `POST /api/trade/exchange/<league>`, the currency rate branch. It has its own limit group
 * (EXCHANGE) and its own response form: the listings arrive right here, no separate
 * `fetch` is needed. This is why the branch is chosen BEFORE the request.
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

/** A league in the `/api/leagues` response: only what the choice needs. */
export interface LeagueEntry { id: string, event?: boolean | null, rules: Array<{ id: string }> }

/**
 * The current softcore trade league from the `/api/leagues` response. The donor rule
 * (`background/Leagues.ts:57-75`), drop SSF (`NoParties`) and Ruthless
 * (`HardMode`, except events), is extended: we drop ANY league with the rule
 * `Hardcore`, not only the permanent one. The donor took the second list item and relied
 * on the temporary HC coming after the temporary SC; the player is promised
 * softcore, and the filter keeps this promise, not the response order.
 *
 * No temporary league (between leagues, measured 12.11.2026) gives Standard.
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
 * The league for the search. `fixed` is a league set by hand: with the variable
 * `POE_DECK_LEAGUE` or the `league` line in the player config (src/config.ts).
 * Private leagues and "I want to look at Standard" do not fit the choice rule
 * and must not.
 */
export async function currentLeague (realm: Realm = 'pc', fixed = process.env.POE_DECK_LEAGUE): Promise<string> {
  if (fixed) return fixed

  const response = await tradeFetch(`${tradeEndpoint(realm)}/api/leagues?type=main&realm=${realm}`)
  return pickTradeLeague(await answerOf<LeagueEntry[]>(undefined, response))
}

/** `GET /api/trade/fetch/<ids>?query=<id>`. No more than 10 ids at a time: the API limit. */
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
