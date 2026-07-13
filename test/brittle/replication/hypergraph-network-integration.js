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
//
// BUG FIX (sequential connect): `networkingA.connect()` and
// `networkingB.connect()` were awaited one after another. A single
// connect() can internally take up to ~20s (two sequential 10s flush
// timeouts inside HypergraphNetwork), so awaiting two sequentially could
// approach 40s before either side finishes. Fixed to Promise.all(), the
// same fix already applied to hypergraph-network.js and connect-to-swarm.js
// in an earlier round — this file was missed at the time.
//
// BUG FIX (content verification): watched the remote user core via a raw
// `store.get()`, which only creates a Hypercore reference for replication —
// it never registers the core with the graph's view, so graph.get()/
// getContent() could never see peer A's data. Switched to openUserCore()
// so the exact content can be verified, not just raw core length (which
// only proves *some* bytes arrived, not the *right* ones).

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { HypergraphNetwork } = require('../../../index.js')
const { createGraph, sleep } = require('../helpers')

test('hypergraph-network-integration: data written by one peer replicates to the other via HypergraphNetwork, with content verified (needs real network)', { timeout: 240000 }, async (t) => {
  console.log('TEST: HypergraphNetworking integration - starting (requires DHT access)')

  const a = await createGraph(t, 'hn-integration-a')
  const b = await createGraph(t, 'hn-integration-b')

  const topic = a.graph.discoveryKey

  console.log('  Step 1: register peer A\'s user core on peer B\'s graph view before connecting')
  const aUserCoreOnB = await b.graph.openUserCore(a.graph.key)

  console.log('  Step 2: create HypergraphNetwork helpers with real swarms and connect (in parallel)')
  const swarmA = new Hyperswarm()
  const swarmB = new Hyperswarm()

  const networkingA = new HypergraphNetwork(a.graph, a.store, swarmA, { topic, role: 'owner' })
  const networkingB = new HypergraphNetwork(b.graph, b.store, swarmB, { topic, role: 'peer' })
  networkingA.on('flush-timeout', (info) => console.log(`    [A] flush-timeout: ${info.step} exceeded ${info.timeoutMs}ms`))
  networkingB.on('flush-timeout', (info) => console.log(`    [B] flush-timeout: ${info.step} exceeded ${info.timeoutMs}ms`))

  t.teardown(async () => {
    try { await networkingA.destroy() } catch (err) { /* already closed */ }
    try { await networkingB.destroy() } catch (err) { /* already closed */ }
    await a.close()
    await b.close()
    try { await swarmA.destroy() } catch (err) { /* already closed */ }
    try { await swarmB.destroy() } catch (err) { /* already closed */ }
  })

  await Promise.all([networkingA.connect(), networkingB.connect()])

  console.log('  Step 3: peer A writes data')
  const msg = await a.graph.put({ type: 'message' })
  await a.graph.putContent(msg.id, 'Message via HypergraphNetwork', 'text')

  console.log('  Step 4: wait for replication and verify the exact content matches on peer B')
  let msgOnB = null
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    await aUserCoreOnB.update()
    await b.graph.update()
    msgOnB = await b.graph.get(msg.id)
    if (msgOnB) break
  }

  t.ok(msgOnB, 'peer B received the entity written by peer A via HypergraphNetwork')
  const contentOnB = msgOnB ? await b.graph.getContent(msg.id) : null
  t.is(contentOnB && contentOnB.body, 'Message via HypergraphNetwork', "peer B's copy of the content matches exactly what peer A wrote")
  console.log('TEST: HypergraphNetworking integration - passed')
})
