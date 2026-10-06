// What a peer has shown stays readable offline after a restart.
//
// A newcomer that fast-forwarded holds only the index blocks it read. Before
// the fix, reading a channel first looked up the context's record (for its
// index layout) at the latest view version; after the view had grown, that
// lookup's path was no longer local, so with no peer the read waited forever,
// although the page itself was held (bench/chat.js at 30k-1M messages).

const test = require('brittle')
const path = require('path')
const Corestore = require('corestore')
const { Hypergraph } = require('../../../index.js')
const { createGraph, sleep } = require('../helpers')

async function page (graph, ctx, channel) {
  const out = []
  for await (const e of graph.edges(channel, { direction: 'in', type: 'msg', context: ctx, reverse: true, limit: 50 })) out.push(e)
  return out
}

async function write (graph, ctx, channel, from, to, size = 1000) {
  for (let s = from; s < to; s += size) {
    const b = graph.batch()
    for (let i = s; i < Math.min(to, s + size); i++) b.relate({ from: b.put({ type: 'msg' }), to: channel, type: 'msg', context: ctx, data: `m${i}` })
    await b.flush()
  }
}

test('offline-reopen: the latest page a newcomer showed loads again offline after a restart', { timeout: 300000 }, async (t) => {
  const owner = await createGraph(t, 'offline-owner')
  const ctx = await owner.graph.createContext()
  const octx = await owner.graph.openContext(ctx)
  const channel = (await owner.graph.put({ type: 'channel' })).id
  const confirmed = async () => { while (octx.view.core.signedLength < octx.view.core.length) { await owner.graph.update(); await sleep(50) } }
  await write(owner.graph, ctx, channel, 0, 2000, 250)
  await confirmed()

  const dir = path.join(owner.dir, '..', path.basename(owner.dir) + '-newcomer')
  t.teardown(() => require('fs').rmSync(dir, { recursive: true, force: true, maxRetries: 10 }))
  let store = new Corestore(dir)
  let graph = new Hypergraph(store)
  await graph.ready()
  const nctx = await graph.openContext(ctx)
  const connect = () => {
    const s1 = owner.graph.replicate(true)
    const s2 = graph.replicate(false)
    s1.pipe(s2).pipe(s1)
    return () => { s1.destroy(); s2.destroy() }
  }
  const showLatest = async (last) => {
    let shown = []
    for (let i = 0; i < 600; i++) {
      shown = await page(graph, ctx, channel).catch(() => [])
      if (shown[0] && shown[0].data === last) break
      await sleep(25)
    }
    return shown
  }

  // Join and read: the context's record is looked up at this early version.
  let disconnect = connect()
  t.is((await showLatest('m1999')).length, 50, 'the newcomer shows the latest page')
  disconnect()

  // The channel grows a lot while the newcomer is away; back online, it
  // fast-forwards and shows the new latest page.
  await write(owner.graph, ctx, channel, 2000, 14000, 250)
  await confirmed()
  disconnect = connect()
  const shown = await showLatest('m13999')
  t.is(shown.length, 50, 'and the new latest page')
  t.ok(nctx.view.core.contiguousLength < nctx.view.core.length, 'holding only part of the index')
  disconnect()
  await graph.close(); await store.close()

  // Restart with no peer at all.
  store = new Corestore(dir)
  graph = new Hypergraph(store)
  await graph.ready()
  await graph.openContext(ctx)
  const again = await Promise.race([page(graph, ctx, channel), sleep(5000).then(() => null)])
  t.ok(again, 'the page loads offline (not stuck waiting for a peer)')
  t.alike(again && again.map(e => e.from), shown.map(e => e.from), 'and it is the same page')
  await graph.close(); await store.close()
})
