// Helpers (spec 013): blind peers listed in a space's settings keep its data
// available while its members are offline. Each space, once online, runs one
// blind-peering client on the instance's DHT and hands the helpers its
// decision log and every log it holds; a member reading later gets them back
// by plain replication over the same connection. Nothing is awaited: a helper
// down, or a bogus key, changes nothing for opening, writing or reading
// (specs/research/availability.md: the awaited addAutobase() hangs while one
// helper is down).
//
// Spec 017: a held log is open only for its hand-off. It is opened, given to
// blind-peering, and released once the request was written to every helper
// it goes to (`sent`: test/next/net/handoff.js); the helper keeps mirroring
// it from this member, which serves it closed. Handed again when it grew.
// A hand-off not sent within HAND_MS (a helper down) is tried again later.

const BlindPeering = require('blind-peering')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')

const HAND_MS = 10000
const RETRY_MS = 60000

class Helpers {
  // space: state.helpers, decisionLog, directory, hg (store, _network)
  constructor (space) {
    this.space = space
    this.peering = null
    this.keys = '' // the list the client runs with
    this.queue = new Set() // logs to hand off, one at a time
    this.unsent = new Set() // logs whose hand-off wasn't sent: tried again every RETRY_MS
    this.running = false
    this.timer = null
    this.closed = false
  }

  // The list may have changed, or the instance just went online.
  update () {
    const network = this.space.hg._network
    const dht = network.swarm && network.swarm.dht
    const keys = this.space.state.helpers
    if (this.closed || !dht || keys.join() === this.keys) return
    this.keys = keys.join()
    if (this.peering) this.peering.close().catch(safetyCatch)
    this.peering = null
    if (!keys.length) return
    this.peering = new BlindPeering(dht, this.space.hg.store, { keys: keys.map((k) => b4a.from(k, 'hex')), wakeup: network.wakeup })
    this.peering.addAutobaseBackground(this.space.decisionLog.base)
    for (const log of this.space.directory.logs.values()) {
      log.handed = -1 // a new list: handed to it from the start
      this.hold(log)
    }
  }

  // A log held here, handed over (followed live by the helpers while open).
  hold (log) {
    if (!this.peering || this.closed || log.handed >= log.length) return
    this.queue.add(log)
    this.#drain()
  }

  async #drain () {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.size && !this.closed && this.peering) {
        const log = this.queue.values().next().value
        this.queue.delete(log)
        await this.#handOff(log).catch(safetyCatch)
      }
    } finally {
      this.running = false
    }
  }

  async #handOff (log) {
    const peering = this.peering
    const dir = this.space.directory
    if (dir.logs.get(b4a.toString(log.key, 'hex')) !== log) return
    const core = await dir.open(log)
    try {
      const length = core.length
      let timer = null
      const late = new Promise((resolve) => { timer = setTimeout(resolve, HAND_MS) })
      await Promise.race([peering.addCore(core), late])
      clearTimeout(timer)
      if (sent(peering, core)) {
        log.handed = length
        this.unsent.delete(log)
      } else {
        this.unsent.add(log)
        this.#retryLater()
      }
    } finally {
      dir.release(log)
    }
  }

  #retryLater () {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = null
      for (const log of this.unsent) this.hold(log)
      this.unsent.clear()
    }, RETRY_MS)
    if (this.timer.unref) this.timer.unref()
  }

  close () {
    this.closed = true
    clearTimeout(this.timer)
    this.queue.clear()
    this.unsent.clear()
    if (this.peering) this.peering.close().catch(safetyCatch)
    this.peering = null
  }
}

// Was the request for `core` written to every helper it goes to? (blind-
// peering's own state: `addCore` resolves once connected, then flushed.)
function sent (peering, core) {
  for (const peer of peering.blindPeers.values()) {
    const info = peer.cores.get(core)
    if (info && !(peer.connected && info.flushed === peer.connects)) return false
  }
  return true
}

module.exports = { Helpers, sent }
