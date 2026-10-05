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

// ── Several indexers (spec 005) ─────────────────────────────────────────────

const hexKey = (kp) => kp.publicKey.toString('hex')

// Owner + two members, each member's writer linked to the member, fully linked.
async function setupMembers (t, label) {
  const peers = []
  for (const name of ['owner', 'b', 'c']) peers.push({ name, ...(await createGraph(t, `${label}-${name}`)) })
  const links = []
  for (let i = 0; i < peers.length; i++) {
    for (let j = i + 1; j < peers.length; j++) links.push({ i, j, close: link(peers[i], peers[j]) })
  }
  t.teardown(() => { for (const l of links) l.close() })
  const [owner] = peers
  const ownerKp = owner.graph.identity.deviceKeyPair
  const ctx = await owner.graph.createContext()
  for (const p of peers) p.ctx = await p.graph.openContext(ctx)
  for (const p of peers.slice(1)) {
    await owner.ctx.addWriter(p.ctx.localKey, { keyPair: ownerKp, member: hexKey(p.graph.identity.deviceKeyPair) })
  }
  t.ok(await until(async () => {
    for (const p of peers) await p.graph.update()
    return peers.every(p => p.ctx.writable)
  }, 20000), 'every peer can write')
  return { peers, ctx, links, ownerKp }
}

async function indexersEverywhere (peers, expected) {
  for (const p of peers) await p.graph.update()
  const sets = await Promise.all(peers.map(async p => (await p.ctx.status()).indexers.slice().sort()))
  return sets.every(s => JSON.stringify(s) === JSON.stringify(expected.slice().sort()))
}

test('indexers: admins appointed by the owner index, and confirm while the owner is offline (spec 005)', { timeout: 180000 }, async (t) => {
  const { peers, ctx, links, ownerKp } = await setupMembers(t, 'idx-admins')
  const [owner, b, c] = peers

  await owner.ctx.setRole(hexKey(b.graph.identity.deviceKeyPair), 'admin', { keyPair: ownerKp })
  await owner.ctx.setRole(hexKey(c.graph.identity.deviceKeyPair), 'admin', { keyPair: ownerKp })
  const all = [owner.ctx.localKey, b.ctx.localKey, c.ctx.localKey].map(k => k.toString('hex'))
  t.ok(await until(() => indexersEverywhere(peers, all), 20000), 'owner and both admins index, on every peer')
  // A change of indexers takes effect once the current indexers (here the
  // owner alone) have confirmed it: only then do the admins act as indexers.
  t.ok(await until(async () => { for (const p of peers) await p.graph.update(); return b.ctx.base.isIndexer && c.ctx.base.isIndexer }, 20000), 'the admins act as indexers once the owner confirmed the change')

  // Owner goes offline; the admins keep writing and confirming.
  for (const l of links.filter(l => l.i === 0 || l.j === 0)) l.close()
  const dir = await writeFiles(b, ctx, 200)
  const applied = await until(async () => {
    await b.graph.update(); await c.graph.update()
    return (await c.graph.countEdgesIn(dir, 'in', { context: ctx })) === 200
  }, 30000)
  t.ok(applied, 'the admins apply each other\'s writes')
  // With several indexers the newest acknowledgements are always awaiting
  // the next round, so "confirmed === length" never holds; what matters is
  // that everything that existed when the writes were applied gets confirmed.
  const written = Math.max(b.ctx.base.length, c.ctx.base.length)
  const t0 = Date.now()
  t.ok(await until(async () => {
    await b.graph.update(); await c.graph.update()
    const [sb, sc] = [await b.ctx.status(), await c.ctx.status()]
    return sb.confirmedLength >= written && sc.confirmedLength >= written
  }, 10000), `everything written was confirmed by the two admins, ${Date.now() - t0} ms after it was applied`)
})

test('indexers: revoking a role demotes the member\'s writer, which keeps writing; a second device inherits the role (spec 005)', { timeout: 180000 }, async (t) => {
  const { peers, ctx, ownerKp } = await setupMembers(t, 'idx-revoke')
  const [owner, b, c] = peers
  const bKp = b.graph.identity.deviceKeyPair

  await owner.ctx.setRole(hexKey(bKp), 'admin', { keyPair: ownerKp })
  const withB = [owner.ctx.localKey, b.ctx.localKey].map(k => k.toString('hex'))
  t.ok(await until(() => indexersEverywhere(peers, withB), 20000), 'b indexes')

  // b's "second device": c's writer re-linked to b by a new context/writer.
  await owner.ctx.addWriter(c.ctx.localKey, { keyPair: ownerKp, member: hexKey(bKp) })
  const withBoth = [...withB, c.ctx.localKey.toString('hex')]
  t.ok(await until(() => indexersEverywhere(peers, withBoth), 20000), 'a device added later for b indexes too')

  await owner.ctx.removeRole(hexKey(bKp), { keyPair: ownerKp })
  t.ok(await until(() => indexersEverywhere(peers, [owner.ctx.localKey.toString('hex')]), 20000), 'revoked: only the owner indexes')
  const dir = await writeFiles(b, ctx, 10)
  t.ok(await until(async () => { await owner.graph.update(); return (await owner.graph.countEdgesIn(dir, 'in', { context: ctx })) === 10 }, 20000), 'b still writes')
})

test('indexers: the owner cannot give up its own ownership (the context would be left unmanaged) (spec 005)', async (t) => {
  const { graph } = await createGraph(t, 'idx-owner-self')
  const kp = graph.identity.deviceKeyPair
  const ctx = await graph.createContext()
  const context = await graph.openContext(ctx)
  await context.removeRole(hexKey(kp), { keyPair: kp })
  await context.setRole(hexKey(kp), 'member', { keyPair: kp })
  t.is((await context.roles()).members[hexKey(kp)], 'owner', 'still owner')
  t.alike((await context.status()).indexers, [context.localKey.toString('hex')], 'still the indexer')
})

test('indexers: concurrent role and writer changes from different members converge to identical tables and indexers (spec 005)', { timeout: 180000 }, async (t) => {
  const { peers, ctx, ownerKp } = await setupMembers(t, 'idx-concurrent')
  const [owner, b, c] = peers
  const bKp = b.graph.identity.deviceKeyPair
  await owner.ctx.setRole(hexKey(bKp), 'admin', { keyPair: ownerKp })
  await until(async () => { for (const p of peers) await p.graph.update(); return (await c.ctx.roles()).members[hexKey(bKp)] === 'admin' }, 20000)

  // At the same time: the owner revokes b, b makes c a mod, and c writes.
  const cKp = c.graph.identity.deviceKeyPair
  await Promise.all([
    owner.ctx.removeRole(hexKey(bKp), { keyPair: ownerKp }),
    b.ctx.setRole(hexKey(cKp), 'mod', { keyPair: bKp }),
    writeFiles(c, ctx, 20)
  ])

  t.ok(await until(async () => {
    for (const p of peers) await p.graph.update()
    const lengths = new Set(peers.map(p => p.ctx.base.length))
    return lengths.size === 1
  }, 30000), 'peers converged')
  await sleep(500)
  for (const p of peers) await p.graph.update()
  const tables = await Promise.all(peers.map(async p => JSON.stringify((await p.ctx.roles()).members)))
  t.is(new Set(tables).size, 1, `identical role tables everywhere: ${tables[0]}`)
  const idx = await Promise.all(peers.map(async p => JSON.stringify((await p.ctx.status()).indexers.slice().sort())))
  t.is(new Set(idx).size, 1, 'identical indexer sets everywhere')
})
