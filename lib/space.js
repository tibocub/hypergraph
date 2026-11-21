// A space: a community's records, queries and decisions.
// Each device writes its own log here; the decision log says who is in; every
// member checks what it receives before keeping it (lib/gate.js) and indexes
// what it holds (lib/index/). Reads are bounded and say if they are complete.

const { EventEmitter } = require('events')
const b4a = require('b4a')
const c = require('compact-encoding')
const z32 = require('z32')
const crypto = require('hypercore-crypto')
const safetyCatch = require('safety-catch')
const enc = require('./encodings.js')
const gate = require('./gate.js')
const invites = require('./invites.js')
const { Decisions } = require('./decisions/log.js')
const { initProof, writerSignable, removalSignable, POLICIES } = require('./decisions/apply.js')
const { OwnLog, admittedOf } = require('./log.js')
const { Directory, KEY_MESSAGE } = require('./directory.js')
const { Replicator, clearBlocks, unheard } = require('./replication.js')
const { Helpers } = require('./helpers.js')
const { Indexer } = require('./index/indexer.js')
const { Query, linkedRows, edgeRows, taggedRows, tagStamp, shape, idOf, keyBytes, NOT_SHOWN } = require('./index/query.js')
const { tagKey, droppedName, droppedRow, FLAGS } = require('./index/indexer.js')
const { State, touched, ROLES, ACTIONS, OWN, mayAssign, mayInvite, mayRemove, grantable, rankOf } = require('./decisions/state.js')
const { Identity } = require('./identity.js')
const { PERSONAL, Types } = require('./types.js')
const { HypergraphError } = require('./errors.js')
const storage = require('./storage.js')
const symbols = require('./symbols.js')
const pc = require('./private/crypto.js')
const grants = require('./private/grants.js')
const { Activity, periodOf, PERIOD_MS } = require('./activity.js')
const { isFuture, compare } = require('./stamp.js')
const limits = require('./limit.js')

/** @param {Uint8Array} b */
const hex = (b) => b4a.toString(b, 'hex')
const cutList = c.array(enc.struct([['log', c.fixed32], ['length', c.uint]]))
const reportBoxes = c.array(enc.struct([['to', c.fixed32], ['sealed', c.buffer]])) // hg/report's boxes
const MAX_REASON = 1000
/** @param {Uint8Array} identity @param {Uint8Array} device */
const removalKey = (identity, device) => hex(identity) + ':' + hex(device)
const CLAIM_MS = 5000 // a claim of this device's writer key is sent again at most this often
const DROP_MIN = 256 // smaller records are never dropped (votes, tags: little to gain, and sums need them)
const REFILL = 64 // dropped records fetched again per pass, when everything fits again
const LOGS_MS = 100 // 'logs' events at most this often
const BOUND_MS = 5000 // writes' and background waits; reads answer at once
const LINK = 'hg/key-link'
const PLAIN = new Set(['hg/grant', LINK, 'hg/device-remove']) // never sealed in a private space
const EMPTY = b4a.alloc(0)
const MAX_HELPERS = 8 // as lib/decisions/apply.js
const MAX_TYPES = 32 * 1024 // a types/set declaration's bytes, as lib/decisions/apply.js
const LIST_MS = 100 // new logs listed together
const CHUNK = 256 * 1024 // a renewed space's state, copied in chunks of about this many characters
const FINAL_MS = 10000 // a renewer waits this long for its move to be settled by the indexers, then goes first
const FOLLOW_MS = 1000 // a move not settled yet is looked at again this often

// A helper's key: z32 or hex text, or 32 bytes; as hex.
/**
 * @param {string | Uint8Array} k
 * @returns {string}
 */
function helperKey (k) {
  let b = null
  try { b = typeof k === 'string' ? (/^[0-9a-fA-F]{64}$/.test(k) ? b4a.from(k, 'hex') : z32.decode(k)) : k } catch {}
  if (!b4a.isBuffer(b) || b.byteLength !== 32) throw new TypeError(`Not a helper's key: ${k}`)
  return b4a.toString(b, 'hex')
}

/**
 * @typedef {import('./directory.js').HeldLog} HeldLog
 * @typedef {import('./directory.js').SpaceChannel} SpaceChannel
 * @typedef {import('./encodings.js').WireRecord} WireRecord
 * @typedef {import('./activity.js').ActivityRow} ActivityRow
 * @typedef {import('./index/indexer.js').Changes} Changes
 * @typedef {import('./index/query.js').HgRecord} HgRecord
 * @typedef {import('./index/query.js').Page} Page
 * @typedef {import('./index/query.js').Edge} Edge
 * @typedef {import('./index/indexer.js').Deletion} Deletion
 * @typedef {import('./decisions/state.js').SubView} SubView
 * @typedef {import('./index.js').Hypergraph & { [symbols.slowLists]?: number, [symbols.idleLogs]?: { idle: number, claims: number } }} Seams Hypergraph with lib/testing.js's slots.
 * @typedef {{ readonly identity: string | null, device: string, send (i: number, msg: unknown): void }} ProtocolPeer A peer on an app's protocol.
 * @typedef {{ fields: Record<string, string>, links: Record<string, string[]>, onePerMember: boolean, editable: import('./types.js').EditRule, index: string[][], builtin: boolean }} TypeInfo A record type as types() describes it.
 * @typedef {import('./index/indexer.js').RecordRow} RecordRow
 * @typedef {{policy: string, access: string, held: string, heldFrom: (number|null), stored: number, share: (number|null), budget: (number|null), belowPolicy: boolean, peers: number, settlers: number, warnings: Array<{code: string, message: string}>, complete: boolean, members?: number, holders?: number, total?: (number|null)}} SpaceStatus What {@link Space#status} returns.
 * @typedef {WireRecord & { unreadable?: boolean }} OpenRecord A record as it counts here: opened if it was sealed.
 */

/**
 * What a space's parts (directory, activity, indexer, replicator) see of it.
 * @typedef {object} SpaceContext
 * @property {import('./index/indexer.js').Db} db
 * @property {import('./index/indexer.js').WriteQueue} queue
 * @property {import('./directory.js').Directory} directory
 * @property {boolean} byActivity Reading by activity lists (a big space).
 * @property {number} listDelay
 * @property {number} idleMs
 * @property {number} claimMs
 * @property {import('./helpers.js').Helpers} helpers
 * @property {(log: HeldLog) => void} opened
 * @property {(log: HeldLog) => void} closedLog
 * @property {(log: HeldLog) => void} behind
 * @property {(log: HeldLog) => Promise<void>} saveLog
 * @property {(key: Uint8Array) => Promise<number | null>} fromOf
 * @property {(m: { count: number, records?: number }) => void} summary
 * @property {(rows: ActivityRow[]) => void} entries
 * @property {(rows: ActivityRow[]) => void} activityKept
 * @property {() => number} coveredFrom
 * @property {(log: { device: Uint8Array, identity: Uint8Array }) => import('./limit.js').WriteLimit | null | false} limitFor
 * @property {() => number | null} horizon
 * @property {(log: HeldLog) => void} restart
 * @property {Uint8Array} key
 * @property {Uint8Array} discoveryKey
 * @property {Uint8Array} decisions The decision log its log headers must name.
 * @property {Types} types
 * @property {import('./gate.js').Rules} rules
 * @property {import('corestore')} store
 * @property {Uint8Array} me
 * @property {boolean} personal
 * @property {import('./stamp.js').Stamper} stamper
 * @property {State} state
 * @property {(key: Uint8Array) => import('hypercore')} getCore
 * @property {(key: Uint8Array) => { space: Uint8Array, top: Uint8Array, cut: number } | null} pastOf
 * @property {(key: Uint8Array) => boolean} readByDecisions
 * @property {(identity: Uint8Array, device: Uint8Array, log: Uint8Array, admitted?: string | null) => number} limitOf
 * @property {(identity: Uint8Array, device: Uint8Array, log: Uint8Array) => boolean} mayRetry
 * @property {(log: HeldLog, record: OpenRecord, values: Record<string, any> | null) => boolean} allowed
 * @property {(values: { removed: Uint8Array, cut: Uint8Array, proof: Uint8Array }, identity: Uint8Array) => void} removed
 * @property {(bytes: Uint8Array) => boolean} locked
 * @property {(log: HeldLog, seq: number, record: WireRecord) => OpenRecord | false | null} unseal
 * @property {(log: HeldLog) => void} accepted
 * @property {(key: Uint8Array) => HeldLog | null} logOf
 * @property {(log: HeldLog, limit: number) => Promise<void>} cut
 * @property {(changes: Changes) => void} changed
 * @property {(id: Uint8Array, opts?: { dropped?: boolean }) => Promise<void>} clear
 * @property {() => void} progress
 * @property {Uint8Array} proof
 * @property {() => void} peersChanged
 * @property {(bytes: Uint8Array, ch?: SpaceChannel | null) => Promise<void>} redeem
 * @property {(bytes: Uint8Array) => Promise<void>} ask
 * @property {(ch: SpaceChannel) => void} channelOpened
 * @property {import('./activity.js').Activity} activity
 * @property {import('./index/indexer.js').Indexer} indexer
 */

const NONE = new State() // a sub-space its top space's log doesn't name yet: nobody is in
// A newcomer reads a space newest first when a peer
// holds more records than `records`, and reads it by activity lists (not
// opening every log) beyond `logs` logs: the switch-over point. Measured
// (bench/next/first-page.js): each log opened costs a newcomer ~1.5 KB and
// ~1 ms; at 300 logs that is ~0.45 MB, keeping a first page under 1 MB.
// Tests lower them (lib/testing.js bigSpaces).
const BIG = { logs: 300, records: 2000 }

/**
 * A space: a forum, a chat, a wiki, a shared folder. Its members, their roles and the moderation are in
 * its decision log; each member's device writes records into a log of its own; every reader checks
 * every record against the space's rules, so a modified app can't break them. Get one from
 * {@link Hypergraph#createSpace}, {@link Hypergraph#redeemInvite} or {@link Hypergraph#space}; never
 * construct it.
 *
 * Reads answer at once from what this device holds, `complete` saying whether something it knows of is
 * still on its way; `{ timeout }` makes a read wait while incomplete. Every read has an event that says
 * when to read it again.
 *
 * A closed space opens by itself on its next async call; sync getters such as {@link Space#state} need
 * {@link Space#ready} first.
 *
 * Write errors (`put`, `edit`, `del`, graph calls), as `HypergraphError` codes: `NOT_ALLOWED` (no
 * permission, banned, a write limit), `INVALID_RECORD`, `INVALID_TYPE`, `INCOMPATIBLE_TYPES` (the space's
 * types don't have it yet, or this app changed them in a way members can't share), `RULE_REJECTED`,
 * `MOVED` (the space was renewed), `DEVICE_REMOVED`. Any call: `CLOSED` after close, `SUSPENDED` on a
 * closed space while the app is suspended.
 * @extends EventEmitter
 * @fires Space#change
 * @fires Space#members
 * @fires Space#decisions
 * @fires Space#status
 * @fires Space#peers
 * @fires Space#logs
 * @fires Space#moved
 * @fires Space#member-connection
 * @fires Space#member-disconnection
 */
class Space extends EventEmitter {
  // Set by _open() (a closed space has none of these: checked where it may be closed):
  /** @type {import('corestore')} */ store
  /** @type {Uint8Array} */ _discoveryKey
  /** @type {SpaceContext} */ _ctx
  /** this device's log here @type {import('./log.js').OwnLog & { generation: number }} */ own
  /** this identity's log here (device removals) @type {import('hypercore')} */ _idcore
  /** @type {Activity} */ activity
  /** @type {Directory} */ directory
  /** @type {Indexer} */ indexer
  /** @type {Replicator} */ replicator
  /** @type {Helpers} */ _helpers
  /** @type {(state: State, keys: Set<string> | null) => void} */ _onchange
  /** @type {() => void} */ _onfailed
  /** @type {Promise<void>} */ _decided
  // Set by #reset():
  /** get() follows a set() @type {{ get (key: string): Record<string, number>[] } & Map<string, Record<string, number>[]>} */ removals
  /** @type {Map<string, { identity: Uint8Array, device: Uint8Array, cut: Uint8Array, proof: Uint8Array }>} */ _removed
  /** @type {Map<string, Uint8Array>} */ _asks
  /** @type {Set<string>} */ _asking
  /** @type {number} */ _claimed
  /** @type {Uint8Array | null} */ _redemption
  /** @type {Set<string>} */ _redeeming
  /** @type {number | null} */ _budget
  /** @type {number | null} */ _share
  /** @type {string} */ _statusSig
  /** @type {boolean} */ _undecided
  /** @type {{ horizon: number | null, byActivity: boolean }} */ _reading
  /** log hex -> period -> start; get() follows a set() where it is read @type {{ get (key: string): Map<number, number> } & Map<string, Map<number, number>>} */ _act
  /** @type {number} */ _indexed
  /** @type {Set<string>} */ _fetching
  // Kept as it runs:
  /** @type {boolean} */ _stale
  /** @type {boolean} */ _rebuild
  /** @type {Promise<void> | null} */ _reopening
  /** @type {number} */ _pastsSeen
  /** @type {string} */ _limitSig
  /** @type {boolean} */ _keyAgain
  /** @type {Promise<void> | null} */ _keying
  /** @type {Promise<unknown> | null} */ _rotating
  /** @type {ReturnType<typeof setTimeout> | null} */ _logsTimer
  /** @type {ReturnType<typeof setTimeout> | null} */ _statusTimer
  /** @type {ReturnType<typeof setTimeout> | null} */ _listTimer
  /** @type {ReturnType<typeof setTimeout> | null} */ _followTimer
  /** @type {Promise<Space> | null} */ _renewing
  /** @type {Promise<void> | null} */ _following
  /** @type {string} */ _movedHash
  /** @type {boolean} */ _trimAgain
  /** @type {Promise<void> | null} */ _trimming
  /** @type {Promise<unknown>} */ _reposting
  /** @type {boolean} */ _over
  /** @type {Map<string, number> | null} */ _dropFrom
  /** @type {boolean} */ _refilling
  /** @type {Promise<void> | null} */ _widening
  /** @type {Promise<void> | null} */ _shutting
  /** @type {Set<SpaceChannel>} */ _handedOut
  // Set by lib/index.js:
  /** its top space, held open while it is @type {Space | null} */ _top
  /** @type {boolean} */ _circle
  /** the decision log held while it is rebuilt @type {import('./decisions/log.js').Decisions | null} */ _heldLog
  /** @type {string | null} */ _movedTo
  /** what instance.json last saved of it @type {string} */ _remembered

  /**
   * @param {import('./index.js').Hypergraph} hg
   * @param {{ key?: Uint8Array | null, ns: string, personal?: boolean, encryptionKey?: Uint8Array | null, keyPair?: import('./identity.js').KeyPair | null, root?: Uint8Array | null, fresh?: boolean, name?: string, parent?: string | null, declared?: Types | null }} opts
   */
  constructor (hg, { key = null, ns, personal = false, encryptionKey = null, keyPair = null, root = null, fresh = false, name = '', parent = null, declared = null }) {
    super()
    this.setMaxListeners(0)
    this.hg = hg
    this.ns = ns
    this.keyBytes = /** @type {Uint8Array} */ (key) // null for a new space until _open()
    /**
     * @type {Uint8Array | null}
     */
    this.rootKey = root
    this.db = hg.db
    this.personal = personal
    if (!encryptionKey && !personal && (root || key)) encryptionKey = hg._diskKeys.get(hex(/** @type {Uint8Array} */ (root || key))) || null
    /**
     * @type {Uint8Array | null}
     */
    this.encryptionKey = encryptionKey
    /** @type {import('./identity.js').KeyPair | null} */
    this._keyPair = keyPair
    this._coreOpts = encryptionKey ? { encryption: { key: encryptionKey } } : {}
    /** null while closed: read where it is open @type {Decisions} */
    this.decisionLog = /** @type {Decisions} */ (/** @type {unknown} */ (null))
    this._name = name
    /** @type {string | null} */
    this._parent = parent // z32, a closed sub-space's parent
    this._fresh = fresh && !personal
    this._protocols = new Map() // name -> handlers: apps' own protocols (addProtocol)
    this.opened = false // _open() done (a closed space is a shell: key, name, parent)
    this._opening = null
    this._uses = 0 // calls in flight, live views, holds (never closed while in use)
    this._own = personal // created by this identity: seeded first
    this._pinned = false
    this._seeded = personal // open for good (own, pinned, recent: lib/index.js #reseed)
    this._used = 0 // last use (ms)
    this._idleTimer = null
    /** @type {Types | null} */
    this._declared = declared
    this._refusal = null // INCOMPATIBLE_TYPES, if this app's types break the space's
    /** @type {[number, Types] | null} */
    this._typesOf = null // [version, Types]
    this.closed = false
    this.#reset()
  }

