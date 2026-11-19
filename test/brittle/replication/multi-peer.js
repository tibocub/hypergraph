// NOTE ON NETWORK DEPENDENCY: joins the real public DHT via Hyperswarm.

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { createGraph, sleep, waitForConnections, destroySwarm, testSwarm } = require('../helpers')

test('multi-peer: data written by one peer replicates to two others, with content verified (needs real network)', { timeout: 320000 }, async (t) => {
  console.log('TEST: 3-peer replication - starting (requires DHT access)')

  console.log('  Step 1: create three peers, all watching peer A user core')
  const a = await createGraph(t, 'multi-peer-a')
  const b = await createGraph(t, 'multi-peer-b')
  const c = await createGraph(t, 'multi-peer-c')

  const aUserCoreOnB = await b.graph.openUserCore(a.graph.key)
  const aUserCoreOnC = await c.graph.openUserCore(a.graph.key)

  const topic = a.graph.discoveryKey
  const swarmA = await testSwarm(t)
  const swarmB = await testSwarm(t)
  const swarmC = await testSwarm(t)
  swarmA.on('connection', (conn) => a.store.replicate(conn))
  swarmB.on('connection', (conn) => b.store.replicate(conn))
  swarmC.on('connection', (conn) => c.store.replicate(conn))

  console.log('  Step 2: all three peers join the same topic')
  const discA = swarmA.join(topic, { server: true, client: true })
  const discB = swarmB.join(topic, { server: true, client: true })
  const discC = swarmC.join(topic, { server: true, client: true })
  await Promise.all([discA.flushed(), discB.flushed(), discC.flushed()])
  // swarm.flush() is deliberately not awaited here: per hyperswarm's own
  // README, connections are emitted by 'connection' as soon as they happen,
  // independent of flush() — flush() is heavyweight and unrelated to
  // whether a specific connection has already succeeded. The actual
  // connection check below (waitForConnections) polls swarm.connections
  // directly rather than relying on flush() for anything.

  t.teardown(async () => {
    await a.close()
    await b.close()
    await c.close()
    await destroySwarm(swarmA)
    await destroySwarm(swarmB)
    await destroySwarm(swarmC)
  })

  console.log('  Step 2b: verify every peer actually has at least one live connection (not just flushed discovery)')
  const connCounts = await waitForConnections([
    { name: 'A', swarm: swarmA }, { name: 'B', swarm: swarmB }, { name: 'C', swarm: swarmC }
  ], 60000, { topic, retries: 2 })
  const hasAllConnections = connCounts.every((c) => c.count > 0)
  t.ok(hasAllConnections, 'every peer has at least one live connection before data is written')

  if (!hasAllConnections) {
    console.log('TEST: 3-peer replication - skipped remaining steps (missing connection)')
    return
  }

  console.log('  Step 3: peer A writes data once all three are connected')
  await sleep(3000)
  const msg = await a.graph.put({ type: 'message' })
  await a.graph.putContent(msg.id, 'Broadcast to everyone', 'text')

  console.log('  Step 4: pump peers B and C until both catch up, then verify exact content')
  let msgOnB = null
  let msgOnC = null
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    await aUserCoreOnB.update()
    await aUserCoreOnC.update()
    await b.graph.update()
    await c.graph.update()
    msgOnB = await b.graph.get(msg.id)
    msgOnC = await c.graph.get(msg.id)
    if (i % 10 === 0) {
      console.log(`    ...waiting (${i}s): onB=${!!msgOnB}, onC=${!!msgOnC}, connections A=${swarmA.connections.size} B=${swarmB.connections.size} C=${swarmC.connections.size}`)
    }
    if (msgOnB && msgOnC) break
  }

  t.ok(msgOnB, 'peer B received the entity written by peer A')
  t.ok(msgOnC, `peer C received the entity written by peer A (had ${swarmC.connections.size} live connection(s))`)

  const contentOnB = msgOnB ? await b.graph.getContent(msg.id) : null
  const contentOnC = msgOnC ? await c.graph.getContent(msg.id) : null
  t.is(contentOnB && contentOnB.body, 'Broadcast to everyone', "peer B's copy of the content matches exactly")
  t.is(contentOnC && contentOnC.body, 'Broadcast to everyone', "peer C's copy of the content matches exactly")
  console.log('TEST: 3-peer replication - passed')
})

