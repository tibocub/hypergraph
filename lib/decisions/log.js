// A space's decision log (research R8): one Autobase, adapted from
// src/v2/control.js. Written by members whose role has `decide` (the owner at
// first); read and applied by every member. The space's key is the
// Autobase's key. Emits 'change' after the state moved.

const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const c = require('compact-encoding')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const { EventEmitter } = require('events')
const enc = require('../encodings.js')
const { applyNodes, initProof, DECISION_KEY } = require('./apply.js')
const { State } = require('./state.js')
const { HypergraphError } = require('../errors.js')

const WRITABLE_MS = 5000

// `promise`, or null after `ms` (the timer cleared either way).
async function within (promise, ms) {
  let timer = null
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, ms), null) })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

class Decisions extends EventEmitter {
  // keyPair: the first writer's (the personal space's comes from the
  // phrase); encryptionKey: the personal space's (research.md A7).
  constructor (store, key, { identity, wakeup, keyPair = null, encryptionKey = null } = {}) {
    super()
    this.setMaxListeners(0) // a space and its sub-spaces listen (story 8)
    this.identity = identity
    const secret = {}
    if (keyPair) secret.keyPair = keyPair
    if (encryptionKey) secret.encryptionKey = encryptionKey
    this.base = new Autobase(store, key || null, {
      ...secret,
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

  // `wait`: how long to wait to become a writer; `onwait()` is called every
  // second meanwhile (the space claims its writer key again).
  async append (decision, { wait = WRITABLE_MS, onwait = null } = {}) {
    // A member just given a role that records decisions becomes a writer once
    // its device sees the decision that added it.
    if (!this.base.writable) await this.#writable(wait, onwait)
    if (!this.base.writable) throw new HypergraphError('NOT_ALLOWED', 'Only members who record decisions (owner, admins, moderators) can do this')
    await this.base.append(c.encode(enc.decision, { stamp: Date.now(), ...decision }))
    await this.update()
  }

  #writable (ms, onwait) {
    return new Promise((resolve) => {
      const check = () => { if (this.base.writable || this.closed) done() }
      const done = () => {
        clearTimeout(timer)
        clearInterval(again)
        this.base.off('writable', check)
        this.base.off('update', check)
        resolve()
      }
      const timer = setTimeout(done, ms)
      const again = setInterval(() => {
        if (onwait) onwait()
        this.base.update().then(check, check)
      }, 1000)
      this.base.on('writable', check)
      this.base.on('update', check)
      this.base.update().then(check, check)
    })
  }

  // Catches up with the connected members who record decisions (ROADMAP
  // 2026-10-09): asks peers how long each writer's log is, then lets Autobase
  // apply what is new, within `ms`. Before refusing a decision method, so a
  // decision made a moment ago elsewhere (an unban) is not missed.
  async catchUp (ms) {
    if (this.closed) return
    const deadline = Date.now() + ms
    const keys = [...this.state.writerInfo.keys()].map((k) => b4a.from(k, 'hex'))
    const cores = keys.map((key) => this.base.store.get({ key }))
    try {
      const lengths = await within(Promise.all(cores.map(async (core) => {
        await core.ready()
        if (core.peers.length) await core.update({ wait: true }).catch(safetyCatch)
        return core.length
      })), ms)
      if (!lengths || this.closed) return
      this.base.hintWakeup(keys.map((key, i) => ({ key, length: lengths[i] })))
      for (;;) {
        await this.update()
        const behind = keys.some((key, i) => {
          const w = this.base.activeWriters.get(key)
          return !!w && w.length < lengths[i]
        })
        if (!behind || this.closed || Date.now() >= deadline) return
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer)
            this.base.off('update', done)
            resolve()
          }
          const timer = setTimeout(done, Math.min(100, deadline - Date.now()))
          this.base.on('update', done)
        })
      }
    } finally {
      for (const core of cores) core.close().catch(safetyCatch)
    }
  }

  // What the decision log stores here, estimated (lib/storage.js): its
  // writers' logs and its view. Never dropped.
  bytes () {
    let n = 0
    try {
      for (const w of this.base.activeWriters) n += w.core.byteLength + w.core.length * 150
      if (this.base.view && this.base.view.core) n += 2 * this.base.view.core.byteLength + this.base.view.core.length * 150
    } catch {}
    return n
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
    for await (const { key, value } of view.createReadStream({ lt: '~' })) entries.push([key, value]) // not the decision list
    this.state = State.from(entries)
  }

  // The decision list, newest first (lib/decisions/apply.js listDecision):
  // [{ seq, ...entry }] below `before` (a seq), at most `limit`; `scope`: the
  // decisions about one sub-space (hex), or (null) the space's own (story 8).
  async list ({ limit = 50, before = Infinity, scope = null } = {}) {
    const view = this.base.view
    if (!view || this.closed) return []
    const range = { gte: DECISION_KEY, lt: Number.isFinite(before) ? DECISION_KEY + String(before).padStart(12, '0') : DECISION_KEY + '~', reverse: true }
    const out = []
    for await (const { key, value } of view.createReadStream(range)) {
      if ((value.space || null) !== scope) continue
      out.push({ seq: Number(key.slice(DECISION_KEY.length)), ...value })
      if (out.length >= limit) break
    }
    return out
  }

  async close () {
    this.closed = true
    if (this._reloading) await this._reloading.catch(safetyCatch)
    await this.base.close()
  }
}

module.exports = { Decisions }
