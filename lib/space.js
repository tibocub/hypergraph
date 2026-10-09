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
const { initProof, writerSignable, removalSignable } = require('./decisions/apply.js')
const { OwnLog } = require('./log.js')
const { Directory } = require('./directory.js')
const { Replicator, clearBlocks } = require('./replication.js')
const { Indexer } = require('./index/indexer.js')
const { Query, linkedRows, edgeRows, taggedRows, tagStamp, shape, idOf, keyBytes } = require('./index/query.js')
const { tagKey } = require('./index/indexer.js')
const { ROLES, ACTIONS, OWN, mayAssign, mayInvite, mayRemove, grantable, rankOf } = require('./decisions/state.js')
const { Identity } = require('./identity.js')
const { PERSONAL } = require('./types.js')
const { HypergraphError } = require('./errors.js')

const hex = (b) => b4a.toString(b, 'hex')
const cutList = c.array(enc.struct([['log', c.fixed32], ['length', c.uint]]))
const removalKey = (identity, device) => hex(identity) + ':' + hex(device)
const CLAIM_MS = 5000 // a claim of this device's writer key is sent again at most this often

class Space extends EventEmitter {
  // personal: the identity's personal space (research.md A7), encrypted with
  // `encryptionKey`; `keyPair`: its first writer's, when creating it.
  constructor (hg, { key = null, ns, personal = false, encryptionKey = null, keyPair = null }) {
    super()
    this.setMaxListeners(0)
    this.hg = hg
    this.ns = ns
    this.keyBytes = key
    this.db = hg.db
    this.types = hg.types
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
  }

  get key () { return z32.encode(this.keyBytes) }
  get hex () { return hex(this.keyBytes) }
  get name () { return this.personal ? '' : this.decisions.state.name }
  get parent () { return null }
  get discoveryKey () { return this.decisions.discoveryKey }
  get state () { return this.decisions.state }

  async _open ({ create = null } = {}) {
    const hg = this.hg
    this.store = hg.store.namespace(this.ns)
    this.decisions = new Decisions(this.store, this.keyBytes, { identity: hg._identity, wakeup: hg._network.wakeup, keyPair: this._keyPair, encryptionKey: this.encryptionKey })
    this._keyPair = null
    await this.decisions.ready()
    if (create) await this.decisions.init(create)
    this.keyBytes = this.decisions.key

    const me = hg._identity.publicKey
    // What the directory, indexer and replicator see of this space.
    const ctx = this._ctx = {
      key: this.keyBytes,
      discoveryKey: this.decisions.discoveryKey,
      types: this.types,
      rules: hg.rules,
      store: this.store,
      me,
      stamper: hg._stamper,
      get state () { return ctxState() },
      getCore: (key) => this.store.get({ key, ...this._coreOpts }),
      limitOf: (identity, device, log) => this.limitOf(identity, device, log),
      mayRetry: (identity, device, log) => !this.isRemoved(identity, device) && !this.state.isCut(identity, log),
      allowed: (log, record, values) => this.#allowed(log, record, values),
      removed: (values, identity) => this.#removed(values, identity),
      accepted: (log) => this.replicator.hold(log),
      logOf: (key) => this.directory.logs.get(hex(key)) || null,
      cut: (log, limit) => this.#cut(log, limit).catch(safetyCatch),
      changed: (types) => this.#changed(types),
      clear: (id) => this.#clear(id),
      progress: () => this.emit('_progress'),
      redeem: (bytes) => this.#redeem(bytes),
      ask: (bytes) => this.#onAsk(bytes),
      channelOpened: (ch) => {
        if (this._redemption && !this.state.isMember(me)) ch.messages[5].send({ redemption: this._redemption })
        for (const bytes of this._asks.values()) ch.messages[6].send({ decision: bytes })
      }
    }
    const ctxState = () => this.decisions.state
    this.own = await this.#openOwnLog()
    this._idcore = this.store.get({ name: 'identity-log', ...this._coreOpts })
    await this._idcore.ready()
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
      await this.directory.accept(row.log, core, row, { indexed: row.indexed, own: !!mine, announce: false, limit: cut ?? Infinity, cut })
    }
    await this.#seenOwn()
    this.decisions.on('change', () => { this._decided = this.#onDecisions().catch(safetyCatch) })
    await this.#onDecisions()
  }

  // This device's log in the space: the first one not cut. A member removed
  // and let in again writes in a new log: the old one counts up to its cut
  // only, for good (research.md A4).
  async #openOwnLog (from = 0) {
    const me = this.hg._identity
    for (let n = from; ; n++) {
      const own = new OwnLog(this.store.get({ name: n ? `log/${n}` : 'log', ...this._coreOpts }), { space: this.keyBytes, identity: me })
      await own.ready()
      own.generation = n
      if (!this.state.isCut(me.publicKey, own.key) && !this.state.isEditCut(me.publicKey, own.key)) return own
      await own.core.close()
    }
  }

