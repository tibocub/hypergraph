// Joining a context by fast-forward: adopt the indexers' signed state
// instead of replaying history (spec 003, US2).
//
// In-memory replication, so it is deterministic.

const test = require('brittle')
const { createGraph, sleep } = require('../helpers')

function link (a, b) {
  const s1 = a.store.replicate(true, { live: true })
  const s2 = b.store.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  return () => { s1.destroy(); s2.destroy() }
}

async function until (fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(100)
  }
  return false
}

async function listing (graph, dirId, ctx) {
  const out = []
  for await (const e of graph.edges(dirId, { direction: 'in', type: 'in', context: ctx })) out.push(e.from)
  return out
}

// A writer with `calls` bulk calls of `per` files each, spread over `dirs`
// folders. Many bulk calls = many Autobase nodes, so a newcomer is far enough
// behind for Autobase to fast-forward it (it does at >= 16 nodes).
async function bigContext (t, label, { calls = 40, per = 500, dirs = 4 } = {}) {
  const writer = await createGraph(t, `${label}-writer`)
  const ctx = await writer.graph.createContext()
  const dirIds = []
  for (let d = 0; d < dirs; d++) dirIds.push((await writer.graph.put({ type: 'dir' })).id)
  for (let c = 0; c < calls; c++) {
    const batch = writer.graph.batch()
    for (let i = 0; i < per; i++) batch.relate({ from: batch.put({ type: 'file' }), to: dirIds[(c * per + i) % dirs], type: 'in', context: ctx })
    await batch.flush()
  }
  // Let the creator's acks confirm everything before anyone joins.
  const context = await writer.graph.openContext(ctx)
  await until(async () => { await writer.graph.update(); const s = await context.status(); return s.confirmedLength === s.length }, 20000)
  return { writer, ctx, dirIds, total: calls * per }
}

test('fast-forward: a fresh peer adopts the signed state instead of replaying, and lists the same folders', { timeout: 300000 }, async (t) => {
  const { writer, ctx, dirIds, total } = await bigContext(t, 'ff-join')
  const newcomer = await createGraph(t, 'ff-join-newcomer')
  t.teardown(link(writer, newcomer))

  const started = Date.now()
  const context = await newcomer.graph.openContext(ctx)
  t.ok(await until(async () => {
    await newcomer.graph.update()
    return (await newcomer.graph.countEdgesIn(dirIds[0], 'in', { context: ctx })) === total / dirIds.length
  }, 60000), 'the first folder is complete on the newcomer')
  const joinMs = Date.now() - started

  const status = await context.status()
  t.ok(status.fastForwards >= 1, `the newcomer fast-forwarded (join took ${joinMs} ms)`)
  t.is(status.isIndexer, false, 'and does not index')

  t.alike(await listing(newcomer.graph, dirIds[0], ctx), await listing(writer.graph, dirIds[0], ctx), 'same listing as the writer')

  const view = context.view.core
  let held = 0
  for (let i = 0; i < view.length; i++) if (await view.has(i)) held++
  t.ok(held < view.length / 2, `holds ${held} of ${view.length} index blocks after reading one folder`)

  // It keeps up with what happens after it joined.
  const late = await writer.graph.put({ type: 'file' })
  await writer.graph.relate({ from: late.id, to: dirIds[1], type: 'in', context: ctx })
  t.ok(await until(async () => {
    await newcomer.graph.update()
    return (await newcomer.graph.countEdgesIn(dirIds[1], 'in', { context: ctx })) === total / dirIds.length + 1
  }, 30000), 'applies a relation written after it joined')
})

test('fast-forward: fastForward: false replays everything and ends with the same index', { timeout: 300000 }, async (t) => {
  const { writer, ctx, dirIds, total } = await bigContext(t, 'ff-off', { calls: 20, per: 200 })
  const replayer = await createGraph(t, 'ff-off-replayer')
  t.teardown(link(writer, replayer))

  const context = await replayer.graph.openContext(ctx, { fastForward: false })
  t.ok(await until(async () => {
    await replayer.graph.update()
    for (const d of dirIds) if ((await replayer.graph.countEdgesIn(d, 'in', { context: ctx })) !== total / dirIds.length) return false
    return true
  }, 60000), 'every folder complete')
  t.is((await context.status()).fastForwards, 0, 'it never fast-forwarded')
  for (const d of dirIds) t.alike(await listing(replayer.graph, d, ctx), await listing(writer.graph, d, ctx), 'same listing')
})

