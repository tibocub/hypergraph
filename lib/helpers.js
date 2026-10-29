// Helpers (spec 013): blind peers listed in a space's settings keep its data
// available while its members are offline. Each space, once online, runs one
// blind-peering client on the instance's DHT and hands the helpers its
// decision log and every log it holds; a member reading later gets them back
// by plain replication over the same connection. Nothing is awaited: a helper
// down, or a bogus key, changes nothing for opening, writing or reading
// (specs/research/availability.md: the awaited addAutobase() hangs while one
// helper is down).

const BlindPeering = require('blind-peering')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')

class Helpers {
  // space: state.helpers, decisionLog, directory.logs, hg (store, _network)
  constructor (space) {
    this.space = space
    this.peering = null
    this.keys = '' // the list the client runs with
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
    for (const log of this.space.directory.logs.values()) this.hold(log.core)
  }

  // A log held here, handed over (and followed live by the helpers).
  hold (core) {
    if (this.peering) this.peering.addCoreBackground(core)
  }

  close () {
    this.closed = true
    if (this.peering) this.peering.close().catch(safetyCatch)
    this.peering = null
  }
}

module.exports = { Helpers }
