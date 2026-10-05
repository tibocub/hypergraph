// App rules: deterministic checks an app attaches to a context, run in apply,
// rejecting events before they are indexed (spec 003, US3).
// Contract: specs/003-fast-forward-contexts/contracts/api.md

const test = require('brittle')
const crypto = require('hypercore-crypto')
const { createGraph, sleep } = require('../helpers')
const { stableRelationHash } = require('../../../src/utils')

async function until (fn, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(50)
  }
  return false
}

test('context-rules: a rejected event is not indexed, whichever way it was written', async (t) => {
  const { graph } = await createGraph(t, 'rules-reject')
  const locked = await graph.put({ type: 'dir' })
  const open = await graph.put({ type: 'dir' })
  const rules = {
    id: 'locks/v1',
    validate: (event) => !(event.type === 'relation/create' && event.to === locked.id)
  }
  const ctx = await graph.createContext({ rules })
  const context = await graph.openContext(ctx, { rules })

  // Through relate().
  const f1 = await graph.put({ type: 'file' })
  await graph.relate({ from: f1.id, to: locked.id, type: 'in', context: ctx })
  await graph.relate({ from: f1.id, to: open.id, type: 'in', context: ctx })

  // Through graph.batch().
  const b = graph.batch()
  for (let i = 0; i < 5; i++) {
    const f = b.put({ type: 'file' })
    b.relate({ from: f, to: locked.id, type: 'in', context: ctx })
    b.relate({ from: f, to: open.id, type: 'in', context: ctx })
  }
  await b.flush()

  // Straight into the context, as a modified client could.
  const author = graph.key.toString('hex')
  const f2 = await graph.put({ type: 'file' })
  const raw = { type: 'relation/create', from: f2.id, to: locked.id, relationType: 'in', author, timestamp: Date.now(), signature: null }
  raw.signature = crypto.sign(stableRelationHash(raw, ctx), graph.identity.deviceKeyPair.secretKey).toString('hex')
  await context.appendBatch([raw])
  await graph.update()

  t.is(await graph.countEdgesIn(locked.id, 'in', { context: ctx }), 0, 'nothing reached the locked folder')
  const into = []
  for await (const e of graph.edges(locked.id, { direction: 'in', context: ctx })) into.push(e)
  t.is(into.length, 0, 'no edge indexed')
  t.is(await graph.countEdgesIn(open.id, 'in', { context: ctx }), 6, 'accepted relations are indexed')
  t.is(await graph.countEdgesOut(f1.id, 'in', { context: ctx }), 1, 'counts ignore rejected relations')
  t.is((await context.status()).rules, 'locks/v1', 'the rules id is recorded')
})

test('context-rules: a rule can read the index as it was just before the event, including earlier events of the same batch', async (t) => {
  const { graph } = await createGraph(t, 'rules-reader')
  // "A file is in at most one folder."
  const rules = {
    id: 'one-folder/v1',
    async validate (event, reader) {
      if (event.type !== 'relation/create' || event.relationType !== 'in') return true
      const out = await reader.edges(event.from, { direction: 'out', type: 'in' })
      return out.length === 0
    }
  }
  const ctx = await graph.createContext({ rules })
  await graph.openContext(ctx, { rules })
  const d1 = await graph.put({ type: 'dir' })
  const d2 = await graph.put({ type: 'dir' })

  const b = graph.batch()
  const f = b.put({ type: 'file' })
  b.relate({ from: f, to: d1.id, type: 'in', context: ctx })
  b.relate({ from: f, to: d2.id, type: 'in', context: ctx }) // same batch: must see the first
  await b.flush()

  t.is(await graph.countEdgesIn(d1.id, 'in', { context: ctx }), 1, 'first placement accepted')
  t.is(await graph.countEdgesIn(d2.id, 'in', { context: ctx }), 0, 'second placement rejected, though written in the same batch')

  const g = await graph.put({ type: 'file' })
  await graph.relate({ from: g.id, to: d2.id, type: 'in', context: ctx })
  t.is(await graph.countEdgesIn(d2.id, 'in', { context: ctx }), 1, 'another file can go there')
})

test('context-rules: the reader answers hasEdge, counts and hasTag', async (t) => {
  const { graph } = await createGraph(t, 'rules-reader-api')
  const seen = []
  const rules = {
    id: 'probe/v1',
    async validate (event, reader) {
      if (event.type === 'message') {
        seen.push({
          hasEdge: await reader.hasEdge(event.text, 'in', event.username),
          countIn: await reader.countIn(event.username, 'in'),
          countOut: await reader.countOut(event.text, 'in'),
          hasTag: await reader.hasTag(event.text, 'blue')
        })
      }
      return true
    }
  }
  const ctx = await graph.createContext({ rules })
  const context = await graph.openContext(ctx, { rules })
  const dir = await graph.put({ type: 'dir' })
  const file = await graph.put({ type: 'file' })
  await graph.relate({ from: file.id, to: dir.id, type: 'in', context: ctx })
  await graph.tag(file.id, 'blue', { context: ctx })
  await context.append({ type: 'message', text: file.id, username: dir.id, author: graph.key.toString('hex'), timestamp: Date.now() })
  await graph.update()

  t.alike(seen, [{ hasEdge: true, countIn: 1, countOut: 1, hasTag: true }], 'reader sees the edge, its counts and the tag')
})

