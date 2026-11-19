// NOTE ON NETWORK DEPENDENCY: joins the real public DHT via Hyperswarm.

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { createGraph, sleep, destroySwarm, testSwarm } = require('../helpers')

test('peer-reconnection: a disconnected peer catches up on data created while it was offline, with content verified (needs real network)', async (t) => {
  console.log('TEST: peer reconnection - starting (requires DHT access)')

  const a = await createGraph(t, 'peer-reconnection-a')
  const b = await createGraph(t, 'peer-reconnection-b')

  const remoteUserCoreOnB = await b.graph.openUserCore(a.graph.key)

  const topic = a.graph.discoveryKey
  const swarmA = await testSwarm(t)
  swarmA.on('connection', (conn) => a.store.replicate(conn))

  let swarmB = await testSwarm(t)
  swarmB.on('connection', (conn) => b.store.replicate(conn))

  console.log('  Step 1: both peers join and connect')
  const discA = swarmA.join(topic, { server: true, client: true })
  const discB = swarmB.join(topic, { server: true, client: true })
  await Promise.race([Promise.all([discA.flushed(), discB.flushed()]), sleep(5000)])
  await Promise.race([Promise.all([swarmA.flush(), swarmB.flush()]), sleep(5000)])

  console.log('  Step 2: peer A writes a first message while B is connected')
  const msg1 = await a.graph.put({ type: 'message' })
  await a.graph.putContent(msg1.id, 'Message 1', 'text')
  await sleep(3000)

  console.log('  Step 3: peer B disconnects (intentional mid-test disconnect, not teardown)')
  await destroySwarm(swarmB)

  console.log('  Step 4: peer A writes a second message while B is offline')
  const msg2 = await a.graph.put({ type: 'message' })
  await a.graph.putContent(msg2.id, 'Message 2', 'text')

  console.log('  Step 5: peer B reconnects with a fresh swarm')
  swarmB = await testSwarm(t)
  swarmB.on('connection', (conn) => b.store.replicate(conn))

  const discBReconnect = swarmB.join(topic, { server: true, client: true })
  await discBReconnect.flushed()
  await Promise.race([swarmB.flush(), sleep(5000)])

  t.teardown(async () => {
    await a.close()
    await b.close()
    await destroySwarm(swarmA)
    await destroySwarm(swarmB)
  })

  console.log('  Step 6: wait for both messages to sync after reconnection, then verify exact content')
  let msg1OnB = null
  let msg2OnB = null
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    await remoteUserCoreOnB.update()
    await b.graph.update()
    msg1OnB = await b.graph.get(msg1.id)
    msg2OnB = await b.graph.get(msg2.id)
    if (msg1OnB && msg2OnB) break
  }

  t.ok(msg1OnB, 'peer B caught up on the message written before it disconnected')
  t.ok(msg2OnB, 'peer B caught up on the message written while it was offline')

  const content1OnB = msg1OnB ? await b.graph.getContent(msg1.id) : null
  const content2OnB = msg2OnB ? await b.graph.getContent(msg2.id) : null
  t.is(content1OnB && content1OnB.body, 'Message 1', 'content of the pre-disconnect message matches exactly')
  t.is(content2OnB && content2OnB.body, 'Message 2', 'content of the offline-written message matches exactly')
  console.log('TEST: peer reconnection - passed')

  // No process.exit() here, even as the last file: a force-exit also
  // swallows brittle's final summary, and in networking/ the same
  // workaround silently skipped other files' tests (see peer-connection.js).
})
