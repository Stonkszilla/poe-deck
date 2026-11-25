// BORROWED from SnosMe/awakened-poe-trade (MIT, Copyright (c) 2020 Alexander Drozdov).
// License text: licenses/awakened-poe-trade.LICENSE, origin: README, section "Donor and pin".
//
// Source: two donor files, merged here into one (in the donor, the border between them
// was a Vue widget, which we do not have):
//   renderer/src/web/price-check/trade/RateLimiter.ts  → RateLimiter, ResourceHandle
//   renderer/src/web/price-check/trade/common.ts:37-140 → RATE_LIMIT_RULES,
//                                                         adjustRateLimits, preventQueueCreation
//
// The algorithm is unchanged. It is the reason for the borrowing: GGG limits are not bypassed,
// they are mirrored. The client starts with a conservative 1 request / 5 s per group. After each
// response it reads `x-rate-limit-rules` and `x-rate-limit-<rule>[-state]` and REBUILDS its
// limiters to what the server declared, burning the difference idle. A naive limiter of our own
// is a request to get banned.
//
// Differences from the donor, all forced:
//   1. `shallowReactive([])` / `shallowRef(0)` -> a plain array and a number. Reactivity
//      was for the RateLimiterState.vue widget; we have no Vue.
//   2. `AppConfig('price-check')!.apiLatencySeconds` -> the `desyncFixSeconds` argument.
//      The clock desync correction stays, the donor config does not.
//   3. Array indexes with `!`: we have `noUncheckedIndexedAccess`, the donor does not.
//      The invariants are the same as the implicit ones: if a limiter is exhausted, stack[0] exists.
//
// Not borrowed: Cache (response TTL) and artificial-slowdown. They will be needed when
// something appears that calls the filters.

/** One issued "unit" of a limit: it lives `window` seconds and leaves the stack by itself. */
class ResourceHandle {
  public borrowedAt: number
  public releasedAt: number
  public promise: Promise<void>

  private _tmid!: ReturnType<typeof setTimeout>
  private _cb: () => void
  private _resolve!: () => void
  private _reject!: (reason?: unknown) => void

  constructor (millis: number, cb: () => void) {
    this.borrowedAt = Date.now()
    this.releasedAt = this.borrowedAt + millis
    this._cb = cb
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve
      this._reject = reject

      this._tmid = setTimeout(() => {
        this._cb()
        this._resolve()
      }, millis)
    })
  }

  public cancel (reason?: unknown) {
    clearTimeout(this._tmid)
    this._cb()
    this._reject(reason)
  }
}

export class RateLimiter {
  stack: ResourceHandle[] = []
  queue = 0

  private _destroyed = false

  constructor (
    public max: number,
    public window: number
  ) {}

  wait (borrow = true) {
    return this._wait(borrow)
  }

  private async _wait (borrow: boolean): Promise<void> {
    if (this._destroyed) throw new Error('RateLimiter is no longer active')

    if (this.isFullyUtilized) {
      this.queue++
      await this.stack[0]!.promise
      this.queue--
      return this._wait(borrow)
    } else {
      if (borrow) {
        this.push()
      }
    }
  }

  private push () {
    const handle = new ResourceHandle(this.window * 1000, () => {
      const idx = this.stack.indexOf(handle)
      if (idx !== -1) {
        this.stack.splice(idx, 1)
      }
    })
    this.stack.push(handle)
  }

  static async waitMulti (limiters: Iterable<RateLimiter>): Promise<void> {
    const _limiters = Array.from(limiters)

    try {
      await Promise.all(_limiters.map(rl => rl.wait(false)))
    } catch (e) {
      if (e instanceof Error && e.message === 'RateLimiter is no longer active') {
        return this.waitMulti(limiters)
      } else {
        throw e
      }
    }

    if (_limiters.every(rl => !rl.isFullyUtilized)) {
      _limiters.forEach(rl => { void rl.wait() })
    } else {
      return this.waitMulti(limiters)
    }
  }

  static estimateTime (count: number, limiters: Iterable<RateLimiter>, ignoreState = false): number {
    // NOTE: Cannot handle existing queue in simulation, because
    //       entries in queue can depend on other limiters in `waitMulti` call.
    //       It means that time returned by `estimateTime` will be increased
    //       multiple times between calls until queue is cleared.

    let simulation: Array<{ max: number, window: number, stack: number[] }>
    {
      const now = Date.now()
      simulation = Array.from(limiters).map(l => ({
        max: l.max,
        window: l.window,
        stack: ignoreState
          ? []
          : l.stack
              .map(entry => entry.releasedAt - now)
              .sort((a, b) => a - b)
      }))
    }

    let total = 0
    while (count--) {
      while (simulation.some(limit => limit.stack.length >= limit.max)) {
        const waitTime = simulation.reduce((ms, limit) =>
          (limit.stack.length >= limit.max)
            ? Math.max(limit.stack[0]! - total, ms) : ms, 0)

        total += waitTime

        for (const limit of simulation) {
          limit.stack = limit.stack.filter(time => time > total)
        }
      }

      for (const limit of simulation) {
        limit.stack.push(total + limit.window * 1000)
      }
    }

    return total
  }

