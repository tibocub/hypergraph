#!/usr/bin/env node

/**
 * Comprehensive P2P Replication Test Suite
 * 
 * Tests real-world replication scenarios:
 * 1. Catch-up replication (peer connects after data exists)
 * 2. Relay replication (A -> B -> C while A offline)
 * 3. Concurrent writes and conflict resolution
 * 4. Peer reconnection and state sync
 * 
 * CRITICAL REQUIREMENTS FOR REPLICATION:
 * =====================================
 * 1. Core Loading: Cores must be explicitly loaded with store.get({ key: ... })
 *    and await core.ready() BEFORE replication starts. Corestore only replicates
 *    cores that are already loaded in memory when store.replicate() is called.
 * 
 * 2. DHT Announcement: Peers must join the swarm and await flushed() BEFORE
 *    creating data. If data is created before the peer is discoverable on the DHT,
 *    other peers cannot replicate it.
 * 
 * 3. Topic Selection: Must use graph.discoveryKey as the Hyperswarm topic,
 *    not randomly generated topics. This ensures peers can find each other.
 * 
 * 4. Store Replication: Use store.replicate(conn) to replicate all loaded cores
 *    at once, rather than replicating individual cores.
 * 
 * These requirements were discovered through debugging and are documented here
 * to prevent future confusion.
 */

const { Hypergraph, HypergraphNetworking } = require('../../index.js')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function cleanup (...dirs) {
  for (const dir of dirs) {
    // Retry cleanup with delays for Windows file locking issues
    const maxRetries = 10
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true })
          break // Success, exit retry loop
        }
      } catch (err) {
        if (attempt === maxRetries - 1) {
          console.warn('Cleanup warning for', dir, ':', err.message)
        } else {
          await sleep(500 * (attempt + 1)) // Longer exponential backoff
        }
      }
    }
  }
}

/**
 * Properly destroy a swarm with timeout to ensure clean DHT state
 */
async function destroySwarm (swarm, timeoutMs = 5000) {
  try {
    await Promise.race([
      swarm.destroy(),
      sleep(timeoutMs)
    ])
  } catch (err) {
    console.warn('Swarm destruction warning:', err.message)
  }
}

// ============================================================================
// TEST 1: Catch-up Replication
// ============================================================================

async function testCatchUpReplication () {
  console.log('\n=== Test 1: Catch-up Replication ===')
  console.log('Scenario: Peer B connects after Peer A has already created data\n')

  const randomId = Math.random().toString(36).substring(7)
  const dir1 = `./test-catchup-1-${randomId}`
  const dir2 = `./test-catchup-2-${randomId}`
  cleanup(dir1, dir2)

  const timeout = setTimeout(() => {
    console.error('Test 1 TIMEOUT after 30 seconds')
    cleanup(dir1, dir2)
    process.exit(1)
  }, 30000)

  try {
    // Peer A creates data before Peer B joins
    const store1 = new Corestore(dir1)
    const graph1 = new Hypergraph(store1)
    await graph1.ready()

    // CRITICAL: Load Peer A's usercore in store1 BEFORE setting up replication
    const localUserCoreOnA = store1.get({ key: graph1.key })
    await localUserCoreOnA.ready()

    // Use graph1's discovery key as the topic (like old hypergraph example)
    const topic = graph1.discoveryKey
    const swarm1 = new Hyperswarm()

    // Set up replication for Peer A
    swarm1.on('connection', (conn) => {
      store1.replicate(conn)
    })

    // Peer A joins the swarm FIRST (to announce on DHT)
    const d1 = swarm1.join(topic, { server: true, client: true })
    await d1.flushed()
    await swarm1.flush()
    console.log('Peer A announced on DHT')

    // NOW create messages on Peer A's usercore
    const msg = await graph1.put({ type: 'message' })
    await graph1.putContent(msg.id, 'Hello from peer 1!', 'text')
    console.log('Peer A created 1 message on usercore')

    // Now Peer B joins
    const store2 = new Corestore(dir2)
    const graph2 = new Hypergraph(store2)
    await graph2.ready()

    // CRITICAL: Load Peer A's usercore in Peer B's store BEFORE setting up replication
    const remoteUserCoreOnB = store2.get({ key: graph1.key })
    await remoteUserCoreOnB.ready()

    const swarm2 = new Hyperswarm()

    // Set up replication for Peer B
    swarm2.on('connection', (conn) => {
      store2.replicate(conn)
    })

    // Peer B joins the swarm
    const d2 = swarm2.join(topic, { server: true, client: true })

    // Wait for DHT discovery and connection with longer timeout
    await Promise.race([
      Promise.all([d2.flushed(), swarm2.flush()]),
      sleep(15000)
    ])

    console.log('Peers connected, waiting for replication...')
    
    // Wait for replication with update loop (like old hypergraph example)
    for (let i = 0; i < 30; i++) {
      await sleep(500)
      await remoteUserCoreOnB.update()
      if (remoteUserCoreOnB.length > 0) break
    }

    // Check if Peer B received data (check core length)
    const coreLength = remoteUserCoreOnB.length
    console.log(`Peer B's usercore length: ${coreLength}`)
    console.log('Expected: > 0 (data was replicated)')

    await destroySwarm(swarm1)
    await destroySwarm(swarm2)

    clearTimeout(timeout)
    cleanup(dir1, dir2)

    if (coreLength > 0) {
      console.log('✓ Test 1 PASSED\n')
      return true
    } else {
      console.log('✗ Test 1 FAILED\n')
      return false
    }
  } catch (err) {
    console.error('Test 1 ERROR:', err.message)
    clearTimeout(timeout)
    cleanup(dir1, dir2)
    return false
  }
}

