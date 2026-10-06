const ReadyResource = require('ready-resource')
const ProtomuxWakeup = require('protomux-wakeup')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const { Control, sign, mayAssign, RANK } = require('./control')

// Scaling v2 prototype (spec 007): a community where cost follows what a
// peer holds and reads. Unstable; not part of the v1 API. See
// docs/v2-prototype.md and specs/007-scaling-v2-prototype/.

const toHex = (k) => (b4a.isBuffer(k) ? b4a.toString(k, 'hex') : String(k))

class Community extends ReadyResource {
  #store
  #identity
  #key
  #wakeup
  #control = null

  /**
   * @param {Object} store - Corestore
   * @param {Object} opts
   * @param {{ keyPair: Object, seed?: Buffer }} opts.identity - the member
   * @param {Buffer|string} [opts.key] - an existing community; omit to create one
   */
  constructor (store, opts = {}) {
    super()
    if (!opts.identity || !opts.identity.keyPair) throw new Error('opts.identity.keyPair is required')
    this.#store = store
    this.#identity = opts.identity
    this.#key = opts.key ? b4a.from(toHex(opts.key), 'hex') : null
    this.#wakeup = new ProtomuxWakeup()
    this.ready().catch(() => {})
  }

  get key () { return this.#control ? this.#control.key : null }
  get localKey () { return this.#control ? this.#control.localKey : null }
  get identity () { return this.#identity }
  get control () { return this.#control }

  async _open () {
    // One namespace per community: two Autobases opened from the same
    // namespace get the same local writer key (bench/roster.js).
    const ns = this.#store.namespace('hg-v2:' + (this.#key ? toHex(this.#key) : toHex(hcrypto.randomBytes(16))))
    this.#control = new Control(ns, this.#key, { wakeup: this.#wakeup })
    await this.#control.ready()
    if (!this.#key) await this.#control.append(this.#sign({ type: 'init', name: '' }))
  }

  async _close () {
    if (this.#control) await this.#control.close()
    this.#wakeup.destroy()
  }

  /** Wire a replication stream (the control log's writer discovery included). */
  replicate (isInitiatorOrStream, opts) {
    const stream = this.#store.replicate(isInitiatorOrStream, opts)
    this.#wakeup.addStream(stream)
    return stream
  }

  async update () {
    if (!this.opened) await this.ready()
    await this.#control.update()
  }

  // ── control state (synchronous: kept in memory, small) ───────────────────

  get #state () { return this.#control.state }
  role (pubkey) { const r = this.#state.roles[toHex(pubkey)]; return r ? r.role : null }
  roles () { return Object.fromEntries(Object.entries(this.#state.roles).map(([k, v]) => [k, v.role])) }
  channels () {
    return Object.entries(this.#state.channels).map(([id, c]) => ({ id, name: c.name, segmentMs: c.segmentMs }))
  }
  channel (id) { return this.#state.channels[id] || null }
  banned (pubkey) { return this.#state.bans[toHex(pubkey)] || null }
  hidden (author, log, seq) { return this.#state.hides[`${toHex(author)}:${toHex(log)}:${seq}`] || null }
  keepers (channelId) { return this.#state.keepers[channelId] || [] }

  // ── administration ───────────────────────────────────────────────────────

  #sign (event, keyPair = this.#identity.keyPair) {
    return sign(this.#control.hex, event, keyPair)
  }

  #myRole () { return this.role(this.#identity.keyPair.publicKey) }

  #requireWriter () {
    if (!this.#control.writable) throw new Error('This member is not a writer of the control log')
  }

  async setRole (pubkey, role, opts = {}) {
    if (!this.opened) await this.ready()
    const member = toHex(pubkey)
    if (!mayAssign(this.#myRole(), this.role(member), role || null)) throw new Error('Setting this role is not allowed for this member')
    this.#requireWriter()
    await this.#control.append(this.#sign({ type: 'role', member, role: role || null, writer: opts.writer ? toHex(opts.writer) : null }))
  }

  async createChannel ({ name = '', segmentMs = 3600000 } = {}) {
    if (!this.opened) await this.ready()
    if (!((RANK[this.#myRole()] || 0) >= RANK.admin)) throw new Error('Creating a channel is not allowed for this member')
    this.#requireWriter()
    const id = toHex(hcrypto.randomBytes(16))
    await this.#control.append(this.#sign({ type: 'channel', id, name, segmentMs }))
    return id
  }

  async ban (pubkey, { reason = '' } = {}) {
    await this.#moderate({ type: 'ban', member: toHex(pubkey), reason })
  }

  async unban (pubkey) {
    await this.#moderate({ type: 'unban', member: toHex(pubkey) })
  }

  async hide ({ author, log, seq }, { reason = '' } = {}) {
    await this.#moderate({ type: 'hide', member: toHex(author), log: toHex(log), seq, reason })
  }

  async #moderate (event) {
    if (!this.opened) await this.ready()
    if (!((RANK[this.#myRole()] || 0) >= RANK.mod)) throw new Error('Moderation is not allowed for this member')
    this.#requireWriter()
    await this.#control.append(this.#sign(event))
  }

  // ── test hooks (prototype only) ──────────────────────────────────────────

  /** Append an event signed by another key pair, through this peer's writer. */
  async appendAs (keyPair, event) {
    this.#requireWriter()
    await this.#control.append(this.#sign(event, keyPair))
  }

  /** Append an event claiming `author` but signed by `signer`. */
  async appendForged (event, author, signer) {
    this.#requireWriter()
    const signed = this.#sign(event, signer)
    signed.author = toHex(author)
    await this.#control.append(signed)
  }
}

module.exports = { Community }
