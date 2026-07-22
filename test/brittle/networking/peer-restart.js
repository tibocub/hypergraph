// Tests for peer restart/resume: closing and reopening a Hypergraph
// instance on the same Corestore directory, simulating a real app
// restarting (process exit + relaunch, not just an in-memory close/reopen
// within one test).

const test = require('brittle')
const Corestore = require('corestore')
const path = require('path')
const os = require('os')
const fs = require('fs')
const hypercoreCrypto = require('hypercore-crypto')
const { Hypergraph } = require('../../../index.js')
const { sleep } = require('../helpers')

test('peer-restart: without explicitly persisting deviceKeyPair, reopening on the same store creates a DIFFERENT, unrelated identity — a real gotcha, not a bug', async (t) => {
  console.log('TEST: restart without persisted deviceKeyPair - starting')
  const dir = path.join(os.tmpdir(), `hypergraph-restart-naive-${process.pid}-${Date.now()}`)
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  const store1 = new Corestore(dir)
  const graph1 = new Hypergraph(store1)
  await graph1.ready()
  const key1 = graph1.key.toString('hex')
  await graph1.close()
  await store1.close()

  console.log('  "restart": same directory, but no deviceKeyPair passed — matches an app that forgot to persist it')
  const store2 = new Corestore(dir)
  const graph2 = new Hypergraph(store2)
  await graph2.ready()
  const key2 = graph2.key.toString('hex')
  await graph2.close()
  await store2.close()

  t.not(key1, key2, 'confirmed: a naive restart with no explicit deviceKeyPair produces a completely different, unrelated identity — apps MUST persist and reuse deviceKeyPair themselves for restart continuity')
  console.log('TEST: restart without persisted deviceKeyPair - passed')
})

test('peer-restart: with deviceKeyPair explicitly persisted and reused, a restart correctly preserves identity, prior data, and context writability', async (t) => {
  console.log('TEST: restart with persisted deviceKeyPair - starting')
  const dir = path.join(os.tmpdir(), `hypergraph-restart-correct-${process.pid}-${Date.now()}`)
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const storeDir = path.join(dir, 'store')
  const keyPairFile = path.join(dir, 'device-keypair.json')

  function loadOrCreateDeviceKeyPair () {
    if (fs.existsSync(keyPairFile)) {
      const saved = JSON.parse(fs.readFileSync(keyPairFile, 'utf-8'))
      return { publicKey: Buffer.from(saved.publicKey, 'hex'), secretKey: Buffer.from(saved.secretKey, 'hex') }
    }
    const kp = hypercoreCrypto.keyPair()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(keyPairFile, JSON.stringify({ publicKey: kp.publicKey.toString('hex'), secretKey: kp.secretKey.toString('hex') }))
    return kp
  }

  console.log('  Step 1: first "session" — create data, join a context')
  let store = new Corestore(storeDir)
  let deviceKeyPair = loadOrCreateDeviceKeyPair()
  let graph = new Hypergraph(store, { deviceKeyPair })
  await graph.ready()
  const originalKey = graph.key.toString('hex')

  const post = await graph.put({ type: 'post' })
  await graph.putContent(post.id, 'written before restart', 'text')
  const ctxKey = await graph.createContext({ writeMode: 'open' })
  const ctx = await graph.openContext(ctxKey, { writeMode: 'open' })
  await graph.relate({ from: post.id, to: post.id, type: 'self', context: ctxKey })
  t.ok(ctx.writable, 'sanity: writable before restart')

  await graph.close()
  await store.close()

  console.log('  Step 2: "restart" — reopen the same store, reusing the persisted deviceKeyPair')
  store = new Corestore(storeDir)
  deviceKeyPair = loadOrCreateDeviceKeyPair()
  graph = new Hypergraph(store, { deviceKeyPair })
  await graph.ready()

  t.is(graph.key.toString('hex'), originalKey, 'the same identity is restored across the restart')

  const restoredPost = await graph.get(post.id)
  t.ok(restoredPost, 'the entity created before restart still exists')
  const restoredContent = await graph.getContent(post.id)
  t.is(restoredContent.body, 'written before restart', 'its content is intact and correct')

  const restoredCtx = await graph.openContext(ctxKey, { writeMode: 'open' })
  t.ok(restoredCtx.writable, 'still recognized as a writer in the context it had joined, with no new addWriter() call needed — writer status is tied to the core key, which is unchanged')

  console.log('  Step 3: a new write after restart still works correctly')
  const post2 = await graph.put({ type: 'post' })
  await graph.relate({ from: post2.id, to: post.id, type: 'reply', context: ctxKey })
  const edges = []
  for await (const e of graph.edges(post.id, { direction: 'in', type: 'reply' })) edges.push(e)
  t.is(edges.length, 1, 'a fresh write after restart succeeds correctly')

  await graph.close()
  await store.close()
  console.log('TEST: restart with persisted deviceKeyPair - passed')
})