test('fast-forward: events breaking the context\'s rules are absent on replaying and fast-forwarding peers alike', { timeout: 300000 }, async (t) => {
  const crypto = require('hypercore-crypto')
  const { stableRelationHash } = require('../../../src/utils')

  const writer = await createGraph(t, 'ff-rules-writer')
  const locked = await writer.graph.put({ type: 'dir' })
  const open = await writer.graph.put({ type: 'dir' })
  const rules = { id: 'locks/v1', validate: (e) => !(e.type === 'relation/create' && e.to === locked.id) }
  const ctx = await writer.graph.createContext({ rules })
  const context = await writer.graph.openContext(ctx, { rules })
  const author = writer.graph.key.toString('hex')
  const secretKey = writer.graph.identity.deviceKeyPair.secretKey

  // Enough separate writes for a newcomer to be fast-forwarded, each mixing
  // accepted relations with raw ones a modified client would send.
  for (let c = 0; c < 30; c++) {
    const batch = writer.graph.batch()
    const files = []
    for (let i = 0; i < 20; i++) { const f = batch.put({ type: 'file' }); files.push(f); batch.relate({ from: f, to: open.id, type: 'in', context: ctx }) }
    await batch.flush()
    const raw = files.slice(0, 5).map((f) => {
      const ev = { type: 'relation/create', from: f.id, to: locked.id, relationType: 'in', author, timestamp: Date.now(), signature: null }
      ev.signature = crypto.sign(stableRelationHash(ev, ctx), secretKey).toString('hex')
      return ev
    })
    await context.appendBatch(raw)
  }
  await until(async () => { await writer.graph.update(); const s = await context.status(); return s.confirmedLength === s.length }, 20000)
  t.is(await writer.graph.countEdgesIn(locked.id, 'in', { context: ctx }), 0, 'the writer itself never indexed them')

  for (const [label, opts] of [['fast-forwarding', {}], ['replaying', { fastForward: false }]]) {
    const peer = await createGraph(t, `ff-rules-${opts.fastForward === false ? 'replay' : 'ff'}`)
    t.teardown(link(writer, peer))
    const c = await peer.graph.openContext(ctx, { rules, ...opts })
    t.ok(await until(async () => {
      await peer.graph.update()
      return (await peer.graph.countEdgesIn(open.id, 'in', { context: ctx })) === 600
    }, 60000), `${label} peer has every accepted relation`)
    t.is(await peer.graph.countEdgesIn(locked.id, 'in', { context: ctx }), 0, `${label} peer has none of the rejected ones`)
    const into = []
    for await (const e of peer.graph.edges(locked.id, { direction: 'in', context: ctx })) into.push(e)
    t.is(into.length, 0, `${label} peer lists nothing in the locked folder`)
    if (opts.fastForward !== false) t.ok((await c.status()).fastForwards >= 1, 'and it did fast-forward')
  }
})

test('fast-forward: a peer that opens only the context lists folders with every entry\'s data, never touching the authors\' logs (spec 004)', { timeout: 300000 }, async (t) => {
  const writer = await createGraph(t, 'ff-data-writer')
  const ctx = await writer.graph.createContext()
  const dir = await writer.graph.put({ type: 'dir' })
  for (let c = 0; c < 30; c++) {
    const batch = writer.graph.batch()
    for (let i = 0; i < 100; i++) {
      const n = c * 100 + i
      batch.relate({ from: batch.put({ type: 'file' }), to: dir.id, type: 'in', context: ctx, data: JSON.stringify({ name: `file-${n}.bin`, size: n }) })
    }
    await batch.flush()
  }
  const wctx = await writer.graph.openContext(ctx)
  await until(async () => { await writer.graph.update(); const s = await wctx.status(); return s.confirmedLength === s.length }, 20000)

  const reader = await createGraph(t, 'ff-data-reader')
  t.teardown(link(writer, reader))
  const context = await reader.graph.openContext(ctx) // and nothing else: no openUserCore()
  t.ok(await until(async () => {
    await reader.graph.update()
    return (await reader.graph.countEdgesIn(dir.id, 'in', { context: ctx })) === 3000
  }, 60000), 'the folder is complete')

  const entries = []
  for await (const e of reader.graph.edges(dir.id, { direction: 'in', type: 'in', context: ctx })) entries.push(JSON.parse(e.data))
  t.is(entries.length, 3000, 'every entry listed')
  t.ok(entries.every(d => typeof d.name === 'string' && typeof d.size === 'number'), 'each with its data')
  t.ok((await context.status()).fastForwards >= 1, 'joined by fast-forward')

  const writerLog = reader.store.get({ key: writer.graph.key })
  await writerLog.ready()
  t.is(writerLog.contiguousLength, 0, 'none of the writer\'s log was downloaded')
  await writerLog.close()
})
