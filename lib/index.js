// hypergraph/next: the new core.
//
//   const { Hypergraph } = require('hypergraph/next')
//   const hg = await Hypergraph.open('./data', { types })
//
// One instance holds one identity and any number of spaces, in one storage
// folder (Corestore in cores/, the local index in index/), over one set of
// connections. Every identity also has a personal space, shared by its
// devices only. The public API: docs/next/api.md.

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
const { Holding, coreKeys } = require('./holding.js')
const { Pairing } = require('./pairing.js')
const { Joiner } = require('./joiner.js')
const Autobase = require('autobase')
const { Space } = require('./space.js')
const { scope } = require('./scope.js')
const { Decisions } = require('./decisions/log.js')
const { declareRules } = require('./gate.js')
const enc = require('./encodings.js')
const invites = require('./invites.js')
const symbols = require('./symbols.js')
const phrase = require('./phrase.js')
const storage = require('./storage.js')
const instance = require('./instance.js')
const { POLICIES } = require('./decisions/apply.js')
const { behind } = require('./replication.js')
const { HypergraphError, codes } = require('./errors.js')

const JOIN_TIMEOUT = 30000 // joining: connecting alone can take seconds on a real network
const REFUSALS = {
  INVITE_EXPIRED: 'This invite link has expired',
  INVITE_USED_UP: 'This invite link was already used as many times as it allows',
  INVITE_REVOKED: 'This invite link was revoked',
  NOT_ALLOWED: 'This invite link can\'t let you in: its maker may not give that role, or you are banned from the space',
  CIRCLE_FULL: 'This circle already has 50 members'
}
const HEADS_MS = 10 * 60 * 1000 // how often a device writes its heads, if they changed (and at close)
const HOLD_MS = 300 // budget passes run this long after the last change
const RECLAIM_MS = 10 * 60 * 1000 // disk space of dropped content is reclaimed at most this often
const REPOST_TRIES = 30 // late writes the old space can't open yet are tried again this many times, a second apart
const MOVED_MS = 30 * 24 * 3600 * 1000 // a space that moved is kept this long after the move
const BLOB_FILE = 256e6 // hypercore-storage's blob file size
const MAX_OPEN = 64 // spaces open at once (16 on a phone is the app's call)
const MAX_ANNOUNCED = 32 // the seeded set: spaces kept open and announced (8 on a phone)
const OPEN_BYTES = 250e3 // memory of an open space, plus LOG_BYTES per log open
const LOG_BYTES = 18e3
const PINNED = 'hg/pinned' // the setting holding the pinned spaces' keys
const IDLE_MS = 120000 // an unused space not seeded closes after this
const hex = (b) => b4a.toString(b, 'hex')
const headList = c.array(enc.struct([['space', c.fixed32], ['log', c.fixed32], ['length', c.uint]]))

/**
 * One person's hypergraph on one device: one identity, its devices, its spaces and their records,
 * in one storage folder, over one set of connections. Open it with {@link Hypergraph.open}.
 *
 * Errors are {@link HypergraphError}s with a `code`. Any call after {@link Hypergraph#close} throws `CLOSED`.
 * @extends EventEmitter
 * @fires Hypergraph#spaces
 * @fires Hypergraph#devices
 * @fires Hypergraph#settings
 * @fires Hypergraph#copies
 */
class Hypergraph extends EventEmitter {
  constructor (dir, opts) {
    super()
    // How many spaces stay open, topics announced, bytes open
    // spaces may take (none: only maxOpen), and how long an unused space
    // stays open.
    for (const name of ['maxOpen', 'maxAnnounced', 'memory', 'idleMs']) {
      const v = opts[name]
      if (v !== undefined && v !== null && !(typeof v === 'number' && v > 0)) throw new TypeError(`${name} is a positive number`)
    }
    this.dir = dir
    this.opts = opts
    this.maxOpen = opts.maxOpen || MAX_OPEN
    this.maxAnnounced = opts.maxAnnounced || MAX_ANNOUNCED
    this.idleMs = opts.idleMs || IDLE_MS
    this.memory = opts.memory || null
    this._pins = new Set() // z32 keys of the spaces pinned (a setting of the person's, shared by their devices)
    this._lastHeads = new Map() // space hex -> this device's heads there at its last record (closed spaces)
    this._types = new Types(opts.types || {})
    this.rules = declareRules(opts.rules || [])
    this._spaces = new Map() // space hex -> Space (the personal space included)
    this._diskKeys = new Map() // top space hex -> a private space's disk key (@hg/meta disk-keys)
    this._joiners = new Map() // space hex -> the joiner waiting for its disk key (lib/joiner.js)
    this._logsOf = new Map() // top space hex -> { log: its decision log, refs, opening } (shared by its sub-spaces)
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
    this._moved = {} // loaded at open
  }

  // The clock decisions are stamped with (lib/testing.js setClock moves it).
  _now () {
    return Date.now() + (this._clockOffset || 0)
  }