  #reset () {
    this.removals = new Map() // `identity hex:device hex` -> [{ log hex: length }], one per removal
    this._removed = new Map() // `identity hex:device hex` -> the removal ({ identity, device, cut, proof }), for the decision log
    this._asks = new Map() // hex -> encoded decision this device asks a writer to record
    this._asking = new Set()
    this._claimed = 0
    this._redemption = null
    this._redeeming = new Set()
    this._budget = null // its own budget here, or null: a share of the app's
    this._share = null // what it may use here, from the app's last budget pass
    this._statusSig = ''
    this._undecided = false // a newcomer that hasn't chosen how to read yet
    this._reading = { horizon: null, byActivity: false } // horizon: the first period read (null: everything)
    this._act = new Map() // log hex -> Map(period -> start): entries at or after the horizon
    this._indexed = 0 // index changes so far
    this._fetching = new Set() // record ids hex whose dropped content is being fetched (#fetchLater)
  }

  /**
   * The space's key (z32): its address, given to every member.
   * @type {string}
   */
  get key () { return z32.encode(this.keyBytes) }
  /**
   * The space's key in hex.
   * @type {string}
   */
  get hex () { return hex(this.keyBytes) }
  /**
   * The space's name ('' for the personal space).
   * @type {string}
   */
  get name () { return this.personal ? '' : this._log ? (this.state.name || this._name || '') : this._name }
  /**
   * The key of the space this one is a sub-space of (z32), or null for a top space.
   * @type {string|null}
   */
  get parent () {
    if (!this.rootKey) return null
    if (!this._log) return this._parent || z32.encode(this.rootKey)
    const up = /** @type {SubView} */ (this.state).parent // a sub-space's
    return z32.encode(up ? b4a.from(up, 'hex') : this.rootKey)
  }

  /**
   * Whether its content is readable only by its members.
   * @type {boolean}
   */
  get private () { return !!this.state.private }
  /**
   * Whether it is a circle ({@link Hypergraph#createCircle}).
   * @type {boolean}
   */
  get circle () { return !this.personal && !!this.state.circle }

  /**
   * Whether it was made public ({@link Space#makePublic}).
   * @type {boolean}
   */
  get isPublic () { return this.state.public }

  /**
   * Whether it was renewed into another space ({@link Space#renew}): read-only from then on.
   * @type {boolean}
   */
  get moved () { return !!this._log && !!this.state.moved }
  /**
   * The key of the space it was renewed into (z32), once this device opened its "moved to" notice;
   * null before, and always for a removed person.
   * @type {string|null}
   */
  get movedTo () { return this._movedTo || null }

  /**
   * For a space made by a renew: `{ from, waiting }`, else null. `waiting` while no other owner's or
   * admin's device records decisions in it yet: the renewer's device must stay online until one does.
   * @type {{from: string, waiting: boolean}|null}
   */
  get renewal () {
    if (!this._log || this.rootKey) return null
    const r = this.state.renewed
    if (!r) return null
    return { from: z32.encode(b4a.from(r.from, 'hex')), waiting: this.#handoverWaits() }
  }

  #handoverWaits () {
    const st = this.state
    const me = this.hg._identity
    const mine = hex(me.device.publicKey)
    for (const w of st.writerInfo.values()) if (w.device !== mine && !st.isGone(w.identity, w.device)) return false
    for (const id of st.members.keys()) if (id !== hex(me.publicKey) && st.writesDecisions(id)) return true
    for (const log of this.directory.logs.values()) { // this person's other devices
      if (b4a.equals(log.device, log.identity) || b4a.equals(log.device, this.hg._identity.device.publicKey)) continue
      if (st.writesDecisions(log.identity) && !this.isRemoved(log.identity, log.device) && !st.isGone(log.identity, log.device)) return true
    }
    return false
  }

  /**
   * @param {Uint8Array} key
   * @returns {{ space: Uint8Array, top: Uint8Array, cut: number } | null}
   */
  _pastOf (key) {
    const p = this._log ? this._log.state.pasts.get(hex(key)) : null
    if (!p || p.in !== this.hex) return null
    return { space: b4a.from(p.space, 'hex'), top: b4a.from(p.top, 'hex'), cut: p.cut }
  }

  // How a log's core opens here: a history log with the old disk key (none
  // held: a newcomer of a hidden history, which reads nothing of it).
  /**
   * @param {Uint8Array} key
   */
  #coreOptsOf (key) {
    const past = this._pastOf(key)
    if (!past) return this._coreOpts
    const disk = this.hg._diskKeys.get(hex(past.top))
    return disk ? { encryption: { key: disk } } : {}
  }

  /**
   * @param {Uint8Array} key
   * @returns {Uint8Array}
   */
  #adOf (key) {
    const past = this._pastOf(key)
    return past ? past.space : this.keyBytes
  }
  get _log () { return this.decisionLog || this._heldLog || null }
  /**
   * The topic its members meet on.
   * @ignore
   */
  get discoveryKey () { return this.rootKey ? this._discoveryKey : this.decisionLog ? this.decisionLog.discoveryKey : crypto.discoveryKey(this.keyBytes) }
  /**
   * The key of the decision log holding its decisions: its own, or its top space's for a sub-space.
   * @ignore
   */
  get top () { return this.rootKey || this.keyBytes }

  /**
   * Its decisions as they count here (lib/decisions/state.js).
   * @ignore
   */
  get state () {
    if (!this._log) throw new Error('This space is closed until it is used: await space.ready() before reading its state (spec 015)')
    const st = this._log.state
    return this.rootKey ? (st.sub(this.keyBytes) || NONE) : st
  }


  // The types this space's records are read, checked and indexed with: the
  // ones it recorded (a sub-space: its top space's), else (a space from
  // before, the personal space, a closed space) this app's.
  get _types () {
    const st = !this.personal && this._log ? this._log.state : null
    if (!st || !st.typesVersion || !st.types) return this.hg._types
    if (!this._typesOf || this._typesOf[0] !== st.typesVersion) this._typesOf = [st.typesVersion, Types.from(st.types)]
    return this._typesOf[1]
  }

  /**
   * The space's record types, in the form of {@link Hypergraph#types}.
   * @returns {Record<string, TypeInfo>}
   */
  types () {
    this.#mustBeOpen()
    return describeTypes(this._types)
  }

  /**
   * Which version of its types the space has (0: none recorded yet, this app's are used).
   * @type {number}
   */
  get typesVersion () {
    this.#mustBeOpen()
    return this.personal ? 0 : this._log.state.typesVersion
  }

  // What this app's declaration says of the space's types: a refusal
  // (INCOMPATIBLE_TYPES) if it changes them in a way they can't be shared.
  // Types the index was built without (or new indexes), with rows of them
  // here: this space's rows are indexed again from its logs.
  async #checkTypes () {
    const hg = this.hg
    const indexed = await hg._indexedWith(this)
    const recorded = this.personal ? null : this.decisionLog.state.types
    this._refusal = null
    try {
      if (recorded) hg._types.conflict(recorded)
      else hg._types.checkCompatible(indexed)
    } catch (err) {
      if (/** @type {HypergraphError} */ (err).code !== 'INCOMPATIBLE_TYPES') throw err
      this._refusal = err
      return false
    }
    const stale = this._types.stale(indexed)
    const rebuild = stale.length > 0 && await hg._holdsAny(this, stale)
    if (!rebuild) await hg._indexedNow(this, this._types.describe())
    return rebuild
  }

  // A decider's app records its declaration when it adds to the space's
  // (types, fields at the end, indexes): every member then reads with it.
  // Types the app lacks (a site's, another admin's newer app's) stay, in a
  // space that has at least one of the app's types. Never a
  // member's app, never a sub-space (they have their top space's).
  async #recordTypes () {
    if (this.personal || this.rootKey || this._refusal || this.closed || this.hg._recordNoTypes) return
    const app = this._declared || this.hg._types
    if (!Object.keys(app.describe()).length) return // an engine without types
    const st = /** @type {State} */ (this.state) // a top space's
    if (!st.can(this.hg._identity.publicKey, 'decide')) return
    const recorded = st.types
    // Another app's space (a wiki, held by a forum app's engine): no type in
    // common, nothing of this app's to record there.
    if (recorded && !Object.keys(app.describe()).some((name) => recorded[name])) return
    const next = recorded ? app.over(recorded) : app.describe()
    if (recorded) {
      if (JSON.stringify(next) === JSON.stringify(recorded)) return
      try {
        Types.from(next).checkCompatible(recorded)
      } catch {
        return // the app changes the space's types: #checkTypes refused it
      }
    }
    this._use() // indexed again (if it must be) once this is done
    try {
      await this.#decide({ type: 'types/set', version: st.typesVersion + 1, types: JSON.stringify(next) })
    } finally {
      this._unuse()
    }
  }

  /**
   * Adds types to this space, for an engine serving many apps that can't declare every site's types
   * when it opens. The types named replace the space's version of them, the others stay; anything but an
   * addition (fields at the end, new types, indexes) is refused. Resolves once this device reads with them.
   * @param {import('./types.js').TypeDeclarations} types In the form of `Hypergraph.open`'s `types`.
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_ALLOWED` for who may not decide, or on a sub-space (declare them on its top space); `INCOMPATIBLE_TYPES` for anything but an addition; `INVALID_TYPE` for a malformed type.
   */
  async declareTypes (types) {
    if (this.personal) throw new HypergraphError('NOT_ALLOWED', "The personal space has hypergraph's own types only")
    if (this.rootKey) throw new HypergraphError('NOT_ALLOWED', "A sub-space has its top space's types: declare them on the top space")
    if (!types || typeof types !== 'object' || Array.isArray(types)) throw new TypeError('Types are { name: { fields: { field: kind } } }, as Hypergraph.open takes')
    await this.#mayDecide('decide', 'add types to this space')
    for (let tries = 0; tries < 5; tries++) {
      const st = /** @type {State} */ (this.state) // a top space's
      const base = st.types || this.hg._types.describe()
      const next = Types.adding(base, types)
      next.checkCompatible(base)
      const desc = JSON.stringify(next.describe())
      if (st.types && desc === JSON.stringify(st.types)) return
      if (b4a.byteLength(desc) > MAX_TYPES) throw new HypergraphError('INVALID_TYPE', `A space's types are at most ${MAX_TYPES / 1024} KB as JSON (these are ${Math.ceil(b4a.byteLength(desc) / 1024)} KB)`)
      await this.#decide({ type: 'types/set', version: st.typesVersion + 1, types: desc })
    }
    throw new HypergraphError('NOT_ALLOWED', 'Other deciders kept recording types at the same moment: try again')
  }

  // The space's types changed while open: another decider's
  // version may have won over this app's (both wrote the same next version),
  // so this app records again if it still has something to add.
  async #typesChanged () {
    this._typesOf = null
    this.#recordTypes().catch(safetyCatch)
    if (!(await this.#checkTypes())) return
    this._stale = true
    this.#rebuildLater()
  }

  // Rows indexed with older types are indexed again once nothing uses the
  // space (now, or when its use ends; a space always in use, at its next
  // opening).
  #rebuildLater () {
    if (!this._stale || this._inUse || this.closed || !this.opened) return
    this._stale = false
    this.hg._rebuildSpace(this).catch(safetyCatch)
  }

  /**
   * @param {string} type
   * @param {Record<string, unknown> | null | undefined} values
   */
  #spaceHas (type, values) {
    const app = this.hg._types
    if (!app.has(type)) return
    /** @param {string} what */
    const lacks = (what) => new HypergraphError('INCOMPATIBLE_TYPES', `This space doesn't have ${what} yet: its owner's or an admin's app records it when it opens the space, updated, or with space.declareTypes()`)
    if (!this._types.has(type)) throw lacks(`the type "${type}"`)
    const known = this._types.get(type).byName
    for (const [field, value] of Object.entries(values || {})) {
      if (value !== undefined && !known.has(field) && app.get(type).byName.has(field)) throw lacks(`the field "${field}" of ${type}`)
    }
  }


  /**
   * Opens the space if it is closed. Then its sync getters (`state`, `subspaces()`, `status()`) can be read.
   * @returns {Promise<void>}
   */
  async ready () {
    await this._ready()
    this._touch()
  }

  /**
   * Keeps the space open until the returned function is called (a page showing it).
   * @returns {Promise<function(): void>} `release`.
   */
  async hold () {
    this._use()
    try {
      await this._ready()
    } catch (err) {
      this._unuse()
      throw err
    }
    let held = true
    return () => {
      if (!held) return
      held = false
      this._unuse()
    }
  }

  async _ready () {
    if (this.opened && !this._shutting) return
    while (this._shutting) await this._shutting // closing to be opened again: not closed for good
    if (this.closed) throw new HypergraphError('CLOSED', 'This space is closed')
    if (this.opened) return
    if (!this._opening) this._opening = this.hg._openShell(this).finally(() => { this._opening = null })
    await this._opening
  }

  _touch () {
    this._used = Date.now()
    if (this._uses === 0) this.#idleLater()
  }

  _use () {
    this._uses++
    this._used = Date.now()
    if (this._idleTimer) {
      clearTimeout(this._idleTimer)
      this._idleTimer = null
    }
    if (this.opened) this.hg._network.used(this)
  }

  _unuse () {
    this._used = Date.now()
    if (--this._uses > 0) return
    this.#idleLater()
    if (this._stale) this.#rebuildLater()
  }

  #mustBeOpen () {
    if (!this._log) throw new Error('This space is closed until it is used: await space.ready() first (spec 015)')
  }

  get _inUse () {
    if (this._uses > 0 || this._protocols.size > 0) return true
    for (const name of this.eventNames()) if (typeof name === 'string' && name[0] !== '_' && this.listenerCount(name) > 0) return true
    return false
  }

  #idleLater () {
    if (this._seeded || this.closed || this._idleTimer) return
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null
      if (this.closed || this._seeded || !this.opened) return
      if (this._inUse || Date.now() - this._used < this.hg.idleMs) return this.#idleLater()
      this.hg._closeIdle(this).catch(safetyCatch)
    }, this.hg.idleMs)
    if (this._idleTimer.unref) this._idleTimer.unref()
  }

  /**
   * @param {{ create?: (Parameters<import('./decisions/log.js').Decisions['init']>[0] & { renewed?: (key: Uint8Array) => import('./encodings.js').DecisionBody[] }) | null }} [opts]
   */
  async _open ({ create = null } = {}) {
    const hg = this.hg
    this.store = hg.store.namespace(this.ns)
    if (this.rootKey) {
      this._discoveryKey = crypto.discoveryKey(this.keyBytes)
      this.decisionLog = await hg._decisions(this.rootKey)
    } else {
      const make = () => {
        const log = new Decisions(this.store, this.keyBytes, { identity: hg._identity, wakeup: hg._network.wakeup, keyPair: this._keyPair, encryptionKey: this.encryptionKey, now: () => hg._now() })
        log.once('waiting', () => this.emit('_waiting')) // Hypergraph.open goes on without it
        return log
      }
      if (this.personal || !this.keyBytes) {
        this.decisionLog = make()
        await this.decisionLog.ready()
        if (create) await this.decisionLog.init(create)
        if (create && create.renewed) for (const d of create.renewed(this.decisionLog.key)) await this.decisionLog.append(d) // the old state, before anything else
        if (!this.personal) hg._shareDecisions(this.decisionLog.key, this.decisionLog)
      } else {
        this.decisionLog = await hg._decisions(this.keyBytes, make) // a guest of a sub-space may have opened it
      }
      this._keyPair = null
      this.keyBytes = this.decisionLog.key
    }

    const me = hg._identity.publicKey
    const space = this
    const ctx = this._ctx = /** @type {SpaceContext} */ ({
      db: hg.db,
      queue: hg._queue,
      get directory () { return space.directory },
      get byActivity () { return space._reading.byActivity },
      get listDelay () { return /** @type {Seams} */ (hg)[symbols.slowLists] || 0 },
      get idleMs () { return (/** @type {Seams} */ (hg)[symbols.idleLogs] || /** @type {{ idle?: number }} */ ({})).idle || 0 }, // tests only (lib/testing.js idleLogs)
      get claimMs () { return (/** @type {Seams} */ (hg)[symbols.idleLogs] || /** @type {{ claims?: number }} */ ({})).claims || 0 },
      get helpers () { return space._helpers },
      // a log's core opened or closed (lib/directory.js), a peer
      // holding more of it, its cached length and size to save
      opened: (log) => this.replicator.opened(log),
      closedLog: (log) => this.replicator.closedLog(log),
      behind: (log) => this.replicator.check(log),
      saveLog: (log) => hg._queue.run((tx) => tx.insert('@hg/meta', droppedRow(ctx, log))),
      fromOf: (key) => this.#fromOf(key),
      summary: (m) => this.#onSummary(m),
      entries: (rows) => this.#entries(rows),
      activityKept: (rows) => this.activity.kept(rows),
      coveredFrom: () => this.#coveredFrom(),
      limitFor: (log) => this.#limitFor(log),
      horizon: () => (this._undecided ? null : this._reading.horizon),
      restart: (log) => this.replicator.restart(log),
      key: this.keyBytes,
      discoveryKey: this.discoveryKey,
      decisions: this.top, // the decision log its log headers must name (lib/gate.js)
      get types () { return space._types },
      rules: hg.rules,
      store: this.store,
      me,
      personal: this.personal,
      stamper: hg._stamper,
      get state () { return ctxState() },
      getCore: (key) => this.store.get({ key, ...this.#coreOptsOf(key) }),
      pastOf: (key) => this._pastOf(key),
      readByDecisions: (key) => this.decisionLog.uses(key),
      limitOf: (identity, device, log, admitted) => this.limitOf(identity, device, log, admitted),
      mayRetry: (identity, device, log) => !this.isRemoved(identity, device) && !this.state.isCut(identity, log),
      allowed: (log, record, values) => this.#allowed(log, record, values),
      removed: (values, identity) => this.#removed(values, identity),
      locked: (bytes) => this.#locked(bytes),
      unseal: (log, seq, record) => this.#unseal(log, seq, record),
      accepted: (log) => {
        this.activity.logAccepted(log.key)
        this.#keysLater() // a device to grant, in a private space
        hg._logAccepted(this, log.key) // named for a rebuild (lib/instance.js)
        this.replicator.hold(log)
        this._helpers.hold(log)
        this.#listLater()
        this.#logsChanged()
        if (!log.own && !b4a.equals(log.device, log.identity)) this.emit('members') // a member's device
      },
      logOf: (key) => this.directory.logs.get(hex(key)) || null,
      cut: (log, limit) => this.#cut(log, limit).catch(safetyCatch),
      changed: (changes) => this.#changed(changes),
      clear: (id, opts) => this.#clear(id, opts),
      progress: () => {
        this.emit('_progress')
        this.#statusLater() // complete may have changed
      },
      proof: hg._identity.proof, // sent to peers on the space channel (hello)
      peersChanged: () => {
        if (this.closed) return
        this.emit('peers', this.peers())
        this.#memberConnected()
      },
      redeem: (bytes, ch) => this.#redeem(bytes, ch),
      ask: (bytes) => this.#onAsk(bytes),
      channelOpened: (ch) => {
        if (this._redemption && !this.state.isRecorded(me)) ch.messages[5].send({ redemption: this._redemption })
        for (const bytes of this._asks.values()) ch.messages[6].send({ decision: bytes })
        for (const name of this._protocols.keys()) this.#openProtocol(ch, name)
      }
    })
    const ctxState = () => this.state
    if (await this.#checkTypes()) { // indexed again from its logs
      await hg._clearRows(this)
      this._rebuild = true
    }
    this.own = await this.#openOwnLog()
    this._idcore = this.store.get({ name: 'identity-log', ...this._coreOpts })
    await this._idcore.ready()
    await this.#loadReading()
    this.activity = ctx.activity = new Activity(ctx)
    this.directory = new Directory(ctx)
    this.indexer = ctx.indexer = new Indexer(ctx, hg._queue)
    this.replicator = new Replicator(ctx)
    this._helpers = new Helpers(this)

    const removals = { gte: { space: this.keyBytes, type: 'hg/device-remove' }, lte: { space: this.keyBytes, type: 'hg/device-remove' } }
    for (const row of await this.db.find('@hg/by-type', removals).toArray()) this.#removed(/** @type {{ removed: Uint8Array, cut: Uint8Array, proof: Uint8Array }} */ (this._types.decode(row.type, row.fields, row.links)), row.author, false)
    const rows = await this.db.find('@hg/logs', { gte: { space: this.keyBytes }, lte: { space: this.keyBytes } }).toArray()
    for (const row of rows) {
      if (row.refused) continue
      const mine = b4a.equals(row.log, this.own.key) ? this.own.core : b4a.equals(row.log, this._idcore.key) ? this._idcore : null
      const cut = row.cut || null // the index stores "none" as 0; a kept log's cut is at least 2
      const dropped = await this.db.get('@hg/meta', { name: droppedName(this.keyBytes, row.log) })
      const counters = dropped ? JSON.parse(b4a.toString(dropped.value)) : {}
      const from = mine || counters.from === undefined ? 1 : counters.from // where reading it starts
      // a held log stays closed, its length, size and
      // header's code as saved; one saved before that is opened once to read them
      const cached = !mine && counters.len !== undefined
      const core = cached ? null : mine || this.store.get({ key: row.log, ...this.#coreOptsOf(row.log) })
      const header = cached ? null : await /** @type {import('hypercore')} */ (core).get(0, { wait: false }).catch(() => null)
      const admitted = cached ? counters.adm ?? null : header ? admittedOf(header) : null
      const log = await this.directory.accept(row.log, core, row, { indexed: row.indexed, own: !!mine, announce: false, limit: cut ?? Infinity, cut, from, act: counters.act || null, admitted, length: counters.len || 0, byteLength: counters.size || 0, handed: counters.hand ?? -1, handedTo: counters.to ?? null })
      if (log && dropped) { // content dropped from it here, its index entries' bytes
        const { bytes, blocks, ix = 0 } = counters
        log.dropped = bytes
        log.droppedBlocks = blocks
        log.ixBytes = ix
      }
    }
    if (hg._rebuilding || this._rebuild) await this.#rediscover()
    await this.#seenOwn()
    this._budget = await hg._loadBudget(this)
    this._onchange = (state, keys) => { this._decided = this.#onDecisions(touched(keys)).catch(safetyCatch) }
    this.decisionLog.on('change', this._onchange)
    this._onfailed = () => this._statusChanged() // a DECISIONS_FAILED warning (status())
    this.decisionLog.on('failed', this._onfailed)
    await this.#onDecisions()
    if (this._rebuild) {
      this._rebuild = false
      await hg._indexedNow(this, this._types.describe())
    }
    this.opened = true
    if (create) await this.#recordTypes() // in the space's first decisions
    else this.#recordTypes().catch(safetyCatch)
  }

  // The index was lost: the logs this device had
  // accepted here, named in the instance's logs file, are checked by the gate
  // again from their held headers and indexed from their start.
  async #rediscover () {
    const me = this.hg._identity
    for (const key of this.hg._knownLogs(this)) {
      if (this.directory.logs.has(hex(key))) continue
      if (b4a.equals(key, this._idcore.key)) {
        await this.directory.accept(key, this._idcore, { identity: me.publicKey, device: me.publicKey }, { own: true, announce: false })
      } else if (!b4a.equals(key, this.own.key)) {
        await this.directory.consider(key)
      } else if (this.own.core.length > 1) { // written in: known (a log is accepted at its first record)
        await this.directory.accept(key, this.own.core, { identity: me.publicKey, device: me.device.publicKey }, { own: true, announce: false, admitted: this.own.admitted })
      }
    }
  }

  // This device's log in the space: the first one not cut. A member removed
  // and let in again writes in a new log: the old one counts up to its cut
  // only, for good.
  /**
   * @param {number} [from]
   * @returns {Promise<import('./log.js').OwnLog & { generation: number }>}
   */
  async #openOwnLog (from = 0) {
    const me = this.hg._identity
    for (let n = from; ; n++) {
      const own = /** @type {import('./log.js').OwnLog & { generation: number }} */ (new OwnLog(this.store.get({ name: n ? `log/${n}` : 'log', ...this._coreOpts }), { space: this.keyBytes, identity: me, decisions: this.top, admitted: () => this.state.admission(me.publicKey) }))
      await own.ready()
      own.generation = n
      if (!this.state.isCut(me.publicKey, own.key) && !this.state.isEditCut(me.publicKey, own.key) && !this.#unadmitted(own)) return own
      await own.core.close()
    }
  }

  // Cut (removed, banned, or an edit permission taken away) and let back
  // in: this device writes in a new log. Before any
  // write, so nothing lands in the cut one.
  async #ownUncut () {
    while (this._reopening) await this._reopening
    const me = this.hg._identity.publicKey
    if (!this.state.canWrite(me) || !(this.state.isCut(me, this.own.key) || this.state.isEditCut(me, this.own.key) || this.#unadmitted(this.own))) return
    this._reopening = this.#openOwnLog(this.own.generation + 1).then((own) => { this.own = own })
    try {
      await this._reopening
    } finally {
      this._reopening = null
    }
  }

  /**
   * @param {import('./log.js').OwnLog} own
   */
  #unadmitted (own) {
    const me = this.hg._identity.publicKey
    return this.state.mustAdmit(me, own.key) && own.admitted !== this.state.admission(me)
  }

  // `changed`: what the decisions touched (lib/decisions/state.js touched):
  // what runs here looks only there.
  /**
   * @param {import('./decisions/state.js').Touched} [changed]
   */
  async #onDecisions (changed = touched(null)) {
    if (this.closed) return
    if (changed.types && this.opened) await this.#typesChanged()
    const me = this.hg._identity
    await this.#ownUncut()
    // a member's log is announced at its first record
    // (#log), so a silent member costs nobody anything; in a private space at
    // join, so key holders see its device and grant it the key (and the personal space, as before)
    if ((this.state.private || this.personal) && this.state.isMember(me.publicKey) && !this.directory.logs.has(hex(this.own.key))) {
      await this.directory.accept(this.own.key, this.own.core, { identity: me.publicKey, device: me.device.publicKey }, { own: true, admitted: this.own.admitted })
    }
    const cutting = this.directory.recheck(changed)
    this.#considerListed(changed)
    this._helpers.update()
    this.#listLater()
    this.activity.channelOpened() // a peer may be a member now: asked for activity lists
    await this.indexer.moderate(changed)
    await this.indexer.reauthorize(changed)
    await this.#limitChanged()
    this.#claim()
    this.#keysLater()
    this.#followLater()
    this.#considerPasts()
    if (this.state.trims.size) this._trims().catch(safetyCatch)
    await this.#recordRemovals()
    await cutting // what lost its right to count is out of every list before anyone hears
    this.#memberConnected() // a peer may be a member now
    this.emit('_progress')
    this.emit('_decided')
    this.emit('decisions')
    this.emit('members')
    this.hg._circles.changed(this) // a circle's members
    if (!this.personal) this.hg._spacesChanged() // a name, a sub-space
    this._statusChanged()
    this.hg._holdLater()
    if (!this.personal) this.hg._openSubspaces().catch(safetyCatch) // members have its sub-spaces
  }

  #considerPasts () {
    const pasts = this.state.pasts
    if (this.personal || pasts.size === this._pastsSeen) return
    this._pastsSeen = pasts.size
    for (const [h, p] of pasts) {
      if (p.in !== this.hex || this.directory.logs.has(h)) continue
      this.directory.refused.delete(h) // a peer may have named it before this state did: checked against this space then
      this.directory.consider(b4a.from(h, 'hex')).catch(safetyCatch)
    }
  }


  // A device of a member who may decide or moderate claims its writer key of
  // the decision log: any writer records the claim (the member's other
  // device, an admin), so no one has to do anything.
  #claim () {
    const me = this.hg._identity
    const key = this.decisionLog.localKey
    const state = this.state
    for (const [h, bytes] of this._asks) if (this.#settled(bytes)) this._asks.delete(h)
    if (!state.meta || !state.writesDecisions(me.publicKey) || state.writer(key) || state.isGone(me.publicKey, me.device.publicKey)) return
    if (Date.now() - this._claimed < CLAIM_MS) return
    this._claimed = Date.now()
    this.#ask({ type: 'writer/add', key, proof: initProof(me, key, this.top) })
  }

  /**
   * @param {import('./encodings.js').DecisionBody} decision
   */
  #ask (decision) {
    const bytes = c.encode(enc.decision, { stamp: Date.now(), ...decision })
    this._asks.set(hex(crypto.hash(bytes)), bytes)
    this.directory.sendAsk(bytes)
  }

  /**
   * @param {Uint8Array} bytes
   */
  #settled (bytes) {
    let d = null
    try { d = c.decode(enc.decision, bytes) } catch { return true }
    if (d.type === 'writer/add') return !!this.state.writer(d.key) || !this.state.writesDecisions(this.hg._identity.publicKey)
    if (d.type === 'device/remove') return this.state.isGone(this.hg._identity.publicKey, d.device)
    return true
  }

  // Removals of devices (signed by their identity keys, indexed from
  // identity logs) reach the decision log too, so a removed device's writer
  // keys stop counting, now or if its member is promoted later. Any writer
  // records them; a device of the same identity asks if it can't.
  async #recordRemovals () {
    // A removal's proof names the space it was written in; the decision log
    // is the top space's, so a sub-space leaves it to its top space.
    if (this.rootKey) return
    const me = this.hg._identity.publicKey
    const writer = this.decisionLog.writable && !!this.state.writer(this.decisionLog.localKey)
    for (const [h, r] of this._removed) {
      if (this.state.isGone(r.identity, r.device)) {
        this._removed.delete(h)
        continue
      }
      /** @type {import('./encodings.js').DecisionBody} */
      const decision = { type: 'device/remove', device: r.device, cut: r.cut, proof: r.proof }
      if (writer) await this.#append(h, decision).catch(safetyCatch)
      else if (b4a.equals(r.identity, me) && !this._asking.has(h)) {
        this._asking.add(h)
        this.#ask(decision)
      }
    }
  }

  /**
   * @param {string} tag
   * @param {import('./encodings.js').DecisionBody} decision
   */
  async #append (tag, decision) {
    if (this._asking.has('append:' + tag) || this.closed) return
    this._asking.add('append:' + tag)
    try {
      await this.decisionLog.append(decision)
    } finally {
      this._asking.delete('append:' + tag)
    }
  }

  // A peer asks us to record a decision it can't write: only the
  // self-signed kinds, and only if they would count.
  /**
   * @param {Uint8Array} bytes
   */
  async #onAsk (bytes) {
    if (this.closed || !this.decisionLog.writable || !this.state.writer(this.decisionLog.localKey)) return
    let d = null
    try { d = c.decode(enc.decision, bytes) } catch { return }
    const state = this.state
    if (d.type === 'writer/add') {
      const info = Identity.verify(d.proof, writerSignable(d.key, this.top))
      if (!info || state.writer(d.key) || !state.writesDecisions(info.identity) || state.isGone(info.identity, info.device)) return
      await this.#append(hex(d.key), { type: d.type, key: d.key, proof: d.proof })
    } else if (d.type === 'device/remove' && !this.rootKey) {
      const info = Identity.verify(d.proof, removalSignable(this.keyBytes, d.device, d.cut))
      if (!info || !b4a.equals(info.device, info.identity) || state.isGone(info.identity, d.device)) return
      await this.#append(removalKey(info.identity, d.device), { type: d.type, device: d.device, cut: d.cut, proof: d.proof })
    }
  }

  // "Newest own seen": the last record of each of this
  // identity's logs held here, so stamps stay above them after a restart
  // even if this device's clock was ahead then.
  async #seenOwn () {
    const me = this.hg._identity.publicKey
    for (const log of this.directory.logs.values()) {
      if (!b4a.equals(log.identity, me) || log.length < 2) continue
      const bytes = await this.directory.get(log, log.length - 1, { wait: false }).catch(() => null)
      if (!bytes) continue
      try { this.hg._stamper.seen(enc.decodeRecord(bytes).stamp) } catch {}
    }
  }


  /**
   * @param {Uint8Array} identity
   * @param {Uint8Array | null} device
   * @param {Uint8Array} log
   * @param {string | null} [admitted]
   * @returns {number}
   */
  limitOf (identity, device, log, admitted = null) {
    let limit = this.state.limitOf(identity, log)
    const past = this._pastOf(log)
    if (past) limit = Math.min(limit, past.cut) // past its cut, written after the move (re-posted by its author, if at all)
    const identityLog = device && b4a.equals(device, identity) // device removals: never cut
    if (limit > 1 && !identityLog && this.state.mustAdmit(identity, log) && admitted !== this.state.admission(identity)) limit = 0
    const removals = device && this.removals.get(removalKey(identity, device))
    if (!removals) return limit
    let cut = limit
    for (const r of removals) cut = Math.min(cut, r[hex(log)] ?? 0)
    return cut
  }

  /**
   * @param {Uint8Array} identity
   * @param {Uint8Array | null} device
   */
  isRemoved (identity, device) {
    return !!device && this.removals.has(removalKey(identity, device))
  }

  // Is this record allowed where it is? Hypergraph's own types have their
  // places: an identity log holds signed removals only, removals are only
  // there, and the personal space's own records only in it.
  /**
   * @param {{ key: Uint8Array, device: Uint8Array, identity: Uint8Array }} log
   * @param {{ type: string, kind: number }} record
   * @param {import('./fields.js').DecodedFields | null} values
   */
  #allowed (log, record, values) {
    const identityLog = b4a.equals(log.device, log.identity)
    if (identityLog || record.type === 'hg/device-remove') {
      return identityLog && record.type === 'hg/device-remove' && record.kind === enc.PUT && this.#validRemoval(log, values)
    }
    return !PERSONAL.has(record.type) || this.personal
  }

  /**
   * @param {{ key: Uint8Array, identity: Uint8Array }} log
   * @param {import('./fields.js').DecodedFields | null} values
   */
  #validRemoval (log, values) {
    const { removed: device, cut, proof } = values || {}
    if (!device || device.byteLength !== 32 || b4a.equals(device, log.identity) || !cut || !proof) return false
    try { c.decode(cutList, cut) } catch { return false }
    const info = Identity.verify(proof, removalSignable(this.#adOf(log.key), device, cut))
    return !!info && b4a.equals(info.identity, log.identity) && b4a.equals(info.device, log.identity)
  }

  /**
   * @param {{ removed: Uint8Array, cut: Uint8Array, proof: Uint8Array }} values
   * @param {Uint8Array} identity
   * @param {boolean} [recheck]
   */
  #removed ({ removed: device, cut, proof }, identity, recheck = true) {
    /** @type {Record<string, number>} */
    const logs = {}
    for (const { log, length } of c.decode(cutList, cut)) logs[hex(log)] = length
    const h = removalKey(identity, device)
    if (!this.removals.has(h)) this.removals.set(h, [])
    this.removals.get(h).push(logs)
    if (!this._removed.has(h)) this._removed.set(h, { identity, device, cut, proof })
    if (recheck && !this.closed) {
      this.directory.recheck()
      this.emit('_removed', device)
      this.#recordRemovals().catch(safetyCatch)
    }
  }

  // Removes `device` (of this identity) from this space: a removal signed by
  // the identity key, in this device's identity log, cutting the device's
  // logs where this device holds them, or where the device's last heads
  // say if further (`heads`: { log hex: length }, from the personal space).
  /**
   * @param {Uint8Array} device
   * @param {{ keyPair: import('./identity.js').KeyPair }} secrets
   * @param {Record<string, number>} [heads] Its last heads here: log hex -> length.
   */
  async _removeDevice (device, secrets, heads = {}) {
    if (this.closed || this.isRemoved(this.hg._identity.publicKey, device)) return
    /** @type {Record<string, number>} */
    const lengths = { ...heads }
    for (const log of this.directory.logs.values()) {
      if (!b4a.equals(log.device, device) || !b4a.equals(log.identity, this.hg._identity.publicKey)) continue
      const held = Math.min(log.indexed, log.limit)
      lengths[hex(log.key)] = Math.max(held, lengths[hex(log.key)] || 0)
    }
    const cut = c.encode(cutList, Object.entries(lengths).map(([log, length]) => ({ log: b4a.from(log, 'hex'), length })))
    const proof = Identity.attestAsIdentity(removalSignable(this.keyBytes, device, cut), secrets.keyPair)
    const log = await this.#identityLog(secrets)
    const { fields, links } = this._types.encode('hg/device-remove', { removed: device, cut, proof })
    await log.append({ kind: enc.PUT, type: 'hg/device-remove', stamp: this.hg._stamper.next(), target: null, links, fields })
    await this.indexer.index(/** @type {HeldLog} */ (this.directory.logs.get(hex(log.key))))
  }

  /**
   * @param {{ keyPair: import('./identity.js').KeyPair }} secrets
   */
  async #identityLog (secrets) {
    const me = this.hg._identity
    const log = new OwnLog(this._idcore, { space: this.keyBytes, identity: me, decisions: this.top, attest: (data) => Identity.attestAsIdentity(data, secrets.keyPair) })
    await log.ready()
    if (!this.directory.logs.has(hex(log.key))) {
      await this.directory.accept(log.key, log.core, { identity: me.publicKey, device: me.publicKey }, { own: true })
    }
    return log
  }

  _heads () {
    const me = this.hg._identity.device.publicKey
    const out = []
    for (const log of this.directory.logs.values()) if (b4a.equals(log.device, me)) out.push({ log: log.key, length: log.length })
    return out
  }


  /**
   * Writes a record.
   * @param {string} type One of the space's types.
   * @param {Record<string, unknown>} values Its fields. A field given as `undefined` counts as absent; a link field takes a record or its id.
   * @returns {Promise<HgRecord>} The record: `{ id, type, author, device, stamp, edited, ...fields }`.
   * @throws {HypergraphError} The write errors (see {@link Space}). `INVALID_TYPE` for hypergraph's own types (`hg/...`).
   */
  async put (type, values) {
    if (typeof type === 'string' && type.startsWith('hg/')) throw new HypergraphError('INVALID_TYPE', `"${type}" is hypergraph's own type`)
    return this._put(type, values)
  }

  // put(), hypergraph's own types included. `replaces`: the stamp of the
  // version this one replaces (a relation, a tag), to be stamped above it.
  /**
   * @param {string} type
   * @param {Record<string, unknown>} values
   * @param {number} [replaces]
   * @returns {Promise<HgRecord>}
   */
  async _put (type, values, replaces = 0) {
    await this.#mayPost()
    this.#spaceHas(type, values)
    const v = this._types.validate(type, values)
    await this.#mayPutType(type)
    await this.#checkLinks(type, v)
    this.#checkRules(type, v)
    const { fields, links } = this._types.encode(type, v)
    replaces = Math.max(replaces, await this.#linkedStamp(links))
    const seq = await this.#write({ kind: enc.PUT, type, stamp: this.hg._stamper.next({ replaces }), target: null, links, fields })
    return this.#written(seq)
  }

  /**
   * @param {string} type
   */
  async #mayPutType (type) {
    const put = this._types.get(type).put
    if (put.by !== 'permission') return
    await this.#unless(() => this.state.can(this.hg._identity.publicKey, put.permission) ? null : `Only members whose role has the permission "${put.permission}" put a ${type} (your role is ${this.#myRole()})`)
  }

  /**
   * Reads a record.
   * @param {HgRecord|string|Uint8Array} id A record or its id.
   * @param {object} [opts]
   * @param {number} [opts.timeout] Wait up to this long (ms) while incomplete.
   * @returns {Promise<{record: (HgRecord|null), complete: boolean, deleted: (Deletion|null)}>} `record` is null if not held, or deleted. `deleted`: null (held, or nothing here says), `{ by: 'author', stamp, device }` or `{ by: 'space' }` (taken down by a moderator). A hidden record is returned with `hidden: true`.
   */
  async get (id, { timeout } = {}) {
    const key = idOf(id)
    const { record, complete } = await this._bounded(async (deadline) => {
      const row = await this.db.get('@hg/records', { space: this.keyBytes, id: key })
      if (!row) return { record: null, need: this.#needOf(key) }
      if (!gate.mayPut(this._types, row, this.state)) return { record: null, need: row.stamp } // a put its author had no right to
      const { items, partial } = await this._shaped([row], deadline)
      return { record: items[0] || null, partial, need: row.stamp }
    }, timeout)
    return { record, complete, deleted: record ? null : await this.#deletedOf(key) }
  }

  /**
   * @param {Uint8Array} key
   * @returns {Promise<import('./index/indexer.js').Deletion | null>}
   */
  async #deletedOf (key) {
    if (this.state.isRemoved(key)) return { by: 'space' }
    const log = this.directory.logs.get(hex(enc.idParts(key).log))
    if (!log) return null
    const range = { gte: { space: this.keyBytes, target: key }, lte: { space: this.keyBytes, target: key } }
    let del = null
    for (const ch of await this.db.find('@hg/changes', range).toArray()) {
      if (ch.kind === enc.DELETE && b4a.equals(ch.author, log.identity) && (!del || compare(ch, del) > 0)) del = ch
    }
    return del ? { by: 'author', stamp: del.stamp, device: z32.encode(del.device) } : null
  }

  /**
   * Changes some fields of a record; the others stay, and it keeps its id. Its author edits it, or
   * anyone the type's `editable` allows.
   * @param {HgRecord|string} id A record or its id.
   * @param {Record<string, unknown>} changes The fields to change; `undefined` leaves a field as it was.
   * @returns {Promise<HgRecord>} The record's new version.
   * @throws {HypergraphError} `NOT_FOUND` for a record not held here; `NOT_ALLOWED` if this person may not edit it; The write errors (see {@link Space}).
   */
  async edit (id, changes) {
    /** @type {RecordRow | null} */
    let row = await this.#changeable(id, 'edit')
    if (row.flags & FLAGS.DROPPED) { // its content was dropped here: fetched first
      row = await this.#content(row, Date.now() + BOUND_MS)
      if (!row) throw new HypergraphError('NOT_FOUND', 'This record\'s content is no longer held here and no member holding it answered: try again later')
    }
    const current = this._types.decode(row.type, row.fields, row.links)
    const given = Object.fromEntries(Object.entries(changes || {}).filter(([, value]) => value !== undefined))
    this.#spaceHas(row.type, given)
    const v = this._types.validate(row.type, { ...current, ...given })
    await this.#checkLinks(row.type, v)
    this.#checkRules(row.type, v, row.id)
    const { fields, links } = this._types.encode(row.type, v, { fields: row.fields, links: row.links || [] })
    const replaces = Math.max(row.vstamp, await this.#linkedStamp(links))
    await this.#write({ kind: enc.EDIT, type: row.type, stamp: this.hg._stamper.next({ replaces }), target: row.id, links, fields })
    await this.indexer.index(this.#ownLog())
    return /** @type {HgRecord} */ ((await this.get(row.id, { timeout: 0 })).record)
  }

  /**
   * Deletes a record. Only its author deletes it; a moderator's `del()` of someone else's record takes
   * it down (a moderation decision). Editors of a shared type edit, they don't delete.
   * @param {string} id
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_FOUND`; `NOT_ALLOWED` for someone else's record without moderation rights; The write errors (see {@link Space}).
   */
  async del (id) {
    const row = await this.#changeable(id, 'delete', () => this.state.can(this.hg._identity.publicKey, 'moderate'))
    if (!b4a.equals(row.author, this.hg._identity.publicKey)) return this.moderateAction('remove', row.id)
    await this.#write({ kind: enc.DELETE, type: row.type, stamp: this.hg._stamper.next({ replaces: row.vstamp }), target: row.id, links: [], fields: b4a.alloc(0) })
    await this.indexer.index(this.#ownLog())
  }

  /**
   * @param {HgRecord | string} id
   * @param {'edit' | 'delete'} what
   * @param {() => boolean} [also]
   * @returns {Promise<RecordRow>}
   */
  async #changeable (id, what, also = () => false) {
    await this.#mayPost()
    const row = await this.#row(id)
    if (row.type.startsWith('hg/')) throw new HypergraphError('NOT_ALLOWED', `A ${row.type} is hypergraph's own record`)
    const kind = what === 'delete' ? enc.DELETE : enc.EDIT
    await this.#unless(() => {
      if (gate.mayChange(this._types, { kind, type: row.type, author: this.hg._identity.publicKey, id: null }, row, this.state) || also()) return null
      const editable = this._types.get(row.type).editable
      if (kind === enc.DELETE) return `Only its author${editable.by === 'author' ? '' : ' or a moderator'} deletes this ${row.type}${editable.by === 'author' ? '' : ' (its editors edit it)'}`
      if (editable.by === 'permission') return `You may not edit this ${row.type}: it needs the permission "${editable.permission}" (your role is ${this.#myRole()})`
      return `You may not edit this ${row.type}: only its author`
    })
    return row
  }

  /**
   * @param {HgRecord | string} id
   * @returns {Promise<RecordRow>}
   */
  async #row (id) {
    const row = await this.db.get('@hg/records', { space: this.keyBytes, id: idOf(id) })
    if (!row) throw new HypergraphError('NOT_FOUND', `No record ${typeof id === 'string' ? id : id.id} here`)
    return row
  }

  async #mayPost () {
    if (this.closed) throw new HypergraphError('CLOSED', 'This space is closed')
    this.#notMoved()
    if (this.isRemoved(this.hg._identity.publicKey, this.hg._identity.device.publicKey)) throw new HypergraphError('DEVICE_REMOVED', 'This device was removed from the account: what it writes is ignored')
    await this.#unless(() => {
      const me = this.hg._identity.publicKey
      if (this.state.canWrite(me)) return null
      if (this.state.can(me, 'post')) return `Only some roles write here (${/** @type {SubView} */ (this.state).writeRoles.join(', ')}, and the owner and admins): yours is ${this.#myRole()}`
      return this.#whyNot('write in it')
    })
  }

  async #log () {
    await this.#ownUncut()
    const me = this.hg._identity
    if (!this.directory.logs.has(hex(this.own.key))) await this.directory.accept(this.own.key, this.own.core, { identity: me.publicKey, device: me.device.publicKey }, { own: true, admitted: this.own.admitted })
    return this.own
  }

  [symbols.ownLog] () { return this.#log() }

  /**
   * @param {WireRecord} record
   * @returns {Promise<number>} Its block.
   */
  async #write (record) {
    const log = await this.#log()
    await this.#withinLimit(log, record)
    return log.append(record, await this.#sealer(record, log))
  }


  // The limit `log`'s records are judged by: the space's, except in the
  // personal space and for identity logs (device removals).
  /**
   * @param {{ device: Uint8Array, identity: Uint8Array }} log
   */
  #limitFor (log) {
    if (this.personal || b4a.equals(log.device, log.identity)) return null
    return this.state.writeLimit
  }

  // Refuses a record no member would count: beyond the limit.
  /**
   * @param {import('./log.js').OwnLog} own
   * @param {WireRecord} record
   */
  async #withinLimit (own, record) {
    const limit = this.state.writeLimit
    if (!limit || this.personal || PLAIN.has(record.type) || record.kind === enc.DELETE) return
    /** @param {number} i */
    const at = async (i) => {
      const bytes = await own.core.get(i, { wait: false }).catch(() => null)
      if (bytes) return enc.decodeRecord(bytes).stamp
      const log = this.directory.logs.get(hex(own.key))
      return log && await this.indexer.isWiped(log, i) ? -1 : null
    }
    const seq = own.core.length
    const when = await limits.nextAllowed(seq, record.stamp, limit, at)
    if (!when) return
    const again = when === Infinity ? 'later' : `after ${new Date(when).toISOString()}`
    throw new HypergraphError('NOT_ALLOWED', `This space allows ${limit.records} records per ${Math.round(limit.periodMs / 1000)} s from each device: you may write again ${again}`)
  }

  /**
   * Lets each device's log count at most `records` records within any `periodMs` (open spaces
   * against floods). A record past it counts for nobody; deleting never frees room; raising or lifting the
   * limit brings refused records back.
   * @param {{records: number, periodMs: number}|null} limit null lifts it.
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_ALLOWED` for who may not decide.
   */
  async setWriteLimit (limit) {
    if (limit !== null && !limits.validLimit(limit)) throw new TypeError('A write limit is { records, periodMs }: whole numbers, at least 1 (or null: none)')
    await this.#mayDecide('decide', 'set the write limit')
    await this.#decide({ type: 'settings/set', policy: null, writeLimit: limit ? { records: limit.records, periodMs: limit.periodMs } : { records: 0, periodMs: 0 }, rules: null })
  }

  // The limit records were judged by here (saved), and the one now: if they
  // differ, every log is judged again (a raised or lifted limit reads the
  // logs again, so records refused before come back).
  async #limitChanged () {
    const now = JSON.stringify(this.state.writeLimit)
    const name = 'limit:' + this.hex
    if (this._limitSig === undefined) {
      const row = await this.db.get('@hg/meta', { name })
      this._limitSig = row ? b4a.toString(row.value) : 'null'
    }
    if (now === this._limitSig || this.closed) return
    const before = JSON.parse(this._limitSig)
    const after = this.state.writeLimit
    this._limitSig = now
    await this.hg._queue.run((tx) => tx.insert('@hg/meta', { name, value: b4a.from(now) }))
    const looser = !after || (before && (after.records > before.records || after.periodMs < before.periodMs))
    for (const log of [...this.directory.logs.values()]) await this.indexer.rejudge(log, { again: looser })
  }

  // Content is sealed with an epoch key; each key reaches the devices of the
  // members entitled to read in `hg/grant` records (lib/private/grants.js),
  // written by whoever holds it. When someone loses access, a key holder who
  // may decide or moderate changes the key (`key/rotate`) and grants the new
  // one to who is left. Keys live in memory only (#epochKeys), re-opened from
  // the grants in the index after a restart; never logged or shown.
  // Each key unlocks the ones before it (`hg/key-link` records: an older
  // key sealed with a newer one), so a newcomer reads the whole history,
  // unless the space hides it (`history: 'hidden'`): then no link is written
  // nor followed, a newcomer's arrival changes the key, and records sealed
  // before the first key this device got don't count as missing here.

  #epochKeys = new Map() // commitment, short form (hex) -> key
  #epochOf = new Map() // commitment, short form (hex) -> its epoch
  #granting = new Set() // `${device z32}:${commitment hex}`: grants this device wrote, indexed or not yet
  /** @type {import('./identity.js').KeyPair | null} */
  #box = null // this device's box key pair

  /**
   * Who reads a private space's history: `'visible'` (every member, the default) or `'hidden'`
   * (each member from its join on).
   * @type {string}
   */
  get history () { return this.state.history }

  /**
   * Sets who reads a private space's history. With `'hidden'`, a newcomer's arrival changes the key
   * and it reads from its join on.
   * @param {string} history `'visible'` or `'hidden'`.
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_ALLOWED` for who may not decide, or for a space that isn't private.
   */
  async setHistory (history) {
    if (history !== 'visible' && history !== 'hidden') throw new TypeError('History is \'visible\' or \'hidden\'')
    if (!this.state.private) throw new HypergraphError('NOT_ALLOWED', 'Only a private space has a history to hide: anyone holding a closed space\'s key reads it')
    await this.#mayDecide('decide', 'set who reads the history')
    await this.#decide({ type: 'settings/set', policy: null, writeLimit: null, rules: null, history })
  }

  /**
   * @param {string} short
   * @param {Uint8Array} key
   * @param {number} epoch
   */
  #keep (short, key, epoch) {
    this.#epochKeys.set(short, key)
    this.#epochOf.set(short, epoch)
  }

  /**
   * @param {number} epoch
   */
  #hidden (epoch) {
    return this.state.history === 'hidden' && this.#epochOf.size > 0 && epoch < Math.min(...this.#epochOf.values())
  }

  /**
   * @returns {Uint8Array | null}
   */
  #current () {
    const keys = this.state.keys
    const commit = keys && keys.commits[keys.current]
    return commit ? this.#epochKeys.get(commit.slice(0, 16)) || null : null
  }

  /**
   * @param {WireRecord} record
   * @param {import('./log.js').OwnLog} log
   * @returns {Promise<((seq: number, r: WireRecord) => WireRecord) | null>}
   */
  async #sealer (record, log) {
    if (!this.state.private || PLAIN.has(record.type) || record.kind === enc.DELETE) return null
    const deadline = Date.now() + BOUND_MS
    let keys = this.state.keys
    for (;;) {
      keys = this.state.keys
      // Never with a key someone who lost access holds: changed first (by
      // this device if it may, else by a key holder who may). A change due
      // 'soon' is made first by who may, others write meanwhile.
      const change = this.#current() && keys ? await this.#changeNow(keys) : 'now'
      if (this.#current() && (!change || (change === 'soon' && !this.#decider()))) break
      if (this.closed || Date.now() >= deadline) {
        keys = null
        break
      }
      if (this.#current() && this.#decider()) await this.#rotateOnce()
      else await this.#progress(deadline - Date.now())
    }
    const key = keys && this.#current()
    if (!key) throw new HypergraphError('NOT_ALLOWED', 'This private space\'s current key hasn\'t reached this device: a member who holds it (and, after someone lost access, one who may change it) must be online')
    const epoch = /** @type {import('./decisions/state.js').Epochs} */ (keys).current
    return (seq, r) => ({ ...r, links: [], fields: pc.sealRecord(key, epoch, pc.recordAD(this.keyBytes, log.key, seq, epoch), r, { pad: !log.core.encryption }), sealed: true })
  }

  /**
   * @param {Uint8Array} bytes
   */
  #locked (bytes) {
    if (!this.state.private) return false
    let r = null
    try { r = enc.decodeRecord(bytes) } catch { return false }
    const info = r.sealed && !PLAIN.has(r.type) ? pc.sealedWith(r.fields) : null
    return !!info && !this.#epochKeys.has(info.commit) && !this.#hidden(info.epoch)
  }

  // A record as it counts here (lib/gate.js checkRecord): opened if sealed;
  // null while its key isn't held; false if it must not count; a put written
  // in the clear in a private space is `unreadable` (listed, no content).
  /**
   * @param {{ key: Uint8Array }} log
   * @param {number} seq
   * @param {WireRecord} record
   * @returns {OpenRecord | false | null}
   */
  #unseal (log, seq, record) {
    const plain = PLAIN.has(record.type) || record.kind === enc.DELETE
    if (!this.state.private || plain) return record.sealed ? false : record
    if (!record.sealed) return record.kind === enc.PUT ? { ...record, fields: EMPTY, links: [], unreadable: true } : false
    const info = pc.sealedWith(record.fields)
    if (!info) return false
    const { epoch } = info
    const key = this.#epochKeys.get(info.commit)
    if (!key) return this.#hidden(epoch) ? false : null
    const open = pc.openRecord(key, pc.recordAD(this.#adOf(log.key), log.key, seq, epoch), record.fields)
    return open ? { ...record, fields: open.fields, links: open.links, sealed: false } : false
  }

  /**
   * @param {{ key: Uint8Array }} log
   * @param {number} seq
   * @param {Uint8Array} bytes
   * @returns {OpenRecord | null}
   */
  _unsealed (log, seq, bytes) {
    let r = null
    try { r = enc.decodeRecord(bytes) } catch { return null }
    return this.#unseal(log, seq, r) || null
  }

  /**
   * Changes a private space's content key now (a device stolen, a leak suspected): who lost access
   * can't read what comes next. Removals change it by themselves. Resolves once the new key is recorded and
   * granted to every member's device.
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_ALLOWED` for who may not decide or moderate, or for a space that isn't private.
   */
  async rotateKey () {
    if (this.personal || !this.state.private) throw new HypergraphError('NOT_ALLOWED', 'Only a private space has a content key to change')
    const me = this.hg._identity.publicKey
    await this.#unless(() => this.state.can(me, 'decide') || this.state.can(me, 'moderate') ? null : this.#whyNot('change the key'))
    const deadline = Date.now() + BOUND_MS // a member just let in: its grant may be on its way, as for a write
    while (!this.#current() && !this.closed && Date.now() < deadline) await this.#progress(deadline - Date.now())
    if (!this.#current()) throw new HypergraphError('NOT_ALLOWED', "This private space's current key hasn't reached this device yet")
    for (let tries = 0; tries < 5; tries++) {
      if (await this.#rotate()) return
    }
    throw new HypergraphError('NOT_ALLOWED', 'Other members kept changing the key at the same moment: try again')
  }

  async _startKeys () {
    if (this.state.private && !this.state.keys) await this.#rotate()
  }

  #keysLater () {
    if (this.closed || this.personal || !this.state.private) return
    if (this._keying) {
      this._keyAgain = true
      return
    }
    this._keying = this.#keyWork().catch(safetyCatch).finally(() => {
      this._keying = null
      if (this._keyAgain && !this.closed) {
        this._keyAgain = false
        this.#keysLater()
      }
    })
  }

  async #keyWork () {
    await this.#refreshKeys()
    const keys = this.state.keys
    if (this.closed || !keys || !this.#current()) return
    const { granted, entitled } = await this.#grantState()
    const change = this.#change(keys, granted, entitled)
    if (change && this.#decider()) {
      await this.#rotateOnce() // a new key for who is there now
      return
    }
    if (change === 'now' || this.state.history === 'hidden') return
    for (const [z, to] of entitled) if (!granted.has(z) && !this.closed) await this.#grant(to)
    await this.#link(keys)
  }

  #decider () {
    const me = this.hg._identity.publicKey
    return (this.state.can(me, 'decide') || this.state.can(me, 'moderate')) && this.decisionLog.writable
  }

  // Must the key change? 'now': a device that may no longer read holds it
  // (nothing is written with it any more); 'soon' (by who may decide): the
  // history is hidden and a device lacks it (a newcomer), or another key won
  // a race for its epoch and this device holds that key (its side changes it:
  // both sides at once would race again; a race's keys are linked from
  // the next epoch only, never from each other: a member removed on one side
  // of a partition may hold the other side's key). null: no.
  /**
   * @param {import('./decisions/state.js').Epochs} keys
   * @param {Set<string>} granted
   * @param {Map<string, Entitled>} entitled
   * @returns {'now' | 'soon' | null}
   */
  #change (keys, granted, entitled) {
    if ([...granted].some((d) => !entitled.has(d))) return 'now'
    if (this.state.history === 'hidden' && [...entitled.keys()].some((z) => !granted.has(z))) return 'soon'
    const lost = Object.entries(keys.others || {}).some(([commit, epoch]) => epoch === keys.current && this.#epochKeys.has(commit.slice(0, 16)))
    return lost ? 'soon' : null
  }

  /**
   * @param {import('./decisions/state.js').Epochs} keys
   */
  async #changeNow (keys) {
    const { granted, entitled } = await this.#grantState()
    return this.#change(keys, granted, entitled)
  }

  #rotateOnce () {
    if (!this._rotating) this._rotating = this.#rotate().catch(safetyCatch).finally(() => { this._rotating = null })
    return this._rotating
  }

  async #refreshKeys () {
    const keys = this.state.keys
    if (!keys || this.closed) return
    if (!this.#box) this.#box = pc.boxKeyPair(this.hg._identity.device)
    const range = { space: this.keyBytes, type: grants.TYPE, ix: grants.grantIx(this.hg._identity.device.publicKey) }
    let learnt = false
    for (const row of await this.db.find('@hg/by-ix', { gte: range, lte: range }).toArray()) {
      let v = null
      try { v = this._types.decode(grants.TYPE, row.fields, row.links) } catch { continue }
      const short = b4a.isBuffer(v.commit) ? pc.shortCommit(v.commit) : null
      if (!short || this.#epochKeys.has(short)) continue
      const got = grants.openGrant(v, this.#box, keys)
      if (!got) continue
      this.#keep(short, got.key, v.epoch)
      learnt = true
    }
    if (this.state.history !== 'hidden' && await this.#followLinks(keys)) learnt = true
    if (!learnt || this.closed) return
    for (const log of this.directory.logs.values()) {
      for (const seq of log.holes) log.arrived.add(seq)
      this.indexer.index(log).catch(safetyCatch)
    }
    this.emit('_progress')
  }

  async #links () {
    const range = { space: this.keyBytes, type: LINK }
    /** @type {{ from: string, to: string, epoch: number, values: Record<string, any>, space: Uint8Array }[]} */
    const out = []
    for (const row of await this.db.find('@hg/by-type', { gte: range, lte: range }).toArray()) {
      let v = null
      try { v = this._types.decode(LINK, row.fields, row.links) } catch { continue }
      if (b4a.isBuffer(v.from) && b4a.isBuffer(v.to) && v.to.byteLength === 32 && Number.isSafeInteger(v.epoch)) out.push({ from: pc.shortCommit(v.from), to: pc.shortCommit(v.to), epoch: v.epoch, values: v, space: this.#adOf(row.log) })
    }
    return out
  }

  // Opens the older keys the held ones unlock (a key counts only if the
  // decision log recorded its commitment). True if one was learnt.
  /**
   * @param {import('./decisions/state.js').Epochs} keys
   */
  async #followLinks (keys) {
    const links = await this.#links()
    let learnt = false
    for (let more = true; more;) {
      more = false
      for (const { from, to, epoch, values, space } of links) {
        const by = this.#epochKeys.get(from)
        if (!by || this.#epochKeys.has(to) || !(this.#epochOf.get(from) > epoch) || !grants.known(keys, epoch, b4a.toString(values.to, 'hex'))) continue // from a later epoch only
        const key = pc.openKey(by, values.sealed, pc.linkAD(space, values.to))
        if (!key || !b4a.equals(pc.commitOf(key), values.to)) continue
        this.#keep(to, key, epoch)
        learnt = more = true
      }
    }
    return learnt
  }

  // Every key of an earlier epoch held here that the current key doesn't
  // unlock yet gets a link from it: after a rotation, the previous key; after
  // two rotations at once, both, from the next epoch.
  /**
   * @param {import('./decisions/state.js').Epochs} keys
   */
  async #link (keys) {
    const now = keys.commits[keys.current]
    const by = this.#epochKeys.get(now.slice(0, 16)) // of `keys`, which may no longer be the current ones
    if (!by) return
    const reach = new Set([now.slice(0, 16)])
    const links = await this.#links()
    for (let more = true; more;) {
      more = false
      for (const l of links) {
        if (reach.has(l.from) && !reach.has(l.to)) {
          reach.add(l.to)
          more = true
        }
      }
    }
    const commits = { ...Object.fromEntries(Object.entries(keys.commits).map(([e, h]) => [h, Number(e)])), ...(keys.others || {}) }
    for (const [commit, epoch] of Object.entries(commits)) {
      const key = this.#epochKeys.get(commit.slice(0, 16))
      if (!key || epoch >= keys.current || reach.has(commit.slice(0, 16)) || this.closed) continue
      const to = b4a.from(commit, 'hex')
      await this._put(LINK, { from: b4a.from(now, 'hex'), to, epoch, sealed: pc.sealKey(by, key, pc.linkAD(this.keyBytes, to)) }).catch(safetyCatch)
    }
  }

  /**
   * @typedef {{ device: Uint8Array, identity: Uint8Array }} Entitled
   */

  /**
   * @returns {Promise<{ granted: Set<string>, entitled: Map<string, Entitled> }>}
   */
  async #grantState () {
    const keys = this.state.keys
    /** @type {Set<string>} */
    const granted = new Set()
    const range = { space: this.keyBytes, type: grants.TYPE }
    for (const row of await this.db.find('@hg/by-type', { gte: range, lte: range }).toArray()) {
      let v = null
      try { v = this._types.decode(grants.TYPE, row.fields, row.links) } catch { continue }
      if (grants.current(v, keys)) granted.add(v.to)
    }
    const now = keys && keys.commits[keys.current]
    for (const g of this.#granting) if (g.endsWith(':' + now)) granted.add(g.slice(0, g.indexOf(':')))
    /** @type {Map<string, Entitled>} */
    const entitled = new Map()
    const me = this.hg._identity
    if (this.state.isMember(me.publicKey)) entitled.set(z32.encode(me.device.publicKey), { device: me.device.publicKey, identity: me.publicKey })
    for (const log of this.directory.logs.values()) {
      if (b4a.equals(log.device, log.identity) || !this.#mayRead(log)) continue
      entitled.set(z32.encode(log.device), { device: log.device, identity: log.identity })
    }
    return { granted, entitled }
  }

  /**
   * @param {{ identity: Uint8Array, device: Uint8Array | null }} who
   */
  #mayRead ({ identity, device }) {
    return this.state.isMember(identity) && !this.isRemoved(identity, device)
  }

  // Judged again at the moment of granting: the decisions may have changed
  // since the list was made (a partition healing removed someone, and the
  // current key is a new one).
  /**
   * @param {Entitled} to
   */
  async #grant (to) {
    if (!this.#mayRead(to)) return
    const { device } = to
    const keys = /** @type {import('./decisions/state.js').Epochs} */ (this.state.keys) // read only once #current() gave a key
    const key = this.#current()
    const values = key && grants.makeGrant(key, keys.current, b4a.from(keys.commits[keys.current], 'hex'), device)
    if (!values) return
    this.#granting.add(values.to + ':' + keys.commits[keys.current]) // counted before it is indexed: a write meanwhile must see it
    await this._put(grants.TYPE, values).catch(safetyCatch)
  }

  // A new epoch key: recorded with its commitment; if another rotation came
  // first in the order, its key comes to this device by a grant instead.
  async #rotate () {
    const keys = this.state.keys
    const epoch = keys ? keys.current + 1 : 0
    const key = pc.newEpochKey()
    const commit = pc.commitOf(key)
    await this.#decide({ type: 'key/rotate', epoch, commit })
    const now = this.state.keys
    if (!now || now.commits[epoch] !== b4a.toString(commit, 'hex')) return false
    this.#keep(pc.shortCommit(commit), key, epoch)
    this.emit('_progress')
    const { entitled } = await this.#grantState()
    for (const to of entitled.values()) await this.#grant(to)
    this.#keysLater() // a link to the key before it
    return true
  }

  [symbols.epochKeys] () {
    return [...this.#epochKeys.values()]
  }

  // Refusals that depend on the decisions: first catch up with the connected
  // members who record decisions (within the read bound), then judge again,
  // so a decision made a moment ago elsewhere isn't missed. `refusal()` gives
  // the reason, or null.
  /**
   * @param {() => string | null} refusal Why not, or null.
   * @param {import('./errors.js').ErrorCode} [code]
   */
  async #unless (refusal, code = 'NOT_ALLOWED') {
    if (!refusal()) return
    await this.decisionLog.catchUp(BOUND_MS)
    const why = refusal()
    if (why) throw new HypergraphError(code, why)
  }

  // Why this member may not do `what`: banned, not a member, or its role.
  /**
   * @param {string} what
   */
  #whyNot (what) {
    const me = this.hg._identity.publicKey
    if (this.state.isBanned(me)) return `You are banned from this space: you may not ${what}`
    const role = this.#myRole()
    if (!role) return `You are not a member of this space: you may not ${what}`
    return `Your role is ${role}: it does not allow you to ${what}`
  }

  // The newest stamp among the records `links` point at, held here:
  // a record is stamped above what it links to, so whoever holds a record's
  // period on holds what points at it. A target stamped far ahead of this
  // clock doesn't drag this identity's stamps into the future.
  /**
   * @param {Uint8Array[]} links
   */
  async #linkedStamp (links) {
    let top = 0
    for (const l of links) {
      if (l.byteLength < 33) continue // a space, not a record
      const row = await this.db.get('@hg/records', { space: this.keyBytes, id: l })
      if (row && row.stamp > top && !isFuture(row.stamp)) top = row.stamp
    }
    return top
  }

  /**
   * @param {string} type
   * @param {Record<string, unknown>} values
   */
  async #checkLinks (type, values) {
    /** @param {string} target */
    const typeOf = async (target) => {
      const row = await this.db.get('@hg/records', { space: this.keyBytes, id: idOf(target) })
      return row ? row.type : null
    }
    if (!(await gate.linksAllowed(this._types, type, values, typeOf))) {
      throw new HypergraphError('INVALID_RECORD', `A ${type} cannot link to that type of record`)
    }
  }

  /**
   * @param {string} type
   * @param {Record<string, unknown>} values
   * @param {Uint8Array | null} [id]
   */
  #checkRules (type, values, id = null) {
    if (!this.hg.rules.length || type.startsWith('hg/')) return
    const me = this.hg._identity
    const record = { ...values, id: id ? enc.idToString(id) : null, type, author: z32.encode(me.publicKey), device: z32.encode(me.device.publicKey), stamp: Date.now() }
    const broken = gate.brokenRule(this.hg.rules, record, { space: this.key })
    if (broken) throw new HypergraphError('RULE_REJECTED', `This ${type} breaks the app's rule "${broken}": no member would keep it`)
  }

  /**
   * @returns {HeldLog}
   */
  #ownLog () {
    return /** @type {HeldLog} */ (this.directory.logs.get(hex(this.own.key)))
  }

  /**
   * @param {number} seq
   */
  async #written (seq) {
    await this.indexer.index(this.#ownLog())
    const id = enc.idBytes({ log: this.own.key, seq })
    const row = await this.db.get('@hg/records', { space: this.keyBytes, id })
    if (!row) throw new HypergraphError('INVALID_RECORD', 'The record was written but refused by its own checks')
    return shape(this._types, row)
  }


  /**
   * Starts a query on one type of records; chain filters, then {@link Query#latest} or {@link Query#live}.
   * @param {string} type
   * @returns {Query}
   * @example
   * const { items, complete } = await space.query('comment').on(post).by(someone).latest(20)
   */
  query (type) {
    if (!this._typesPending()) this._types.get(type)
    return new Query(this, type)
  }

  /**
   * The records created past a cursor, for notifications and unread marks. It goes by what this device
   * received and indexed, never by clocks, and opens no log. Deleted, hidden, banned and rejected records
   * aren't returned; a record whose content was dropped here comes with `dropped: true` and no fields.
   * @param {Object<string, number>|null} cursor `{ [log]: nextSeq }` (plain JSON, keep it across restarts); null: from now on.
   * @param {object} [opts]
   * @param {string[]|null} [opts.types] Only these types (hypergraph's own only if named). The cursor still moves past the others.
   * @param {number} [opts.limit=Infinity] At most this many; the cursor stops there, call again for more.
   * @returns {Promise<{records: HgRecord[], cursor: Object<string, number>}>} `records` in no particular order, each at its current version.
   */
  async since (cursor, { types = null, limit = Infinity } = {}) {
    if (cursor !== null && (typeof cursor !== 'object' || Array.isArray(cursor) || !Object.values(cursor).every(Number.isSafeInteger))) throw new TypeError('A cursor is what since() returned, or null')
    if (types !== null && !Array.isArray(types)) throw new TypeError('types is a list of type names')
    if (limit !== Infinity && !(Number.isSafeInteger(limit) && limit > 0)) throw new TypeError('limit is a positive whole number')
    const known = this._types
    if (types && !this._typesPending()) for (const t of types) known.get(t) // throws INVALID_TYPE
    const wanted = types && new Set(types)
    const next = { ...cursor }
    const rows = []
    for (const log of this.directory.logs.values()) {
      if (log.from === null) continue // not read here (a big space's log outside the periods read)
      const name = z32.encode(log.key)
      const until = Math.min(log.indexed, log.limit)
      if (!cursor) {
        next[name] = until
        continue
      }
      let seq = Math.max(next[name] ?? 1, log.from)
      if (seq >= until) continue
      for (; seq < until && rows.length < limit; seq++) {
        const row = await this.db.get('@hg/records', { space: this.keyBytes, id: enc.idBytes({ log: log.key, seq }) })
        if (!row) continue // an edit, a delete, a record that doesn't count
        if (!known.has(row.type)) {
          if (this._typesPending()) break // its type may still arrive
          continue
        }
        if (row.flags & NOT_SHOWN || !(wanted ? wanted.has(row.type) : !row.type.startsWith('hg/')) || !gate.mayPut(known, row, this.state)) continue
        rows.push(row)
      }
      next[name] = seq
      if (rows.length === limit) break
    }
    const records = rows.map((row) => shape(known, row))
    const typeOf = this._typeOf()
    for (const item of records) await this.#judgeLinks(item, typeOf)
    return { records, cursor: next }
  }

  // Its types may not have arrived: none recorded and not complete yet (a
  // visitor opening a site by key, found by the HyperBrowser spike), so a type
  // it doesn't know yet reads as not complete instead of INVALID_TYPE.
  _typesPending () {
    if (this.personal || !this._log) return false
    return !this._log.state.typesVersion && !this.isComplete()
  }

  /**
   * The records pointing at a record, oldest first.
   * @param {HgRecord|string} target A record or its id.
   * @param {string|null} [type=null] Only this type; without one, relations and tags are left out.
   * @param {object} [opts]
   * @param {number} [opts.timeout]
   * @returns {Promise<Page>}
   */
  linked (target, type = null, { timeout } = {}) {
    return this._bounded(async (deadline) => {
      const { rows, partial } = await this.#pointingAt(target, type, deadline)
      const shaped = await this._shaped(rows, deadline)
      return { items: shaped.items, partial: partial || shaped.partial, need: await this.#stampOf(target) }
    }, timeout)
  }

  /**
   * Counts the records of a type pointing at a record.
   * @param {string} type
   * @param {object} opts
   * @param {HgRecord|string} [opts.on] The record (or its id) they point at: required.
   * @param {number} [opts.timeout]
   * @returns {Promise<{value: number, complete: boolean}>}
   * @throws {TypeError} Without `on`.
   */
  async count (type, { on, timeout } = {}) {
    if (!on) throw new TypeError('count() counts the records pointing at one: count(type, { on: record })')
    const { n, complete } = await this._bounded(async (deadline) => {
      const { rows, partial } = await this.#pointingAt(on, type, deadline)
      return { n: rows.length, partial, need: await this.#stampOf(on) }
    }, timeout)
    return { value: n, complete }
  }

  /**
   * @param {HgRecord | string} target
   * @param {string | null} type
   * @param {number} deadline
   * @returns {Promise<{ rows: RecordRow[], partial: boolean }>}
   */
  async #pointingAt (target, type, deadline) {
    const rows = await linkedRows(this, target, type)
    const typeOf = this._typeOf()
    /** @type {RecordRow[]} */
    const out = []
    let partial = false
    for (const row of rows) {
      const { ok, row: r } = await this._linkCounts(row, idOf(target), typeOf, deadline)
      if (ok === null) partial = true
      else if (ok) out.push(r)
    }
    return { rows: out, partial }
  }

  // Link targets are judged when read: a link counts unless
  // its target is held here with a type the link field doesn't allow. The
  // type of a record never changes, and a target that isn't held (not arrived
  // yet; deleted, taken down or cut: gone on every member) counts as written,
  // so every member judges alike whatever the order of arrival.
  // `typeOf(id)`: the held record's type or null, cached for one read.
  /**
   * @returns {(id: string | Uint8Array | HgRecord) => Promise<string | null>}
   */
  _typeOf () {
    /** @type {Map<string, Promise<string | null>>} */
    const cache = new Map()
    return (id) => {
      const bytes = idOf(id)
      const h = hex(bytes)
      if (!cache.has(h)) cache.set(h, this.db.get('@hg/records', { space: this.keyBytes, id: bytes }).then((r) => (r ? r.type : null)))
      return /** @type {Promise<string | null>} */ (cache.get(h))
    }
  }

  /**
   * @param {RecordRow} row
   * @param {Uint8Array} target
   * @param {(id: Uint8Array) => Promise<string | null>} typeOf
   * @param {number} deadline
   * @returns {Promise<{ ok: boolean | null, row: RecordRow }>}
   */
  async _linkCounts (row, target, typeOf, deadline) {
    const targetType = await typeOf(target)
    /** @param {RecordRow} r */
    const decode = (r) => {
      try { return this._types.has(r.type) ? this._types.decode(r.type, r.fields || b4a.alloc(0), r.links || []) : null } catch { return null }
    }
    const id = enc.idToString(target)
    const dropped = !!(row.flags & FLAGS.DROPPED)
    let ok = gate.linkCounts(this._types, row.type, dropped ? null : decode(row), id, targetType)
    if (ok !== null) return { ok, row }
    const full = await this.#content(row, deadline)
    if (!full) return { ok: null, row }
    ok = gate.linkCounts(this._types, full.type, decode(full), id, targetType)
    return { ok, row: full }
  }

  /**
   * Sums a field over the records of a type pointing at a record; for `onePerMember` types, each member's
   * latest only.
   * @param {string} type
   * @param {string} field
   * @param {object} opts
   * @param {HgRecord|string} [opts.on] The record (or its id) they point at: required.
   * @param {number} [opts.timeout]
   * @returns {Promise<{value: number, complete: boolean}>}
   * @throws {TypeError} Without `on`.
   */
  async sum (type, field, { on, timeout } = {}) {
    if (!on) throw new TypeError('sum() adds up the records pointing at one: sum(type, field, { on: record })')
    const { items, complete } = await this.linked(on, type, { timeout })
    return { value: items.reduce((s, r) => s + (Number(r[field]) || 0), 0), complete }
  }


  /**
   * The people of this space as this member knows them: members highest role first, then people banned or
   * removed (`role: null`). The decision log names them; in a public space, also everyone whose log this
   * device holds. Two members may list different people.
   * @returns {Promise<Array<{identity: string, role: (string|null), you: boolean, banned: boolean, removed: boolean, devices: Array<{device: string, log: string}>}>>} In a circle, each also has `share` and `used` (bytes, null when not reported).
   */
  async members () {
    const state = this.state
    const me = hex(this.hg._identity.publicKey)
    const people = new Map()
    /** @param {string} h */
    const person = (h) => {
      if (!people.has(h)) people.set(h, { identity: z32.encode(b4a.from(h, 'hex')), role: state.roleOf(h), you: h === me, banned: state.isBanned(h), removed: false, devices: [] })
      return people.get(h)
    }
    for (const h of state.members.keys()) person(h)
    for (const h of state.banned.keys()) person(h)
    for (const h of state.cuts.keys()) if (!state.isMember(h)) person(h).removed = !state.isBanned(h)
    for (const log of this.directory.logs.values()) {
      if (b4a.equals(log.device, log.identity)) continue // an identity log: removals, not a device
      const h = hex(log.identity)
      const p = people.get(h) || (state.public && state.isMember(h) ? person(h) : null)
      if (p) p.devices.push({ device: z32.encode(log.device), log: z32.encode(log.key) })
    }
    if (this.circle) { // each holder's share and use, bytes, all their holding devices (null: none reported)
      const { people: storage } = this.hg._circles.storageOf(this)
      for (const [h, p] of people) Object.assign(p, storage.get(h) || { share: null, used: null })
    }
    /** @param {{ role: string | null }} p */
    const rank = (p) => (p.role ? rankOf(p.role) : 0)
    return [...people.values()].sort((a, b) => rank(b) - rank(a) || (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0))
  }

  /**
   * What was decided here, newest first: a moderation log an app can show. Every member lists the same,
   * in the same order. A decision its author wasn't allowed to make is listed with `counted: false`.
   * @param {object} [opts]
   * @param {number} [opts.limit=50]
   * @param {{seq: number}|number|null} [opts.after=null] The last item of the previous page, or its `seq`.
   * @returns {Promise<{items: Array<Record<string, any>>, complete: boolean}>} Each item has `seq`, `type`, `by` and `device` (z32 or null), `at` (its stamp) and `counted`, and also what was decided (identity, role, action, target, reason, name, permissions, policy, rules...).
   * @throws {HypergraphError} `CLOSED`.
   */
  async decisions ({ limit = 50, after = null } = {}) {
    if (this.closed) throw new HypergraphError('CLOSED', 'This space is closed')
    const before = after === null ? Infinity : (typeof after === 'number' ? after : after.seq)
    const raw = await this.decisionLog.list({ limit, before, scope: this.rootKey ? this.hex : null })
    /** @param {string | null | undefined} h */
    const z = (h) => (h ? z32.encode(b4a.from(h, 'hex')) : null)
    const items = raw.map((/** @type {import('./decisions/log.js').ListedDecision} */ { writer, space, ...d }) => {
      /** @type {Record<string, any>} */
      const out = { ...d, by: z(d.by), device: z(d.device) }
      for (const k of ['identity', 'key', 'removed', 'maker', 'invite']) if (out[k]) out[k] = z(out[k])
      if (out.helpers) out.helpers = out.helpers.map(z)
      if (out.target) out.target = out.action === 'ban' || out.action === 'unban' ? z(out.target) : enc.idToString(b4a.from(out.target, 'hex'))
      return out
    })
    return { items, complete: this.isComplete() }
  }

  /**
   * A record's tags, sorted.
   * @param {HgRecord|string} record
   * @param {object} [opts]
   * @param {number} [opts.timeout]
   * @returns {Promise<{items: string[], complete: boolean}>}
   */
  async tags (record, { timeout } = {}) {
    return this._bounded(async () => {
      const row = await this.db.get('@hg/records', { space: this.keyBytes, id: idOf(record) })
      const prefix = tagKey('')
      return { items: row ? (row.ix || []).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort() : [], need: row ? row.stamp : this.#needOf(idOf(record)) }
    }, timeout)
  }

  /**
   * The peers connected on this space now; `identity` is null for a moment, until the peer's device proof
   * arrives. `[]` for a closed space.
   * @returns {Array<{identity: (string|null), device: string}>}
   */
  peers () {
    if (!this.opened) return [] // closed: not connected
    /** @param {Uint8Array | null} k */
    const z = (k) => (k ? z32.encode(k) : null)
    return this.directory.peerList().map((p) => ({ identity: z(p.identity), device: z(p.device) }))
  }


  /**
   * The connection streams of this space's members connected now, for an app's own transfer
   * library: open its channel on `Protomux.from(stream)`. Strangers never appear.
   * @returns {Array<{stream: object, identity: string, device: string}>}
   */
  memberConnections () {
    if (!this.opened) return []
    return [...this.directory.channels].filter((ch) => this.#isMemberChannel(ch)).map((ch) => ({ stream: ch.mux.stream, ...peerOf(ch) }))
  }

  /**
   * @param {SpaceChannel} ch
   */
  #isMemberChannel (ch) {
    return !!ch.identity && this.#mayRead({ identity: ch.identity, device: ch.peer })
  }

  // ...and 'member-disconnection' once when that peer stops being a member
  // (removed, banned, device removed) or its channel here closes; the stream
  // itself stays open (other spaces may share it).
  #memberConnected () {
    this._handedOut ??= new Set()
    for (const ch of this._handedOut) {
      if (this.directory.channels.has(ch) && this.#isMemberChannel(ch)) continue
      this._handedOut.delete(ch)
      ch.member = false // let back in: handed out again
      this.emit('member-disconnection', ch.mux.stream, peerOf(ch))
    }
    for (const ch of this.directory.channels) {
      if (ch.member || !this.#isMemberChannel(ch)) continue
      ch.member = true
      this._handedOut.add(ch)
      this.emit('member-connection', ch.mux.stream, peerOf(ch))
    }
  }

  /**
   * Adds the app's own Protomux protocol on this space's connections, opened with every peer once it
   * proved it knows the space's key, on later connections too.
   * @param {string} name
   * @param {object} [handlers]
   * @param {Array<{encoding: import('./encodings.js').Codec<any>, onmessage: (msg: any, peer: ProtocolPeer) => void}>} [handlers.messages=[]] compact-encoding codecs; `onmessage(msg, peer)`.
   * @param {(peer: ProtocolPeer) => void} [handlers.onopen] `onopen(peer)`; `identity` is null until the peer said who it is.
   * @param {(peer: ProtocolPeer) => void} [handlers.onclose] `onclose(peer)`.
   * @returns {void}
   * @throws {HypergraphError} `NOT_ALLOWED` if this space already has a protocol of that name.
   */
  addProtocol (name, { messages = [], onopen = () => {}, onclose = () => {} } = {}) {
    if (this._protocols.has(name)) throw new HypergraphError('NOT_ALLOWED', `This space has a protocol named "${name}" already`)
    this._protocols.set(name, { messages, onopen, onclose })
    if (this.directory) for (const ch of this.directory.channels) this.#openProtocol(ch, name)
  }

  /**
   * @param {SpaceChannel} ch
   * @param {string} name
   */
  #openProtocol (ch, name) {
    const { messages, onopen, onclose } = this._protocols.get(name)
    const open = () => {
      if (!this.directory.channels.has(ch)) return
      /** @type {ProtocolPeer} */
      const peer = { get identity () { return ch.identity ? z32.encode(ch.identity) : null }, device: z32.encode(ch.peer), send: (i, msg) => app.messages[i].send(msg) }
      const app = /** @type {import('protomux').Channel} */ (ch.mux.createChannel({ protocol: name, id: this.discoveryKey, onopen: () => onopen(peer), onclose: () => { ch.apps.delete(app); onclose(peer) } })) // null when open already: checked below
      if (!app) return // open already
      for (const m of messages) app.addMessage({ encoding: m.encoding, onmessage: (msg) => m.onmessage(msg, peer) })
      ch.apps.add(app)
      app.open()
    }
    ch.mux.pair({ protocol: name, id: this.discoveryKey }, open)
    open()
  }


  /**
   * Relates a record to another with a type, and optionally a number and data. Said by who may edit
   * `from`; relating the same pair with the same type again replaces it.
   * @param {HgRecord|string} from
   * @param {HgRecord|string} to
   * @param {string} type
   * @param {object} [opts]
   * @param {number|null} [opts.value=null]
   * @param {string|null} [opts.data=null] Text up to 4 KB.
   * @returns {Promise<{id: string, from: string, to: string, type: string, value: (number|null), data: (string|null), author: string, stamp: number}>}
   * @throws {HypergraphError} The write errors (see {@link Space}).
   */
  async relate (from, to, type, { value = null, data = null } = {}) {
    const source = await this.#row(from)
    await this.#mayEdit(source, 'relate from')
    const values = this.#graphValues('hg/relation', { from: enc.idToString(source.id), to: enc.idToString(idOf(to)), rel: type, value, data, off: false })
    const r = await this._put('hg/relation', values, await this.#relationStamp(source, /** @type {string} */ (values.to), type))
    return /** @type {Edge} */ ({ id: r.id, from: r.from, to: r.to, type: r.rel, value: r.value ?? null, data: r.data ?? null, author: r.author, stamp: r.stamp })
  }

  /**
   * Takes a relation away (relating again brings it back).
   * @param {HgRecord|string} from
   * @param {HgRecord|string} to
   * @param {string} type
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_FOUND` if there is no such relation; The write errors (see {@link Space}).
   */
  async unrelate (from, to, type) {
    const source = await this.#row(from)
    const target = enc.idToString(idOf(to))
    const { items } = await this.edges(/** @type {HgRecord} */ (/** @type {unknown} */ (source)), { direction: 'out', type, timeout: 0 })
    if (!items.some((e) => e.to === target)) throw new HypergraphError('NOT_FOUND', `No ${type} relation between these records`)
    await this.#mayEdit(source, 'unrelate from')
    await this._put('hg/relation', this.#graphValues('hg/relation', { from: enc.idToString(source.id), to: target, rel: type, off: true }), await this.#relationStamp(source, target, type))
  }

  /**
   * @param {RecordRow} source
   * @param {string} to
   * @param {string} type
   */
  async #relationStamp (source, to, type) {
    const prefix = { space: this.keyBytes, target: source.id, type: 'hg/relation' }
    let top = 0
    for (const row of await this.db.find('@hg/by-link', { gte: prefix, lte: prefix }).toArray()) {
      try {
        const v = this._types.decode('hg/relation', row.fields, row.links)
        if (v.rel === type && v.to === to && b4a.equals(enc.idBytes(v.from), source.id)) top = Math.max(top, row.stamp)
      } catch {}
    }
    return top
  }

  /**
   * The relations out of a record, into it, or both.
   * @param {HgRecord|string} record
   * @param {object} [opts]
   * @param {'out'|'in'|'both'} [opts.direction='both']
   * @param {string|null} [opts.type=null]
   * @param {'asc'|'desc'} [opts.order='asc'] `'asc'`: oldest first.
   * @param {number} [opts.limit=Infinity] Caps `items`, not `count`.
   * @param {number} [opts.timeout]
   * @returns {Promise<{items: Edge[], count: number, complete: boolean}>}
   */
  edges (record, { direction = 'both', type = null, order = 'asc', limit = Infinity, timeout } = {}) {
    if (!['out', 'in', 'both'].includes(direction)) throw new TypeError("direction is 'out', 'in' or 'both'")
    return this._bounded(async () => {
      const all = await edgeRows(this, record, { direction, type })
      if (order === 'desc') all.reverse()
      return { items: all.slice(0, limit), count: all.length, need: await this.#stampOf(record) }
    }, timeout)
  }

  /**
   * Tags a record (who may edit it). The latest tag or untag wins.
   * @param {HgRecord|string} record
   * @param {string} name
   * @returns {Promise<void>}
   * @throws {HypergraphError} The write errors (see {@link Space}).
   */
  async tag (record, name) {
    const row = await this.#row(record)
    await this.#mayEdit(row, 'tag')
    await this._put('hg/tag', this.#graphValues('hg/tag', { on: enc.idToString(row.id), tag: name, off: false }), await tagStamp(this, row.id, name))
  }

  /**
   * Takes a tag off a record.
   * @param {HgRecord|string} record
   * @param {string} name
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_FOUND` if it doesn't have the tag; The write errors (see {@link Space}).
   */
  async untag (record, name) {
    const row = await this.#row(record)
    if (!(row.ix || []).includes(tagKey(name))) throw new HypergraphError('NOT_FOUND', `This ${row.type} is not tagged "${name}"`)
    await this.#mayEdit(row, 'untag')
    await this._put('hg/tag', this.#graphValues('hg/tag', { on: enc.idToString(row.id), tag: name, off: true }), await tagStamp(this, row.id, name))
  }

  /**
   * The records with a tag, newest first.
   * @param {string} name
   * @param {object} [opts]
   * @param {string|null} [opts.type=null] One type; all the app's types by default.
   * @param {number} [opts.limit=20]
   * @param {HgRecord|null} [opts.after=null] The last record of the previous page.
   * @param {number} [opts.timeout]
   * @returns {Promise<Page>}
   */
  getByTag (name, { type = null, limit = 20, after = null, timeout } = {}) {
    if (type) return this.query(type).tag(name).latest(limit, { after, timeout })
    if (typeof name !== 'string' || !name) throw new TypeError('A tag is a non-empty string')
    return this._bounded((deadline) => taggedRows(this, name, limit, after, deadline), timeout)
  }

  /**
   * @param {RecordRow} row
   * @param {string} what
   */
  async #mayEdit (row, what) {
    await this.#mayPost()
    await this.#unless(() => gate.mayEdit(this._types, { author: this.hg._identity.publicKey, id: null }, row, this.state) ? null : `You may not ${what} this ${row.type}: only who may edit it (its author, by default)`)
  }

  /**
   * @param {string} type
   * @param {Record<string, unknown>} values
   */
  #graphValues (type, values) {
    const v = this._types.validate(type, values)
    if (!gate.builtinValid({ kind: enc.PUT, type }, { off: false, ...v })) {
      throw new HypergraphError('INVALID_RECORD', type === 'hg/tag' ? 'A tag is a non-empty string' : `A relation has a type (a non-empty string), a finite number as value, and data of at most ${gate.MAX_DATA} bytes of text`)
    }
    return v
  }

  // Answers with what is held; given a `timeout`, waits up to it while blocks
  // this space needs are known but not held (reads answer at once,
  // waiting is asked for). An incomplete answer still starts what it needs:
  // wider reading here, dropped content in _shaped; `change` says when. `fn(deadline)` may fetch content
  // dropped here until then; `partial` in its result: some it couldn't.
  // `need` in fn's result: the stamp from which the answer must
  // hold everything to be complete (a page's oldest item; a target's stamp);
  // 0: everything; 'own': this device's own records; absent: the whole
  // space. A member reading part of a big space widens what it reads to get
  // there.
  /**
   * @typedef {number | 'own' | undefined} Need What a read needs held to be complete: from a stamp on, this device's own logs, or everything.
   */

  /**
   * @template {{ partial?: boolean, need?: Need }} R
   * @param {(deadline: number) => Promise<R>} fn
   * @param {number} [timeout]
   * @returns {Promise<Omit<R, 'partial' | 'need'> & { complete: boolean, access?: 'none' }>}
   */
  async _bounded (fn, timeout = 0) {
    const deadline = Date.now() + timeout
    for (;;) {
      const gen = this._indexed
      const { partial = false, need, ...result } = await fn(deadline)
      // Not for me: a private space this member may not
      // read holds what it can't open; waiting changes nothing, so it answers
      // at once and says so.
      if (this._access() === 'none') return { ...result, complete: false, access: 'none' }
      // Complete only if nothing was indexed while the answer was read: records
      // indexed meanwhile may belong in it (found by bench/next/first-page.js:
      // a complete first page missing the newest posts).
      const complete = !partial && this._completeFor(need) && gen === this._indexed
      const left = deadline - Date.now()
      if (complete || this.closed) return { ...result, complete }
      if (gen !== this._indexed && left > 0) continue // read again at once
      this.#widenFor(need)
      if (left <= 0) return { ...result, complete }
      await this.#progress(left)
    }
  }

  // 'full': this member reads what is written here; 'waiting': a private
  // space's member whose key hasn't arrived yet; 'none': a private space it
  // may not read (removed, or only relaying it): nothing new will open.
  /**
   * @returns {'full' | 'waiting' | 'none'}
   */
  _access () {
    if (this.personal || !this.state.private) return 'full'
    if (!this.state.isMember(this.hg._identity.publicKey)) return 'none'
    return this.#current() ? 'full' : 'waiting'
  }

  /**
   * @param {Need} need
   */
  _completeFor (need) {
    if (need === 'own') return [...this.directory.logs.values()].every((l) => !l.own || (l.scanned >= l.length && l.holes.size === 0))
    return need === undefined ? this.isComplete() : this.completeFrom(need)
  }

  /**
   * @param {Need} need
   */
  #widenFor (need) {
    const h = this._reading.horizon
    if (h === null || this._undecided) return
    if (need !== undefined && /** @type {number} */ (need) > 0) {
      if (periodOf(/** @type {number} */ (need)) < h) this.#widen(periodOf(/** @type {number} */ (need))) // 'own' is no stamp: not above 0
      return
    }
    // It needs older records than it found: one step back, once what it
    // reads now is all here (else the page may fill without going back).
    if (this.completeFrom(h * PERIOD_MS)) this.#widen(this.#stepBack())
  }

  /**
   * @param {RecordRow[]} rows
   * @param {number} deadline
   * @returns {Promise<{ items: HgRecord[], partial: boolean }>}
   */
  async _shaped (rows, deadline) {
    const waits = deadline > Date.now()
    const got = await Promise.all(rows.map((row) => !(row.flags & FLAGS.DROPPED) ? row : waits ? this.#content(row, deadline) : this.#fetchLater(row)))
    const items = /** @type {RecordRow[]} */ (got.filter((row) => row)).map((row) => shape(this._types, row))
    const typeOf = this._typeOf()
    for (const item of items) await this.#judgeLinks(item, typeOf)
    return { items, partial: items.length < rows.length }
  }

  // A link field whose target is held here with a type it doesn't allow
  // points at nothing.
  /**
   * @param {HgRecord} item
   * @param {(id: string) => Promise<string | null>} typeOf
   */
  async #judgeLinks (item, typeOf) {
    if (!this._types.has(item.type)) return
    const { fields, links } = this._types.get(item.type)
    for (const f of fields) {
      if (f.kind !== 'link' || !links[f.name] || !item[f.name]) continue
      const targetType = await typeOf(/** @type {string} */ (item[f.name]))
      if (targetType && !this._types.linkAllowed(item.type, f.name, targetType)) item[f.name] = null
    }
  }

  /**
   * @param {RecordRow} row
   * @returns {null}
   */
  #fetchLater (row) {
    const h = hex(row.id)
    if (this._fetching.has(h) || this.closed) return null
    this._fetching.add(h)
    this.#content(row, Date.now() + BOUND_MS).catch(safetyCatch).finally(() => this._fetching.delete(h))
    return null
  }

  /**
   * @param {RecordRow} row
   * @param {number} deadline
   * @param {boolean} [read]
   * @returns {Promise<RecordRow | null>}
   */
  async #content (row, deadline, read = true) {
    const log = this.directory.logs.get(hex(row.log))
    const left = deadline - Date.now()
    if (!log || left <= 0 || this.closed) return null
    let bytes = null
    try { bytes = await this.directory.get(log, row.seq, { timeout: left }) } catch { return null }
    if (!bytes || this.closed) return null
    const put = this._unsealed(log, row.seq, bytes) // opened, in a private space
    if (!put) return null
    const restored = await this.indexer.restore(row.id, put.fields, { read, size: bytes.byteLength })
    this.hg._holdLater() // held again: something else may have to go
    if (restored) {
      this.#changed(new Map([[hex(row.id), { id: enc.idToString(row.id), type: row.type, deleted: null }]]))
      return restored
    }
    const now = await this.db.get('@hg/records', { space: this.keyBytes, id: row.id }) // restored meanwhile by another read
    return now && !(now.flags & FLAGS.DROPPED) ? now : null
  }

  /**
   * @param {HgRecord | string} id
   * @returns {Promise<number | undefined>}
   */
  async #stampOf (id) {
    if (this._reading.horizon === null) return undefined
    const row = await this.db.get('@hg/records', { space: this.keyBytes, id: idOf(id) })
    return row ? row.stamp : 0
  }

  /** @type {(key?: Uint8Array) => number | undefined} */
  #needOf () {
    return this._reading.horizon === null ? undefined : 0
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  #progress (ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.off('_progress', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.on('_progress', done)
    })
  }

  /**
   * Whether everything this member knows of here is held and indexed, and it reached another member
   * since opening (or it is the only member, on its only device).
   * @returns {boolean}
   */
  isComplete () {
    this.#mustBeOpen()
    return this.completeFrom(0)
  }

  #completeAll () {
    if (this.replicator.missing() > 0) return false
    if (this.directory.known) return true
    const members = this.state.members
    return members.size === 1 && members.has(hex(this.hg._identity.publicKey)) && this.hg._alone
  }

  // Runs at once, again when records of `type` change, and, while its last
  // answer was incomplete, when it may have become complete.
  // Calls fn only when the answer (items or `complete`) changed.
  /**
   * @param {string} type
   * @param {(deadline: number) => Promise<import('./index/query.js').Answer>} run
   * @param {(page: Page) => void} fn
   * @returns {() => void} stop
   */
  _live (type, run, fn) {
    let stopped = false
    let running = false
    let again = false
    let incomplete = false
    let partial = false
    /** @type {Need} */
    let need
    /** @type {string | null} */
    let last = null
    const go = async () => {
      if (running) { again = true; return }
      running = true
      try {
        do {
          again = false
          const answer = /** @type {import('./index/query.js').Answer & { complete: boolean }} */ (await run(Date.now())) // at once, like every read
          partial = !!answer.partial
          need = answer.need
          incomplete = partial || again || !this._completeFor(need)
          delete answer.partial
          delete answer.need
          answer.complete = !incomplete
          const said = JSON.stringify(answer)
          if (!stopped && said !== last) {
            last = said
            fn(answer)
          }
          if (!stopped && incomplete) this.#widenFor(need)
        } while (again && !stopped)
      } catch (err) {
        safetyCatch(err)
      } finally {
        running = false
      }
    }
    /** @param {{ types: string[] }} change */
    const onchange = ({ types }) => { if (types.includes(type)) go() }
    // Other records arriving change nothing here, only maybe `complete`; a
    // partial answer retries fetching what it lacked.
    const onprogress = () => { if (incomplete && (partial || this._completeFor(need))) go() }
    this.on('change', onchange)
    this.on('_progress', onprogress)
    this._use() // a live view keeps its space open
    if (this.opened) go()
    else this._ready().then(() => { if (!stopped) go() }, safetyCatch)
    return () => {
      if (stopped) return
      stopped = true
      this.off('change', onchange)
      this.off('_progress', onprogress)
      this._unuse()
    }
  }

  /**
   * @param {Changes} changes
   */
  #changed (changes) {
    const records = [...changes.values()]
    const types = new Set(records.map((r) => r.type))
    if (types.size) this._indexed++ // reads check nothing changed while they read
    if (types.has(grants.TYPE)) this.#keysLater()
    if (types.size) this.emit('change', { types: [...types], records })
    if (types.size) this.hg._circles.changed(this) // handed again, or a circle's holders changed
    this.emit('_progress')
    this.#logsChanged()
    this.#statusLater()
    this.hg._holdLater()
  }

  #logsChanged () {
    if (this._logsTimer || this.closed) return
    this._logsTimer = setTimeout(() => {
      this._logsTimer = null
      if (!this.closed) this.emit('logs')
    }, LOGS_MS)
    if (this._logsTimer.unref) this._logsTimer.unref()
  }

  // 'status' checked at most every LOGS_MS after something arrived: what is
  // held, so `complete`, may have changed.
  #statusLater () {
    if (this._statusTimer || this.closed) return
    this._statusTimer = setTimeout(() => {
      this._statusTimer = null
      this._statusChanged()
    }, LOGS_MS)
    if (this._statusTimer.unref) this._statusTimer.unref()
  }

  // `log`'s author lost the right to write: only what is below `limit` counts.
  // Serialized per log, after any indexing run.
  /**
   * @param {HeldLog} log
   * @param {number} limit
   */
  async #cut (log, limit) {
    const prev = log.cutting || Promise.resolve()
    log.cutting = prev.then(async () => {
      if (this.closed || (log.cut === limit && log.limit <= limit)) return
      if (log.indexing) await log.indexing
      await this.indexer.cut(log, limit)
      await this.replicator.cut(log)
      if (limit <= 1) {
        this.directory.drop(log)
        this.replicator.drop(log)
        await this.hg._queue.run((tx) => tx.insert('@hg/logs', { space: this.keyBytes, log: log.key, identity: log.identity, device: log.device, indexed: log.indexed, cut: limit, refused: true }))
      }
      this.emit('_progress')
    })
    return log.cutting
  }

  /**
   * @param {Uint8Array} id
   * @param {{ dropped?: boolean }} [opts]
   */
  async #clear (id, { dropped = false } = {}) {
    const { log, seq } = enc.idParts(id)
    const held = this.directory.logs.get(hex(log))
    if (!held) return
    await this.directory.use(held, (core) => clearBlocks(core, seq, seq + 1)).catch(safetyCatch)
    if (dropped) return
    await this.#wipedEntry(held, seq).catch(safetyCatch)
    // A wiped record's stamp is gone: the next ones are judged against the
    // next readable record (lib/limit.js).
    const limit = this.#limitFor(held)
    if (limit) await this.indexer.rejudge(held, { from: seq + 1, to: seq + limit.records }).catch(safetyCatch)
  }

  // Block `seq` of `log` was wiped: an entry starting right after
  // it can't be checked any more (nobody holds the block before its start), so
  // it starts earlier, after the last readable block; and deriving goes on
  // from there.
  /**
   * @param {HeldLog} log
   * @param {number} seq
   */
  async #wipedEntry (log, seq) {
    /** @param {number} s */
    const readable = async (s) => s === 0 || (!!(await this.directory.get(log, s, { wait: false }).catch(() => null)) && !(await this.indexer.isWiped(log, s)))
    let start = seq
    while (start > 1 && !(await readable(start - 1))) {
      if (start - 1 < (log.from || 1)) return // not read here: can't tell
      start--
    }
    if (log.act.last === seq) log.act = { ...log.act, last: start - 1 }
    const next = await this.directory.get(log, seq + 1, { wait: false }).catch(() => null)
    let stamp = null
    try { stamp = next ? enc.decodeRecord(next).stamp : null } catch {}
    if (stamp === null) return
    const row = { space: this.keyBytes, period: periodOf(stamp), log: log.key, start }
    let fresh = false
    await this.hg._queue.run(async (tx) => {
      const old = await tx.get('@hg/activity', row)
      if (!old || old.start !== seq + 1) return
      await tx.insert('@hg/activity', row)
      fresh = true
    })
    if (fresh) this.activity.kept([row])
  }


  #notMoved () {
    if (this._log && this.state.moved) throw new HypergraphError('MOVED', this._movedTo ? `This space moved to ${this._movedTo}: it is read-only` : 'This space moved: it is read-only')
  }

  #already () {
    const by = this.state.moved && this.state.moved.by
    return new HypergraphError('ALREADY_RENEWED', `This space was already renewed${by ? ` by ${z32.encode(b4a.from(by, 'hex'))}` : ''}: it moved`)
  }

  /**
   * Gives a private top space a new decision log, new logs and a new disk key, sealed to its current
   * members' devices: removed people don't learn where it went. The history stays (the old logs, same
   * record ids), members and sub-spaces come along, old invite links stop working. This space becomes
   * read-only and points at the new one.
   * @returns {Promise<Space>} The new space.
   * @throws {HypergraphError} `NOT_ALLOWED` for who isn't an owner or admin, or a space that isn't a private top space; `ALREADY_RENEWED` if another renew was decided first.
   */
  async renew () {
    if (this.personal || this.rootKey) throw new HypergraphError('NOT_ALLOWED', this.rootKey ? 'A sub-space renews with its top space: renew that one' : 'The personal space is not renewed')
    if (!this.state.private) throw new HypergraphError('NOT_ALLOWED', 'Only a private space has a disk key to renew')
    await this.#mayDecide('decide', 'renew this space')
    if (this.state.moved) throw this.#already()
    if (!this._renewing) {
      this._renewing = this.#renew().finally(() => {
        this._renewing = null
        if (!this.closed) this.#followLater() // lost: this device follows the winner
      })
    }
    return this._renewing
  }

  /**
   * {@link Space#rotateKey}, then {@link Space#renew}: after an incident.
   * @param {object} [opts]
   * @param {boolean} [opts.forget=false] Also trims everything written before now.
   * @returns {Promise<Space>} The new space.
   * @throws {HypergraphError} As `rotateKey` and `renew`.
   */
  async secure ({ forget = false } = {}) {
    await this.rotateKey()
    const fresh = await this.renew()
    if (forget) await fresh.trimHistory({ before: Infinity })
    return fresh
  }

  async #renew () {
    const hg = this.hg
    /** @type {Record<string, string>} */
    const subs = {} // old sub-space key hex -> new (a removed member must not find them)
    for (const h of this.state.subspaces.keys()) subs[h] = hex(crypto.randomBytes(32))
    let text = JSON.stringify(await this.decisionLog.entries('', '~'))
    for (const [from, to] of Object.entries(subs)) text = text.split(from).join(to)
    /** @type {[string, any][]} */
    const base = JSON.parse(text)
    const spaces = [this, ...hg._below(this)]
    for (const s of spaces) await s._ready()
    /** @type {Uint8Array} */
    let hash = /** @type {Uint8Array} */ (/** @type {unknown} */ (null)) // set by renewed() below
    /**
     * @param {Uint8Array} key
     * @returns {import('./encodings.js').DecisionBody[]}
     */
    const renewed = (key) => {
      /** @type {[string, any][]} */
      const entries = base.map(([k, v]) => k.startsWith('past:') && v.in === this.hex ? [k, { ...v, in: hex(key) }] : [k, v])
      for (const s of spaces) {
        const into = s.rootKey ? subs[s.hex] : hex(key)
        if (!into) continue
        for (const log of s.directory.logs.values()) {
          if (s._pastOf(log.key)) continue // history of an earlier renew: in the copied state already
          entries.push([`past:${hex(log.key)}`, { space: s.hex, top: this.hex, cut: Math.min(log.length, log.limit), in: into }])
        }
      }
      hash = crypto.hash(b4a.from(JSON.stringify(entries)))
      /** @type {[string, any][][]} */
      const chunks = [[]]
      let size = 0
      for (const e of entries) {
        const n = JSON.stringify(e).length
        if (size + n > CHUNK && chunks[chunks.length - 1].length) {
          chunks.push([])
          size = 0
        }
        chunks[chunks.length - 1].push(e)
        size += n
      }
      return chunks.map((list, i) => ({ type: 'space/renewed', from: this.keyBytes, hash, entries: JSON.stringify(list), last: i === chunks.length - 1 }))
    }
    const meta = /** @type {import('./decisions/state.js').SpaceMeta} */ (this.state.meta)
    const { space: fresh, disk } = await hg._createRenewed({ name: meta.name, policy: meta.policy || 'auto', circle: !!meta.circle }, renewed)
    const payload = { to: fresh.hex, disk: hex(disk), subs }
    const bytes = b4a.from(JSON.stringify(payload))
    const boxes = []
    for (const { device } of (await this.#grantState()).entitled.values()) {
      const box = pc.boxPublicKey(device)
      if (box) boxes.push({ to: device, sealed: pc.seal(bytes, box) })
    }
    try {
      await this.#decide({ type: 'space/moved', boxes, hash })
    } catch (err) {
      await hg._discard(fresh)
      throw err
    }
    // The first move decided wins: final once the indexers signed it; without
    // them (offline) this device goes first after FINAL_MS, the others follow
    // once it is final.
    const deadline = Date.now() + FINAL_MS
    for (;;) {
      const final = await this.decisionLog.final('moved')
      const now = final || (Date.now() >= deadline ? this.state.moved : null)
      if (now) {
        if (now.hash !== hex(hash)) {
          await hg._discard(fresh)
          throw this.#already()
        }
        await hg._moveTo(this, payload, now.hash)
        return fresh
      }
      if (this.closed) throw new HypergraphError('CLOSED', 'This space is closed')
      await this.#progress(Math.min(250, Math.max(1, deadline - Date.now())))
    }
  }

  // Every device: once the move is final, it opens its box and moves (no
  // box: a removed person, left behind with `moved` and no address).
  #followLater () {
    const moved = this.state.moved
    if (!moved || this.rootKey || this.personal || this.closed || this._following || this._renewing || this._movedHash === moved.hash) return
    this._following = this.#follow().catch(safetyCatch).finally(() => {
      this._following = null
      if (this._movedHash !== (this.state.moved && this.state.moved.hash) && !this.closed) {
        clearTimeout(this._followTimer)
        this._followTimer = setTimeout(() => this.#followLater(), FOLLOW_MS)
        if (this._followTimer.unref) this._followTimer.unref()
      }
    })
  }

  async #follow () {
    const moved = await this.decisionLog.final('moved')
    if (!moved || this.closed || this._movedHash === moved.hash) return
    const mine = moved.boxes.find((/** @type {{ to: string, sealed: string }} */ b) => b.to === hex(this.hg._identity.device.publicKey))
    const opened = mine ? pc.openSealed(b4a.from(mine.sealed, 'hex'), pc.boxKeyPair(this.hg._identity.device)) : null
    let payload = null
    try { payload = opened ? JSON.parse(b4a.toString(opened)) : null } catch {}
    if (!payload) {
      this._movedHash = moved.hash
      this.emit('moved', { to: null })
      this.hg._spacesChanged()
      return
    }
    await this.hg._moveTo(this, payload, moved.hash)
  }

  /**
   * Deletes the records written before a time, in this space and its sub-spaces, on every member's
   * device and every holder of its circles. What stays keeps its ids. Copies others already took can't be
   * recalled.
   * @param {object} [opts]
   * @param {number} [opts.before] ms since 1970; Infinity: everything so far. Required.
   * @returns {Promise<void>} Once recorded and done on this device.
   * @throws {HypergraphError} `NOT_ALLOWED` for who isn't an owner or admin, on a sub-space (trim its top space) or the personal space.
   * @throws {TypeError} When `before` isn't a number.
   */
  async trimHistory ({ before } = {}) {
    if (this.personal || this.rootKey) throw new HypergraphError('NOT_ALLOWED', this.rootKey ? 'A sub-space\'s history is trimmed with its top space' : 'The personal space is not trimmed')
    if (typeof before !== 'number' || Number.isNaN(before)) throw new TypeError('before is a time (ms since 1970), or Infinity for everything so far')
    await this.#mayDecide('decide', 'trim its history')
    const logs = []
    for (const s of [this, ...this.hg._below(this)]) {
      await s._ready()
      for (const log of [...s.directory.logs.values()]) {
        if (b4a.equals(log.device, log.identity)) continue
        const below = await s.#trimPoint(log, before)
        if (below > (this.state.trims.get(hex(log.key)) || 1)) logs.push({ log: log.key, length: below })
      }
    }
    if (logs.length) await this.#decide({ type: 'history/trim', before: Math.min(before, Number.MAX_SAFE_INTEGER), logs })
    for (const s of [this, ...this.hg._below(this)]) await s._trims()
  }

  /**
   * @param {HeldLog} log
   * @param {number} before
   */
  async #trimPoint (log, before) {
    const end = Math.min(log.length, log.limit)
    if (before === Infinity) return end
    let seq = Math.max(this.state.trims.get(hex(log.key)) || 1, 1)
    for (; seq < end; seq++) {
      const bytes = await this.directory.get(log, seq, { wait: false }).catch(() => null)
      if (!bytes) {
        if (await this.indexer.isWiped(log, seq)) continue
        break
      }
      let stamp = Infinity
      try { stamp = enc.decodeRecord(bytes).stamp } catch {}
      if (stamp >= before) break
    }
    return seq
  }

  _trims () {
    if (this._trimming) {
      this._trimAgain = true
      return this._trimming
    }
    this._trimming = (async () => {
      do {
        this._trimAgain = false
        for (const log of [...this.directory.logs.values()]) {
          const below = this.state.trims.get(hex(log.key))
          if (!below || (log.from || 1) >= below || this.closed) continue
          if (log.indexing) await log.indexing
          const kept = new Set()
          const end = Math.min(below, await this.directory.use(log, (core) => core.length).catch(() => 0))
          for (let seq = 1; seq < end; seq++) {
            const bytes = await this.directory.get(log, seq, { wait: false }).catch(() => null)
            let type = null
            try { type = bytes ? enc.decodeRecord(bytes).type : null } catch {}
            if (type === grants.TYPE || type === LINK) kept.add(seq)
          }
          await this.indexer.trim(log, below, (seq) => kept.has(seq))
          await this.directory.use(log, async (core) => {
            for (let start = 1; start < end;) {
              let stop = start
              while (stop < end && !kept.has(stop)) stop++
              if (stop > start) await clearBlocks(core, start, stop)
              start = stop + 1
            }
          }).catch(safetyCatch)
          this.hg._circles.trimmed(this, log.key, below) // holders clear it too
        }
      } while (this._trimAgain && !this.closed)
    })().finally(() => { this._trimming = null })
    return this._trimming
  }

  // This device's own records written in `old`'s logs past their cut
  // (after the move, or never seen by the renewer) are written here again,
  // sealed with this space's keys, each carrying its old id (`from`), once.
  // Never anyone else's; never for someone who may not write here. Returns
  // how many it couldn't open yet (the old space's keys come back from its
  // index after a restart): the caller tries again.
  /**
   * @param {Space} old
   * @returns {Promise<number>}
   */
  _repost (old) {
    const run = (this._reposting || Promise.resolve()).then(() => this.#repostOnce(old)) // one pass at a time: two would both write
    this._reposting = run.catch(() => {})
    return run
  }

  /**
   * @param {Space} old
   * @returns {Promise<number>} How many records are still waiting for their key.
   */
  async #repostOnce (old) {
    const me = this.hg._identity
    if (this.closed) return 0
    if (!this.state.canWrite(me.publicKey)) return 1 // its state may still be loading (a restart): looked at again
    let waiting = 0
    /** @type {Map<string, Uint8Array>} */
    const done = new Map() // old id hex -> new id
    for (let i = 1; i < this.own.core.length; i++) {
      const r = await this.own.get(i).catch(() => null)
      if (r && r.from) done.set(hex(r.from), enc.idBytes({ log: this.own.key, seq: i }))
    }
    for (const log of [...old.directory.logs.values()]) {
      if (!b4a.equals(log.device, me.device.publicKey) || b4a.equals(log.device, log.identity)) continue
      const past = this._pastOf(log.key)
      const cut = past ? past.cut : 1
      const length = await old.directory.use(log, (core) => core.length)
      for (let seq = Math.max(cut, 1); seq < length && !this.closed; seq++) {
        const from = enc.idBytes({ log: log.key, seq })
        if (done.has(hex(from))) continue
        const bytes = await old.directory.get(log, seq, { wait: false }).catch(() => null)
        const r = bytes ? old._unsealed(log, seq, bytes) : null
        if (!r && bytes) waiting++
        if (!r || r.unreadable || PLAIN.has(r.type)) continue
        const target = r.target ? (done.get(hex(r.target)) || r.target) : null
        const at = await this.#write({ kind: r.kind, type: r.type, stamp: r.stamp, target, links: r.links, fields: r.fields, from })
        done.set(hex(from), enc.idBytes({ log: this.own.key, seq: at }))
      }
    }
    if (done.size) await this.indexer.index(this.#ownLog())
    return waiting
  }


  /**
   * A member's role.
   * @param {string} who An identity key (z32).
   * @returns {Promise<string|null>} `'owner'`, `'admin'`, `'moderator'`, `'member'`, `'guest'` or a custom role; null if not a member.
   */
  async getRole (who) {
    return this.state.roleOf(keyBytes(who, 'an identity'))
  }

  /**
   * Takes someone out of the space. What they wrote up to what this member holds stays, for everyone;
   * anything after is ignored. In a private space the key changes.
   * @param {string} who
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_ALLOWED`, saying why (role too low, their role at or above this person's, a public space's joiner: ban them).
   */
  async removeRole (who) {
    const identity = keyBytes(who, 'an identity')
    await this.#mayDecide('decide', 'remove members')
    await this.#unless(() => this.state.roleOf(identity) ? null : 'Not a member of this space', 'NOT_FOUND')
    if (!this.state.isRecorded(identity)) throw new HypergraphError('NOT_ALLOWED', 'A public space lets anyone back in: ban them instead')
    await this.#unless(() => {
      const role = this.state.roleOf(identity)
      return mayRemove(this.#myRole(), role, 'decide', this.state.roles) ? null : `You may not remove a member whose role is ${role} (yours is ${this.#myRole()})`
    })
    await this.#decide({ type: 'member/remove', identity, cut: this.#cutOf(identity) })
  }

  /**
   * Gives someone a role; someone not a member yet becomes one. Owners and admins give roles below their own.
   * @param {string} who
   * @param {string} role A built-in role (`'admin'`, `'moderator'`, `'member'`, `'guest'`) or one from {@link Space#defineRole}.
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_ALLOWED`, saying why.
   */
  async setRole (who, role) {
    const identity = keyBytes(who, 'an identity')
    await this.#mayDecide('roles', 'give roles')
    await this.#unless(() => this.state.permissionsOf(role) ? null : `No role "${role}" in this space (define it first: defineRole)`, 'NOT_FOUND')
    await this.#unless(() => this.state.isBanned(identity) ? 'This identity is banned from the space (unban it first)' : this.#assignRefusal(identity, role))
    await this.#decide({ type: 'role/set', identity, role, cut: this.#cutOf(identity) })
  }

  /**
   * Defines a role and its permissions, or adds permissions to one. A role can gain permissions later but
   * never lose `post` or one of the app's.
   * @param {string} name
   * @param {string[]} permissions hypergraph's own (`'post'`, `'moderate'`, `'invite'`, `'roles'`, `'decide'`) and the app's (e.g. `'edit-pages'`).
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_ALLOWED` for who may not decide, a built-in role's name, a permission taken away that can't be, or one this person doesn't have.
   * @throws {TypeError} For an empty name or a malformed list.
   */
  async defineRole (name, permissions) {
    await this.#mayDecide('roles', 'define roles')
    if (typeof name !== 'string' || !name) throw new TypeError('A role name is a non-empty string')
    if (!Array.isArray(permissions) || !permissions.every((p) => typeof p === 'string' && p)) throw new TypeError('permissions is a list of names')
    if (ROLES[name]) throw new HypergraphError('NOT_ALLOWED', `"${name}" is a built-in role`)
    const before = this.state.permissionsOf(name)
    const lost = (before || []).filter((/** @type {string} */ p) => !OWN.includes(p) && !permissions.includes(p))
    if (lost.length) {
      throw new HypergraphError('NOT_ALLOWED', `Role "${name}" cannot lose ${lost.map((/** @type {string} */ p) => `'${p}'`).join(', ')}: give its members another role instead`)
    }
    if (!grantable(this.#myRole(), permissions, this.state.roles)) throw new HypergraphError('NOT_ALLOWED', 'You may not hand on a permission you don\'t have')
    await this.#decide({ type: 'role/define', name, permissions })
  }

  /**
   * A moderation decision, applied by every member in the same order.
   * @param {string} action `'flag'`, `'hide'`, `'reveal'`, `'remove'` (a record, or a report: dismissed), `'ban'` or `'unban'` (an identity).
   * @param {HgRecord|string|Uint8Array} target A record (or its id), or an identity key.
   * @param {object} [opts]
   * @param {string} [opts.reason='']
   * @param {HgRecord|string|null} [opts.from=null] With `ban`: also drop this record of theirs and everything after it in its log.
   * @param {'all'|null} [opts.drop=null] With `ban`: `'all'` drops everything they wrote, on every device, here and in every sub-space below.
   * @returns {Promise<void>} Once this app applied it, here and in the sub-spaces open here.
   * @throws {HypergraphError} `NOT_ALLOWED`, saying why (not a moderator, their role at or above this person's, an unban by a lower rank than the ban's).
   */
  async moderateAction (action, target, { reason = '', from = null, drop = null } = {}) {
    if (drop !== null && drop !== 'all') throw new TypeError('drop is "all" (or leave it out)')
    if (drop && action !== 'ban') throw new TypeError('drop goes with a ban')
    if (!ACTIONS.includes(action)) throw new TypeError(`Moderation actions: ${ACTIONS.join(', ')}`)
    await this.#mayDecide('moderate', 'moderate')
    if (action === 'unban') {
      const identity = keyBytes(/** @type {string | Uint8Array} */ (target), 'an identity')
      await this.#unless(() => this.state.banned.get(hex(identity)) ? null : 'This identity is not banned here', 'NOT_FOUND')
      await this.#unless(() => {
        const byRole = this.state.roleOf(/** @type {import('./decisions/state.js').Ban} */ (this.state.banned.get(hex(identity))).by)
        return this.#myRole() !== 'owner' && byRole && rankOf(byRole) > rankOf(this.#myRole()) ? `Banned by a member whose role is ${byRole}: only someone at that rank lifts it` : null
      })
      return this.#decide({ type: 'moderate', action, target: identity, reason, cut: [] })
    }
    if (action !== 'ban') return this.#decide({ type: 'moderate', action, target: idOf(target), reason, cut: [] })
    const identity = keyBytes(/** @type {string | Uint8Array} */ (target), 'an identity')
    await this.#unless(() => mayRemove(this.#myRole(), this.state.roleOf(identity), 'moderate', this.state.roles) ? null : `You may not ban a member whose role (${this.state.roleOf(identity)}) is at or above yours (${this.#myRole()})`)
    const cut = this.#cutOf(identity)
    if (drop) return this.#decide({ type: 'moderate', action, target: identity, reason, cut: cut.map((e) => ({ log: e.log, length: 0 })), drop })
    if (from) {
      const { log, seq } = enc.idParts(idOf(from))
      const entry = cut.find((e) => b4a.equals(e.log, log))
      if (!entry || seq < 1) throw new HypergraphError('NOT_ALLOWED', 'A ban starts from one of the banned member\'s own records (this one is not theirs, or not held here)')
      entry.length = seq
    }
    await this.#decide({ type: 'moderate', action, target: identity, reason, cut })
  }


  /**
   * Reports a record to the moderators, privately: what and why are sealed to the devices of the owner,
   * admins and moderators of that moment. Other members only see that its author wrote a report.
   * @param {HgRecord|string} record
   * @param {object} [opts]
   * @param {string} [opts.reason=''] Up to 1,000 characters.
   * @returns {Promise<{id: string, stamp: number}>}
   * @throws {HypergraphError} `NOT_ALLOWED` for who may not write; `INVALID_RECORD` for a reason too long.
   */
  async report (record, { reason = '' } = {}) {
    if (this.personal) throw new HypergraphError('NOT_ALLOWED', 'The personal space is only yours: no reports')
    if (typeof reason !== 'string' || reason.length > MAX_REASON) throw new HypergraphError('INVALID_RECORD', `A report's reason is a string of at most ${MAX_REASON} characters`)
    const on = enc.idToString(idOf(record))
    const message = b4a.from(JSON.stringify({ on, reason }))
    const devices = new Map()
    for (const w of this.state.writerInfo.values()) {
      if (!w.device || devices.has(w.device) || this.state.isGone(w.identity, w.device) || !this.state.can(w.identity, 'moderate')) continue
      const box = pc.boxPublicKey(b4a.from(w.device, 'hex'))
      if (box) devices.set(w.device, { to: b4a.from(w.device, 'hex'), sealed: pc.seal(message, box) })
    }
    const r = await this._put('hg/report', { boxes: c.encode(reportBoxes, [...devices.values()]) })
    return { id: r.id, stamp: r.stamp }
  }

  /**
   * The reports this device can open (a moderator's), grouped by reported record, one per member (their
   * latest), the most recently reported first.
   * @param {object} [opts]
   * @param {number} [opts.timeout]
   * @returns {Promise<{items: Array<{on: string, count: number, reports: Array<{id: string, by: string, reason: string, stamp: number}>}>, complete: boolean}>}
   * @throws {HypergraphError} `NOT_ALLOWED` for who may not moderate.
   */
  async reports ({ timeout } = {}) {
    await this.#mayDecide('moderate', 'read reports')
    if (!this.#box) this.#box = pc.boxKeyPair(this.hg._identity.device)
    const me = this.hg._identity.device.publicKey
    return this._bounded(async (deadline) => {
      const prefix = { space: this.keyBytes, type: 'hg/report' }
      const rows = (await this.db.find('@hg/by-type', { gte: prefix, lte: prefix }).toArray()).filter((r) => !(r.flags & (FLAGS.HIDDEN | FLAGS.REMOVED)))
      const { items, partial } = await this._shaped(rows, deadline)
      /** @type {Map<string, { id: string, on: string, by: string, reason: string, stamp: number }>} */
      const latest = new Map() // `${on} ${by}` -> report
      for (const r of items) {
        let opened = null
        try {
          const mine = c.decode(reportBoxes, /** @type {Uint8Array} */ (r.boxes)).find((b) => b4a.equals(b.to, me))
          const bytes = mine && pc.openSealed(mine.sealed, /** @type {import('./identity.js').KeyPair} */ (this.#box)) // set above
          opened = bytes && JSON.parse(b4a.toString(bytes))
        } catch {}
        if (!opened || typeof opened.on !== 'string' || typeof opened.reason !== 'string') continue
        const key = `${opened.on} ${r.author}`
        const prev = latest.get(key)
        if (!prev || r.stamp > prev.stamp || (r.stamp === prev.stamp && r.id > prev.id)) latest.set(key, { id: r.id, on: opened.on, by: r.author, reason: opened.reason, stamp: r.stamp })
      }
      /** get() follows a set() @type {{ get (key: string): { id: string, on: string, by: string, reason: string, stamp: number }[] } & Map<string, { id: string, on: string, by: string, reason: string, stamp: number }[]>} */
      const groups = new Map()
      for (const rep of latest.values()) {
        if (!groups.has(rep.on)) groups.set(rep.on, [])
        groups.get(rep.on).push(rep)
      }
      const out = [...groups].map(([on, list]) => {
        list.sort((a, b) => b.stamp - a.stamp)
        return { on, count: list.length, reports: list.map(({ id, by, reason, stamp }) => ({ id, by, reason, stamp })) }
      })
      out.sort((a, b) => b.reports[0].stamp - a.reports[0].stamp)
      return { items: out, partial, need: 0 }
    }, timeout)
  }

  // Appends a decision; resolves once this member applied it. A device whose
  // member was just given a role that records decisions isn't a writer of the
  // decision log yet: it claims its key again at once and waits (within the
  // read bound, at least 5 s) instead of failing.
  /**
   * @param {import('./encodings.js').DecisionBody} decision
   */
  async #decide (decision) {
    this.#notMoved()
    if (!this.decisionLog.writable && this.state.writesDecisions(this.hg._identity.publicKey)) {
      this._claimed = 0
      this.#claim()
    }
    await this.decisionLog.append(this.#scoped(decision), { wait: BOUND_MS, onwait: () => { this._claimed = 0; this.#claim() } })
    for (const s of this.hg._spaces.values()) {
      if (s.decisionLog === this.decisionLog && s._decided) await s._decided
    }
  }

  /**
   * @param {import('./encodings.js').DecisionBody} decision
   * @returns {import('./encodings.js').DecisionBody}
   */
  #scoped (decision) {
    if (!this.rootKey) return decision
    return { type: 'scoped', space: this.keyBytes, decision: c.encode(enc.decision, { stamp: Date.now(), ...decision }) }
  }

  /**
   * The space's roles, highest first: the built-in ones, then its own.
   * @returns {Promise<Array<{name: string, permissions: string[], custom: boolean}>>}
   */
  async roles () {
    const out = Object.entries(ROLES).map(([name, permissions]) => ({ name, permissions: [...permissions], custom: false }))
    const custom = [...this.state.roles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    for (const [name, permissions] of custom) out.push({ name, permissions: [...permissions], custom: true })
    return out
  }

  /**
   * @returns {string | null}
   */
  #myRole () {
    return this.state.roleOf(this.hg._identity.publicKey)
  }

  // Why this member may not give `role` to `identity`, or null.
  /**
   * @param {Uint8Array} identity
   * @param {string} role
   * @returns {string | null}
   */
  #assignRefusal (identity, role) {
    const mine = this.#myRole()
    const current = this.state.roleOf(identity)
    if (mayAssign(mine, current, role, this.state.roles)) return null
    if (role === 'owner') return 'Nobody gives the role owner'
    if (current === 'owner') return 'The owner\'s role can\'t be changed'
    if (mine === 'owner') return `You may not give the role ${role}`
    if (current && rankOf(current) >= rankOf(mine)) return `Their role (${current}) is at or above yours (${mine})`
    if (rankOf(role) >= rankOf(mine)) return `The role ${role} is at or above yours (${mine})`
    return `The role ${role} carries a permission your role (${mine}) doesn't have`
  }

  // The cut of an identity's logs: where this member holds them, here and in
  // every sub-space held below (a removal or ban here applies there).
  /**
   * @param {Uint8Array} identity
   * @returns {import('./encodings.js').CutEntry[]}
   */
  #cutOf (identity) {
    /** @type {import('./encodings.js').CutEntry[]} */
    const cut = []
    for (const space of [this, ...this.hg._below(this)]) {
      for (const log of space.directory.logs.values()) {
        if (b4a.equals(log.identity, identity)) cut.push({ log: log.key, length: Math.min(log.indexed, log.limit) })
      }
    }
    return cut
  }

  /**
   * @param {string} permission
   * @param {string} what
   */
  async #mayDecide (permission, what) {
    if (this.closed) throw new HypergraphError('CLOSED', 'This space is closed')
    if (this.personal) throw new HypergraphError('NOT_ALLOWED', 'The personal space is only yours: no roles, moderation or invites')
    await this.#unless(() => this.state.can(this.hg._identity.publicKey, permission) ? null : this.#whyNot(what))
  }

  // --- invites: recorded by any member who
  // records decisions, the maker online or not ---

  /**
   * Makes an invite link. It is signed by its maker and holds no key; it works while its maker is
   * offline, as long as a member who records decisions is online.
   * @param {object} [opts]
   * @param {string} [opts.role='member'] A role below the maker's, or `member`/`guest`; never owner.
   * @param {number} [opts.uses=1] How many people may use it; Infinity: until revoked.
   * @param {number} [opts.expires=0] ms since 1970; 0: never.
   * @param {Array<Space|string>} [opts.subspaces=[]] Sub-spaces of this space the newcomer also gets the role in.
   * @returns {Promise<string>} The link.
   * @throws {HypergraphError} `NOT_ALLOWED`, saying why; `NOT_FOUND` for a sub-space not inside this space.
   */
  async createInvite ({ role = 'member', uses = 1, expires = 0, subspaces = [] } = {}) {
    if (this.personal) throw new HypergraphError('NOT_ALLOWED', 'The personal space is only yours: add a device with hg.addDevice()')
    if (uses !== Infinity && !(Number.isInteger(uses) && uses >= 1)) throw new TypeError('uses is a whole number of people, at least 1, or Infinity for a public link')
    await this.#unless(() => this.state.can(this.hg._identity.publicKey, 'invite') ? null : this.#whyNot('invite'))
    await this.#unless(() => this.state.permissionsOf(role) ? null : `No role "${role}" in this space`, 'NOT_FOUND')
    await this.#unless(() => mayInvite(this.#myRole(), role, this.state.roles) ? null : `Your role (${this.#myRole()}) can't invite people as ${role}`)
    await this.#unless(() => !this.circle || ['owner', 'admin'].includes(/** @type {string} */ (this.#myRole())) ? null : 'Only the owner and admins invite people to a circle')
    // Sub-spaces inside this one the newcomer gets the role
    // in too (e.g. private ones); its maker must be able to invite there.
    const subs = []
    for (const s of subspaces) {
      const key = keyBytes(s && /** @type {Space} */ (s).key ? /** @type {Space} */ (s).key : /** @type {string} */ (s), 'a sub-space')
      if (!this.#inside(key)) throw new HypergraphError('NOT_FOUND', 'Not a sub-space of this space: ' + z32.encode(key))
      const there = /** @type {import('./decisions/state.js').SubView} */ (this.decisionLog.state.sub(key)) // #inside() checked it
      const mine = there.roleOf(this.hg._identity.publicKey)
      if (!mayInvite(mine, role, this.state.roles)) throw new HypergraphError('NOT_ALLOWED', `You can't invite people as ${role} to the sub-space "${there.name}"${mine ? ` (your role there is ${mine})` : ' (you have no role there)'}`)
      subs.push(key)
    }
    const disk = this.encryptionKey && !this.personal ? pc.diskCommit(this.encryptionKey) : null // never the key
    return invites.encodeLink(invites.makeInvite({ space: this.keyBytes, role, uses: uses === Infinity ? 0 : uses, expires, subspaces: subs }, this.hg._identity, this.top), this.top, disk)
  }

  /**
   * @param {Uint8Array} key
   */
  #inside (key) {
    const subs = this.decisionLog.state.subspaces
    const here = this.rootKey ? this.hex : null
    for (let info = /** @type {import('./decisions/state.js').SubspaceInfo | null | undefined} */ (subs.get(hex(key))); info; info = info.parent ? subs.get(info.parent) : null) {
      if (info.parent === here) return true
    }
    return false
  }

  /**
   * No one else gets in with this link; who came in stays.
   * @param {string} link
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_ALLOWED` unless its maker or who may decide; always for the public link.
   */
  async revokeInvite (link) {
    const inv = this.#ownInvite(link)
    if (inv.public) throw new HypergraphError('NOT_ALLOWED', "A public link can't be revoked: a public space stays public (ban people, or set a write limit)")
    const me = this.hg._identity.publicKey
    await this.#unless(() => this.state.can(me, 'decide') || b4a.equals(inv.maker, me) ? null : 'Only its maker, or an admin, revokes an invite')
    await this.#decide({ type: 'invite/revoke', invite: c.encode(enc.invite, inv) })
  }


  /**
   * Creates a space inside this one (a sub-forum, a folder with its own rules). It has this space's
   * members and roles, then its own; a ban or removal here applies in it. Every member of this space has
   * it without joining.
   * @param {object} [opts]
   * @param {string} [opts.name='']
   * @param {boolean} [opts.private=false] Read only by the people given a role in it and this space's owner and admins.
   * @param {string[]} [opts.writeRoles=[]] Only these roles write (the owner and admins always may).
   * @returns {Promise<Space>}
   * @throws {HypergraphError} `NOT_ALLOWED` for who may not decide.
   */
  async createSubspace ({ name = '', private: priv = false, writeRoles = [] } = {}) {
    if (this.personal) throw new HypergraphError('NOT_ALLOWED', 'The personal space has no sub-spaces')
    if (typeof name !== 'string') throw new TypeError('A name is a string')
    if (!Array.isArray(writeRoles) || !writeRoles.every((r) => typeof r === 'string' && r)) throw new TypeError('writeRoles is a list of role names')
    await this.#mayDecide('decide', 'create sub-spaces')
    for (const role of writeRoles) await this.#unless(() => this.state.permissionsOf(role) ? null : `No role "${role}" in this space`, 'NOT_FOUND')
    const key = crypto.randomBytes(32)
    await this.#decide({ type: 'subspace/create', key, name, private: !!priv, writeRoles })
    const sub = await this.hg._openSubspace(key, this.top)
    await sub._startKeys() // a private one's first key
    return sub
  }

  /**
   * The sub-spaces right inside this one. One this member is in is listed once
   * {@link Hypergraph#space} opens it (`spaces` fires then).
   * @returns {Array<{key: string, name: string, private: boolean}>}
   */
  subspaces () {
    if (this.personal) return []
    this.#mustBeOpen()
    const parent = this.rootKey ? this.hex : null
    const st = this._log.state
    const me = this.hg._identity.publicKey
    const out = []
    for (const [key, info] of st.subspaces) {
      if (info.parent !== parent) continue
      if (!this.hg._spaces.has(key) && !this.hg._left.has(key) && /** @type {import('./decisions/state.js').SubView} */ (st.sub(key)).isMember(me)) continue // being opened here
      out.push({ key: z32.encode(b4a.from(key, 'hex')), name: info.name, private: !!info.private })
    }
    return out
  }


  /**
   * Opens the space to anyone, for good: its public link lets anyone in, with no decision and no admin
   * online. It can't be made private again (handle floods with bans and {@link Space#setWriteLimit}).
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_ALLOWED` for who may not decide, and for a private space.
   */
  async makePublic () {
    await this.#mayDecide('decide', 'make the space public')
    if (this.state.private) throw new HypergraphError('NOT_ALLOWED', "A private space can't be made public: whoever joined would be given its key")
    if (this.encryptionKey) throw new HypergraphError('NOT_ALLOWED', "A sub-space of a private space can't be made public: it is encrypted on disk with that space's key (spec 022)")
    if (this.state.public) return
    await this.#decide({ type: 'settings/set', policy: null, writeLimit: null, rules: null, public: true })
  }

  /**
   * The space's public link, the same on every member.
   * @returns {string}
   * @throws {HypergraphError} `NOT_ALLOWED` before it is public.
   */
  publicLink () {
    if (!this.state.public) throw new HypergraphError('NOT_ALLOWED', "This space isn't public (makePublic() first)")
    return invites.publicLink(this.keyBytes, this.top)
  }

  /**
   * Who came in with a link, oldest first. For the public link: the joiners this member knows of, `at` null.
   * @param {string} link
   * @returns {Promise<Array<{identity: string, at: (number|null)}>>}
   */
  async redemptions (link) {
    const inv = this.#ownInvite(link)
    if (inv.public) return (await this.members()).filter((m) => m.role === 'member' && !this.state.isRecorded(z32.decode(m.identity))).map((m) => ({ identity: m.identity, at: null }))
    const id = hex(inv.id)
    const out = []
    const prefix = `${this.#viewScope()}redeemed:${id}:`
    for (const [key, { at }] of await this.decisionLog.entries(prefix, prefix + '~')) {
      out.push({ identity: z32.encode(b4a.from(key.slice(prefix.length), 'hex')), at })
    }
    return out.sort((a, b) => a.at - b.at)
  }

  #viewScope () {
    return this.rootKey ? `sub:${this.hex}:` : ''
  }

  /**
   * @param {string} link
   */
  #ownInvite (link) {
    const inv = invites.decodeLink(link)
    if (!b4a.equals(inv.space, this.keyBytes)) throw new HypergraphError('NOT_FOUND', 'This invite is for another space')
    return inv
  }

  // A newcomer's redemption reached us (on channel `ch`): record it if we
  // can; in a private space, then send it the disk key.
  /**
   * @param {Uint8Array} bytes
   * @param {SpaceChannel | null} [ch]
   */
  async #redeem (bytes, ch = null) {
    if (!this.decisionLog.writable || !this.state.can(this.hg._identity.publicKey, 'decide')) return
    /** @type {import('./encodings.js').Redemption | null} */
    let r = null
    try { r = c.decode(enc.redemption, bytes) } catch { return }
    const sealed = !!this.encryptionKey && !this.personal
    if (this.state.moved) { // old invite links stop working
      const who = sealed && ch && invites.verifyRedemption(r, this.top)
      const box = who && pc.boxPublicKey(who.device)
      if (box) ch.messages[KEY_MESSAGE].send(pc.seal(pc.refusalAnswer('INVITE_REVOKED'), box))
      return
    }
    if (!b4a.equals(r.invite.space, this.keyBytes) || (this.state.isRecorded(r.identity) && !sealed) || (this.state.isBanned(r.identity) && !sealed)) return
    const who = invites.verifyRedemption(r, this.top)
    if (!who) return
    if (this.state.isBanned(r.identity)) return ch && this.#answer(ch, r, who.device) // sealed: told NOT_ALLOWED
    const tag = hex(r.invite.id) + hex(r.identity)
    if (!this.state.isRecorded(r.identity)) {
      if (this._redeeming.has(tag)) return
      this._redeeming.add(tag)
      try {
        await this.decisionLog.append(this.#scoped({ type: 'invite/redeem', redemption: bytes }))
      } finally {
        this._redeeming.delete(tag)
      }
    }
    if (sealed && ch) await this.#answer(ch, r, who.device)
  }

  // The answer to a redemption, sealed to the device that signed
  // it: the disk key once the decision log recorded it (sent again if that
  // device asks again: a lost message), else the refusal's code (the newcomer
  // can't read the log to tell why). Never the key to a refused redemption,
  // a banned member or a removed device.
  /**
   * @param {SpaceChannel} ch
   * @param {import('./encodings.js').Redemption} r
   * @param {Uint8Array} device
   */
  async #answer (ch, r, device) {
    const box = pc.boxPublicKey(device)
    if (!box || this.closed) return
    const id = hex(r.invite.id)
    const recorded = await this.decisionLog.entry(`${this.#viewScope()}redeemed:${id}:${hex(r.identity)}`)
    if (recorded && this.state.isMember(r.identity) && !this.state.isBanned(r.identity) && !this.isRemoved(r.identity, device)) {
      ch.messages[KEY_MESSAGE].send(pc.seal(pc.keyAnswer(/** @type {Uint8Array} */ (this.encryptionKey), this.#pastKeys()), box))
      return
    }
    const uses = await this.decisionLog.entry(`${this.#viewScope()}uses:${id}`)
    const refused = this.state.inviteRefusal(r.invite, r.identity, Date.now(), uses ? uses.count : 0) || (this.state.isBanned(r.identity) ? 'NOT_ALLOWED' : null)
    if (refused) ch.messages[KEY_MESSAGE].send(pc.seal(pc.refusalAnswer(refused), box))
  }

  /**
   * @returns {{ top: Uint8Array, key: Uint8Array }[]}
   */
  #pastKeys () {
    if (this.state.history === 'hidden') return []
    const tops = new Set([...this.state.pasts.values()].map((p) => p.top))
    return [...tops].map((h) => ({ top: b4a.from(h, 'hex'), key: this.hg._diskKeys.get(h) })).filter((p) => p.key)
  }

  // Asks every peer of this space to record our redemption; resolves to true
  // when the decision log says we're in, to the reason it was refused (a
  // code), or to false after `timeout`. Refusals are judged from this
  // device's own copy of the decision log once a member was reached: the
  // checks a recorder makes (uses, revocation, the maker's rights).
  /**
   * @param {import('./encodings.js').Redemption} redemption
   * @param {number} timeout
   * @returns {Promise<true | import('./errors.js').ErrorCode | false>} true once in; else why not.
   */
  async _redeem (redemption, timeout) {
    const me = this.hg._identity.publicKey
    if (this.state.isRecorded(me)) return true
    this._redemption = c.encode(enc.redemption, redemption)
    this.directory.sendRedeem(this._redemption)
    const deadline = Date.now() + timeout
    let refused = null
    while (!this.state.isRecorded(me) && !this.closed && Date.now() < deadline) {
      if (this.state.meta && this.directory.reached) {
        const id = hex(redemption.invite.id)
        const recorded = await this.decisionLog.entry(`${this.#viewScope()}redeemed:${id}:${hex(me)}`)
        const uses = await this.decisionLog.entry(`${this.#viewScope()}uses:${id}`)
        refused = recorded ? null : this.state.inviteRefusal(redemption.invite, me, Date.now(), uses ? uses.count : 0)
      }
      if (refused) break
      await this.#progress(deadline - Date.now())
    }
    this._redemption = null
    return this.state.isRecorded(me) || refused || false
  }

  // Joining with a public link: nothing is sent; resolves to true
  // once this device's copy of the decision log says the space is public,
  // 'NOT_PUBLIC' once a peer was reached and it caught up saying it isn't,
  // false after `timeout`.
  /**
   * @param {number} timeout
   * @returns {Promise<boolean | 'NOT_PUBLIC'>}
   */
  async _joinPublic (timeout) {
    const deadline = Date.now() + timeout
    while (!this.closed && Date.now() < deadline) {
      if (this.state.public) return true
      if (this.state.meta && this.directory.reached) {
        for (let writers = -1; writers !== this.state.writerInfo.size && !this.state.public && Date.now() < deadline;) {
          writers = this.state.writerInfo.size
          await this.decisionLog.catchUp(Math.min(BOUND_MS, Math.max(0, deadline - Date.now())))
        }
        return this.state.public || 'NOT_PUBLIC'
      }
      await this.#progress(Math.min(250, deadline - Date.now()))
    }
    return this.state.public
  }

  /**
   * How this space is doing on this device.
   * @returns {SpaceStatus} In a circle, also its `members`, `holders` and `total` room (bytes).
   * `access`: `'full'`, `'waiting'` (a private space's key not here yet) or `'none'`. `held`: `'all'`, or
   * `'part'` once content was dropped or while a big space is read from `heldFrom` on. Warnings:
   * `SINGLE_SETTLER`, `BELOW_POLICY`, `OVER_BUDGET`, `DECISIONS_FAILED`, `RULES_DIFFER`, `OTHER_VERSION`,
   * `UNSERVED_LENGTH`, `RENEW_WAITING`. A circle adds `members`, `holders` and `total`.
   */
  status () {
    this.#mustBeOpen()
    let settlers = 0
    for (const w of this.state.writerInfo.values()) if (w.indexer) settlers++
    const { stored, floor, droppedBlocks } = this._usage()
    const share = this._share
    const policy = this._policy
    const belowPolicy = policy === 'everything' && !this.personal && (droppedBlocks > 0 || (this._reading.horizon !== null && this._reading.horizon > 0 && this._share !== null && this._usage().stored * 2 >= this._share * 0.9))
    const warnings = []
    if (!this.personal && settlers === 1) {
      warnings.push({ code: 'SINGLE_SETTLER', message: 'Only one member settles the order of decisions here: give the space an admin, so it keeps working if that device is lost' })
    }
    if (this.directory.others.size) warnings.push({ code: 'OTHER_VERSION', message: 'A peer runs another version of hypergraph, which can’t sync with this one: update every app together' })
    for (const [h, { peer, length }] of this.directory.unserved) {
      warnings.push({ code: 'UNSERVED_LENGTH', message: `A peer (${peer ? z32.encode(peer) : 'unknown'}) said it holds ${length} blocks of log ${z32.encode(b4a.from(h, 'hex'))}, and nobody served them: they are not counted as missing` })
    }
    if (belowPolicy) warnings.push({ code: 'BELOW_POLICY', message: 'This space asks its members to keep everything, and this device keeps only part of it: give it more room (setBudget)' })
    const differ = this.personal ? null : rulesDiffer(this.state.rules, this.hg.rules)
    if (differ) warnings.push({ code: 'RULES_DIFFER', message: differ })
    if (this.decisionLog.error) { // Autobase stopped on an error: this device's decisions stand still until the app opens it again
      warnings.push({ code: 'DECISIONS_FAILED', message: `This space's decision log stopped on an error (${this.decisionLog.error.message}): close and open the app again` })
    }
    if (this.renewal && this.renewal.waiting) {
      warnings.push({ code: 'RENEW_WAITING', message: 'This space was just renewed: keep this device online until another owner\'s or admin\'s device has opened it' })
    }
    if (this._over) {
      warnings.push({ code: 'OVER_BUDGET', message: 'What this device may not drop here (its own records, the decisions, the list of records) is more than this space\'s share of the budget' })
    }
    const horizon = this._reading.horizon
    const heldFrom = horizon === null ? null : horizon * PERIOD_MS // reads records from then on
    /** @type {{ members?: number, holders?: number, total?: number | null }} */
    const circle = this.circle ? this.hg._circles.statusOf(this) : {}
    return { policy, access: this._access(), held: droppedBlocks > 0 || heldFrom !== null ? 'part' : 'all', heldFrom, stored, share, budget: this._budget, belowPolicy, peers: this.directory.peers, settlers, warnings, complete: this.isComplete(), ...circle }
  }

  /**
   * A read-only diagnostics snapshot, for debugging and the inspector: logs, the decision log, records
   * by type, storage, peers, warnings. It writes and fetches nothing, but counts every record: not for every
   * render.
   * @param {object} [opts]
   * @param {{type: string, limit?: number, after?: (HgRecord|string|null)} | null} [opts.records] Also every row of a type (`rows: { items, next }`), hidden, superseded and dropped ones included.
   * @param {string | null} [opts.record] Also one record's versions and deletes.
   * @returns {Promise<Record<string, any>>} Its logs, writers, records by type, storage and warnings (a debugging view: its shape may change).
   * @throws {HypergraphError} `CLOSED`.
   */
  async inspect ({ records: rowsOf = null, record: recordId = null } = {}) {
    if (this.closed) throw new HypergraphError('CLOSED', 'This space is closed')
    const logs = []
    const seen = new Set()
    for (const log of this.directory.logs.values()) {
      seen.add(hex(log.key))
      logs.push({
        key: z32.encode(log.key),
        identity: z32.encode(log.identity),
        device: z32.encode(log.device),
        own: !!log.own,
        length: log.length,
        held: await this.directory.use(log, heldCount).catch(() => 0),
        indexed: Math.min(log.indexed, log.length),
        cut: log.cut || null,
        dropped: log.droppedBlocks,
        refused: false,
        waiting: false
      })
    }
    const refusedRows = await this.db.find('@hg/logs', { gte: { space: this.keyBytes }, lte: { space: this.keyBytes } }).toArray()
    for (const row of refusedRows) {
      if (!row.refused || seen.has(hex(row.log))) continue
      seen.add(hex(row.log))
      logs.push(otherLog(row.log, { identity: row.identity, device: row.device, cut: row.cut || null, refused: true }))
    }
    for (const h of this.directory.refused) {
      if (!seen.has(h)) logs.push(otherLog(b4a.from(h, 'hex'), { refused: true }))
      seen.add(h)
    }
    for (const [h, w] of this.directory.pending) {
      if (!seen.has(h)) logs.push(otherLog(w.key, { identity: w.identity, device: w.device, waiting: true }))
    }

    const writers = [...this.state.writerInfo].map(([key, w]) => ({
      key: z32.encode(b4a.from(key, 'hex')),
      identity: z32.encode(b4a.from(w.identity, 'hex')),
      device: w.device ? z32.encode(b4a.from(w.device, 'hex')) : null,
      settler: !!w.indexer
    }))
    /** @type {Record<string, number>} */
    const records = {}
    const range = { gte: { space: this.keyBytes }, lte: { space: this.keyBytes } }
    for await (const row of this.db.find('@hg/by-type', range)) records[row.type] = (records[row.type] || 0) + 1

    const s = this.status()
    return {
      key: this.key,
      name: this.name,
      personal: this.personal,
      parent: this.parent, // the space it is in, its own sub-spaces, private state (never keys)
      subspaces: this.subspaces(),
      private: this.private,
      epoch: this.state.keys ? this.state.keys.current : null,
      readable: !this.private || !!this.#current(),
      access: s.access, // 'full' | 'waiting' | 'none' (a private space not for this member)
      reading: { heldFrom: s.heldFrom, byActivity: this._reading.byActivity, entries: (await this.activity.list(0)).length },
      complete: this.isComplete(),
      peers: s.peers,
      logs,
      decisions: { length: this.decisionLog.base.length, settled: this.decisionLog.base.indexedLength, settlers: writers.filter((w) => w.settler).map((w) => w.key), writers },
      records,
      storage: { policy: s.policy, held: s.held, stored: s.stored, share: s.share, budget: s.budget, belowPolicy: s.belowPolicy },
      warnings: s.warnings,
      ...(rowsOf ? { rows: await this.#inspectRows(rowsOf) } : {}),
      ...(recordId ? { record: await this.#inspectRecord(recordId) } : {})
    }
  }

  /**
   * @param {{ type: string, limit?: number, after?: HgRecord | string | null }} opts
   */
  async #inspectRows ({ type, limit = 25, after = null }) {
    const prefix = { space: this.keyBytes, type }
    let from = null
    if (after) from = await this.db.get('@hg/records', { space: this.keyBytes, id: idOf(after) })
    const range = from ? { gte: prefix, lte: { ...prefix, stamp: from.stamp } } : { gte: prefix, lte: prefix }
    const items = []
    let more = false
    for await (const row of this.db.find('@hg/by-type', range, { reverse: true })) {
      if (from && row.stamp === from.stamp && b4a.compare(row.id, from.id) >= 0) continue
      if (items.length === limit) { more = true; break }
      const f = row.flags || 0
      items.push({ ...shape(this._types, row), state: { hidden: !!(f & FLAGS.HIDDEN), superseded: !!(f & FLAGS.SUPERSEDED), edited: !!(f & FLAGS.EDITED), flagged: !!(f & FLAGS.FLAGGED), dropped: !!(f & FLAGS.DROPPED), read: !!(f & FLAGS.READ) } })
    }
    return { items, next: more ? /** @type {HgRecord} */ (items.at(-1)).id : null }
  }

  /**
   * @param {HgRecord | string} id
   */
  async #inspectRecord (id) {
    const key = idOf(id)
    const row = await this.db.get('@hg/records', { space: this.keyBytes, id: key })
    const { log: logKey, seq } = enc.idParts(key)
    const log = this.directory.logs.get(hex(logKey))
    /** @param {Uint8Array} k */
    const z = (k) => z32.encode(k)
    /** @param {string} type @param {Uint8Array} fields @param {Uint8Array[]} links */
    const fieldsOf = (type, fields, links) => {
      try { return this._types.has(type) ? this._types.decode(type, fields, links) : {} } catch { return {} }
    }
    const versions = []
    const bytes = log ? await this.directory.get(log, seq, { wait: false }).catch(() => null) : null
    let put = null
    if (bytes) put = this._unsealed(/** @type {HeldLog} */ (log), seq, bytes) // null while its key isn't held here
    const type = row ? row.type : put ? put.type : null
    if (row || put) {
      versions.push({ id: enc.idToString(key), kind: 'put', by: log ? z(log.identity) : (row ? z(row.author) : null), device: log ? z(log.device) : (row ? z(row.device) : null), stamp: row ? row.stamp : /** @type {OpenRecord} */ (put).stamp, counts: !!row, ...(put ? fieldsOf(put.type, put.fields, put.links) : {}) })
    }
    const deletes = []
    const changes = await this.db.find('@hg/changes', { gte: { space: this.keyBytes, target: key }, lte: { space: this.keyBytes, target: key } }).toArray()
    changes.sort((a, b) => a.stamp - b.stamp)
    for (const ch of changes) {
      let counts = row ? gate.mayChange(this._types, ch, row, this.state) : null
      if (!row && ch.kind === enc.DELETE && log) counts = ch.type === type || type === null ? b4a.equals(ch.author, log.identity) : false
      const base = { id: enc.idToString(ch.id), by: z(ch.author), device: z(ch.device), stamp: ch.stamp, counts }
      if (ch.kind === enc.DELETE) deletes.push(base)
      else versions.push({ ...base, kind: 'edit', ...fieldsOf(ch.type, ch.fields, ch.links) })
    }
    return { id: enc.idToString(key), type: type || (changes[0] ? changes[0].type : null), deleted: !row && deletes.some((d) => d.counts), removed: this.state.isRemoved(key), versions, deletes }
  }

  _statusChanged () {
    if (this.closed || !this.decisionLog) return
    const s = this.status()
    const sig = JSON.stringify([s.policy, s.access, s.held, s.heldFrom, s.belowPolicy, s.budget, s.warnings.map((w) => w.code), s.settlers, s.complete, s.members, s.holders])
    if (sig === this._statusSig) return
    this._statusSig = sig
    this.emit('status', s)
  }


  get _policy () { return this.personal ? 'everything' : this.state.policy }

  _usage () {
    const me = this.hg._identity.publicKey
    let stored = 0
    let floor = 0
    let droppedBlocks = 0
    for (const log of this.directory.logs.values()) {
      const length = log.length
      const below = log.from === null ? length : log.from - 1 // not read here
      const held = Math.max(0, Math.min(log.scanned, log.limit, length) - below - log.holes.size)
      if (!held) continue
      const content = log.byteLength * held / length
      const ixBytes = log.ixBytes || 0 // app index entries and tag keys: never dropped
      const s = storage.stored({ content, blocks: held, droppedContent: log.dropped, droppedBlocks: log.droppedBlocks, ixBytes })
      stored += s
      floor += b4a.equals(log.identity, me) ? s : held * storage.ROW_OVERHEAD + ixBytes
      droppedBlocks += log.droppedBlocks
    }
    const decisions = this.decisionLog.bytes()
    return { stored: stored + decisions, floor: floor + decisions, droppedBlocks }
  }

  // Keeps this space within `share` bytes (the app's budget pass): content
  // dropped oldest first, records fetched back by a read last; in a space
  // whose creator asks to keep everything, dropped content fetched again
  // once it fits.
  // `over`: what it can't drop already takes more than it may use.
  /**
   * @param {number} share
   * @param {boolean} [over]
   */
  async _hold (share, over = false) {
    this._share = share
    this._over = over
    if (this.personal || this.closed) return
    const target = share * 0.95 // a little under, not to drop at every new record
    if (this._usage().stored > share) {
      const touched = new Set()
      for (const read of [false, true]) {
        const need = this._usage().stored - target
        if (need <= 0) break
        const rows = await this.#droppable(need, read)
        const { logs, bytes } = await this.indexer.drop(rows)
        for (const log of logs) touched.add(log)
        this.hg._dropped(bytes)
      }
      for (const log of touched) this.replicator.restart(log)
      this._statusChanged()
      return
    }
    if (this._policy === 'everything') await this.#refill(share)
    this.#backfill(share)
  }

  // Records whose content may go, oldest first, adding up to about `need`
  // bytes: the app's types, others' records only, of at least DROP_MIN bytes,
  // held below where their log is indexed; `read`: those fetched back by a
  // read (they go last).
  /**
   * @param {number} need
   * @param {boolean} read
   * @returns {Promise<RecordRow[]>}
   */
  async #droppable (need, read) {
    const me = this.hg._identity.publicKey
    const found = []
    if (!this._dropFrom) this._dropFrom = new Map()
    for (const type of this._types.names()) {
      if (type.startsWith('hg/')) continue
      const prefix = { space: this.keyBytes, type }
      const from = read ? 0 : (this._dropFrom.get(type) || 0)
      const stream = this.db.find('@hg/by-type', { gte: from ? { ...prefix, stamp: from } : prefix, lte: prefix })
      let sum = 0
      let first = 0
      for await (const row of stream) {
        if ((row.flags & FLAGS.DROPPED) || !!(row.flags & FLAGS.READ) !== read) continue
        if (b4a.equals(row.author, me) || !row.fields || row.fields.byteLength < DROP_MIN) continue
        const log = this.directory.logs.get(hex(row.log))
        if (!log || log.own || row.seq >= log.indexed) continue
        if (!first) first = row.stamp
        found.push(row)
        sum += 2 * row.fields.byteLength + storage.BLOCK_OVERHEAD
        if (sum >= need) break
      }
      await stream.destroy()
      if (!read && first) this._dropFrom.set(type, first) // everything older is dropped or never droppable
    }
    found.sort((a, b) => a.stamp - b.stamp)
    const out = []
    let sum = 0
    for (const row of found) {
      if (sum >= need) break
      out.push(row)
      sum += 2 * row.fields.byteLength + storage.BLOCK_OVERHEAD
    }
    return out
  }

  // Keep everything (the creator's choice): content dropped here while it
  // didn't fit is fetched again, a batch per pass, once it fits.
  /**
   * @param {number} share
   */
  async #refill (share) {
    const { stored, droppedBlocks } = this._usage()
    if (!droppedBlocks || this._refilling) return
    let dropped = 0
    for (const log of this.directory.logs.values()) dropped += log.dropped
    if (stored + 2 * dropped > share * 0.95) return
    this._refilling = true
    try {
      const rows = []
      for (const type of this._types.names()) {
        if (type.startsWith('hg/')) continue
        const prefix = { space: this.keyBytes, type }
        for (const row of await this.db.find('@hg/by-type', { gte: prefix, lte: prefix }).toArray()) {
          if ((row.flags & FLAGS.DROPPED) && rows.length < REFILL) rows.push(row)
        }
      }
      const deadline = Date.now() + BOUND_MS
      await Promise.all(rows.map((row) => this.#content(row, deadline, false)))
      this._dropFrom = null
      if (rows.length) this.hg._holdLater()
    } finally {
      this._refilling = false
    }
  }

  /**
   * This space's own budget on this device, taken out of the app's.
   * @param {number|null} bytes null: share the app's budget with the other spaces.
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_ALLOWED` when the spaces' budgets would exceed the app's; `CLOSED`.
   */
  async setBudget (bytes) {
    if (this.closed) throw new HypergraphError('CLOSED', 'This space is closed')
    if (this.personal) throw new HypergraphError('NOT_ALLOWED', 'The personal space is always kept whole')
    if (bytes !== null && !(Number.isFinite(bytes) && bytes > 0)) throw new TypeError('A budget is a number of bytes, or null to share the app\'s budget')
    if (bytes !== null) {
      let others = 0
      for (const s of this.hg._spaces.values()) if (s !== this && s._budget) others += s._budget
      if (others + bytes > this.hg.budget) throw new HypergraphError('NOT_ALLOWED', `Spaces' own budgets would add up to more than the app's budget (${this.hg.budget} bytes)`)
    }
    this._budget = bytes
    await this.hg._saveBudget(this, bytes)
    await this.hg._holdNow()
  }

  /**
   * The storage policy every member is asked to follow.
   * @param {string} policy `'auto'` (keep what fits, then the newest part plus what is read) or `'everything'`.
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_ALLOWED` for who may not decide.
   */
  async setPolicy (policy) {
    if (!POLICIES.includes(policy)) throw new TypeError(`A policy is ${POLICIES.map((p) => `'${p}'`).join(' or ')}`)
    await this.#mayDecide('decide', 'change the storage policy')
    await this.#decide({ type: 'settings/set', policy, writeLimit: null, rules: null })
  }

  /**
   * Records this app's rule ids as the ones the space runs; a member whose app runs others gets
   * `RULES_DIFFER` in {@link Space#status}. Rules are code: this detects a mismatch, it can't prevent one.
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_ALLOWED` for who may not decide.
   */
  async setRules () {
    await this.#mayDecide('decide', 'record the rules the space runs')
    await this.#decide({ type: 'settings/set', policy: null, writeLimit: null, rules: this.hg.rules.map((r) => r.id) })
  }


  /**
   * The helpers (blind-peer servers) keeping this space while its members are offline: their keys (z32).
   * A sub-space's are its top space's. Changes fire `decisions`.
   * @type {string[]}
   */
  get helpers () { return this.state.helpers.map((/** @type {string} */ k) => z32.encode(b4a.from(k, 'hex'))) }

  /**
   * Lists the space's helpers. Never required: with none, or all down, everything works as without.
   * At most 8; each core goes to 2 of them.
   * @param {string[]} keys Blind-peer keys, z32 or hex; [] clears.
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_ALLOWED` for anyone but the owner.
   * @throws {TypeError} For a key that isn't 32 bytes.
   */
  async setHelpers (keys) {
    if (!Array.isArray(keys) || keys.length > MAX_HELPERS) throw new TypeError(`Helpers are a list of at most ${MAX_HELPERS} keys`)
    const list = [...new Set(keys.map(helperKey))]
    if (this.personal || this.rootKey) throw new HypergraphError('NOT_ALLOWED', 'Only a top space lists helpers (its sub-spaces use them)')
    await this.#unless(() => this.#myRole() === 'owner' ? null : "Only the owner lists the space's helpers")
    await this.#decide({ type: 'settings/set', policy: null, writeLimit: null, rules: null, history: null, helpers: list })
  }

  // In a space with helpers, a device that records decisions lists the logs
  // it holds that aren't listed yet, so members find them on a helper without
  // meeting their authors. Batched.
  #listLater () {
    if (this._listTimer || this.closed || this.personal || !this.state.helpers.length || !this.decisionLog.writable) return
    this._listTimer = setTimeout(() => {
      this._listTimer = null
      this.#listLogs().catch(safetyCatch)
    }, LIST_MS)
  }

  async #listLogs () {
    if (this.closed || !this.state.helpers.length || !this.decisionLog.writable) return
    const listed = this.decisionLog.state.listed
    const logs = [...this.directory.logs.values()].filter((l) => !listed.has(hex(l.key))).map((l) => ({ space: this.keyBytes, log: l.key }))
    if (logs.length) await this.decisionLog.append({ type: 'logs/list', logs }, { wait: 0 })
  }

  // The listed logs of this space not held here: checked and fetched as any
  // log a peer names (lib/directory.js).
  /**
   * @param {import('./decisions/state.js').Touched} changed
   */
  #considerListed (changed) {
    const listed = this.decisionLog.state.listed
    for (const [log, space] of changed.all ? listed : /** @type {[string, string | undefined][]} */ ([...changed.listed].map((h) => [h, listed.get(h)]))) {
      if (space === this.hex && !this.directory.logs.has(log)) this.directory.consider(b4a.from(log, 'hex')).catch(safetyCatch)
    }
  }

  // A member reads each log from its first record in the horizon period on
  // (null: everything, the usual case). A newcomer to a big space starts at
  // the newest period; a read needing older records widens the horizon at
  // once, and in the background it widens while the space fits its share
  // (newest part first). Beyond BIG.logs logs, a newcomer doesn't open every
  // log, only those of the activity lists of the periods it reads.

  get _readingName () { return 'reading:' + this.hex }

  async #loadReading () {
    const row = await this.db.get('@hg/meta', { name: this._readingName })
    if (row) {
      const r = JSON.parse(b4a.toString(row.value))
      this._reading = { horizon: r.horizon ?? null, byActivity: !!r.byActivity }
      if (this._reading.horizon !== null) await this.#loadEntries(this._reading.horizon)
    } else if (this._fresh) {
      this._undecided = true
    }
  }

  #saveReading () {
    const value = b4a.from(JSON.stringify(this._reading))
    return this.hg._queue.run((tx) => tx.insert('@hg/meta', { name: this._readingName, value })).catch(safetyCatch)
  }

  /**
   * @param {number} from
   */
  async #loadEntries (from) {
    this._act = new Map()
    const range = { gte: { space: this.keyBytes, period: from }, lte: { space: this.keyBytes } }
    for (const row of await this.db.find('@hg/activity', range).toArray()) this.#remember(row)
  }

  /**
   * @param {ActivityRow} row
   */
  #remember (row) {
    const h = hex(row.log)
    if (!this._act.has(h)) this._act.set(h, new Map())
    const periods = this._act.get(h)
    const old = periods.get(row.period)
    if (old === undefined || row.start < old) periods.set(row.period, row.start)
  }

  // A peer's directory summary, before this newcomer asks for anything: how
  // to read this space.
  /**
   * @param {{ count: number, records?: number }} summary
   */
  #onSummary ({ count, records }) {
    if (!this._undecided || this.closed) return
    this._undecided = false
    if (count < BIG.logs && /** @type {number} */ (records) < BIG.records) return
    const now = periodOf(Date.now())
    this._reading = { horizon: now, byActivity: count >= BIG.logs }
    this.#saveReading()
    this.activity.ask(now)
    this._statusChanged()
  }

  // Where reading a log just accepted starts: 1 when everything is read;
  // else its first entry at or after the horizon (null: none, not read).
  /**
   * @param {Uint8Array} key
   * @returns {Promise<number | null>}
   */
  async #fromOf (key) {
    if (this._reading.horizon === null || this._undecided) return 1
    return this.#startOf(hex(key), this._reading.horizon)
  }

  /**
   * @param {string} h
   * @param {number} period
   * @returns {number | null}
   */
  #startOf (h, period) {
    const periods = this._act.get(h)
    let start = null
    if (periods) for (const [p, s] of periods) if (p >= period && (start === null || s < start)) start = s
    return start
  }

  /**
   * @param {ActivityRow[]} rows
   */
  #entries (rows) {
    if (this._reading.horizon === null || this.closed) return
    for (const row of rows) {
      if (row.period < this._reading.horizon) continue
      this.#remember(row)
      const log = this.directory.logs.get(hex(row.log))
      if (log) this.#readFrom(log, row.start)
    }
    this.emit('_progress')
  }

  // Reads `log` from block `start` on (a checked entry's start: the block
  // before it is the header or an earlier period's).
  /**
   * @param {HeldLog} log
   * @param {number} start
   */
  #readFrom (log, start) {
    if (log.own || (log.from !== null && log.from <= start) || this.closed) return
    if (log.from === null) {
      log.indexed = log.scanned = start
    } else {
      log.skip = { from: log.from, to: log.scanned } // done already: not looked at again
      log.rescanned = true
      log.scanned = start
      log.indexed = Math.min(log.indexed, start)
    }
    log.from = start
    log.act = { next: start, last: start - 1, period: -1 }
    this.replicator.restart(log)
    this.indexer.index(log).catch(safetyCatch)
  }

  /**
   * @param {number} period
   */
  #widen (period) {
    const r = this._reading
    if (r.horizon === null || period >= r.horizon || this.closed) return this._widening
    const floor = this.#floor()
    if (period <= floor) period = 0
    r.horizon = period
    this._widening = (async () => {
      await this.#saveReading()
      await this.#loadEntries(period)
      for (const [h] of this._act) {
        const log = this.directory.logs.get(h)
        const start = this.#startOf(h, period)
        if (log && start !== null) this.#readFrom(log, start)
        else if (!log && start !== null) this.directory.considerSome(b4a.from(h, 'hex'))
      }
      this.activity.ask(period)
      this._statusChanged()
    })().catch(safetyCatch)
    return this._widening
  }

  #floor () {
    const meta = this.state.meta
    return meta && meta.stamp ? periodOf(meta.stamp) : 0
  }

  // One step back (the window read doubles), for a read needing older
  // records than it found.
  #stepBack () {
    const h = this._reading.horizon
    return Math.max(0, /** @type {number} */ (h) - Math.max(1, periodOf(Date.now()) - /** @type {number} */ (h) + 1)) // a horizon is set when this runs
  }

  /**
   * Whether everything stamped at or after a time is held and indexed here (for a big space read from
   * a point in time on). For a member holding everything, the same as {@link Space#isComplete}.
   * @param {number} stamp ms since 1970.
   * @returns {boolean}
   * @param {number} stamp
   */
  completeFrom (stamp) {
    if (!this.personal && this.state.members.size === 0) return false
    const r = this._reading
    if (r.horizon === null) return this.#completeAll()
    const p = Math.max(0, periodOf(stamp))
    if (p < r.horizon || this._undecided) return false
    if (this.activity.reachedFrom > p || this.activity.waitingFrom(p)) return false
    for (const [h] of this._act) {
      const start = this.#startOf(h, p)
      if (start === null) continue
      const log = this.directory.logs.get(h)
      if (!log) {
        if (this.directory.refused.has(h)) continue
        return false
      }
      if (log.own) continue
      if (log.from === null || log.from > start || unheard(log, this.directory.settled()) || log.uncommitted) return false
      const end = Math.min(log.length, log.limit)
      if (log.scanned < end) return false
      for (const s of log.holes) if (s >= start) return false
    }
    return true
  }

  #coveredFrom () {
    for (const log of this.directory.logs.values()) {
      if (log.from !== null && log.act.next < Math.min(log.length, log.limit)) return Infinity // entries not derived yet
    }
    const r = this._reading
    if (r.horizon === null) return this.replicator.missing() === 0 ? 0 : Infinity
    return Math.max(r.horizon, this.activity.reachedFrom)
  }

  // In the background (the app's budget pass): once what is read is held,
  // one step back while the space fits its share (or always, if its creator
  // asks to keep everything); reading everything again once it has it all.
  /**
   * @param {number | null} share
   */
  #backfill (share) {
    const r = this._reading
    if (r.horizon === null || this.closed || this._undecided) return
    if (!this.completeFrom(r.horizon * PERIOD_MS)) return
    if (r.horizon === 0) {
      if (!r.byActivity && this.completeFrom(0)) { // everything held: as any member that always had it
        this._reading = { horizon: null, byActivity: false }
        this._act = new Map()
        this.#saveReading()
        this._statusChanged()
      }
      return
    }
    const fits = this._policy === 'everything' || (share !== null && this._usage().stored * 2 < share * 0.9)
    if (fits) this.#widen(this.#stepBack())
  }

  _readingState () {
    return { horizon: this._reading.horizon, byActivity: this._reading.byActivity, reachedFrom: this.activity.reachedFrom, undecided: this._undecided }
  }

  /**
   * Closes the space on this device. Calls made after it reopen it.
   * @returns {Promise<void>}
   */
  async close () {
    if (this.closed) return
    this.closed = true
    clearTimeout(this._idleTimer)
    if (this._opening) await this._opening.catch(safetyCatch)
    if (this._shutting) await this._shutting
    if (this.decisionLog) await this.#teardown()
    this.opened = false
  }

  // Back to a closed space that opens again on its next use: only
  // when not in use, so no call is in flight.
  async _shut () {
    if (!this.opened || this.closed || this._inUse) return false
    this._shutting = (async () => {
      this.opened = false
      this.closed = true // what runs in the background stops
      try {
        await this.#teardown()
      } catch (err) {
        safetyCatch(err) // whatever failed, it opens again on its next use
      } finally {
        const cores = [this.own && this.own.core, this._idcore, ...(this.directory ? [...this.directory.logs.values()].map((log) => log.core) : [])]
        await Promise.all(/** @type {import('hypercore')[]} */ (cores.filter(Boolean)).map((core) => Promise.resolve().then(() => core.close()).catch(safetyCatch)))
        this.decisionLog = /** @type {Decisions} */ (/** @type {unknown} */ (null))
        this.closed = false
        this._fresh = false
        this.#reset()
      }
    })()
    try {
      await this._shutting
    } finally {
      this._shutting = null
    }
    return true
  }

  async #teardown () {
    clearTimeout(this._followTimer)
    clearTimeout(this._logsTimer)
    clearTimeout(this._statusTimer)
    clearTimeout(this._listTimer)
    this.emit('_progress')
    this._helpers.close()
    this.activity.close()
    this.directory.close()
    this.replicator.close()
    this.indexer.close()
    for (const log of this.directory.logs.values()) if (log.indexing) await log.indexing
    await this.directory.closeCores()
    this.decisionLog.off('change', this._onchange)
    this.decisionLog.off('failed', this._onfailed)
    if (this.personal) await this.decisionLog.close().catch(safetyCatch)
    else await this.hg._releaseDecisions(this.top)
  }
}

