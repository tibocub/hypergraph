// What a private space's key change costs (lib/space.js #rotate → #grant): one
// `hg/grant` record per entitled device, sealed to its box key
// (lib/private/grants.js makeGrant), appended one by one to the rotater's log;
// every member holds and indexes every grant (a log's records). Here: the
// sealing time and the grant's size; the rest is estimated from measured
// per-record costs (design-brief.md: ~1,010 B on disk per record, log +
// index; 5,644 records/s indexed).
//   node bench/scale-audit/grants.js 10000
const hc = require('hypercore-crypto')
const grants = require('../../lib/private/grants.js')
const pc = require('../../lib/private/crypto.js')

const n = Number(process.argv[2]) || 10000
const devices = []
for (let i = 0; i < n; i++) devices.push(hc.keyPair().publicKey)
const key = pc.newEpochKey()
const commit = pc.commitOf(key)
const t = Date.now()
let bytes = 0
for (const d of devices) {
  const g = grants.makeGrant(key, 7, commit, d)
  bytes += Buffer.byteLength(g.to) + g.sealed.byteLength + g.commit.byteLength + 1 // epoch varint
}
const ms = Date.now() - t
console.log(`${n} grants: sealing ${ms} ms (${(ms / n * 1000).toFixed(0)} µs each); fields ~${(bytes / n).toFixed(0)} B per grant`)