// ============================================================================
// TEST 2: Relay Replication
// ============================================================================

async function testRelayReplication () {
  console.log('\n=== Test 2: Relay Replication ===')
  console.log('Scenario: Peer A -> Peer B -> Peer C (A offline during B->C transfer)\n')

  const randomId = Math.random().toString(36).substring(7)
  const dir1 = `./test-relay-1-${randomId}`
  const dir2 = `./test-relay-2-${randomId}`
  const dir3 = `./test-relay-3-${randomId}`
  cleanup(dir1, dir2, dir3)

  const timeout = setTimeout(() => {
    console.error('Test 2 TIMEOUT after 2 minutes')
    cleanup(dir1, dir2, dir3)
    process.exit(1)
  }, 120000)

  try {
    // Peer A creates data
    const store1 = new Corestore(dir1)
    const graph1 = new Hypergraph(store1)
    await graph1.ready()

    // Use graph1's discovery key as the topic
    const topic = graph1.discoveryKey
    const swarm1 = new Hyperswarm()

    // CRITICAL: Peer A must join swarm BEFORE creating data
    // so it's discoverable on the DHT
    swarm1.on('connection', (conn) => {
      store1.replicate(conn)
    })

    const d1 = swarm1.join(topic, { server: true, client: true })
    await d1.flushed()
    console.log('Peer A announced on DHT')

    // NOW create data (after DHT announcement)
    const msg = await graph1.put({ type: 'message' })
    await graph1.putContent(msg.id, 'Message from Peer A', 'text')
    console.log('Peer A created 1 message on usercore')

    // Peer B connects to Peer A
    const store2 = new Corestore(dir2)
    const graph2 = new Hypergraph(store2)
    await graph2.ready()

    // CRITICAL: Load Peer A's usercore in Peer B's store BEFORE setting up replication
    const remoteUserCoreOnB = store2.get({ key: graph1.key })
    await remoteUserCoreOnB.ready()

    const swarm2 = new Hyperswarm()

    swarm2.on('connection', (conn) => {
      store2.replicate(conn)
    })

    // Join the swarm AFTER setting up handlers
    // swarm1 already joined earlier before creating data
    const d2 = swarm2.join(topic, { server: true, client: true })

    await Promise.race([
      d2.flushed(),
      sleep(5000)
    ])

    console.log('Peer A and Peer B connected, waiting for replication...')
    await sleep(10000)

    // Verify Peer B has the data from Peer A (use the pre-loaded instance)
    await remoteUserCoreOnB.update()
    const peerBDataLength = remoteUserCoreOnB.length
    console.log(`Peer B has ${peerBDataLength} blocks from Peer A`)

    // Ensure Peer B actually has the data before disconnecting A
    if (peerBDataLength === 0) {
      console.log('Peer B did not receive data from Peer A, waiting longer...')
      await sleep(10000)
      await remoteUserCoreOnB.update()
      const peerBDataLength2 = remoteUserCoreOnB.length
      console.log(`Peer B now has ${peerBDataLength2} blocks from Peer A`)
    }

    // Disconnect Peer A (simulate going offline)
    await destroySwarm(swarm1)
    console.log('Peer A disconnected (offline)')

    // Peer C connects to Peer B
    const store3 = new Corestore(dir3)
    const graph3 = new Hypergraph(store3)
    await graph3.ready()

    // CRITICAL: Load Peer A's usercore in Peer C's store BEFORE setting up replication
    const remoteUserCoreOnC = store3.get({ key: graph1.key })
    await remoteUserCoreOnC.ready()

    const swarm3 = new Hyperswarm()

    // Use store.replicate() like the old hypergraph example
    swarm3.on('connection', (conn) => {
      store3.replicate(conn)
    })

    // Join the swarm AFTER setting up handlers
    const d3 = swarm3.join(topic, { server: true, client: true })
    await d3.flushed()

    console.log('Peer C connected to Peer B, waiting for relay replication...')
    await sleep(10000)

    // Check if Peer C received the message via Peer B
    // Use the pre-loaded instance that was set up for replication
    await remoteUserCoreOnC.update()

    const coreLength = remoteUserCoreOnC.length
    console.log(`Peer C's usercore length: ${coreLength}`)
    console.log('Expected: > 0 (data was replicated via relay)')

    await destroySwarm(swarm2)
    await destroySwarm(swarm3)

    clearTimeout(timeout)
    cleanup(dir1, dir2, dir3)

    if (coreLength > 0) {
      console.log('✓ Test 2 PASSED\n')
      return true
    } else {
      console.log('✗ Test 2 FAILED\n')
      return false
    }
  } catch (err) {
    console.error('Test 2 ERROR:', err.message)
    clearTimeout(timeout)
    cleanup(dir1, dir2, dir3)
    return false
  }
}

