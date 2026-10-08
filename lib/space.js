// A space (contracts/api.md): a community's records, queries and decisions.
// Each device writes its own log here; the decision log says who is in; every
// member checks what it receives before keeping it (lib/gate.js) and indexes
// what it holds (lib/index/). Reads are bounded and say if they are complete.

const { EventEmitter } = require('events')
const b4a = require('b4a')
const c = require('compact-encoding')
const z32 = require('z32')
const safetyCatch = require('safety-catch')
const enc = require('./encodings.js')
const gate = require('./gate.js')
const invites = require('./invites.js')
const { Decisions } = require('./decisions/log.js')
const { OwnLog } = require('./log.js')
const { Directory } = require('./directory.js')
const { Replicator } = require('./replication.js')
const { Indexer } = require('./index/indexer.js')
const { Query, linkedRows, shape, idOf } = require('./index/query.js')
const { HypergraphError } = require('./errors.js')

const hex = (b) => b4a.toString(b, 'hex')
const KINDS = { put: enc.PUT, edit: enc.EDIT, delete: enc.DELETE }

class Space extends EventEmitter {
  constructor (hg, { key = null, ns }) {
    super()
    this.setMaxListeners(0)
    this.hg = hg
    this.ns = ns
    this.keyBytes = key
    this.db = hg.db
    this.types = hg.types
    this.closed = false
    this._redemption = null
    this._redeeming = new Set()
  }

  get key () { return z32.encode(this.keyBytes) }
  get hex () { return hex(this.keyBytes) }
  get name () { return this.decisions.state.name }
  get parent () { return null }
  get discoveryKey () { return this.decisions.discoveryKey }
  get state () { return this.decisions.state }

  async _open ({ create = null } = {}) {
    const hg = this.hg
    this.store = hg.store.namespace(this.ns)
    this.decisions = new Decisions(this.store, this.keyBytes, { identity: hg._identity, wakeup: hg._network.wakeup })
    await this.decisions.ready()
    if (create) await this.decisions.init(create)
    this.keyBytes = this.decisions.key

    const me = hg._identity.publicKey
    // What the directory, indexer and replicator see of this space.
    const ctx = this._ctx = {
      key: this.keyBytes,
      types: this.types,
      store: this.store,
      me,
      stamper: hg._stamper,
      get state () { return ctxState() },
      accepted: (log) => this.replicator.hold(log),
      changed: (types) => this.#changed(types),
      clear: (id) => this.#clear(id),
      progress: () => this.emit('_progress'),
      redeem: (bytes) => this.#redeem(bytes),
      channelOpened: (ch) => { if (this._redemption && !this.state.isMember(me)) ch.messages[5].send({ redemption: this._redemption }) }
    }
    const ctxState = () => this.decisions.state
    this.own = new OwnLog(this.store.get({ name: 'log' }), { space: this.keyBytes, identity: hg._identity })
    await this.own.ready()
    this.directory = new Directory(ctx)
    this.indexer = ctx.indexer = new Indexer(ctx, hg._queue)
    this.replicator = new Replicator(ctx)

    const rows = await this.db.find('@hg/logs', { gte: { space: this.keyBytes }, lte: { space: this.keyBytes } }).toArray()
    for (const row of rows) {
      if (row.refused) continue
      const own = b4a.equals(row.log, this.own.key)
      const core = own ? this.own.core : this.store.get({ key: row.log })
      await this.directory.accept(row.log, core, row, { indexed: row.indexed, own, announce: false })
    }
    this.decisions.on('change', () => this.#onDecisions().catch(safetyCatch))
    await this.#onDecisions()
  }

  async #onDecisions () {
    if (this.closed) return
    const me = this.hg._identity
    if (this.state.isMember(me.publicKey) && !this.directory.logs.has(hex(this.own.key))) {
      await this.directory.accept(this.own.key, this.own.core, { identity: me.publicKey, device: me.device.publicKey }, { own: true })
    }
    this.directory.recheck()
    this.emit('_progress')
  }

  // --- records ---