test('peer-restart: a peer that restarts mid-session resumes replicating with an existing peer correctly, including data written both before and after the restart', async (t) => {
  console.log('TEST: restart and reconnect with a live peer - starting')
  const dir = path.join(os.tmpdir(), `hypergraph-restart-reconnect-${process.pid}-${Date.now()}`)
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dirOwner = path.join(dir, 'owner')
  const dirPeer = path.join(dir, 'peer')
  const peerKeyPairFile = path.join(dir, 'peer-keypair.json')
  fs.mkdirSync(dir, { recursive: true })

  function loadOrCreatePeerKeyPair () {
    if (fs.existsSync(peerKeyPairFile)) {
      const saved = JSON.parse(fs.readFileSync(peerKeyPairFile, 'utf-8'))
      return { publicKey: Buffer.from(saved.publicKey, 'hex'), secretKey: Buffer.from(saved.secretKey, 'hex') }
    }
    const kp = hypercoreCrypto.keyPair()
    fs.writeFileSync(peerKeyPairFile, JSON.stringify({ publicKey: kp.publicKey.toString('hex'), secretKey: kp.secretKey.toString('hex') }))
    return kp
  }

  const storeOwner = new Corestore(dirOwner)
  const graphOwner = new Hypergraph(storeOwner)
  await graphOwner.ready()
  t.teardown(async () => { await graphOwner.close(); await storeOwner.close() })

  let peerKeyPair = loadOrCreatePeerKeyPair()
  let storePeer = new Corestore(dirPeer)
  let graphPeer = new Hypergraph(storePeer, { deviceKeyPair: peerKeyPair })
  await graphPeer.ready()
  const peerIdentityKey = graphPeer.key.toString('hex')

  const ctxKey = await graphOwner.createContext({ writeMode: 'open' })
  const ctxOwner = await graphOwner.openContext(ctxKey, { writeMode: 'open' })
  await graphPeer.openUserCore(graphOwner.key)
  let ctxPeer = await graphPeer.openContext(ctxKey, { writeMode: 'open' })
  await graphOwner.openUserCore(graphPeer.key)

  let s1 = storeOwner.replicate(true, { live: true })
  let s2 = storePeer.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)

  await ctxOwner.addWriter(ctxPeer.localKey)
  for (let i = 0; i < 30 && !ctxPeer.writable; i++) { await sleep(200); await ctxPeer.update() }
  t.ok(ctxPeer.writable, 'sanity: peer writable before restart')

  const postBeforeRestart = await graphPeer.put({ type: 'post' })
  await graphPeer.relate({ from: postBeforeRestart.id, to: postBeforeRestart.id, type: 'self', context: ctxKey })

  for (let i = 0; i < 30; i++) {
    await sleep(200)
    await graphOwner.update()
    if (await graphOwner.get(postBeforeRestart.id)) break
  }
  t.ok(await graphOwner.get(postBeforeRestart.id), 'sanity: owner sees the peer\'s pre-restart post')

  console.log('  peer "crashes": connections destroyed, graph/store closed')
  s1.destroy()
  s2.destroy()
  await graphPeer.close()
  await storePeer.close()
  await sleep(300)

  console.log('  peer "restarts": same store, same persisted deviceKeyPair, a fresh connection')
  peerKeyPair = loadOrCreatePeerKeyPair()
  storePeer = new Corestore(dirPeer)
  graphPeer = new Hypergraph(storePeer, { deviceKeyPair: peerKeyPair })
  await graphPeer.ready()
  t.teardown(async () => { await graphPeer.close(); await storePeer.close() })
  t.is(graphPeer.key.toString('hex'), peerIdentityKey, 'same identity restored after restart')

  await graphPeer.openUserCore(graphOwner.key)
  ctxPeer = await graphPeer.openContext(ctxKey, { writeMode: 'open' })

  s1 = storeOwner.replicate(true, { live: true })
  s2 = storePeer.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(() => { try { s1.destroy() } catch (err) { /* already closed */ }; try { s2.destroy() } catch (err) { /* already closed */ } })

  for (let i = 0; i < 30 && !ctxPeer.writable; i++) { await sleep(200); await ctxPeer.update() }
  t.ok(ctxPeer.writable, 'still recognized as a writer after restart, with no new addWriter() call needed')

  const restoredPost = await graphPeer.get(postBeforeRestart.id)
  t.ok(restoredPost, 'the peer sees its own pre-restart data after restart')

  console.log('  a new, post-restart write from the peer still syncs to the owner correctly')
  const postAfterRestart = await graphPeer.put({ type: 'post' })
  await graphPeer.relate({ from: postAfterRestart.id, to: postBeforeRestart.id, type: 'reply', context: ctxKey })

  let sawIt = false
  for (let i = 0; i < 30; i++) {
    await sleep(200)
    await graphOwner.update()
    const edges = []
    for await (const e of graphOwner.edges(postBeforeRestart.id, { direction: 'in', type: 'reply' })) edges.push(e)
    if (edges.length > 0) { sawIt = true; break }
  }
  t.ok(sawIt, 'the owner sees the peer\'s post-restart write correctly')
  console.log('TEST: restart and reconnect with a live peer - passed')
})
