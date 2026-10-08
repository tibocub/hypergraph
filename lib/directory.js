// The log directory and the space channel (research R10; experiment 1). A
// space's directory is the set of device logs known to write in it. Members
// exchange it on a Protomux channel per space ('hypergraph/space', id = the
// space key): on open, a summary (count + XOR digest); if different, the
// whole list; a newly accepted log is announced with a notice. Before keeping
// or passing a log on, a member fetches its header and checks it (lib/gate.js):
// a log whose author may not write is never kept nor passed on; if the
// membership decision may still come, the log waits in `pending` (bounded)
// and is checked again when the decisions change. A log whose author lost the
// right to write later is cut (lib/index/indexer.js): kept up to its cut, or
// dropped if nothing in it counts.

const c = require('compact-encoding')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const safetyCatch = require('safety-catch')
const enc = require('./encodings.js')
const gate = require('./gate.js')

const PROTOCOL = 'hypergraph/space'
const HEADER_MS = 10000 // waiting for a log's header from peers
const MAX_PENDING = 1000
const CHUNK = 1000 // keys per `logs` message

const hex = (b) => b4a.toString(b, 'hex')

class Directory {
  // space: key, store, state, me, own (OwnLog), accepted(log), redeem(bytes)
  constructor (space) {
    this.space = space
    this.logs = new Map() // hex -> a held log (see accept())
    this.pending = new Map() // hex -> { key, identity } (valid, author not a member yet)
    this.refused = new Set() // hex: bad headers, never fetched again
    this.inflight = new Set()
    this.channels = new Set()
    this.reached = false // a summary came from a peer since opening
    this.digest = b4a.alloc(32)
    this.closed = false
  }

  get peers () { return this.channels.size }

  keys () {
    return [...this.logs.values()].map((l) => l.key)
  }

  // A log that passed the gate (or was stored as such before).
  async accept (key, core, who, { indexed = 1, own = false, announce = true, limit = Infinity, cut = null } = {}) {
    const h = hex(key)
    if (this.logs.has(h) || this.closed) return null
    // indexed: every block below it is done (kept or skipped); scanned: the
    // next block to look at; holes: blocks below `scanned` not held yet
    // (lib/index/indexer.js); limit: a cut, or Infinity.
    const log = { key, core, identity: who.identity, device: who.device, indexed, scanned: indexed, holes: new Set(), arrived: new Set(), limit, cut, own, indexing: null, again: false }
    this.logs.set(h, log)
    this.pending.delete(h)
    xor(this.digest, crypto.hash(key))
    await this.space.accepted(log)
    if (announce) for (const ch of this.channels) ch.messages[3].send(key)
    return log
  }

  // Someone told us of `key`: fetch its header, check it, keep it or not.
  async consider (key) {
    const h = hex(key)
    if (this.closed || this.logs.has(h) || this.refused.has(h) || this.inflight.has(h)) return
    const waiting = this.pending.get(h)
    if (waiting) {
      if (this.space.state.limitOf(waiting.identity, key) > 1) await this.#fetch(key)
      return
    }
    await this.#fetch(key)
  }

  async #fetch (key) {
    const h = hex(key)
    this.inflight.add(h)
    const core = this.space.store.get({ key })
    let keep = false
    try {
      await core.ready()
      const header = await core.get(0, { timeout: HEADER_MS })
      if (this.closed) return
      const res = gate.checkLog(header, key, this.space.key, this.space.state)
      if (res.ok) {
        keep = true
        await this.accept(key, core, res, { limit: res.limit })
      } else if (res.retry) {
        if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value)
        this.pending.set(h, { key, identity: res.identity })
      } else {
        this.refused.add(h)
      }
    } catch (err) {
      safetyCatch(err) // no header within the bound: someone may offer it again
    } finally {
      this.inflight.delete(h)
      if (!keep) {
        await core.clear(0, 1).catch(safetyCatch)
        await core.close().catch(safetyCatch)
      }
    }
  }

  // The decisions changed: logs waiting for a membership may pass now, and
  // held logs whose author lost the right to write are cut.
  recheck () {
    const state = this.space.state
    for (const { key, identity } of this.pending.values()) {
      if (state.limitOf(identity, key) > 1) this.consider(key).catch(safetyCatch)
    }
    for (const log of [...this.logs.values()]) {
      const limit = state.limitOf(log.identity, log.key)
      if (limit < log.limit || (log.cut !== limit && limit !== Infinity)) this.space.cut(log, limit)
    }
  }

  // A log cut before anything in it counted: not kept, not passed on.
  drop (log) {
    const h = hex(log.key)
    if (!this.logs.delete(h)) return
    xor(this.digest, crypto.hash(log.key))
    this.refused.add(h)
  }

  // Opens the space channel on a connection's muxer.
  attach (mux, peer) {
    if (this.closed) return
    const ch = mux.createChannel({
      protocol: PROTOCOL,
      id: this.space.key,
      onopen: () => {
        this.channels.add(ch)
        ch.messages[0].send({ count: this.logs.size, digest: this.digest })
        this.space.channelOpened(ch)
      },
      onclose: () => {
        this.channels.delete(ch)
      }
    })
    if (!ch) return
    ch.peer = peer
    ch.addMessage({ encoding: enc.summary, onmessage: (m) => this.#onSummary(ch, m) })
    ch.addMessage({ encoding: c.none, onmessage: () => this.#onWant(ch) })
    ch.addMessage({ encoding: enc.logs, onmessage: (keys) => { for (const k of keys) this.consider(k).catch(safetyCatch) } })
    ch.addMessage({ encoding: enc.logKey, onmessage: (k) => this.consider(k).catch(safetyCatch) }) // notice
    ch.addMessage({ encoding: enc.logKey, onmessage: (k) => { if (this.logs.has(hex(k))) ch.messages[2].send([k]) } }) // get
    ch.addMessage({ encoding: enc.redeem, onmessage: (m) => this.space.redeem(m.redemption, ch).catch(safetyCatch) })
    ch.open()
  }

  #onSummary (ch, { count, digest }) {
    if (!this.reached) {
      this.reached = true
      this.space.progress()
    }
    if (count !== this.logs.size || !b4a.equals(digest, this.digest)) ch.messages[1].send(null)
  }

  #onWant (ch) {
    const keys = this.keys()
    for (let i = 0; i < keys.length; i += CHUNK) ch.messages[2].send(keys.slice(i, i + CHUNK))
  }

  // Sends a redemption to every peer of this space (a newcomer's request).
  sendRedeem (redemption) {
    for (const ch of this.channels) ch.messages[5].send({ redemption })
  }

  close () {
    this.closed = true
    for (const ch of this.channels) ch.close()
    this.channels.clear()
  }
}

function xor (into, b) {
  for (let i = 0; i < into.byteLength; i++) into[i] ^= b[i]
}

module.exports = { Directory, PROTOCOL }