  /**
   * Opens (or creates) the hypergraph in folder `dir`. A new folder gets a new identity, unless
   * `mnemonic` restores one or `joinCode` adds this device to an existing one.
   * @param {string} dir The storage folder (created if missing, readable by its owner only on Linux and macOS).
   * @param {object} [opts]
   * @param {Object<string, object>} [opts.types] The app's record types: `{ name: { fields, links, onePerMember, editable, put, index } }`. None for an engine serving many apps.
   * @param {Array<{id: string, validate: function}>} [opts.rules] The app's rules: `validate(record, { space })` returning false or throwing rejects a record.
   * @param {string} [opts.mnemonic] A 24-word recovery phrase, to restore an identity in a new folder.
   * @param {string} [opts.password] Keeps the recovery phrase sealed by this password from the first moment.
   * @param {string} [opts.joinCode] A code from {@link Hypergraph#addDevice} on a device already in: this folder becomes another device of that identity.
   * @param {string} [opts.deviceName=''] This device's name, shown in {@link Hypergraph#devices}.
   * @param {number} [opts.joinTimeout] How long to wait for the device that made `joinCode` (ms).
   * @param {Array} [opts.bootstrap] DHT bootstrap nodes (tests use a local DHT); the public DHT by default.
   * @param {number} [opts.budget] The app's storage budget in bytes; see {@link Hypergraph#setBudget}.
   * @param {number} [opts.maxAnnounced=32] Spaces kept open and online (pinned, own, recent). 8 suits a phone.
   * @param {number} [opts.maxOpen=64] Spaces open at once, at most. 16 suits a phone.
   * @param {number} [opts.idleMs=120000] A space outside the kept-open set closes this long after its last use.
   * @param {number} [opts.memory] Bytes open spaces may take (estimated), as well as `maxOpen`.
   * @returns {Promise<Hypergraph>}
   * @throws {HypergraphError} `NOT_ALLOWED` when `joinCode` or `mnemonic` is given for a folder that already holds another account.
   * @throws {TypeError} When `maxOpen`, `maxAnnounced`, `memory` or `idleMs` is not a positive number.
   */
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
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }) // its owner's only: the device key is inside
    this.store = new Corestore(path.join(this.dir, 'cores'))
    await this.store.ready()
    this.db = await this.#openIndex()
    this._queue = new WriteQueue(this.db)
    // A lost or unreadable index is rebuilt from the held logs: what
    // it can't be rebuilt from comes back from instance.json, and the logs
    // file names the logs to index again (lib/instance.js).
    this._logs = instance.readLogs(this.dir)
    const durable = instance.read(this.dir)
    this._rebuilding = !(await this.#meta('identity')) && !!(durable && durable.identity)
    if (this._rebuilding) await this.#restore(durable)

    // Types are checked per space, as each opens (lib/space.js
    // #checkTypes): a space whose types this app breaks refuses its calls,
    // the others work. The folder-wide `types` (folders from before) is read
    // for spaces without their own.
    this._oldTypes = await this.#meta('types')
    for (const [h, k] of Object.entries((await this.#meta('disk-keys')) || {})) this._diskKeys.set(h, b4a.from(k, 'hex'))

    const device = await this.store.createKeyPair('hypergraph/device')
    this._stamper = new Stamper()
    // The swarm uses the device key pair: a connection's remote key is the
    // peer's device key, which its device proof binds to its identity
    // (space.peers(), lib/directory.js).
    this._network = new Network(this, { bootstrap: this.opts.bootstrap, keyPair: device, maxAnnounced: this.maxAnnounced })
    this._circles = new Holding(this)
    await this._circles.open()
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
    this._leftWith = await this.#meta('left-with') || {} // sub-space hex -> the top space hex it was left with: joined again with it
    this._moved = await this.#meta('moved') || {} // old space hex -> { to: hex, at: ms } (sub-spaces too)

    await this.#openPersonal(create)
    await this.#loadPins()
    if (this._personal) this._lastHeads = await this.#headsOf(this._identity.device.publicKey)
    // Every space held is known (closed); only the seeded set opens
    // now, the others on their first use. A rebuild opens them all: their
    // logs are indexed again as they open.
    const rows = await this.db.find('@hg/spaces', {}).toArray()
    rows.sort((x, y) => (x.parent ? 1 : 0) - (y.parent ? 1 : 0)) // top spaces first: their sub-spaces share their decision log
    for (const row of rows) {
      const info = (await this.#meta('space:' + hex(row.key))) || {}
      const space = new Space(this, { key: row.key, ns: row.ns, root: row.parent || null, name: row.name || '', parent: info.parent || null })
      space._used = info.used || row.joined || 0
      space._own = !!info.own
      space._circle = !!info.circle
      space._pinned = this._pins.has(space.key)
      this._spaces.set(space.hex, space)
    }
    this.#reseed()
    const waiting = new Set()
    for (const space of [...this._spaces.values()]) {
      if (space.personal || !(space._seeded || this._rebuilding)) continue
      if (this._rebuilding) await space._ready()
      else if (space.rootKey && waiting.has(hex(space.rootKey))) space._ready().catch(safetyCatch)
      else if (await this.#openOrWait(space) === 'waiting') waiting.add(space.hex)
    }
    this._rebuilding = false
    this._opened = true
    await this._dropMoved()
    // spaces that moved are opened (served for late devices; this
    // device's late writes there re-posted: lib/space.js _repost)
    for (const h of Object.keys(this._moved)) if (this._spaces.has(h)) this._spaces.get(h)._ready().catch(safetyCatch)
    this._openSubspaces().catch(safetyCatch)
    await this.#settle()
    await this.#openBudget()
    await this._saveInstance()
    this._headsTimer = setInterval(() => this._writeHeads().catch(safetyCatch), HEADS_MS)
    if (this._headsTimer.unref) this._headsTimer.unref()
    this._circles.update()
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

  // --- each space indexed with its own types ---

  // The types `space`'s rows were indexed with (@hg/meta types:<hex>; the
  // folder-wide ones for a folder from before), or null.
  async _indexedWith (space) {
    return (await this.#meta('types:' + space.hex)) ?? this._oldTypes ?? null
  }

  async _indexedNow (space, described) {
    if (JSON.stringify(await this.#meta('types:' + space.hex)) === JSON.stringify(described)) return
    await this.#setMeta('types:' + space.hex, described)
  }

  // Does the index hold records of any of `types` in `space`?
  async _holdsAny (space, types) {
    const key = space.keyBytes
    for (const type of types) if (await this.db.findOne('@hg/by-type', { gte: { space: key, type }, lte: { space: key, type } })) return true
    return false
  }

  // Deletes `space`'s rows from the index (its logs are indexed again, or
  // the space is left). `all`: its settings too (left).
  async _clearRows (space, { all = false } = {}) {
    const key = space.keyBytes
    for (const name of ['@hg/records', '@hg/logs', '@hg/changes', '@hg/activity']) {
      for (;;) {
        const rows = await this.db.find(name, { gte: { space: key }, lte: { space: key }, limit: 1000 }).toArray()
        if (!rows.length) break
        await this._queue.run(async (tx) => { for (const row of rows) await tx.delete(name, row) })
      }
    }
    // reading:, dropped and limit rows; a rebuild keeps the budget and what
    // the engine remembers (budget:, space:)
    const meta = (await this.db.find('@hg/meta', {}).toArray()).filter((row) => row.name.includes(space.hex) && (all || !/^(budget|space|types):/.test(row.name)))
    await this._queue.run(async (tx) => {
      if (all) await tx.delete('@hg/spaces', { key })
      for (const row of meta) await tx.delete('@hg/meta', row)
    })
  }

  // The space's types gained types or indexes it holds rows of: closed, its
  // rows deleted, opened again indexing its logs from their start (as a
  // member who always had these types would have).
  async _rebuildSpace (space) {
    if (this.closed) return
    const log = await this._decisions(space.top) // its state reads on meanwhile
    try {
      space._heldLog = log
      if (!(await this._closeIdle(space))) return
      await this._clearRows(space)
      space._rebuild = true
      await space._ready()
    } finally {
      space._heldLog = null
      await this._releaseDecisions(space.top)
    }
  }

  // The index was lost: its settings and the spaces held come back from
  // instance.json; the spaces' logs are indexed again as they open.
  async #restore (durable) {
    for (const name of ['identity', 'personal', 'alone', 'types', 'budget', 'left', 'disk-keys']) {
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
      for (const name of ['identity', 'personal', 'alone', 'types', 'budget', 'left', 'disk-keys']) out[name] = await this.#meta(name)
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

  // The personal space: created with a new identity (its
  // key comes from the phrase, so restoring finds it again), encrypted.
  async #openPersonal (keyPair) {
    const meta = await this.#meta('personal')
    if (!meta) return // a folder from an early alpha (recreate it)
    const space = new Space(this, { key: b4a.from(meta.key, 'hex'), ns: 'personal', personal: true, encryptionKey: b4a.from(meta.encryptionKey, 'hex'), keyPair })
    await space._open(keyPair ? { create: { name: '' } } : {})
    this._personal = space
    this._spaces.set(space.hex, space)
    space.on('_decided', () => this.#settle().catch(safetyCatch))
    space.on('change', ({ types }) => {
      if (types.includes('hg/space')) this.#settle().catch(safetyCatch)
      if (types.includes('hg/device') || types.includes('hg/device-remove')) this.emit('devices')
      if (types.includes('hg/setting')) {
        this.#loadPins().then(() => this.#pinsChanged([...this._pins])).catch(safetyCatch) // another device's pins
        this.emit('settings')
      }
    })
    await this._network.join(space, { now: true })
  }

  async #settingsOf () {
    const out = {}
    for (const { values } of await this.#rows('hg/setting')) {
      try { out[values.name] = JSON.parse(values.value) } catch {}
    }
    return out
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
    // open it twice.
    if (!this._opened || !personal || this.closed || personal.closed || !personal.state.isMember(this._identity.publicKey)) return
    if (personal.isRemoved(this._identity.publicKey, this._identity.device.publicKey)) return
    const me = this._identity.device.publicKey
    if (!(await this.#rows('hg/device')).some(({ values }) => b4a.equals(values.key, me))) {
      await personal._put('hg/device', { key: me, name: this.opts.deviceName || '' })
    }
    const listed = new Set()
    const rows = await this.#rows('hg/space')
    for (const { values } of rows) { // the disk keys first (a sub-space opens with its top space's)
      if (b4a.isBuffer(values.disk) && values.disk.byteLength === 32) await this._keepDiskKey(z32.decode(values.root || values.space), values.disk)
    }
    for (const { values } of rows) {
      listed.add(values.space)
      if (this.closed) return
      if (this._spaces.has(hex(z32.decode(values.space))) || this._left.has(hex(z32.decode(values.space)))) continue
      // Held closed, opened now if it is in the seeded set.
      const key = z32.decode(values.space)
      const space = new Space(this, { key, ns: hex(key), root: values.root ? z32.decode(values.root) : null, fresh: true, name: values.name || '' })
      await this.#keep(space, false)
      if (space._seeded) await space._ready().catch(safetyCatch)
    }
    for (const space of this._spaces.values()) {
      if (space.personal || !space.opened || listed.has(space.key) || !space.state.isMember(this._identity.publicKey)) continue
      await personal._put('hg/space', { space: space.key, name: space.name || '', root: space.rootKey ? z32.encode(space.rootKey) : undefined, disk: this._diskKeys.get(hex(space.top)) })
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

  // This device's own settings in the index (lib/holding.js).
  _meta (name) { return this.#meta(name) }
  _setMeta (name, value) { return this.#setMeta(name, value) }

  async #meta (name) {
    const row = await this.db.get('@hg/meta', { name })
    return row ? JSON.parse(b4a.toString(row.value)) : null
  }

  #setMeta (name, value) {
    return this._queue.run((tx) => tx.insert('@hg/meta', { name, value: b4a.from(JSON.stringify(value)) }))
  }

  // --- identity ---

  /**
   * The person: `{ publicKey }` (z32), the same on all their devices.
   * @type {{publicKey: string}}
   */
  get identity () { return { publicKey: z32.encode(this._identity.publicKey) } }
  /**
   * This device: `{ publicKey }` (z32).
   * @type {{publicKey: string}}
   */
  get device () { return { publicKey: z32.encode(this._identity.device.publicKey) } }

  /**
   * The 24 words that restore this identity elsewhere.
   * @param {string} [password] Needed once the phrase is protected here.
   * @returns {Promise<string|null>} The phrase, or null if it was forgotten on this device.
   * @throws {HypergraphError} `NOT_ALLOWED` when the phrase is protected and the password is missing or wrong.
   */
  async recoveryPhrase (password) {
    this.#open()
    return phrase.open(this.dir, password)
  }

  /**
   * Keeps the recovery phrase on this device, sealed by a password. Until this or
   * {@link Hypergraph#forgetRecoveryPhrase} is called, the phrase sits in the folder as is: ask the person right
   * after showing it.
   * @param {string} password
   * @returns {Promise<void>}
   */
  async protectRecoveryPhrase (password) {
    this.#open()
    phrase.protect(this.dir, password)
  }

  /**
   * Erases the recovery phrase from this device (the person wrote it down). Adding or
   * removing a device then needs the phrase typed in.
   * @returns {Promise<void>}
   */
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

  // --- devices and the personal space ---

  /**
   * The personal space: shared by this identity's devices only, encrypted, never listed in
   * {@link Hypergraph#spaces}. Put the app's private records there.
   * @type {Space}
   * @throws {HypergraphError} `NOT_FOUND` while it isn't open yet.
   */
  get personal () {
    if (!this._personal) throw new HypergraphError('NOT_FOUND', 'This folder has no personal space (made before story 3: recreate it)')
    return this._personal
  }

  /**
   * Makes a code for a new device of this person. Open the new device with
   * `Hypergraph.open(dir, { joinCode: code })`; it receives the recovery phrase over the pairing connection.
   * @param {object} [opts]
   * @param {string} [opts.password] The phrase's password, if it is protected here.
   * @param {string} [opts.recoveryPhrase] The phrase itself, if it was forgotten here.
   * @param {number} [opts.timeout=600000] How long the code stays valid (ms).
   * @returns {Promise<{code: string, added: Promise<{publicKey: string, name: string}|null>}>} `added` resolves to the new device, or null once the code expired unused.
   * @throws {HypergraphError} `NOT_ALLOWED` without the recovery phrase.
   */
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

  /**
   * This identity's devices, removed ones left out.
   * @returns {Promise<Array<{publicKey: string, name: string, current: boolean}>>}
   */
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

  /**
   * Removes a lost device, in every space: what it wrote up to where this device holds it
   * stays, nothing after counts, for everyone. The removal is signed by the identity, so it needs the
   * recovery phrase. The removed device's app gets `DEVICE_REMOVED` on its writes.
   * @param {string} publicKey The device's key (z32).
   * @param {object} [opts]
   * @param {string} [opts.password] The phrase's password, if it is protected here.
   * @param {string} [opts.recoveryPhrase] The phrase itself, if it was forgotten here.
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_FOUND` for a device that isn't this identity's; `NOT_ALLOWED` without the phrase, or for this device itself.
   */
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
      if (space.closed) continue
      await space._ready() // a closed space opens for it
      if (!space.state.isMember(this._identity.publicKey)) continue
      await space._removeDevice(device, secrets, heads.get(space.hex) || {})
    }
  }

  /**
   * This person's settings, the same on all their devices.
   * @returns {Promise<Object<string, *>>} `{ name: value }`.
   */
  async settings () {
    this.#open()
    this.personal // eslint-disable-line no-unused-expressions
    const out = {}
    for (const { values } of await this.#rows('hg/setting')) if (!values.name.startsWith('hg/')) out[values.name] = JSON.parse(values.value)
    return out
  }

  /**
   * Sets one setting for all this person's devices. The latest set, from any device, wins.
   * @param {string} name
   * @param {*} value Anything JSON can hold.
   * @returns {Promise<void>}
   */
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
      if (space.opened) {
        for (const { log, length } of space._heads()) heads.push({ space: space.keyBytes, log, length })
      } else { // closed: its heads as last written
        for (const [log, length] of Object.entries(this._lastHeads.get(space.hex) || {})) heads.push({ space: space.keyBytes, log: b4a.from(log, 'hex'), length })
      }
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

  // --- storage budgets ---

  /**
   * The app's storage budget in bytes: the one set, or 5 GB, or what it holds plus half the free
   * disk if that is smaller.
   * @type {number}
   */
  get budget () {
    return this._budget ?? this._defaultBudget
  }

  async #openBudget () {
    const saved = await this.#meta('budget')
    this._budget = saved ?? this.opts.budget ?? null
    this._defaultBudget = storage.defaultBudget({ free: await storage.freeDisk(this.dir), used: this.#used() })
    this._holdLater()
  }

  /**
   * Sets the bytes the app may use on this device. Spaces with their own budget get it; the
   * others share the rest in proportion to what each holds.
   * @param {number|null} bytes null: back to the default.
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_ALLOWED` when the spaces' own budgets don't fit in it.
   */
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

  /**
   * What the app stores here.
   * @returns {Promise<{budget: number, used: number, free: number|null}>} `used` is an estimate (personal space and decision logs included); `free` is the disk's free bytes, null when the runtime can't tell.
   */
  async storage () {
    this.#open()
    return { budget: this.budget, used: this.#used(), free: await storage.freeDisk(this.dir) }
  }

  #used () {
    let n = storage.INSTANCE
    for (const space of this._spaces.values()) if (space.opened) n += space._usage().stored // shortcut: closed spaces not counted
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
    const spaces = [...this._spaces.values()].filter((s) => s.opened && !s.closed)
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
  // hold dropped content.
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

  // --- spaces open while used ---

  // Opens a closed space (Space#_ready): a sub-space holds its top space open
  // (its decision log lives there); the least recently used unseeded space
  // closes first when maxOpen (or `memory`) is reached.
  async _openShell (space) {
    this.#open()
    if (this._suspended) throw new HypergraphError('SUSPENDED', 'The app is in the background (suspend()): resume() first')
    const top = space.rootKey ? this._spaces.get(hex(space.rootKey)) : null
    if (top) {
      await top._ready()
      top._use()
    }
    // Its topic joined first: its decisions may not all be held here.
    if (this._network.swarm && !space.rootKey) this._network.join(space, { now: true }).catch(safetyCatch)
    try {
      await this.#makeRoom(space)
      await space._open()
    } catch (err) {
      if (top) top._unuse()
      if (!space.rootKey) this._network.leave(space, { grace: true }).catch(safetyCatch)
      throw err
    }
    space._top = top
    space._used = Date.now()
    if (!space.rootKey && space.state.owner === hex(this._identity.publicKey)) space._own = true
    this.#remember(space)
    if (this._network.swarm) this._network.join(space, { now: true }).catch(safetyCatch)
    if (this._opened) this._openSubspaces().catch(safetyCatch)
    space._touch()
  }

  // Opens `space`, unless its decisions aren't all held here (a process
  // killed while they downloaded): 'waiting', it opens once a peer holding
  // them is reached, after connectToSwarm().
  #openOrWait (space) {
    return new Promise((resolve, reject) => {
      const onwait = () => resolve('waiting')
      space.once('_waiting', onwait)
      space._ready().then(() => resolve('open'), reject).finally(() => space.off('_waiting', onwait))
    })
  }

  // A space unused for idleMs (or the least recently used one, for room):
  // closed, its topic kept a while (it may be visited again).
  async _closeIdle (space) {
    if (this._circles.active && space.opened) await this._circles.remember(space).catch(safetyCatch) // handed later without opening it
    const heads = space.opened ? space._heads() : null
    if (!(await space._shut())) return false
    if (heads) this._lastHeads.set(space.hex, Object.fromEntries(heads.map(({ log, length }) => [hex(log), length])))
    const top = space._top
    space._top = null
    if (top) top._unuse()
    this.#remember(space)
    this._network.leave(space, { grace: true }).catch(safetyCatch)
    return true
  }

  async #makeRoom (opening) {
    for (;;) {
      const open = [...this._spaces.values()].filter((s) => s.opened && !s.personal)
      const bytes = open.reduce((n, s) => n + OPEN_BYTES + LOG_BYTES * s.directory.logs.size, 0)
      if (open.length < this.maxOpen && (!this.memory || bytes + OPEN_BYTES <= this.memory)) return
      let lru = null
      for (const s of open) if (s !== opening && !s._seeded && !s._inUse && (!lru || s._used < lru._used)) lru = s
      if (!lru || !(await this._closeIdle(lru))) return // all in use: opened anyway
    }
  }

  // The seeded set: pinned, own spaces, then the most
  // recently used, up to maxAnnounced top spaces (their sub-spaces with
  // them). Seeded spaces stay open.
  #reseed () {
    const tops = [...this._spaces.values()].filter((s) => !s.personal && !s.rootKey)
    tops.sort((a, b) => seedRank(a) - seedRank(b) || b._used - a._used)
    const seeded = new Set(tops.slice(0, this.maxAnnounced).map((s) => s.hex))
    for (const s of this._spaces.values()) {
      if (s.personal) continue
      const was = s._seeded
      s._seeded = seeded.has(s.rootKey ? hex(s.rootKey) : s.hex)
      if (was && !s._seeded) s._touch() // closes once idle
    }
  }

  // Opens the seeded spaces still closed, one after another.
  async #openSeeded () {
    for (const s of [...this._spaces.values()]) {
      if (this.closed || this._suspended) return
      if (s._seeded && !s.opened && !s.closed) await s._ready().catch(safetyCatch)
    }
  }

  // What the engine keeps of a space between runs (@hg/meta space:<hex>).
  #remember (space) {
    if (this.closed || space.personal) return
    if (space.opened && space.circle) space._circle = true
    const info = { used: space._used, own: space._own, parent: space.rootKey ? space.parent : null, ...(space._circle ? { circle: true } : {}) }
    const sig = JSON.stringify(info)
    if (sig === space._remembered) return
    space._remembered = sig
    this.#setMeta('space:' + space.hex, info).catch(safetyCatch)
  }

  async #loadPins () {
    if (!this._personal) return
    const list = (await this.#settingsOf())[PINNED]
    this._pins = new Set(Array.isArray(list) ? list.filter((k) => typeof k === 'string') : [])
    for (const s of this._spaces.values()) s._pinned = this._pins.has(s.key)
  }

  /**
   * Pins a space held here: kept open and online, on every device of this person (a bookmark).
   * @param {string} key The space's key (z32).
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_FOUND` if it isn't held here.
   */
  async pin (key) {
    this.#open()
    const space = this.space(key)
    if (this._pins.has(space.key)) return
    await this.#savePins([...this._pins, space.key])
  }

  /**
   * Unpins a space.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async unpin (key) {
    this.#open()
    const k = typeof key === 'string' ? key : key && key.key
    if (!this._pins.has(k)) return
    await this.#savePins([...this._pins].filter((p) => p !== k))
  }

  /**
   * The pinned spaces' keys.
   * @returns {string[]}
   */
  pinned () {
    return [...this._pins]
  }

  async #savePins (list) {
    await this.personal._put('hg/setting', { name: PINNED, value: JSON.stringify(list) })
    await this.#pinsChanged(list)
  }

  async #pinsChanged (list) {
    this._pins = new Set(list)
    for (const s of this._spaces.values()) s._pinned = this._pins.has(s.key)
    this.#reseed()
    this._spacesChanged()
    await this.#openSeeded()
  }

  /**
   * A site's handle: one space and its sub-spaces, nothing else of this engine (not the other
   * spaces, the personal space, the recovery phrase, the devices or the budgets). For a browser running
   * many sites on one engine.
   * @param {string} target The space's key (z32; a space not held here is opened by its key) or an invite link.
   * @param {object} [opts]
   * @param {string} [opts.identity='site'] `'main'` acts as this person, once they agreed to show their identity to the site. The default, a key of the site's own, is not built yet.
   * @returns {Promise<Scope>}
   * @throws {HypergraphError} `NOT_SUPPORTED` without `identity: 'main'`; `NOT_ALLOWED` for a sub-space (reach it with {@link Scope#subspace}); the errors of {@link Hypergraph#redeemInvite} for a link.
   */
  async scope (target, opts) {
    this.#open()
    return scope(this, target, opts)
  }

  // --- a phone ---

  /**
   * The app goes to the background: topics paused, connections suspended, spaces not in use
   * closed. A call on a closed space then throws `SUSPENDED` until {@link Hypergraph#resume}.
   * @returns {Promise<void>}
   */
  async suspend () {
    this.#open()
    if (this._suspended) return
    this._suspended = true
    await this._network.suspend()
    for (const space of [...this._spaces.values()]) {
      if (!space.personal && space.opened && !space._inUse) await this._closeIdle(space).catch(safetyCatch)
    }
    await this._writeHeads().catch(safetyCatch)
  }

  /**
   * Back to the foreground: the space in use is still open; the pinned and recent ones open again.
   * @returns {Promise<void>}
   */
  async resume () {
    this.#open()
    if (!this._suspended) return
    this._suspended = false
    await this._network.resume()
    this.#openSeeded().catch(safetyCatch)
  }

  /**
   * Whether {@link Hypergraph#suspend} was called and not yet resumed.
   * @type {boolean}
   */
  get suspended () { return !!this._suspended }

  // --- network ---

  /**
   * Goes online: finds the members of every space, now and later.
   * @returns {Promise<void>}
   */
  async connectToSwarm () {
    this.#open()
    await this._network.connect()
  }

  // --- spaces ---

  /**
   * Creates a space, owned by this person.
   * @param {object} [opts]
   * @param {string} [opts.name='']
   * @param {boolean} [opts.private=false] Readable only by its members; also encrypted on disk.
   * @param {string} [opts.policy='auto'] `'auto'` (each member keeps what fits, then the newest part plus what it reads) or `'everything'` (every member is asked to keep it all).
   * @param {Object<string, object>} [opts.types] Its record types, recorded in it; this app's by default.
   * @returns {Promise<Space>}
   * @throws {TypeError} For an unknown policy.
   */
  createSpace (opts) {
    return this.#createSpace(opts, false)
  }

  async #createSpace ({ name = '', policy = 'auto', private: priv = false, types = null } = {}, circle) {
    this.#open()
    if (!POLICIES.includes(policy)) throw new TypeError(`A policy is ${POLICIES.map((p) => `'${p}'`).join(' or ')}`)
    const declared = types ? new Types(types) : null
    const disk = priv ? crypto.randomBytes(32) : null // a private space is encrypted on disk
    const space = new Space(this, { ns: hex(crypto.randomBytes(16)), declared, encryptionKey: disk })
    await this.#makeRoom(space)
    await space._open({ create: { name, policy, private: !!priv, circle } })
    if (disk) await this._keepDiskKey(space.keyBytes, disk)
    space._own = true
    if (this.rules.length) await space.setRules() // the creator's app rules are the space's
    await this.#keep(space)
    await space._startKeys() // a private one's first key
    return space
  }

  // The new space of a renew (lib/space.js #renew): private, a new
  // disk key, its first decisions the old state (`renewed(key)`). Held here,
  // not listed in the personal space until the move is decided (_moveTo).
  async _createRenewed ({ name, policy, circle }, renewed) {
    this.#open()
    const disk = crypto.randomBytes(32)
    const space = new Space(this, { ns: hex(crypto.randomBytes(16)), encryptionKey: disk })
    await this.#makeRoom(space)
    await space._open({ create: { name, policy, private: true, circle, renewed } })
    await this._keepDiskKey(space.keyBytes, disk)
    this._spaces.set(space.hex, space)
    if (this._network.swarm) await this._network.join(space, { now: true })
    return { space, disk }
  }

  // A renew that lost (another was decided first): its space goes.
  async _discard (space) {
    await this.#drop(space)
    this._diskKeys.delete(space.hex)
    await this.#setMeta('disk-keys', Object.fromEntries([...this._diskKeys].map(([k, v]) => [k, hex(v)])))
  }

  // `old` moved (its "moved to" box opened here: { to, disk, subs }
  // as hex, `hash` the move's): the new space opened, checked to be the one
  // the move names, kept and listed; the old one hidden (kept 30 days for
  // late devices: #dropMoved), its key leading to the new one; this device's
  // records written in the old logs after the move re-posted.
  async _moveTo (old, { to, disk, subs = {} }, hash) {
    if (this.closed || old._movedHash === hash) return
    const key = b4a.from(to, 'hex')
    await this._keepDiskKey(key, b4a.from(disk, 'hex'))
    const fresh = await this[symbols.openSpace](key)
    const deadline = Date.now() + 60000
    while (!fresh.state.renewed && !fresh.closed && !this.closed && Date.now() < deadline) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); fresh.off('decisions', done); resolve() }
        const timer = setTimeout(done, 500)
        fresh.on('decisions', done)
      })
    }
    const r = fresh.state.renewed
    if (!r || r.from !== old.hex || r.hash !== hash) return // not (yet) the space the move names: looked at again later
    const at = Date.now()
    this._moved[old.hex] = { to, at }
    for (const [from, next] of Object.entries(subs)) this._moved[from] = { to: next, at }
    await this.#setMeta('moved', this._moved)
    old._movedHash = hash
    old._movedTo = fresh.key
    for (const s of this._below(old)) s._movedTo = z32.encode(b4a.from(subs[s.hex] || s.hex, 'hex'))
    await this.#keep(fresh)
    if (this._pins.has(old.key)) await this.#savePins([...this._pins].filter((k) => k !== old.key && k !== fresh.key).concat(fresh.key)).catch(safetyCatch) // bookmarks follow
    this._openSubspaces().catch(safetyCatch)
    old.emit('moved', { to: fresh.key })
    this._spacesChanged()
    const pairs = [[fresh, old], ...this._below(old).map((s) => [subs[s.hex] && this._spaces.get(subs[s.hex]), s]).filter(([n]) => n)]
    // records the old space can't open yet (its keys come back from its index after a restart): again, for a while
    for (let tries = 0; tries < REPOST_TRIES && pairs.length && !this.closed; tries++) {
      for (let i = pairs.length - 1; i >= 0; i--) {
        const [next, from] = pairs[i]
        const waiting = await next._ready().then(() => next._repost(from)).catch((err) => { safetyCatch(err); return 0 })
        if (!waiting) pairs.splice(i, 1)
      }
      if (pairs.length) await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  // A space that moved is kept (and served, for devices that were
  // away) 30 days after the move, then left; its logs stay, as the new
  // space's history.
  async _dropMoved () {
    const now = this._now()
    for (const [h, { at }] of Object.entries(this._moved)) {
      const space = this._spaces.get(h)
      if (!space || now - at < MOVED_MS) continue
      const saved = await this.#meta('cores:' + h)
      const keys = space.opened ? (await coreKeys(space)).map((k) => hex(k)) : saved ? saved.cores.map(([k]) => k) : [h]
      this._spaces.delete(h)
      this._left.add(h)
      await this._network.leave(space).catch(safetyCatch)
      await space.close().catch(safetyCatch)
      await this._clearRows(space, { all: true })
      if (this._circles) await this._circles.dropped(keys).catch(safetyCatch)
    }
    await this.#setMeta('left', [...this._left])
  }

  /**
   * Creates a circle: a private space whose members' devices keep each other's spaces online
   * (see {@link Hypergraph#setHolding}). 50 members at most, invited by its owner and admins.
   * @param {object} [opts]
   * @param {string} [opts.name='']
   * @returns {Promise<Space>}
   */
  createCircle ({ name = '' } = {}) {
    return this.#createSpace({ name, private: true }, true)
  }

  /**
   * Whether this device holds for its circles (keeps their members' spaces and serves them), and
   * how much, one share for all its circles. Off until set.
   * @param {object} [opts]
   * @param {boolean} [opts.on]
   * @param {number} [opts.bytes] This device's share; 1 GB at first, kept when left out.
   * @returns {Promise<void>}
   */
  async setHolding ({ on, bytes } = {}) {
    this.#open()
    if (typeof on !== 'boolean') throw new TypeError('on is true or false')
    if (bytes !== undefined && !(Number.isSafeInteger(bytes) && bytes > 0)) throw new TypeError('bytes is a positive whole number')
    await this._circles.set({ on, bytes })
    return this.holding()
  }

  /**
   * This device's holding for its circles.
   * @returns {{on: boolean, bytes: number, used: number}} `used`: what it holds for them.
   */
  holding () {
    return { on: this._circles.on, bytes: this._circles.bytes, used: this._circles.used() }
  }

  /**
   * How many copies of a space of this person's its circles' holders keep ("kept by N of 5
   * copies"), as of the last update. A `copies` event tells when it may have changed.
   * @param {string} key
   * @returns {{wanted: number, kept: number, online: number}} `wanted`: 5, or one per circle past 5, 0 when it isn't handed to anyone; `kept`: holders with all its latest data; `online`: those connected now.
   */
  copiesOf (key) {
    this.#open()
    return this._circles.copiesOf(this.space(key))
  }

  /**
   * Joins the space an invite link (or a public link) is for, once a member who records
   * decisions lets this person in.
   * @param {string} link
   * @param {object} [opts]
   * @param {number} [opts.timeout=30000] How long to wait for such a member (ms).
   * @returns {Promise<Space>}
   * @throws {HypergraphError} `INVITE_EXPIRED`, `INVITE_USED_UP`, `INVITE_REVOKED`, `NOT_ALLOWED` (its maker may not give that role, or this person is banned), `CIRCLE_FULL`; `INVITE_INVALID` for a malformed link, a space that isn't public (public link), or nobody able to let this person in answering in time.
   */
  async redeemInvite (link, { timeout = JOIN_TIMEOUT } = {}) {
    this.#open()
    const inv = invites.decodeLink(link)
    if (inv.public) return this.#joinPublic(inv, timeout)
    if (inv.expires && Date.now() > inv.expires) throw new HypergraphError('INVITE_EXPIRED', 'This invite link has expired')
    const held = this._spaces.has(hex(inv.space))
    const root = b4a.equals(inv.root, inv.space) ? null : inv.root // a sub-space's invite
    if (inv.disk && !held && !this._diskKeys.has(hex(inv.root))) {
      // a private space's disk key first (lib/joiner.js), from the decider that records us
      const answer = await this.#diskKeyFor(inv, timeout)
      if (answer && answer.refused) throw new HypergraphError(answer.refused, REFUSALS[answer.refused])
      const disk = answer && answer.key
      if (!disk) throw new HypergraphError('INVITE_INVALID', `No member able to let you in answered within ${Math.round(timeout / 1000)} s (they may be offline: try again later)`)
      await this._keepDiskKey(inv.root, disk)
      for (const p of answer.past || []) await this._keepDiskKey(p.top, p.key) // the history's
    }
    const space = await this[symbols.openSpace](inv.space, { root })
    await this.connectToSwarm()
    const result = await space._redeem(invites.makeRedemption(inv, this._identity, space.decisionLog.localKey), timeout)
    if (result !== true) {
      if (!held) await this.#drop(space)
      if (result) throw new HypergraphError(result, REFUSALS[result])
      throw new HypergraphError('INVITE_INVALID', `No member able to let you in answered within ${Math.round(timeout / 1000)} s (they may be offline: try again later)`)
    }
    await this.#keep(space)
    if (space.circle) await this._circles.joined(space).catch(safetyCatch) // back in, after any `left`
    return space
  }

  // Sends our redemption to the space's peers on a bare space
  // channel and waits for its disk key or a refusal ({ key } | { refused },
  // null after `timeout`); nothing of the
  // space is opened meanwhile. The writer key is the one its decision log
  // will have (Autobase's local core in the top space's namespace).
  async #diskKeyFor (inv, timeout) {
    const writer = await Autobase.getLocalKey(this.store.namespace(hex(inv.root)))
    const redemption = c.encode(enc.redemption, invites.makeRedemption(inv, this._identity, writer))
    const joiner = new Joiner({ key: inv.space, redemption, commit: inv.disk, device: this._identity.device })
    this._joiners.set(joiner.hex, joiner)
    try {
      await this.connectToSwarm()
      if (this._network.connected) await this._network.join(joiner, { now: true })
      return await joiner.wait(timeout)
    } finally {
      this._joiners.delete(joiner.hex)
      joiner.close()
      if (!joiner.key) await this._network.leave(joiner).catch(safetyCatch)
    }
  }

  // Keeps a private top space's disk key on this device.
  async _keepDiskKey (top, key) {
    const h = hex(top)
    if (this._diskKeys.has(h) && b4a.equals(this._diskKeys.get(h), key)) return
    this._diskKeys.set(h, key)
    await this.#setMeta('disk-keys', Object.fromEntries([...this._diskKeys].map(([k, v]) => [k, hex(v)])))
  }

  // A public link: no decision, no decider; one peer holding the
  // decision log is enough.
  async #joinPublic (inv, timeout) {
    const held = this._spaces.has(hex(inv.space))
    const root = b4a.equals(inv.root, inv.space) ? null : inv.root
    const space = await this[symbols.openSpace](inv.space, { root })
    await this.connectToSwarm()
    const result = await space._joinPublic(timeout)
    if (result !== true) {
      if (!held) await this.#drop(space)
      if (result) throw new HypergraphError('INVITE_INVALID', "This space isn't public: ask a member for an invite link")
      throw new HypergraphError('INVITE_INVALID', `No one holding this space was reachable within ${Math.round(timeout / 1000)} s (try again later)`)
    }
    await this.#keep(space)
    return space
  }

  // --- packs: what a visitor of public spaces would download, in a folder ---

  /**
   * Writes a pack of public spaces into a folder: what a visitor downloads of them (each
   * space's decision log and accepted logs, whole and signed by their writers) and a `spaces.json`. No key
   * pair, identity, personal space or setting leaves this instance.
   * @param {string[]} keys The spaces' keys (a sub-space by its own key), held here.
   * @param {string} dir
   * @param {object} [opts]
   * @param {number} [opts.timeout=30000]
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_ALLOWED` for a space that isn't public; `NOT_FOUND` for one not held here.
   */
  async exportSpaces (keys, dir, { timeout = 30000 } = {}) {
    this.#open()
    const spaces = []
    for (const key of keys) {
      const space = this.space(key)
      await space._ready()
      if (!space.isPublic) throw new HypergraphError('NOT_ALLOWED', `Space ${space.key} isn't public: only what anyone may download is packed`)
      const cores = new Map()
      if (!space.rootKey) {
        const base = space.decisionLog.base
        cores.set(hex(base.key), base.key)
        for await (const { key: k } of base.system.list()) cores.set(hex(k), k)
        for (const v of base.views()) cores.set(hex(v.key), v.key)
      }
      const logs = [...space.directory.logs.values()].map((l) => l.key)
      for (const k of logs) cores.set(hex(k), k)
      const out = []
      for (const k of cores.values()) {
        const core = this.store.get({ key: k })
        await core.ready()
        out.push({ key: z32.encode(k), length: core.length })
        await core.close()
      }
      spaces.push({ key: space.key, root: space.rootKey ? z32.encode(space.rootKey) : null, cores: out, logs: logs.map((k) => z32.encode(k)) })
    }
    fs.mkdirSync(dir, { recursive: true })
    const pack = new Corestore(path.join(dir, 'cores'))
    try {
      await copyCores(this.store, pack, spaces, timeout)
    } finally {
      await pack.close()
    }
    fs.rmSync(path.join(dir, 'cores', 'CORESTORE'), { force: true }) // this machine's device file: a pack is opened read only
    fs.writeFileSync(path.join(dir, 'spaces.json'), JSON.stringify({ version: 1, spaces }, null, 2))
  }

  /**
   * Joins the spaces of a pack ({@link Hypergraph#exportSpaces}) with nobody online. Every
   * block is checked against its writer's signature and every log by the space's rules; only public spaces
   * are kept, all or none. A core held here already as long or longer is left as it is. The folder is only
   * read.
   * @param {string} dir
   * @param {object} [opts]
   * @param {number} [opts.timeout=30000]
   * @returns {Promise<string[]>} The keys of the spaces kept.
   * @throws {HypergraphError} `IMPORT_INVALID` when blocks are missing or changed, or a space isn't public.
   */
  async importSpaces (dir, { timeout = 30000 } = {}) {
    this.#open()
    let spaces
    try {
      ({ spaces } = JSON.parse(fs.readFileSync(path.join(dir, 'spaces.json'), 'utf-8')))
      for (const s of spaces) {
        z32.decode(s.key)
        if (s.root) z32.decode(s.root)
        for (const c of s.cores) if (!Number.isSafeInteger(c.length) || c.length < 0 || z32.decode(c.key).byteLength !== 32) throw new Error('bad core')
        for (const l of s.logs) z32.decode(l)
      }
    } catch (err) {
      throw new HypergraphError('IMPORT_INVALID', 'Not a pack of spaces: ' + err.message)
    }
    const opened = []
    try {
      const pack = new Corestore(path.join(dir, 'cores'), { readOnly: true }) // read only: an app's folder may be
      try {
        await copyCores(pack, this.store, spaces, timeout)
      } finally {
        await pack.close()
      }
      const checked = []
      for (const s of [...spaces.filter((x) => !x.root), ...spaces.filter((x) => x.root)]) { // tops first: a sub-space reads its top's decisions
        const held = this._spaces.has(hex(z32.decode(s.key)))
        const space = await this[symbols.openSpace](s.key, { root: s.root, now: false })
        if (!held) opened.push(space)
        await space.decisionLog.update()
        await space._decided
        if (!space.isPublic) throw new HypergraphError('IMPORT_INVALID', `Space ${s.key} isn't public`)
        for (const l of s.logs) await space.directory.consider(z32.decode(l))
        // indexed before it resolves: a read right after finds every record (blocks held and not indexed yet;
        // not replicator.missing(), which counts a log no peer told the length of for its first HEARD_MS)
        const indexing = () => [...space.directory.logs.values()].some((log) => behind(log) > 0)
        for (const until = Date.now() + timeout; indexing() && Date.now() < until;) {
          await new Promise((resolve) => { const done = () => { clearTimeout(timer); space.off('_progress', done); resolve() }; const timer = setTimeout(done, 100); space.on('_progress', done) })
        }
        checked.push(space)
      }
      for (const space of checked) await this.#keep(space, true, false) // every space checked first: a refusal keeps none
      return checked.map((space) => space.key)
    } catch (err) {
      for (const space of opened) await this.#drop(space)
      throw err.code === 'IMPORT_INVALID' ? err : new HypergraphError('IMPORT_INVALID', "This pack can't be read: " + err.message)
    }
  }

  // A space opened here but not joined: closed and forgotten.
  async #drop (space) {
    this._spaces.delete(space.hex)
    await this._network.leave(space).catch(safetyCatch)
    await space.close().catch(safetyCatch)
  }

  /**
   * The app's declared record types, hypergraph's own included (`builtin: true`).
   * @returns {Object<string, {fields: Object<string, string>, links: object, onePerMember: boolean, editable: (string|object), index: Array, builtin: boolean}>}
   */
  types () {
    const out = {}
    for (const name of this._types.names()) {
      const t = this._types.get(name)
      const editable = t.editable.by === 'permission' ? { permission: t.editable.permission } : t.editable.by
      out[name] = { fields: Object.fromEntries(t.fields.map((f) => [f.name, f.kind])), links: Object.fromEntries(Object.entries(t.links).map(([f, targets]) => [f, [...targets]])), onePerMember: t.onePerMember, editable, index: t.index.map((keys) => [...keys]), builtin: name.startsWith('hg/') }
    }
    return out
  }

  /**
   * The spaces held here, the personal space left out. The `spaces` event fires when the list
   * changes (a space joined here or on another device, left, renamed or moved).
   * @returns {Array<{key: string, name: string, parent: (string|null), opened: boolean, pinned: boolean, own: boolean}>} `parent`: the space a sub-space is in.
   */
  spaces () {
    return [...this._spaces.values()].filter((s) => !s.personal && !this.#movedHere(s.hex)).map((s) => ({ key: s.key, name: s.name, parent: s.parent, opened: s.opened, pinned: s._pinned, own: s._own }))
  }

  // 'spaces' when what spaces() returns differs from the last one sent: a space
  // kept or left, a name or a parent arriving.
  _spacesChanged () {
    if (this.closed) return
    const spaces = this.spaces()
    const sig = JSON.stringify(spaces.map(({ opened, ...rest }) => rest)) // opening and closing is not a change of the list
    if (sig === this._spacesSig) return
    this._spacesSig = sig
    this.emit('spaces', spaces)
    if (this._circles) this._circles.changed()
  }

  /**
   * Drops a space from this device, with its sub-spaces held here: closed, its logs and index rows
   * deleted, not opened again unless joined again. Membership doesn't change: the other members, and this
   * person's other devices, keep it.
   * @param {string} key
   * @returns {Promise<void>}
   * @throws {HypergraphError} `NOT_FOUND` if it isn't held here.
   */
  async leaveSpace (key) {
    this.#open()
    const space = this.space(key)
    await space._ready()
    if (space.circle) await this._circles.leaving(space).catch(safetyCatch) // the person leaves it
    const spaces = [...this._below(space), space]
    for (const s of spaces) await s._ready()
    for (const s of spaces) {
      this._spaces.delete(s.hex)
      this._left.add(s.hex)
      if (s !== space) this._leftWith[s.hex] = space.hex
      await this._network.leave(s)
      await s.close()
    }
    await this.#setMeta('left', [...this._left])
    await this.#setMeta('left-with', this._leftWith)
    this._spacesChanged()
    for (const s of spaces) await this.#purge(s)
    await this._saveInstance()
    await this._circles.update() // what it held for that circle goes, unless another covers it
  }

  // Deletes what this device holds of a space just closed: the blocks of its
  // logs and its rows in the index. This device's own two logs keep their
  // header (block 0): joining again reopens them by name and reads it, and
  // nobody else holds the header of a log never written in (HyperBrowser 004).
  // shortcut: the logs' trees and the decision log stay (small; a named core
  // deleted from Corestore can't be made again under its name, so rejoining
  // would fail); delete the cores once Hypercore's purge() works (11.37 calls
  // methods that don't exist).
  async #purge (space) {
    const own = [space.own.core.key, space._idcore.key]
    const keys = [...own, ...[...space.directory.logs.values()].map((log) => log.key)]
    for (const k of keys) {
      const core = this.store.get({ key: k }) // a session of its own: the space's are closed
      const from = own.some((o) => b4a.equals(o, k)) ? 1 : 0
      await core.ready().then(() => core.length > from && core.clear(from, core.length)).catch(safetyCatch)
      await core.close().catch(safetyCatch)
    }
    await this._clearRows(space, { all: true })
  }

  // The space `h` (hex) moved to, if held here.
  #movedHere (h) {
    const m = this._moved[h]
    return m ? this._spaces.get(m.to) || null : null
  }

  /**
   * The space with this key, open or not (every async call opens it). A space that was renewed
   * gives the space it moved to.
   * @param {string} key
   * @returns {Space}
   * @throws {HypergraphError} `NOT_FOUND` if it isn't held here (an invite lets this person in).
   */
  space (key) {
    let bytes = null
    try { bytes = typeof key === 'string' ? z32.decode(key) : key } catch {}
    const space = bytes && (this.#movedHere(hex(bytes)) || this._spaces.get(hex(bytes)))
    if (!space || space.personal) throw new HypergraphError('NOT_FOUND', `No space ${key} here`)
    return space
  }

  // Opens a space by key without joining it (redeemInvite; listed spaces;
  // tests). `encryptionKey`: tests only (a stranger holding a personal
  // space's keys).
  // `now`: its topic joined past the queue (in use), else queued.
  async [symbols.openSpace] (key, { encryptionKey = null, root = null, now = true } = {}) {
    const bytes = typeof key === 'string' ? z32.decode(key) : key
    const held = this._spaces.get(hex(bytes))
    if (held) {
      await held._ready()
      return held
    }
    // One open at a time per space: two would open its decision log twice.
    if (!this._opening) this._opening = new Map()
    const opening = this._opening.get(hex(bytes))
    if (opening) return opening
    const open = (async () => {
      const space = new Space(this, { key: bytes, ns: hex(bytes), encryptionKey, root: root ? (typeof root === 'string' ? z32.decode(root) : root) : null, fresh: true })
      await this.#makeRoom(space)
      await space._open()
      space._used = Date.now()
      this._spaces.set(space.hex, space)
      if (now) await this._network.join(space, { now })
      else this._network.join(space).catch(safetyCatch)
      return space
    })()
    this._opening.set(hex(bytes), open)
    try {
      return await open
    } finally {
      this._opening.delete(hex(bytes))
    }
  }

  // --- sub-spaces ---

  // The decision log of top space `key`, shared by the space and its
  // sub-spaces (opening one Autobase twice hangs): the one held, or a new one
  // (`make()`, or in the namespace of its key). Released with
  // _releaseDecisions().
  async _decisions (key, make = null) {
    const h = hex(key)
    let entry = this._logsOf.get(h)
    if (!entry) {
      this.#open()
      const log = make ? make() : new Decisions(this.store.namespace(h), key, { identity: this._identity, wakeup: this._network.wakeup, encryptionKey: this._diskKeys.get(h) || null, now: () => this._now() })
      entry = { log, refs: 0, ready: log.ready() }
      entry.ready.then(() => { entry.opened = true }, safetyCatch)
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
    const space = await this[symbols.openSpace](key, { root, now: false })
    await this.#keep(space, true, false)
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
      if (space.personal || space.closed || !space.opened) continue
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
  // identity's other devices join it too) unless it came from there. `now`:
  // its topic joined past the queue (created or joined by a call now).
  async #keep (space, list = true, now = list) {
    this._spaces.set(space.hex, space)
    if (this._left.delete(space.hex)) { // joined again, with the sub-spaces left with it
      delete this._leftWith[space.hex]
      for (const [sub, top] of Object.entries(this._leftWith)) {
        if (top !== space.hex) continue
        this._left.delete(sub)
        delete this._leftWith[sub]
      }
      await this.#setMeta('left', [...this._left])
      await this.#setMeta('left-with', this._leftWith)
      this._openSubspaces().catch(safetyCatch)
    }
    await this._queue.run((tx) => tx.insert('@hg/spaces', { key: space.keyBytes, ns: space.ns, name: space.name || '', parent: space.rootKey || null, joined: Date.now() }))
    await this._saveInstance()
    space._used = Date.now()
    this.#remember(space)
    this.#reseed()
    if (space.opened) {
      if (now) await this._network.join(space, { now })
      else this._network.join(space).catch(safetyCatch)
      space._touch()
    }
    this._spacesChanged()
    if (list) await this.#settle().catch(safetyCatch)
  }

  #open () {
    if (this.closed) throw new HypergraphError('CLOSED', 'This hypergraph is closed')
  }

  /**
   * Closes every space, the connections and the storage. Calling it again returns the same promise.
   * @returns {Promise<void>}
   */
  close () {
    if (!this._closing) this._closing = this.#close()
    return this._closing
  }

  async #close () {
    for (const space of this._spaces.values()) this.#remember(space)
    if (this._headsTimer) clearInterval(this._headsTimer)
    if (this._holdTimer) clearTimeout(this._holdTimer)
    if (this._holding) await this._holding.catch(safetyCatch)
    if (this._reclaiming) await this._reclaiming
    if (this._saving) await this._saving
    await this._writeHeads().catch(safetyCatch)
    this.closed = true
    // A decision log still opening may wait for peers (its view's blocks not
    // held here): closed now, the opens waiting on it fail.
    for (const entry of this._logsOf.values()) if (!entry.opened) entry.log.close().catch(safetyCatch)
    if (this._settling) await this._settling.catch(safetyCatch)
    if (this._circles) await this._circles.close().catch(safetyCatch)
    if (this._pairing) await this._pairing.close().catch(safetyCatch)
    if (this._network) await this._network.close().catch(safetyCatch)
    for (const space of this._spaces.values()) await space.close().catch(safetyCatch)
    if (this._queue) await this._queue.idle()
    if (this.db) await this.db.close().catch(safetyCatch)
    if (this.store) await this.store.close().catch(safetyCatch)
  }
}