/**
 * @param {string[] | null} space The rule ids the space runs.
 * @param {import('./gate.js').Rules} mine
 */
function rulesDiffer (space, mine) {
  if (!space) return null
  const ids = new Set(mine.map((r) => r.id))
  const missing = space.filter((id) => !ids.has(id))
  const extra = [...ids].filter((id) => !space.includes(id)).sort()
  if (!missing.length && !extra.length) return null
  const parts = []
  if (missing.length) parts.push(`this app lacks ${missing.map((id) => `"${id}"`).join(', ')}`)
  if (extra.length) parts.push(`the space doesn't run ${extra.map((id) => `"${id}"`).join(', ')}`)
  return `This app's rules differ from the ones this space runs (${parts.join('; ')}): members may disagree on which records exist. Update the app, or record its rules (setRules) if it is the space's new version`
}

/**
 * @param {import('hypercore')} core
 */
async function heldCount (core) {
  if (!core.length || await core.has(0, core.length)) return core.length
  let n = 0
  for (let i = 0; i < core.length; i++) if (await core.has(i)) n++
  return n
}

/**
 * @param {Uint8Array} key
 * @param {{ identity?: Uint8Array | null, device?: Uint8Array | null, cut?: number | null, refused?: boolean, waiting?: boolean }} opts
 */
