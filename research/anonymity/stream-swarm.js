// A stand-in for Hyperswarm that finds no one: it dials addresses it is given
// (an onion or I2P address an invite would carry) and accepts what a listener
// hands it. Each raw socket gets the same Noise handshake Hyperswarm uses, so
// hypergraph sees an ordinary connection with the peer's device key.
//
// shortcut: no topic routing (every peer gets every space), no backoff; enough
// to measure, not a product transport.

const { EventEmitter } = require('events')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const b4a = require('b4a')

class StreamSwarm extends EventEmitter {
  // dial(address) -> Promise<raw duplex socket>
  constructor ({ keyPair, dial = null, peers = [] }) {
    super()
    this.keyPair = keyPair
    this.dht = null // nothing here touches a DHT
    this.connections = new Set()
    this._dial = dial
    this._peers = peers // addresses to dial once a topic is joined
    this._byKey = new Map() // device hex -> address, to dial again
    this._dialing = new Set()
    this._dialed = false
    this.destroyed = false
  }

  accept (socket) { return this._wrap(false, socket, null) }

  async dialAddress (address) {
    if (this.destroyed || this._dialing.has(address)) return
    this._dialing.add(address)
    try {
      const socket = await this._dial(address)
      await this._wrap(true, socket, address)
    } finally {
      this._dialing.delete(address)
    }
  }

  _wrap (initiator, socket, address) {
    const conn = new NoiseSecretStream(initiator, socket, { keyPair: this.keyPair })
    conn.on('error', () => {})
    return new Promise((resolve, reject) => {
      conn.once('open', () => {
        if (this.destroyed) { conn.destroy(); return resolve(null) }
        const h = b4a.toString(conn.remotePublicKey, 'hex')
        if (address) this._byKey.set(h, address)
        this.connections.add(conn)
        conn.on('close', () => this.connections.delete(conn))
        this.emit('connection', conn, { publicKey: conn.remotePublicKey })
        resolve(conn)
      })
      conn.once('close', () => reject(new Error('closed before the handshake')))
    })
  }

  join () {
    if (!this._dialed) {
      this._dialed = true
      for (const a of this._peers) this.dialAddress(a).catch((err) => this.emit('dial-error', err, a))
    }
    return { flushed: async () => {}, refresh: async () => {}, destroy: async () => {} }
  }

  joinPeer (key) {
    const address = this._byKey.get(b4a.toString(key, 'hex'))
    if (address) this.dialAddress(address).catch((err) => this.emit('dial-error', err, address))
  }

  leavePeer () {}
  async listen () {}
  async flush () {}

  async destroy () {
    this.destroyed = true
    for (const c of this.connections) c.destroy()
  }
}

module.exports = { StreamSwarm }
