// hypergraph/next: the new core (spec 011, specs/011-spaces-core/).
//
//   const { Hypergraph } = require('hypergraph/next')
//   const hg = await Hypergraph.open('./data', { types })
//
// One instance holds one identity and any number of spaces, in one storage
// folder (Corestore in cores/, the local index in index/), over one set of
// connections. The public API is in contracts/api.md.

const { EventEmitter } = require('events')
const path = require('path')
const b4a = require('b4a')
const z32 = require('z32')
const Corestore = require('corestore')
const HyperDB = require('hyperdb')
const crypto = require('hypercore-crypto')
const safetyCatch = require('safety-catch')
const def = require('./index/spec/hyperdb')
const { WriteQueue } = require('./index/indexer.js')
const { Types } = require('./types.js')
const { Identity } = require('./identity.js')
const { Stamper } = require('./stamp.js')
const { Network } = require('./network.js')
const { Space } = require('./space.js')
const invites = require('./invites.js')
const symbols = require('./symbols.js')
const phrase = require('./phrase.js')
const { HypergraphError, codes } = require('./errors.js')

const READ_TIMEOUT = 5000
const REDEEM_TIMEOUT = 60000
const hex = (b) => b4a.toString(b, 'hex')

class Hypergraph extends EventEmitter {
  constructor (dir, opts) {
    super()
    this.dir = dir
    this.opts = opts
    this.readTimeout = opts.readTimeout ?? READ_TIMEOUT
    this.types = new Types(opts.types || {})
    this._spaces = new Map() // space hex -> Space
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
    const saved = await this.#meta('identity')
    if (saved) {
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
      this._identity = await Identity.create({ device, mnemonic: this.opts.mnemonic || null })
      phrase.save(this.dir, this._identity.recoveryPhrase)
      await this.#setMeta('identity', { proof: b4a.toString(this._identity.proof, 'hex') })
    }
    this._identity.recoveryPhrase = null // kept in its own file only (lib/phrase.js)
    this._stamper = new Stamper()
    this._network = new Network(this, { bootstrap: this.opts.bootstrap })

    for (const row of await this.db.find('@hg/spaces', {}).toArray()) {
      const space = new Space(this, { key: row.key, ns: row.ns })
      await space._open()
      this._spaces.set(space.hex, space)
    }
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

  // The 24 words that restore this identity elsewhere: null if forgotten here
  // (or on a device added by another: story 3); once protected, only with
  // the password (NOT_ALLOWED otherwise).
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
    if (!(await space._redeem(invites.makeRedemption(inv, this._identity), timeout))) {
      throw new HypergraphError('INVITE_INVALID', `No member able to let you in answered within ${Math.round(timeout / 1000)} s (the link may be used up, expired or revoked, or they are offline)`)
    }
    await this.#keep(space)
    return space
  }

  // The spaces held here: [{ key, name, parent }].
  spaces () {
    return [...this._spaces.values()].map((s) => ({ key: s.key, name: s.name, parent: s.parent }))
  }

  space (key) {
    let bytes = null
    try { bytes = typeof key === 'string' ? z32.decode(key) : key } catch {}
    const space = bytes && this._spaces.get(hex(bytes))
    if (!space) throw new HypergraphError('NOT_FOUND', `No space ${key} here`)
    return space
  }

  // Opens a space by key without joining it (redeemInvite; tests).
  async [symbols.openSpace] (key) {
    const bytes = typeof key === 'string' ? z32.decode(key) : key
    const held = this._spaces.get(hex(bytes))
    if (held) return held
    const space = new Space(this, { key: bytes, ns: hex(bytes) })
    await space._open()
    this._spaces.set(space.hex, space)
    await this._network.join(space)
    return space
  }

  async #keep (space) {
    this._spaces.set(space.hex, space)
    await this._queue.run((tx) => tx.insert('@hg/spaces', { key: space.keyBytes, ns: space.ns, name: space.name || '', parent: null, joined: Date.now() }))
    await this._network.join(space)
  }

  #open () {
    if (this.closed) throw new HypergraphError('CLOSED', 'This hypergraph is closed')
  }

  close () {
    if (!this._closing) this._closing = this.#close()
    return this._closing
  }

  async #close () {
    this.closed = true
    if (this._network) await this._network.close().catch(safetyCatch)
    for (const space of this._spaces.values()) await space.close().catch(safetyCatch)
    if (this._queue) await this._queue.idle()
    if (this.db) await this.db.close().catch(safetyCatch)
    if (this.store) await this.store.close().catch(safetyCatch)
  }
}

module.exports = { Hypergraph, HypergraphError, codes }
