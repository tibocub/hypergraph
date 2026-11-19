// The log directory and the space channel. A
// space's directory is the set of device logs known to write in it. Members
// exchange it on a Protomux channel per space ('hypergraph/space/3', id = the
// space key): on open, a summary (count + XOR digest); if different, the
// lists are settled by key ranges (lib/ranges.js): what each lacks,
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
// A held log's core is open only while it is used: `open(log)` /
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

// /2 settles lists by ranges; /3 adds log lengths. Peers of
// another version don't pair (Protomux pairs by name) and are told apart
// (OTHER_PROTOCOLS: status warning)
const PROTOCOL = 'hypergraph/space/3'
const OTHER_PROTOCOLS = ['hypergraph/space', 'hypergraph/space/2']
const OTHER_PROTOCOL = OTHER_PROTOCOLS[1] // the previous one
const IDLE_MS = 30000 // a log unused this long closes
const CLAIM_MS = 60000 // a longer length a peer claimed, not served this long after it opened: dropped
const HEADER_MS = 10000 // waiting for a log's header from peers
const MAX_PENDING = 1000
const SUMMARY_MS = 10000 // the summary is sent again this often (plus up to a second)
const CHANGED_MS = 250 // and this long after the directory changed
const SECOND_MS = 500 // the connection's responder starts a range exchange this late, if the initiator didn't
const SOME = 16 // logs learnt from activity entries: headers fetched at once
const MAX_SOME = 256 // and waiting (more are dropped: entries for them come again)
const FETCHES = 16 // log headers fetched at once, whoever told us of the logs
const MAX_QUEUE = 1024 // and waiting; more are dropped: a peer's summary brings them again
const [NS_INITIATOR, NS_RESPONDER] = crypto.namespace(PROTOCOL, 2)

/**
 * @typedef {import('hypercore')} Hypercore
 * @typedef {import('protomux')} Protomux
 * @typedef {import('./space.js').SpaceContext} Space
 * @typedef {{ next: number, last: number, period: number }} ActState Where deriving a log's activity entries stands.
 *
 * A device log the space holds: it passed the gate. Its core is open only while used.
 * @typedef {object} HeldLog
 * @property {Uint8Array} key
 * @property {Hypercore | null} core Open, or null (closed: `length` and `byteLength` as last known).
 * @property {number} uses open() calls not released
 * @property {Promise<void> | null} opening
 * @property {Promise<void> | null} closing
 * @property {ReturnType<typeof setTimeout> | null} idleTimer
 * @property {number} length
 * @property {number} byteLength
 * @property {string | null} saved What was last saved of it (savedOf).
 * @property {number} claim A longer length a peer's summary gave (0: none).
 * @property {number} claimAt
 * @property {Uint8Array | null} claimBy
 * @property {number} handed Its length at the last hand-off to helpers.
 * @property {string | null} handedTo Which list of helpers.
 * @property {Uint8Array} identity
 * @property {Uint8Array} device
 * @property {number} indexed Every block below it is done (kept or skipped).
 * @property {number} scanned The next block to look at.
 * @property {Set<number>} holes Blocks below `scanned` not held yet.
 * @property {Set<number>} arrived
 * @property {number} limit A cut, or Infinity.
 * @property {number | null} cut
 * @property {boolean} own Written by this device.
 * @property {string | null} admitted The admission code its header carries (hex).
 * @property {number} acceptedAt
 * @property {Promise<void> | null} indexing
 * @property {boolean} again
 * @property {number} dropped
 * @property {number} droppedBlocks
 * @property {number} ixBytes
 * @property {number | null} from The first block read here (null: none yet).
 * @property {{ from: number, to: number } | null} skip Blocks done already, when reading starts earlier.
 * @property {ActState} act
 * @property {boolean} [uncommitted]
 * @property {number} [holeWait]
 * @property {ReturnType<typeof setTimeout> | null} [holeTimer]
 * @property {Map<number, number> | null} [overStamps]
 * @property {boolean} [rescanned]
 * @property {import('hypercore').Download | null} [range]
 * @property {boolean} [busy]
 * @property {number} [lastProgress]
 * @property {Promise<void> | null} [cutting]
 * @property {boolean} [heard] A peer told its length.
 *
 * @typedef {{ checks: Promise<boolean>[], waiting: number, theirs: string | null }} Exchange
 *
 * The space channel on one connection (Protomux), with what this member knows of the peer.
 * @typedef {import('protomux').Channel & {
 *   mux: Protomux,
 *   apps: Set<{ close (): void }>,
 *   peer: Uint8Array | null,
 *   theirs: string | null,
 *   settledOn: string | null,
 *   settledMine: string | null,
 *   identity: Uint8Array | null,
 *   session: import('./ranges.js').Session,
 *   heard?: number,
  member?: boolean,
 *   exchange?: Exchange | null
 * }} SpaceChannel
 * @typedef {{ identity: Uint8Array, device: Uint8Array }} Author
 * @typedef {{ key: Uint8Array, identity: Uint8Array, device: Uint8Array, admitted: string | null }} PendingLog
 */