test('multi-peer: three peers each write, and all three converge on all writes with content verified (needs real network)', { timeout: 320000 }, async (t) => {
  console.log('TEST: 3-peer convergence - starting (requires DHT access)')

  const a = await createGraph(t, 'multi-peer-conv-a')
  const b = await createGraph(t, 'multi-peer-conv-b')
  const c = await createGraph(t, 'multi-peer-conv-c')

  console.log('  Step 1: register each peer\'s user core on the other two before connecting')
  const bUserCoreOnA = await a.graph.openUserCore(b.graph.key)
  const cUserCoreOnA = await a.graph.openUserCore(c.graph.key)
  const aUserCoreOnB = await b.graph.openUserCore(a.graph.key)
  const cUserCoreOnB = await b.graph.openUserCore(c.graph.key)
  const aUserCoreOnC = await c.graph.openUserCore(a.graph.key)
  const bUserCoreOnC = await c.graph.openUserCore(b.graph.key)

  const topic = a.graph.discoveryKey
  const swarmA = await testSwarm(t)
  const swarmB = await testSwarm(t)
  const swarmC = await testSwarm(t)
  swarmA.on('connection', (conn) => a.store.replicate(conn))
  swarmB.on('connection', (conn) => b.store.replicate(conn))
  swarmC.on('connection', (conn) => c.store.replicate(conn))

  const discA = swarmA.join(topic, { server: true, client: true })
  const discB = swarmB.join(topic, { server: true, client: true })
  const discC = swarmC.join(topic, { server: true, client: true })
  await Promise.all([discA.flushed(), discB.flushed(), discC.flushed()])
  // swarm.flush() deliberately not awaited here — see Step 2 above.

  t.teardown(async () => {
    await a.close()
    await b.close()
    await c.close()
    await destroySwarm(swarmA)
    await destroySwarm(swarmB)
    await destroySwarm(swarmC)
  })

  console.log('  Step 1b: verify every peer actually has at least one live connection (not just flushed discovery)')
  const connCounts = await waitForConnections([
    { name: 'A', swarm: swarmA }, { name: 'B', swarm: swarmB }, { name: 'C', swarm: swarmC }
  ], 60000, { topic, retries: 2 })
  const hasAllConnections = connCounts.every((c) => c.count > 0)
  t.ok(hasAllConnections, 'every peer has at least one live connection before data is written')

  if (!hasAllConnections) {
    console.log('TEST: 3-peer convergence - skipped remaining steps (missing connection)')
    return
  }

  console.log('  Step 2: each peer writes its own uniquely-identifiable message once all are connected')
  await sleep(3000)
  const msgA = await a.graph.put({ type: 'message' })
  await a.graph.putContent(msgA.id, 'Message from A', 'text')
  const msgB = await b.graph.put({ type: 'message' })
  await b.graph.putContent(msgB.id, 'Message from B', 'text')
  const msgC = await c.graph.put({ type: 'message' })
  await c.graph.putContent(msgC.id, 'Message from C', 'text')

  console.log('  Step 3: pump all peers until each has seen the other two, then verify exact content everywhere')
  let allConverged = false
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    await Promise.all([
      bUserCoreOnA.update(), cUserCoreOnA.update(),
      aUserCoreOnB.update(), cUserCoreOnB.update(),
      aUserCoreOnC.update(), bUserCoreOnC.update(),
      a.graph.update(), b.graph.update(), c.graph.update()
    ])
    const [msgBOnA, msgCOnA, msgAOnB, msgCOnB, msgAOnC, msgBOnC] = await Promise.all([
      a.graph.get(msgB.id), a.graph.get(msgC.id),
      b.graph.get(msgA.id), b.graph.get(msgC.id),
      c.graph.get(msgA.id), c.graph.get(msgB.id)
    ])
    allConverged = !!(msgBOnA && msgCOnA && msgAOnB && msgCOnB && msgAOnC && msgBOnC)
    if (i % 10 === 0) {
      console.log(`    ...waiting (${i}s): A has [B:${!!msgBOnA},C:${!!msgCOnA}], B has [A:${!!msgAOnB},C:${!!msgCOnB}], C has [A:${!!msgAOnC},B:${!!msgBOnC}], connections A=${swarmA.connections.size} B=${swarmB.connections.size} C=${swarmC.connections.size}`)
    }
    if (allConverged) break
  }

  t.ok(allConverged, 'all three peers received all three entities')

  const [contentBOnA, contentCOnA, contentAOnB, contentCOnB, contentAOnC, contentBOnC] = await Promise.all([
    a.graph.getContent(msgB.id), a.graph.getContent(msgC.id),
    b.graph.getContent(msgA.id), b.graph.getContent(msgC.id),
    c.graph.getContent(msgA.id), c.graph.getContent(msgB.id)
  ])
  t.is(contentBOnA && contentBOnA.body, 'Message from B', "A's copy of B's message matches exactly")
  t.is(contentCOnA && contentCOnA.body, 'Message from C', "A's copy of C's message matches exactly")
  t.is(contentAOnB && contentAOnB.body, 'Message from A', "B's copy of A's message matches exactly")
  t.is(contentCOnB && contentCOnB.body, 'Message from C', "B's copy of C's message matches exactly")
  t.is(contentAOnC && contentAOnC.body, 'Message from A', "C's copy of A's message matches exactly")
  t.is(contentBOnC && contentBOnC.body, 'Message from B', "C's copy of B's message matches exactly")
  console.log('TEST: 3-peer convergence - passed')
})
