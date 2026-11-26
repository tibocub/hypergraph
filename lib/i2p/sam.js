// A SAM v3 client: the I2P router's local API, on 127.0.0.1 only. One session per open: one destination, its
// datagrams both ways on the session's TCP socket (no UDP, as i2pd does when a session has no PORT), and its streams,
// each on a TCP socket of its own. i2pd serves streams on a DATAGRAM session too, so one session is enough.
const net = require('net')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const { fromI2PBase64, publicOf, addressOf, signingKeyPair, SIG_TYPE } = require('./address.js')

const HOPS = 'inbound.length=3 outbound.length=3'
const HELLO_MS = 10000

/**
 * @typedef {{ host?: string, port: number }} SamOptions where the router's SAM listens; host is always loopback
 * @typedef {Record<string, string>} Reply a reply line's KEY=VALUE pairs, plus `_` for its first two words
 * @typedef {{ dest: Uint8Array, address: string, keyPair: { publicKey: Uint8Array, secretKey: Uint8Array } }} Identity
 *   a session's destination: binary public destination, its address (base32 of its hash), its Ed25519 key pair
 * @typedef {import('net').Socket} RawStream a stream to another destination, after SAM's handshake: plain bytes
 */

/** @param {string} line @returns {Reply} */
function parse (line) {
  const words = line.trim().match(/[^\s"]+="[^"]*"|\S+/g) || []
  /** @type {Reply} */
  const out = { _: words.slice(0, 2).join(' ') }
  for (const w of words.slice(2)) {
    const i = w.indexOf('=')
    if (i > 0) out[w.slice(0, i)] = w.slice(i + 1).replace(/^"|"$/g, '')
  }
  return out
}

class SamSocket {
  /** @param {net.Socket} socket */
  constructor (socket) {
    this.socket = socket
    /** @type {Uint8Array} */
    this.buf = b4a.alloc(0)
    /** @type {((line: string) => void)[]} */
    this.waiting = []
    /** @type {(data: Uint8Array, from: Uint8Array, fromPort: number, toPort: number) => void} */
    this.ondatagram = () => {}
    this.closed = false
    this.detached = false
    this.datagrams = false // the session's own socket: datagrams arrive on it
    this.ondata = (/** @type {Uint8Array} */ d) => { this.buf = b4a.concat([this.buf, d]); this.#drain() }
    socket.on('data', this.ondata)
    socket.on('error', () => {})
    socket.on('close', () => {
      this.closed = true
      for (const w of this.waiting.splice(0)) w('CLOSED')
    })
  }

  #drain () {
    while (!this.detached) {
      const nl = this.buf.indexOf(10)
      if (nl === -1) return
      const line = b4a.toString(this.buf.subarray(0, nl))
      if (this.datagrams && line.startsWith('DATAGRAM RECEIVED')) {
        const r = parse(line)
        const size = Number(r.SIZE)
        if (this.buf.length < nl + 1 + size) return // the rest is still coming
        const data = this.buf.subarray(nl + 1, nl + 1 + size)
        this.buf = this.buf.subarray(nl + 1 + size)
        try { this.ondatagram(data, fromI2PBase64(r.DESTINATION), Number(r.FROM_PORT) || 0, Number(r.TO_PORT) || 0) } catch {}
        continue
      }
      const w = this.waiting.shift()
      if (!w) return // kept for next(), or a stream's first bytes, kept for detach()
      this.buf = this.buf.subarray(nl + 1)
      w(line)
    }
  }

  /** The next line, raw. @returns {Promise<string>} */
  next () {
    if (this.closed) return Promise.resolve('CLOSED')
    return new Promise((resolve) => { this.waiting.push(resolve); this.#drain() })
  }

  /** @param {string} line @param {number} [ms] 0: no timeout @returns {Promise<Reply>} */
  async ask (line, ms = 0) {
    const reply = this.next()
    this.socket.write(line + '\n')
    if (!ms) return parse(await reply)
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null
    const late = new Promise((resolve, reject) => { timer = setTimeout(() => { this.destroy(); reject(new Error('SAM did not answer: ' + line.split(' ', 2).join(' '))) }, ms) })
    try { return parse(/** @type {string} */ (await Promise.race([reply, late]))) } finally { if (timer) clearTimeout(timer) }
  }

  /** Hands the socket over as a plain stream, with any bytes already read put back. @returns {RawStream} */
  detach () {
    this.detached = true
    // Paused until the new reader is attached (after this tick's promises): a flowing socket with no reader
    // would drop the bytes put back.
    this.socket.pause()
    this.socket.off('data', this.ondata)
    if (this.buf.length) this.socket.unshift(this.buf)
    this.buf = b4a.alloc(0)
    const socket = this.socket
    setImmediate(() => socket.resume())
    return socket
  }

  destroy () { this.socket.destroy() }
}

/** @param {SamOptions} sam @returns {Promise<SamSocket>} */
function connect ({ host = '127.0.0.1', port }) {
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('SAM is reached on 127.0.0.1 only')
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host)
    socket.once('error', reject)
    socket.once('connect', async () => {
      socket.off('error', reject)
      const s = new SamSocket(socket)
      try {
        const r = await s.ask('HELLO VERSION MIN=3.1 MAX=3.3', HELLO_MS)
        if (r.RESULT !== 'OK') throw new Error('SAM HELLO: ' + (r.RESULT || r._))
        resolve(s)
      } catch (err) { s.destroy(); reject(err) }
    })
  })
}

/**
 * A session: a fresh destination with 3-hop tunnels, its private key never saved. Resolves once its tunnels are
 * built (the router answers SESSION CREATE then), which takes seconds to minutes.
 * @param {{ sam: SamOptions, options?: string, ondatagram?: (data: Uint8Array, from: Uint8Array, fromPort: number, toPort: number) => void }} opts
 *   options: more SAM session options; ondatagram gets the sender's binary destination, checked by the router
 */
async function session ({ sam, options = '', ondatagram }) {
  const s = await connect(sam)
  const id = 'hg' + b4a.toString(random(6), 'hex')
  const r = await s.ask(`SESSION CREATE STYLE=DATAGRAM ID=${id} DESTINATION=TRANSIENT SIGNATURE_TYPE=${SIG_TYPE} ${HOPS} ${options}`.trim())
  if (r.RESULT !== 'OK') { s.destroy(); throw new Error('SAM SESSION CREATE: ' + (r.RESULT || r._) + (r.MESSAGE ? ' ' + r.MESSAGE : '')) }
  s.datagrams = true
  if (ondatagram) s.ondatagram = ondatagram
  const priv = fromI2PBase64(r.DESTINATION)
  const dest = publicOf(priv)
  /** @type {Set<SamSocket>} */
  const pending = new Set() // streams being dialed or waiting to accept, destroyed with the session
  let accepting = false
  return {
    id,
    sam,
    socket: s,
    /** @type {Identity} */
    identity: { dest, address: addressOf(dest), keyPair: signingKeyPair(priv) },
    get closed () { return s.closed },
    /** @param {string} address the receiver's base32 address @param {Uint8Array} data */
    send (address, data) {
      if (s.closed) return
      // One write, under 8 KB in all: i2pd drops a DATAGRAM SEND whose data isn't in the same read as its line.
      s.socket.write(b4a.concat([b4a.from(`DATAGRAM SEND ID=${id} DESTINATION=${address}.b32.i2p SIZE=${data.length}\n`), data]))
    },
    /**
     * A stream to `address` (the router finds its destination). Rejects if it can't be reached.
     * @param {string} address @param {number} [ms]
     * @returns {Promise<RawStream>}
     */
    async connect (address, ms = 120000) {
      const c = await connect(sam)
      pending.add(c)
      try {
        const r = await c.ask(`STREAM CONNECT ID=${id} DESTINATION=${address}.b32.i2p SILENT=false`, ms)
        if (r.RESULT !== 'OK') throw new Error('I2P stream to ' + address.slice(0, 8) + '…: ' + (r.RESULT || r._))
        return c.detach()
      } catch (err) { c.destroy(); throw err } finally { pending.delete(c) }
    },
    /**
     * Accepts every incoming stream until the session closes.
     * @param {(stream: RawStream, from: string) => void} onstream from: the dialer's address
     */
    accept (onstream) {
      if (accepting) return
      accepting = true
      const loop = async () => {
        while (!s.closed) {
          let c
          try { c = await connect(sam) } catch { await sleep(1000); continue }
          pending.add(c)
          const r = await c.ask(`STREAM ACCEPT ID=${id} SILENT=false`)
          if (r.RESULT !== 'OK') { pending.delete(c); c.destroy(); await sleep(1000); continue }
          const line = await c.next() // the dialer's destination, then its bytes
          pending.delete(c)
          if (line === 'CLOSED') continue
          try { onstream(c.detach(), addressOf(fromI2PBase64(line.split(' ')[0]))) } catch { c.destroy() }
        }
      }
      loop().catch(() => {})
    },
    close () {
      for (const c of pending) c.destroy()
      s.destroy()
    }
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** @param {number} n */
function random (n) {
  const b = b4a.alloc(n)
  sodium.randombytes_buf(b)
  return b
}

module.exports = { connect, session, parse, HOPS }
