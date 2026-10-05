// Version 2 contexts: the creator indexes, other writers don't, acks are on —
// so shared contexts actually reach a confirmed state (spec 003, US1).
//
// In-memory replication (store.replicate piped to store.replicate): what is
// under test is confirmation and convergence, not the network.

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

// Creator + two writers, fully linked; returns the peers with their contexts.
async function setup (t, label) {
  const peers = []
  for (const name of ['creator', 'w1', 'w2']) peers.push({ name, ...(await createGraph(t, `${label}-${name}`)) })
  const links = []
  for (let i = 0; i < peers.length; i++) {
    for (let j = i + 1; j < peers.length; j++) links.push({ i, j, close: link(peers[i], peers[j]) })
  }
  t.teardown(() => { for (const l of links) l.close() })

  const ctx = await peers[0].graph.createContext()
  for (const p of peers) p.ctx = await p.graph.openContext(ctx)
  for (const p of peers.slice(1)) await peers[0].ctx.addWriter(p.ctx.localKey)
  t.ok(await until(async () => {
    for (const p of peers) await p.graph.update()
    return peers.every(p => p.ctx.writable)
  }, 20000), 'every peer can write')
  for (const p of peers) for (const q of peers) if (p !== q) await p.graph.openUserCore(q.graph.key)
  return { peers, ctx, links }
}

async function writeFiles (p, ctx, n) {
  const batch = p.graph.batch()
  const dir = batch.put({ type: 'dir' })
  for (let i = 0; i < n; i++) batch.relate({ from: batch.put({ type: 'file' }), to: dir, type: 'in', context: ctx })
  await batch.flush()
  return dir.id
}

async function confirmedEverywhere (peers) {
  for (const p of peers) await p.graph.update()
  const statuses = await Promise.all(peers.map(p => p.ctx.status()))
  return statuses.every(s => s.length > 0 && s.confirmedLength === s.length) &&
    statuses.every(s => s.length === statuses[0].length)
}

test('indexers: three writers write concurrently; within 10 s of stopping, everything is confirmed on every peer', { timeout: 180000 }, async (t) => {
  const { peers, ctx } = await setup(t, 'idx-confirm')

  const dirs = await Promise.all(peers.map(p => writeFiles(p, ctx, 1000)))

  // Everyone has everything (applied)...
  t.ok(await until(async () => {
    for (const p of peers) await p.graph.update()
    for (const p of peers) {
      for (const d of dirs) if (await p.graph.countEdgesIn(d, 'in', { context: ctx }) !== 1000) return false
    }
    return true
  }, 60000), 'all 3,000 relations applied on every peer')
  const applied = Date.now()

  // ...and it becomes confirmed, within 10 s (SC-003).
  const confirmed = await until(() => confirmedEverywhere(peers), 10000)
  t.ok(confirmed, `everything is confirmed on every peer, ${Date.now() - applied} ms after it was all applied`)

  const indexers = (await peers[0].ctx.status()).indexers
  t.alike(indexers, [peers[0].ctx.localKey.toString('hex')], 'the creator is the only indexer')
})

test('indexers: with the creator offline, writers keep writing and see each other; confirmed once it is back', { timeout: 180000 }, async (t) => {
  const { peers, ctx, links } = await setup(t, 'idx-offline')
  const [creator, w1, w2] = peers

  // Take the creator offline.
  for (const l of links.filter(l => l.i === 0 || l.j === 0)) l.close()

  const d1 = await writeFiles(w1, ctx, 100)
  const d2 = await writeFiles(w2, ctx, 100)
  t.ok(await until(async () => {
    await w1.graph.update(); await w2.graph.update()
    return (await w1.graph.countEdgesIn(d2, 'in', { context: ctx })) === 100 &&
      (await w2.graph.countEdgesIn(d1, 'in', { context: ctx })) === 100
  }, 30000), 'writers apply each other\'s relations without the creator')

  const before = await w1.ctx.status()
  t.ok(before.confirmedLength < before.length, 'not confirmed while the only indexer is away')

  // Creator comes back.
  t.teardown(link(creator, w1))
  t.teardown(link(creator, w2))
  t.ok(await until(() => confirmedEverywhere(peers), 30000), 'confirmed once the creator is back')
  t.is(await creator.graph.countEdgesIn(d1, 'in', { context: ctx }), 100, 'the creator has w1\'s relations')
})
