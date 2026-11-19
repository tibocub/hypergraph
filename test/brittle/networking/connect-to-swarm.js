// NOTE ON NETWORK DEPENDENCY:

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const crypto = require('crypto')
const { createGraph, sleep, destroySwarm, testSwarm, testBootstrap } = require('../helpers')

test('connect-to-swarm: connectToSwarm no longer throws "Topic is required" (no network needed)', async (t) => {
  console.log('TEST: connectToSwarm argument fix - starting')
  const peer = await createGraph(t, 'connect-to-swarm-args')

  const swarm = await testSwarm(t)
  const topic = crypto.randomBytes(32)

  console.log('  Step 1: race connect() against a short timeout (no DHT needed to prove the arg bug is gone)')
  const connectPromise = peer.graph.connectToSwarm(topic, { swarm, role: 'owner' })
    .then((networking) => ({ ok: true, networking }))
    .catch((err) => ({ ok: false, err }))

  const result = await Promise.race([
    connectPromise,
    sleep(500).then(() => ({ ok: true, timedOut: true }))
  ])

  if (!result.ok) {
    t.fail(`connectToSwarm rejected: ${result.err.message}`)
  } else {
    t.pass('connectToSwarm did not synchronously throw "Topic is required"')
  }

  console.log('  Step 2: let the background connect attempt settle, then close everything in the safe order')
  t.teardown(async () => {
    await peer.close()
    await connectPromise
    await destroySwarm(swarm)
  })
  console.log('TEST: connectToSwarm argument fix - passed')
})

test('connect-to-swarm: auto-creates a Hyperswarm when opts.swarm is omitted (no network needed)', async (t) => {
  console.log('TEST: connectToSwarm auto-create swarm - starting')
  const peer = await createGraph(t, 'connect-to-swarm-autocreate')

  const topic = crypto.randomBytes(32)

  console.log('  Step 1: call connectToSwarm with no swarm option at all')
  const connectPromise = peer.graph.connectToSwarm(topic, { role: 'owner', bootstrap: await testBootstrap(t) })
    .then((networking) => ({ ok: true, networking }))
    .catch((err) => ({ ok: false, err }))

  const result = await Promise.race([
    connectPromise,
    sleep(500).then(() => ({ ok: true, timedOut: true }))
  ])

  if (!result.ok) {
    t.fail(`connectToSwarm rejected: ${result.err.message}`)
  } else {
    t.pass('connectToSwarm auto-created a swarm instead of requiring one')
  }

  console.log('  Step 2: let the background connect attempt settle, then close everything in the safe order')
  t.teardown(async () => {
    // close() destroys the network and the swarm it auto-created, even
    // while it is still connecting (it used to keep retrying for ~45 s and
    // keep the process alive).
    await peer.close()
    await connectPromise
  })
  console.log('TEST: connectToSwarm auto-create swarm - passed')
})

test('connect-to-swarm: two peers connect end-to-end via connectToSwarm/disconnectFromSwarm (needs real network)', { timeout: 240000 }, async (t) => {
  console.log('TEST: connectToSwarm end-to-end - starting (requires DHT access)')
  const a = await createGraph(t, 'connect-to-swarm-e2e-a')
  const b = await createGraph(t, 'connect-to-swarm-e2e-b')

  const topic = crypto.randomBytes(32)
  const swarmA = await testSwarm(t)
  const swarmB = await testSwarm(t)

  console.log('  Step 1: connect both peers to the same topic in parallel')
  const [networkingA, networkingB] = await Promise.all([
    a.graph.connectToSwarm(topic, { swarm: swarmA, role: 'owner' }),
    b.graph.connectToSwarm(topic, { swarm: swarmB, role: 'peer' })
  ])
  networkingA.on('flush-timeout', (info) => console.log(`    [A] flush-timeout: ${info.step} exceeded ${info.timeoutMs}ms`))
  networkingB.on('flush-timeout', (info) => console.log(`    [B] flush-timeout: ${info.step} exceeded ${info.timeoutMs}ms`))

  t.teardown(async () => {
    try { await a.graph.disconnectFromSwarm(networkingA) } catch (err) { /* already closed */ }
    try { await b.graph.disconnectFromSwarm(networkingB) } catch (err) { /* already closed */ }
    await a.close()
    await b.close()
    await destroySwarm(swarmA)
    await destroySwarm(swarmB)
  })

  console.log('  Step 2: verify both report connected')
  t.ok(networkingA.connected, 'peer A is connected')
  t.ok(networkingB.connected, 'peer B is connected')
  console.log('TEST: connectToSwarm end-to-end - passed')
})

test('connect-to-swarm: graph.close() stops a connectToSwarm() that is still trying to connect', async (t) => {
  const { graph, close } = await createGraph(t, 'connect-to-swarm-close')
  const topic = crypto.randomBytes(32) // nobody else here: connect() keeps retrying
  const connecting = graph.connectToSwarm(topic, { role: 'peer', bootstrap: await testBootstrap(t) })
  await sleep(500)
  const started = Date.now()
  await close()
  await connecting
  t.ok(Date.now() - started < 3000, `the attempt stopped within ${Date.now() - started} ms of close()`)
})
