// A stand-in for udx-native that dht-rpc accepts as `opts.udx`, carrying its
// UDP packets as SAM datagrams. dht-rpc is not forked.
//
// dht-rpc speaks IPv4 host:port (6 bytes) and checks a node's id against
// hash(host, port), so each I2P destination gets a fixed fake address:
// host = the first 4 bytes of its hash, port = the I2P datagram port. Every
// node computes the same fake address for the same destination.
//
// The catch: replies list "closer nodes" as fake addresses, which can't be
// turned back into destinations. So each datagram carries a prefix with the
// 32-byte hash of every closer node it lists (and, for RAW, the sender's
// own hash, since RAW datagrams don't say who sent them).
//
// shortcut: 32-bit host collisions are ignored (fine for a few test nodes, not for a real network).

const { EventEmitter } = require('events')
const c = require('compact-encoding')
const sam = require('./sam.js')

const RESPONSE = 0x13 // dht-rpc's RESPONSE_ID

const hostOf = (hash) => `${hash[0]}.${hash[1]}.${hash[2]}.${hash[3]}`

// Reads the closer nodes of a dht-rpc response, or [] (see dht-rpc lib/io.js).
function closerNodes (msg) {
  if (msg[0] !== RESPONSE) return []
  try {
    const state = { start: 1, end: msg.length, buffer: msg }
    const flags = c.uint.decode(state)
    state.start += 2 + 6 // tid, to
    if (flags & 1) state.start += 32
    if (flags & 2) state.start += 32
    if (!(flags & 4)) return []
    const n = c.uint.decode(state)
    const out = []
    for (let i = 0; i < n; i++) {
      const b = msg.subarray(state.start, state.start + 6)
      out.push(`${b[0]}.${b[1]}.${b[2]}.${b[3]}`)
      state.start += 6
    }
    return out
  } catch { return [] }
}

class FakeSocket extends EventEmitter {
  constructor (udx) { super(); this.udx = udx; this.bound = false; this._port = 0 }
  bind (port) {
    if (port === 0) do port = 1 + Math.floor(Math.random() * 65534); while (this.udx.sockets.has(port))
    if (this.udx.sockets.has(port)) throw new Error('port in use')
    this._port = port
    this.bound = true
    this.udx.sockets.set(port, this)
  }

  address () { return { host: this.udx.host, family: 4, port: this._port } }
  trySend (buf, port, host) { this.udx._send(this._port, buf, port, host) }
  async send (buf, port, host) { this.udx._send(this._port, buf, port, host); return true }
  async close () { this.udx.sockets.delete(this._port); this.bound = false; this.emit('close') }
}

class I2PUDX {
  // style: 'DATAGRAM' (signed sender) or 'RAW' (sender written in the prefix, unchecked)
  // datagrams: sam.datagrams, or a fake with the same shape (test.js)
  static async open ({ style = 'DATAGRAM', sam: samOpts = {}, datagrams = sam.datagrams } = {}) {
    const u = new I2PUDX(style)
    u.session = await datagrams(style, { sam: samOpts, onmessage: (m, info) => u._onmessage(m, info) })
    u.hash = u.session.hash
    u.host = hostOf(u.hash)
    u.known.set(u.host, u.hash)
    return u
  }

  constructor (style) {
    this.style = style
    this.sockets = new Map()
    this.known = new Map() // fake host -> destination hash
    this.stats = { tx: 0, rx: 0, txBytes: 0, rxBytes: 0, unknownHost: 0 }
  }

  learn (hash) { this.known.set(hostOf(hash), hash) }
  createSocket () { return new FakeSocket(this) }
  watchNetworkInterfaces () { const e = new EventEmitter(); e.destroy = () => {}; e.interfaces = []; return e }
  networkInterfaces () { return [] }
  async lookup (host) { return { host, family: 4 } }

  _send (fromPort, buf, port, host) {
    const hash = this.known.get(host)
    if (!hash) { this.stats.unknownHost++; return }
    const hashes = closerNodes(buf).map((h) => this.known.get(h)).filter(Boolean)
    const parts = []
    if (this.style === 'RAW') parts.push(this.hash)
    parts.push(Buffer.from([hashes.length]), ...hashes, buf)
    const payload = Buffer.concat(parts)
    this.stats.tx++
    this.stats.txBytes += payload.length
    this.session.send(sam.b32(hash), payload, { fromPort, toPort: port })
  }

  _onmessage (msg, { dest, fromPort, toPort }) {
    let off = 0
    let from
    if (this.style === 'RAW') { from = msg.subarray(0, 32); off = 32 } else from = sam.destHash(dest)
    const n = msg[off++]
    for (let i = 0; i < n; i++, off += 32) this.learn(Buffer.from(msg.subarray(off, off + 32)))
    this.learn(Buffer.from(from))
    const sock = this.sockets.get(toPort)
    this.stats.rx++
    this.stats.rxBytes += msg.length
    if (sock) sock.emit('message', msg.subarray(off), { host: hostOf(from), port: fromPort, family: 4 })
  }

  close () { this.session.close() }
}

module.exports = { I2PUDX, hostOf, closerNodes }
