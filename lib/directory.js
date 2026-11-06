// The log directory and the space channel (research R10; experiment 1). A
// space's directory is the set of device logs known to write in it. Members
// exchange it on a Protomux channel per space ('hypergraph/space/3', id = the
// space key): on open, a summary (count + XOR digest); if different, the
// lists are settled by key ranges (spec 016, lib/ranges.js): what each lacks,
// not the whole list; a newly accepted log is announced with a notice. The summary is
// sent again when the directory changes and every SUMMARY_MS, so a log whose
// single notice was missed (lost, or its header fetch timed out) still
// arrives without a reconnect. Before keeping
// or passing a log on, a member fetches its header and checks it (lib/gate.js):
// a log whose author may not write is never kept nor passed on; if the
// membership decision may still come, the log waits in `pending` (bounded)
// and is checked again when the decisions change. A log whose author lost the
// right to write later is cut (lib/index/indexer.js): kept up to its cut, or
// dropped if nothing in it counts.
//
// Spec 017: a held log's core is open only while it is used: `open(log)` /
// `release(log)` (or `use`, `get`, `has`) count uses, and the core closes
// IDLE_MS after the last. Its length and size are kept on the entry. Each
// summary entry covers the log's length (lib/ranges.js), so the exchange that
// finds a missing log also finds one a peer holds more of: a claim, which opens
// the log to download it. A closed log is heard (lib/replication.js unheard)
// only while every connected peer's last summary was settled with this member
// (`settled()`); a claim nobody serves within CLAIM_MS is dropped and shown
// in status (UNSERVED_LENGTH).

const c = require('compact-encoding')
const b4a = require('b4a')
const z32 = require('z32')
const crypto = require('hypercore-crypto')
const safetyCatch = require('safety-catch')
const enc = require('./encodings.js')
const gate = require('./gate.js')
const { Identity } = require('./identity.js')
const symbols = require('./symbols.js')
const activity = require('./activity.js')
const ranges = require('./ranges.js')

// spec 016: /2 settles lists by ranges; spec 017: /3 with log lengths. Peers of
// another version don't pair (Protomux pairs by name) and are told apart
// (OTHER_PROTOCOLS: status warning)
const PROTOCOL = 'hypergraph/space/3'
const OTHER_PROTOCOLS = ['hypergraph/space', 'hypergraph/space/2']
const OTHER_PROTOCOL = OTHER_PROTOCOLS[1] // the previous one
const IDLE_MS = 30000 // a log unused this long closes (spec 017)
const CLAIM_MS = 60000 // a longer length a peer claimed, not served this long after it opened: dropped
const HEADER_MS = 10000 // waiting for a log's header from peers
const MAX_PENDING = 1000
const SUMMARY_MS = 10000 // the summary is sent again this often (plus up to a second)
const CHANGED_MS = 250 // and this long after the directory changed
const SECOND_MS = 500 // spec 016: the connection's responder starts a range exchange this late, if the initiator didn't
const SOME = 16 // logs learnt from activity entries: headers fetched at once (story 9)
const MAX_SOME = 256 // and waiting (more are dropped: entries for them come again)
const FETCHES = 16 // log headers fetched at once, whoever told us of the logs (SC-006)
const MAX_QUEUE = 1024 // and waiting; more are dropped: a peer's summary brings them again
const [NS_INITIATOR, NS_RESPONDER] = crypto.namespace(PROTOCOL, 2)

const hex = (b) => b4a.toString(b, 'hex')
const EMPTY = b4a.alloc(0)

class Directory {
  // space: key, discoveryKey, getCore(key), state, limitOf(), mayRetry(),
  // accepted(log), redeem(bytes) (lib/space.js)
  constructor (space) {
    this.space = space
    this.logs = new Map() // hex -> a held log (see accept())
    this.pending = new Map() // hex -> { key, identity } (valid, author not a member yet)
    this.byIdentity = new Map() // identity hex -> Set of log hex, held or pending: recheck() of a few identities
    this.refused = new Set() // hex: bad headers, never fetched again
    this.inflight = new Map() // hex -> the header fetch under way
    this.queue = new Map() // hex -> { key, resolve }: fetches waiting for a turn (FETCHES at once)
    this.urgent = 0 // fetches running for members' notices (their own FETCHES)
    this.channels = new Set()
    this.reached = false // a summary came from a peer since opening
    this.known = false // a peer's whole directory was looked at (or matched this one) since opening
    this.sorted = new ranges.Keys() // the held logs' keys and lengths, for range exchanges
    this.unserved = new Map() // hex -> { peer, length }: claims nobody served (spec 017)
    this.others = new Set() // muxes whose peer opened the channel of another version (spec 016)
    this.closed = false
    this.timers = new Set()
    this.some = [] // logs learnt from activity entries, waiting for a header fetch
    this.someRunning = 0
    this.#every()
  }