const hex = (/** @type {Uint8Array} */ b) => b4a.toString(b, 'hex')
const EMPTY = b4a.alloc(0)

class Directory {
  /**
   * @param {Space} space
   */
  constructor (space) {
    this.space = space
    /** @type {Map<string, HeldLog>} */
    this.logs = new Map() // hex -> a held log (see accept())
    /** @type {Map<string, PendingLog>} */
    this.pending = new Map() // hex -> { key, identity } (valid, author not a member yet)
    /** get() follows a set() @type {{ get (key: string): Set<string> } & Map<string, Set<string>>} */
    this.byIdentity = new Map() // identity hex -> Set of log hex, held or pending: recheck() of a few identities
    /** @type {Set<string>} */
    this.refused = new Set() // hex: bad headers, never fetched again
    /** @type {Map<string, Promise<boolean>>} */
    this.inflight = new Map() // hex -> the header fetch under way
    /** @type {Map<string, { key: Uint8Array, resolve: (v: boolean | Promise<boolean>) => void, done: Promise<boolean> }>} */
    this.queue = new Map() // hex -> { key, resolve }: fetches waiting for a turn (FETCHES at once)
    this.urgent = 0 // fetches running for members' notices (their own FETCHES)
    /** @type {Set<SpaceChannel>} */
    this.channels = new Set()
    this.reached = false // a summary came from a peer since opening
    this.known = false // a peer's whole directory was looked at (or matched this one) since opening
    this.sorted = new ranges.Keys() // the held logs' keys and lengths, for range exchanges
    /** @type {Map<string, { peer: Uint8Array | null, length: number }>} */
    this.unserved = new Map() // hex -> { peer, length }: claims nobody served
    /** @type {Set<Protomux>} */
    this.others = new Set() // muxes whose peer opened the channel of another version
    this.closed = false
    /** @type {Set<ReturnType<typeof setTimeout>>} */
    this.timers = new Set()
    /** @type {Uint8Array[]} */
    this.some = [] // logs learnt from activity entries, waiting for a header fetch
    this.someRunning = 0
    this.#every()
  }

  get peers () { return this.channels.size }

  get digest () { return this.sorted.digest }

  keys () {
    return [...this.logs.values()].map((l) => l.key)
  }

