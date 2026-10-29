// hypergraph/next: the new core (spec 011, specs/011-spaces-core/).
//
//   const { Hypergraph } = require('hypergraph/next')
//   const hg = await Hypergraph.open('./data', { types })
//
// One instance holds one identity and any number of spaces, in one storage
// folder (Corestore in cores/, the local index in index/), over one set of
// connections. Every identity also has a personal space, shared by its
// devices only (research.md A7). The public API is in contracts/api.md.

const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const c = require('compact-encoding')
const z32 = require('z32')
const Corestore = require('corestore')
const HyperDB = require('hyperdb')
const crypto = require('hypercore-crypto')
const safetyCatch = require('safety-catch')
const def = require('./index/spec/hyperdb')
const { WriteQueue } = require('./index/indexer.js')
const { keyBytes } = require('./index/query.js')
const { Types } = require('./types.js')
const { Identity } = require('./identity.js')
const { Stamper } = require('./stamp.js')
const { Network } = require('./network.js')
const { Pairing } = require('./pairing.js')
const { Space } = require('./space.js')
const { Decisions } = require('./decisions/log.js')
const { declareRules } = require('./gate.js')
const enc = require('./encodings.js')
const invites = require('./invites.js')
const symbols = require('./symbols.js')
const phrase = require('./phrase.js')
const storage = require('./storage.js')
const instance = require('./instance.js')
const { POLICIES } = require('./decisions/apply.js')
const { HypergraphError, codes } = require('./errors.js')

const JOIN_TIMEOUT = 30000 // joining: connecting alone can take seconds on a real network (ROADMAP 2026-10-09)
const REFUSALS = {
  INVITE_EXPIRED: 'This invite link has expired',
  INVITE_USED_UP: 'This invite link was already used as many times as it allows',
  INVITE_REVOKED: 'This invite link was revoked',
  NOT_ALLOWED: 'This invite link can\'t let you in: its maker may not give that role, or you are banned from the space'
}
const HEADS_MS = 10 * 60 * 1000 // how often a device writes its heads, if they changed (and at close)
const HOLD_MS = 300 // budget passes run this long after the last change
const RECLAIM_MS = 10 * 60 * 1000 // disk space of dropped content is reclaimed at most this often
const BLOB_FILE = 256e6 // hypercore-storage's blob file size
const hex = (b) => b4a.toString(b, 'hex')
const headList = c.array(enc.struct([['space', c.fixed32], ['log', c.fixed32], ['length', c.uint]]))

class Hypergraph extends EventEmitter {
  constructor (dir, opts) {
    super()
    this.dir = dir
    this.opts = opts
    this._types = new Types(opts.types || {})
    this.rules = declareRules(opts.rules || [])
    this._spaces = new Map() // space hex -> Space (the personal space included)
    this._logsOf = new Map() // top space hex -> { log: its decision log, refs, opening } (story 8: shared by its sub-spaces)
    this._personal = null
    this._wasAlone = false // a new identity, no device added since
    this._pairing = null
    this._settling = null
    this._heads = ''
    this._headsTimer = null
    this._budget = null // the app's budget, if set (setBudget, or open's `budget`)
    this._defaultBudget = storage.DEFAULT_BUDGET
    this._holdTimer = null
    this._holding = null
    this._holdAgain = false
    this.closed = false
    this._closing = null
  }

  // The clock decisions are stamped with (lib/testing.js setClock moves it).
  _now () {
    return Date.now() + (this._clockOffset || 0)
  }

  static async open (dir, opts = {}) {
    const hg = new Hypergraph(dir, opts)
    try {
      await hg._open()
    } catch (err) {
      await hg.close().catch(safetyCatch)
      throw err
    }
    return hg
  }