  async put (type, values) {
    this.#mayPost()
    const v = this.types.validate(type, values)
    await this.#checkLinks(type, v)
    const { fields, links } = this.types.encode(type, v)
    const seq = await this.own.append({ kind: enc.PUT, type, stamp: this.hg._stamper.next(), target: null, links, fields })
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
    const { fields, links } = this.types.encode(row.type, v)
    await this.own.append({ kind: enc.EDIT, type: row.type, stamp: this.hg._stamper.next({ replaces: row.vstamp }), target: row.id, links, fields })
    await this.indexer.index(this.#ownLog())
    return (await this.get(row.id, { timeout: 0 })).record
  }

  async del (id) {
    const row = await this.#changeable(id, 'delete')
    await this.own.append({ kind: enc.DELETE, type: row.type, stamp: this.hg._stamper.next({ replaces: row.vstamp }), target: row.id, links: [], fields: b4a.alloc(0) })
    await this.indexer.index(this.#ownLog())
  }

  async #changeable (id, what) {
    this.#mayPost()
    const row = await this.db.get('@hg/records', { space: this.keyBytes, id: idOf(id) })
    if (!row) throw new HypergraphError('NOT_FOUND', `No record ${typeof id === 'string' ? id : id.id} here`)
    const change = { type: row.type, author: this.hg._identity.publicKey }
    if (!gate.mayChange(this.types, change, row, this.state)) {
      throw new HypergraphError('NOT_ALLOWED', `You may not ${what} this ${row.type}: only who the type allows (its author, by default)`)
    }
    return row
  }

  #mayPost () {
    if (this.closed) throw new HypergraphError('CLOSED', 'This space is closed')
    if (!this.state.can(this.hg._identity.publicKey, 'post')) throw new HypergraphError('NOT_ALLOWED', 'Only members of this space can write in it')
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

  // Complete: every member's log is known, every known block indexed, and a
  // member was reached since opening (unless this device is the only member).
  isComplete () {
    if (this.replicator.missing() > 0) return false
    const me = hex(this.hg._identity.publicKey)
    const members = [...this.state.members.keys()]
    if (members.length === 1 && members[0] === me) return true
    if (!this.directory.reached) return false
    const authors = new Set([...this.directory.logs.values()].map((l) => hex(l.identity)))
    return members.every((m) => authors.has(m))
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

  // A deleted record's blocks: wiped from this device.
  async #clear (id) {
    const { log, seq } = enc.idParts(id)
    const held = this.directory.logs.get(hex(log))
    if (held) await held.core.clear(seq, seq + 1).catch(safetyCatch)
  }

  // --- invites (story 1: recorded by a member who records decisions, online) ---

  async createInvite ({ role = 'member', uses = 1, expires = 0, subspaces = [] } = {}) {
    if (!this.state.can(this.hg._identity.publicKey, 'invite')) throw new HypergraphError('NOT_ALLOWED', 'Your role does not allow inviting')
    return invites.encodeLink(invites.makeInvite({ space: this.keyBytes, role, uses, expires, subspaces }, this.hg._identity))
  }

  // A newcomer's redemption reached us: record it if we can.
  async #redeem (bytes) {
    if (!this.decisions.writable || !this.state.can(this.hg._identity.publicKey, 'decide')) return
    let r = null
    try { r = c.decode(enc.redemption, bytes) } catch { return }
    if (!b4a.equals(r.invite.space, this.keyBytes) || this.state.isMember(r.identity) || !invites.verifyRedemption(r)) return
    const tag = hex(r.invite.id) + hex(r.identity)
    if (this._redeeming.has(tag)) return
    this._redeeming.add(tag)
    try {
      await this.decisions.append({ type: 'invite/redeem', redemption: bytes })
    } finally {
      this._redeeming.delete(tag)
    }
  }

  // Asks every peer of this space to record our redemption; resolves when
  // the decision log says we're in, or false after `timeout`.
  async _redeem (redemption, timeout) {
    const me = this.hg._identity.publicKey
    if (this.state.isMember(me)) return true
    this._redemption = c.encode(enc.redemption, redemption)
    this.directory.sendRedeem(this._redemption)
    const deadline = Date.now() + timeout
    while (!this.state.isMember(me) && !this.closed && Date.now() < deadline) await this.#progress(deadline - Date.now())
    this._redemption = null
    return this.state.isMember(me)
  }

  // --- for tests: bypass the API's own checks ---

  async _writeRaw ({ kind, type, target = null, fields = {} }) {
    const encoded = this.types.has(type) ? this.types.encode(type, fields) : { fields: b4a.alloc(0), links: [] }
    return this.own.append({ kind: KINDS[kind], type, stamp: this.hg._stamper.next(), target: target ? idOf(target) : null, links: encoded.links, fields: encoded.fields })
  }

  async _holdsBlock (id) {
    const { log, seq } = enc.idParts(id)
    const held = this.directory.logs.get(hex(log))
    return held ? held.core.has(seq) : false
  }

  _logs () { return this.directory.keys().map((k) => z32.encode(k)) }
  _ownLog () { return z32.encode(this.own.key) }

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
