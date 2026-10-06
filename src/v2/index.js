const ReadyResource = require('ready-resource')
const nodeCrypto = require('crypto')
const ProtomuxWakeup = require('protomux-wakeup')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const { Control, sign, mayAssign, RANK } = require('./control')
const { Roster, verifyEntry, signEntry } = require('./roster')
const { AuthorLog } = require('./author-log')
const { segmentOf, isFuture, FUTURE_MS } = require('./segments')

// Scaling v2 prototype (spec 007): a community where cost follows what a
// peer holds and reads. Unstable; not part of the v1 API. See
// docs/v2-prototype.md and specs/007-scaling-v2-prototype/.

const toHex = (k) => (b4a.isBuffer(k) ? b4a.toString(k, 'hex') : String(k))

function rosterKeyPair (identity, communityKey, channel) {
  const seed = identity.seed || nodeCrypto.createHash('sha256').update(identity.keyPair.secretKey).digest()
  return hcrypto.keyPair(nodeCrypto.createHash('sha256').update('hg-v2-roster\0').update(seed).update(communityKey).update(b4a.from(channel)).digest())
}

// Whichever first: the promise, or `ms`; the timer is cleared either way.
async function within (promise, ms) {
  let timer = null
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms) })])
  } finally {
    clearTimeout(timer)
  }
}

class Community extends ReadyResource {
  #store
  #identity
  #key
  #wakeup
  #control = null
  #ns = null
  #logs = new Map() // log key hex -> AuthorLog (others' logs, opened by key)
  #ownLogs = new Map() // channel id -> this member's AuthorLog
  #rosters = new Map() // channel id -> Map(keeper pubkey hex -> Roster)
  #kept = new Set() // channels this member keeps
  #announced = new Set() // `${channel}:${segment}` this member is listed in
  #pending = new Map() // `${channel}:${segment}` -> announcement, until listed
  #retry = null
  #unreachable = 0 // logs a read gave up on (last page)
  #follows = new Set() // stop functions of live follows

  /**
   * @param {Object} store - Corestore
   * @param {Object} opts
   * @param {{ keyPair: Object, seed?: Buffer }} opts.identity - the member
   * @param {Buffer|string} [opts.key] - an existing community; omit to create one
   */
  constructor (store, opts = {}) {
    super()
    if (!opts.identity || !opts.identity.keyPair) throw new Error('opts.identity.keyPair is required')
    this.#store = store
    this.#identity = opts.identity
    this.#key = opts.key ? b4a.from(toHex(opts.key), 'hex') : null
    this.#wakeup = new ProtomuxWakeup()
    this.ready().catch(() => {})
  }