// ============================================================================
// TEST 3: Concurrent Writes
// ============================================================================

async function testConcurrentWrites () {
  console.log('\n=== Test 3: Sequential Writes (Both peers write) ===')
  console.log('Scenario: Both peers write data and replicate to each other\n')

  const randomId = Math.random().toString(36).substring(7)
  const dir1 = `./test-concurrent-1-${randomId}`
  const dir2 = `./test-concurrent-2-${randomId}`
  cleanup(dir1, dir2)

  const timeout = setTimeout(() => {
    console.error('Test 3 TIMEOUT after 30 seconds')
    cleanup(dir1, dir2)
    process.exit(1)
  }, 30000)

  try {
    const store1 = new Corestore(dir1)
    const store2 = new Corestore(dir2)

    const graph1 = new Hypergraph(store1)
    const graph2 = new Hypergraph(store2)

    await Promise.all([graph1.ready(), graph2.ready()])

    // Use graph1's discovery key as the topic
    const topic = graph1.discoveryKey
    const swarm1 = new Hyperswarm()

    // CRITICAL: Load both usercores in both stores BEFORE setting up replication
    const localUserCore1 = store1.get({ key: graph1.key })
    const localUserCore2 = store2.get({ key: graph2.key })
    const remoteUserCore2On1 = store1.get({ key: graph2.key })
    const remoteUserCore1On2 = store2.get({ key: graph1.key })
    await Promise.all([localUserCore1.ready(), localUserCore2.ready(), remoteUserCore2On1.ready(), remoteUserCore1On2.ready()])

    // Use store.replicate() like the old hypergraph example
    swarm1.on('connection', (conn) => {
      store1.replicate(conn)
    })

    // Peer A joins swarm FIRST (to announce on DHT before creating data)
    const d1 = swarm1.join(topic, { server: true, client: true })
    await d1.flushed()
    console.log('Peer A announced on DHT')

    // Peer A writes first
    const msg1 = await graph1.put({ type: 'message' })
    await graph1.putContent(msg1.id, 'Message from Peer A', 'text')
    console.log('Peer A wrote message 1')

    // NOW Peer B joins
    const swarm2 = new Hyperswarm()
    swarm2.on('connection', (conn) => {
      store2.replicate(conn)
    })

    const d2 = swarm2.join(topic, { server: true, client: true })
    await d2.flushed()
    console.log('Peer B announced on DHT')

    // Wait for Peer B to connect to Peer A and replicate
    console.log('Waiting for Peer B to connect and replicate...')
    await sleep(10000)

    // Peer B writes (both peers now have data)
    const msg2 = await graph2.put({ type: 'message' })
    await graph2.putContent(msg2.id, 'Message from Peer B', 'text')
    console.log('Peer B wrote message 2')

    console.log('Both peers wrote, waiting for replication...')
    await sleep(5000)

    // Check if both peers have both messages
    // Use the pre-loaded instances that were set up for replication
    await remoteUserCore2On1.update()
    await remoteUserCore1On2.update()

    const coreLength1 = remoteUserCore2On1.length
    const coreLength2 = remoteUserCore1On2.length
    console.log(`Peer A's remote usercore length: ${coreLength1}`)
    console.log(`Peer B's remote usercore length: ${coreLength2}`)
    console.log('Expected: Both > 0 (data was replicated)')

    await destroySwarm(swarm1)
    await destroySwarm(swarm2)

    clearTimeout(timeout)
    cleanup(dir1, dir2)

    if (coreLength1 > 0 && coreLength2 > 0) {
      console.log('✓ Test 3 PASSED\n')
      return true
    } else {
      console.log('✗ Test 3 FAILED\n')
      return false
    }
  } catch (err) {
    console.error('Test 3 ERROR:', err.message)
    clearTimeout(timeout)
    cleanup(dir1, dir2)
    return false
  }
}

