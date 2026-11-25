// Changed from dht-rpc 6.28.0: an address is an I2P destination's hash (as its 52-character base32 `host`) and a
// port, not IPv4. The names (`ipv4`, `ipv4Array`) stay so io.js and query.js are dht-rpc's own, unchanged.
const sodium = require('sodium-universal')
const c = require('compact-encoding')
const b4a = require('b4a')
const { toBase32, fromBase32 } = require('../../address.js')

/** @type {import('compact-encoding').Encoder<{ host: string, port: number }, { id: null, host: string, port: number }>} */
const ipv4 = {
  preencode (state) { state.end += 34 },
  encode (state, m) {
    c.fixed32.encode(state, fromBase32(m.host))
    c.uint16.encode(state, m.port)
  },
  decode (state) {
    const host = toBase32(c.fixed32.decode(state))
    return { id: null, host, port: c.uint16.decode(state) } // id: populated by the callee
  }
}

module.exports = { id, ipv4, ipv4Array: c.array(ipv4), SIZE: 34 }

/** @param {string} host @param {number} port @param {Uint8Array} [out] */
function id (host, port, out = b4a.allocUnsafeSlow(32)) {
  const addr = b4a.allocUnsafe(34)
  ipv4.encode({ start: 0, end: 34, buffer: addr }, { host, port })
  sodium.crypto_generichash(out, addr)
  return out
}