  // Cut (removed, banned, or an edit permission taken away) and let back
  // in: this device writes in a new log (research.md A4, A9). Before any
  // write, so nothing lands in the cut one.
  async #ownUncut () {
    while (this._reopening) await this._reopening
    const me = this.hg._identity.publicKey
    if (!this.state.canWrite(me) || !(this.state.isCut(me, this.own.key) || this.state.isEditCut(me, this.own.key))) return
    this._reopening = this.#openOwnLog(this.own.generation + 1).then((own) => { this.own = own })
    try {
      await this._reopening
    } finally {
      this._reopening = null
    }
  }

  async #onDecisions () {
    if (this.closed) return
    const me = this.hg._identity
    await this.#ownUncut()
    if (this.state.isMember(me.publicKey) && !this.directory.logs.has(hex(this.own.key))) {
      await this.directory.accept(this.own.key, this.own.core, { identity: me.publicKey, device: me.device.publicKey }, { own: true })
    }
    this.directory.recheck()
    await this.indexer.moderate()
    await this.indexer.reauthorize()
    this.#claim()
    await this.#recordRemovals()
    this.emit('_progress')
    this.emit('_decided')
  }

  // --- decision rights follow devices (research.md A8) ---

  // A device of a member who may decide or moderate claims its writer key of
  // the decision log: any writer records the claim (the member's other
  // device, an admin), so no one has to do anything.
  #claim () {
    const me = this.hg._identity
    const key = this.decisions.localKey
    const state = this.state
    for (const [h, bytes] of this._asks) if (this.#settled(bytes)) this._asks.delete(h)
    if (!state.meta || !state.writesDecisions(me.publicKey) || state.writer(key) || state.isGone(me.publicKey, me.device.publicKey)) return
    if (Date.now() - this._claimed < CLAIM_MS) return
    this._claimed = Date.now()
    this.#ask({ type: 'writer/add', key, proof: initProof(me, key, this.keyBytes) })
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
    const me = this.hg._identity.publicKey
    const writer = this.decisions.writable && !!this.state.writer(this.decisions.localKey)
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
      await this.decisions.append(decision)
    } finally {
      this._asking.delete('append:' + tag)
    }
  }

  // A peer asks us to record a decision it can't write: only the
  // self-signed kinds, and only if they would count.
  async #onAsk (bytes) {
    if (this.closed || !this.decisions.writable || !this.state.writer(this.decisions.localKey)) return
    let d = null
    try { d = c.decode(enc.decision, bytes) } catch { return }
    const state = this.state
    if (d.type === 'writer/add') {
      const info = Identity.verify(d.proof, writerSignable(d.key, this.keyBytes))
      if (!info || state.writer(d.key) || !state.writesDecisions(info.identity) || state.isGone(info.identity, info.device)) return
      await this.#append(hex(d.key), { type: d.type, key: d.key, proof: d.proof })
    } else if (d.type === 'device/remove') {
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
  limitOf (identity, device, log) {
    const limit = this.state.limitOf(identity, log)
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
    const log = new OwnLog(this._idcore, { space: this.keyBytes, identity: me, attest: (data) => Identity.attestAsIdentity(data, secrets.keyPair) })
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
    const seq = await (await this.#log()).append({ kind: enc.PUT, type, stamp: this.hg._stamper.next({ replaces }), target: null, links, fields })
    return this.#written(seq)
  }

  async get (id, { timeout } = {}) {
    const key = idOf(id)
    const { record, complete } = await this._bounded(async () => {
      const row = await this.db.get('@hg/records', { space: this.keyBytes, id: key })
      return { record: row ? shape(this.types, row) : null }
    }, timeout)
    return { record, complete }
  }

  // Changes some fields; the others stay. The record keeps its id.
  async edit (id, changes) {
    const row = await this.#changeable(id, 'edit')
    const current = this.types.decode(row.type, row.fields, row.links)
    const v = this.types.validate(row.type, { ...current, ...changes })
    await this.#checkLinks(row.type, v)
    this.#checkRules(row.type, v, row.id)
    const { fields, links } = this.types.encode(row.type, v)
    await (await this.#log()).append({ kind: enc.EDIT, type: row.type, stamp: this.hg._stamper.next({ replaces: row.vstamp }), target: row.id, links, fields })
    await this.indexer.index(this.#ownLog())
    return (await this.get(row.id, { timeout: 0 })).record
  }

  // Deletes a record: its author's delete; a moderator who isn't its author
  // takes it down instead (a decision, research.md A9). Other editors of a
  // shared type can't delete it (Tibo, 2026-10-09): they edit it.
  async del (id) {
    const row = await this.#changeable(id, 'delete', () => this.state.can(this.hg._identity.publicKey, 'moderate'))
    if (!b4a.equals(row.author, this.hg._identity.publicKey)) return this.moderateAction('remove', row.id)
    await (await this.#log()).append({ kind: enc.DELETE, type: row.type, stamp: this.hg._stamper.next({ replaces: row.vstamp }), target: row.id, links: [], fields: b4a.alloc(0) })
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
    await this.#unless(() => this.state.can(this.hg._identity.publicKey, 'post') ? null : this.#whyNot('write in it'))
  }

  // This device's log to write in now, once every check passed.
  async #log () {
    await this.#ownUncut()
    const me = this.hg._identity
    if (!this.directory.logs.has(hex(this.own.key))) await this.directory.accept(this.own.key, this.own.core, { identity: me.publicKey, device: me.device.publicKey }, { own: true })
    return this.own
  }

  // Refusals that depend on the decisions: first catch up with the connected
  // members who record decisions (within the read bound), then judge again,
  // so a decision made a moment ago elsewhere isn't missed (ROADMAP
  // 2026-10-09). `refusal()` gives the reason, or null.
  async #unless (refusal, code = 'NOT_ALLOWED') {
    if (!refusal()) return
    await this.decisions.catchUp(this.hg.readTimeout)
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
    return this._bounded(async () => ({ items: (await linkedRows(this, target, type)).map((row) => shape(this.types, row)) }), timeout)
  }

  async count (type, { on, timeout } = {}) {
    const { items, complete } = await this.linked(on, type, { timeout })
    return { value: items.length, complete }
  }

  // The sum of `field` over the records of `type` pointing at `on`; for
  // one-per-member types, each member's latest only.
  async sum (type, field, { on, timeout } = {}) {
    const { items, complete } = await this.linked(on, type, { timeout })
    return { value: items.reduce((s, r) => s + (Number(r[field]) || 0), 0), complete }
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
      return { items: all.slice(0, limit), count: all.length }
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
    return this._bounded(async () => ({ items: await taggedRows(this, name, limit, after) }), timeout)
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
  // held, then answers with what it has.
  async _bounded (fn, timeout = this.hg.readTimeout) {
    const deadline = Date.now() + timeout
    for (;;) {
      const result = await fn()
      const complete = this.isComplete()
      const left = deadline - Date.now()
      if (complete || left <= 0 || this.closed) return { ...result, complete }
      await this.#progress(left)
    }
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
    if (this.replicator.missing() > 0) return false
    if (this.directory.reached) return true
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
          const result = await run()
          if (!stopped) fn({ ...result, complete: this.isComplete() })
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
    if (types.size) this.emit('change', { types: [...types] })
    this.emit('_progress')
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
  async #clear (id) {
    const { log, seq } = enc.idParts(id)
    const held = this.directory.logs.get(hex(log))
    if (held) await clearBlocks(held.core, seq, seq + 1).catch(safetyCatch)
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
    if (!this.decisions.writable && this.state.writesDecisions(this.hg._identity.publicKey)) {
      this._claimed = 0
      this.#claim()
    }
    await this.decisions.append(decision, { wait: Math.max(this.hg.readTimeout, 5000), onwait: () => { this._claimed = 0; this.#claim() } })
    if (this._decided) await this._decided
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

  // The cut of an identity's logs: where this member holds them.
  #cutOf (identity) {
    const cut = []
    for (const log of this.directory.logs.values()) {
      if (b4a.equals(log.identity, identity)) cut.push({ log: log.key, length: Math.min(log.indexed, log.limit) })
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
    return invites.encodeLink(invites.makeInvite({ space: this.keyBytes, role, uses: uses === Infinity ? 0 : uses, expires, subspaces }, this.hg._identity))
  }

  // No one else gets in with `link`; who came in stays. Its maker, or who
  // may decide.
  async revokeInvite (link) {
    const inv = this.#ownInvite(link)
    const me = this.hg._identity.publicKey
    await this.#unless(() => this.state.can(me, 'decide') || b4a.equals(inv.maker, me) ? null : 'Only its maker, or an admin, revokes an invite')
    await this.#decide({ type: 'invite/revoke', invite: c.encode(enc.invite, inv) })
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
    if (!this.decisions.writable || !this.state.can(this.hg._identity.publicKey, 'decide')) return
    let r = null
    try { r = c.decode(enc.redemption, bytes) } catch { return }
    if (!b4a.equals(r.invite.space, this.keyBytes) || this.state.isMember(r.identity) || this.state.isBanned(r.identity) || !invites.verifyRedemption(r)) return
    const tag = hex(r.invite.id) + hex(r.identity)
    if (this._redeeming.has(tag)) return
    this._redeeming.add(tag)
    try {
      await this.decisions.append({ type: 'invite/redeem', redemption: bytes })
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

  // How this space is doing here: { peers, settlers, warnings: [{ code,
  // message }] }. SINGLE_SETTLER: only one member settles the order of
  // decisions; if that device is lost for good, decisions are never settled
  // again (research.md A8). Policy and budget come with story 6.
  status () {
    let settlers = 0
    for (const w of this.state.writerInfo.values()) if (w.indexer) settlers++
    const warnings = []
    if (!this.personal && settlers === 1) {
      warnings.push({ code: 'SINGLE_SETTLER', message: 'Only one member settles the order of decisions here: give the space an admin, so it keeps working if that device is lost' })
    }
    return { peers: this.directory.peers, settlers, warnings }
  }

  async close () {
    if (this.closed) return
    this.closed = true
    this.emit('_progress')
    this.directory.close()
    this.replicator.close()
    this.indexer.close()
    for (const log of this.directory.logs.values()) if (log.indexing) await log.indexing
    await this.decisions.close().catch(safetyCatch)
  }
}

module.exports = { Space }