// Seeding order (lower first): pinned (the person chose them), own spaces,
// then the others.
function seedRank (space) {
  return space._pinned || space._circle ? 0 : space._own ? 1 : 2
}

// Every core of `spaces` (exportSpaces' list) copied from store `from` into
// store `to`, through replication in this process: `to` checks each block
// against its signed tree, as from any peer. A core `to` holds as long already
// is left as is.
async function copyCores (from, to, spaces, timeout) {
  const a = from.replicate(true)
  const b = to.replicate(false)
  let failed = null
  const broken = new Promise((resolve) => {
    const fail = (err) => { failed = failed || err || new Error('the stream closed'); resolve() }
    a.on('error', fail)
    b.on('error', fail)
    a.on('close', () => fail())
    b.on('close', () => fail())
  })
  a.pipe(b).pipe(a)
  try {
    for (const s of spaces) {
      for (const c of s.cores) {
        if (!c.length) continue
        const core = to.get({ key: z32.decode(c.key) })
        try {
          await core.ready()
          if (core.contiguousLength >= c.length) continue
          let timer = null
          const late = new Promise((resolve) => { timer = setTimeout(resolve, timeout) })
          const range = core.download({ start: 0, end: c.length })
          await Promise.race([range.done(), late, broken])
          clearTimeout(timer)
          range.destroy()
          if (core.contiguousLength < c.length) throw new HypergraphError('IMPORT_INVALID', `Blocks of ${c.key} missing or changed${failed ? ' (' + failed.message + ')' : ''}`)
        } finally {
          await core.close()
        }
      }
    }
  } finally {
    a.destroy()
    b.destroy()
  }
}

/**
 * The list `spaces()` returns changed.
 * @type {Array<object>}
 * @event Hypergraph#spaces
 */

/**
 * `devices()` may have changed.
 * @event Hypergraph#devices
 */

/**
 * `settings()` may have changed.
 * @event Hypergraph#settings
 */

/**
 * `copiesOf(key)` may have changed for some space.
 * @event Hypergraph#copies
 */

module.exports = { Hypergraph, HypergraphError, codes }