  // A log that passed the gate (or was stored as such before).
  // from: the first block read here (null: none yet, a big space's
  // log outside the periods read); act: where deriving its activity entries
  // stands.
  // admitted: the admission code its header carries.
  // core: open, or null (a closed log, its `length` and
  // `byteLength` as last known).
  /**
   * @param {Uint8Array} key
   * @param {Hypercore | null} core
   * @param {Author} who
   * @param {{ indexed?: number, own?: boolean, announce?: boolean, limit?: number, cut?: number | null, from?: number | null, act?: ActState | null, admitted?: string | null, length?: number, byteLength?: number, handed?: number, handedTo?: string | null }} [opts]
   * @returns {Promise<HeldLog | null>}
   */
  async accept (key, core, who, { indexed = 1, own = false, announce = true, limit = Infinity, cut = null, from, act = null, admitted = null, length = 0, byteLength = 0, handed = -1, handedTo = null } = {}) {
    const h = hex(key)
    if (this.logs.has(h) || this.closed) return null
    if (from === undefined) from = own ? 1 : await this.space.fromOf(key)
    if (this.logs.has(h) || this.closed) return null
    const start = from === null ? indexed : Math.max(indexed, from)
    // indexed: every block below it is done (kept or skipped); scanned: the
    // next block to look at; holes: blocks below `scanned` not held yet
    // (lib/index/indexer.js); limit: a cut, or Infinity; skip: blocks done
    // already, when reading starts earlier.
    // core: null while closed; uses: open() calls not released;
    // claim: a longer length a peer's summary gave (0: none); handed: its
    // length at the last hand-off to helpers, handedTo: which list of them
    // (lib/helpers.js), both saved with its length.
    /** @type {HeldLog} */
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


  /**
   * @param {HeldLog} log
   * @returns {Promise<Hypercore>}
   */
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
    return /** @type {Hypercore} */ (/** @type {unknown} */ (log.core)) // opened above (tsc keeps it null from the check before the await)
  }

  /**
   * @param {HeldLog} log
   */
  release (log) {
    if (log.uses > 0) log.uses--
    this.#idle(log)
  }

  /**
   * @template T
   * @param {HeldLog} log
   * @param {(core: Hypercore) => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  async use (log, fn) {
    const core = await this.open(log)
    try {
      return await fn(core)
    } finally {
      this.release(log)
    }
  }

  /**
   * @param {HeldLog} log
   * @param {number} seq
   * @param {import('hypercore').GetOptions} [opts]
   */
  get (log, seq, opts) {
    return this.use(log, (core) => core.get(seq, opts))
  }

  /**
   * @param {HeldLog} log
   * @param {number} start
   * @param {number} [end]
   */
  has (log, start, end) {
    return this.use(log, (core) => core.has(start, end))
  }

  /**
   * @param {HeldLog} log
   */
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

