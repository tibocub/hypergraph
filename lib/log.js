// A device's log in a space (research R5): a Hypercore per device per space.
// Block 0 is the header: the space, its decision log, and a proof, signed by
// the device on its identity's behalf, that this log speaks for that identity
// in that space. Every later block is a record.

const c = require('compact-encoding')
const b4a = require('b4a')
const enc = require('./encodings.js')
const { Identity } = require('./identity.js')

const NS_LOG = b4a.from('hypergraph/log\0')
const logSignable = (logKey, space) => b4a.concat([NS_LOG, logKey, space])

class OwnLog {
  constructor (core, { space, identity }) {
    this.core = core
    this.space = space
    this.identity = identity
  }

  get key () { return this.core.key }
  get length () { return this.core.length }

  async ready () {
    await this.core.ready()
    if (this.core.length === 0) {
      const proof = this.identity.attest(logSignable(this.core.key, this.space))
      await this.core.append(c.encode(enc.header, { version: enc.VERSION, space: this.space, decisions: this.space, proof }))
    }
  }

  // Appends a record ({ kind, type, stamp, target, links, fields }); its seq.
  async append (record) {
    const { length } = await this.core.append(enc.encodeRecord(record))
    return length - 1
  }

  async get (seq) {
    return enc.decodeRecord(await this.core.get(seq))
  }
}

// Who a log's header says wrote it: { identity, device }, or null if the
// header is malformed, for another space, or its proof doesn't verify.
function readHeader (bytes, logKey, space) {
  let h = null
  try { h = c.decode(enc.header, bytes) } catch { return null }
  if (h.version !== enc.VERSION || !b4a.equals(h.space, space)) return null
  return Identity.verify(h.proof, logSignable(logKey, space))
}

module.exports = { OwnLog, readHeader }