  isEqualLimit (other: { max: number, window: number }) {
    return this.max === other.max &&
      this.window === other.window
  }

  get isFullyUtilized () {
    return !this.available
  }

  get available () {
    return Math.max(this.max - this.stack.length, 0)
  }

  destroy () {
    this._destroyed = true
    if (this.queue) {
      // shortcircuit awaiters in queue
      this.stack[0]!.cancel(new Error('RateLimiter is no longer active'))
    }
  }

  toString () {
    return `RateLimiter<max=${this.max}:window=${this.window}>: (stack=${this.stack.length},queue=${this.queue})`
  }
}

/**
 * Three limit groups of the trade API. Start values are conservative: until the server
 * declares its own, the client thinks it is limited to one request per 5 seconds.
 */
export const RATE_LIMIT_RULES = {
  SEARCH: new Set([new RateLimiter(1, 5)]),
  EXCHANGE: new Set([new RateLimiter(1, 5)]),
  FETCH: new Set([new RateLimiter(1, 5)])
}

/**
 * Back to the conservative start. Limiters are module-level state shared by the
 * whole process: a test that loosens them leaves them loose for whatever runs
 * next, and `adjustRateLimits` cannot undo that exactly (it adds the desync
 * correction to the window). Nothing in the daemon calls this.
 */
export function resetRateLimits (): void {
  for (const group of Object.values(RATE_LIMIT_RULES)) {
    group.clear()
    group.add(new RateLimiter(1, 5))
  }
}

/**
 * Correction for clock desync between us and the server, in seconds. In the donor it came
 * from the widget config (`apiLatencySeconds`); here it is an argument with the donor value.
 */
export const DEFAULT_DESYNC_FIX = 0.05

/**
 * Rebuilds the set of limiters to what the server declared in the response headers.
 * No `x-rate-limit-rules` header means nothing to adjust (non-trade endpoints have
 * their own policy, for example `ladder-view` on `/api/leagues`).
 */
export function adjustRateLimits (
  clientLimits: Set<RateLimiter>,
  headers: Headers,
  desyncFixSeconds = DEFAULT_DESYNC_FIX
): void {
  if (!headers.has('x-rate-limit-rules')) return

  const rules = headers.get('x-rate-limit-rules')!.split(',')

  _adjustRateLimits(
    clientLimits,
    rules.map(rule => headers.get(`x-rate-limit-${rule}`)!).join(','),
    rules.map(rule => headers.get(`x-rate-limit-${rule}-state`)!).join(','),
    desyncFixSeconds
  )
}

function _adjustRateLimits (
  clientLimits: Set<RateLimiter>,
  limitStr: string,
  stateStr: string,
  DESYNC_FIX: number
): void {
  const limitRuleState = stateStr
    .split(',')
    .map(rule => rule.split(':'))
    .map(rule => Number(rule[0]))
  const limitRule = limitStr
    .split(',')
    .map(rule => rule.split(':'))
    .map((rule, idx) => ({
      max: Number(rule[0]),
      window: Number(rule[1]) + DESYNC_FIX,
      state: limitRuleState[idx] ?? 0
    }))

  // destroy
  for (const limit of clientLimits) {
    const isActive = limitRule.some(serverLimit => limit.isEqualLimit(serverLimit))
    if (!isActive) {
      clientLimits.delete(limit)
      limit.destroy()
    }
  }

  // compare client<>server state
  for (const limit of clientLimits) {
    const serverLimit = limitRule.find(serverLimit => limit.isEqualLimit(serverLimit))!
    const delta = (serverLimit.state - limit.stack.length)

    if (delta > 0) {
      // The server thinks we are busier than we think. Burn the difference idle,
      // so that the client never thinks it is freer than the server.
      for (let i = 0; i < Math.min(delta, limit.available); ++i) {
        void limit.wait()
      }
    }
  }

  // add new
  serverLimits:
  for (const serverLimit of limitRule) {
    for (const limit of clientLimits) {
      if (limit.isEqualLimit(serverLimit)) continue serverLimits
    }

    const rl = new RateLimiter(serverLimit.max, serverLimit.window)
    clientLimits.add(rl)

    for (let i = 0; i < serverLimit.state; ++i) {
      void rl.wait()
    }
  }
}

/**
 * Throws "Retry after N seconds" instead of a silent queue longer than 1.5 s, so that
 * the user sees the refusal at once and does not wait in silence.
 */
export function preventQueueCreation (targets: Array<{ count: number, limiters: Iterable<RateLimiter> }>) {
  const estimatedMillis = Math.max(...targets.map(target => {
    const estimated = RateLimiter.estimateTime(target.count, target.limiters)
    const estimatedCleanState = RateLimiter.estimateTime(target.count, target.limiters, true)

    // ignore if impossible to run without queue
    return (estimated === estimatedCleanState) ? 0 : estimated
  }))

  if (estimatedMillis >= 1500) {
    throw new Error(`Retry after ${Math.round(estimatedMillis / 1000)} seconds`)
  }
}
