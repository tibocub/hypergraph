// A space (contracts/api.md): a community's records, queries and decisions.
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
const { Directory } = require('./directory.js')
const { Replicator, clearBlocks, unheard } = require('./replication.js')
const { Indexer } = require('./index/indexer.js')
const { Query, linkedRows, edgeRows, taggedRows, tagStamp, shape, idOf, keyBytes } = require('./index/query.js')
const { tagKey, droppedName, FLAGS } = require('./index/indexer.js')
const { State, ROLES, ACTIONS, OWN, mayAssign, mayInvite, mayRemove, grantable, rankOf } = require('./decisions/state.js')
const { Identity } = require('./identity.js')
const { PERSONAL } = require('./types.js')
const { HypergraphError } = require('./errors.js')
const storage = require('./storage.js')
const symbols = require('./symbols.js')
const pc = require('./private/crypto.js')
const grants = require('./private/grants.js')
const { Activity, periodOf, PERIOD_MS } = require('./activity.js')
const { isFuture } = require('./stamp.js')
const limits = require('./limit.js')

const hex = (b) => b4a.toString(b, 'hex')
const cutList = c.array(enc.struct([['log', c.fixed32], ['length', c.uint]]))
const removalKey = (identity, device) => hex(identity) + ':' + hex(device)
const CLAIM_MS = 5000 // a claim of this device's writer key is sent again at most this often
const DROP_MIN = 256 // smaller records are never dropped (votes, tags: little to gain, and sums need them)
const REFILL = 64 // dropped records fetched again per pass, when everything fits again
const LOGS_MS = 100 // 'logs' events at most this often
const LINK = 'hg/key-link'
const PLAIN = new Set(['hg/grant', LINK, 'hg/device-remove']) // never sealed in a private space (story 8, A16)
const EMPTY = b4a.alloc(0)
const NONE = new State() // a sub-space its top space's log doesn't name yet: nobody is in
// Story 9 (research.md A14): a newcomer reads a space newest first when a peer
// holds more records than `records`, and reads it by activity lists (not
// opening every log) beyond `logs` logs: the switch-over point. Measured
// (bench/next/first-page.js): each log opened costs a newcomer ~1.5 KB and
// ~1 ms; at 300 logs that is ~0.45 MB, keeping a first page under 1 MB.
// Tests lower them (lib/testing.js bigSpaces).
const BIG = { logs: 300, records: 2000 }

class Space extends EventEmitter {
  // personal: the identity's personal space (research.md A7), encrypted with
  // `encryptionKey`; `keyPair`: its first writer's, when creating it.
  // root: for a sub-space (story 8), the key of the top space whose decision
  // log holds its decisions.
  // fresh: opened here for the first time, joining (story 9: it may read
  // newest first).
  constructor (hg, { key = null, ns, personal = false, encryptionKey = null, keyPair = null, root = null, fresh = false }) {
    super()
    this.setMaxListeners(0)
    this.hg = hg
    this.ns = ns
    this.keyBytes = key
    this.rootKey = root
    this.db = hg.db
    this.types = hg._types
    this.personal = personal
    this.encryptionKey = encryptionKey
    this._keyPair = keyPair
    this._coreOpts = encryptionKey ? { encryption: { key: encryptionKey } } : {}
    this.removals = new Map() // `identity hex:device hex` -> [{ log hex: length }], one per removal
    this._removed = new Map() // `identity hex:device hex` -> the removal ({ identity, device, cut, proof }), for the decision log
    this._asks = new Map() // hex -> encoded decision this device asks a writer to record (research.md A8)
    this._asking = new Set()
    this._claimed = 0
    this.closed = false
    this._redemption = null
    this._redeeming = new Set()
    this._budget = null // its own budget here, or null: a share of the app's
    this._share = null // what it may use here, from the app's last budget pass
    this._statusSig = ''
    this._fresh = fresh && !personal
    this._undecided = false // a newcomer that hasn't chosen how to read yet (story 9)
    this._reading = { horizon: null, byActivity: false } // horizon: the first period read (null: everything)
    this._act = new Map() // log hex -> Map(period -> start): entries at or after the horizon
    this._indexed = 0 // index changes so far
    this._protocols = new Map() // name -> handlers: apps' own protocols (addProtocol)
  }

  get key () { return z32.encode(this.keyBytes) }
  get hex () { return hex(this.keyBytes) }
  get name () { return this.personal ? '' : (this.state.name || '') }
  // The space this one is a sub-space of (z32), or null.
  get parent () {
    if (!this.rootKey) return null
    const up = this.state.parent
    return z32.encode(up ? b4a.from(up, 'hex') : this.rootKey)
  }

  // Is its content readable only with its keys (story 8)?
  get private () { return !!this.state.private }
  get discoveryKey () { return this.rootKey ? this._discoveryKey : this.decisionLog.discoveryKey }
  // The key of the decision log holding this space's decisions: its own, or
  // its top space's for a sub-space.
  get top () { return this.rootKey || this.keyBytes }

  // The decisions as they count here: a sub-space's effective state (lib/
  // decisions/state.js), empty until its top space's log says it exists.
  get state () {
    const st = this.decisionLog.state
    return this.rootKey ? (st.sub(this.keyBytes) || NONE) : st
  }

  async _open ({ create = null } = {}) {
    const hg = this.hg
    this.store = hg.store.namespace(this.ns)
    if (this.rootKey) {
      this._discoveryKey = crypto.discoveryKey(this.keyBytes)
      this.decisionLog = await hg._decisions(this.rootKey)
    } else {
      const make = () => new Decisions(this.store, this.keyBytes, { identity: hg._identity, wakeup: hg._network.wakeup, keyPair: this._keyPair, encryptionKey: this.encryptionKey, now: () => hg._now() })
      if (this.personal || !this.keyBytes) {
        this.decisionLog = make()
        await this.decisionLog.ready()
        if (create) await this.decisionLog.init(create)
        if (!this.personal) hg._shareDecisions(this.decisionLog.key, this.decisionLog)
      } else {
        this.decisionLog = await hg._decisions(this.keyBytes, make) // a guest of a sub-space may have opened it
      }
      this._keyPair = null
      this.keyBytes = this.decisionLog.key
    }

    const me = hg._identity.publicKey
    const space = this
    // What the directory, indexer and replicator see of this space.
    const ctx = this._ctx = {
      db: hg.db,
      queue: hg._queue,
      get directory () { return space.directory },
      get byActivity () { return space._reading.byActivity },
      get listDelay () { return hg[symbols.slowLists] || 0 },
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
      types: this.types,
      rules: hg.rules,
      store: this.store,
      me,
      personal: this.personal,
      stamper: hg._stamper,
      get state () { return ctxState() },
      getCore: (key) => this.store.get({ key, ...this._coreOpts }),
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
        this.#logsChanged()
      },
      logOf: (key) => this.directory.logs.get(hex(key)) || null,
      cut: (log, limit) => this.#cut(log, limit).catch(safetyCatch),
      changed: (types) => this.#changed(types),
      clear: (id, opts) => this.#clear(id, opts),
      progress: () => this.emit('_progress'),
      proof: hg._identity.proof, // sent to peers on the space channel (hello)
      peersChanged: () => { if (!this.closed) this.emit('peers', this.peers()) },
      redeem: (bytes) => this.#redeem(bytes),
      ask: (bytes) => this.#onAsk(bytes),
      channelOpened: (ch) => {
        if (this._redemption && !this.state.isMember(me)) ch.messages[5].send({ redemption: this._redemption })
        for (const bytes of this._asks.values()) ch.messages[6].send({ decision: bytes })
        for (const name of this._protocols.keys()) this.#openProtocol(ch, name)
      }
    }
    const ctxState = () => this.state
    this.own = await this.#openOwnLog()
    this._idcore = this.store.get({ name: 'identity-log', ...this._coreOpts })
    await this._idcore.ready()
    await this.#loadReading()
    this.activity = ctx.activity = new Activity(ctx)
    this.directory = new Directory(ctx)
    this.indexer = ctx.indexer = new Indexer(ctx, hg._queue)
    this.replicator = new Replicator(ctx)

    const removals = { gte: { space: this.keyBytes, type: 'hg/device-remove' }, lte: { space: this.keyBytes, type: 'hg/device-remove' } }
    for (const row of await this.db.find('@hg/by-type', removals).toArray()) this.#removed(this.types.decode(row.type, row.fields, row.links), row.author, false)
    const rows = await this.db.find('@hg/logs', { gte: { space: this.keyBytes }, lte: { space: this.keyBytes } }).toArray()
    for (const row of rows) {
      if (row.refused) continue
      const mine = b4a.equals(row.log, this.own.key) ? this.own.core : b4a.equals(row.log, this._idcore.key) ? this._idcore : null
      const core = mine || this.store.get({ key: row.log, ...this._coreOpts })
      const cut = row.cut || null // the index stores "none" as 0; a kept log's cut is at least 2
      const dropped = await this.db.get('@hg/meta', { name: droppedName(this.keyBytes, row.log) })
      const counters = dropped ? JSON.parse(b4a.toString(dropped.value)) : {}
      const from = mine || counters.from === undefined ? 1 : counters.from // story 9: where reading it starts
      const header = await core.get(0, { wait: false }).catch(() => null)
      const log = await this.directory.accept(row.log, core, row, { indexed: row.indexed, own: !!mine, announce: false, limit: cut ?? Infinity, cut, from, act: counters.act || null, admitted: header ? admittedOf(header) : null })
      if (log && dropped) { // content dropped from it here (story 6), its index entries' bytes
        const { bytes, blocks, ix = 0 } = counters
        log.dropped = bytes
        log.droppedBlocks = blocks
        log.ixBytes = ix
      }
    }
    if (hg._rebuilding) await this.#rediscover()
    await this.#seenOwn()
    this._budget = await hg._loadBudget(this)
    this._onchange = () => { this._decided = this.#onDecisions().catch(safetyCatch) }
    this.decisionLog.on('change', this._onchange)
    await this.#onDecisions()
  }

