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
const { Replicator, clearBlocks } = require('./replication.js')
const { Indexer } = require('./index/indexer.js')
const { Query, linkedRows, shape, idOf, keyBytes } = require('./index/query.js')
const { ROLES, ACTIONS, mayAssign, mayRemove, grantable } = require('./decisions/state.js')
const { HypergraphError } = require('./errors.js')

const hex = (b) => b4a.toString(b, 'hex')

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
      rules: hg.rules,
      store: this.store,
      me,
      stamper: hg._stamper,
      get state () { return ctxState() },
      accepted: (log) => this.replicator.hold(log),
      logOf: (key) => this.directory.logs.get(hex(key)) || null,
      cut: (log, limit) => this.#cut(log, limit).catch(safetyCatch),
      changed: (types) => this.#changed(types),
      clear: (id) => this.#clear(id),
      progress: () => this.emit('_progress'),
      redeem: (bytes) => this.#redeem(bytes),
      channelOpened: (ch) => { if (this._redemption && !this.state.isMember(me)) ch.messages[5].send({ redemption: this._redemption }) }
    }
    const ctxState = () => this.decisions.state
    this.own = await this.#openOwnLog()
    this.directory = new Directory(ctx)
    this.indexer = ctx.indexer = new Indexer(ctx, hg._queue)
    this.replicator = new Replicator(ctx)

    const rows = await this.db.find('@hg/logs', { gte: { space: this.keyBytes }, lte: { space: this.keyBytes } }).toArray()
    for (const row of rows) {
      if (row.refused) continue
      const own = b4a.equals(row.log, this.own.key)
      const core = own ? this.own.core : this.store.get({ key: row.log })
      const cut = row.cut || null // the index stores "none" as 0; a kept log's cut is at least 2
      await this.directory.accept(row.log, core, row, { indexed: row.indexed, own, announce: false, limit: cut ?? Infinity, cut })
    }
    this.decisions.on('change', () => { this._decided = this.#onDecisions().catch(safetyCatch) })
    await this.#onDecisions()
  }

  // This device's log in the space: the first one not cut. A member removed
  // and let in again writes in a new log: the old one counts up to its cut
  // only, for good (research.md A4).
  async #openOwnLog (from = 0) {
    const me = this.hg._identity
    for (let n = from; ; n++) {
      const own = new OwnLog(this.store.get({ name: n ? `log/${n}` : 'log' }), { space: this.keyBytes, identity: me })
      await own.ready()
      own.generation = n
      if (!this.state.isCut(me.publicKey, own.key)) return own
      await own.core.close()
    }
  }

  async #onDecisions () {
    if (this.closed) return
    const me = this.hg._identity
    if (this.state.canWrite(me.publicKey) && this.state.isCut(me.publicKey, this.own.key)) {
      this.own = await this.#openOwnLog(this.own.generation + 1)
    }
    if (this.state.isMember(me.publicKey) && !this.directory.logs.has(hex(this.own.key))) {
      await this.directory.accept(this.own.key, this.own.core, { identity: me.publicKey, device: me.device.publicKey }, { own: true })
    }
    this.directory.recheck()
    await this.indexer.moderate()
    this.emit('_progress')
  }

  // --- records ---

  async put (type, values) {
    this.#mayPost()
    const v = this.types.validate(type, values)
    await this.#checkLinks(type, v)
    this.#checkRules(type, v)
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
    this.#checkRules(row.type, v, row.id)
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

  // The app's rules, as every member will check them.
  #checkRules (type, values, id = null) {
    if (!this.hg.rules.length) return
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
  // member since opening — or it is the space's only member.
  isComplete () {
    if (this.replicator.missing() > 0) return false
    if (this.directory.reached) return true
    const members = [...this.state.members.keys()]
    return members.length === 1 && members[0] === hex(this.hg._identity.publicKey)
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
    this.#mayDecide('decide', 'remove members')
    const role = this.state.roleOf(identity)
    if (!role) throw new HypergraphError('NOT_FOUND', 'Not a member of this space')
    if (!mayRemove(this.#myRole(), role, 'decide', this.state.roles)) throw new HypergraphError('NOT_ALLOWED', `You may not remove a member whose role is ${role}`)
    await this.#decide({ type: 'member/remove', identity, cut: this.#cutOf(identity) })
  }

  // Gives someone a role (v1's setRole): a built-in one ('admin', 'moderator',
  // 'member', 'guest') or one defined with defineRole. Someone not a member
  // yet becomes one. A role without `post` cuts what they wrote where this
  // member holds it.
  async setRole (who, role) {
    const identity = keyBytes(who, 'an identity')
    this.#mayDecide('roles', 'give roles')
    if (!this.state.permissionsOf(role)) throw new HypergraphError('NOT_FOUND', `No role "${role}" in this space (define it first: defineRole)`)
    if (this.state.isBanned(identity)) throw new HypergraphError('NOT_ALLOWED', 'This identity is banned from the space')
    if (!mayAssign(this.#myRole(), this.state.roleOf(identity), role, this.state.roles)) throw new HypergraphError('NOT_ALLOWED', `You may not give the role ${role} to this member`)
    await this.#decide({ type: 'role/set', identity, role, cut: this.#cutOf(identity) })
  }

  // A custom role and its permissions: hypergraph's own ('post', 'moderate',
  // 'invite', 'roles', 'decide') and the app's (e.g. 'edit-pages'). A role
  // can gain permissions later, but never lose 'post'.
  async defineRole (name, permissions) {
    this.#mayDecide('roles', 'define roles')
    if (typeof name !== 'string' || !name) throw new TypeError('A role name is a non-empty string')
    if (!Array.isArray(permissions) || !permissions.every((p) => typeof p === 'string' && p)) throw new TypeError('permissions is a list of names')
    if (ROLES[name]) throw new HypergraphError('NOT_ALLOWED', `"${name}" is a built-in role`)
    const before = this.state.permissionsOf(name)
    if (before && before.includes('post') && !permissions.includes('post')) {
      throw new HypergraphError('NOT_ALLOWED', `Role "${name}" cannot lose 'post': give its members another role instead`)
    }
    if (!grantable(this.#myRole(), permissions, this.state.roles)) throw new HypergraphError('NOT_ALLOWED', 'You may not hand on a permission you don\'t have')
    await this.#decide({ type: 'role/define', name, permissions })
  }

  // flag, hide, reveal, remove (a record, for good), or ban (an identity: out
  // for good; what they wrote up to what this member holds stays, anything
  // after is ignored). Moderators, admins and the owner.
  async moderateAction (action, target, { reason = '' } = {}) {
    if (!ACTIONS.includes(action)) throw new TypeError(`Moderation actions: ${ACTIONS.join(', ')}`)
    this.#mayDecide('moderate', 'moderate')
    if (action !== 'ban') return this.#decide({ type: 'moderate', action, target: idOf(target), reason, cut: [] })
    const identity = keyBytes(target, 'an identity')
    if (!mayRemove(this.#myRole(), this.state.roleOf(identity), 'moderate', this.state.roles)) {
      throw new HypergraphError('NOT_ALLOWED', 'You may not ban a member whose role is at or above yours')
    }
    await this.#decide({ type: 'moderate', action, target: identity, reason, cut: this.#cutOf(identity) })
  }

  // Appends a decision; resolves once this member applied it.
  async #decide (decision) {
    await this.decisions.append(decision)
    if (this._decided) await this._decided
  }

  #myRole () {
    return this.state.roleOf(this.hg._identity.publicKey)
  }

  // The cut of an identity's logs: where this member holds them.
  #cutOf (identity) {
    const cut = []
    for (const log of this.directory.logs.values()) {
      if (b4a.equals(log.identity, identity)) cut.push({ log: log.key, length: Math.min(log.indexed, log.limit) })
    }
    return cut
  }

  #mayDecide (permission, what) {
    if (this.closed) throw new HypergraphError('CLOSED', 'This space is closed')
    if (!this.state.can(this.hg._identity.publicKey, permission)) throw new HypergraphError('NOT_ALLOWED', `Your role does not allow you to ${what}`)
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