function otherLog (key, { identity = null, device = null, cut = null, refused = false, waiting = false }) {
  /** @param {Uint8Array | null} k */
  const z = (k) => (k ? z32.encode(k) : null)
  return { key: z32.encode(key), identity: z(identity), device: z(device), own: false, length: 0, held: 0, indexed: 0, cut, dropped: 0, refused, waiting }
}

/**
 * @param {SpaceChannel} ch
 * @returns {{ identity: string, device: string }}
 */
function peerOf (ch) {
  return { identity: z32.encode(ch.identity), device: z32.encode(ch.peer) }
}

/**
 * @param {Types} types
 * @returns {Record<string, TypeInfo>}
 */
function describeTypes (types) {
  /** @type {Record<string, TypeInfo>} */
  const out = {}
  for (const name of types.names()) {
    const t = types.get(name)
    const editable = t.editable.by === 'permission' ? { permission: t.editable.permission } : t.editable.by
    out[name] = { fields: Object.fromEntries(t.fields.map((f) => [f.name, f.kind])), links: Object.fromEntries(Object.entries(t.links).map(([f, targets]) => [f, [...targets]])), onePerMember: t.onePerMember, editable, index: t.index.map((keys) => [...keys]), builtin: name.startsWith('hg/') }
  }
  return out
}