  // The index was lost (FR-012, research.md A10): the logs this device had
  // accepted here, named in the instance's logs file, are checked by the gate
  // again from their held headers and indexed from their start.
  async #rediscover () {
    const me = this.hg._identity
    for (const key of this.hg._knownLogs(this)) {
      if (this.directory.logs.has(hex(key))) continue
      if (b4a.equals(key, this._idcore.key)) {
        await this.directory.accept(key, this._idcore, { identity: me.publicKey, device: me.publicKey }, { own: true, announce: false })
      } else if (!b4a.equals(key, this.own.key)) { // this device's own log is accepted with the decisions
        await this.directory.consider(key)
      }
    }
  }

  // This device's log in the space: the first one not cut. A member removed
  // and let in again writes in a new log: the old one counts up to its cut
  // only, for good (research.md A4).
  async #openOwnLog (from = 0) {
    const me = this.hg._identity
    for (let n = from; ; n++) {
      const own = new OwnLog(this.store.get({ name: n ? `log/${n}` : 'log', ...this._coreOpts }), { space: this.keyBytes, identity: me, decisions: this.top, admitted: () => this.state.admission(me.publicKey) })
      await own.ready()
      own.generation = n
      if (!this.state.isCut(me.publicKey, own.key) && !this.state.isEditCut(me.publicKey, own.key) && !this.#unadmitted(own)) return own
      await own.core.close()
    }
  }

  // Cut (removed, banned, or an edit permission taken away) and let back
  // in: this device writes in a new log (research.md A4, A9). Before any
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

  // Was this device's log made before it was let back in (story 9)? Then
  // nobody counts it: it writes in a new one.
  #unadmitted (own) {
    const me = this.hg._identity.publicKey
    return this.state.mustAdmit(me, own.key) && own.admitted !== this.state.admission(me)
  }

  async #onDecisions () {
    if (this.closed) return
    const me = this.hg._identity
    await this.#ownUncut()
    if (this.state.isMember(me.publicKey) && !this.directory.logs.has(hex(this.own.key))) {
      await this.directory.accept(this.own.key, this.own.core, { identity: me.publicKey, device: me.device.publicKey }, { own: true, admitted: this.own.admitted })
    }
    this.directory.recheck()
    this.activity.channelOpened() // a peer may be a member now: asked for activity lists
    await this.indexer.moderate()
    await this.indexer.reauthorize()
    await this.#limitChanged()
    this.#claim()
    this.#keysLater()
    await this.#recordRemovals()
    this.emit('_progress')
    this.emit('_decided')
    this._statusChanged()
    this.hg._holdLater()
    if (!this.personal) this.hg._openSubspaces().catch(safetyCatch) // members have its sub-spaces (story 8)
  }

  // --- decision rights follow devices (research.md A8) ---

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

  // Asks every peer to record a decision this device can't write itself.
  #ask (decision) {
    const bytes = c.encode(enc.decision, { stamp: Date.now(), ...decision })
    this._asks.set(hex(crypto.hash(bytes)), bytes)
    this.directory.sendAsk(bytes)
  }

  // Is an asked decision applied (or moot) already?
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
      const decision = { type: 'device/remove', device: r.device, cut: r.cut, proof: r.proof }
      if (writer) await this.#append(h, decision).catch(safetyCatch)
      else if (b4a.equals(r.identity, me) && !this._asking.has(h)) {
        this._asking.add(h)
        this.#ask(decision)
      }
    }
  }

  // Appends a decision once at a time per tag.
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

  // "Newest own seen" (research R7, A7): the last record of each of this
  // identity's logs held here, so stamps stay above them after a restart
  // even if this device's clock was ahead then.
  async #seenOwn () {
    const me = this.hg._identity.publicKey
    for (const log of this.directory.logs.values()) {
      if (!b4a.equals(log.identity, me) || log.core.length < 2) continue
      const bytes = await log.core.get(log.core.length - 1, { wait: false }).catch(() => null)
      if (!bytes) continue
      try { this.hg._stamper.seen(enc.decodeRecord(bytes).stamp) } catch {}
    }
  }

  // --- devices (research.md A7) ---

  // How much of a log counts: the decisions' limit (lib/decisions/state.js)
  // and, for a removed device, the lowest of its removals' cuts (a log a
  // removal doesn't name counts for nothing). Removals only ever lower it.
  // Only the identity a device belongs to removes it.
  // `admitted`: the admission code the log's header carries (story 9): a
  // log of someone cut before that no cut names counts only with the code of
  // the decision that let them back in.
  limitOf (identity, device, log, admitted = null) {
    let limit = this.state.limitOf(identity, log)
    const identityLog = device && b4a.equals(device, identity) // device removals: never cut
    if (limit > 1 && !identityLog && this.state.mustAdmit(identity, log) && admitted !== this.state.admission(identity)) limit = 0
    const removals = device && this.removals.get(removalKey(identity, device))
    if (!removals) return limit
    let cut = limit
    for (const r of removals) cut = Math.min(cut, r[hex(log)] ?? 0)
    return cut
  }

  isRemoved (identity, device) {
    return !!device && this.removals.has(removalKey(identity, device))
  }

  // Is this record allowed where it is? Hypergraph's own types have their
  // places: an identity log holds signed removals only, removals are only
  // there, and the personal space's own records only in it.
  #allowed (log, record, values) {
    const identityLog = b4a.equals(log.device, log.identity)
    if (identityLog || record.type === 'hg/device-remove') {
      return identityLog && record.type === 'hg/device-remove' && record.kind === enc.PUT && this.#validRemoval(log, values)
    }
    return !PERSONAL.has(record.type) || this.personal
  }

  #validRemoval (log, values) {
    const { removed: device, cut, proof } = values || {}
    if (!device || device.byteLength !== 32 || b4a.equals(device, log.identity) || !cut || !proof) return false
    try { c.decode(cutList, cut) } catch { return false }
    const info = Identity.verify(proof, removalSignable(this.keyBytes, device, cut))
    return !!info && b4a.equals(info.identity, log.identity) && b4a.equals(info.device, log.identity)
  }

  // A removal by `identity` was indexed: that identity's device's logs count
  // up to its cut.
  #removed ({ removed: device, cut, proof }, identity, recheck = true) {
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
  async _removeDevice (device, secrets, heads = {}) {
    if (this.closed || this.isRemoved(this.hg._identity.publicKey, device)) return
    const lengths = { ...heads }
    for (const log of this.directory.logs.values()) {
      if (!b4a.equals(log.device, device) || !b4a.equals(log.identity, this.hg._identity.publicKey)) continue
      const held = Math.min(log.indexed, log.limit)
      lengths[hex(log.key)] = Math.max(held, lengths[hex(log.key)] || 0)
    }
    const cut = c.encode(cutList, Object.entries(lengths).map(([log, length]) => ({ log: b4a.from(log, 'hex'), length })))
    const proof = Identity.attestAsIdentity(removalSignable(this.keyBytes, device, cut), secrets.keyPair)
    const log = await this.#identityLog(secrets)
    const { fields, links } = this.types.encode('hg/device-remove', { removed: device, cut, proof })
    await log.append({ kind: enc.PUT, type: 'hg/device-remove', stamp: this.hg._stamper.next(), target: null, links, fields })
    await this.indexer.index(this.directory.logs.get(hex(log.key)))
  }

  // This device's identity log here: its header is signed by the identity
  // key itself (research.md A7).
  async #identityLog (secrets) {
    const me = this.hg._identity
    const log = new OwnLog(this._idcore, { space: this.keyBytes, identity: me, decisions: this.top, attest: (data) => Identity.attestAsIdentity(data, secrets.keyPair) })
    await log.ready()
    if (!this.directory.logs.has(hex(log.key))) {
      await this.directory.accept(log.key, log.core, { identity: me.publicKey, device: me.publicKey }, { own: true })
    }
    return log
  }

  // This device's log lengths here (its heads): [{ log, length }].
  _heads () {
    const me = this.hg._identity.device.publicKey
    const out = []
    for (const log of this.directory.logs.values()) if (b4a.equals(log.device, me)) out.push({ log: log.key, length: log.core.length })
    return out
  }

  // --- records ---

  async put (type, values) {
    if (typeof type === 'string' && type.startsWith('hg/')) throw new HypergraphError('INVALID_TYPE', `"${type}" is hypergraph's own type`)
    return this._put(type, values)
  }

  // put(), hypergraph's own types included. `replaces`: the stamp of the
  // version this one replaces (a relation, a tag), to be stamped above it.
  async _put (type, values, replaces = 0) {
    await this.#mayPost()
    const v = this.types.validate(type, values)
    await this.#checkLinks(type, v)
    this.#checkRules(type, v)
    const { fields, links } = this.types.encode(type, v)
    replaces = Math.max(replaces, await this.#linkedStamp(links))
    const seq = await this.#write({ kind: enc.PUT, type, stamp: this.hg._stamper.next({ replaces }), target: null, links, fields })
    return this.#written(seq)
  }

  async get (id, { timeout } = {}) {
    const key = idOf(id)
    const { record, complete } = await this._bounded(async (deadline) => {
      const row = await this.db.get('@hg/records', { space: this.keyBytes, id: key })
      if (!row) return { record: null, need: this.#needOf(key) }
      const { items, partial } = await this._shaped([row], deadline)
      return { record: items[0] || null, partial, need: row.stamp }
    }, timeout)
    return { record, complete }
  }

  // Changes some fields; the others stay. The record keeps its id.
  async edit (id, changes) {
    let row = await this.#changeable(id, 'edit')
    if (row.flags & FLAGS.DROPPED) { // its content was dropped here: fetched first (story 6)
      row = await this.#content(row, Date.now() + this.hg.readTimeout)
      if (!row) throw new HypergraphError('NOT_FOUND', 'This record\'s content is no longer held here and no member holding it answered: try again later')
    }
    const current = this.types.decode(row.type, row.fields, row.links)
    // A field passed as undefined is left as it was.
    const given = Object.fromEntries(Object.entries(changes || {}).filter(([, value]) => value !== undefined))
    const v = this.types.validate(row.type, { ...current, ...given })
    await this.#checkLinks(row.type, v)
    this.#checkRules(row.type, v, row.id)
    // Fields a newer app version added stay as they are (story 7).
    const { fields, links } = this.types.encode(row.type, v, { fields: row.fields, links: row.links || [] })
    const replaces = Math.max(row.vstamp, await this.#linkedStamp(links))
    await this.#write({ kind: enc.EDIT, type: row.type, stamp: this.hg._stamper.next({ replaces }), target: row.id, links, fields })
    await this.indexer.index(this.#ownLog())
    return (await this.get(row.id, { timeout: 0 })).record
  }

  // Deletes a record: its author's delete; a moderator who isn't its author
  // takes it down instead (a decision, research.md A9). Other editors of a
  // shared type can't delete it (Tibo, 2026-10-09): they edit it.
  async del (id) {
    const row = await this.#changeable(id, 'delete', () => this.state.can(this.hg._identity.publicKey, 'moderate'))
    if (!b4a.equals(row.author, this.hg._identity.publicKey)) return this.moderateAction('remove', row.id)
    await this.#write({ kind: enc.DELETE, type: row.type, stamp: this.hg._stamper.next({ replaces: row.vstamp }), target: row.id, links: [], fields: b4a.alloc(0) })
    await this.indexer.index(this.#ownLog())
  }

  // The row of a record this member may change; `also`: another way it may
  // (a moderator's delete).
  async #changeable (id, what, also = () => false) {
    await this.#mayPost()
    const row = await this.#row(id)
    if (row.type.startsWith('hg/')) throw new HypergraphError('NOT_ALLOWED', `A ${row.type} is hypergraph's own record`)
    const kind = what === 'delete' ? enc.DELETE : enc.EDIT
    await this.#unless(() => {
      if (gate.mayChange(this.types, { kind, type: row.type, author: this.hg._identity.publicKey, id: null }, row, this.state) || also()) return null
      const editable = this.types.get(row.type).editable
      if (kind === enc.DELETE) return `Only its author${editable.by === 'author' ? '' : ' or a moderator'} deletes this ${row.type}${editable.by === 'author' ? '' : ' (its editors edit it)'}`
      if (editable.by === 'permission') return `You may not edit this ${row.type}: it needs the permission "${editable.permission}" (your role is ${this.#myRole()})`
      return `You may not edit this ${row.type}: only its author`
    })
    return row
  }

  async #row (id) {
    const row = await this.db.get('@hg/records', { space: this.keyBytes, id: idOf(id) })
    if (!row) throw new HypergraphError('NOT_FOUND', `No record ${typeof id === 'string' ? id : id.id} here`)
    return row
  }

  async #mayPost () {
    if (this.closed) throw new HypergraphError('CLOSED', 'This space is closed')
    if (this.isRemoved(this.hg._identity.publicKey, this.hg._identity.device.publicKey)) throw new HypergraphError('DEVICE_REMOVED', 'This device was removed from the account: what it writes is ignored')
    await this.#unless(() => {
      const me = this.hg._identity.publicKey
      if (this.state.canWrite(me)) return null
      if (this.state.can(me, 'post')) return `Only some roles write here (${this.state.writeRoles.join(', ')}, and the owner and admins): yours is ${this.#myRole()}`
      return this.#whyNot('write in it')
    })
  }

  // This device's log to write in now, once every check passed.
  async #log () {
    await this.#ownUncut()
    const me = this.hg._identity
    if (!this.directory.logs.has(hex(this.own.key))) await this.directory.accept(this.own.key, this.own.core, { identity: me.publicKey, device: me.device.publicKey }, { own: true, admitted: this.own.admitted })
    return this.own
  }

  // Writes a record in this device's log: sealed with the current epoch's key
  // in a private space (story 8).
  async #write (record) {
    const log = await this.#log()
    await this.#withinLimit(log, record)
    return log.append(record, await this.#sealer(record, log))
  }

  // --- the write limit of an open space (story 9, T071a; lib/limit.js) ---

  // The limit `log`'s records are judged by: the space's, except in the
  // personal space and for identity logs (device removals).
  #limitFor (log) {
    if (this.personal || b4a.equals(log.device, log.identity)) return null
    return this.state.writeLimit
  }

  // Refuses a record no member would count: beyond the limit.
  async #withinLimit (own, record) {
    const limit = this.state.writeLimit
    if (!limit || this.personal || PLAIN.has(record.type) || record.kind === enc.DELETE) return
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

  // At most `records` records per `periodMs` from each device; null lifts
  // it. For open spaces (a public invite link). Who may decide.
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

  // --- private spaces (story 8, research.md A13; spec 008's design) ---
  // Content is sealed with an epoch key; each key reaches the devices of the
  // members entitled to read in `hg/grant` records (lib/private/grants.js),
  // written by whoever holds it. When someone loses access, a key holder who
  // may decide or moderate changes the key (`key/rotate`) and grants the new
  // one to who is left. Keys live in memory only (#epochKeys), re-opened from
  // the grants in the index after a restart; never logged or shown.
  // A16: each key unlocks the ones before it (`hg/key-link` records: an older
  // key sealed with a newer one), so a newcomer reads the whole history,
  // unless the space hides it (`history: 'hidden'`): then no link is written
  // nor followed, a newcomer's arrival changes the key, and records sealed
  // before the first key this device got don't count as missing here.

  #epochKeys = new Map() // commitment, short form (hex) -> key
  #epochOf = new Map() // commitment, short form (hex) -> its epoch
  #granting = new Set() // `${device z32}:${commitment hex}`: grants this device wrote, indexed or not yet
  #box = null // this device's box key pair

  get history () { return this.state.history }

  // Who reads a private space's history: 'visible' (every member, the
  // default) or 'hidden' (each member from its join on). Who may decide.
  async setHistory (history) {
    if (history !== 'visible' && history !== 'hidden') throw new TypeError('History is \'visible\' or \'hidden\'')
    if (!this.state.private) throw new HypergraphError('NOT_ALLOWED', 'Only a private space has a history to hide: anyone holding a closed space\'s key reads it')
    await this.#mayDecide('decide', 'set who reads the history')
    await this.#decide({ type: 'settings/set', policy: null, writeLimit: null, rules: null, history })
  }

  #keep (short, key, epoch) {
    this.#epochKeys.set(short, key)
    this.#epochOf.set(short, epoch)
  }

  // A history hidden from this device: sealed before the first key it got.
  #hidden (epoch) {
    return this.state.history === 'hidden' && this.#epochOf.size > 0 && epoch < Math.min(...this.#epochOf.values())
  }

  // The current epoch's key, if held here.
  #current () {
    const keys = this.state.keys
    const commit = keys && keys.commits[keys.current]
    return commit ? this.#epochKeys.get(commit.slice(0, 16)) || null : null
  }

  // How `record` is written here: null, or seal(seq, record) with the current
  // epoch's key (waiting for it within the read bound).
  async #sealer (record, log) {
    if (!this.state.private || PLAIN.has(record.type) || record.kind === enc.DELETE) return null
    const deadline = Date.now() + this.hg.readTimeout
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
    const epoch = keys.current
    return (seq, r) => ({ ...r, links: [], fields: pc.sealRecord(key, epoch, pc.recordAD(this.keyBytes, log.key, seq, epoch), r), sealed: true })
  }

  // Is this block a sealed record whose epoch key isn't held here?
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
  #unseal (log, seq, record) {
    const plain = PLAIN.has(record.type) || record.kind === enc.DELETE
    if (!this.state.private || plain) return record.sealed ? false : record
    if (!record.sealed) return record.kind === enc.PUT ? { ...record, fields: EMPTY, links: [], unreadable: true } : false
    const info = pc.sealedWith(record.fields)
    if (!info) return false
    const { epoch } = info
    const key = this.#epochKeys.get(info.commit)
    if (!key) return this.#hidden(epoch) ? false : null
    const open = pc.openRecord(key, pc.recordAD(this.keyBytes, log.key, seq, epoch), record.fields)
    return open ? { ...record, fields: open.fields, links: open.links, sealed: false } : false
  }

  // A record read from a log, as it counts here (opened if sealed), or null.
  _unsealed (log, seq, bytes) {
    let r = null
    try { r = enc.decodeRecord(bytes) } catch { return null }
    return this.#unseal(log, seq, r) || null
  }

  // The first key of a private space this device just created.
  async _startKeys () {
    if (this.state.private && !this.state.keys) await this.#rotate()
  }

  // Key work, one run at a time (a call during one runs another after it).
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
  // both sides at once would race again; A16: a race's keys are linked from
  // the next epoch only, never from each other: a member removed on one side
  // of a partition may hold the other side's key). null: no.
  #change (keys, granted, entitled) {
    if ([...granted].some((d) => !entitled.has(d))) return 'now'
    if (this.state.history === 'hidden' && [...entitled.keys()].some((z) => !granted.has(z))) return 'soon'
    const lost = Object.entries(keys.others || {}).some(([commit, epoch]) => epoch === keys.current && this.#epochKeys.has(commit.slice(0, 16)))
    return lost ? 'soon' : null
  }

  async #changeNow (keys) {
    const { granted, entitled } = await this.#grantState()
    return this.#change(keys, granted, entitled)
  }

  // One rotation at a time from this device.
  #rotateOnce () {
    if (!this._rotating) this._rotating = this.#rotate().catch(safetyCatch).finally(() => { this._rotating = null })
    return this._rotating
  }

  // The keys granted to this device that match the decision log's
  // commitments; a new one lets the records waiting for it be indexed.
  async #refreshKeys () {
    const keys = this.state.keys
    if (!keys || this.closed) return
    if (!this.#box) this.#box = pc.boxKeyPair(this.hg._identity.device)
    const range = { space: this.keyBytes, type: grants.TYPE, ix: grants.grantIx(this.hg._identity.device.publicKey) }
    let learnt = false
    for (const row of await this.db.find('@hg/by-ix', { gte: range, lte: range }).toArray()) {
      let v = null
      try { v = this.types.decode(grants.TYPE, row.fields, row.links) } catch { continue }
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

  // The key links in this space: [{ from, to (short, hex), epoch, values }].
  async #links () {
    const range = { space: this.keyBytes, type: LINK }
    const out = []
    for (const row of await this.db.find('@hg/by-type', { gte: range, lte: range }).toArray()) {
      let v = null
      try { v = this.types.decode(LINK, row.fields, row.links) } catch { continue }
      if (b4a.isBuffer(v.from) && b4a.isBuffer(v.to) && v.to.byteLength === 32 && Number.isSafeInteger(v.epoch)) out.push({ from: pc.shortCommit(v.from), to: pc.shortCommit(v.to), epoch: v.epoch, values: v })
    }
    return out
  }

  // Opens the older keys the held ones unlock (a key counts only if the
  // decision log recorded its commitment). True if one was learnt.
  async #followLinks (keys) {
    const links = await this.#links()
    let learnt = false
    for (let more = true; more;) {
      more = false
      for (const { from, to, epoch, values } of links) {
        const by = this.#epochKeys.get(from)
        if (!by || this.#epochKeys.has(to) || !(this.#epochOf.get(from) > epoch) || !grants.known(keys, epoch, b4a.toString(values.to, 'hex'))) continue // from a later epoch only
        const key = pc.openKey(by, values.sealed, pc.linkAD(this.keyBytes, values.to))
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

  // { granted: device z32s holding the current key, entitled: device z32 ->
  // { device, identity }, for the devices of the members who may read now (this one included
  // once a member) }.
  async #grantState () {
    const keys = this.state.keys
    const granted = new Set()
    const range = { space: this.keyBytes, type: grants.TYPE }
    for (const row of await this.db.find('@hg/by-type', { gte: range, lte: range }).toArray()) {
      let v = null
      try { v = this.types.decode(grants.TYPE, row.fields, row.links) } catch { continue }
      if (grants.current(v, keys)) granted.add(v.to)
    }
    const now = keys && keys.commits[keys.current]
    for (const g of this.#granting) if (g.endsWith(':' + now)) granted.add(g.slice(0, g.indexOf(':')))
    const entitled = new Map()
    const me = this.hg._identity
    if (this.state.isMember(me.publicKey)) entitled.set(z32.encode(me.device.publicKey), { device: me.device.publicKey, identity: me.publicKey })
    for (const log of this.directory.logs.values()) {
      if (b4a.equals(log.device, log.identity) || !this.#mayRead(log)) continue
      entitled.set(z32.encode(log.device), { device: log.device, identity: log.identity })
    }
    return { granted, entitled }
  }

  #mayRead ({ identity, device }) {
    return this.state.isMember(identity) && !this.isRemoved(identity, device)
  }

  // Judged again at the moment of granting: the decisions may have changed
  // since the list was made (a partition healing removed someone, and the
  // current key is a new one: A16).
  async #grant (to) {
    if (!this.#mayRead(to)) return
    const { device } = to
    const keys = this.state.keys
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
    this.#keysLater() // a link to the key before it (A16)
    return true
  }

  // Tests only (lib/testing.js epochKeys).
  [symbols.epochKeys] () {
    return [...this.#epochKeys.values()]
  }

  // Refusals that depend on the decisions: first catch up with the connected
  // members who record decisions (within the read bound), then judge again,
  // so a decision made a moment ago elsewhere isn't missed (ROADMAP
  // 2026-10-09). `refusal()` gives the reason, or null.
  async #unless (refusal, code = 'NOT_ALLOWED') {
    if (!refusal()) return
    await this.decisionLog.catchUp(this.hg.readTimeout)
    const why = refusal()
    if (why) throw new HypergraphError(code, why)
  }

  // Why this member may not do `what`: banned, not a member, or its role.
  #whyNot (what) {
    const me = this.hg._identity.publicKey
    if (this.state.isBanned(me)) return `You are banned from this space: you may not ${what}`
    const role = this.#myRole()
    if (!role) return `You are not a member of this space: you may not ${what}`
    return `Your role is ${role}: it does not allow you to ${what}`
  }

  // The newest stamp among the records `links` point at, held here (story 9):
  // a record is stamped above what it links to, so whoever holds a record's
  // period on holds what points at it. A target stamped far ahead of this
  // clock doesn't drag this identity's stamps into the future.
  async #linkedStamp (links) {
    let top = 0
    for (const l of links) {
      if (l.byteLength < 33) continue // a space, not a record
      const row = await this.db.get('@hg/records', { space: this.keyBytes, id: l })
      if (row && row.stamp > top && !isFuture(row.stamp)) top = row.stamp
    }
    return top
  }

  async #checkLinks (type, values) {
    const typeOf = async (target) => {
      const row = await this.db.get('@hg/records', { space: this.keyBytes, id: idOf(target) })
      return row ? row.type : null
    }
    if (!(await gate.linksAllowed(this.types, type, values, typeOf))) {
      throw new HypergraphError('INVALID_RECORD', `A ${type} cannot link to that type of record`)
    }
  }

  // The app's rules, as every member will check them.
  #checkRules (type, values, id = null) {
    if (!this.hg.rules.length || type.startsWith('hg/')) return
    const me = this.hg._identity
    const record = { ...values, id: id ? enc.idToString(id) : null, type, author: z32.encode(me.publicKey), device: z32.encode(me.device.publicKey), stamp: Date.now() }
    const broken = gate.brokenRule(this.hg.rules, record, { space: this.key })
    if (broken) throw new HypergraphError('RULE_REJECTED', `This ${type} breaks the app's rule "${broken}": no member would keep it`)
  }

  #ownLog () {
    return this.directory.logs.get(hex(this.own.key))
  }

  async #written (seq) {
    await this.indexer.index(this.#ownLog())
    const id = enc.idBytes({ log: this.own.key, seq })
    const row = await this.db.get('@hg/records', { space: this.keyBytes, id })
    if (!row) throw new HypergraphError('INVALID_RECORD', 'The record was written but refused by its own checks')
    return shape(this.types, row)
  }

  // --- reads ---

  query (type) {
    this.types.get(type)
    return new Query(this, type)
  }

  // What points at `target`, oldest first.
  linked (target, type = null, { timeout } = {}) {
    return this._bounded(async (deadline) => {
      const { rows, partial } = await this.#pointingAt(target, type, deadline)
      const shaped = await this._shaped(rows, deadline)
      return { items: shaped.items, partial: partial || shaped.partial, need: await this.#stampOf(target) }
    }, timeout)
  }

  // Counts rows: content dropped here matters only to judge a link (A12).
  async count (type, { on, timeout } = {}) {
    const { n, complete } = await this._bounded(async (deadline) => {
      const { rows, partial } = await this.#pointingAt(on, type, deadline)
      return { n: rows.length, partial, need: await this.#stampOf(on) }
    }, timeout)
    return { value: n, complete }
  }

  // The rows pointing at `target` through a link that counts: { rows,
  // partial } (partial: a dropped record's content, needed to judge its
  // link, couldn't be fetched in time).
  async #pointingAt (target, type, deadline) {
    const rows = await linkedRows(this, target, type)
    const typeOf = this._typeOf()
    const out = []
    let partial = false
    for (const row of rows) {
      const { ok, row: r } = await this._linkCounts(row, idOf(target), typeOf, deadline)
      if (ok === null) partial = true
      else if (ok) out.push(r)
    }
    return { rows: out, partial }
  }

  // Link targets are judged when read (research.md A12): a link counts unless
  // its target is held here with a type the link field doesn't allow. The
  // type of a record never changes, and a target that isn't held (not arrived
  // yet; deleted, taken down or cut: gone on every member) counts as written,
  // so every member judges alike whatever the order of arrival.
  // `typeOf(id)`: the held record's type or null, cached for one read.
  _typeOf () {
    const cache = new Map()
    return (id) => {
      const bytes = idOf(id)
      const h = hex(bytes)
      if (!cache.has(h)) cache.set(h, this.db.get('@hg/records', { space: this.keyBytes, id: bytes }).then((r) => (r ? r.type : null)))
      return cache.get(h)
    }
  }

  // Does `row` point at `target` (id bytes) through a link that counts?
  // { ok: true | false | null (couldn't tell: content dropped, not fetched
  // by `deadline`), row (with its content, if it had to be fetched) }.
  async _linkCounts (row, target, typeOf, deadline) {
    const targetType = await typeOf(target)
    const decode = (r) => {
      try { return this.types.has(r.type) ? this.types.decode(r.type, r.fields || b4a.alloc(0), r.links || []) : null } catch { return null }
    }
    const id = enc.idToString(target)
    const dropped = !!(row.flags & FLAGS.DROPPED)
    let ok = gate.linkCounts(this.types, row.type, dropped ? null : decode(row), id, targetType)
    if (ok !== null) return { ok, row }
    const full = await this.#content(row, deadline)
    if (!full) return { ok: null, row }
    ok = gate.linkCounts(this.types, full.type, decode(full), id, targetType)
    return { ok, row: full }
  }

  // The sum of `field` over the records of `type` pointing at `on`; for
  // one-per-member types, each member's latest only.
  async sum (type, field, { on, timeout } = {}) {
    const { items, complete } = await this.linked(on, type, { timeout })
    return { value: items.reduce((s, r) => s + (Number(r[field]) || 0), 0), complete }
  }

  // --- who and what (core follow-ups: the reads the inspector asked for) ---

  // The people of this space as this member knows them: [{ identity, role,
  // you, banned, removed, devices: [{ device, log }] }], members highest role
  // first, then banned and removed people (role null). `devices`: the device
  // logs of theirs held here.
  async members () {
    const state = this.state
    const me = hex(this.hg._identity.publicKey)
    const people = new Map()
    const person = (h) => {
      if (!people.has(h)) people.set(h, { identity: z32.encode(b4a.from(h, 'hex')), role: state.roleOf(h), you: h === me, banned: state.isBanned(h), removed: false, devices: [] })
      return people.get(h)
    }
    for (const h of state.members.keys()) person(h)
    for (const h of state.banned.keys()) person(h)
    for (const h of state.cuts.keys()) if (!state.isMember(h)) person(h).removed = !state.isBanned(h)
    for (const log of this.directory.logs.values()) {
      if (b4a.equals(log.device, log.identity)) continue // an identity log: removals, not a device
      const p = people.get(hex(log.identity))
      if (p) p.devices.push({ device: z32.encode(log.device), log: z32.encode(log.key) })
    }
    const rank = (p) => (p.role ? rankOf(p.role) : 0)
    return [...people.values()].sort((a, b) => rank(b) - rank(a) || (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0))
  }

  // What was decided here, newest first: { items: [{ seq, type, by, device,
  // at, counted, ... }], complete }: who decided (identity and device of the
  // writer key then, null if it spoke for nobody), when (their stamp), what
  // and why (identity, role, action, target, reason, name, permissions,
  // policy, rules...), and whether it counted (a decision its author wasn't
  // allowed to make is listed, and changed nothing). `after`: the last item
  // of the previous page.
  async decisions ({ limit = 50, after = null } = {}) {
    if (this.closed) throw new HypergraphError('CLOSED', 'This space is closed')
    const before = after === null ? Infinity : (typeof after === 'number' ? after : after.seq)
    const raw = await this.decisionLog.list({ limit, before, scope: this.rootKey ? this.hex : null })
    const z = (h) => (h ? z32.encode(b4a.from(h, 'hex')) : null)
    const items = raw.map(({ writer, space, ...d }) => {
      const out = { ...d, by: z(d.by), device: z(d.device) }
      for (const k of ['identity', 'key', 'removed', 'maker', 'invite']) if (out[k]) out[k] = z(out[k])
      if (out.target) out.target = out.action === 'ban' || out.action === 'unban' ? z(out.target) : enc.idToString(b4a.from(out.target, 'hex'))
      return out
    })
    return { items, complete: this.isComplete() }
  }

  // A record's tags, sorted: { items: ['rust', ...], complete } (none if it
  // isn't held here).
  async tags (record, { timeout } = {}) {
    return this._bounded(async () => {
      const row = await this.db.get('@hg/records', { space: this.keyBytes, id: idOf(record) })
      const prefix = tagKey('')
      return { items: row ? (row.ix || []).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort() : [], need: row ? row.stamp : this.#needOf(idOf(record)) }
    }, timeout)
  }

  // The peers connected on this space: [{ identity, device }] (identity null
  // for a moment, until the peer's device proof arrives).
  peers () {
    const z = (k) => (k ? z32.encode(k) : null)
    return this.directory.peerList().map((p) => ({ identity: z(p.identity), device: z(p.device) }))
  }

  // --- apps' own protocols (FR-031: SwarmFS's transfers) ---

  // A Protomux channel `name` on this space's connections, next to
  // hypergraph's own, opened with each peer once it proved it knows the space
  // key (lib/directory.js). messages: [{ encoding, onmessage (msg, peer) }];
  // peer: { identity (z32, null until its hello), device (z32), send (i, msg) }.
  addProtocol (name, { messages = [], onopen = () => {}, onclose = () => {} } = {}) {
    if (this._protocols.has(name)) throw new HypergraphError('NOT_ALLOWED', `This space has a protocol named "${name}" already`)
    this._protocols.set(name, { messages, onopen, onclose })
    for (const ch of this.directory.channels) this.#openProtocol(ch, name)
  }

  // Opens protocol `name` beside space channel `ch`: now, and when the other
  // side opens it (it may add the protocol later).
  #openProtocol (ch, name) {
    const { messages, onopen, onclose } = this._protocols.get(name)
    const open = () => {
      if (!this.directory.channels.has(ch)) return
      const peer = { get identity () { return ch.identity ? z32.encode(ch.identity) : null }, device: z32.encode(ch.peer), send: (i, msg) => app.messages[i].send(msg) }
      const app = ch.mux.createChannel({ protocol: name, id: this.discoveryKey, onopen: () => onopen(peer), onclose: () => { ch.apps.delete(app); onclose(peer) } })
      if (!app) return // open already
      for (const m of messages) app.addMessage({ encoding: m.encoding, onmessage: (msg) => m.onmessage(msg, peer) })
      ch.apps.add(app)
      app.open()
    }
    ch.mux.pair({ protocol: name, id: this.discoveryKey }, open)
    open()
  }

  // --- the graph (v1's vocabulary, story 5, research.md A9) ---

  // A relation from `from` to `to` of a `type`, with an optional number and
  // data (text up to 4 KB). Said by who may edit `from` (its author, or an
  // editor of a shared type); relating the same again replaces it.
  async relate (from, to, type, { value = null, data = null } = {}) {
    const source = await this.#row(from)
    await this.#mayEdit(source, 'relate from')
    const values = this.#graphValues('hg/relation', { from: enc.idToString(source.id), to: enc.idToString(idOf(to)), rel: type, value, data, off: false })
    const r = await this._put('hg/relation', values, await this.#relationStamp(source, values.to, type))
    return { id: r.id, from: r.from, to: r.to, type: r.rel, value: r.value ?? null, data: r.data ?? null, author: r.author, stamp: r.stamp }
  }

  // Takes a relation away (relating it again brings it back). NOT_FOUND if
  // there is none.
  async unrelate (from, to, type) {
    const source = await this.#row(from)
    const target = enc.idToString(idOf(to))
    const { items } = await this.edges(source, { direction: 'out', type, timeout: 0 })
    if (!items.some((e) => e.to === target)) throw new HypergraphError('NOT_FOUND', `No ${type} relation between these records`)
    await this.#mayEdit(source, 'unrelate from')
    await this._put('hg/relation', this.#graphValues('hg/relation', { from: enc.idToString(source.id), to: target, rel: type, off: true }), await this.#relationStamp(source, target, type))
  }

  // The newest stamp among the relations (from, to, type), any author.
  async #relationStamp (source, to, type) {
    const prefix = { space: this.keyBytes, target: source.id, type: 'hg/relation' }
    let top = 0
    for (const row of await this.db.find('@hg/by-link', { gte: prefix, lte: prefix }).toArray()) {
      try {
        const v = this.types.decode('hg/relation', row.fields, row.links)
        if (v.rel === type && v.to === to && b4a.equals(enc.idBytes(v.from), source.id)) top = Math.max(top, row.stamp)
      } catch {}
    }
    return top
  }

  // { items, count, complete }: the relations out of `record`, into it, or
  // both ('out' | 'in' | 'both'), optionally of one type; oldest first
  // (`order: 'desc'`: newest first); `limit` caps items, not count.
  edges (record, { direction = 'both', type = null, order = 'asc', limit = Infinity, timeout } = {}) {
    if (!['out', 'in', 'both'].includes(direction)) throw new TypeError("direction is 'out', 'in' or 'both'")
    return this._bounded(async () => {
      const all = await edgeRows(this, record, { direction, type })
      if (order === 'desc') all.reverse()
      return { items: all.slice(0, limit), count: all.length, need: await this.#stampOf(record) }
    }, timeout)
  }

  // Tags a record (its author, or an editor of a shared type).
  async tag (record, name) {
    const row = await this.#row(record)
    await this.#mayEdit(row, 'tag')
    await this._put('hg/tag', this.#graphValues('hg/tag', { on: enc.idToString(row.id), tag: name, off: false }), await tagStamp(this, row.id, name))
  }

  // NOT_FOUND if it doesn't have the tag.
  async untag (record, name) {
    const row = await this.#row(record)
    if (!(row.ix || []).includes(tagKey(name))) throw new HypergraphError('NOT_FOUND', `This ${row.type} is not tagged "${name}"`)
    await this.#mayEdit(row, 'untag')
    await this._put('hg/tag', this.#graphValues('hg/tag', { on: enc.idToString(row.id), tag: name, off: true }), await tagStamp(this, row.id, name))
  }

  // { items, complete }: records with a tag, newest first (by when they were
  // put); `type` for one type; `after` the last record of the previous page.
  getByTag (name, { type = null, limit = 20, after = null, timeout } = {}) {
    if (type) return this.query(type).tag(name).latest(limit, { after, timeout })
    if (typeof name !== 'string' || !name) throw new TypeError('A tag is a non-empty string')
    return this._bounded((deadline) => taggedRows(this, name, limit, after, deadline), timeout)
  }

  async #mayEdit (row, what) {
    await this.#mayPost()
    await this.#unless(() => gate.mayEdit(this.types, { author: this.hg._identity.publicKey, id: null }, row, this.state) ? null : `You may not ${what} this ${row.type}: only who may edit it (its author, by default)`)
  }

  // Hypergraph's graph records, checked as every member will check them.
  #graphValues (type, values) {
    const v = this.types.validate(type, values)
    if (!gate.builtinValid({ kind: enc.PUT, type }, { off: false, ...v })) {
      throw new HypergraphError('INVALID_RECORD', type === 'hg/tag' ? 'A tag is a non-empty string' : `A relation has a type (a non-empty string), a finite number as value, and data of at most ${gate.MAX_DATA} bytes of text`)
    }
    return v
  }

  // Waits (up to `timeout`) while blocks this space needs are known but not
  // held, then answers with what it has. `fn(deadline)` may fetch content
  // dropped here until then; `partial` in its result: some it couldn't.
  // `need` in fn's result (story 9): the stamp from which the answer must
  // hold everything to be complete (a page's oldest item; a target's stamp);
  // 0: everything; absent: the whole space. A member reading part of a big
  // space widens what it reads to get there.
  async _bounded (fn, timeout = this.hg.readTimeout) {
    const deadline = Date.now() + timeout
    for (;;) {
      const gen = this._indexed
      const { partial = false, need, ...result } = await fn(deadline)
      // Not for me (routed to story 9): a private space this member may not
      // read holds what it can't open; waiting changes nothing, so it answers
      // at once and says so.
      if (this._access() === 'none') return { ...result, complete: false, access: 'none' }
      // Complete only if nothing was indexed while the answer was read: records
      // indexed meanwhile may belong in it (found by bench/next/first-page.js:
      // a complete first page missing the newest posts; also before story 9).
      const complete = !partial && this._completeFor(need) && gen === this._indexed
      const left = deadline - Date.now()
      if (complete || left <= 0 || this.closed) return { ...result, complete }
      if (gen !== this._indexed) continue // read again at once
      this.#widenFor(need)
      await this.#progress(left)
    }
  }

  // 'full': this member reads what is written here; 'waiting': a private
  // space's member whose key hasn't arrived yet; 'none': a private space it
  // may not read (removed, or only relaying it): nothing new will open.
  _access () {
    if (this.personal || !this.state.private) return 'full'
    if (!this.state.isMember(this.hg._identity.publicKey)) return 'none'
    return this.#current() ? 'full' : 'waiting'
  }

  _completeFor (need) {
    return need === undefined ? this.isComplete() : this.completeFrom(need)
  }

  // A read needs records older than this member reads: it widens.
  #widenFor (need) {
    const h = this._reading.horizon
    if (h === null || this._undecided) return
    if (need !== undefined && need > 0) {
      if (periodOf(need) < h) this.#widen(periodOf(need))
      return
    }
    // It needs older records than it found: one step back, once what it
    // reads now is all here (else the page may fill without going back).
    if (this.completeFrom(h * PERIOD_MS)) this.#widen(this.#stepBack())
  }

  // Rows as the app sees them: { items, partial }. Content dropped here is
  // fetched (until `deadline`) and kept; a record it couldn't get is left
  // out and the answer is partial (story 6, research.md A10).
  async _shaped (rows, deadline) {
    const got = await Promise.all(rows.map((row) => (row.flags & FLAGS.DROPPED) ? this.#content(row, deadline) : row))
    const items = got.filter((row) => row).map((row) => shape(this.types, row))
    const typeOf = this._typeOf()
    for (const item of items) await this.#judgeLinks(item, typeOf)
    return { items, partial: items.length < rows.length }
  }

  // A link field whose target is held here with a type it doesn't allow
  // points at nothing (research.md A12).
  async #judgeLinks (item, typeOf) {
    if (!this.types.has(item.type)) return
    const { fields, links } = this.types.get(item.type)
    for (const f of fields) {
      if (f.kind !== 'link' || !links[f.name] || !item[f.name]) continue
      const targetType = await typeOf(item[f.name])
      if (targetType && !this.types.linkAllowed(item.type, f.name, targetType)) item[f.name] = null
    }
  }

  // A dropped record's content, fetched from whoever holds it (its author
  // always does) until `deadline`, and kept: the row, or null.
  async #content (row, deadline, read = true) {
    const log = this.directory.logs.get(hex(row.log))
    const left = deadline - Date.now()
    if (!log || left <= 0 || this.closed) return null
    let bytes = null
    try { bytes = await log.core.get(row.seq, { timeout: left }) } catch { return null }
    if (!bytes || this.closed) return null
    const put = this._unsealed(log, row.seq, bytes) // opened, in a private space
    if (!put) return null
    const restored = await this.indexer.restore(row.id, put.fields, { read, size: bytes.byteLength })
    this.hg._holdLater() // held again: something else may have to go
    if (restored) return restored
    const now = await this.db.get('@hg/records', { space: this.keyBytes, id: row.id }) // restored meanwhile by another read
    return now && !(now.flags & FLAGS.DROPPED) ? now : null
  }

  // What a read about record `id` needs (story 9): its stamp, records about
  // it being stamped after it (lib/stamp.js); 0 (everything) if it isn't held
  // here; for a member reading everything, nothing more than the whole space.
  async #stampOf (id) {
    if (this._reading.horizon === null) return undefined
    const row = await this.db.get('@hg/records', { space: this.keyBytes, id: idOf(id) })
    return row ? row.stamp : 0
  }

  #needOf () {
    return this._reading.horizon === null ? undefined : 0
  }

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

  // Complete (research.md A4): every block this member knows of is held and
  // indexed (holes it knows were wiped don't count), and it reached another
  // member since opening — or it is the space's only member, on its only
  // device (research.md A7).
  isComplete () {
    return this.completeFrom(0)
  }

  #completeAll () {
    if (this.replicator.missing() > 0) return false
    if (this.directory.known) return true
    const members = [...this.state.members.keys()]
    return members.length === 1 && members[0] === hex(this.hg._identity.publicKey) && this.hg._alone
  }

  _live (type, run, fn) {
    let stopped = false
    let running = false
    let again = false
    const go = async () => {
      if (running) { again = true; return }
      running = true
      try {
        do {
          again = false
          const gen = this._indexed
          const { partial = false, need, ...result } = await run(Date.now() + this.hg.readTimeout)
          if (gen !== this._indexed) again = true // indexed meanwhile: read again
          if (!stopped) fn({ ...result, complete: !partial && this._completeFor(need) && gen === this._indexed })
          if (!stopped && !(!partial && this._completeFor(need))) this.#widenFor(need)
        } while (again && !stopped)
      } catch (err) {
        safetyCatch(err)
      } finally {
        running = false
      }
    }
    const onchange = ({ types }) => { if (types.includes(type)) go() }
    this.on('change', onchange)
    go()
    return () => {
      stopped = true
      this.off('change', onchange)
    }
  }

  #changed (types) {
    if (types.size) this._indexed++ // reads check nothing changed while they read
    if (types.has(grants.TYPE)) this.#keysLater()
    if (types.size) this.emit('change', { types: [...types] })
    this.emit('_progress')
    this.#logsChanged()
    this.hg._holdLater()
  }

  // 'logs': a log was accepted, or what is indexed of one moved (at most
  // every LOGS_MS; for the inspector and other diagnostics).
  #logsChanged () {
    if (this._logsTimer || this.closed) return
    this._logsTimer = setTimeout(() => {
      this._logsTimer = null
      if (!this.closed) this.emit('logs')
    }, LOGS_MS)
    if (this._logsTimer.unref) this._logsTimer.unref()
  }

  // `log`'s author lost the right to write: only what is below `limit` counts
  // (research.md A4). Serialized per log, after any indexing run.
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

  // A deleted record's blocks: wiped from this device.
  // `dropped`: its content only, to keep within a budget (it still counts).
  async #clear (id, { dropped = false } = {}) {
    const { log, seq } = enc.idParts(id)
    const held = this.directory.logs.get(hex(log))
    if (!held) return
    await clearBlocks(held.core, seq, seq + 1).catch(safetyCatch)
    if (dropped) return
    await this.#wipedEntry(held, seq).catch(safetyCatch)
    // A wiped record's stamp is gone: the next ones are judged against the
    // next readable record (lib/limit.js).
    const limit = this.#limitFor(held)
    if (limit) await this.indexer.rejudge(held, { from: seq + 1, to: seq + limit.records }).catch(safetyCatch)
  }

  // Block `seq` of `log` was wiped (story 9): an entry starting right after
  // it can't be checked any more (nobody holds the block before its start), so
  // it starts earlier, after the last readable block; and deriving goes on
  // from there.
  async #wipedEntry (log, seq) {
    const readable = async (s) => s === 0 || (!!(await log.core.get(s, { wait: false }).catch(() => null)) && !(await this.indexer.isWiped(log, s)))
    let start = seq
    while (start > 1 && !(await readable(start - 1))) {
      if (start - 1 < (log.from || 1)) return // not read here: can't tell
      start--
    }
    if (log.act.last === seq) log.act = { ...log.act, last: start - 1 }
    const next = await log.core.get(seq + 1, { wait: false }).catch(() => null)
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

  // --- roles and moderation ---

  // The role of a member ('owner', 'admin', 'moderator', 'member', or a custom
  // role); null if not a member.
  async getRole (who) {
    return this.state.roleOf(keyBytes(who, 'an identity'))
  }

  // Takes someone out of the space (v1's removeRole). What they wrote up to
  // what this member holds stays for everyone; anything after is ignored.
  async removeRole (who) {
    const identity = keyBytes(who, 'an identity')
    await this.#mayDecide('decide', 'remove members')
    await this.#unless(() => this.state.roleOf(identity) ? null : 'Not a member of this space', 'NOT_FOUND')
    await this.#unless(() => {
      const role = this.state.roleOf(identity)
      return mayRemove(this.#myRole(), role, 'decide', this.state.roles) ? null : `You may not remove a member whose role is ${role} (yours is ${this.#myRole()})`
    })
    await this.#decide({ type: 'member/remove', identity, cut: this.#cutOf(identity) })
  }

  // Gives someone a role (v1's setRole): a built-in one ('admin', 'moderator',
  // 'member', 'guest') or one defined with defineRole. Someone not a member
  // yet becomes one. A role without `post` cuts what they wrote where this
  // member holds it.
  async setRole (who, role) {
    const identity = keyBytes(who, 'an identity')
    await this.#mayDecide('roles', 'give roles')
    await this.#unless(() => this.state.permissionsOf(role) ? null : `No role "${role}" in this space (define it first: defineRole)`, 'NOT_FOUND')
    await this.#unless(() => this.state.isBanned(identity) ? 'This identity is banned from the space (unban it first)' : this.#assignRefusal(identity, role))
    await this.#decide({ type: 'role/set', identity, role, cut: this.#cutOf(identity) })
  }

  // A custom role and its permissions: hypergraph's own ('post', 'moderate',
  // 'invite', 'roles', 'decide') and the app's (e.g. 'edit-pages'). A role
  // can gain permissions later, but never lose 'post'.
  async defineRole (name, permissions) {
    await this.#mayDecide('roles', 'define roles')
    if (typeof name !== 'string' || !name) throw new TypeError('A role name is a non-empty string')
    if (!Array.isArray(permissions) || !permissions.every((p) => typeof p === 'string' && p)) throw new TypeError('permissions is a list of names')
    if (ROLES[name]) throw new HypergraphError('NOT_ALLOWED', `"${name}" is a built-in role`)
    const before = this.state.permissionsOf(name)
    const lost = (before || []).filter((p) => !OWN.includes(p) && !permissions.includes(p))
    if (lost.length) {
      throw new HypergraphError('NOT_ALLOWED', `Role "${name}" cannot lose ${lost.map((p) => `'${p}'`).join(', ')}: give its members another role instead`)
    }
    if (!grantable(this.#myRole(), permissions, this.state.roles)) throw new HypergraphError('NOT_ALLOWED', 'You may not hand on a permission you don\'t have')
    await this.#decide({ type: 'role/define', name, permissions })
  }

  // flag, hide, reveal, remove (a record, for good), or ban (an identity: out
  // for good; what they wrote up to what this member holds stays, anything
  // after is ignored). A ban `from` one of their records also drops that
  // record and everything after it in its log, for everyone. Moderators,
  // admins and the owner.
  async moderateAction (action, target, { reason = '', from = null } = {}) {
    if (!ACTIONS.includes(action)) throw new TypeError(`Moderation actions: ${ACTIONS.join(', ')}`)
    await this.#mayDecide('moderate', 'moderate')
    if (action === 'unban') {
      const identity = keyBytes(target, 'an identity')
      await this.#unless(() => this.state.banned.get(hex(identity)) ? null : 'This identity is not banned here', 'NOT_FOUND')
      await this.#unless(() => {
        const byRole = this.state.roleOf(this.state.banned.get(hex(identity)).by)
        return this.#myRole() !== 'owner' && byRole && rankOf(byRole) > rankOf(this.#myRole()) ? `Banned by a member whose role is ${byRole}: only someone at that rank lifts it` : null
      })
      return this.#decide({ type: 'moderate', action, target: identity, reason, cut: [] })
    }
    if (action !== 'ban') return this.#decide({ type: 'moderate', action, target: idOf(target), reason, cut: [] })
    const identity = keyBytes(target, 'an identity')
    await this.#unless(() => mayRemove(this.#myRole(), this.state.roleOf(identity), 'moderate', this.state.roles) ? null : `You may not ban a member whose role (${this.state.roleOf(identity)}) is at or above yours (${this.#myRole()})`)
    const cut = this.#cutOf(identity)
    if (from) {
      const { log, seq } = enc.idParts(idOf(from))
      const entry = cut.find((e) => b4a.equals(e.log, log))
      if (!entry || seq < 1) throw new HypergraphError('NOT_ALLOWED', 'A ban starts from one of the banned member\'s own records (this one is not theirs, or not held here)')
      entry.length = seq
    }
    await this.#decide({ type: 'moderate', action, target: identity, reason, cut })
  }

  // Appends a decision; resolves once this member applied it. A device whose
  // member was just given a role that records decisions isn't a writer of the
  // decision log yet: it claims its key again at once and waits (within the
  // read bound, at least 5 s) instead of failing (ROADMAP 2026-10-09).
  async #decide (decision) {
    if (!this.decisionLog.writable && this.state.writesDecisions(this.hg._identity.publicKey)) {
      this._claimed = 0
      this.#claim()
    }
    await this.decisionLog.append(this.#scoped(decision), { wait: Math.max(this.hg.readTimeout, 5000), onwait: () => { this._claimed = 0; this.#claim() } })
    if (this._decided) await this._decided
  }

  // A decision about this space as its decision log takes it: inside a
  // sub-space, marked with it (story 8).
  #scoped (decision) {
    if (!this.rootKey) return decision
    return { type: 'scoped', space: this.keyBytes, decision: c.encode(enc.decision, { stamp: Date.now(), ...decision }) }
  }

  // The space's roles, highest first: the built-in ones, then its own (by
  // name): [{ name, permissions, custom }]. The owner holds every permission,
  // the app's included.
  async roles () {
    const out = Object.entries(ROLES).map(([name, permissions]) => ({ name, permissions: [...permissions], custom: false }))
    const custom = [...this.state.roles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    for (const [name, permissions] of custom) out.push({ name, permissions: [...permissions], custom: true })
    return out
  }

  #myRole () {
    return this.state.roleOf(this.hg._identity.publicKey)
  }

  // Why this member may not give `role` to `identity`, or null.
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
  // every sub-space held below (a removal or ban here applies there: story 8).
  #cutOf (identity) {
    const cut = []
    for (const space of [this, ...this.hg._below(this)]) {
      for (const log of space.directory.logs.values()) {
        if (b4a.equals(log.identity, identity)) cut.push({ log: log.key, length: Math.min(log.indexed, log.limit) })
      }
    }
    return cut
  }

  async #mayDecide (permission, what) {
    if (this.closed) throw new HypergraphError('CLOSED', 'This space is closed')
    if (this.personal) throw new HypergraphError('NOT_ALLOWED', 'The personal space is only yours: no roles, moderation or invites')
    await this.#unless(() => this.state.can(this.hg._identity.publicKey, permission) ? null : this.#whyNot(what))
  }

  // --- invites (spec 008's design, research R16): recorded by any member who
  // records decisions, the maker online or not ---

  // A link for `role`, usable by `uses` people (Infinity: a public link,
  // until revoked), until `expires` (ms since 1970; 0: never).
  async createInvite ({ role = 'member', uses = 1, expires = 0, subspaces = [] } = {}) {
    if (this.personal) throw new HypergraphError('NOT_ALLOWED', 'The personal space is only yours: add a device with hg.addDevice()')
    if (uses !== Infinity && !(Number.isInteger(uses) && uses >= 1)) throw new TypeError('uses is a whole number of people, at least 1, or Infinity for a public link')
    await this.#unless(() => this.state.can(this.hg._identity.publicKey, 'invite') ? null : this.#whyNot('invite'))
    await this.#unless(() => this.state.permissionsOf(role) ? null : `No role "${role}" in this space`, 'NOT_FOUND')
    await this.#unless(() => mayInvite(this.#myRole(), role, this.state.roles) ? null : `Your role (${this.#myRole()}) can't invite people as ${role}`)
    // Story 9 (routed): sub-spaces inside this one the newcomer gets the role
    // in too (e.g. private ones); its maker must be able to invite there.
    const subs = []
    for (const s of subspaces) {
      const key = keyBytes(s && s.key ? s.key : s, 'a sub-space')
      if (!this.#inside(key)) throw new HypergraphError('NOT_FOUND', 'Not a sub-space of this space: ' + z32.encode(key))
      const there = this.decisionLog.state.sub(key)
      const mine = there.roleOf(this.hg._identity.publicKey)
      if (!mayInvite(mine, role, this.state.roles)) throw new HypergraphError('NOT_ALLOWED', `You can't invite people as ${role} to the sub-space "${there.name}"${mine ? ` (your role there is ${mine})` : ' (you have no role there)'}`)
      subs.push(key)
    }
    return invites.encodeLink(invites.makeInvite({ space: this.keyBytes, role, uses: uses === Infinity ? 0 : uses, expires, subspaces: subs }, this.hg._identity, this.top), this.top)
  }

  // Is sub-space `key` inside this space, at any depth?
  #inside (key) {
    const subs = this.decisionLog.state.subspaces
    const here = this.rootKey ? this.hex : null
    for (let info = subs.get(hex(key)); info; info = info.parent ? subs.get(info.parent) : null) {
      if (info.parent === here) return true
    }
    return false
  }

  // No one else gets in with `link`; who came in stays. Its maker, or who
  // may decide.
  async revokeInvite (link) {
    const inv = this.#ownInvite(link)
    const me = this.hg._identity.publicKey
    await this.#unless(() => this.state.can(me, 'decide') || b4a.equals(inv.maker, me) ? null : 'Only its maker, or an admin, revokes an invite')
    await this.#decide({ type: 'invite/revoke', invite: c.encode(enc.invite, inv) })
  }

  // --- sub-spaces (story 8, research.md A13) ---

  // A space inside this one (a sub-forum, a folder with its own rules): its
  // members and roles are this space's, then its own (guests, roles given in
  // it); a ban or removal here applies in it. `writeRoles`: only these roles
  // write (the owner and admins always may); `private`: read only by the
  // people given a role in it and this space's owner and admins. Who may
  // decide. Its decisions are kept in this space's decision log. Resolves to
  // the sub-space (every member of this space has it, without joining).
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

  // The sub-spaces right inside this one: [{ key, name, private }] (sync).
  subspaces () {
    if (this.personal) return []
    const parent = this.rootKey ? this.hex : null
    const out = []
    for (const [key, info] of this.decisionLog.state.subspaces) {
      if (info.parent === parent) out.push({ key: z32.encode(b4a.from(key, 'hex')), name: info.name, private: !!info.private })
    }
    return out
  }

  // Who came in with `link`: [{ identity, at }], oldest first.
  async redemptions (link) {
    const id = hex(this.#ownInvite(link).id)
    const out = []
    for (const [key, { at }] of this.state.redeemed) {
      const [invite, identity] = key.split(':')
      if (invite === id) out.push({ identity: z32.encode(b4a.from(identity, 'hex')), at })
    }
    return out.sort((a, b) => a.at - b.at)
  }

  #ownInvite (link) {
    const inv = invites.decodeLink(link)
    if (!b4a.equals(inv.space, this.keyBytes)) throw new HypergraphError('NOT_FOUND', 'This invite is for another space')
    return inv
  }

  // A newcomer's redemption reached us: record it if we can.
  async #redeem (bytes) {
    if (!this.decisionLog.writable || !this.state.can(this.hg._identity.publicKey, 'decide')) return
    let r = null
    try { r = c.decode(enc.redemption, bytes) } catch { return }
    if (!b4a.equals(r.invite.space, this.keyBytes) || this.state.isMember(r.identity) || this.state.isBanned(r.identity) || !invites.verifyRedemption(r, this.top)) return
    const tag = hex(r.invite.id) + hex(r.identity)
    if (this._redeeming.has(tag)) return
    this._redeeming.add(tag)
    try {
      await this.decisionLog.append(this.#scoped({ type: 'invite/redeem', redemption: bytes }))
    } finally {
      this._redeeming.delete(tag)
    }
  }

  // Asks every peer of this space to record our redemption; resolves to true
  // when the decision log says we're in, to the reason it was refused (a
  // code), or to false after `timeout`. Refusals are judged from this
  // device's own copy of the decision log once a member was reached: the
  // checks a recorder makes (uses, revocation, the maker's rights).
  async _redeem (redemption, timeout) {
    const me = this.hg._identity.publicKey
    if (this.state.isMember(me)) return true
    this._redemption = c.encode(enc.redemption, redemption)
    this.directory.sendRedeem(this._redemption)
    const deadline = Date.now() + timeout
    let refused = null
    while (!this.state.isMember(me) && !this.closed && Date.now() < deadline) {
      if (this.state.meta && this.directory.reached) refused = this.state.inviteRefusal(redemption.invite, me, Date.now())
      if (refused) break
      await this.#progress(deadline - Date.now())
    }
    this._redemption = null
    return this.state.isMember(me) || refused || false
  }

  // How this space is doing here: { policy, held, stored, share, budget,
  // belowPolicy, peers, settlers, warnings: [{ code, message }] }.
  // held: 'all', or 'part' once content was dropped here; stored: bytes
  // (estimated); share: what it may use here (null until first computed).
  // SINGLE_SETTLER: only one member settles the order of decisions; if that
  // device is lost for good, decisions are never settled again (research.md
  // A8). BELOW_POLICY: its creator asks members to keep everything, and this
  // device can't. OVER_BUDGET: what it may not drop (this identity's records,
  // the decision log, the list of records) is already more than its share.
  status () {
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
    if (belowPolicy) warnings.push({ code: 'BELOW_POLICY', message: 'This space asks its members to keep everything, and this device keeps only part of it: give it more room (setBudget)' })
    const differ = this.personal ? null : rulesDiffer(this.state.rules, this.hg.rules)
    if (differ) warnings.push({ code: 'RULES_DIFFER', message: differ })
    if (this._over) {
      warnings.push({ code: 'OVER_BUDGET', message: 'What this device may not drop here (its own records, the decisions, the list of records) is more than this space\'s share of the budget' })
    }
    const horizon = this._reading.horizon
    const heldFrom = horizon === null ? null : horizon * PERIOD_MS // story 9: reads records from then on
    return { policy, access: this._access(), held: droppedBlocks > 0 || heldFrom !== null ? 'part' : 'all', heldFrom, stored, share, budget: this._budget, belowPolicy, peers: this.directory.peers, settlers, warnings }
  }

  // A read-only diagnostics snapshot (contracts/api.md, "Diagnostics"): for
  // the inspector tool and for debugging. Writes nothing, fetches nothing;
  // counting records reads the whole index of the space, so it is not for a
  // hot path. `records: { type, limit, after }` adds `rows`: every row of a
  // type, those no list shows included; `record: id` adds `record`: its
  // versions and deletes (core follow-ups).
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
        length: log.core.length,
        held: await heldCount(log.core),
        indexed: Math.min(log.indexed, log.core.length),
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
    const records = {}
    const range = { gte: { space: this.keyBytes }, lte: { space: this.keyBytes } }
    for await (const row of this.db.find('@hg/by-type', range)) records[row.type] = (records[row.type] || 0) + 1

    const s = this.status()
    return {
      key: this.key,
      name: this.name,
      personal: this.personal,
      parent: this.parent, // story 8: the space it is in, its own sub-spaces, private state (never keys)
      subspaces: this.subspaces(),
      private: this.private,
      epoch: this.state.keys ? this.state.keys.current : null,
      readable: !this.private || !!this.#current(),
      access: s.access, // story 9: 'full' | 'waiting' | 'none' (a private space not for this member)
      // story 9: from when records are read here (null: all), by activity lists, entries kept
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

  // Every row of a type, newest first, as held here: { items, next } — each
  // its current version with `state: { hidden, superseded, edited, flagged,
  // dropped, read }` (hidden, superseded and dropped rows included; deleted
  // and taken-down records have no row). `after`: `next` of the last page.
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
      items.push({ ...shape(this.types, row), state: { hidden: !!(f & FLAGS.HIDDEN), superseded: !!(f & FLAGS.SUPERSEDED), edited: !!(f & FLAGS.EDITED), flagged: !!(f & FLAGS.FLAGGED), dropped: !!(f & FLAGS.DROPPED), read: !!(f & FLAGS.READ) } })
    }
    return { items, next: more ? items.at(-1).id : null }
  }

  // A record's history as held here: { id, type, deleted, removed, versions:
  // [{ id, kind: 'put' | 'edit', by, device, stamp, counts, ...fields }],
  // deletes: [{ id, by, device, stamp, counts }] }. Fields are null where the
  // content isn't held (dropped, or cleared by a delete); `counts`: whether
  // that version or delete counts (null when it can't be told: the record
  // itself isn't held).
  async #inspectRecord (id) {
    const key = idOf(id)
    const row = await this.db.get('@hg/records', { space: this.keyBytes, id: key })
    const { log: logKey, seq } = enc.idParts(key)
    const log = this.directory.logs.get(hex(logKey))
    const z = (k) => z32.encode(k)
    const fieldsOf = (type, fields, links) => {
      try { return this.types.has(type) ? this.types.decode(type, fields, links) : {} } catch { return {} }
    }
    const versions = []
    const bytes = log ? await log.core.get(seq, { wait: false }).catch(() => null) : null
    let put = null
    if (bytes) put = this._unsealed(log, seq, bytes) // null while its key isn't held here
    const type = row ? row.type : put ? put.type : null
    if (row || put) {
      versions.push({ id: enc.idToString(key), kind: 'put', by: log ? z(log.identity) : (row ? z(row.author) : null), device: log ? z(log.device) : (row ? z(row.device) : null), stamp: row ? row.stamp : put.stamp, counts: !!row, ...(put ? fieldsOf(put.type, put.fields, put.links) : {}) })
    }
    const deletes = []
    const changes = await this.db.find('@hg/changes', { gte: { space: this.keyBytes, target: key }, lte: { space: this.keyBytes, target: key } }).toArray()
    changes.sort((a, b) => a.stamp - b.stamp)
    for (const ch of changes) {
      let counts = row ? gate.mayChange(this.types, ch, row, this.state) : null
      if (!row && ch.kind === enc.DELETE && log) counts = ch.type === type || type === null ? b4a.equals(ch.author, log.identity) : false
      const base = { id: enc.idToString(ch.id), by: z(ch.author), device: z(ch.device), stamp: ch.stamp, counts }
      if (ch.kind === enc.DELETE) deletes.push(base)
      else versions.push({ ...base, kind: 'edit', ...fieldsOf(ch.type, ch.fields, ch.links) })
    }
    return { id: enc.idToString(key), type: type || (changes[0] ? changes[0].type : null), deleted: !row && deletes.some((d) => d.counts), removed: this.state.isRemoved(key), versions, deletes }
  }

  // Emits 'status' when the policy, what is held, being below the policy or
  // the warnings changed.
  _statusChanged () {
    if (this.closed) return
    const s = this.status()
    const sig = JSON.stringify([s.policy, s.access, s.held, s.heldFrom, s.belowPolicy, s.budget, s.warnings.map((w) => w.code)])
    if (sig === this._statusSig) return
    this._statusSig = sig
    this.emit('status', s)
  }

  // --- holding part of the space (story 6, research.md A10) ---

  get _policy () { return this.personal ? 'everything' : this.state.policy }

  // What this space stores here, estimated (lib/storage.js): { stored,
  // floor, droppedBlocks }. floor: what can't be dropped (this identity's
  // records, the decision log, every record's row).
  _usage () {
    const me = this.hg._identity.publicKey
    let stored = 0
    let floor = 0
    let droppedBlocks = 0
    for (const log of this.directory.logs.values()) {
      const length = log.core.length
      const below = log.from === null ? length : log.from - 1 // not read here (story 9)
      const held = Math.max(0, Math.min(log.scanned, log.limit, length) - below - log.holes.size)
      if (!held) continue
      const content = log.core.byteLength * held / length
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
  async #droppable (need, read) {
    const me = this.hg._identity.publicKey
    const found = []
    if (!this._dropFrom) this._dropFrom = new Map()
    for (const type of this.types.names()) {
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
  async #refill (share) {
    const { stored, droppedBlocks } = this._usage()
    if (!droppedBlocks || this._refilling) return
    let dropped = 0
    for (const log of this.directory.logs.values()) dropped += log.dropped
    if (stored + 2 * dropped > share * 0.95) return
    this._refilling = true
    try {
      const rows = []
      for (const type of this.types.names()) {
        if (type.startsWith('hg/')) continue
        const prefix = { space: this.keyBytes, type }
        for (const row of await this.db.find('@hg/by-type', { gte: prefix, lte: prefix }).toArray()) {
          if ((row.flags & FLAGS.DROPPED) && rows.length < REFILL) rows.push(row)
        }
      }
      const deadline = Date.now() + this.hg.readTimeout
      await Promise.all(rows.map((row) => this.#content(row, deadline, false)))
      this._dropFrom = null
      if (rows.length) this.hg._holdLater()
    } finally {
      this._refilling = false
    }
  }

  // This space's own budget on this device, out of the app's (bytes), or
  // null to share the app's budget with the other spaces.
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

  // The storage policy every member is asked to follow: 'auto' (keep what
  // fits, then the newest part plus what is read) or 'everything'. Who may
  // decide (owner, admins).
  async setPolicy (policy) {
    if (!POLICIES.includes(policy)) throw new TypeError(`A policy is ${POLICIES.map((p) => `'${p}'`).join(' or ')}`)
    await this.#mayDecide('decide', 'change the storage policy')
    await this.#decide({ type: 'settings/set', policy, writeLimit: null, rules: null })
  }

  // Records this app's rules (their ids) as the ones the space runs: members
  // whose app has others are warned (status(): RULES_DIFFER). Rules are code,
  // so nothing can make every member run the same ones; this only detects a
  // mismatch. Change a rule's id when you change what it accepts. Who may
  // decide; createSpace() records the creator's.
  async setRules () {
    await this.#mayDecide('decide', 'record the rules the space runs')
    await this.#decide({ type: 'settings/set', policy: null, writeLimit: null, rules: this.hg.rules.map((r) => r.id) })
  }

  // --- big spaces (story 9, research.md A14) ---
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

  // The entries at or after period `from`, in memory (`_act`).
  async #loadEntries (from) {
    this._act = new Map()
    const range = { gte: { space: this.keyBytes, period: from }, lte: { space: this.keyBytes } }
    for (const row of await this.db.find('@hg/activity', range).toArray()) this.#remember(row)
  }

  #remember (row) {
    const h = hex(row.log)
    if (!this._act.has(h)) this._act.set(h, new Map())
    const periods = this._act.get(h)
    const old = periods.get(row.period)
    if (old === undefined || row.start < old) periods.set(row.period, row.start)
  }

  // A peer's directory summary, before this newcomer asks for anything: how
  // to read this space.
  #onSummary ({ count, records }) {
    if (!this._undecided || this.closed) return
    this._undecided = false
    if (count < BIG.logs && records < BIG.records) return
    const now = periodOf(Date.now())
    this._reading = { horizon: now, byActivity: count >= BIG.logs }
    this.#saveReading()
    this.activity.ask(now)
    this._statusChanged()
  }

  // Where reading a log just accepted starts: 1 when everything is read;
  // else its first entry at or after the horizon (null: none, not read).
  async #fromOf (key) {
    if (this._reading.horizon === null || this._undecided) return 1
    return this.#startOf(hex(key), this._reading.horizon)
  }

  // The lowest start of a log's entries at or after `period`, or null.
  #startOf (h, period) {
    const periods = this._act.get(h)
    let start = null
    if (periods) for (const [p, s] of periods) if (p >= period && (start === null || s < start)) start = s
    return start
  }

  // Entries just kept here: logs read from earlier if they reach into the
  // periods read.
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

  // Reads from period `period` on (never later than now).
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

  // The space's first period: nothing is older.
  #floor () {
    const meta = this.state.meta
    return meta && meta.stamp ? periodOf(meta.stamp) : 0
  }

  // One step back (the window read doubles), for a read needing older
  // records than it found.
  #stepBack () {
    const h = this._reading.horizon
    return Math.max(0, h - Math.max(1, periodOf(Date.now()) - h + 1))
  }

  // Is everything stamped at or after `stamp` held and indexed here? For a
  // member reading everything, the same as isComplete(). Else: the lists of
  // entries from its period on were received whole, none waits for its
  // check, and every log with an entry from then on is read from it with
  // nothing missing.
  completeFrom (stamp) {
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
      if (log.from === null || log.from > start || unheard(log) || log.uncommitted) return false
      const end = Math.min(log.core.length, log.limit)
      if (log.scanned < end) return false
      for (const s of log.holes) if (s >= start) return false
    }
    return true
  }

  // What this member can tell a peer asking for entries: the period from
  // which its lists are whole (Infinity: it can't tell yet).
  #coveredFrom () {
    for (const log of this.directory.logs.values()) {
      if (log.from !== null && log.act.next < Math.min(log.core.length, log.limit)) return Infinity // entries not derived yet
    }
    const r = this._reading
    if (r.horizon === null) return this.replicator.missing() === 0 ? 0 : Infinity
    return Math.max(r.horizon, this.activity.reachedFrom)
  }

  // In the background (the app's budget pass): once what is read is held,
  // one step back while the space fits its share (or always, if its creator
  // asks to keep everything); reading everything again once it has it all.
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

  // Tests only (lib/testing.js reading).
  _readingState () {
    return { horizon: this._reading.horizon, byActivity: this._reading.byActivity, reachedFrom: this.activity.reachedFrom, undecided: this._undecided }
  }

  async close () {
    if (this.closed) return
    this.closed = true
    clearTimeout(this._logsTimer)
    this.emit('_progress')
    this.activity.close()
    this.directory.close()
    this.replicator.close()
    this.indexer.close()
    for (const log of this.directory.logs.values()) if (log.indexing) await log.indexing
    this.decisionLog.off('change', this._onchange)
    if (this.personal) await this.decisionLog.close().catch(safetyCatch)
    else await this.hg._releaseDecisions(this.top)
  }
}

// How this app's rules differ from the ones the space recorded (ids), as a
// sentence, or null (the same, or the space never recorded any).
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

// How many blocks of a log this device holds.
async function heldCount (core) {
  if (!core.length || await core.has(0, core.length)) return core.length
  let n = 0
  for (let i = 0; i < core.length; i++) if (await core.has(i)) n++
  return n
}

// A log this member doesn't keep, as inspect() lists it.
function otherLog (key, { identity = null, device = null, cut = null, refused = false, waiting = false }) {
  const z = (k) => (k ? z32.encode(k) : null)
  return { key: z32.encode(key), identity: z(identity), device: z(device), own: false, length: 0, held: 0, indexed: 0, cut, dropped: 0, refused, waiting }
}

module.exports = { Space, BIG }
