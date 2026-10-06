const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const { segmentOf } = require('./segments')
const { Roster } = require('./roster')

// What a member keeps (spec 007, research R7, US4).
//
//   all    — every segment of every channel, and the rosters in full: what
//            a helper runs, so it can serve old segments to anyone.
//   sparse — nothing beyond what is read (plain Hypercore behavior).
//   auto   — like all while the community fits the budget; past it, the
//            newest segments that fit (a window), dropping what falls out.
//
// A pass walks segments newest first across channels, works out each
// author's range in each segment from the roster (an entry's start up to
// the author's next entry, or the log's end), and downloads segment by
// segment. Closed segments are downloaded and their sessions closed: holding
// everything doesn't mean keeping thousands of logs open. Only the current
// segment's logs stay open, downloading live. Passes run when a roster grows
// or the control log changes, never on a timer.
//
// Sizes are estimates: blocks x (the log's average block size + what storing
// a block costs besides, STORED_OVERHEAD); Hypercore's storage-size info
// doesn't work on RocksDB storage.
// Reads beyond the window are not counted (gap: see research.md).

const TRACE = !!process.env.HG_V2_TRACE // per-segment timings on stderr
const trace = (...a) => { if (TRACE) process.stderr.write(`[replication ${process.pid}] ${a.join(' ')}\n`) }
// Stored per block beyond its own bytes: Merkle tree nodes, bitfield and
// RocksDB keys. Measured: a host holding 10M messages, 211 B on disk per
// ~80 B message; an auto window at 1M, ~215 B per ~86 B block. Counting
// content only, a 50 MB budget took 125 MB of disk.
const STORED_OVERHEAD = 130
const SETTLE_MS = 300 // batch the triggers of a burst into one pass
const LENGTH_MS = 2000 // waiting for a log's length from peers
const DOWNLOAD_MS = 30000 // one range's download, at most
const STALL_MS = 5000 // no block for this long and no peer: stalled
// Passes after logs were out of reach, and after a stalled download: that
// one needs the released logs to be dropped first (Corestore: ~8 s), which
// fresh sessions then reconnect (1M bench: retries at 2 s and 5 s stalled
// again, the one at 10 s went through).
const RETRY_MS = [2000, 5000, 10000, 30000, 60000, 120000]
const STALL_RETRY_MS = [10000, 20000, 40000, 80000, 120000]

class Replicator {
  /**
   * @param {Object} opts
   * @param {'all'|'sparse'|'auto'} opts.mode
   * @param {number} opts.budget - bytes (auto)
   * @param {Object} opts.store - Corestore (own sessions, closed independently of readers)
   * @param {() => Array<{ id, segmentMs, createdAt }>} opts.channels
   * @param {(channel) => Array<{ keeper, rosterKey }>} opts.keepers
   * @param {(rosters, channel, segment) => Promise<Array>} opts.entriesFrom - verified entries
   * @param {(rosters, max) => Promise<number>} opts.latestFrom
   */
  constructor ({ mode, budget, store, channels, keepers, entriesFrom, latestFrom }) {
    this.mode = mode
    this.budget = budget
    this.store = store
    this.channels = channels
    this.keepers = keepers
    this.entriesFrom = entriesFrom
    this.latestFrom = latestFrom

    this.held = new Map() // `${channel}:${segment}` -> { channel, segment, ranges, bytes }
    this.closedPlans = new Map() // same key -> ranges + bytes of a closed segment (final)
    this.fits = true
    this.passes = 0
    this.live = new Map() // log hex -> { core, range, ondownload, from } (current segment)
    this.liveBytes = 0 // live blocks beyond what the last pass planned
    // Its own roster sessions, apart from the reader's: holding a community
    // is not having its channels open (stats, closeChannel).
    this.rosters = new Map() // roster key hex -> { roster, core, range, onappend }
    this.byChannel = new Map() // channel -> Map(keeper -> Roster)
    this.timer = null
    this.retryTimer = null
    this.retries = 0
    this.running = null
    this.again = false
    this.closed = false
  }

  get holding () {
    if (this.mode === 'sparse') return 'read'
    if (this.mode === 'all') return 'all'
    return this.fits ? 'all' : 'window'
  }

  get heldBytes () {
    let n = this.liveBytes
    for (const item of this.held.values()) n += item.bytes
    return n
  }

