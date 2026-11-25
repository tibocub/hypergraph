// A minimal SAM v3 client (i2pd and emissary both speak it on 127.0.0.1).
// Streams: one control socket per session, one more socket per connection.
// Datagrams: the router forwards them to a local UDP port we bind; we send
// them to the router's UDP port. Only localhost is ever dialed here.
//
// shortcut: no SAM auth, no PRIMARY sessions, one line parser; enough to measure.

const net = require('net')
const dgram = require('dgram')
const crypto = require('crypto')

const I2P_B64 = (s) => s.replace(/-/g, '+').replace(/~/g, '/')
const destToBuffer = (b64) => Buffer.from(I2P_B64(b64), 'base64')
// A destination's hash is sha256 of its binary form: the .b32.i2p name.
const destHash = (b64) => crypto.createHash('sha256').update(destToBuffer(b64)).digest()

// A private destination starts with the public one: 384 bytes of keys, then a
// certificate (type, 2-byte length, payload).
function publicDest (privB64) {
  const priv = destToBuffer(privB64)
  const len = 387 + priv.readUInt16BE(385)
  return priv.subarray(0, len).toString('base64').replace(/\+/g, '-').replace(/\//g, '~')
}

function base32 (buf) {
  const abc = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let val = 0
  let out = ''
  for (const b of buf) {
    val = (val << 8) | b
    bits += 8
    while (bits >= 5) { out += abc[(val >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += abc[(val << (5 - bits)) & 31]
  return out
}
const b32 = (hash) => base32(hash) + '.b32.i2p'

function parseLine (line) {
  const out = {}
  const parts = line.trim().split(' ')
  out._ = parts.slice(0, 2).join(' ')
  for (const p of parts.slice(2)) {
    const i = p.indexOf('=')
    if (i > 0) out[p.slice(0, i)] = p.slice(i + 1).replace(/^"|"$/g, '')
  }
  return out
}

// Opens a socket to SAM, says HELLO; returns { socket, line(), send() }.
async function control ({ host = '127.0.0.1', port = 7656 } = {}) {
  const socket = net.connect(port, host)
  socket.setNoDelay(true)
  let buf = ''
  const waiting = []
  const lines = []
  const ondata = (d) => {
    buf += d.toString('latin1')
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const l = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (waiting.length) waiting.shift().resolve(l)
      else lines.push(l)
    }
  }
  socket.on('data', ondata)
  const fail = (err) => { while (waiting.length) waiting.shift().reject(err) }
  socket.on('error', fail)
  socket.on('close', () => fail(new Error('SAM socket closed')))
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const line = () => lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve, reject) => waiting.push({ resolve, reject }))
  const ask = async (cmd) => { socket.write(cmd + '\n'); return parseLine(await line()) }
  const hello = await ask('HELLO VERSION MIN=3.1 MAX=3.3')
  if (hello.RESULT !== 'OK') throw new Error('SAM HELLO failed: ' + JSON.stringify(hello))
  // Hands the socket over as a raw pipe: stop parsing, give back unread bytes.
  const detach = () => {
    socket.removeListener('data', ondata)
    const rest = buf
    buf = ''
    if (rest) socket.unshift(Buffer.from(rest, 'latin1'))
    return socket
  }
  return { socket, line, ask, detach, version: hello.VERSION }
}

const SIG = 'SIGNATURE_TYPE=7 i2cp.leaseSetEncType=4' // Ed25519, X25519

// A session: STYLE=STREAM | DATAGRAM | RAW. Resolves once the router has
// built its tunnels (SESSION STATUS OK), which is the slow part.
async function session (style, { sam = {}, id = 'hg' + crypto.randomBytes(4).toString('hex'), udpPort = 0, options = '' } = {}) {
  const c = await control(sam)
  const extra = udpPort ? ` PORT=${udpPort} HOST=127.0.0.1` : ''
  const header = style === 'RAW' ? ' HEADER=true' : ''
  const t = Date.now()
  const st = await c.ask(`SESSION CREATE STYLE=${style} ID=${id} DESTINATION=TRANSIENT ${SIG}${extra}${header} ${options}`.trim())
  if (st.RESULT !== 'OK') throw new Error('SESSION CREATE failed: ' + JSON.stringify(st))
  const readyMs = Date.now() - t
  const dest = publicDest(st.DESTINATION) // emissary closes the socket on NAMING LOOKUP NAME=ME
  return { id, sam, control: c, dest, hash: destHash(dest), readyMs, close: () => c.socket.destroy() }
}

// Dials `to` (a b64 destination or a .b32.i2p name) in a stream session.
async function streamConnect (s, to) {
  const c = await control(s.sam)
  const st = await c.ask(`STREAM CONNECT ID=${s.id} DESTINATION=${to} SILENT=false`)
  if (st.RESULT !== 'OK') { c.socket.destroy(); throw new Error('STREAM CONNECT: ' + st.RESULT) }
  return c.detach()
}

// Calls onsocket(socket, peerDest) for every incoming stream, forever.
function streamAccept (s, onsocket) {
  let stopped = false
  let c = null
  const loop = async () => {
    while (!stopped) {
      try {
        c = await control(s.sam)
        const st = await c.ask(`STREAM ACCEPT ID=${s.id} SILENT=false`)
        if (st.RESULT !== 'OK') throw new Error('STREAM ACCEPT: ' + st.RESULT)
        const first = await c.line() // the peer's destination, sent when it connects
        const sock = c.detach()
        c = null
        onsocket(sock, first.split(' ')[0])
      } catch (err) {
        if (c) c.socket.destroy()
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }
  loop()
  return () => { stopped = true; if (c) c.socket.destroy() } // a pending ACCEPT would take the next stream
}

// A datagram session. onmessage(payload, { dest, fromPort, toPort }).
// RAW gives no sender (dest is null); DATAGRAM gives a signed sender.
async function datagrams (style, { sam = {}, udp = 7655, onmessage }) {
  const sock = dgram.createSocket('udp4')
  await new Promise((resolve) => sock.bind(0, '127.0.0.1', resolve))
  const s = await session(style, { sam, udpPort: sock.address().port })
  sock.on('message', (msg) => {
    // RAW with HEADER=true starts with "FROM_PORT=..."; a router that ignores HEADER sends the bare payload
    if (style === 'RAW' && !msg.subarray(0, 10).toString('latin1').startsWith('FROM_PORT') && !msg.subarray(0, 10).toString('latin1').startsWith('PROTOCOL')) return onmessage(msg, { dest: null, fromPort: 0, toPort: 0 })
    const nl = msg.indexOf(10)
    if (nl === -1) return
    const head = msg.subarray(0, nl).toString('latin1').split(' ')
    const opts = {}
    for (const p of head) { const i = p.indexOf('='); if (i > 0) opts[p.slice(0, i)] = p.slice(i + 1) }
    const dest = style === 'RAW' ? null : head[0]
    onmessage(msg.subarray(nl + 1), { dest, fromPort: Number(opts.FROM_PORT || 0), toPort: Number(opts.TO_PORT || 0) })
  })
  const send = (to, payload, { fromPort = 0, toPort = 0 } = {}) => {
    const head = Buffer.from(`3.3 ${s.id} ${to} FROM_PORT=${fromPort} TO_PORT=${toPort}\n`, 'latin1')
    sock.send(Buffer.concat([head, payload]), sam.udp || udp, sam.host || '127.0.0.1')
  }
  return { ...s, send, close: () => { s.close(); sock.close() } }
}

module.exports = { control, session, streamConnect, streamAccept, datagrams, destHash, b32, base32, parseLine }
