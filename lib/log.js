// A device's log in a space (research R5): a Hypercore per device per space.
// Block 0 is the header: the space, its decision log, and a proof, signed by
// the device on its identity's behalf, that this log speaks for that identity
// in that space. Every later block is a record. An identity log's header is
// signed by the identity key itself (research.md A7): it holds device
// removals, and no removal can touch it.

const c = require('compact-encoding')
const b4a = require('b4a')
const enc = require('./encodings.js')
const { Identity } = require('./identity.js')

const NS_LOG = b4a.from('hypergraph/log\0')
const logSignable = (logKey, space) => b4a.concat([NS_LOG, logKey, space])

class OwnLog {
  // attest(data): the header's proof; by default this device's, on its
  // identity's behalf. decisions: the key of the decision log holding the
  // space's decisions (its own; a sub-space's top space, story 8).
  // admitted(): the code this log's author was let back in with (story 9),
  // or null; written in the header when the log is made.
  constructor (core, { space, identity, decisions = space, attest = (data) => identity.attest(data), admitted = () => null }) {
    this.core = core
    this.space = space
    this.decisions = decisions
    this.identity = identity
    this.attest = attest
    this.admittedOf = admitted
    this.admitted = null // hex, from the header
  }

  get key () { return this.core.key }
  get length () { return this.core.length }

  async ready () {
    await this.core.ready()
    if (this.core.length === 0) {
      const proof = this.attest(logSignable(this.core.key, this.space))
      const code = this.admittedOf()
      await this.core.append(c.encode(enc.header, { version: enc.VERSION, space: this.space, decisions: this.decisions, proof, admitted: code ? b4a.from(code, 'hex') : null }))
    }
    this.admitted = admittedOf(await this.core.get(0))
  }

  // Appends a record ({ kind, type, stamp, target, links, fields }); its seq.
  // `seal(seq, record)`: the record as written (a private space's, sealed
  // with its position: story 8). One append at a time, so the position is
  // known before writing.
  append (record, seal = null) {
    const run = (this._appending || Promise.resolve()).then(async () => {
      const r = seal ? seal(this.core.length, record) : record
      const { length } = await this.core.append(enc.encodeRecord(r))
      return length - 1
    })
    this._appending = run.catch(() => {})
    return run
  }

  async get (seq) {
    return enc.decodeRecord(await this.core.get(seq))
  }
}

// Who a log's header says wrote it: { identity, device }, or null if the
// header is malformed, for another space or decision log, or its proof
// doesn't verify.
function readHeader (bytes, logKey, space, decisions = space) {
  let h = null
  try { h = c.decode(enc.header, bytes) } catch { return null }
  if (h.version !== enc.VERSION || !b4a.equals(h.space, space) || !b4a.equals(h.decisions, decisions)) return null
  const who = Identity.verify(h.proof, logSignable(logKey, space))
  return who && { ...who, admitted: h.admitted ? b4a.toString(h.admitted, 'hex') : null }
}

// The admission code a log's header carries (hex), or null.
function admittedOf (bytes) {
  try {
    const h = c.decode(enc.header, bytes)
    return h.admitted ? b4a.toString(h.admitted, 'hex') : null
  } catch {
    return null
  }
}

module.exports = { OwnLog, readHeader, admittedOf }
