// A space's decision log: one Autobase. Written by members whose role has
// `decide` (the owner at
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
/**
 * @typedef {import('./apply.js').View} View
 * @typedef {{ identity: import('../identity.js').Identity, wakeup: unknown, keyPair?: import('../identity.js').KeyPair | null, encryptionKey?: Uint8Array | null, now?: () => number }} DecisionsOptions
 * @typedef {import('../encodings.js').DecisionBody} DecisionBody
 * @typedef {Record<string, any> & { seq: number, type: string, at: number, writer: string, by: string | null, device: string | null, counted: boolean, space?: string }} ListedDecision A decision as the list keeps it (lib/decisions/apply.js listDecision).
 */

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T | null>}
 */
async function within (promise, ms) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  const timeout = /** @type {Promise<null>} */ (new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, ms), null) }))
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// The entries of `snap` (a snapshot of the view) changed since its version
// `from`, applied to `state` in place: the keys changed.
/**
 * @param {State} state
 * @param {View} snap
 * @param {number} from
 * @returns {Promise<Set<string>>}
 */
async function readChanges (state, snap, from) {
  /** @type {Set<string>} */
  const keys = new Set()
  for await (const { left, right } of snap.createDiffStream(from, { lt: '~' })) { // not the decision list
    const key = /** @type {import('./apply.js').ViewNode} */ (left || right).key
    state.apply(key, left ? left.value : null)
    keys.add(key)
  }
  return keys
}

class Decisions extends EventEmitter {
  /**
   * @param {import('corestore')} store
   * @param {Uint8Array | null} key
   * @param {DecisionsOptions} opts
   */
  constructor (store, key, { identity, wakeup, keyPair = null, encryptionKey = null, now = Date.now } = /** @type {DecisionsOptions} */ ({})) {
    super()
    this.now = now
    this.setMaxListeners(0) // a space and its sub-spaces listen
    this.identity = identity
    /** @type {{ keyPair?: import('../identity.js').KeyPair, encryptionKey?: Uint8Array }} */
    const secret = {}
    if (keyPair) secret.keyPair = keyPair
    if (encryptionKey) secret.encryptionKey = encryptionKey
    /** @type {import('autobase')<View>} */
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
    this.rebuilds = 0 // full reads of the view (open, Autobase reorders): tests count them
    this._read_at = null // { view, fork, version } the state was read at
    this._truncated = Infinity // the lowest length the view was truncated to since
    /** @type {import('hypercore') | null} */
    this._watched = null
    this._reloading = null
    this._again = false
    this.closed = false
    this.base.on('update', () => this.reload().catch(safetyCatch))
    // Autobase closes itself on any error, and with no listener (or one that
    // throws, as safetyCatch does for a TypeError) it ends the process: one
    // bad block from a peer killed every space of the app). Kept as this log's
    // `error`, told with 'failed': the space
    // shows it in status() (DECISIONS_FAILED).
    /** @type {Error | null} */
    this.error = null
    this.base.on('error', (err) => {
      if (this.closed || this.error) return
      this.error = err
      this.emit('failed', err)
    })
  }

  // Is the core `key` open in Autobase as a writer? Any peer can name a key
  // to Autobase (a wakeup), so it may be a member's message log, which the
  // directory must then not clear (lib/directory.js).
  /**
   * @param {Uint8Array} key
   */
  uses (key) {
    try { return !!this.base.activeWriters.get(key) } catch { return false }
  }

  get key () { return this.base.key }
  get discoveryKey () { return this.base.discoveryKey }
  get writable () { return this.base.writable }
  get localKey () { return this.base.local.key }

  async ready () {
    await this.base.ready()
    const view = this.base.view && this.base.view.core
    if (view && view.contiguousLength < view.length) this.emit('waiting') // its state is read from peers
    await this.reload()
    if (this.closed) throw new HypergraphError('CLOSED', 'This space is closed') // while it opened
  }

  /**
   * @param {{ name?: string, policy?: string, private?: boolean, parent?: Uint8Array | null, circle?: boolean }} [opts]
   */
  async init ({ name = '', policy = 'auto', private: priv = false, parent = null, circle = false } = {}) {
    await this.append({ type: 'space/init', name, parent, private: priv, policy, version: enc.VERSION, proof: initProof(this.identity, this.base.local.key, this.base.key), circle: circle || null })
  }

  /**
   * @param {DecisionBody} decision
   * @param {{ wait?: number, onwait?: (() => void) | null }} [opts]
   */
  async append (decision, { wait = WRITABLE_MS, onwait = null } = {}) {
    // A member just given a role that records decisions becomes a writer once
    // its device sees the decision that added it.
    if (!this.base.writable) await this.#writable(wait, onwait)
    if (!this.base.writable) throw new HypergraphError('NOT_ALLOWED', 'Only members who record decisions (owner, admins, moderators) can do this')
    await this.base.append(c.encode(enc.decision, { stamp: this.now(), ...decision }))
    await this.update()
  }

