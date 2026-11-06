// Spec 017's assumption (b), with a real blind peer on the local DHT: a log
// handed to a helper (blind-peering addCore) and closed right after is still
// mirrored, and handed again when it grows. `await addCore()` resolves once
// the helper's connection is up, and then the request was written to it.

const test = require('brittle')
const b4a = require('b4a')
const DHT = require('hyperdht')
const Corestore = require('corestore')
const BlindPeering = require('blind-peering')
const { helper } = require('./_helper.js')
const { sent } = require('../../../lib/helpers.js')
const { tmpDir, testBootstrap, eventually } = require('../helpers.js')

async function holdsUpTo (server, key, length) {
  const copy = server.store.get({ key })
  await copy.ready()
  const ok = copy.length >= length && await copy.has(0, length)
  await copy.close()
  return ok
}

test('a log handed to a helper and closed at once is mirrored; grown, handed again', { timeout: 120000 }, async (t) => {
  const server = await helper(t)
  const dht = new DHT({ bootstrap: await testBootstrap(t) })
  const store = new Corestore(tmpDir(t, 'member'))
  t.teardown(async () => { await peering.close(); await store.close(); await dht.destroy() }, { order: 0 })
  const peering = new BlindPeering(dht, store, { keys: [server.publicKey] })
  // what keeps the helper's connection referenced in a space: its decision log
  const anchor = store.get({ name: 'anchor' })
  await anchor.append('x')
  peering.addCoreBackground(anchor)

  const log = store.get({ name: 'log' })
  await log.append(Array.from({ length: 50 }, (_, i) => 'block ' + i))
  const key = log.key
  const id = b4a.toString(log.discoveryKey, 'hex')
  await peering.addCore(log)
  t.ok(sent(peering, log), 'the request was written before the close')
  await log.close()
  t.ok(await eventually(() => holdsUpTo(server, key, 50), 30000, 250), 'the helper mirrors all 50 blocks')
  t.ok(await eventually(() => !store.cores.opened(id), 70000, 500), 'freed here while connected to the helper')

  const again = store.get({ key })
  await again.append(Array.from({ length: 10 }, (_, i) => 'more ' + i))
  await peering.addCore(again)
  t.ok(sent(peering, again), 'the new length was written')
  await again.close()
  t.ok(await eventually(() => holdsUpTo(server, key, 60), 30000, 250), 'the helper gets the new blocks')
})