  get key () { return this.#control ? this.#control.key : null }
  get localKey () { return this.#control ? this.#control.localKey : null }
  get identity () { return this.#identity }
  get control () { return this.#control }

  async _open () {
    // One namespace per community: two Autobases opened from the same
    // namespace get the same local writer key (bench/roster.js).
    const ns = this.#store.namespace('hg-v2:' + (this.#key ? toHex(this.#key) : toHex(hcrypto.randomBytes(16))))
    this.#ns = ns
    this.#control = new Control(ns, this.#key, { wakeup: this.#wakeup })
    await this.#control.ready()
    if (!this.#key) await this.#control.append(this.#sign({ type: 'init', name: '' }))
    // Rosters this member keeps, from an earlier session.
    const me = toHex(this.#identity.keyPair.publicKey)
    for (const [channel, keepers] of Object.entries(this.#control.state.keepers)) {
      if (keepers.some(k => k.keeper === me)) await this.#openOwnRoster(channel)
    }
  }

  async _close () {
    if (this.#retry) clearInterval(this.#retry)
    for (const stop of this.#follows) stop()
    for (const rosters of this.#rosters.values()) for (const r of rosters.values()) await r.close().catch(safetyCatch)
    for (const log of this.#logs.values()) await log.close().catch(safetyCatch)
    for (const log of this.#ownLogs.values()) await log.close().catch(safetyCatch)
    if (this.#control) await this.#control.close()
    this.#wakeup.destroy()
  }

  /** Wire a replication stream (the control log's writer discovery included). */
  replicate (isInitiatorOrStream, opts) {
    const stream = this.#store.replicate(isInitiatorOrStream, opts)
    this.#wakeup.addStream(stream)
    return stream
  }

  async update () {
    if (!this.opened) await this.ready()
    await this.#control.update()
  }

  // ── control state (synchronous: kept in memory, small) ───────────────────

  get #state () { return this.#control.state }
  role (pubkey) { const r = this.#state.roles[toHex(pubkey)]; return r ? r.role : null }
  roles () { return Object.fromEntries(Object.entries(this.#state.roles).map(([k, v]) => [k, v.role])) }
  channels () {
    return Object.entries(this.#state.channels).map(([id, c]) => ({ id, name: c.name, segmentMs: c.segmentMs }))
  }
  channel (id) { return this.#state.channels[id] || null }
  banned (pubkey) { return this.#state.bans[toHex(pubkey)] || null }
  hidden (author, log, seq) { return this.#state.hides[`${toHex(author)}:${toHex(log)}:${seq}`] || null }
  keepers (channelId) { return this.#state.keepers[channelId] || [] }

  // ── administration ───────────────────────────────────────────────────────

  #sign (event, keyPair = this.#identity.keyPair) {
    return sign(this.#control.hex, event, keyPair)
  }

  #myRole () { return this.role(this.#identity.keyPair.publicKey) }

  #requireWriter () {
    if (!this.#control.writable) throw new Error('This member is not a writer of the control log')
  }

  async setRole (pubkey, role, opts = {}) {
    if (!this.opened) await this.ready()
    const member = toHex(pubkey)
    if (!mayAssign(this.#myRole(), this.role(member), role || null)) throw new Error('Setting this role is not allowed for this member')
    this.#requireWriter()
    await this.#control.append(this.#sign({ type: 'role', member, role: role || null, writer: opts.writer ? toHex(opts.writer) : null }))
  }

  async createChannel ({ name = '', segmentMs = 3600000 } = {}) {
    if (!this.opened) await this.ready()
    if (!((RANK[this.#myRole()] || 0) >= RANK.admin)) throw new Error('Creating a channel is not allowed for this member')
    this.#requireWriter()
    const id = toHex(hcrypto.randomBytes(16))
    await this.#control.append(this.#sign({ type: 'channel', id, name, segmentMs }))
    return id
  }

  async ban (pubkey, { reason = '' } = {}) {
    if (!this.opened) await this.ready()
    await this.#moderate({ type: 'ban', member: toHex(pubkey), reason, cut: await this.#banCut(toHex(pubkey)) })
  }

  // The author's logs listed in the current or previous segment of each
  // channel, with the length this peer sees now. An author already listed
  // can keep appending to that log with times dated before the ban; the cut
  // stops those. (A log last listed in an older segment isn't found: there
  // the time rule alone applies, so backdated posts can show on scrollback
  // to that segment.)
  async #banCut (author) {
    const cut = {}
    for (const { id, segmentMs } of this.channels()) {
      const seg = segmentOf(Date.now(), segmentMs)
      for (const s of [seg - 1, seg]) {
        for (const e of await this.rosterEntries(id, s)) {
          if (e.author !== author || cut[e.log] !== undefined) continue
          const log = await this.#log(e.log)
          await within(log.update({ wait: true }).catch(safetyCatch), 1000)
          cut[e.log] = log.length
        }
      }
    }
    return cut
  }

  async unban (pubkey) {
    await this.#moderate({ type: 'unban', member: toHex(pubkey) })
  }

  async hide ({ author, log, seq }, { reason = '' } = {}) {
    await this.#moderate({ type: 'hide', member: toHex(author), log: toHex(log), seq, reason })
  }

  async #moderate (event) {
    if (!this.opened) await this.ready()
    if (!((RANK[this.#myRole()] || 0) >= RANK.mod)) throw new Error('Moderation is not allowed for this member')
    this.#requireWriter()
    await this.#control.append(this.#sign(event))
  }

  // ── keepers and rosters ──────────────────────────────────────────────────

  async #openOwnRoster (channel) {
    const me = toHex(this.#identity.keyPair.publicKey)
    const rosters = this.#rostersOf(channel)
    if (rosters.has(me) && rosters.get(me).writable) return rosters.get(me)
    // Derived from the identity, community and channel, like author logs:
    // the same roster after a restart and on any device. (Named in the
    // storage namespace, it came back empty under a new key after the
    // community was reopened by key, which every reader missed.)
    const roster = new Roster(this.#store.get({ keyPair: rosterKeyPair(this.#identity, this.key, channel) }), {
      onAnnouncement: (ann) => this.acceptAnnouncement(ann)
    })
    await roster.ready()
    rosters.set(me, roster)
    this.#kept.add(channel)
    return roster
  }

  #rostersOf (channel) {
    let m = this.#rosters.get(channel)
    if (!m) this.#rosters.set(channel, (m = new Map()))
    return m
  }

  // Open (lazily) every keeper's roster for a channel, as the control log
  // lists them.
  async #keeperRosters (channel) {
    const rosters = this.#rostersOf(channel)
    for (const { keeper, rosterKey } of this.keepers(channel)) {
      if (rosters.has(keeper)) continue
      const roster = new Roster(this.#store.get({ key: b4a.from(rosterKey, 'hex') }))
      await roster.ready()
      rosters.set(keeper, roster)
    }
    return rosters
  }

  /** As a keeper (role keeper or above): start keeping the channel's roster. */
  async keep (channel) {
    if (!this.opened) await this.ready()
    if (!this.channel(channel)) throw new Error('Unknown channel')
    if (!((RANK[this.#myRole()] || 0) >= RANK.keeper)) throw new Error('Keeping a roster is not allowed for this member')
    this.#requireWriter()
    const roster = await this.#openOwnRoster(channel)
    const me = toHex(this.#identity.keyPair.publicKey)
    if (!this.keepers(channel).some(k => k.keeper === me)) {
      await this.#control.append(this.#sign({ type: 'keeper', channel, rosterKey: toHex(roster.key) }))
    }
  }

  /**
   * Keeper side: list an author if the announcement checks out. Returns
   * whether the author is (now) listed.
   */
  async acceptAnnouncement (ann) {
    if (!this.opened) await this.ready()
    const channel = this.channel(ann.channel)
    if (!channel || !this.#kept.has(ann.channel)) return false
    const me = toHex(this.#identity.keyPair.publicKey)
    const roster = this.#rostersOf(ann.channel).get(me)
    if (!roster || !roster.writable) return false
    const current = segmentOf(Date.now(), channel.segmentMs)
    if (ann.segment < current - 1 || ann.segment > current + 1) return false
    if (this.banned(ann.author)) return false
    if (!verifyEntry(this.key, ann.channel, ann.segment, ann)) return false
    if (!(await roster.has(ann.segment, ann.author))) {
      await roster.put(ann.segment, ann.author, { log: ann.log, start: ann.start, sig: ann.sig })
    }
    return true
  }

  /**
   * A segment's roster across every keeper: entries whose signature checks
   * out, one per author (the lowest start). `opts.keeper` reads one keeper.
   *
   * @returns {Promise<Array<{ author: string, log: string, start: number }>>}
   */
  async rosterEntries (channel, segment, opts = {}) {
    if (!this.opened) await this.ready()
    const rosters = await this.#keeperRosters(channel)
    const byAuthor = new Map()
    for (const [keeper, roster] of rosters) {
      if (opts.keeper && keeper !== opts.keeper) continue
      let entries = []
      try {
        entries = await roster.segment(segment)
      } catch (err) {
        safetyCatch(err)
        continue
      }
      for (const e of entries) {
        if (!verifyEntry(this.key, channel, segment, e)) continue
        const author = toHex(e.author)
        const known = byAuthor.get(author)
        if (!known || e.start < known.start) byAuthor.set(author, { author, log: toHex(e.log), start: e.start })
      }
    }
    return [...byAuthor.values()]
  }

  /** The highest segment ≤ max with any roster entry, across keepers, or -1. */
  async latestSegment (channel, max) {
    const rosters = await this.#keeperRosters(channel)
    let best = -1
    for (const roster of rosters.values()) {
      try {
        best = Math.max(best, await roster.latestSegment(max))
      } catch (err) {
        safetyCatch(err)
      }
    }
    return best
  }

  // ── posting ──────────────────────────────────────────────────────────────

  async #ownLog (channel) {
    let log = this.#ownLogs.get(channel)
    if (!log) {
      log = new AuthorLog(this.#store, { keyPair: AuthorLog.keyPairFor(this.#identity, this.key, channel) })
      await log.ready()
      this.#ownLogs.set(channel, log)
    }
    return log
  }

  /**
   * Post a message to a channel: appended to this member's own log for the
   * channel, no agreement with anyone needed. The first post in a segment
   * announces this member to the channel's keepers.
   *
   * @returns {Promise<{ author: string, log: string, seq: number, t: number }>}
   */
  async post (channel, text, opts = {}) {
    if (!this.opened) await this.ready()
    const record = this.channel(channel)
    if (!record) throw new Error('Unknown channel')
    if (this.banned(this.#identity.keyPair.publicKey)) throw new Error('This member is banned')
    const log = await this.#ownLog(channel)
    const reply = opts.reply ? { log: b4a.from(toHex(opts.reply.log), 'hex'), seq: opts.reply.seq } : null
    const { seq, t } = await log.append({ text, reply })
    const segment = segmentOf(t, record.segmentMs)
    if (!this.#announced.has(`${channel}:${segment}`)) await this.#announce(channel, segment, log, seq)
    return { author: toHex(this.#identity.keyPair.publicKey), log: toHex(log.key), seq, t }
  }

  async #announce (channel, segment, log, start) {
    const id = `${channel}:${segment}`
    const ann = {
      channel,
      segment,
      author: this.#identity.keyPair.publicKey,
      log: log.key,
      start,
      sig: signEntry(this.key, channel, segment, log.key, start, this.#identity.keyPair)
    }
    this.#announced.add(id)
    this.#pending.set(id, ann)
    if (this.#kept.has(channel)) await this.acceptAnnouncement(ann)
    await this.#sendPending()
    if (!this.#retry) {
      // Until a keeper lists it: a keeper may not be connected yet.
      this.#retry = setInterval(() => this.#sendPending().catch(safetyCatch), 500)
      if (this.#retry.unref) this.#retry.unref()
    }
  }

  async #sendPending () {
    for (const [id, ann] of this.#pending) {
      const rosters = await this.#keeperRosters(ann.channel)
      let listed = false
      for (const roster of rosters.values()) {
        try {
          if (await roster.has(ann.segment, ann.author)) { listed = true; break }
        } catch (err) {
          safetyCatch(err)
        }
      }
      if (listed) {
        this.#pending.delete(id)
        continue
      }
      for (const roster of rosters.values()) if (!roster.writable) roster.announce(ann)
    }
    if (this.#pending.size === 0 && this.#retry) {
      clearInterval(this.#retry)
      this.#retry = null
    }
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async #log (logHex) {
    for (const own of this.#ownLogs.values()) if (toHex(own.key) === logHex) return own
    let log = this.#logs.get(logHex)
    if (!log) {
      log = new AuthorLog(this.#store, { key: b4a.from(logHex, 'hex') })
      await log.ready()
      this.#logs.set(logHex, log)
    }
    return log
  }

  // A log's length as far as peers say within `timeout` (its local length if
  // nobody answers).
  async #length (log, timeout) {
    if (log.writable) return log.length
    await within(log.update({ wait: true }).catch(safetyCatch), timeout)
    return log.length
  }

  #shape (author, logHex, m) {
    const hidden = !!this.hidden(author, logHex, m.seq)
    return { author, log: logHex, seq: m.seq, t: m.t, text: hidden ? null : m.text, hidden }
  }

  #visible (author, logHex, m) {
    if (isFuture(m.t)) return false
    const ban = this.banned(author)
    if (!ban) return true
    const cut = ban.cut && ban.cut[logHex]
    return cut !== undefined ? m.seq < cut : m.t <= ban.at
  }

  // Newest messages with t < beforeT, at most `limit`, newest first. Walks
  // back from the newest segment that has roster entries; each listed
  // author's messages in a segment are read from their newest down. Older
  // segments only hold older messages, so it stops once a page is full.
  async #page (channel, beforeT, limit, timeout) {
    const record = this.channel(channel)
    if (!record) throw new Error('Unknown channel')
    const first = segmentOf(record.createdAt, record.segmentMs)
    const startT = Number.isFinite(beforeT) ? beforeT : Date.now() + FUTURE_MS
    let seg = segmentOf(startT, record.segmentMs)
    const later = new Map() // author -> where their entry in a later segment starts
    const out = []
    let unreachable = 0
    while (seg >= first) {
      seg = await this.latestSegment(channel, seg)
      if (seg < 0) break
      const entries = await this.rosterEntries(channel, seg)
      await Promise.all(entries.map(async (e) => {
        const log = await this.#log(e.log)
        const end = later.has(e.author) ? later.get(e.author) : await this.#length(log, timeout)
        let got = 0
        for (let i = end - 1; i >= e.start && got < limit; i--) {
          let m = null
          try {
            m = await log.get(i, { timeout })
          } catch (err) {
            safetyCatch(err)
          }
          if (!m) { unreachable++; break }
          if (m.t >= beforeT || !this.#visible(e.author, e.log, m)) continue
          out.push(this.#shape(e.author, e.log, m))
          got++
        }
      }))
      for (const e of entries) later.set(e.author, e.start)
      if (out.length >= limit) break
      seg--
    }
    this.#unreachable = unreachable
    // Newest first: by time, then author, then seq, all descending: the
    // exact reverse of the order every peer agrees on.
    out.sort((x, y) => (y.t - x.t) || (y.author < x.author ? -1 : y.author > x.author ? 1 : 0) || (y.seq - x.seq))
    return out.slice(0, limit)
  }

  /**
   * The latest messages of a channel, newest first.
   *
   * @param {string} channel
   * @param {{ limit?: number, timeout?: number }} [opts] - timeout: ms to
   *   wait for an author's log before leaving it out (stats().unreachable)
   */
  async latest (channel, { limit = 50, timeout = 5000 } = {}) {
    if (!this.opened) await this.ready()
    return this.#page(channel, Infinity, limit, timeout)
  }

  /** Scrollback: the messages before time `t`, newest first. */
  async before (channel, { t, limit = 50, timeout = 5000 } = {}) {
    if (!this.opened) await this.ready()
    return this.#page(channel, t, limit, timeout)
  }

  /**
   * Follow a channel live: `onmessage` gets other members' new posts in the
   * current segment, once each, in each author's order.
   *
   * @returns {() => void} stop
   */
  follow (channel, onmessage, opts = {}) {
    const me = toHex(this.#identity.keyPair.publicKey)
    const watched = new Map() // log hex -> { author, next, log, onappend, range }
    let stopped = false
    let initial = true // the first scan: what is already there is history
    const since = Date.now()

    const drain = async (w) => {
      while (!stopped && w.next < w.log.length) {
        const seq = w.next++
        let m = null
        try {
          m = await w.log.get(seq)
        } catch (err) {
          safetyCatch(err)
        }
        if (m && m.t >= since && this.#visible(w.author, toHex(w.log.key), m)) onmessage(this.#shape(w.author, toHex(w.log.key), m))
      }
    }

    let scanning = false
    let rescan = false
    // A roster that grows means someone may have posted for the first time
    // in this segment: scan right away instead of waiting for the poll.
    const hooked = new Set()
    const onroster = () => scan().catch(safetyCatch)
    const watch = async (e, first) => {
      const log = await this.#log(e.log)
      if (first) await within(log.update({ wait: true }).catch(safetyCatch), 2000)
      // Authors found by the first scan: their messages so far are history.
      // Authors listed later: everything from their entry, as long as it was
      // posted since following began.
      const w = { author: e.author, log, next: first ? Math.max(e.start, log.length) : e.start }
      w.onappend = () => drain(w).catch(safetyCatch)
      log.core.on('append', w.onappend)
      w.range = log.core.download({ start: w.next, end: -1 })
      watched.set(e.log, w)
      w.onappend() // anything already there since following began
    }
    const scan = async () => {
      // One scan at a time (the timer would otherwise overlap a slow one and
      // watch the same author twice); new authors are set up in parallel.
      if (stopped) return
      if (scanning) { rescan = true; return } // once this one ends
      scanning = true
      try {
        const record = this.channel(channel)
        if (!record) return
        for (const roster of (await this.#keeperRosters(channel)).values()) {
          if (hooked.has(roster)) continue
          hooked.add(roster)
          roster.core.on('append', onroster)
        }
        const seg = segmentOf(Date.now(), record.segmentMs)
        const fresh = []
        for (const s of [seg - 1, seg]) {
          for (const e of await this.rosterEntries(channel, s)) {
            if (e.author === me || watched.has(e.log) || fresh.some(f => f.log === e.log)) continue
            fresh.push(e)
          }
        }
        const first = initial
        initial = false
        for (const e of fresh) watched.set(e.log, null) // claimed
        await Promise.all(fresh.map(e => watch(e, first).catch(err => { watched.delete(e.log); safetyCatch(err) })))
      } finally {
        scanning = false
        if (rescan && !stopped) {
          rescan = false
          scan().catch(safetyCatch)
        }
      }
    }

    scan().catch(safetyCatch)
    // Still polled: a keeper that joins later has a roster nobody hooked yet.
    const timer = setInterval(() => scan().catch(safetyCatch), opts.pollMs || 500)
    if (timer.unref) timer.unref()
    const stop = () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      for (const roster of hooked) roster.core.off('append', onroster)
      for (const w of watched.values()) {
        if (!w) continue
        w.log.core.off('append', w.onappend)
        try { w.range.destroy() } catch (err) { safetyCatch(err) }
      }
      this.#follows.delete(stop)
    }
    this.#follows.add(stop)
    return stop
  }

  async stats () {
    let rosterKeepers = 0
    for (const m of this.#rosters.values()) rosterKeepers += m.size
    return {
      openLogs: this.#logs.size + this.#ownLogs.size,
      rosterKeepers,
      unreachable: this.#unreachable,
      controlLength: this.#control.base.length
    }
  }

  // ── test hooks (prototype only) ──────────────────────────────────────────

  /**
   * Post as another identity through this peer (benchmarks: many authors in
   * one process without one control log replica each). Same log and
   * announcement as that identity's own post() would produce.
   */
  async postAs (identity, channel, text) {
    const record = this.channel(channel)
    if (!record) throw new Error('Unknown channel')
    const author = toHex(identity.keyPair.publicKey)
    const id = `${author}:${channel}`
    let log = this.#ownLogs.get(id)
    if (!log) {
      log = new AuthorLog(this.#store, { keyPair: AuthorLog.keyPairFor(identity, this.key, channel) })
      await log.ready()
      this.#ownLogs.set(id, log)
    }
    const { seq, t } = await log.append({ text })
    const segment = segmentOf(t, record.segmentMs)
    const announced = `${author}:${channel}:${segment}`
    if (!this.#announced.has(announced)) {
      this.#announced.add(announced)
      const ann = { channel, segment, author: identity.keyPair.publicKey, log: log.key, start: seq, sig: signEntry(this.key, channel, segment, log.key, seq, identity.keyPair) }
      this.#pending.set(announced, ann)
      if (this.#kept.has(channel)) await this.acceptAnnouncement(ann)
      await this.#sendPending()
      if (!this.#retry) {
        this.#retry = setInterval(() => this.#sendPending().catch(safetyCatch), 500)
        if (this.#retry.unref) this.#retry.unref()
      }
    }
    return { author, log: toHex(log.key), seq, t }
  }

  /** Post with a given time, announcing for its segment (tests). */
  /** Length of an author log as this peer knows it (after a short update). */
  async logLength (logKey) {
    const log = await this.#log(toHex(logKey))
    await within(log.update({ wait: true }).catch(safetyCatch), 1000)
    return log.length
  }

  async postRaw (channel, { t, text }) {
    const record = this.channel(channel)
    const log = await this.#ownLog(channel)
    const { seq } = await log.appendRaw({ t, text })
    const segment = segmentOf(t, record.segmentMs)
    if (!this.#announced.has(`${channel}:${segment}`)) await this.#announce(channel, segment, log, seq)
    return { seq, t }
  }

  /** As a keeper, write a roster entry without any check (tests forging). */
  async writeRosterEntryUnchecked (channel, segment, entry) {
    const roster = await this.#openOwnRoster(channel)
    await roster.put(segment, entry.author, entry)
  }

  /** Append an event signed by another key pair, through this peer's writer. */
  async appendAs (keyPair, event) {
    this.#requireWriter()
    await this.#control.append(this.#sign(event, keyPair))
  }

  /** Append an event claiming `author` but signed by `signer`. */
  async appendForged (event, author, signer) {
    this.#requireWriter()
    const signed = this.#sign(event, signer)
    signed.author = toHex(author)
    await this.#control.append(signed)
  }
}

module.exports = { Community }