  /**
   * @param {HeldLog} log
   * @param {Hypercore} core
   */
  #attach (log, core) {
    log.core = core
    const measure = () => this.measure(log)
    core.on('append', measure)
    core.on('truncate', measure)
    this.measure(log)
    this.space.opened(log) // the replicator follows it (lib/replication.js)
  }

  // Unused: closed after the idle delay. A log this member writes in stays
  // open, and so do all for a member reading by activity lists.
  /**
   * @param {HeldLog} log
   */
  #idle (log) {
    if (log.uses > 0 || !log.core || log.idleTimer || log.own || this.closed || this.space.byActivity) return
    log.idleTimer = this.#later(this.space.idleMs || IDLE_MS, () => {
      log.idleTimer = null
      this.#closeCore(log).catch(safetyCatch)
    })
  }

  /**
   * @param {HeldLog} log
   */
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

  /**
   * @param {HeldLog} log
   */
  async #save (log) {
    const now = savedOf(log)
    if (now === log.saved) return
    log.saved = now
    await this.space.saveLog(log).catch(safetyCatch)
  }

  /**
   * @param {HeldLog} log
   */
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

  /**
   * @param {HeldLog} log
   * @param {number} length
   * @param {SpaceChannel} ch
   */
  #claim (log, length, ch) {
    if (log.own || length <= counted(log) || length <= log.claim) return
    log.claim = length
    log.claimAt = Date.now()
    log.claimBy = ch.peer
    this.space.behind(log)
  }

  /**
   * @param {HeldLog} log
   */
  #unclaim (log) {
    log.claim = 0
    log.claimBy = null
    if (this.unserved.delete(hex(log.key))) this.space.peersChanged()
  }

  // A claim not served within CLAIM_MS: dropped, shown in status (a lie, or
  // nobody online holds the blocks).
  /**
   * @param {HeldLog} log
   * @param {number} [now]
   */
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
  // has nothing more at them.
  settled () {
    for (const ch of this.channels) if (!ch.theirs || ch.theirs !== ch.settledOn) return false
    return true
  }

  openLogs () {
    return [...this.logs.values()].filter((l) => l.core && !l.own)
  }

  // Closing the space, once nothing reads any more: every log it opened is
  // closed, those opening included, and their lengths saved. This
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

  // A log learnt from an activity entry: its header is fetched and
  // checked like any, a few at a time; more wait, up to MAX_SOME (throwaway
  // keys cost a bounded queue, not storage).
  /**
   * @param {Uint8Array} key
   */
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
      const key = /** @type {Uint8Array} */ (this.some.shift()) // the loop checks some.length
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
  // member's notice (a log is announced at its first record), not
  // stuck behind keys anyone can name in bulk.
  /**
   * @param {Uint8Array} key
   * @param {boolean} [urgent]
   * @returns {Promise<boolean>}
   */
  async consider (key, urgent = false) {
    const h = hex(key)
    if (this.closed || this.logs.has(h) || this.refused.has(h)) return true
    if (this.inflight.has(h)) return /** @type {Promise<boolean>} */ (this.inflight.get(h))
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
  /**
   * @param {Uint8Array} key
   * @param {boolean} [urgent]
   * @returns {Promise<boolean>}
   */
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
      /** @type {((v: boolean | Promise<boolean>) => void) | null} */
      let resolve = null
      const done = new Promise((r) => { resolve = r })
      this.queue.set(h, /** @type {{ key: Uint8Array, resolve: (v: boolean | Promise<boolean>) => void, done: Promise<boolean> }} */ (/** @type {unknown} */ ({ key, resolve, done }))) // resolve: set by the executor
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
      const [h, { key, resolve }] = /** @type {[string, { key: Uint8Array, resolve: (v: boolean | Promise<boolean>) => void }]} */ (this.queue.entries().next().value) // the queue isn't empty
      this.queue.delete(h)
      resolve(this.consider(key))
    }
  }

  /**
   * @param {Uint8Array} key
   */
  async #fetchOnce (key) {
    const h = hex(key)
    const core = this.space.getCore(key)
    let keep = false
    let had = true // the header was here before this fetch: never cleared by it
    try {
      await core.ready()
      had = await core.has(0)
      const header = await core.get(0, { timeout: HEADER_MS })
      if (this.closed) return
      const past = this.space.pastOf ? this.space.pastOf(key) : null
      const res = past ? gate.checkLog(header, key, past.space, { limitOf: this.space.limitOf, mayRetry: this.space.mayRetry, decisions: past.top }) : gate.checkLog(header, key, this.space.key, this.space)
      if (res.ok) {
        keep = true
        await this.accept(key, core, res, { limit: res.limit, admitted: res.admitted })
      } else if (res.retry) {
        if (this.pending.size >= MAX_PENDING) {
          const [old, { identity }] = /** @type {[string, PendingLog]} */ (this.pending.entries().next().value) // full
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
        // Only a header this fetch brought, and not under the decision log
        // reading it (any peer can name a key to Autobase): a core held here
        // for something else (this device's log in another space, a decision
        // writer) keeps it. Autobase was once told
        // block 0 was here, then read it cleared.
        if (!had && !(this.space.readByDecisions && this.space.readByDecisions(key))) await core.clear(0, 1).catch(safetyCatch)
        await core.close().catch(safetyCatch)
      }
    }
  }

  /**
   * @param {string} h
   * @param {Uint8Array} identity
   */
  #index (h, identity) {
    const id = hex(identity)
    if (!this.byIdentity.has(id)) this.byIdentity.set(id, new Set())
    this.byIdentity.get(id).add(h)
  }

  /**
   * @param {string} h
   * @param {Uint8Array} identity
   */
  #unindex (h, identity) {
    if (this.logs.has(h) || this.pending.has(h)) return
    const id = hex(identity)
    const set = this.byIdentity.get(id)
    if (set && set.delete(h) && !set.size) this.byIdentity.delete(id)
  }

  // The decisions changed: logs waiting for a membership may pass now, and
  // held logs whose author lost the right to write are cut. Resolves once
  // those cuts are indexed. `touched` (lib/decisions/state.js): only
  // the logs of the identities a decision touched; null: every log.
  /**
   * @param {import('./decisions/state.js').Touched | null} [touched]
   */
  recheck (touched = null) {
    const space = this.space
    const only = touched && !touched.all ? [...touched.ids].flatMap((id) => [...(this.byIdentity.get(id) || [])]) : null
    const pending = only ? /** @type {PendingLog[]} */ (only.map((h) => this.pending.get(h)).filter(Boolean)) : [...this.pending.values()]
    for (const { key, identity, device, admitted } of pending) {
      if (space.limitOf(identity, device, key, admitted) > 1) this.consider(key).catch(safetyCatch)
    }
    const cuts = []
    for (const log of only ? /** @type {HeldLog[]} */ (only.map((h) => this.logs.get(h)).filter(Boolean)) : [...this.logs.values()]) {
      const limit = space.limitOf(log.identity, log.device, log.key, log.admitted)
      if (limit < log.limit || (log.cut !== limit && limit !== Infinity)) cuts.push(this.space.cut(log, limit))
    }
    return Promise.all(cuts)
  }

  /**
   * @param {HeldLog} log
   */
  drop (log) {
    const h = hex(log.key)
    if (!this.logs.delete(h)) return
    this.#unindex(h, log.identity)
    this.sorted.delete(log.key)
    this.refused.add(h)
    this.#changed()
  }

  #every () {
    if (this.closed) return
    this.#later(SUMMARY_MS + Math.floor(Math.random() * 1000), () => {
      this.#sendSummary()
      this.#every()
    })
  }

  #changed () {
    if (this._changedTimer || this.closed) return
    this._changedTimer = this.#later(CHANGED_MS, () => {
      this._changedTimer = null
      this.#sendSummary()
    })
  }

  /**
   * @param {number} ms
   * @param {() => void} fn
   */
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

  #summary () {
    let records = 0
    for (const log of this.logs.values()) records += Math.max(0, counted(log) - 1)
    return { count: this.logs.size, digest: this.digest, records }
  }

  // Opens the space channel on a connection's muxer. The id is the discovery
  // key, which DHT nodes see: each side proves it knows the space key in the
  // handshake, and a channel without that proof is closed before
  // anything is answered.
  /**
   * @param {Protomux} mux
   * @param {Uint8Array | null} peer
   */
  attach (mux, peer) {
    if (this.closed) return
    const ch = /** @type {SpaceChannel} */ (mux.createChannel({
      protocol: PROTOCOL,
      id: this.space.discoveryKey,
      handshake: c.fixed32,
      onopen: (/** @type {Uint8Array} */ proof) => {
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
    }))
    if (!ch) return
    ch.mux = mux
    ch.apps = new Set()
    ch.peer = peer
    ch.theirs = null // the digest of its last summary (hex)
    ch.settledOn = null // the digest of its summary this member last settled with
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
    // an activity entry, a request for the entries
    // from a period on, a list in answer
    ch.addMessage({ encoding: activity.entry, onmessage: (e) => { if (!this.#deaf('notices')) this.space.activity.receive(e, ch).catch(safetyCatch) } })
    ch.addMessage({ encoding: activity.want, onmessage: (m) => this.space.activity.onWant(ch, m).catch(safetyCatch) })
    ch.addMessage({ encoding: activity.list, onmessage: (m) => this.space.activity.onList(ch, m).catch(safetyCatch) })
    ch.addMessage({ encoding: c.buffer }) // a private space's disk key, sealed to a newcomer's device (KEY_MESSAGE; read by lib/joiner.js)
    ch.open(capability(mux.stream.isInitiator, this.space.key, mux.stream))
  }

  /**
   * @param {'summaries' | 'notices'} kind
   * @param {SpaceChannel} [ch]
   * @param {{ digest: Uint8Array }} [m]
   */
  #deaf (kind, ch, m) {
    const deaf = /** @type {Directory & { [symbols.deaf]?: { notices: boolean, summaries: boolean, dropped: { peer: string | null, digest: string }[] } | null }} */ (this)[symbols.deaf]
    if (!deaf || !deaf[kind]) return false
    if (m) deaf.dropped.push({ peer: /** @type {SpaceChannel} */ (ch).peer ? z32.encode(/** @type {Uint8Array} */ (/** @type {SpaceChannel} */ (ch).peer)) : null, digest: hex(m.digest) })
    return true
  }

  // A peer's device proof: who it is, if the proof is for the device at the
  // other end of this connection (its Noise key: the swarm uses device keys).
  /**
   * @param {SpaceChannel} ch
   * @param {Uint8Array} proof
   */
  #onHello (ch, proof) {
    const info = Identity.verifyDevice(proof)
    if (!info || !ch.peer || !b4a.equals(info.device, ch.peer) || ch.identity) return
    ch.identity = info.identity
    this.space.peersChanged()
    this.space.activity.channelOpened(ch) // a member now: it may be asked for activity lists
  }

  /**
   * @param {SpaceChannel} ch
   */
  #fromMember (ch) {
    try {
      return !!ch.identity && this.space.state.isMember(ch.identity)
    } catch {
      return false
    }
  }

  peerList () {
    return [...this.channels].map((ch) => ({ identity: ch.identity, device: ch.peer }))
  }

  // A peer's summary: if its directory differs, settle by ranges — not again
  // once settled with that summary (this member then lacks nothing
  // the peer has), as the summary comes every little while.
  /**
   * @param {SpaceChannel} ch
   * @param {{ count: number, digest: Uint8Array, records?: number }} summary
   */
  #onSummary (ch, { count, digest, records }) {
    this.space.summary({ count, records }) // a newcomer chooses how to read
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

  /**
   * @param {SpaceChannel} ch
   * @param {import('./ranges.js').RangeMessage[]} out
   */
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
  /**
   * @param {SpaceChannel} ch
   * @param {import('./ranges.js').KeysMessage} m
   */
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

  /**
   * @param {SpaceChannel} ch
   * @returns {Exchange}
   */
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

  /**
   * @param {Protomux} mux
   */
  otherVersion (mux) {
    if (this.closed || this.others.has(mux)) return
    this.others.add(mux)
    mux.stream.once('close', () => {
      this.others.delete(mux)
      this.space.peersChanged()
    })
    this.space.peersChanged()
  }

  /**
   * @param {Uint8Array} decision
   */
  sendAsk (decision) {
    for (const ch of this.channels) ch.messages[6].send({ decision })
  }

  /**
   * @param {Uint8Array} redemption
   */
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
/**
 * @param {boolean} isInitiator
 * @param {Uint8Array} key
 * @param {{ handshakeHash: Uint8Array }} stream
 * @returns {Uint8Array}
 */
function capability (isInitiator, key, stream) {
  return crypto.hash([isInitiator ? NS_INITIATOR : NS_RESPONDER, key, stream.handshakeHash])
}

/**
 * @param {{ length: number, limit: number }} log
 */
function counted (log) {
  return Math.min(log.length, log.limit)
}

/** @param {HeldLog} log */
const savedOf = (log) => log.length + ':' + log.byteLength + ':' + log.admitted + ':' + log.handed + ':' + log.handedTo

/**
 * @returns {Error & { code?: string }}
 */
function closedError () {
  /** @type {Error & { code?: string }} */
  const err = new Error('This space is closed')
  err.code = 'CLOSED'
  return err
}

const KEY_MESSAGE = 11 // the index of the disk key message above

module.exports = { Directory, KEY_MESSAGE, capability, PROTOCOL, OTHER_PROTOCOL, OTHER_PROTOCOLS, counted }