  schedule () {
    if (this.closed || this.mode === 'sparse') return
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.run().catch(safetyCatch)
    }, SETTLE_MS)
  }

  async run () {
    if (this.closed) return
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        await this.pass()
      } while (this.again && !this.closed)
    })()
    try {
      await this.running
    } finally {
      this.running = null
    }
  }

  async close () {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.running) await this.running.catch(safetyCatch)
    for (const l of this.live.values()) await closeSession(l)
    for (const r of this.rosters.values()) {
      r.core.off('append', r.onappend)
      if (r.range) try { r.range.destroy() } catch (err) { safetyCatch(err) }
      await r.roster.close().catch(safetyCatch)
    }
    this.live.clear()
    this.rosters.clear()
    this.byChannel.clear()
  }

  async pass () {
    this.passes++
    this.liveBytes = 0 // the plan below counts the current segments again
    await this.watchRosters()
    const budget = this.mode === 'all' ? Infinity : this.budget
    const want = []
    let total = 0
    let fits = true
    const sessions = new Map()
    try {
      let tp = Date.now()
      for await (const item of this.segmentsNewestFirst(sessions)) {
        trace('plan', item.channel.slice(0, 6), item.segment, 'ranges', item.ranges.length, 'bytes', item.bytes, 'ms', Date.now() - tp)
        tp = Date.now()
        if (this.closed) return
        if (total + item.bytes > budget) { fits = false; break }
        total += item.bytes
        want.push(item)
      }
      let stalled = false
      let retry = false // some logs out of reach: try again later
      for (const item of want) {
        if (this.closed) return
        const key = `${item.channel}:${item.segment}`
        const th = Date.now()
        if (item.current) await this.holdLive(item, sessions)
        else if (!this.held.has(key)) await this.holdClosed(item, sessions)
        const done = (await this.complete(item, sessions)) && !item.unknown
        if (item.unknown) retry = true
        else if (!done) stalled = true
        if (done) this.held.set(key, item)
        trace('hold', item.segment, done ? 'complete' : 'INCOMPLETE', 'ms', Date.now() - th)
        if (!done && TRACE) {
          for (const r of item.ranges) {
            const core = await this.session(r.log, sessions)
            if (await core.has(r.start, r.end)) continue
            let have = 0
            for (let i = r.start; i < r.end; i++) if (await core.has(i)) have++
            trace('  stuck', r.log.slice(0, 8), `[${r.start},${r.end})`, 'have', have, 'peers', core.peers.length, 'length', core.length, 'contiguous', core.contiguousLength)
          }
        }
        // A segment that didn't come: the rest likely won't either (seen:
        // logs whose connection to the serving peer was gone, 0 peers,
        // while that peer was up). Stop, let this pass's sessions close,
        // and try again later with fresh ones.
        if (stalled) break
      }
      const wanted = new Set(want.map(i => `${i.channel}:${i.segment}`))
      for (const [key, item] of [...this.held]) {
        if (wanted.has(key)) continue
        await this.drop(item, sessions)
        this.held.delete(key)
      }
      // Live sessions for logs no longer in a current segment.
      const liveNow = new Set()
      for (const item of want) if (item.current) for (const r of item.ranges) liveNow.add(r.log)
      for (const [log, l] of [...this.live]) {
        if (liveNow.has(log)) continue
        this.live.delete(log)
        await closeSession(l)
      }
      this.fits = fits
      this.retryLater(stalled ? STALL_RETRY_MS : retry ? RETRY_MS : null)
    } finally {
      for (const core of sessions.values()) await core.close().catch(safetyCatch)
    }
  }

  retryLater (schedule) {
    if (!schedule) {
      this.retries = 0
      return
    }
    if (this.retryTimer || this.closed) return
    const ms = schedule[Math.min(this.retries++, schedule.length - 1)]
    trace('retry in', ms)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.schedule()
    }, ms)
    if (this.retryTimer.unref) this.retryTimer.unref()
  }

  // Each channel's segments newest first, merged by segment start across
  // channels, with each author's range and the estimated bytes.
  async * segmentsNewestFirst (sessions) {
    const now = Date.now()
    const cursors = []
    for (const ch of this.channels()) {
      const first = segmentOf(ch.createdAt || 0, ch.segmentMs)
      const current = segmentOf(now, ch.segmentMs)
      const later = new Map() // author -> start of their entry in a later segment
      const c = { ch, first, current, later, next: await this.latestFrom(this.rostersOf(ch.id), current) }
      if (c.next >= first) cursors.push(c)
    }
    while (cursors.length) {
      cursors.sort((a, b) => b.next * b.ch.segmentMs - a.next * a.ch.segmentMs)
      const c = cursors[0]
      const segment = c.next
      yield await this.plan(c, segment, sessions)
      c.next = segment - 1 >= c.first ? await this.latestFrom(this.rostersOf(c.ch.id), segment - 1) : -1
      if (c.next < c.first) cursors.shift()
    }
  }

  async plan (c, segment, sessions) {
    const channel = c.ch.id
    const key = `${channel}:${segment}`
    const current = segment >= c.current - 1 // still accepting entries
    const cached = !current && this.closedPlans.get(key)
    const entries = await this.entriesFrom(this.rostersOf(channel), channel, segment)
    if (cached) {
      for (const e of entries) c.later.set(e.author, e.start)
      return cached
    }
    const ranges = []
    let bytes = 0
    let unknown = false
    for (const e of entries) {
      const core = await this.session(e.log, sessions)
      const fromLater = c.later.has(e.author)
      if (!fromLater) await within(core.update({ wait: true }).catch(safetyCatch), LENGTH_MS)
      const end = fromLater ? c.later.get(e.author) : core.length
      c.later.set(e.author, e.start)
      if (end <= e.start) {
        // A listed author has a block at `start`: a shorter log is one no
        // peer could tell us about yet, not an empty range.
        if (!fromLater) unknown = true
        continue
      }
      ranges.push({ log: e.log, start: e.start, end })
      bytes += (end - e.start) * (averageBlock(core) + STORED_OVERHEAD)
    }
    const item = { channel, segment, ranges, bytes: Math.ceil(bytes), current, unknown }
    // A closed segment's plan is final, unless part of it couldn't be seen
    // (an earlier version kept that partial plan, and never fetched the rest).
    if (!current && !unknown) this.closedPlans.set(key, item)
    return item
  }

  async holdClosed (item, sessions) {
    await Promise.all(item.ranges.map(async (r) => this.fetch(await this.session(r.log, sessions), r)))
  }

  async holdLive (item, sessions) {
    for (const r of item.ranges) {
      const known = this.live.get(r.log)
      if (known) {
        known.from = Math.max(known.from, r.end)
        continue
      }
      const core = this.store.get({ key: b4a.from(r.log, 'hex') })
      await core.ready()
      const range = core.download({ start: r.start, end: -1 })
      // Blocks past what this pass planned add to what is held; re-plan only
      // once they take it over the budget (a pass per block chained passes
      // for as long as anyone posted).
      const l = { core, range, ondownload: null, from: r.end }
      l.ondownload = (index, byteLength) => {
        if (index < l.from) return
        this.liveBytes += byteLength + STORED_OVERHEAD
        if (this.mode === 'auto' && this.heldBytes > this.budget) this.schedule()
      }
      core.on('download', l.ondownload)
      this.live.set(r.log, l)
    }
    await Promise.all(item.ranges.map(async (r) => this.fetch(await this.session(r.log, sessions), r)))
  }

  // Download [start, end); give up after DOWNLOAD_MS, or sooner when nothing
  // arrived for STALL_MS and the log has no peer.
  async fetch (core, r) {
    const range = core.download({ start: r.start, end: r.end })
    let last = Date.now()
    const ondownload = () => { last = Date.now() }
    core.on('download', ondownload)
    const deadline = Date.now() + DOWNLOAD_MS
    try {
      await new Promise(resolve => {
        const check = setInterval(() => {
          const stalled = Date.now() - last > STALL_MS && core.peers.length === 0
          if (this.closed || stalled || Date.now() > deadline) finish()
        }, 250)
        const finish = () => { clearInterval(check); resolve() }
        range.done().then(finish, finish)
      })
    } finally {
      core.off('download', ondownload)
      range.destroy()
    }
  }

  async complete (item, sessions) {
    for (const r of item.ranges) {
      const core = await this.session(r.log, sessions)
      if (!(await core.has(r.start, r.end))) return false
    }
    return true
  }

  async drop (item, sessions) {
    for (const r of item.ranges) {
      const core = await this.session(r.log, sessions)
      if (core.writable) continue // the member's own messages: never dropped
      await core.clear(r.start, r.end).catch(safetyCatch)
    }
  }

  async session (logHex, sessions) {
    let core = sessions.get(logHex)
    if (!core) {
      core = this.store.get({ key: b4a.from(logHex, 'hex') })
      sessions.set(logHex, core)
      await core.ready()
    }
    return core
  }

  // Every channel's rosters: a pass when one grows; in 'all', held in full
  // so this peer can serve any segment's entries.
  async watchRosters () {
    for (const ch of this.channels()) {
      for (const { keeper, rosterKey } of this.keepers(ch.id)) {
        if (this.rosters.has(rosterKey)) continue
        const core = this.store.get({ key: b4a.from(rosterKey, 'hex') })
        const roster = new Roster(core, { extension: false })
        await roster.ready()
        if (core.length === 0) await within(core.update({ wait: true }).catch(safetyCatch), LENGTH_MS)
        const onappend = () => this.schedule()
        core.on('append', onappend)
        const range = this.mode === 'all' ? core.download({ start: 0, end: -1 }) : null
        this.rosters.set(rosterKey, { roster, core, range, onappend })
        this.rostersOf(ch.id).set(keeper, roster)
      }
    }
  }

  rostersOf (channel) {
    let m = this.byChannel.get(channel)
    if (!m) this.byChannel.set(channel, (m = new Map()))
    return m
  }
}

function averageBlock (core) {
  return core.length > 0 ? core.byteLength / core.length : 0
}

async function closeSession ({ core, range, ondownload }) {
  if (range) try { range.destroy() } catch (err) { safetyCatch(err) }
  if (ondownload) core.off('download', ondownload)
  await core.close().catch(safetyCatch)
}

async function within (promise, ms) {
  let timer = null
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms) })])
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { Replicator, STORED_OVERHEAD }