  /**
   * @param {number} ms
   * @param {(() => void) | null} onwait
   * @returns {Promise<void>}
   */
  #writable (ms, onwait) {
    return /** @type {Promise<void>} */ (new Promise((resolve) => {
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
    }))
  }

  // Catches up with the connected members who record decisions: asks peers how
  // long each writer's log is, then lets Autobase
  // apply what is new, within `ms`. Before refusing a decision method, so a
  // decision made a moment ago elsewhere (an unban) is not missed.
  /**
   * @param {number} ms
   */
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
        await /** @type {Promise<void>} */ (new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer)
            this.base.off('update', done)
            resolve()
          }
          const timer = setTimeout(done, Math.min(100, deadline - Date.now()))
          this.base.on('update', done)
        }))
      }
    } finally {
      for (const core of cores) core.close().catch(safetyCatch)
    }
  }

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

  // Brings the state to the view: the entries changed since the last read
  // are applied to it in place (Hyperbee's diff between the two versions), so
  // a decision costs what it changed, not every member. The whole view is
  // read again only on open and when Autobase reordered it (truncated it
  // below what was read). One at a time; a call during one runs another.
  // Emits 'change' (state, keys): the view keys that changed, null after a
  // full read (everything may have).
  async reload () {
    if (this.closed) return
    if (this._reloading) {
      this._again = true
      return this._reloading
    }
    /** @type {Set<string> | null} */
    let keys = new Set()
    this._reloading = (async () => {
      do {
        this._again = false
        const changed = await this._read()
        if (changed === null) keys = null
        else if (keys) for (const k of changed) keys.add(k)
      } while (this._again)
    })()
    try {
      await this._reloading
    } finally {
      this._reloading = null
    }
    this.emit('change', this.state, keys)
  }

  async _read () {
    const view = this.base.view
    if (!view || this.closed) return new Set()
    if (this._watched !== view.core) {
      this._watched = view.core
      view.core.on('truncate', (length) => { this._truncated = Math.min(this._truncated, length) })
    }
    const truncated = this._truncated
    this._truncated = Infinity
    const snap = view.snapshot()
    try {
      await snap.ready()
      const at = { view, fork: view.core.fork, version: snap.version }
      const last = this._read_at
      if (last && last.view === view && last.fork === at.fork && truncated >= last.version && at.version >= last.version) {
        const keys = at.version > last.version ? await readChanges(this.state, snap, last.version) : new Set()
        this._read_at = at
        return keys
      }
      /** @type {[string, any][]} */
      const entries = []
      for await (const { key, value } of snap.createReadStream({ lt: '~' })) entries.push([key, value])
      this.state = State.from(entries)
      this.rebuilds++
      this._read_at = at
      return null
    } catch (err) {
      this._read_at = null // half applied, or a truncation missed: read it whole next time
      throw err
    } finally {
      await snap.close()
    }
  }

  // A view entry's value (null: none), and the entries from `gte` below `lt`:
  // what the state doesn't hold (redeemed:, uses:).
  /**
   * @param {string} key
   * @returns {Promise<import('./apply.js').ViewNode['value'] | null>} The entry's JSON value.
   */
  async entry (key) {
    const node = this.base.view && !this.closed ? await this.base.view.get(key) : null
    return node ? node.value : null
  }

  // A view entry's value as far as the order is settled (signed by
  // the indexers: no reorder can change it any more), or null.
  /**
   * @param {string} key
   * @returns {Promise<import('./apply.js').ViewNode['value'] | null>} The entry's JSON value.
   */
  async final (key) {
    const view = this.base.view
    const length = view && !this.closed ? view.core.signedLength : 0
    if (!length) return null
    const co = view.checkout(length)
    try {
      const node = await co.get(key)
      return node ? node.value : null
    } finally {
      await co.close()
    }
  }

  /**
   * @param {string} gte
   * @param {string} lt
   * @returns {Promise<[string, import('./apply.js').ViewNode['value']][]>}
   */
  async entries (gte, lt) {
    const view = this.base.view
    if (!view || this.closed) return []
    /** @type {[string, any][]} */
    const out = []
    for await (const { key, value } of view.createReadStream({ gte, lt })) out.push([key, value])
    return out
  }

  /**
   * @param {{ limit?: number, before?: number, scope?: string | null }} [opts]
   * @returns {Promise<ListedDecision[]>}
   */
  async list ({ limit = 50, before = Infinity, scope = null } = {}) {
    const view = this.base.view
    if (!view || this.closed) return []
    const range = { gte: DECISION_KEY, lt: Number.isFinite(before) ? DECISION_KEY + String(before).padStart(12, '0') : DECISION_KEY + '~', reverse: true }
    /** @type {ListedDecision[]} */
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
    // The base first: a read of view blocks not held here waits for peers,
    // forever once the network is closed; closing the base ends it.
    await this.base.close()
    if (this._reloading) await this._reloading.catch(safetyCatch)
  }
}

module.exports = { Decisions, readChanges }
