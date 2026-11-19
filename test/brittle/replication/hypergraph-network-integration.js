// NOTE ON NETWORK DEPENDENCY: joins the real public DHT via Hyperswarm.

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { HypergraphNetwork } = require('../../../index.js')
const { createGraph, sleep, destroySwarm, testSwarm } = require('../helpers')

test('hypergraph-network-integration: data written by one peer replicates to the other via HypergraphNetwork, with content verified (needs real network)', { timeout: 240000 }, async (t) => {
  console.log('TEST: HypergraphNetworking integration - starting (requires DHT access)')

  const a = await createGraph(t, 'hn-integration-a')
  const b = await createGraph(t, 'hn-integration-b')

  const topic = a.graph.discoveryKey

  console.log('  Step 1: register peer A\'s user core on peer B\'s graph view before connecting')
  const aUserCoreOnB = await b.graph.openUserCore(a.graph.key)

  console.log('  Step 2: create HypergraphNetwork helpers with real swarms and connect (in parallel)')
  const swarmA = await testSwarm(t)
  const swarmB = await testSwarm(t)

  const networkingA = new HypergraphNetwork(a.graph, a.store, swarmA, { topic, role: 'owner' })
  const networkingB = new HypergraphNetwork(b.graph, b.store, swarmB, { topic, role: 'peer' })
  networkingA.on('flush-timeout', (info) => console.log(`    [A] flush-timeout: ${info.step} exceeded ${info.timeoutMs}ms`))
  networkingB.on('flush-timeout', (info) => console.log(`    [B] flush-timeout: ${info.step} exceeded ${info.timeoutMs}ms`))

  t.teardown(async () => {
    try { await networkingA.destroy() } catch (err) { /* already closed */ }
    try { await networkingB.destroy() } catch (err) { /* already closed */ }
    await a.close()
    await b.close()
    await destroySwarm(swarmA)
    await destroySwarm(swarmB)
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