const OPENING = ['put', 'get', 'edit', 'del', 'since', 'setWriteLimit', 'setHistory', 'count', 'sum', 'members', 'decisions', 'tags',
  'relate', 'unrelate', 'tag', 'untag', 'getRole', 'removeRole', 'setRole', 'defineRole', 'moderateAction', 'report', 'reports',
  'roles', 'createInvite', 'revokeInvite', 'makePublic', 'createSubspace', 'redemptions', 'inspect', 'setBudget', 'setPolicy', 'setRules',
  'setHelpers', 'declareTypes', 'rotateKey', 'renew', 'secure', 'trimHistory', '_bounded']
for (const name of OPENING) {
  const fn = /** @type {any} */ (Space.prototype)[name] // wrapped by name
  // @ts-expect-error methods wrapped by name: the same signature, opened first
  Space.prototype[name] = async function (/** @type {unknown[]} */ ...args) {
    this._use() // first: nothing closes it from here on
    try {
      await this._ready()
      if (this._refusal) throw this._refusal // this app's types break the space's
      return await fn.apply(this, args)
    } finally {
      this._unuse()
    }
  }
}

/**
 * Records changed (a put, an edit, a delete, a hide, reveal or flag, a take-down, content fetched back).
 * Re-read `get`, `query`, `linked`, `count`, `sum`, `tags`, `edges`, `getByTag`.
 * @type {object}
 * @property {string[]} types The distinct types of `records`.
 * @property {Array<{id: string, type: string, deleted: (object|null)}>} records
 * @event Space#change
 */

/**
 * `members()`, `getRole()` or `roles()` may have changed: read them again.
 * @event Space#members
 */

/**
 * `decisions()`, `redemptions()`, `history` or `helpers` may have changed: read them again.
 * @event Space#decisions
 */

/**
 * `status()` changed (policy, access, held, belowPolicy, budget, warnings, settlers or complete).
 * @type {object}
 * @event Space#status
 */

/**
 * Someone connected or left.
 * @type {Array<{identity: (string|null), device: string}>}
 * @event Space#peers
 */

/**
 * A member's log arrived or grew (at most every 100 ms): `inspect()` may differ.
 * @event Space#logs
 */

/**
 * This space was renewed, here or on another device.
 * @type {object}
 * @property {string|null} to The new space's key; null when this person was left out.
 * @event Space#moved
 */

/**
 * A member's connection, for the app's own transfer library: `(stream, { identity, device })`.
 * @event Space#member-connection
 */

/**
 * A peer stopped being a member here, or disconnected: `(stream, { identity, device })`. The stream stays open.
 * @event Space#member-disconnection
 */

module.exports = { Space, BIG, describeTypes }