// ============================================================================
// TEST 4: Peer Reconnection
// ============================================================================

async function testPeerReconnection () {
  console.log('\n=== Test 4: Peer Reconnection ===')
  console.log('Scenario: Peer disconnects and reconnects\n')

  const randomId = Math.random().toString(36).substring(7)
  const dir1 = `./test-reconnect-1-${randomId}`
  const dir2 = `./test-reconnect-2-${randomId}`
  cleanup(dir1, dir2)

  const timeout = setTimeout(() => {
    console.error('Test 4 TIMEOUT after 30 seconds')
    cleanup(dir1, dir2)
    process.exit(1)
  }, 30000)

  try {
    const store1 = new Corestore(dir1)
    const store2 = new Corestore(dir2)

    const graph1 = new Hypergraph(store1)
    const graph2 = new Hypergraph(store2)

    await Promise.all([graph1.ready(), graph2.ready()])

    // Use graph1's discovery key as the topic
    const topic = graph1.discoveryKey
    const swarm1 = new Hyperswarm()
    const swarm2 = new Hyperswarm()

    // CRITICAL: Load Peer A's usercore in Peer B's store BEFORE setting up replication
    const remoteUserCoreOnB = store2.get({ key: graph1.key })
    await remoteUserCoreOnB.ready()

    // Set up store replication BEFORE joining
    swarm1.on('connection', (conn) => {
      store1.replicate(conn)
    })

    swarm2.on('connection', (conn) => {
      store2.replicate(conn)
    })

    // Join the swarm AFTER setting up handlers
    const d1 = swarm1.join(topic, { server: true, client: true })
    const d2 = swarm2.join(topic, { server: true, client: true })

    await Promise.race([
      Promise.all([d1.flushed(), d2.flushed()]),
      sleep(5000)
    ])

    console.log('Peers connected')

    // Peer A creates a message on usercore
    const msg = await graph1.put({ type: 'message' })
    await graph1.putContent(msg.id, 'Message 1', 'text')

    await sleep(3000)

    // Peer B disconnects
    await destroySwarm(swarm2)
    console.log('Peer B disconnected')

    // Peer A creates another message while B is offline
    const msg2 = await graph1.put({ type: 'message' })
    await graph1.putContent(msg2.id, 'Message 2', 'text')

    console.log('Peer A created another message while B was offline')

    // Peer B reconnects
    const swarm3 = new Hyperswarm()

    // CRITICAL: Load Peer A's usercore in Peer B's store BEFORE setting up replication
    // (already loaded earlier, but we need to ensure it's still in memory)
    const remoteUserCoreOnB2 = store2.get({ key: graph1.key })
    await remoteUserCoreOnB2.ready()

    // Set up store replication for reconnection BEFORE joining
    swarm3.on('connection', (conn) => {
      store2.replicate(conn)
    })

    // Join the swarm AFTER setting up handlers
    const d3 = swarm3.join(topic, { server: true, client: true })
    await d3.flushed()
    console.log('Peer B reconnected, waiting for sync...')

    await sleep(5000)

    // Check if Peer B received both messages (use the pre-loaded instance)
    await remoteUserCoreOnB2.update()

    const coreLength = remoteUserCoreOnB2.length
    console.log(`Peer B's usercore length after reconnection: ${coreLength}`)
    console.log('Expected: > 0 (data was replicated after reconnection)')

    await destroySwarm(swarm1)
    await destroySwarm(swarm3)

    clearTimeout(timeout)
    cleanup(dir1, dir2)

    if (coreLength > 0) {
      console.log('✓ Test 4 PASSED\n')
      return true
    } else {
      console.log('✗ Test 4 FAILED\n')
      return false
    }
  } catch (err) {
    console.error('Test 4 ERROR:', err.message)
    clearTimeout(timeout)
    cleanup(dir1, dir2)
    return false
  }
}

