// References over a real Hyperswarm connection.
//
// NOTE ON NETWORK DEPENDENCY: joins the real public DHT via Hyperswarm.
// Cannot be verified without real network access.
//
// NEVER add process.exit() to this file. test:replication glob-matches and
// runs every file in ONE brittle process — a force-exit here silently kills
// sibling files' still-running tests before they report. Slow-but-correct
// beats fast-but-truncates-siblings. (Confirmed the hard way; see CLAUDE.md.)
//
// FINDING THAT RESHAPED THIS FILE: spec 001 (FR-012) anticipated "two peers
// concurrently store different references for one entity, and they converge."
// That scenario cannot occur. src/view.js #applyContentAppend enforces that
// content may only be appended under the entity's OWN author's core:
//
//     if (authorFromEntityId(event.entityId) !== coreKeyHex) return
//
// So concurrent references for one entity are impossible by construction —
// every content version for an entity comes from a single core, which is
// totally ordered, making convergence trivial rather than contested. The
// interesting property is the security one underneath it, which test 2 below
// covers: a peer forging a reference for someone else's entity is ignored.

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { createGraph, sleep, destroySwarm, testSwarm } = require('../helpers')
const { CONTENT_LINK_TYPE } = require('../../../src/content-ref.js')

const REF = {
  src: ['swarmfs://9f2ca1b3'],
  size: 2147483648,
  type: 'video/mp4',
  mutable: false
}

async function connect (t, a, b) {
  // Each side must register the other's user core with its view before
  // replicating — a raw store.get() replicates bytes but never makes the data
  // visible to graph.get()/getContent(). See concurrent-writes.js.
  await a.graph.openUserCore(b.graph.key)
  await b.graph.openUserCore(a.graph.key)

  const topic = a.graph.discoveryKey

  const swarmA = await testSwarm(t)
  swarmA.on('connection', (conn) => a.store.replicate(conn))
  const discA = swarmA.join(topic, { server: true, client: true })
  await discA.flushed()

  const swarmB = await testSwarm(t)
  swarmB.on('connection', (conn) => b.store.replicate(conn))
  const discB = swarmB.join(topic, { server: true, client: true })
  await discB.flushed()

  t.teardown(async () => {
    await destroySwarm(swarmA)
    await destroySwarm(swarmB)
  })

  return { swarmA, swarmB }
}

test('content-ref-replication: a reference survives replication intact (needs real network)', { timeout: 180000 }, async (t) => {
  const a = await createGraph(t, 'crr-a')
  const b = await createGraph(t, 'crr-b')

  await connect(t, a, b)

  const video = await a.graph.put({ type: 'video' })
  await a.graph.putContentRef(video.id, {
    ...REF,
    src: ['swarmfs://9f2ca1b3', 'https://gateway.example/9f2ca1b3'],
    digest: 'blake3:9f2ca1b3'
  })

  // Give replication time to carry the event across.
  for (let i = 0; i < 30; i++) {
    await b.graph.update()
    const record = await b.graph.getContent(video.id)
    if (record) break
    await sleep(500)
  }

  const record = await b.graph.getContent(video.id)

  t.ok(record, 'the far peer sees the content record')
  t.is(record.contentType, CONTENT_LINK_TYPE, 'still marked as a link')
  t.ok(record.reference, 'parsed on the far side too')
  t.ok(record.reference.valid, 'and it is valid')
  t.is(record.reference.src.length, 2, 'both addresses crossed')
  t.is(record.reference.src[0].address, 'swarmfs://9f2ca1b3', 'preference order preserved')
  t.is(record.reference.src[1].scheme, 'https', 'fallback preserved')
  t.is(record.reference.size, 2147483648, 'declared size preserved')
  t.is(record.reference.type, 'video/mp4', 'declared type preserved')
  t.is(record.reference.mutable, false, 'mutability preserved')
  t.is(record.reference.digest, 'blake3:9f2ca1b3', 'digest preserved')
})

test('content-ref-replication: a peer cannot forge a reference for another peer\'s entity (needs real network)', { timeout: 180000 }, async (t) => {
  const a = await createGraph(t, 'crr-forge-a')
  const b = await createGraph(t, 'crr-forge-b')

  await connect(t, a, b)

  // A owns the entity and publishes the genuine reference.
  const video = await a.graph.put({ type: 'video' })
  await a.graph.putContentRef(video.id, { ...REF, src: ['swarmfs://genuine'] })

  for (let i = 0; i < 30; i++) {
    await b.graph.update()
    if (await b.graph.getContent(video.id)) break
    await sleep(500)
  }

  t.ok(await b.graph.getContent(video.id), 'B replicated A\'s genuine reference')

  // B now tries to redirect A's entity at content B controls. The append
  // succeeds locally on B's own core — nothing stops a peer writing whatever
  // it likes to its own core — but apply must ignore it, because the entity's
  // id does not belong to B.
  await b.graph.putContentRef(video.id, { ...REF, src: ['swarmfs://malicious'] })
  await b.graph.update()

  const onB = await b.graph.getContent(video.id)
  t.is(onB.reference.src[0].address, 'swarmfs://genuine',
    'B\'s own view still shows the genuine reference, not its forgery')

  // And the forgery must not travel back to A either.
  for (let i = 0; i < 10; i++) {
    await a.graph.update()
    await sleep(300)
  }

  const onA = await a.graph.getContent(video.id)
  t.is(onA.reference.src[0].address, 'swarmfs://genuine',
    'A is unaffected by the forgery attempt')
})

test('content-ref-replication: a malformed payload from a peer does not break replication (needs real network)', { timeout: 180000 }, async (t) => {
  const a = await createGraph(t, 'crr-bad-a')
  const b = await createGraph(t, 'crr-bad-b')

  await connect(t, a, b)

  // A writes a deliberately malformed reference payload, bypassing
  // putContentRef's validation exactly as a hostile or buggy peer would.
  const broken = await a.graph.put({ type: 'video' })
  await a.graph.putContent(broken.id, '{not json at all', CONTENT_LINK_TYPE)

  // ...and then a perfectly good record afterwards. The good one must still
  // arrive: one bad payload must not stall apply or poison the view.
  const fine = await a.graph.put({ type: 'post' })
  await a.graph.putContent(fine.id, 'this must still replicate', 'text')

  for (let i = 0; i < 30; i++) {
    await b.graph.update()
    if (await b.graph.getContent(fine.id)) break
    await sleep(500)
  }

  const good = await b.graph.getContent(fine.id)
  t.ok(good, 'replication continued past the malformed record')
  t.is(good.body, 'this must still replicate', 'later content arrived intact')

  let bad
  await t.execution(async () => { bad = await b.graph.getContent(broken.id) },
    'reading the malformed record does not throw on the far side')

  t.ok(bad, 'the malformed record is still returned')
  t.is(bad.reference.valid, false, 'reported invalid rather than dropped')
  t.ok(typeof bad.reference.error === 'string', 'with an explanation')
  t.is(bad.body, '{not json at all', 'raw payload preserved for diagnosis')
})
