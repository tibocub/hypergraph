// A helper for the tests of spec 013: a real blind-peer server on the test's
// local DHT, as `blind-peer-cli` runs it, closed after the test.

const path = require('path')
const z32 = require('z32')
const b4a = require('b4a')
const { tmpDir, testBootstrap, bounded } = require('../helpers.js')

// `key`: what an owner lists (z32).
async function helper (t) {
  const BlindPeer = require('blind-peer')
  const server = new BlindPeer(path.join(tmpDir(t, 'helper'), 'store'), { bootstrap: await testBootstrap(t) })
  await server.ready()
  await server.listen()
  t.teardown(() => bounded(server.close(), 10000, 'helper.close()'), { order: 0 })
  server.key = z32.encode(server.publicKey)
  return server
}

// Does the helper hold every block of `core` (as long as it is here)?
async function holds (server, core) {
  if (!core.length) return false
  const copy = server.store.get({ key: core.key })
  await copy.ready()
  const ok = copy.length >= core.length && await copy.has(0, core.length)
  await copy.close()
  return ok
}

// Does it hold this member's part of the space: its log and, if it records
// decisions, its decisions, with its log listed (spec 013)?
async function heldBy (server, space) {
  if (!(await holds(server, space.own.core))) return false
  if (!space.decisionLog.writable) return true
  return space.state.listed.has(b4a.toString(space.own.key, 'hex')) && await holds(server, space.decisionLog.base.local)
}

module.exports = { helper, holds, heldBy }
