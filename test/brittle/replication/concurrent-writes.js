// NOTE ON NETWORK DEPENDENCY: joins the real public DHT via Hyperswarm.

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { createGraph, sleep, destroySwarm, testSwarm } = require('../helpers')

test('concurrent-writes: two peers each write, both replicate, and content matches exactly (needs real network)', async (t) => {
  console.log('TEST: sequential writes, both peers write - starting (requires DHT access)')

  const a = await createGraph(t, 'concurrent-writes-a')
  const b = await createGraph(t, 'concurrent-writes-b')

  console.log('  Step 1: preload both remote user cores before replicating (via openUserCore, not raw store.get)')
  const bUserCoreOnA = await a.graph.openUserCore(b.graph.key)
  const aUserCoreOnB = await b.graph.openUserCore(a.graph.key)

  const topic = a.graph.discoveryKey
  const swarmA = await testSwarm(t)
  swarmA.on('connection', (conn) => a.store.replicate(conn))

  const discA = swarmA.join(topic, { server: true, client: true })
  await discA.flushed()

  console.log('  Step 2: peer A writes first, then peer B joins')
  const msg1 = await a.graph.put({ type: 'message' })
  await a.graph.putContent(msg1.id, 'Message from Peer A', 'text')

  const swarmB = await testSwarm(t)
  swarmB.on('connection', (conn) => b.store.replicate(conn))

  const discB = swarmB.join(topic, { server: true, client: true })
  await discB.flushed()

  t.teardown(async () => {
    await a.close()
    await b.close()
    await destroySwarm(swarmA)
    await destroySwarm(swarmB)
  })

  console.log('  Step 3: wait for peer B to connect and replicate peer A data')
  await sleep(10000)

  console.log('  Step 4: peer B writes its own message once both have some data')
  const msg2 = await b.graph.put({ type: 'message' })
  await b.graph.putContent(msg2.id, 'Message from Peer B', 'text')

  console.log('  Step 5: wait for both writes to replicate, then verify exact content matches on both sides')
  let msg2OnA = null
  let msg1OnB = null
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    await bUserCoreOnA.update()
    await aUserCoreOnB.update()
    await a.graph.update()
    await b.graph.update()
    msg2OnA = await a.graph.get(msg2.id)
    msg1OnB = await b.graph.get(msg1.id)
    if (msg2OnA && msg1OnB) break
  }

  t.ok(msg2OnA, `peer A received peer B's message entity`)
  t.ok(msg1OnB, `peer B received peer A's message entity`)

  const msg2ContentOnA = msg2OnA ? await a.graph.getContent(msg2.id) : null
  const msg1ContentOnB = msg1OnB ? await b.graph.getContent(msg1.id) : null
  t.is(msg2ContentOnA && msg2ContentOnA.body, 'Message from Peer B', "peer A's copy of peer B's message matches exactly")
  t.is(msg1ContentOnB && msg1ContentOnB.body, 'Message from Peer A', "peer B's copy of peer A's message matches exactly")
  console.log('TEST: sequential writes, both peers write - passed')
})
