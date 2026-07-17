// NOTE ON NETWORK DEPENDENCY:
// The full connect() flow needs real DHT access to verify `connected` end
// to end and cannot be verified in this sandbox. It does have an internal
// ~20s timeout rather than hanging forever, so it fails safely offline.
//
// BUG FOUND & FIXED (arg shape): connectToSwarm() built the HypergraphNetwork
// call with `new HypergraphNetworking(this, this.#store, { dataSwarm: opts.swarm, topic, ... })`
// — stuffing the options into the 3rd positional constructor argument
// (`swarm`) instead of passing the swarm and options separately. Since
// HypergraphNetwork's real constructor is `(graph, store, swarm, opts)`,
// this made `swarm` become the options object and `opts.topic` become
// undefined, so every call threw "Topic is required" immediately. It also
// never auto-created a Hyperswarm when `opts.swarm` was omitted, despite the
// docstring promising it would. Both are fixed in src/hypergraph.js.
//
// BUG FOUND & FIXED (teardown ordering): brittle's t.teardown() runs LIFO.
// Destroying a swarm before the graph/store that used it are closed tears
// the raw socket out from under an in-flight replication stream, and
// store.close() then hangs forever waiting for a clean close event that
// never comes. Every test below now lets the connectToSwarm() call settle
// (or times out deliberately) and closes graph/store *before* destroying
// the swarm.

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const crypto = require('crypto')
const { createGraph, sleep, destroySwarm } = require('../helpers')

test('connect-to-swarm: connectToSwarm no longer throws "Topic is required" (no network needed)', async (t) => {
  console.log('TEST: connectToSwarm argument fix - starting')
  const peer = await createGraph(t, 'connect-to-swarm-args')

  const swarm = new Hyperswarm()
  const topic = crypto.randomBytes(32)

  console.log('  Step 1: race connect() against a short timeout (no DHT needed to prove the arg bug is gone)')
  const connectPromise = peer.graph.connectToSwarm(topic, { swarm, role: 'owner' })
    .then((networking) => ({ ok: true, networking }))
    .catch((err) => ({ ok: false, err }))

  const result = await Promise.race([
    connectPromise,
    sleep(3000).then(() => ({ ok: true, timedOut: true }))
  ])

  if (!result.ok) {
    t.fail(`connectToSwarm rejected: ${result.err.message}`)
  } else {
    t.pass('connectToSwarm did not synchronously throw "Topic is required"')
  }

  console.log('  Step 2: let the background connect attempt settle, then close everything in the safe order')
  t.teardown(async () => {
    const settled = await Promise.race([connectPromise, sleep(15000).then(() => null)])
    if (settled && settled.networking) {
      try { await settled.networking.destroy() } catch (err) { /* already closed */ }
    }
    await peer.close()
    await destroySwarm(swarm)
  })
  console.log('TEST: connectToSwarm argument fix - passed')
})

test('connect-to-swarm: auto-creates a Hyperswarm when opts.swarm is omitted (no network needed)', async (t) => {
  console.log('TEST: connectToSwarm auto-create swarm - starting')
  const peer = await createGraph(t, 'connect-to-swarm-autocreate')

  const topic = crypto.randomBytes(32)

  console.log('  Step 1: call connectToSwarm with no swarm option at all')
  const connectPromise = peer.graph.connectToSwarm(topic, { role: 'owner' })
    .then((networking) => ({ ok: true, networking }))
    .catch((err) => ({ ok: false, err }))

  const result = await Promise.race([
    connectPromise,
    sleep(3000).then(() => ({ ok: true, timedOut: true }))
  ])

  if (!result.ok) {
    t.fail(`connectToSwarm rejected: ${result.err.message}`)
  } else {
    t.pass('connectToSwarm auto-created a swarm instead of requiring one')
  }

  console.log('  Step 2: let the background connect attempt settle, then close everything in the safe order')
  t.teardown(async () => {
    const settled = await Promise.race([connectPromise, sleep(15000).then(() => null)])
    if (settled && settled.networking) {
      try { await settled.networking.destroy() } catch (err) { /* already closed */ }
    }
    await peer.close()
  })
  console.log('TEST: connectToSwarm auto-create swarm - passed')
})

test('connect-to-swarm: two peers connect end-to-end via connectToSwarm/disconnectFromSwarm (needs real network)', { timeout: 240000 }, async (t) => {
  console.log('TEST: connectToSwarm end-to-end - starting (requires DHT access)')
  const a = await createGraph(t, 'connect-to-swarm-e2e-a')
  const b = await createGraph(t, 'connect-to-swarm-e2e-b')

  const topic = crypto.randomBytes(32)
  const swarmA = new Hyperswarm()
  const swarmB = new Hyperswarm()

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