  async _open () {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }) // its owner's only: the device key is inside (audit 2)
    this.store = new Corestore(path.join(this.dir, 'cores'))
    await this.store.ready()
    this.db = await this.#openIndex()
    this._queue = new WriteQueue(this.db)
    // A lost or unreadable index is rebuilt from the held logs (FR-012): what
    // it can't be rebuilt from comes back from instance.json, and the logs
    // file names the logs to index again (lib/instance.js).
    this._logs = instance.readLogs(this.dir)
    const durable = instance.read(this.dir)
    this._rebuilding = !(await this.#meta('identity')) && !!(durable && durable.identity)
    if (this._rebuilding) await this.#restore(durable)

    const stored = await this.#meta('types')
    this._types.checkCompatible(stored)
    // The app learned a type or a type gained an index,
    // and the index holds records of it: rebuilt from the held logs, as by a
    // member who always had this version (story 7, research.md A11).
    const stale = this._types.stale(stored)
    if (stale.length && await this.#holdsAny(stale)) await this.#reindex()
    await this.#setMeta('types', this._types.describe())

    const device = await this.store.createKeyPair('hypergraph/device')
    this._stamper = new Stamper()
    // The swarm uses the device key pair: a connection's remote key is the
    // peer's device key, which its device proof binds to its identity
    // (space.peers(), lib/directory.js).
    this._network = new Network(this, { bootstrap: this.opts.bootstrap, keyPair: device })
    let create = null // the personal space's first key pair, for a new identity
    const saved = await this.#meta('identity')
    if (saved) {
      if (this.opts.joinCode) throw new HypergraphError('NOT_ALLOWED', 'This folder already holds an account; open an empty folder to add this device to one')
      this._identity = Identity.fromProof({ device, proof: b4a.from(saved.proof, 'hex') })
      if (!this._identity) throw new Error('This folder\'s identity proof does not match its device key')
      if (this.opts.mnemonic && !b4a.equals(await Identity.publicKeyOf(this.opts.mnemonic), this._identity.publicKey)) {
        throw new HypergraphError('NOT_ALLOWED', 'This folder already holds another identity; open an empty folder to restore one')
      }
      if (saved.mnemonic) { // folders from before the phrase had its own file
        phrase.save(this.dir, saved.mnemonic)
        await this.#setMeta('identity', { proof: saved.proof })
      }
      if (this.opts.password && phrase.isPlain(this.dir)) phrase.protect(this.dir, this.opts.password)
    } else {
      // A new identity, one restored from its phrase, or another device of
      // one, given its phrase by a device already in (lib/pairing.js).
      const mnemonic = this.opts.joinCode ? await this.#join(device) : (this.opts.mnemonic || null)
      this._identity = await Identity.create({ device, mnemonic })
      if (this.opts.password) phrase.saveSealed(this.dir, this._identity.recoveryPhrase, this.opts.password)
      else phrase.save(this.dir, this._identity.recoveryPhrase)
      const secrets = await Identity.secrets(this._identity.recoveryPhrase)
      if (!mnemonic) create = secrets.personal.keyPair
      await this.#setMeta('personal', { key: hex(Identity.personalKey(secrets.personal.keyPair, this.store.manifestVersion)), encryptionKey: hex(secrets.personal.encryptionKey) })
      await this.#setMeta('alone', !mnemonic)
      await this.#setMeta('identity', { proof: b4a.toString(this._identity.proof, 'hex') })
    }
    this._identity.recoveryPhrase = null // kept in its own file only (lib/phrase.js)
    this._wasAlone = !!(await this.#meta('alone'))
    this._left = new Set(await this.#meta('left') || []) // spaces left on this device (hex): not opened again from the personal space

    await this.#openPersonal(create)
    const rows = await this.db.find('@hg/spaces', {}).toArray()
    rows.sort((x, y) => (x.parent ? 1 : 0) - (y.parent ? 1 : 0)) // top spaces first: their sub-spaces share their decision log
    for (const row of rows) {
      const space = new Space(this, { key: row.key, ns: row.ns, root: row.parent || null })
      await space._open()
      this._spaces.set(space.hex, space)
      await this._network.join(space)
    }
    this._rebuilding = false
    this._opened = true
    this._openSubspaces().catch(safetyCatch)
    await this.#settle()
    await this.#openBudget()
    await this._saveInstance()
    this._headsTimer = setInterval(() => this._writeHeads().catch(safetyCatch), HEADS_MS)
    if (this._headsTimer.unref) this._headsTimer.unref()
  }

  // --- what the index can't be rebuilt from (lib/instance.js) ---

  // The index; an unreadable one is set aside (kept, never deleted) and a
  // new one rebuilt.
  async #openIndex () {
    const dir = path.join(this.dir, 'index')
    const db = HyperDB.rocks(dir, def)
    try {
      await db.ready()
      return db
    } catch (err) {
      await db.close().catch(safetyCatch)
      instance.setAside(dir)
      const fresh = HyperDB.rocks(dir, def)
      await fresh.ready()
      return fresh
    }
  }

  // Does the index hold records of any of `types`, in any space?
  async #holdsAny (types) {
    const spaces = (await this.db.find('@hg/spaces', {}).toArray()).map((row) => row.key)
    const personal = await this.#meta('personal')
    if (personal) spaces.push(b4a.from(personal.key, 'hex'))
    for (const space of spaces) {
      for (const type of types) if (await this.db.findOne('@hg/by-type', { gte: { space, type }, lte: { space, type } })) return true
    }
    return false
  }

  // Replaces the index with a new one, rebuilt from the held logs like a
  // lost one (instance.json written first, from the index being replaced).
  async #reindex () {
    await this._saveInstance()
    const durable = instance.read(this.dir)
    if (!durable || !durable.identity) return
    const dir = path.join(this.dir, 'index')
    await this.db.close()
    instance.remove(dir)
    this.db = HyperDB.rocks(dir, def)
    await this.db.ready()
    this._queue = new WriteQueue(this.db)
    this._rebuilding = true
    await this.#restore(durable)
  }

  // The index was lost: its settings and the spaces held come back from
  // instance.json; the spaces' logs are indexed again as they open.
  async #restore (durable) {
    for (const name of ['identity', 'personal', 'alone', 'types', 'budget', 'left']) {
      if (durable[name] !== undefined && durable[name] !== null) await this.#setMeta(name, durable[name])
    }
    for (const s of durable.spaces || []) {
      const key = b4a.from(s.key, 'hex')
      await this._queue.run((tx) => tx.insert('@hg/spaces', { key, ns: s.ns, name: s.name || '', parent: s.root ? b4a.from(s.root, 'hex') : null, joined: s.joined || 0 }))
      if (s.budget) await this.#setMeta('budget:' + s.key, s.budget)
    }
  }

  // Writes instance.json from the index's settings and the spaces held (one
  // write at a time).
  _saveInstance () {
    const next = (this._saving || Promise.resolve()).then(async () => {
      const out = {}
      for (const name of ['identity', 'personal', 'alone', 'types', 'budget', 'left']) out[name] = await this.#meta(name)
      out.spaces = []
      for (const row of await this.db.find('@hg/spaces', {}).toArray()) {
        const key = hex(row.key)
        out.spaces.push({ key, ns: row.ns, name: row.name, joined: row.joined, budget: await this.#meta('budget:' + key), ...(row.parent ? { root: hex(row.parent) } : {}) })
      }
      instance.write(this.dir, out)
    }).catch(safetyCatch)
    this._saving = next
    return next
  }

  // A log was accepted in `space`: named in the logs file, once.
  _logAccepted (space, key) {
    let known = this._logs.get(space.hex)
    if (!known) this._logs.set(space.hex, (known = new Set()))
    const h = hex(key)
    if (known.has(h)) return
    known.add(h)
    try { instance.addLog(this.dir, space.keyBytes, key) } catch (err) { safetyCatch(err) }
  }

  // The logs named for `space` (keys), to index again after the index was lost.
  _knownLogs (space) {
    return [...(this._logs.get(space.hex) || [])].map((h) => b4a.from(h, 'hex'))
  }

  // The personal space (research.md A7): created with a new identity (its
  // key comes from the phrase, so restoring finds it again), encrypted.
  async #openPersonal (keyPair) {
    const meta = await this.#meta('personal')
    if (!meta) return // a folder from before story 3 (recreate it)
    const space = new Space(this, { key: b4a.from(meta.key, 'hex'), ns: 'personal', personal: true, encryptionKey: b4a.from(meta.encryptionKey, 'hex'), keyPair })
    await space._open(keyPair ? { create: { name: '' } } : {})
    this._personal = space
    this._spaces.set(space.hex, space)
    space.on('_decided', () => this.#settle().catch(safetyCatch))
    space.on('change', ({ types }) => {
      if (types.includes('hg/space')) this.#settle().catch(safetyCatch)
      if (types.includes('hg/device') || types.includes('hg/device-remove')) this.emit('devices')
      if (types.includes('hg/setting')) this.emit('settings')
    })
    await this._network.join(space)
  }

  // Uses a join code: the phrase, from a device of the account.
  async #join (device) {
    await this._network.connect()
    const res = await this.#pairer().join(this.opts.joinCode, { device: device.publicKey, name: this.opts.deviceName || '', timeout: this.opts.joinTimeout })
    const secrets = await Identity.secrets(res.phrase)
    if (!secrets || !b4a.equals(secrets.publicKey, res.identity)) throw new HypergraphError('INVITE_INVALID', 'The device that answered sent a phrase for another account')
    return res.phrase
  }

  #pairer () {
    if (!this._pairing) this._pairing = new Pairing(this._network.swarm)
    return this._pairing
  }

  // Keeps this device and the personal space in step, once this device is in
  // it: its own device record, the spaces listed there joined here, the
  // spaces held here listed there. One run at a time; a call during one runs
  // another after it.
  #settle () {
    if (!this._settling) {
      this._settling = this.#settleOnce().finally(() => { this._settling = null })
      return this._settling
    }
    if (!this._settleAgain) {
      this._settleAgain = this._settling.then(() => {
        this._settleAgain = null
        return this.#settle()
      })
    }
    return this._settleAgain
  }

  async #settleOnce () {
    const personal = this._personal
    // Not before the spaces held here are open: a rebuild indexes the
    // personal space while they open, and joining one of them again would
    // open it twice (story 6).
    if (!this._opened || !personal || this.closed || personal.closed || !personal.state.isMember(this._identity.publicKey)) return
    if (personal.isRemoved(this._identity.publicKey, this._identity.device.publicKey)) return
    const me = this._identity.device.publicKey
    if (!(await this.#rows('hg/device')).some(({ values }) => b4a.equals(values.key, me))) {
      await personal._put('hg/device', { key: me, name: this.opts.deviceName || '' })
    }
    const listed = new Set()
    for (const { values } of await this.#rows('hg/space')) {
      listed.add(values.space)
      if (this.closed) return
      if (this._spaces.has(hex(z32.decode(values.space))) || this._left.has(hex(z32.decode(values.space)))) continue
      await this.#keep(await this[symbols.openSpace](values.space, { root: values.root || null }), false)
    }
    for (const space of this._spaces.values()) {
      if (space.personal || listed.has(space.key) || !space.state.isMember(this._identity.publicKey)) continue
      await personal._put('hg/space', { space: space.key, name: space.name || '', root: space.rootKey ? z32.encode(space.rootKey) : undefined })
    }
  }

  // The personal space's records of one of hypergraph's types, oldest first:
  // [{ row, values }].
  async #rows (type) {
    const personal = this._personal
    const key = { space: personal.keyBytes, type }
    const rows = await this.db.find('@hg/by-type', { gte: key, lte: key }).toArray()
    return rows.map((row) => ({ row, values: this._types.decode(type, row.fields, row.links) }))
  }

  async #meta (name) {
    const row = await this.db.get('@hg/meta', { name })
    return row ? JSON.parse(b4a.toString(row.value)) : null
  }

  #setMeta (name, value) {
    return this._queue.run((tx) => tx.insert('@hg/meta', { name, value: b4a.from(JSON.stringify(value)) }))
  }

  // --- identity ---

  get identity () { return { publicKey: z32.encode(this._identity.publicKey) } }
  get device () { return { publicKey: z32.encode(this._identity.device.publicKey) } }

  // The 24 words that restore this identity elsewhere: null if forgotten
  // here; once protected, only with the password (NOT_ALLOWED otherwise).
  async recoveryPhrase (password) {
    this.#open()
    return phrase.open(this.dir, password)
  }

  // Right after showing the phrase, apps ask the person to choose: keep it on
  // this device behind a password, or forget it here.
  async protectRecoveryPhrase (password) {
    this.#open()
    phrase.protect(this.dir, password)
  }

  async forgetRecoveryPhrase () {
    this.#open()
    phrase.forget(this.dir)
  }

  // The phrase and what it gives, from this device (`password` if protected)
  // or typed (`recoveryPhrase`); NOT_ALLOWED otherwise.
  async #secrets ({ password, recoveryPhrase } = {}, what) {
    const words = recoveryPhrase || phrase.open(this.dir, password)
    if (!words) throw new HypergraphError('NOT_ALLOWED', `This device no longer holds the recovery phrase: type it to ${what} ({ recoveryPhrase })`)
    const secrets = await Identity.secrets(words)
    if (!secrets || !b4a.equals(secrets.publicKey, this._identity.publicKey)) throw new HypergraphError('NOT_ALLOWED', 'That is not this account\'s recovery phrase')
    return { words, secrets }
  }

  // --- devices and the personal space (research.md A7) ---

  // The personal Space: shared by this identity's devices only.
  get personal () {
    if (!this._personal) throw new HypergraphError('NOT_FOUND', 'This folder has no personal space (made before story 3: recreate it)')
    return this._personal
  }

  // A code for a new device of this account: { code, added }. `added`
  // resolves to the new device ({ publicKey, name }), or null once the code
  // expires (`timeout`, default 10 minutes) unused. The new device receives
  // the recovery phrase: `password` if it is protected here,
  // `recoveryPhrase` if it was forgotten here.
  async addDevice ({ password, recoveryPhrase, timeout } = {}) {
    this.#open()
    const personal = this.personal
    const { words } = await this.#secrets({ password, recoveryPhrase }, 'add a device')
    await this.connectToSwarm()
    if (this._wasAlone) {
      this._wasAlone = false
      await this.#setMeta('alone', false)
      await this._saveInstance()
    }
    const { code, added } = await this.#pairer().add({ key: personal.keyBytes, encryptionKey: personal.encryptionKey, identity: this._identity.publicKey, phrase: words, timeout })
    // Listed at once (the new device lists itself too, once it is in).
    const listed = added.then(async (device) => {
      if (device && !this.closed) await personal._put('hg/device', { key: z32.decode(device.publicKey), name: device.name }).catch(safetyCatch)
      return device
    })
    return { code, added: listed }
  }

  // This identity's devices: [{ publicKey, name, current }], removed ones left out.
  async devices () {
    this.#open()
    const personal = this.personal
    const me = this._identity.device.publicKey
    const out = new Map()
    for (const { values } of await this.#rows('hg/device')) {
      if (personal.isRemoved(this._identity.publicKey, values.key)) continue
      out.set(hex(values.key), { publicKey: z32.encode(values.key), name: values.name || '', current: b4a.equals(values.key, me) })
    }
    return [...out.values()]
  }

  // Removes a lost device, in every space: what it wrote up to where this
  // device holds it (or its last heads say) stays, nothing after counts.
  // Needs the recovery phrase: `password` if protected here, or typed.
  async removeDevice (publicKey, { password, recoveryPhrase } = {}) {
    this.#open()
    const device = keyBytes(publicKey, 'a device')
    if (b4a.equals(device, this._identity.device.publicKey)) throw new HypergraphError('NOT_ALLOWED', 'This is the device you are on: remove it from another one')
    if (b4a.equals(device, this._identity.publicKey)) throw new HypergraphError('NOT_ALLOWED', 'That is the account\'s key, not a device')
    const known = (await this.#rows('hg/device')).some(({ values }) => b4a.equals(values.key, device))
    if (!known) throw new HypergraphError('NOT_FOUND', `${publicKey} is not a device of this account`)
    const { secrets } = await this.#secrets({ password, recoveryPhrase }, 'remove a device')
    await this._removeDevice(device, secrets)
  }

  // Writes the removal in every space this identity is a member of.
  async _removeDevice (device, secrets) {
    const heads = await this.#headsOf(device)
    for (const space of [...this._spaces.values()]) {
      if (!space.state.isMember(this._identity.publicKey)) continue
      await space._removeDevice(device, secrets, heads.get(space.hex) || {})
    }
  }

  // The settings of this person, the same on all their devices: { name: value }.
  async settings () {
    this.#open()
    this.personal // eslint-disable-line no-unused-expressions
    const out = {}
    for (const { values } of await this.#rows('hg/setting')) out[values.name] = JSON.parse(values.value)
    return out
  }

  // `value`: anything JSON can hold. The latest set, from any device, wins.
  async setSetting (name, value) {
    this.#open()
    if (typeof name !== 'string' || !name) throw new TypeError('A setting\'s name is a non-empty string')
    await this.personal._put('hg/setting', { name, value: JSON.stringify(value === undefined ? null : value) })
  }

  // Writes this device's heads (its log lengths in every space) to the
  // personal space, if they changed: another device removing this one cuts
  // its logs there at least.
  async _writeHeads () {
    const personal = this._personal
    if (!personal || this.closed || personal.closed || !personal.state.isMember(this._identity.publicKey)) return
    if (personal.isRemoved(this._identity.publicKey, this._identity.device.publicKey)) return
    const heads = []
    for (const space of this._spaces.values()) {
      if (space.personal) continue // it changes with every heads record
      for (const { log, length } of space._heads()) heads.push({ space: space.keyBytes, log, length })
    }
    const bytes = c.encode(headList, heads)
    if (hex(bytes) === this._heads) return
    await personal._put('hg/heads', { heads: bytes })
    this._heads = hex(bytes)
  }

  // A device's last heads: Map space hex -> { log hex: length }.
  async #headsOf (device) {
    const out = new Map()
    const key = { space: this.personal.keyBytes, type: 'hg/heads' }
    let last = null
    const stream = this.db.find('@hg/by-type', { gte: key, lte: key }, { reverse: true })
    for await (const row of stream) {
      if (!b4a.equals(row.device, device)) continue
      last = this._types.decode('hg/heads', row.fields, row.links)
      break
    }
    await stream.destroy()
    if (!last) return out
    for (const { space, log, length } of c.decode(headList, last.heads)) {
      if (!out.has(hex(space))) out.set(hex(space), {})
      out.get(hex(space))[hex(log)] = length
    }
    return out
  }

  // Only this device, of a new identity: a space where it is the only member
  // has nobody to wait for (Space.isComplete).
  get _alone () {
    if (!this._wasAlone || !this._personal) return false
    const me = this._identity.device.publicKey
    for (const log of this._personal.directory.logs.values()) {
      if (!b4a.equals(log.device, me) && !b4a.equals(log.device, this._identity.publicKey)) return false
    }
    return true
  }

  // --- storage budgets (story 6, research.md A10) ---

  // The app's budget (bytes): set with setBudget(), or 5 GB, or what it holds
  // plus half the free disk if that is smaller.
  get budget () {
    return this._budget ?? this._defaultBudget
  }

  async #openBudget () {
    const saved = await this.#meta('budget')
    this._budget = saved ?? this.opts.budget ?? null
    this._defaultBudget = storage.defaultBudget({ free: await storage.freeDisk(this.dir), used: this.#used() })
    this._holdLater()
  }

  // Sets the app's budget in bytes (null: the default). Spaces' own budgets
  // must fit in it (NOT_ALLOWED).
  async setBudget (bytes) {
    this.#open()
    if (bytes !== null && !(Number.isFinite(bytes) && bytes > 0)) throw new TypeError('A budget is a number of bytes, or null for the default')
    let own = 0
    for (const space of this._spaces.values()) own += space._budget || 0
    if (bytes !== null && own > bytes) throw new HypergraphError('NOT_ALLOWED', `Spaces' own budgets add up to more than that (${own} bytes)`)
    this._budget = bytes
    await this.#setMeta('budget', bytes)
    await this._saveInstance()
    await this._holdNow()
  }

  // { budget, used, free }: the app's budget, what it stores (estimated, the
  // personal space and decision logs included), and the free disk (null if
  // this runtime can't tell).
  async storage () {
    this.#open()
    return { budget: this.budget, used: this.#used(), free: await storage.freeDisk(this.dir) }
  }

  #used () {
    let n = storage.INSTANCE
    for (const space of this._spaces.values()) n += space._usage().stored
    return n
  }

  async _loadBudget (space) {
    return (await this.#meta('budget:' + space.hex)) ?? null
  }

  async _saveBudget (space, bytes) {
    await this.#setMeta('budget:' + space.hex, bytes)
    await this._saveInstance()
  }

  // A budget pass soon (after indexing, decisions, budgets changing).
  _holdLater () {
    if (this._holdTimer || this.closed) return
    this._holdTimer = setTimeout(() => {
      this._holdTimer = null
      this._holdNow().catch(safetyCatch)
    }, HOLD_MS)
    if (this._holdTimer.unref) this._holdTimer.unref()
  }

  // Shares the app's budget between the spaces (lib/storage.js) and keeps
  // each within its share. One pass at a time; a call during one runs
  // another after it.
  async _holdNow () {
    if (this._holding) {
      this._holdAgain = true
      return this._holding
    }
    this._holding = (async () => {
      do {
        this._holdAgain = false
        await this.#hold()
      } while (this._holdAgain && !this.closed)
    })()
    try {
      await this._holding
    } finally {
      this._holding = null
    }
  }

  async #hold () {
    const spaces = [...this._spaces.values()].filter((s) => !s.closed)
    if (this.closed || !spaces.length) return
    const list = spaces.map((s) => {
      const { stored, floor } = s._usage()
      return { id: s.hex, used: stored, floor, budget: s._budget, keep: s.personal }
    })
    const shares = storage.shares({ app: this.budget, fixed: storage.INSTANCE, spaces: list })
    // Over budget with nothing left to drop: a space with its own budget whose
    // floor is above it, or any space at its floor when the floors alone fill
    // the app's budget.
    const floors = list.reduce((n, s) => n + s.floor, storage.INSTANCE)
    for (const [i, space] of spaces.entries()) {
      if (this.closed) return
      const { floor, budget } = list[i]
      const share = shares.get(space.hex)
      const over = !space.personal && (floor > (budget ?? Infinity) * 1.1 || (floors > this.budget * 1.1 && floor >= share))
      await space._hold(share, over).catch(safetyCatch)
      space._statusChanged()
    }
  }

  // Disk space freed by dropping content comes back only when RocksDB
  // compacts, and block contents over 4 KB live in blob files it collects
  // late (hypercore-storage's settings: 256 MB files, the oldest quarter
  // collected). After a tenth of the budget was dropped, at most every 10
  // minutes, both databases are compacted, collecting the blob files that
  // hold dropped content (research.md A10).
  _dropped (bytes) {
    this._droppedSince = (this._droppedSince || 0) + bytes
    if (this._reclaiming || this.closed || this._droppedSince < this.budget / 10) return
    if (Date.now() - (this._reclaimed || 0) < RECLAIM_MS) return
    this._reclaimNow().catch(safetyCatch)
  }

  // Reclaims now (tests, through lib/testing.js: the same step, without the wait).
  async _reclaimNow () {
    while (this._reclaiming) await this._reclaiming
    this._droppedSince = 0
    this._reclaimed = Date.now()
    this._reclaiming = this.#reclaim().catch(safetyCatch).finally(() => { this._reclaiming = null })
    await this._reclaiming
  }

  async #reclaim () {
    const files = Math.max(1, Math.ceil((this.#used() / 2) / BLOB_FILE))
    const cutoff = Math.min(1, Math.max(0.25, 1 / files))
    // rocksdb-native's constants: garbageCollectionPolicy.FORCE = 1
    await this.store.storage.db.compactRange({ blobGarbageCollectionPolicy: 1, blobGarbageCollectionAgeCutoff: cutoff })
    if (!this.closed) await this.db.engine.db.compactRange()
  }

  // --- network ---

  // One call: finds the members of every space, now and later.
  async connectToSwarm () {
    this.#open()
    await this._network.connect()
  }

  // --- spaces ---

  // policy: 'auto' (each member keeps what fits, then the newest part plus
  // what it reads) or 'everything' (every member is asked to keep it all).
  async createSpace ({ name = '', policy = 'auto', private: priv = false } = {}) {
    this.#open()
    if (!POLICIES.includes(policy)) throw new TypeError(`A policy is ${POLICIES.map((p) => `'${p}'`).join(' or ')}`)
    const space = new Space(this, { ns: hex(crypto.randomBytes(16)) })
    await space._open({ create: { name, policy, private: !!priv } })
    if (this.rules.length) await space.setRules() // the creator's app rules are the space's
    await this.#keep(space)
    await space._startKeys() // a private one's first key (story 8)
    return space
  }

  // Joins the space an invite link is for; resolves to it once a member who
  // records decisions has let us in. Waits up to 30 s (`timeout` overrides
  // it; ordinary reads keep their bound); a refusal says why
  // (INVITE_EXPIRED, INVITE_USED_UP, INVITE_REVOKED, NOT_ALLOWED), and nobody
  // able to let us in answering within it is INVITE_INVALID.
  async redeemInvite (link, { timeout = JOIN_TIMEOUT } = {}) {
    this.#open()
    const inv = invites.decodeLink(link)
    if (inv.expires && Date.now() > inv.expires) throw new HypergraphError('INVITE_EXPIRED', 'This invite link has expired')
    const held = this._spaces.has(hex(inv.space))
    const root = b4a.equals(inv.root, inv.space) ? null : inv.root // a sub-space's invite (story 8)
    const space = await this[symbols.openSpace](inv.space, { root })
    await this.connectToSwarm()
    const result = await space._redeem(invites.makeRedemption(inv, this._identity, space.decisionLog.localKey), timeout)
    if (result !== true) {
      if (!held) await this.#drop(space)
      if (result) throw new HypergraphError(result, REFUSALS[result])
      throw new HypergraphError('INVITE_INVALID', `No member able to let you in answered within ${Math.round(timeout / 1000)} s (they may be offline: try again later)`)
    }
    await this.#keep(space)
    return space
  }

  // A space opened here but not joined: closed and forgotten.
  async #drop (space) {
    this._spaces.delete(space.hex)
    await this._network.leave(space).catch(safetyCatch)
    await space.close().catch(safetyCatch)
  }

  // The declared record types: { name: { fields: { field: kind }, links,
  // onePerMember, editable, index, builtin } }, hypergraph's own included
  // (builtin: true). `editable`: 'author' | 'members' | { permission }.
  types () {
    const out = {}
    for (const name of this._types.names()) {
      const t = this._types.get(name)
      const editable = t.editable.by === 'permission' ? { permission: t.editable.permission } : t.editable.by
      out[name] = { fields: Object.fromEntries(t.fields.map((f) => [f.name, f.kind])), links: Object.fromEntries(Object.entries(t.links).map(([f, targets]) => [f, [...targets]])), onePerMember: t.onePerMember, editable, index: t.index.map((keys) => [...keys]), builtin: name.startsWith('hg/') }
    }
    return out
  }

  // The spaces held here: [{ key, name, parent }] (not the personal space;
  // parent: the space a sub-space is in). 'spaces' (the list) when one is
  // kept here (created, joined, from another device's list) or left.
  spaces () {
    return [...this._spaces.values()].filter((s) => !s.personal).map((s) => ({ key: s.key, name: s.name, parent: s.parent }))
  }

  // 'spaces' when what spaces() returns differs from the last one sent: a space
  // kept or left, a name or a parent arriving (spec 012, SwarmFS H12).
  _spacesChanged () {
    if (this.closed) return
    const spaces = this.spaces()
    const sig = JSON.stringify(spaces)
    if (sig === this._spacesSig) return
    this._spacesSig = sig
    this.emit('spaces', spaces)
  }

  // Drops a space from this device, its sub-spaces held here with it: closed,
  // its logs and index rows deleted, and not opened again here (from the
  // personal space's list) unless joined again. Membership doesn't change;
  // other members and this identity's other devices keep theirs.
  async leaveSpace (key) {
    this.#open()
    const space = this.space(key)
    const spaces = [...this._below(space), space]
    for (const s of spaces) {
      this._spaces.delete(s.hex)
      this._left.add(s.hex)
      await this._network.leave(s)
      await s.close()
    }
    await this.#setMeta('left', [...this._left])
    this._spacesChanged()
    for (const s of spaces) await this.#purge(s)
    await this._saveInstance()
  }

  // Deletes what this device holds of a space just closed: the blocks of its
  // logs and its rows in the index.
  // shortcut: the logs' trees and the decision log stay (small; a named core
  // deleted from Corestore can't be made again under its name, so rejoining
  // would fail); delete the cores once Hypercore's purge() works (11.37 calls
  // methods that don't exist).
  async #purge (space) {
    const keys = [space.own.core.key, space._idcore.key, ...[...space.directory.logs.values()].map((log) => log.key)]
    for (const k of keys) {
      const core = this.store.get({ key: k }) // a session of its own: the space's are closed
      await core.ready().then(() => core.clear(0, core.length)).catch(safetyCatch)
      await core.close().catch(safetyCatch)
    }
    const key = space.keyBytes
    for (const name of ['@hg/records', '@hg/logs', '@hg/changes', '@hg/activity']) {
      for (;;) {
        const rows = await this.db.find(name, { gte: { space: key }, lte: { space: key }, limit: 1000 }).toArray()
        if (!rows.length) break
        await this._queue.run(async (tx) => { for (const row of rows) await tx.delete(name, row) })
      }
    }
    const meta = (await this.db.find('@hg/meta', {}).toArray()).filter((row) => row.name.includes(space.hex)) // budget:, limit:, reading and dropped rows
    await this._queue.run(async (tx) => {
      await tx.delete('@hg/spaces', { key })
      for (const row of meta) await tx.delete('@hg/meta', row)
    })
  }

  space (key) {
    let bytes = null
    try { bytes = typeof key === 'string' ? z32.decode(key) : key } catch {}
    const space = bytes && this._spaces.get(hex(bytes))
    if (!space || space.personal) throw new HypergraphError('NOT_FOUND', `No space ${key} here`)
    return space
  }

  // Opens a space by key without joining it (redeemInvite; listed spaces;
  // tests). `encryptionKey`: tests only (a stranger holding a personal
  // space's keys).
  async [symbols.openSpace] (key, { encryptionKey = null, root = null } = {}) {
    const bytes = typeof key === 'string' ? z32.decode(key) : key
    const held = this._spaces.get(hex(bytes))
    if (held) return held
    // One open at a time per space: two would open its decision log twice.
    if (!this._opening) this._opening = new Map()
    const opening = this._opening.get(hex(bytes))
    if (opening) return opening
    const open = (async () => {
      const space = new Space(this, { key: bytes, ns: hex(bytes), encryptionKey, root: root ? (typeof root === 'string' ? z32.decode(root) : root) : null, fresh: true })
      await space._open()
      this._spaces.set(space.hex, space)
      await this._network.join(space)
      return space
    })()
    this._opening.set(hex(bytes), open)
    try {
      return await open
    } finally {
      this._opening.delete(hex(bytes))
    }
  }

  // --- sub-spaces (story 8, research.md A13) ---

  // The decision log of top space `key`, shared by the space and its
  // sub-spaces (opening one Autobase twice hangs): the one held, or a new one
  // (`make()`, or in the namespace of its key). Released with
  // _releaseDecisions().
  async _decisions (key, make = null) {
    const h = hex(key)
    let entry = this._logsOf.get(h)
    if (!entry) {
      const log = make ? make() : new Decisions(this.store.namespace(h), key, { identity: this._identity, wakeup: this._network.wakeup, now: () => this._now() })
      entry = { log, refs: 0, ready: log.ready() }
      this._logsOf.set(h, entry)
    }
    entry.refs++
    await entry.ready
    return entry.log
  }

  // A space just created its decision log: shared from now on.
  _shareDecisions (key, log) {
    this._logsOf.set(hex(key), { log, refs: 1, ready: Promise.resolve() })
  }

  async _releaseDecisions (key) {
    const entry = this._logsOf.get(hex(key))
    if (!entry || --entry.refs > 0) return
    this._logsOf.delete(hex(key))
    await entry.log.close().catch(safetyCatch)
  }

  // Opens and keeps sub-space `key` of top space `root`.
  async _openSubspace (key, root) {
    const space = await this[symbols.openSpace](key, { root })
    await this.#keep(space)
    return space
  }

  // The sub-spaces held here below `space`, at any depth.
  _below (space) {
    const out = []
    const subs = space.decisionLog.state.subspaces
    const target = space.rootKey ? space.hex : null
    for (const s of this._spaces.values()) {
      if (s === space || !s.rootKey || !b4a.equals(s.rootKey, space.top)) continue
      for (let info = subs.get(s.hex); info; info = info.parent ? subs.get(info.parent) : null) {
        if (info.parent === target) {
          out.push(s)
          break
        }
      }
    }
    return out
  }

  // Members of a space have its sub-spaces without joining: each one this
  // identity is in, right inside a space held here, is opened and kept. One
  // run at a time; a call during one runs another after it.
  async _openSubspaces () {
    if (this._subsRunning) {
      this._subsAgain = true
      return
    }
    this._subsRunning = true
    try {
      do {
        this._subsAgain = false
        await this.#openSubspacesOnce()
      } while (this._subsAgain && !this.closed)
    } finally {
      this._subsRunning = false
    }
  }

  async #openSubspacesOnce () {
    if (!this._opened || this.closed) return
    const me = this._identity.publicKey
    for (const space of [...this._spaces.values()]) {
      if (space.personal || space.closed) continue
      const st = space.decisionLog.state
      const here = space.rootKey ? space.hex : null
      for (const [key, info] of st.subspaces) {
        if (this.closed) return
        if (info.parent !== here || this._spaces.has(key) || this._left.has(key) || !st.sub(key).isMember(me)) continue
        await this._openSubspace(b4a.from(key, 'hex'), space.top).catch(safetyCatch)
      }
    }
  }

  // Keeps a space here for good; lists it in the personal space (so this
  // identity's other devices join it too) unless it came from there.
  async #keep (space, list = true) {
    this._spaces.set(space.hex, space)
    if (this._left.delete(space.hex)) await this.#setMeta('left', [...this._left]) // joined again
    await this._queue.run((tx) => tx.insert('@hg/spaces', { key: space.keyBytes, ns: space.ns, name: space.name || '', parent: space.rootKey || null, joined: Date.now() }))
    await this._saveInstance()
    await this._network.join(space)
    this._spacesChanged()
    if (list) await this.#settle().catch(safetyCatch)
  }

  #open () {
    if (this.closed) throw new HypergraphError('CLOSED', 'This hypergraph is closed')
  }

  close () {
    if (!this._closing) this._closing = this.#close()
    return this._closing
  }

  async #close () {
    if (this._headsTimer) clearInterval(this._headsTimer)
    if (this._holdTimer) clearTimeout(this._holdTimer)
    if (this._holding) await this._holding.catch(safetyCatch)
    if (this._reclaiming) await this._reclaiming
    if (this._saving) await this._saving
    await this._writeHeads().catch(safetyCatch)
    this.closed = true
    if (this._settling) await this._settling.catch(safetyCatch)
    if (this._pairing) await this._pairing.close().catch(safetyCatch)
    if (this._network) await this._network.close().catch(safetyCatch)
    for (const space of this._spaces.values()) await space.close().catch(safetyCatch)
    if (this._queue) await this._queue.idle()
    if (this.db) await this.db.close().catch(safetyCatch)
    if (this.store) await this.store.close().catch(safetyCatch)
  }
}

module.exports = { Hypergraph, HypergraphError, codes }
