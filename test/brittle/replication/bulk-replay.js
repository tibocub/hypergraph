// How other peers replay bulk writes (spec 002, US2).
//
// In-memory replication (store.replicate piped to store.replicate), not the
// DHT: what is under test is replay and convergence, not the network, and
// this keeps it deterministic.

const test = require('brittle')
const crypto = require('hypercore-crypto')
const { createGraph, sleep } = require('../helpers')
const { stableRelationHash } = require('../../../src/utils')
const { encodeEvent } = require('../../../src/encodings/event')
const tuning = require('../../../src/tuning')

function replicatePair (a, b) {
  const s1 = a.store.replicate(true, { live: true })
  const s2 = b.store.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  return () => { s1.destroy(); s2.destroy() }
}

async function until (fn, ms = 60000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(50)
  }
  return false
}

async function edgesInto (graph, dirId, ctx) {
  const out = []
  for await (const e of graph.edges(dirId, { direction: 'in', type: 'in', context: ctx })) out.push(e.from)
  return out.sort()
}

test('bulk-replay: another peer replays a bulk-written context in one step per bulk call, to the same index', { timeout: 180000 }, async (t) => {
  const a = await createGraph(t, 'bulk-replay-a')
  const b = await createGraph(t, 'bulk-replay-b')
  const ctx = await a.graph.createContext()
  const aContext = await a.graph.openContext(ctx)

  const dir = await a.graph.put({ type: 'dir' })
  for (let call = 0; call < 3; call++) {
    const batch = a.graph.batch()
    for (let i = 0; i < 1000; i++) batch.relate({ from: batch.put({ type: 'file' }), to: dir.id, type: 'in', context: ctx })
    await batch.flush()
  }

  t.teardown(replicatePair(a, b))
  await b.graph.openUserCore(a.graph.key)
  await b.graph.openContext(ctx)

  t.ok(await until(async () => {
    await b.graph.update()
    return (await b.graph.countEdgesIn(dir.id, 'in', { context: ctx })) === 3000
  }), 'B indexed all 3,000 relations')

  t.alike(await edgesInto(b.graph, dir.id, ctx), await edgesInto(a.graph, dir.id, ctx), 'B has exactly A\'s edges')

  // The grouping travels with the oplog: B's copy of A's writer core holds
  // three batches of 1,000, which is what Autobase replays one apply call per.
  const batchStarts = []
  const { OplogMessage } = require('autobase/lib/messages.js')
  const oplog = b.store.get({ key: aContext.base.local.key, valueEncoding: OplogMessage })
  await oplog.ready()
  for (let i = 0; i < oplog.length; i++) {
    const { node } = await oplog.get(i)
    if (node.batch === 1000) batchStarts.push(i)
  }
  t.is(batchStarts.length, 3, 'three batches of 1,000 replicated to B')
  await oplog.close()
})

test('bulk-replay: a hostile writer\'s huge batch of forged, foreign and malformed events applies without crashing', { timeout: 180000 }, async (t) => {
  const saved = tuning.INDEX_BATCH
  tuning.INDEX_BATCH = 100
  t.teardown(() => { tuning.INDEX_BATCH = saved })

  const { graph } = await createGraph(t, 'bulk-hostile')
  const ctx = await graph.createContext()
  const context = await graph.openContext(ctx)
  const author = graph.key.toString('hex')
  const secretKey = graph.identity.deviceKeyPair.secretKey
  const stranger = crypto.keyPair()

  const dir = await graph.put({ type: 'dir' })
  const blocks = []
  let valid = 0
  for (let i = 0; i < 5000; i++) {
    const kind = i % 4
    const from = `file/${author}/${1000 + i}`
    const ev = { type: 'relation/create', from, to: dir.id, relationType: 'in', author, timestamp: 1791000000000 + i, signature: null }
    if (kind === 0) {
      ev.signature = crypto.sign(stableRelationHash(ev, ctx), secretKey).toString('hex')
      valid++
      blocks.push(encodeEvent(ev))
    } else if (kind === 1) {
      ev.signature = 'ab'.repeat(64) // forged signature
      blocks.push(encodeEvent(ev))
    } else if (kind === 2) {
      // validly signed by a stranger, but claiming `from` is ours
      ev.author = stranger.publicKey.toString('hex')
      ev.signature = crypto.sign(stableRelationHash(ev, ctx), stranger.secretKey).toString('hex')
      blocks.push(encodeEvent(ev))
    } else {
      blocks.push(Buffer.from([0xff, 0x00, 0x13, 0x37, i & 0xff])) // not an event at all
    }
  }

  // Straight into Autobase as one batch, the way a modified client could.
  await context.base.append(blocks)
  await context.base.update()
  await graph.update()

  t.is(await graph.countEdgesIn(dir.id, 'in', { context: ctx }), valid, `only the ${valid} genuine relations applied`)
  t.is((await edgesInto(graph, dir.id, ctx)).length, valid, 'and only they appear as edges')
})

test('bulk-replay: two writers flushing bulk batches concurrently converge to the same index', { timeout: 180000 }, async (t) => {
  const a = await createGraph(t, 'bulk-concurrent-a')
  const b = await createGraph(t, 'bulk-concurrent-b')
  t.teardown(replicatePair(a, b))

  const ctx = await a.graph.createContext()
  const aContext = await a.graph.openContext(ctx)
  const bContext = await b.graph.openContext(ctx)
  await aContext.addWriter(bContext.localKey)
  t.ok(await until(async () => { await b.graph.update(); return bContext.writable }), 'B became a writer')

  await a.graph.openUserCore(b.graph.key)
  await b.graph.openUserCore(a.graph.key)

  // A shared target that neither owns.
  const target = 'dir/shared'
  const fill = (graph) => {
    const batch = graph.batch()
    for (let i = 0; i < 300; i++) batch.relate({ from: batch.put({ type: 'file' }), to: target, type: 'in', context: ctx })
    return batch
  }
  await Promise.all([fill(a.graph).flush(), fill(b.graph).flush()])

  t.ok(await until(async () => {
    await a.graph.update()
    await b.graph.update()
    const ca = await a.graph.countEdgesIn(target, 'in', { context: ctx })
    const cb = await b.graph.countEdgesIn(target, 'in', { context: ctx })
    return ca === 600 && cb === 600
  }), 'both peers count all 600 relations')

  t.alike(await edgesInto(b.graph, target, ctx), await edgesInto(a.graph, target, ctx), 'and list the same edges')
})
