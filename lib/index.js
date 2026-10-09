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
const { declareRules } = require('./gate.js')
const enc = require('./encodings.js')
const invites = require('./invites.js')
const symbols = require('./symbols.js')
const phrase = require('./phrase.js')
const { HypergraphError, codes } = require('./errors.js')

const READ_TIMEOUT = 5000
const REDEEM_TIMEOUT = 60000
const HEADS_MS = 10 * 60 * 1000 // how often a device writes its heads, if they changed (and at close)
const hex = (b) => b4a.toString(b, 'hex')
const headList = c.array(enc.struct([['space', c.fixed32], ['log', c.fixed32], ['length', c.uint]]))

class Hypergraph extends EventEmitter {
  constructor (dir, opts) {
    super()
    this.dir = dir
    this.opts = opts
    this.readTimeout = opts.readTimeout ?? READ_TIMEOUT
    this.types = new Types(opts.types || {})
    this.rules = declareRules(opts.rules || [])
    this._spaces = new Map() // space hex -> Space (the personal space included)
    this._personal = null
    this._wasAlone = false // a new identity, no device added since
    this._pairing = null
    this._settling = null
    this._heads = ''
    this._headsTimer = null
    this.closed = false
    this._closing = null
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
    this.store = new Corestore(path.join(this.dir, 'cores'))
    await this.store.ready()
    this.db = HyperDB.rocks(path.join(this.dir, 'index'), def)
    await this.db.ready()
    this._queue = new WriteQueue(this.db)

    const stored = await this.#meta('types')
    this.types.checkCompatible(stored)
    await this.#setMeta('types', this.types.describe())

    const device = await this.store.createKeyPair('hypergraph/device')
    this._stamper = new Stamper()
    this._network = new Network(this, { bootstrap: this.opts.bootstrap })
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
    } else {
      // A new identity, one restored from its phrase, or another device of
      // one, given its phrase by a device already in (lib/pairing.js).
      const mnemonic = this.opts.joinCode ? await this.#join(device) : (this.opts.mnemonic || null)
      this._identity = await Identity.create({ device, mnemonic })
      phrase.save(this.dir, this._identity.recoveryPhrase)
      const secrets = await Identity.secrets(this._identity.recoveryPhrase)
      if (!mnemonic) create = secrets.personal.keyPair
      await this.#setMeta('personal', { key: hex(Identity.personalKey(secrets.personal.keyPair, this.store.manifestVersion)), encryptionKey: hex(secrets.personal.encryptionKey) })
      await this.#setMeta('alone', !mnemonic)
      await this.#setMeta('identity', { proof: b4a.toString(this._identity.proof, 'hex') })
    }
    this._identity.recoveryPhrase = null // kept in its own file only (lib/phrase.js)
    this._wasAlone = !!(await this.#meta('alone'))

    await this.#openPersonal(create)
    for (const row of await this.db.find('@hg/spaces', {}).toArray()) {
      const space = new Space(this, { key: row.key, ns: row.ns })
      await space._open()
      this._spaces.set(space.hex, space)
      await this._network.join(space)
    }
    await this.#settle()
    this._headsTimer = setInterval(() => this._writeHeads().catch(safetyCatch), HEADS_MS)
    if (this._headsTimer.unref) this._headsTimer.unref()
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
    space.on('change', ({ types }) => { if (types.includes('hg/space')) this.#settle().catch(safetyCatch) })
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
    if (!personal || this.closed || personal.closed || !personal.state.isMember(this._identity.publicKey)) return
    if (personal.isRemoved(this._identity.publicKey, this._identity.device.publicKey)) return
    const me = this._identity.device.publicKey
    if (!(await this.#rows('hg/device')).some(({ values }) => b4a.equals(values.key, me))) {
      await personal._put('hg/device', { key: me, name: this.opts.deviceName || '' })
    }
    const listed = new Set()
    for (const { values } of await this.#rows('hg/space')) {
      listed.add(values.space)
      if (this.closed) return
      if (this._spaces.has(hex(z32.decode(values.space)))) continue
      await this.#keep(await this[symbols.openSpace](values.space), false)
    }
    for (const space of this._spaces.values()) {
      if (space.personal || listed.has(space.key) || !space.state.isMember(this._identity.publicKey)) continue
      await personal._put('hg/space', { space: space.key, name: space.name || '' })
    }
  }

  // The personal space's records of one of hypergraph's types, oldest first:
  // [{ row, values }].
  async #rows (type) {
    const personal = this._personal
    const key = { space: personal.keyBytes, type }
    const rows = await this.db.find('@hg/by-type', { gte: key, lte: key }).toArray()
    return rows.map((row) => ({ row, values: this.types.decode(type, row.fields, row.links) }))
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
      last = this.types.decode('hg/heads', row.fields, row.links)
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

  // --- network ---

  // One call: finds the members of every space, now and later.
  async connectToSwarm () {
    this.#open()
    await this._network.connect()
  }

  // --- spaces ---

  async createSpace ({ name = '', policy = 'auto' } = {}) {
    this.#open()
    const space = new Space(this, { ns: hex(crypto.randomBytes(16)) })
    await space._open({ create: { name, policy } })
    await this.#keep(space)
    return space
  }

  // Joins the space an invite link is for; resolves to it once a member who
  // records decisions has let us in.
  async redeemInvite (link, { timeout = REDEEM_TIMEOUT } = {}) {
    this.#open()
    const inv = invites.decodeLink(link)
    if (inv.expires && Date.now() > inv.expires) throw new HypergraphError('INVITE_EXPIRED', 'This invite link has expired')
    const space = await this[symbols.openSpace](inv.space)
    await this.connectToSwarm()
    if (!(await space._redeem(invites.makeRedemption(inv, this._identity, space.decisions.localKey), timeout))) {
      throw new HypergraphError('INVITE_INVALID', `No member able to let you in answered within ${Math.round(timeout / 1000)} s (the link may be used up, expired or revoked, or they are offline)`)
    }
    await this.#keep(space)
    return space
  }

  // The spaces held here: [{ key, name, parent }] (not the personal space).
  spaces () {
    return [...this._spaces.values()].filter((s) => !s.personal).map((s) => ({ key: s.key, name: s.name, parent: s.parent }))
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
  async [symbols.openSpace] (key, { encryptionKey = null } = {}) {
    const bytes = typeof key === 'string' ? z32.decode(key) : key
    const held = this._spaces.get(hex(bytes))
    if (held) return held
    const space = new Space(this, { key: bytes, ns: hex(bytes), encryptionKey })
    await space._open()
    this._spaces.set(space.hex, space)
    await this._network.join(space)
    return space
  }

  // Keeps a space here for good; lists it in the personal space (so this
  // identity's other devices join it too) unless it came from there.
  async #keep (space, list = true) {
    this._spaces.set(space.hex, space)
    await this._queue.run((tx) => tx.insert('@hg/spaces', { key: space.keyBytes, ns: space.ns, name: space.name || '', parent: null, joined: Date.now() }))
    await this._network.join(space)
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
