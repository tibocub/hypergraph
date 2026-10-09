// The log directory and the space channel (research R10; experiment 1). A
// space's directory is the set of device logs known to write in it. Members
// exchange it on a Protomux channel per space ('hypergraph/space', id = the
// space key): on open, a summary (count + XOR digest); if different, the
// whole list; a newly accepted log is announced with a notice. The summary is
// sent again when the directory changes and every SUMMARY_MS, so a log whose
// single notice was missed (lost, or its header fetch timed out) still
// arrives without a reconnect. Before keeping
// or passing a log on, a member fetches its header and checks it (lib/gate.js):
// a log whose author may not write is never kept nor passed on; if the
// membership decision may still come, the log waits in `pending` (bounded)
// and is checked again when the decisions change. A log whose author lost the
// right to write later is cut (lib/index/indexer.js): kept up to its cut, or
// dropped if nothing in it counts.

const c = require('compact-encoding')
const b4a = require('b4a')
const z32 = require('z32')
const crypto = require('hypercore-crypto')
const safetyCatch = require('safety-catch')
const enc = require('./encodings.js')
const gate = require('./gate.js')
const { Identity } = require('./identity.js')
const symbols = require('./symbols.js')

const PROTOCOL = 'hypergraph/space'
const HEADER_MS = 10000 // waiting for a log's header from peers
const MAX_PENDING = 1000
const CHUNK = 1000 // keys per `logs` message
const SUMMARY_MS = 10000 // the summary is sent again this often (plus up to a second)
const CHANGED_MS = 250 // and this long after the directory changed
const REASK_MS = 60000 // the same difference is asked about again after this long

const hex = (b) => b4a.toString(b, 'hex')

