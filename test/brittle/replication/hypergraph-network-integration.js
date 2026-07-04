// NOTE ON NETWORK DEPENDENCY: joins the real public DHT via Hyperswarm.
// Cannot be verified without real network access.
//
// BUG FIX (argument shape): the original version of this test (in the old
// ad-hoc replication-scenarios.js script) imported `HypergraphNetworking`,
// which does not exist in index.js (the real export is `HypergraphNetwork`),
// and constructed it as `new HypergraphNetworking(graph, store, { topic })`
// — missing the required `swarm` argument entirely. This means the test
// never actually ran; `HypergraphNetworking` was `undefined` and the
// constructor call would throw immediately. Rewritten here against the real
// `HypergraphNetwork(graph, store, swarm, opts)` API.
//
// BUG FIX (teardown ordering): see late-joiner.js for the full explanation.
// Destroying a swarm before its peer's graph/store are closed hangs
// store.close() forever. Fixed by closing graph/store before the swarms.

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { HypergraphNetwork } = require('../../../index.js')
const { createGraph, sleep } = require('../helpers')

test('hypergraph-network-integration: data written by one peer replicates to the other via HypergraphNetwork (needs real network)', async (t) => {
  console.log('TEST: HypergraphNetworking integration - starting (requires DHT access)')

  const a = await createGraph(t, 'hn-integration-a')
  const b = await createGraph(t, 'hn-integration-b')

  const topic = a.graph.discoveryKey

  console.log('  Step 1: preload each peer\'s view of the other\'s user core before connecting')
  const remoteAOnB = b.store.get({ key: a.graph.key })
  const remoteBOnA = a.store.get({ key: b.graph.key })
  await Promise.all([remoteAOnB.ready(), remoteBOnA.ready()])

  console.log('  Step 2: create HypergraphNetwork helpers with real swarms and connect')
  const swarmA = new Hyperswarm()
  const swarmB = new Hyperswarm()

  const networkingA = new HypergraphNetwork(a.graph, a.store, swarmA, { topic, role: 'owner' })
  const networkingB = new HypergraphNetwork(b.graph, b.store, swarmB, { topic, role: 'peer' })

  t.teardown(async () => {
    try { await networkingA.destroy() } catch (err) { /* already closed */ }
    try { await networkingB.destroy() } catch (err) { /* already closed */ }
    await a.close()
    await b.close()
    try { await swarmA.destroy() } catch (err) { /* already closed */ }
    try { await swarmB.destroy() } catch (err) { /* already closed */ }
  })

  await networkingA.connect()
  await networkingB.connect()
  await sleep(3000)

  console.log('  Step 3: peer A writes data')
  const msg = await a.graph.put({ type: 'message' })
  await a.graph.putContent(msg.id, 'Message via HypergraphNetwork', 'text')

  console.log('  Step 4: wait for replication and verify peer B caught up')
  await sleep(5000)
  await remoteAOnB.update()

  const coreLength = remoteAOnB.length
  t.ok(coreLength > 0, `peer B received data written by peer A via HypergraphNetwork (core length: ${coreLength})`)
  console.log('TEST: HypergraphNetworking integration - passed')
})
