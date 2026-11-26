// What dht-rpc needs of udx-native (createSocket, bind, address, trySend, a `message` event, close, network
// interfaces), over one SAM datagram session. A host is a destination's base32 address; ports are ours, written in
// a 4-byte header (i2pd ignores SAM's FROM_PORT/TO_PORT on sending).
const { EventEmitter } = require('events')
const b4a = require('b4a')
const { addressOf } = require('./address.js')

/** @typedef {Awaited<ReturnType<typeof import('./sam.js').session>>} DatagramSession */

class Socket extends EventEmitter {
  /** @param {I2PUDX} udx */
  constructor (udx) {
    super()
    this.udx = udx
    this.bound = false
    this.port = 0
  }

  /** @param {number} [port] 0 or none: any free one */
  bind (port = 0) {
    if (!port) do port = 1 + Math.floor(Math.random() * 65534); while (this.udx.sockets.has(port))
    if (this.udx.sockets.has(port)) throw new Error('port in use')
    this.port = port
    this.bound = true
    this.udx.sockets.set(port, this)
  }

  address () { return { host: this.udx.address, family: 4, port: this.port } }

  /** @param {Uint8Array} buf @param {number} port @param {string} host */
  trySend (buf, port, host) { this.udx.send(this.port, buf, port, host) }

  /** @param {Uint8Array} buf @param {number} port @param {string} host */
  async send (buf, port, host) { this.udx.send(this.port, buf, port, host); return true }

  async close () {
    this.udx.sockets.delete(this.port)
    this.bound = false
    this.emit('close')
  }
}

class I2PUDX {
  /** @param {DatagramSession} session */
  constructor (session) {
    this.session = session
    this.address = session.identity.address
    /** @type {Map<number, Socket>} */
    this.sockets = new Map()
    session.socket.ondatagram = (data, from) => this.#receive(data, from)
  }

  createSocket () { return new Socket(this) }
  networkInterfaces () { return [] }
  watchNetworkInterfaces () { return Object.assign(new EventEmitter(), { interfaces: [], destroy () {} }) }
  /** @param {string} host */
  async lookup (host) { return { host, family: 4 } }

  /** @param {number} fromPort @param {Uint8Array} buf @param {number} port @param {string} host */
  send (fromPort, buf, port, host) {
    const head = b4a.alloc(4)
    head[0] = fromPort >> 8; head[1] = fromPort & 255; head[2] = port >> 8; head[3] = port & 255
    this.session.send(host, b4a.concat([head, buf]))
  }

  /** @param {Uint8Array} data @param {Uint8Array} from */
  #receive (data, from) {
    if (data.length < 4) return
    const sock = this.sockets.get((data[2] << 8) | data[3])
    if (sock) sock.emit('message', data.subarray(4), { host: addressOf(from), family: 4, port: (data[0] << 8) | data[1] })
  }
}

module.exports = { I2PUDX }
