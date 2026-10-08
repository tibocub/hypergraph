// A space's decision log (research R8): one Autobase, adapted from
// src/v2/control.js. Written by members whose role has `decide` (the owner at
// first); read and applied by every member. The space's key is the
// Autobase's key. Emits 'change' after the state moved.

const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const c = require('compact-encoding')
const safetyCatch = require('safety-catch')
const { EventEmitter } = require('events')
const enc = require('../encodings.js')
const { applyNodes, initProof } = require('./apply.js')
const { State } = require('./state.js')
const { HypergraphError } = require('../errors.js')

class Decisions extends EventEmitter {
  constructor (store, key, { identity, wakeup } = {}) {
    super()
    this.identity = identity
    this.base = new Autobase(store, key || null, {
      valueEncoding: c.raw,
      ackInterval: 1000,
      ackThreshold: 0,
      wakeup,
      open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false }),
      apply: (nodes, view, host) => applyNodes(nodes, view, host, { space: this.base.key })
    })
    this.state = new State()
    this._reloading = null
    this._again = false
    this.closed = false
    // The view moves when anyone's decision arrives, not only on update().
    this.base.on('update', () => this.reload().catch(safetyCatch))
    this.base.on('error', safetyCatch)
  }

  get key () { return this.base.key }
  get discoveryKey () { return this.base.discoveryKey }
  get writable () { return this.base.writable }
  get localKey () { return this.base.local.key }

  async ready () {
    await this.base.ready()
    await this.reload()
  }

  // The creator's first decision: the space's name and settings, and that
  // this writer speaks for the creator's identity.
  async init ({ name = '', policy = 'auto', private: priv = false, parent = null } = {}) {
    await this.append({ type: 'space/init', name, parent, private: priv, policy, version: enc.VERSION, proof: initProof(this.identity, this.base.local.key, this.base.key) })
  }

  async append (decision) {
    if (!this.base.writable) throw new HypergraphError('NOT_ALLOWED', 'Only members who record decisions (owner, admins) can do this')
    await this.base.append(c.encode(enc.decision, { stamp: Date.now(), ...decision }))
    await this.update()
  }

  async update () {
    await this.base.update()
    await this.reload()
  }

  // Rebuilds the state from the view: decisions are few (members, roles,
  // moderation), so a full read is cheap and always matches the view, even
  // after Autobase reorders. One at a time; a call during one runs another.
  async reload () {
    if (this.closed) return
    if (this._reloading) {
      this._again = true
      return this._reloading
    }
    this._reloading = (async () => {
      do {
        this._again = false
        await this._read()
      } while (this._again)
    })()
    try {
      await this._reloading
    } finally {
      this._reloading = null
    }
    this.emit('change', this.state)
  }

  async _read () {
    const view = this.base.view
    if (!view || this.closed) return
    const entries = []
    for await (const { key, value } of view.createReadStream()) entries.push([key, value])
    this.state = State.from(entries)
  }

  async close () {
    this.closed = true
    if (this._reloading) await this._reloading.catch(safetyCatch)
    await this.base.close()
  }
}

module.exports = { Decisions }