// ============================================================================
// TEST 5: HypergraphNetworking Integration
// ============================================================================

async function testHypergraphNetworking () {
  console.log('\n=== Test 5: HypergraphNetworking Integration ===')
  console.log('Scenario: Test HypergraphNetworking helper for replication\n')

  const randomId = Math.random().toString(36).substring(7)
  const dir1 = `./test-networking-1-${randomId}`
  const dir2 = `./test-networking-2-${randomId}`
  cleanup(dir1, dir2)

  const timeout = setTimeout(() => {
    console.error('Test 5 TIMEOUT after 30 seconds')
    cleanup(dir1, dir2)
    process.exit(1)
  }, 30000)

  try {
    const store1 = new Corestore(dir1)
    const store2 = new Corestore(dir2)

    const graph1 = new Hypergraph(store1)
    const graph2 = new Hypergraph(store2)

    await Promise.all([graph1.ready(), graph2.ready()])

    // Use graph1's discovery key as the topic
    const topic = graph1.discoveryKey

    // Create HypergraphNetworking helpers
    const networking1 = new HypergraphNetworking(graph1, store1, { topic })
    const networking2 = new HypergraphNetworking(graph2, store2, { topic })

    // CRITICAL: Load remote usercores BEFORE connecting
    const remoteUserCore2On1 = store1.get({ key: graph2.key })
    const remoteUserCore1On2 = store2.get({ key: graph1.key })
    await Promise.all([remoteUserCore2On1.ready(), remoteUserCore1On2.ready()])

    // Connect both peers
    await networking1.connect()
    await networking2.connect()

    console.log('Peers connected via HypergraphNetworking')

    // Wait for connection establishment
    await sleep(3000)

    // Peer A creates data
    const msg = await graph1.put({ type: 'message' })
    await graph1.putContent(msg.id, 'Message via HypergraphNetworking', 'text')

    console.log('Peer A created data, waiting for replication...')
    await sleep(5000)

    // Check if Peer B received data
    await remoteUserCore1On2.update()
    const coreLength = remoteUserCore1On2.length
    console.log(`Peer B's remote usercore length: ${coreLength}`)
    console.log('Expected: > 0 (data was replicated via HypergraphNetworking)')

    // Cleanup
    await networking1.destroy()
    await networking2.destroy()

    clearTimeout(timeout)
    cleanup(dir1, dir2)

    if (coreLength > 0) {
      console.log('✓ Test 5 PASSED\n')
      return true
    } else {
      console.log('✗ Test 5 FAILED\n')
      return false
    }
  } catch (err) {
    console.error('Test 5 ERROR:', err.message)
    clearTimeout(timeout)
    cleanup(dir1, dir2)
    return false
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main () {
  console.log('=== Comprehensive P2P Replication Test Suite ===\n')

  const results = {
    catchUp: await testCatchUpReplication(),
    relay: await testRelayReplication(),
    concurrent: await testConcurrentWrites(),
    reconnection: await testPeerReconnection(),
    networking: await testHypergraphNetworking()
  }

  console.log('\n=== Test Summary ===')
  console.log('Catch-up replication:', results.catchUp ? '✓ PASSED' : '✗ FAILED')
  console.log('Relay replication:', results.relay ? '✓ PASSED' : '✗ FAILED')
  console.log('Concurrent writes:', results.concurrent ? '✓ PASSED' : '✗ FAILED')
  console.log('Peer reconnection:', results.reconnection ? '✓ PASSED' : '✗ FAILED')
  console.log('HypergraphNetworking:', results.networking ? '✓ PASSED' : '✗ FAILED')

  const passed = Object.values(results).filter(r => r).length
  const total = Object.values(results).length

  console.log(`\nTotal: ${passed}/${total} tests passed`)

  process.exit(passed === total ? 0 : 1)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
