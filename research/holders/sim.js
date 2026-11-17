// Spec 025 D2: replays devices' online hours and a strategy's holder picks
// (one circle, one space per person, the owner's device hands it), and
// measures per space the share of the owner's offline hours some copy is
// online, uploads and moves. Plain JS, no dependencies. Mirrors 024's rules
// (lib/holding.js, lib/circles.js): handing only while owner and holder are
// both online; holders sync with each other on the space's topic; 7 days
// unseen (and the owner online 24 h since) = replaced for good, ranked last;
// an extra copy while fewer than 2 regular holders are online; a dropped
// holder deletes once every regular holder has the latest.
// Time: hour 0 = a Monday 00:00 UTC.

const HOUR_WEEK = 168
const WINDOW = 720 // 30 days, like lib/circles.js HOURS
const Z = 1.96

// --- random, hashes ---

function rng (seed) { // mulberry32
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// a uniform in (0, 1) for (space, device): the rendezvous hash
function unit (seed, s, d) {
  let h = Math.imul(seed ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul(s + 1, 0xC2B2AE35) ^ Math.imul(d + 1, 0x27D4EB2F)
  h ^= h >>> 16; h = Math.imul(h, 0x7FEB352D); h ^= h >>> 15; h = Math.imul(h, 0x846CA68B); h ^= h >>> 16
  return ((h >>> 0) + 0.5) / 4294967296
}

// --- made-up patterns: (r, H, tz, opts) -> Uint8Array, 1 = online that hour ---

const local = (t, tz) => {
  const lt = t + tz
  const day = Math.floor(lt / 24)
  return { hour: ((lt % 24) + 24) % 24, day, weekend: ((day % 7) + 7) % 7 >= 5 }
}

function byDay (H, tz, fn) { // fn(day, weekend) -> [from, to) local hours online that day, or null
  const out = new Uint8Array(H)
  let day = null
  let span = null
  for (let t = 0; t < H; t++) {
    const l = local(t, tz)
    if (l.day !== day) { day = l.day; span = fn(l.day, l.weekend) }
    if (span && l.hour >= span[0] && l.hour < span[1]) out[t] = 1
  }
  return out
}

const PATTERNS = {
  // always-on helper (HyperBrowser 020): rare outages of 1-6 h
  helper (r, H) {
    const out = new Uint8Array(H).fill(1)
    for (let t = 0; t < H; t++) if (r() < 0.002) for (let k = 0, n = 1 + Math.floor(r() * 6); k < n && t + k < H; k++) out[t + k] = 0
    return out
  },
  // a home PC left on, off some whole days
  desktop24 (r, H, tz) { return byDay(H, tz, () => (r() < 0.9 ? [0, 24] : null)) },
  // a work laptop: weekdays 9-17 local, some days off
  office (r, H, tz) { return byDay(H, tz, (d, we) => (!we && r() < 0.9 ? [9, 17] : null)) },
  // evenings, longer at weekends
  evening (r, H, tz) {
    return byDay(H, tz, (d, we) => {
      if (we) return r() < 0.6 ? [10 + Math.floor(r() * 4), 23] : null
      return r() < 0.85 ? [18 + Math.floor(r() * 3), 22 + Math.floor(r() * 3)] : null
    })
  },
  // a phone: short bursts in waking hours (an hour counts if online any part of it)
  phone (r, H, tz) {
    const out = new Uint8Array(H)
    for (let t = 0; t < H; t++) { const h = local(t, tz).hour; if (h >= 8 && h < 23 && r() < 0.3) out[t] = 1 }
    return out
  },
  // on for days, then off for days
  onoff (r, H, tz) {
    let on = r() < 0.5
    return byDay(H, tz, () => { if (r() < 0.25) on = !on; return on ? [8, 24] : null })
  },
  // evenings, then gone for good at opts.leaveAt
  leaves (r, H, tz, opts) {
    const out = PATTERNS.evening(r, H, tz)
    out.fill(0, opts.leaveAt)
    return out
  }
}

// Pattern mixes: [kind, weight]; tzs: the time zones people are spread over.
const MIXES = {
  friends: { kinds: [['evening', 35], ['office', 20], ['phone', 20], ['desktop24', 5], ['onoff', 10], ['leaves', 10]], tzs: [0, 1] },
  global: { kinds: [['evening', 35], ['office', 20], ['phone', 20], ['desktop24', 5], ['onoff', 10], ['leaves', 10]], tzs: [-8, -5, 0, 1, 8] },
  phones: { kinds: [['phone', 90], ['leaves', 10]], tzs: [0, 1] }
}

// A circle of `size` people (one device each) from a mix, + a helper if asked.
// lateShare of them join during the measured weeks (short history, S3).
function circle ({ size, mix = 'friends', helper = false, seed = 1, weeks = 8, measureFrom = 4, lateShare = 0.1 }) {
  const r = rng(seed)
  const H = weeks * HOUR_WEEK
  const M0 = measureFrom * HOUR_WEEK
  const m = MIXES[mix]
  const total = m.kinds.reduce((a, [, w]) => a + w, 0)
  const devices = []
  for (let i = 0; i < size; i++) {
    let x = r() * total
    const kind = m.kinds.find(([, w]) => (x -= w) < 0)[0]
    const tz = m.tzs[Math.floor(r() * m.tzs.length)]
    const leaveAt = M0 - 2 * HOUR_WEEK + Math.floor(r() * (H - M0 + HOUR_WEEK))
    const joinAt = i > 0 && r() < lateShare ? M0 + Math.floor(r() * (H - M0 - HOUR_WEEK)) : 0
    const online = PATTERNS[kind](r, H, tz, { leaveAt })
    online.fill(0, 0, joinAt)
    devices.push({ kind, tz, joinAt, online, helper: false })
  }
  if (helper) devices.push({ kind: 'helper', tz: 0, joinAt: 0, online: PATTERNS.helper(r, H), helper: true })
  return { devices, H, M0 }
}

// --- real patterns (D3 export files): a device's 30 days replayed by hour of week ---

// hours: absolute hour numbers (since 1970) it was online in the 30 days
// up to `end` (the export's hour); replayed over H sim hours, week after
// week, matching the hour of the week (UTC).
function replay (hours, H, end = Math.max(...hours)) {
  const set = new Set(hours)
  const byHow = Array.from({ length: HOUR_WEEK }, () => [])
  for (let a = end - WINDOW + 1; a <= end; a++) byHow[(a + 72) % HOUR_WEEK].push(a) // 1970-01-01 was a Thursday
  const out = new Uint8Array(H)
  for (let t = 0; t < H; t++) {
    const list = byHow[t % HOUR_WEEK]
    out[t] = set.has(list[Math.floor(t / HOUR_WEEK) % list.length]) ? 1 : 0
  }
  return out
}

// --- the numbers a strategy sees ---

function wilson (p, n) { // lower bound of the share, n hours watched
  if (n <= 0) return 0
  const z2 = Z * Z
  return (p + z2 / (2 * n) - Z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n)
}

class View {
  constructor (devices, H, seed) {
    this.devices = devices
    this.H = H
    this.seed = seed
    this.prefix = devices.map((d) => { const p = new Int32Array(H + 1); for (let t = 0; t < H; t++) p[t + 1] = p[t] + d.online[t]; return p })
    this.co = new Map()
    this.reports = new Map()
    this.profiles = new Map()
  }

  on (d, t) { return this.devices[d].online[t] === 1 }
  count (d, from, to) { return this.prefix[d][to] - this.prefix[d][Math.max(0, from)] }

  // The self-reported share (hg/holder.online): its last 30 days as of the day's start.
  reported (d, t) {
    const day = Math.floor(t / 24)
    const k = d * 1e6 + day
    if (!this.reports.has(k)) {
      const to = day * 24
      const from = Math.max(this.devices[d].joinAt, to - WINDOW)
      this.reports.set(k, to > from ? this.count(d, from, to) / (to - from) : 0)
    }
    return this.reports.get(k)
  }

  // Hours both a and b were online in [from, to): what 024's `hours` counts for a holder.
  both (a, b, from, to) {
    const k = a < b ? a * 1e4 + b : b * 1e4 + a
    let p = this.co.get(k)
    if (!p) {
      p = new Int32Array(this.H + 1)
      const x = this.devices[a].online
      const y = this.devices[b].online
      for (let t = 0; t < this.H; t++) p[t + 1] = p[t] + (x[t] & y[t])
      this.co.set(k, p)
    }
    return p[to] - p[Math.max(0, from)]
  }

  // Online share by hour of the week over the last 4 weeks (or since it joined).
  profile (d, t) {
    const day = Math.floor(t / 24)
    const k = d * 1e6 + day
    if (!this.profiles.has(k)) {
      const p = new Float64Array(HOUR_WEEK)
      const n = new Float64Array(HOUR_WEEK)
      for (let h = Math.max(this.devices[d].joinAt, day * 24 - 4 * HOUR_WEEK); h < day * 24; h++) { n[h % HOUR_WEEK]++; p[h % HOUR_WEEK] += this.devices[d].online[h] }
      for (let i = 0; i < HOUR_WEEK; i++) p[i] = n[i] ? p[i] / n[i] : 0
      this.profiles.set(k, p)
    }
    return this.profiles.get(k)
  }
}

// --- strategies: order(cands, ctx) -> every candidate, best first; the top COPIES are the regular holders ---

const byU = (ctx) => (a, b) => ctx.u(a) - ctx.u(b)
const rendezvous = (cands, ctx, weight) => [...cands].sort((a, b) => -Math.log(ctx.u(a)) / weight(a) + Math.log(ctx.u(b)) / weight(b))

// S1: the self-reported share, capped by what the owner observed (both online / owner online) once it watched 24 own hours
function s1 (d, ctx) {
  const { view, o, t } = ctx
  const r = view.reported(d, t)
  const from = Math.max(ctx.knownSince[d], t - WINDOW)
  const own = view.count(o, from, t)
  return own >= 24 ? Math.min(r, view.both(o, d, from, t) / own) : r
}

// S3: Wilson lower bound over the hours since the owner knew it (<= 30 days)
const s3 = (p, d, ctx) => wilson(p, Math.min(WINDOW, ctx.t - ctx.knownSince[d] + 1))
const step = (x) => Math.round(x * 10) // S5: 10-point steps

// S5: a regular holder stays unless its replacement is 2+ steps better
function sticky (order, ctx, steps) {
  const top = order.slice(0, ctx.copies)
  const prev = ctx.prev.filter((d) => order.includes(d) && !top.includes(d))
  for (let i = top.length - 1; i >= 0 && prev.length; i--) {
    if (ctx.prev.includes(top[i])) continue
    const j = prev.findIndex((y) => steps(top[i]) - steps(y) < 2)
    if (j >= 0) top[i] = prev.splice(j, 1)[0]
  }
  return [...top, ...order.filter((d) => !top.includes(d))]
}

const STRATEGIES = {
  // 024: plain rendezvous hash
  hash: (cands, ctx) => [...cands].sort(byU(ctx)),
  // S2: weighted rendezvous (Schindelhauer & Schomaker's logarithmic method), weight = reported share
  weighted: (cands, ctx) => rendezvous(cands, ctx, (d) => Math.max(0.01, ctx.view.reported(d, ctx.t))),
  // literature's greedy: the most available first (Total Recall-like / selfish placement)
  top: (cands, ctx) => [...cands].sort((a, b) => ctx.view.reported(b, ctx.t) - ctx.view.reported(a, ctx.t) || ctx.u(a) - ctx.u(b)),
  // S1-S5 together
  s15 (cands, ctx) {
    const st = new Map(cands.map((d) => [d, step(s3(s1(d, ctx), d, ctx))]))
    const w = (d) => Math.max(0.01, st.get(d) / 10)
    const first = [...cands].sort((a, b) => st.get(b) - st.get(a) || ctx.u(a) - ctx.u(b))[0] // S4
    const order = first === undefined ? [] : [first, ...rendezvous(cands.filter((d) => d !== first), ctx, w)]
    return sticky(order, ctx, (d) => st.get(d))
  },
  // S2 with S5's stickiness only (no cap, no Wilson, no S4)
  weightedSticky (cands, ctx) {
    const st = new Map(cands.map((d) => [d, step(ctx.view.reported(d, ctx.t))]))
    return sticky(rendezvous(cands, ctx, (d) => Math.max(0.01, st.get(d) / 10)), ctx, (d) => st.get(d))
  },
  // S6's later option (My3, Rzadca et al.): greedy hour coverage of the owner's
  // offline hours, from 4 weeks of hour maps; recomputed once a day
  coverage (cands, ctx) {
    const { view, o, t } = ctx
    const day = Math.floor(t / 24)
    if (ctx.cache && ctx.cache.day === day && ctx.cache.n === cands.length) return ctx.cache.order
    const off = view.profile(o, t).map((p) => 1 - p)
    const miss = new Float64Array(HOUR_WEEK).fill(1) // chance no chosen holder is online, per hour of week
    const left = new Set(cands)
    const order = []
    while (left.size && order.length < ctx.copies) {
      let best = null
      let gain = -1
      for (const d of left) {
        const p = view.profile(d, t)
        let g = 0
        for (let i = 0; i < HOUR_WEEK; i++) g += off[i] * miss[i] * p[i]
        g += 1e-9 * ctx.u(d)
        if (g > gain) { gain = g; best = d }
      }
      const p = view.profile(best, t)
      for (let i = 0; i < HOUR_WEEK; i++) miss[i] *= 1 - p[i]
      order.push(best)
      left.delete(best)
    }
    order.push(...STRATEGIES.top([...left], ctx))
    ctx.cache = { day, n: cands.length, order }
    return order
  }
}

// --- the replay ---

// opts: copies (5), staleH (168, 024's 7 days; Infinity = never), lookedH (24), extra (true)
function simulate ({ devices, H, M0 }, strategy, opts = {}) {
  const { copies = 5, staleH = 168, lookedH = 24, extra: useExtra = true, seed = 1 } = opts
  const order = typeof strategy === 'function' ? strategy : STRATEGIES[strategy]
  const view = new View(devices, H, seed)
  const n = devices.length
  const spaces = []
  for (let o = 0; o < n; o++) {
    if (devices[o].helper) continue
    spaces.push({ o, version: 0, lastDay: -1, holds: new Int32Array(n).fill(-1), seenAt: new Float64Array(n).fill(-1), knownSince: new Float64Array(n).fill(-1), replaced: new Set(), regular: [], extra: null, cache: null, offH: 0, read: 0, fresh: 0, uploads: 0, moves: 0, deletes: 0 })
  }
  const load = new Float64Array(n)
  let measured = 0

  for (let t = 0; t < H; t++) {
    for (const s of spaces) {
      const o = s.o
      if (t < devices[o].joinAt) continue
      if (view.on(o, t)) {
        if (Math.floor(t / 24) !== s.lastDay) { s.lastDay = Math.floor(t / 24); s.version++ } // writes once a day it's online
        const cands = []
        for (let d = 0; d < n; d++) {
          if (d === o || t < devices[d].joinAt) continue
          if (s.knownSince[d] < 0) { s.knownSince[d] = t; s.seenAt[d] = t }
          if (view.on(d, t)) s.seenAt[d] = t
          if (!s.replaced.has(d) && t - s.seenAt[d] > staleH && view.count(o, s.seenAt[d] + 1, t + 1) >= lookedH) s.replaced.add(d)
          cands.push(d)
        }
        const ctx = { view, o, t, copies, prev: s.regular, knownSince: s.knownSince, u: (d) => unit(seed, o, d), cache: s.cache }
        const fresh = order(cands.filter((d) => !s.replaced.has(d)), ctx)
        s.cache = ctx.cache
        const stale = cands.filter((d) => s.replaced.has(d)).sort(byU(ctx))
        const ranked = [...fresh, ...stale]
        const regular = ranked.slice(0, copies)
        if (t >= M0) for (const d of regular) if (!s.regular.includes(d)) s.moves++
        s.regular = regular
        if (useExtra) { // lib/circles.js extraFor
          const up = regular.filter((d) => view.on(d, t)).length
          if (up >= 2) s.extra = null
          else if (!(up === 1 || (s.extra !== null && view.on(s.extra, t)))) s.extra = ranked.slice(copies).find((d) => view.on(d, t)) ?? null
        }
        const targets = s.extra === null ? regular : [...regular, s.extra]
        for (const d of targets) {
          if (!view.on(d, t) || s.holds[d] >= s.version) continue
          if (s.holds[d] < 0 && t >= M0) s.uploads++
          s.holds[d] = s.version
        }
        if (regular.every((d) => s.holds[d] === s.version)) {
          for (let d = 0; d < n; d++) if (s.holds[d] >= 0 && !targets.includes(d) && view.on(d, t)) { s.holds[d] = -1; s.deletes++ }
        }
      }
      // holders sync with each other on the space's topic
      let best = -1
      for (let d = 0; d < n; d++) if (s.holds[d] > best && view.on(d, t)) best = s.holds[d]
      if (best >= 0) for (let d = 0; d < n; d++) if (s.holds[d] >= 0 && view.on(d, t)) s.holds[d] = best
      if (t < M0) continue
      for (let d = 0; d < n; d++) if (s.holds[d] >= 0) load[d]++
      if (view.on(o, t)) continue
      s.offH++
      let read = false
      let fresh = false
      for (let d = 0; d < n; d++) {
        if (s.holds[d] < 0 || !view.on(d, t)) continue
        read = true
        if (s.holds[d] === s.version) { fresh = true; break }
      }
      if (read) s.read++
      if (fresh) s.fresh++
    }
    if (t >= M0) measured++
  }

  const weeks = measured / HOUR_WEEK
  const per = spaces.map((s) => (s.offH ? s.read / s.offH : 1)).sort((a, b) => a - b)
  const total = load.reduce((a, b) => a + b, 0)
  const helpers = devices.map((d, i) => (d.helper ? i : -1)).filter((i) => i >= 0)
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
  return {
    avail: mean(per), // share of the owner's offline hours some copy is online, mean over spaces
    worst: per[Math.floor(per.length * 0.1)], // the 10th percentile space
    fresh: mean(spaces.map((s) => (s.offH ? s.fresh / s.offH : 1))), // ... with the owner's latest
    uploads: mean(spaces.map((s) => s.uploads)) / weeks, // full copies sent per space per week, measured weeks
    moves: mean(spaces.map((s) => s.moves)) / weeks, // regular holders changed per space per week
    copies: total / measured / spaces.length, // copies kept per space on average
    maxLoad: total ? Math.max(...load) / (total / n) : 0, // the busiest device's load vs the mean
    helperShare: total && helpers.length ? helpers.reduce((a, i) => a + load[i], 0) / total : 0,
    load: [...load], // per device: space-hours of copies held, measured weeks (not averaged by run.js)
    obsErr: obsError(view, devices, H) // 024's observed share (both online / own online) vs the true one
  }
}

// Mean |observed - true| share over owner-holder pairs, last 30 days.
function obsError (view, devices, H) {
  let sum = 0
  let k = 0
  for (let o = 0; o < devices.length; o++) {
    const own = view.count(o, H - WINDOW, H)
    if (!own || devices[o].helper) continue
    for (let d = 0; d < devices.length; d++) {
      if (d === o) continue
      sum += Math.abs(view.both(o, d, H - WINDOW, H) / own - view.count(d, H - WINDOW, H) / WINDOW)
      k++
    }
  }
  return k ? sum / k : 0
}

// --- RQ1: copies needed, independent devices ---

const replication = (p, n) => 1 - (1 - p) ** n
function erasure (p, k, n) { // any k of n pieces online
  let sum = 0
  for (let i = k; i <= n; i++) sum += choose(n, i) * p ** i * (1 - p) ** (n - i)
  return sum
}
function choose (n, k) { let c = 1; for (let i = 1; i <= k; i++) c = c * (n - k + i) / i; return c }
function copiesFor (p, target) { return Math.ceil(Math.log(1 - target) / Math.log(1 - p)) }

module.exports = { HOUR_WEEK, PATTERNS, MIXES, STRATEGIES, rng, unit, circle, replay, wilson, simulate, replication, erasure, copiesFor }