test('context-rules: a rule that throws or returns anything but true rejects, and apply carries on', async (t) => {
  const { graph } = await createGraph(t, 'rules-throw')
  const rules = {
    id: 'flaky/v1',
    validate (event) {
      if (event.type !== 'relation/create') return true
      if (event.relationType === 'boom') throw new Error('rule bug')
      if (event.relationType === 'maybe') return 'yes'
      if (event.relationType === 'async-boom') return Promise.reject(new Error('async rule bug'))
      return true
    }
  }
  const ctx = await graph.createContext({ rules })
  await graph.openContext(ctx, { rules })
  const a = await graph.put({ type: 'x' })
  const b = await graph.put({ type: 'x' })

  for (const type of ['boom', 'maybe', 'async-boom', 'fine']) await graph.relate({ from: a.id, to: b.id, type, context: ctx })

  for (const type of ['boom', 'maybe', 'async-boom']) t.is(await graph.countEdgesIn(b.id, type, { context: ctx }), 0, `${type}: rejected`)
  t.is(await graph.countEdgesIn(b.id, 'fine', { context: ctx }), 1, 'later events still apply')
})

test('context-rules: a context without rules behaves exactly as before', async (t) => {
  const { graph } = await createGraph(t, 'rules-none')
  const ctx = await graph.createContext()
  const context = await graph.openContext(ctx)
  const a = await graph.put({ type: 'x' })
  await graph.relate({ from: a.id, to: a.id, type: 'self', context: ctx })
  t.is(await graph.countEdgesIn(a.id, 'self', { context: ctx }), 1)
  t.is((await context.status()).rules, '')
})

test('context-rules: a peer with different rules is refused, not silently diverging', async (t) => {
  const a = await createGraph(t, 'rules-mismatch-a')
  const b = await createGraph(t, 'rules-mismatch-b')
  const s1 = a.store.replicate(true, { live: true })
  const s2 = b.store.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(() => { s1.destroy(); s2.destroy() })

  const rules = { id: 'swarmfs/v1', validate: () => true }
  const ctx = await a.graph.createContext({ rules })
  const aCtx = await a.graph.openContext(ctx, { rules })
  const x = await a.graph.put({ type: 'x' })
  await a.graph.relate({ from: x.id, to: x.id, type: 'self', context: ctx })

  let reported = null
  try {
    const bCtx = await b.graph.openContext(ctx, { rules: { id: 'swarmfs/v2', validate: () => true } })
    await until(async () => {
      await b.graph.update().catch(() => {})
      reported = (await bCtx.status()).interrupted
      return !!reported
    })
  } catch (err) {
    reported = err.message
  }
  t.ok(reported && /rules mismatch/i.test(reported), `mismatch reported: ${reported}`)
  t.ok(/swarmfs\/v1/.test(reported) && /swarmfs\/v2/.test(reported), 'naming both ids')
  t.is((await aCtx.status()).interrupted, null, 'the creator is unaffected')
})

test('context-rules: a context recorded with an unknown version is refused', async (t) => {
  const ContextBase = require('../../../src/context-base.js')
  const { store } = await createGraph(t, 'rules-version')
  const context = new ContextBase(store, null, {})
  await context.ready()
  t.teardown(() => context.close())
  await t.exception(
    context.append({ type: 'context/init', version: 99, rules: '', timestamp: Date.now() }),
    /unsupported context version 99/,
    'the append that brought the record reports why the context stopped'
  )
  const { interrupted } = await context.status()
  t.ok(interrupted && /unsupported context version 99/.test(interrupted), `status says so too: ${interrupted}`)
  await t.exception(context.append({ type: 'message', text: 'x', username: 'u', author: 'a', timestamp: 1 }), /unsupported context version 99/, 'and later appends are refused with the same reason')
})

test('context-rules: rules see relation data — "names are unique in a folder" (spec 004)', async (t) => {
  const { graph } = await createGraph(t, 'rules-data')
  const nameOf = (data) => { try { return JSON.parse(data).name } catch { return null } }
  const rules = {
    id: 'unique-names/v1',
    async validate (event, reader) {
      if (event.type !== 'relation/create' || event.relationType !== 'in') return true
      const name = nameOf(event.data)
      if (typeof name !== 'string' || name.length === 0) return false
      const siblings = await reader.edges(event.to, { direction: 'in', type: 'in' })
      return !siblings.some(e => nameOf(e.data) === name)
    }
  }
  const ctx = await graph.createContext({ rules })
  await graph.openContext(ctx, { rules })
  const dir = await graph.put({ type: 'dir' })

  const b = graph.batch()
  for (const name of ['a.txt', 'b.txt', 'a.txt']) b.relate({ from: b.put({ type: 'file' }), to: dir.id, type: 'in', context: ctx, data: JSON.stringify({ name }) })
  b.relate({ from: b.put({ type: 'file' }), to: dir.id, type: 'in', context: ctx }) // no data: no name
  await b.flush()

  const names = []
  for await (const e of graph.edges(dir.id, { direction: 'in', type: 'in', context: ctx })) names.push(nameOf(e.data))
  t.alike(names.sort(), ['a.txt', 'b.txt'], 'the duplicate and the nameless entry were rejected')
})