  get peers () { return this.channels.size }

  // The summary's digest: every held log's key and length (spec 017).
  get digest () { return this.sorted.digest }

  keys () {
    return [...this.logs.values()].map((l) => l.key)
  }

  // A log that passed the gate (or was stored as such before).
  // from: the first block read here (story 9; null: none yet, a big space's
  // log outside the periods read); act: where deriving its activity entries
  // stands.
  // admitted: the admission code its header carries (story 9).
  // core: open, or null (spec 017: a closed log, its `length` and
  // `byteLength` as last known).
  async accept (key, core, who, { indexed = 1, own = false, announce = true, limit = Infinity, cut = null, from, act = null, admitted = null, length = 0, byteLength = 0, handed = -1, handedTo = null } = {}) {
    const h = hex(key)
    if (this.logs.has(h) || this.closed) return null
    if (from === undefined) from = own ? 1 : await this.space.fromOf(key)
    if (this.logs.has(h) || this.closed) return null
    const start = from === null ? indexed : Math.max(indexed, from)
    // indexed: every block below it is done (kept or skipped); scanned: the
    // next block to look at; holes: blocks below `scanned` not held yet
    // (lib/index/indexer.js); limit: a cut, or Infinity; skip: blocks done
    // already, when reading starts earlier (story 9).
    // core: null while closed (spec 017); uses: open() calls not released;
    // claim: a longer length a peer's summary gave (0: none); handed: its
    // length at the last hand-off to helpers, handedTo: which list of them
    // (lib/helpers.js), both saved with its length.
    const log = { key, core: null, uses: 0, opening: null, closing: null, idleTimer: null, length, byteLength, saved: null, claim: 0, claimAt: 0, claimBy: null, handed, handedTo, identity: who.identity, device: who.device, indexed: start, scanned: start, holes: new Set(), arrived: new Set(), limit, cut, own, admitted, acceptedAt: Date.now(), indexing: null, again: false, dropped: 0, droppedBlocks: 0, ixBytes: 0, from, skip: null, act: act || { next: from || 1, last: (from || 1) - 1, period: -1 } }
    log.saved = savedOf(log)
    this.logs.set(h, log)
    this.pending.delete(h)
    this.#index(h, log.identity)
    if (core) this.#attach(log, core)
    this.sorted.set(key, counted(log))
    this.#changed()
    await this.space.accepted(log)
    if (announce) for (const ch of this.channels) ch.messages[3].send(key)
    this.#idle(log)
    return log
  }

  // --- spec 017: cores open while used ---

  // The log's core, open until release(log).
  async open (log) {
    if (this.closed) throw closedError()
    log.uses++
    if (log.idleTimer) {
      clearTimeout(log.idleTimer)
      this.timers.delete(log.idleTimer)
      log.idleTimer = null
    }
    if (log.core) return log.core
    if (!log.opening) log.opening = this.#openCore(log).finally(() => { log.opening = null })
    try {
      await log.opening
    } catch (err) {
      this.release(log)
      throw err
    }
    return log.core
  }

  release (log) {
    if (log.uses > 0) log.uses--
    this.#idle(log)
  }

  async use (log, fn) {
    const core = await this.open(log)
    try {
      return await fn(core)
    } finally {
      this.release(log)
    }
  }

  get (log, seq, opts) {
    return this.use(log, (core) => core.get(seq, opts))
  }

  has (log, start, end) {
    return this.use(log, (core) => core.has(start, end))
  }

