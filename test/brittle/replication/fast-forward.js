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
