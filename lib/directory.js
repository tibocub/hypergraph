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
const activity = require('./activity.js')

const PROTOCOL = 'hypergraph/space'
const HEADER_MS = 10000 // waiting for a log's header from peers
const MAX_PENDING = 1000
const CHUNK = 1000 // keys per `logs` message
const SUMMARY_MS = 10000 // the summary is sent again this often (plus up to a second)
const CHANGED_MS = 250 // and this long after the directory changed
const REASK_MS = 60000 // the same difference is asked about again after this long
const SOME = 16 // logs learnt from activity entries: headers fetched at once (story 9)
const MAX_SOME = 256 // and waiting (more are dropped: entries for them come again)

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
    this.some = [] // logs learnt from activity entries, waiting for a header fetch
    this.someRunning = 0
    this.#every()
  }

  get peers () { return this.channels.size }

  keys () {
    return [...this.logs.values()].map((l) => l.key)
  }

  // A log that passed the gate (or was stored as such before).
  // from: the first block read here (story 9; null: none yet, a big space's
  // log outside the periods read); act: where deriving its activity entries
  // stands.
  async accept (key, core, who, { indexed = 1, own = false, announce = true, limit = Infinity, cut = null, from, act = null } = {}) {
    const h = hex(key)
    if (this.logs.has(h) || this.closed) return null
    if (from === undefined) from = own ? 1 : await this.space.fromOf(key)
    if (this.logs.has(h) || this.closed) return null
    const start = from === null ? indexed : Math.max(indexed, from)
    // indexed: every block below it is done (kept or skipped); scanned: the
    // next block to look at; holes: blocks below `scanned` not held yet
    // (lib/index/indexer.js); limit: a cut, or Infinity; skip: blocks done
    // already, when reading starts earlier (story 9).
    const log = { key, core, identity: who.identity, device: who.device, indexed: start, scanned: start, holes: new Set(), arrived: new Set(), limit, cut, own, indexing: null, again: false, dropped: 0, droppedBlocks: 0, ixBytes: 0, from, skip: null, act: act || { next: from || 1, last: (from || 1) - 1, period: -1 } }
    this.logs.set(h, log)
    this.pending.delete(h)
    xor(this.digest, crypto.hash(key))
    this.#changed()
    await this.space.accepted(log)
    if (announce) for (const ch of this.channels) ch.messages[3].send(key)
    return log
  }

  // A log learnt from an activity entry (story 9): its header is fetched and
  // checked like any, a few at a time; more wait, up to MAX_SOME (throwaway
  // keys cost a bounded queue, not storage).
  considerSome (key) {
    const h = hex(key)
    if (this.closed || this.logs.has(h) || this.refused.has(h) || this.inflight.has(h) || this.pending.has(h)) return
    if (this.some.some((k) => b4a.equals(k, key))) return
    if (this.some.length >= MAX_SOME) return
    this.some.push(key)
    this.#drainSome()
  }

  #drainSome () {
    while (this.someRunning < SOME && this.some.length && !this.closed) {
      const key = this.some.shift()
      this.someRunning++
      this.consider(key).catch(safetyCatch).finally(() => {
        this.someRunning--
        const h = hex(key)
        if (this.refused.has(h)) this.space.activity.logRefused(key)
        this.#drainSome()
      })
    }
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
        this.space.activity.logRefused(key)
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
    for (const ch of this.channels) ch.messages[0].send(this.#summary())
  }

  // count, digest, and (story 9) how many records the logs held here hold.
  #summary () {
    let records = 0
    for (const log of this.logs.values()) records += Math.max(0, Math.min(log.core.length, log.limit) - 1)
    return { count: this.logs.size, digest: this.digest, records }
  }

  // Opens the space channel on a connection's muxer.
  attach (mux, peer) {
    if (this.closed) return
    const ch = mux.createChannel({
      protocol: PROTOCOL,
      id: this.space.discoveryKey, // not the key: every peer on the connection sees the id
      onopen: () => {
        this.channels.add(ch)
        ch.messages[0].send(this.#summary())
        if (this.space.proof) ch.messages[7].send(this.space.proof)
        this.space.channelOpened(ch)
        this.space.activity.channelOpened(ch)
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
    // story 9 (research.md A14): an activity entry, a request for the entries
    // from a period on, a list in answer
    ch.addMessage({ encoding: activity.entry, onmessage: (e) => { if (!this.#deaf('notices')) this.space.activity.receive(e, ch).catch(safetyCatch) } })
    ch.addMessage({ encoding: activity.want, onmessage: (m) => this.space.activity.onWant(ch, m).catch(safetyCatch) })
    ch.addMessage({ encoding: activity.list, onmessage: (m) => this.space.activity.onList(ch, m).catch(safetyCatch) })
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
  #onSummary (ch, { count, digest, records }) {
    this.space.summary({ count, records }) // a newcomer chooses how to read (story 9)
    if (!this.reached) {
      this.reached = true
      this.space.progress()
    }
    if (this.space.byActivity) return // a big space: logs come from the activity lists of the periods read
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
    this.some = []
    for (const ch of this.channels) ch.close()
    this.channels.clear()
  }
}

function xor (into, b) {
  for (let i = 0; i < into.byteLength; i++) into[i] ^= b[i]
}

module.exports = { Directory, PROTOCOL }