class Directory {
  // space: key, discoveryKey, getCore(key), state, limitOf(), mayRetry(),
  // accepted(log), redeem(bytes) (lib/space.js)
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
    this.timers = new Set()
    this.#every()
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
    const log = { key, core, identity: who.identity, device: who.device, indexed, scanned: indexed, holes: new Set(), arrived: new Set(), limit, cut, own, indexing: null, again: false, dropped: 0, droppedBlocks: 0, ixBytes: 0 }
    this.logs.set(h, log)
    this.pending.delete(h)
    xor(this.digest, crypto.hash(key))
    this.#changed()
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
      if (this.space.limitOf(waiting.identity, waiting.device, key) > 1) await this.#fetch(key)
      return
    }
    await this.#fetch(key)
  }

  async #fetch (key) {
    const h = hex(key)
    this.inflight.add(h)
    const core = this.space.getCore(key)
    let keep = false
    try {
      await core.ready()
      const header = await core.get(0, { timeout: HEADER_MS })
      if (this.closed) return
      const res = gate.checkLog(header, key, this.space.key, this.space)
      if (res.ok) {
        keep = true
        await this.accept(key, core, res, { limit: res.limit })
      } else if (res.retry) {
        if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value)
        this.pending.set(h, { key, identity: res.identity, device: res.device })
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
    const space = this.space
    for (const { key, identity, device } of this.pending.values()) {
      if (space.limitOf(identity, device, key) > 1) this.consider(key).catch(safetyCatch)
    }
    for (const log of [...this.logs.values()]) {
      const limit = space.limitOf(log.identity, log.device, log.key)
      if (limit < log.limit || (log.cut !== limit && limit !== Infinity)) this.space.cut(log, limit)
    }
  }

  // A log cut before anything in it counted: not kept, not passed on.
  drop (log) {
    const h = hex(log.key)
    if (!this.logs.delete(h)) return
    xor(this.digest, crypto.hash(log.key))
    this.refused.add(h)
    this.#changed()
  }

  // The summary to every peer, every SUMMARY_MS.
  #every () {
    if (this.closed) return
    this.#later(SUMMARY_MS + Math.floor(Math.random() * 1000), () => {
      this.#sendSummary()
      this.#every()
    })
  }

  // The directory changed: the summary soon (once for a burst of changes).
  #changed () {
    if (this._changedTimer || this.closed) return
    this._changedTimer = this.#later(CHANGED_MS, () => {
      this._changedTimer = null
      this.#sendSummary()
    })
  }

  #later (ms, fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.closed) fn()
    }, ms)
    if (timer.unref) timer.unref()
    this.timers.add(timer)
    return timer
  }

  #sendSummary () {
    for (const ch of this.channels) ch.messages[0].send({ count: this.logs.size, digest: this.digest })
  }

  // Opens the space channel on a connection's muxer.
  attach (mux, peer) {
    if (this.closed) return
    const ch = mux.createChannel({
      protocol: PROTOCOL,
      id: this.space.discoveryKey, // not the key: every peer on the connection sees the id
      onopen: () => {
        this.channels.add(ch)
        ch.messages[0].send({ count: this.logs.size, digest: this.digest })
        if (this.space.proof) ch.messages[7].send(this.space.proof)
        this.space.channelOpened(ch)
        this.space.peersChanged()
      },
      onclose: () => {
        this.channels.delete(ch)
        this.space.peersChanged()
      }
    })
    if (!ch) return
    ch.peer = peer
    ch.asked = null // the last difference asked about: { diff, at }
    ch.identity = null
    ch.addMessage({ encoding: enc.summary, onmessage: (m) => { if (!this.#deaf('summaries', ch, m)) this.#onSummary(ch, m) } })
    ch.addMessage({ encoding: c.none, onmessage: () => this.#onWant(ch) })
    ch.addMessage({ encoding: enc.logs, onmessage: (keys) => { for (const k of keys) this.consider(k).catch(safetyCatch) } })
    ch.addMessage({ encoding: enc.logKey, onmessage: (k) => { if (!this.#deaf('notices')) this.consider(k).catch(safetyCatch) } }) // notice
    ch.addMessage({ encoding: enc.logKey, onmessage: (k) => { if (this.logs.has(hex(k))) ch.messages[2].send([k]) } }) // get
    ch.addMessage({ encoding: enc.redeem, onmessage: (m) => this.space.redeem(m.redemption, ch).catch(safetyCatch) })
    ch.addMessage({ encoding: enc.ask, onmessage: (m) => this.space.ask(m.decision).catch(safetyCatch) })
    ch.addMessage({ encoding: c.buffer, onmessage: (proof) => this.#onHello(ch, proof) }) // hello: the peer's device proof
    ch.open()
  }

  // Tests only (lib/testing.js deafen): messages of this kind are dropped.
  #deaf (kind, ch, m) {
    const deaf = this[symbols.deaf]
    if (!deaf || !deaf[kind]) return false
    if (m) deaf.dropped.push({ peer: ch.peer ? z32.encode(ch.peer) : null, digest: hex(m.digest) })
    return true
  }

  // A peer's device proof: who it is, if the proof is for the device at the
  // other end of this connection (its Noise key: the swarm uses device keys).
  #onHello (ch, proof) {
    const info = Identity.verifyDevice(proof)
    if (!info || !ch.peer || !b4a.equals(info.device, ch.peer) || ch.identity) return
    ch.identity = info.identity
    this.space.peersChanged()
  }

  // The peers on this space's channel: [{ identity (null until its hello),
  // device }].
  peerList () {
    return [...this.channels].map((ch) => ({ identity: ch.identity, device: ch.peer }))
  }

  // A peer's summary: if its directory differs, ask for its list — not again
  // for the same difference (both digests unchanged) before REASK_MS, as the
  // summary now comes every little while.
  #onSummary (ch, { count, digest }) {
    if (!this.reached) {
      this.reached = true
      this.space.progress()
    }
    if (count === this.logs.size && b4a.equals(digest, this.digest)) return
    const diff = hex(digest) + hex(this.digest)
    if (ch.asked && ch.asked.diff === diff && Date.now() - ch.asked.at < REASK_MS) return
    ch.asked = { diff, at: Date.now() }
    ch.messages[1].send(null)
  }

  #onWant (ch) {
    const keys = this.keys()
    for (let i = 0; i < keys.length; i += CHUNK) ch.messages[2].send(keys.slice(i, i + CHUNK))
  }

  // Asks every peer of this space to record a decision this device can't
  // write itself (a writer claim, a device removal: research.md A8).
  sendAsk (decision) {
    for (const ch of this.channels) ch.messages[6].send({ decision })
  }

  // Sends a redemption to every peer of this space (a newcomer's request).
  sendRedeem (redemption) {
    for (const ch of this.channels) ch.messages[5].send({ redemption })
  }

  close () {
    this.closed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const ch of this.channels) ch.close()
    this.channels.clear()
  }
}

function xor (into, b) {
  for (let i = 0; i < into.byteLength; i++) into[i] ^= b[i]
}

module.exports = { Directory, PROTOCOL }