  async #openCore (log) {
    while (log.closing) await log.closing
    if (log.core) return
    const core = this.space.getCore(log.key)
    try {
      await core.ready()
    } catch (err) {
      await core.close().catch(safetyCatch)
      throw err
    }
    if (this.closed || this.logs.get(hex(log.key)) !== log) {
      await core.close().catch(safetyCatch)
      throw closedError()
    }
    this.#attach(log, core)
  }

  #attach (log, core) {
    log.core = core
    const measure = () => this.measure(log)
    core.on('append', measure)
    core.on('truncate', measure)
    this.measure(log)
    this.space.opened(log) // the replicator follows it (lib/replication.js)
  }

  // Unused: closed after the idle delay. A log this member writes in stays
  // open, and so do all for a member reading by activity lists (story 9:
  // research R8 of spec 017).
  #idle (log) {
    if (log.uses > 0 || !log.core || log.idleTimer || log.own || this.closed || this.space.byActivity) return
    log.idleTimer = this.#later(this.space.idleMs || IDLE_MS, () => {
      log.idleTimer = null
      this.#closeCore(log).catch(safetyCatch)
    })
  }

  async #closeCore (log) {
    if (log.uses > 0 || !log.core || log.opening || this.closed) return
    const core = log.core
    this.measure(log)
    log.core = null
    this.space.closedLog(log)
    log.closing = core.close().catch(safetyCatch)
    await log.closing
    log.closing = null
    await this.#save(log)
  }

  // The length and size kept for when it's closed (FR-001), and what was
  // handed to helpers, saved if changed.
  async #save (log) {
    const now = savedOf(log)
    if (now === log.saved) return
    log.saved = now
    await this.space.saveLog(log).catch(safetyCatch)
  }

  // The open core's length changed: the entry, its summary item, a claim met.
  measure (log) {
    if (log.core && log.core.opened) {
      log.length = log.core.length
      log.byteLength = log.core.byteLength
    }
    if (log.claim && counted(log) >= Math.min(log.claim, log.limit)) this.#unclaim(log)
    if (this.logs.get(hex(log.key)) !== log) return
    const before = this.sorted.lengthOf(log.key)
    this.sorted.set(log.key, counted(log))
    if (before !== this.sorted.lengthOf(log.key)) this.#changed()
  }

  // A peer holds more of a held log: opened and downloaded (lib/replication.js).
  #claim (log, length, ch) {
    if (log.own || length <= counted(log) || length <= log.claim) return
    log.claim = length
    log.claimAt = Date.now()
    log.claimBy = ch.peer
    this.space.behind(log)
  }

  #unclaim (log) {
    log.claim = 0
    log.claimBy = null
    if (this.unserved.delete(hex(log.key))) this.space.peersChanged()
  }

  // A claim not served within CLAIM_MS: dropped, shown in status (a lie, or
  // nobody online holds the blocks).
  expire (log, now = Date.now()) {
    if (!log.claim || now - log.claimAt < (this.space.claimMs || CLAIM_MS)) return false
    this.unserved.set(hex(log.key), { peer: log.claimBy, length: log.claim })
    log.claim = 0
    log.claimBy = null
    this.space.peersChanged()
    return true
  }

  // Has every connected peer's last summary been settled with this member
  // (the same digest, or an exchange about it finished)? Then a closed log
  // has nothing more at them (spec 017, FR-005).
  settled () {
    for (const ch of this.channels) if (!ch.theirs || ch.theirs !== ch.settledOn) return false
    return true
  }

  // Held logs (not this device's) whose core is open (lib/testing.js openLogs).
  openLogs () {
    return [...this.logs.values()].filter((l) => l.core && !l.own)
  }

  // Closing the space, once nothing reads any more: every log it opened is
  // closed, those opening included (FR-009), and their lengths saved. This
  // device's own logs are closed by the space.
  async closeCores () {
    const all = [...this.logs.values()]
    await Promise.all(all.map((l) => l.opening && l.opening.catch(safetyCatch)))
    await Promise.all(all.map(async (log) => {
      if (log.idleTimer) clearTimeout(log.idleTimer)
      log.idleTimer = null
      if (log.closing) await log.closing
      const core = log.core
      if (!core) return
      this.measure(log)
      if (!log.own) {
        log.core = null
        await core.close().catch(safetyCatch)
      }
      await this.#save(log)
    }))
  }

  // A log learnt from an activity entry (story 9): its header is fetched and
  // checked like any, a few at a time; more wait, up to MAX_SOME (throwaway
  // keys cost a bounded queue, not storage).
  considerSome (key) {
    const h = hex(key)
    if (this.closed || this.logs.has(h) || this.refused.has(h) || this.inflight.has(h) || this.pending.has(h)) return
    if (this.some.some((k) => b4a.equals(k, key))) return
    if (this.some.length >= MAX_SOME) return
    this.some.push(key)
    this.#drainSome()
  }

  #drainSome () {
    while (this.someRunning < SOME && this.some.length && !this.closed) {
      const key = this.some.shift()
      this.someRunning++
      this.consider(key).catch(safetyCatch).finally(() => {
        this.someRunning--
        const h = hex(key)
        if (this.refused.has(h)) this.space.activity.logRefused(key)
        this.#drainSome()
      })
    }
  }

  // Someone told us of `key`: fetch its header, check it, keep it or not.
  // Resolves to false if it was dropped (too many waiting). `urgent`: a
  // member's notice (spec 016: a log is announced at its first record), not
  // stuck behind keys anyone can name in bulk.
  async consider (key, urgent = false) {
    const h = hex(key)
    if (this.closed || this.logs.has(h) || this.refused.has(h)) return true
    if (this.inflight.has(h)) return this.inflight.get(h)
    const waiting = this.pending.get(h)
    if (waiting) {
      if (this.space.limitOf(waiting.identity, waiting.device, key, waiting.admitted) > 1) return this.#fetch(key, urgent)
      return true
    }
    return this.#fetch(key, urgent)
  }

  // Any peer, member or not, can name log keys (notices, lists): FETCHES
  // headers are fetched at once, up to MAX_QUEUE wait, more are dropped. A
  // flood of made-up keys costs a bounded queue, not a log opened per key.
  #fetch (key, urgent = false) {
    const h = hex(key)
    const queued = this.queue.get(h)
    if (queued && !urgent) return queued.done
    urgent = urgent && this.urgent < FETCHES
    if (queued && urgent) {
      this.queue.delete(h)
      queued.resolve(this.#fetch(key, true))
      return queued.done
    }
    if (!urgent && this.inflight.size - this.urgent >= FETCHES) {
      if (this.queue.size >= MAX_QUEUE) return Promise.resolve(false)
      let resolve = null
      const done = new Promise((r) => { resolve = r })
      this.queue.set(h, { key, resolve, done })
      return done
    }
    const run = this.#fetchOnce(key).then(() => true)
    this.inflight.set(h, run)
    if (urgent) this.urgent++
    run.catch(safetyCatch).finally(() => {
      if (urgent) this.urgent--
      if (this.inflight.get(h) === run) this.inflight.delete(h)
      this.#nextFetch()
    })
    return run
  }

  #nextFetch () {
    while (this.inflight.size - this.urgent < FETCHES && this.queue.size && !this.closed) {
      const [h, { key, resolve }] = this.queue.entries().next().value
      this.queue.delete(h)
      resolve(this.consider(key))
    }
  }

  async #fetchOnce (key) {
    const h = hex(key)
    const core = this.space.getCore(key)
    let keep = false
    try {
      await core.ready()
      const header = await core.get(0, { timeout: HEADER_MS })
      if (this.closed) return
      const res = gate.checkLog(header, key, this.space.key, this.space)
      if (res.ok) {
        keep = true
        await this.accept(key, core, res, { limit: res.limit, admitted: res.admitted })
      } else if (res.retry) {
        if (this.pending.size >= MAX_PENDING) {
          const [old, { identity }] = this.pending.entries().next().value
          this.pending.delete(old)
          this.#unindex(old, identity)
        }
        this.pending.set(h, { key, identity: res.identity, device: res.device, admitted: res.admitted })
        this.#index(h, res.identity)
      } else {
        this.refused.add(h)
        this.space.activity.logRefused(key)
      }
    } catch (err) {
      safetyCatch(err) // no header within the bound: someone may offer it again
    } finally {
      if (!keep) {
        await core.clear(0, 1).catch(safetyCatch)
        await core.close().catch(safetyCatch)
      }
    }
  }

  #index (h, identity) {
    const id = hex(identity)
    if (!this.byIdentity.has(id)) this.byIdentity.set(id, new Set())
    this.byIdentity.get(id).add(h)
  }

  #unindex (h, identity) {
    if (this.logs.has(h) || this.pending.has(h)) return
    const id = hex(identity)
    const set = this.byIdentity.get(id)
    if (set && set.delete(h) && !set.size) this.byIdentity.delete(id)
  }

  // The decisions changed: logs waiting for a membership may pass now, and
  // held logs whose author lost the right to write are cut. Resolves once
  // those cuts are indexed (F14). `touched` (lib/decisions/state.js): only
  // the logs of the identities a decision touched; null: every log.
  recheck (touched = null) {
    const space = this.space
    const only = touched && !touched.all ? [...touched.ids].flatMap((id) => [...(this.byIdentity.get(id) || [])]) : null
    const pending = only ? only.map((h) => this.pending.get(h)).filter(Boolean) : [...this.pending.values()]
    for (const { key, identity, device, admitted } of pending) {
      if (space.limitOf(identity, device, key, admitted) > 1) this.consider(key).catch(safetyCatch)
    }
    const cuts = []
    for (const log of only ? only.map((h) => this.logs.get(h)).filter(Boolean) : [...this.logs.values()]) {
      const limit = space.limitOf(log.identity, log.device, log.key, log.admitted)
      if (limit < log.limit || (log.cut !== limit && limit !== Infinity)) cuts.push(this.space.cut(log, limit))
    }
    return Promise.all(cuts)
  }

  // A log cut before anything in it counted: not kept, not passed on.
  drop (log) {
    const h = hex(log.key)
    if (!this.logs.delete(h)) return
    this.#unindex(h, log.identity)
    this.sorted.delete(log.key)
    this.refused.add(h)
    this.#changed()
  }

  // The summary to every peer, every SUMMARY_MS.
  #every () {
    if (this.closed) return
    this.#later(SUMMARY_MS + Math.floor(Math.random() * 1000), () => {
      this.#sendSummary()
      this.#every()
    })
  }

  // The directory changed: the summary soon (once for a burst of changes).
  #changed () {
    if (this._changedTimer || this.closed) return
    this._changedTimer = this.#later(CHANGED_MS, () => {
      this._changedTimer = null
      this.#sendSummary()
    })
  }

  #later (ms, fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.closed) fn()
    }, ms)
    if (timer.unref) timer.unref()
    this.timers.add(timer)
    return timer
  }

  #sendSummary () {
    for (const ch of this.channels) ch.messages[0].send(this.#summary())
  }

  // count, digest, and (story 9) how many records the logs held here hold.
  #summary () {
    let records = 0
    for (const log of this.logs.values()) records += Math.max(0, counted(log) - 1)
    return { count: this.logs.size, digest: this.digest, records }
  }

  // Opens the space channel on a connection's muxer. The id is the discovery
  // key, which DHT nodes see: each side proves it knows the space key in the
  // handshake (audit 1), and a channel without that proof is closed before
  // anything is answered.
  attach (mux, peer) {
    if (this.closed) return
    const ch = mux.createChannel({
      protocol: PROTOCOL,
      id: this.space.discoveryKey,
      handshake: c.fixed32,
      onopen: (proof) => {
        if (!b4a.equals(proof, capability(!mux.stream.isInitiator, this.space.key, mux.stream))) return ch.close()
        this.channels.add(ch)
        ch.messages[0].send(this.#summary())
        if (this.space.proof) ch.messages[7].send(this.space.proof)
        this.space.channelOpened(ch)
        this.space.activity.channelOpened(ch)
        this.space.peersChanged()
      },
      onclose: () => {
        this.channels.delete(ch)
        for (const app of ch.apps) app.close() // apps' protocols (space.addProtocol) go with it
        this.space.peersChanged()
      }
    })
    if (!ch) return
    ch.mux = mux
    ch.apps = new Set()
    ch.peer = peer
    ch.theirs = null // the digest of its last summary (hex)
    ch.settledOn = null // the digest of its summary this member last settled with (spec 017)
    ch.settledMine = null // and this member's own then
    ch.identity = null
    ch.addMessage({ encoding: enc.summary, onmessage: (m) => { if (!this.#deaf('summaries', ch, m)) this.#onSummary(ch, m) } })
    ch.session = new ranges.Session(this.sorted, { take: () => !this.space.byActivity })
    ch.addMessage({ encoding: enc.ranges, onmessage: (m) => { ch.heard = Date.now(); this.#send(ch, ch.session.onRanges(m)) } })
    ch.addMessage({
      encoding: enc.keys,
      onmessage: (m) => {
        const delay = this.space.listDelay // tests only (lib/testing.js slowLists)
        if (delay) this.#later(delay, () => this.#onKeys(ch, m))
        else this.#onKeys(ch, m)
      }
    })
    ch.addMessage({ encoding: enc.logKey, onmessage: (k) => { if (!this.#deaf('notices')) this.consider(k, this.#fromMember(ch)).catch(safetyCatch) } }) // notice
    ch.addMessage({ encoding: enc.logKey, onmessage: (k) => { if (this.logs.has(hex(k))) ch.messages[2].send({ prefix: EMPTY, bits: 0, kind: 2, keys: [k], lengths: [this.sorted.lengthOf(k)] }) } }) // get
    ch.addMessage({ encoding: enc.redeem, onmessage: (m) => this.space.redeem(m.redemption, ch).catch(safetyCatch) })
    ch.addMessage({ encoding: enc.ask, onmessage: (m) => this.space.ask(m.decision).catch(safetyCatch) })
    ch.addMessage({ encoding: c.buffer, onmessage: (proof) => this.#onHello(ch, proof) }) // hello: the peer's device proof
    // story 9 (research.md A14): an activity entry, a request for the entries
    // from a period on, a list in answer
    ch.addMessage({ encoding: activity.entry, onmessage: (e) => { if (!this.#deaf('notices')) this.space.activity.receive(e, ch).catch(safetyCatch) } })
    ch.addMessage({ encoding: activity.want, onmessage: (m) => this.space.activity.onWant(ch, m).catch(safetyCatch) })
    ch.addMessage({ encoding: activity.list, onmessage: (m) => this.space.activity.onList(ch, m).catch(safetyCatch) })
    ch.open(capability(mux.stream.isInitiator, this.space.key, mux.stream))
  }

  // Tests only (lib/testing.js deafen): messages of this kind are dropped.
  #deaf (kind, ch, m) {
    const deaf = this[symbols.deaf]
    if (!deaf || !deaf[kind]) return false
    if (m) deaf.dropped.push({ peer: ch.peer ? z32.encode(ch.peer) : null, digest: hex(m.digest) })
    return true
  }

  // A peer's device proof: who it is, if the proof is for the device at the
  // other end of this connection (its Noise key: the swarm uses device keys).
  #onHello (ch, proof) {
    const info = Identity.verifyDevice(proof)
    if (!info || !ch.peer || !b4a.equals(info.device, ch.peer) || ch.identity) return
    ch.identity = info.identity
    this.space.peersChanged()
    this.space.activity.channelOpened(ch) // a member now: it may be asked for activity lists
  }

  // Is the peer at the other end a member here (its hello proved who it is)?
  #fromMember (ch) {
    try {
      return !!ch.identity && this.space.state.isMember(ch.identity)
    } catch {
      return false
    }
  }

  // The peers on this space's channel: [{ identity (null until its hello),
  // device }].
  peerList () {
    return [...this.channels].map((ch) => ({ identity: ch.identity, device: ch.peer }))
  }

  // A peer's summary: if its directory differs, settle by ranges — not again
  // once settled with that summary (spec 017: this member then lacks nothing
  // the peer has), as the summary comes every little while.
  #onSummary (ch, { count, digest, records }) {
    this.space.summary({ count, records }) // a newcomer chooses how to read (story 9)
    const theirs = hex(digest)
    const was = !!ch.theirs && ch.theirs === ch.settledOn
    ch.theirs = theirs
    if (!this.reached) {
      this.reached = true
      this.space.progress()
    }
    if (this.space.byActivity) return // a big space: logs come from the activity lists of the periods read
    if (count === this.logs.size && b4a.equals(digest, this.digest)) {
      ch.settledOn = theirs
      ch.settledMine = theirs
      if (!was) this.space.progress()
      return this.#known()
    }
    if (ch.settledOn === theirs && ch.settledMine === hex(this.digest)) return // nothing new on either side
    if (was && ch.settledOn !== theirs) this.space.progress() // not complete any more
    // One exchange settles both sides: the connection's initiator starts it,
    // and a member that doesn't know the directory yet (it learns when it is
    // over); otherwise the other side only if none came (a newcomer to a big
    // space never starts one).
    const busy = () => !!ch.exchange && ch.exchange.waiting > 0
    if (ch.mux.stream.isInitiator || !this.known) {
      if (!busy()) this.#send(ch, [ch.session.start()])
      return
    }
    this.#later(SECOND_MS, () => {
      if (!this.closed && this.channels.has(ch) && !busy() && Date.now() - (ch.heard || 0) > SECOND_MS) this.#send(ch, [ch.session.start()])
    })
  }

  // Range and keys messages to a peer. Each one waiting for an answer counts
  // until the peer's `done` for it (lib/ranges.js).
  #send (ch, out) {
    const x = this.#exchange(ch)
    for (const m of out) {
      if (ranges.answered(m)) x.waiting++
      if (m.parts) ch.messages[1].send(m)
      else ch.messages[2].send(m)
    }
  }

  // A peer's keys: each log considered (what it lacks sent back). Once every
  // message of ours was answered and every log looked at (kept, refused or
  // waiting), this member knows the directory. Before, a summary alone
  // counted: a newcomer could say "complete" before it heard of the other
  // members' logs (found by bench/next/first-page.js).
  #onKeys (ch, m) {
    ch.heard = Date.now()
    const { out, learn, done } = ch.session.onKeys(m)
    const x = this.#exchange(ch)
    for (const { key, length } of learn) {
      const log = this.logs.get(hex(key))
      if (log) this.#claim(log, length, ch)
      else x.checks.push(this.consider(key).catch((err) => { safetyCatch(err); return true }))
    }
    this.#send(ch, out)
    if (!done || x.waiting <= 0) { // answering the peer's exchange only: nothing of ours to finish
      if (x.waiting <= 0) ch.exchange = null
      return
    }
    if (--x.waiting > 0) return
    ch.exchange = null
    Promise.all(x.checks).then((all) => {
      if (all.includes(false)) return // some were dropped: asked again at its next summary
      ch.settledMine = hex(this.digest)
      if (ch.settledOn !== x.theirs) {
        ch.settledOn = x.theirs
        this.space.progress()
      }
      this.#known()
    })
  }

  // theirs: the peer's summary it settles.
  #exchange (ch) {
    if (!ch.exchange) ch.exchange = { checks: [], waiting: 0, theirs: ch.theirs }
    else if (ch.exchange.waiting <= 0) ch.exchange.theirs = ch.theirs // a new one
    return ch.exchange
  }

  #known () {
    if (this.known || this.closed) return
    this.known = true
    this.space.progress()
  }

  // A peer opened the space channel of another version (spec 016): seen in
  // status() until that connection closes.
  otherVersion (mux) {
    if (this.closed || this.others.has(mux)) return
    this.others.add(mux)
    mux.stream.once('close', () => {
      this.others.delete(mux)
      this.space.peersChanged()
    })
    this.space.peersChanged()
  }

  // Asks every peer of this space to record a decision this device can't
  // write itself (a writer claim, a device removal: research.md A8).
  sendAsk (decision) {
    for (const ch of this.channels) ch.messages[6].send({ decision })
  }

  // Sends a redemption to every peer of this space (a newcomer's request).
  sendRedeem (redemption) {
    for (const ch of this.channels) ch.messages[5].send({ redemption })
  }

  close () {
    this.closed = true
    for (const { resolve } of this.queue.values()) resolve(true)
    this.queue.clear()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.some = []
    for (const ch of this.channels) ch.close()
    this.channels.clear()
  }
}

// As Hypercore's replication capability: a keyed hash of the space key and the
// connection's handshake, per side (so the other side can't send it back).
function capability (isInitiator, key, stream) {
  return crypto.hash([isInitiator ? NS_INITIATOR : NS_RESPONDER, key, stream.handshakeHash])
}

// The length of a log that counts for readers: what its summary entry says.
function counted (log) {
  return Math.min(log.length, log.limit)
}

const savedOf = (log) => log.length + ':' + log.byteLength + ':' + log.admitted + ':' + log.handed + ':' + log.handedTo

function closedError () {
  const err = new Error('This space is closed')
  err.code = 'CLOSED'
  return err
}

module.exports = { Directory, PROTOCOL, OTHER_PROTOCOL, OTHER_PROTOCOLS, counted }
