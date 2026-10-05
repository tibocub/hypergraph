// Context index layouts (spec 002, US3): the compact layout answers every
// query exactly like the text layout, and a context's layout is fixed by its
// own record.

const test = require('brittle')
const os = require('os')
const path = require('path')
const fs = require('fs')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const { layout1, layout2 } = require('../../../src/index-layout/context')
const { createGraph, sleep } = require('../helpers')

const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)

async function bee (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-layout-'))
  const store = new Corestore(dir)
  const core = store.get({ name: 'view' })
  const db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' }) // as a context view
  await db.ready()
  t.teardown(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }) })
  return db
}

const collect = async (it) => { const out = []; for await (const x of it) out.push(x); return out }

// The same operations through one layout; everything they can be asked.
async function run (layout, db) {
  const post = `post/${A}/3`
  const post2 = `post/${A}/4` // seq order and text order agree; see the numeric-order test
  const reply = `reply/${B}/0`
  const odd = 'not-an-entity:with/odd:chars'

  const w = db.batch()
  await layout.addEdge(w, { from: reply, to: post, type: 'reply', author: B, createdAt: 1000 })
  await layout.addEdge(w, { from: reply, to: post2, type: 'reply', author: B, createdAt: 1000, value: 0.5 })
  await layout.addEdge(w, { from: post, to: odd, type: 'link', author: A, createdAt: 2000, data: '{"size":12}' })
  await layout.addEdge(w, { from: post2, to: post, type: 'reply', author: A, createdAt: 900 })
  await layout.putCount(w, 'in', post, 'reply', 2)
  await layout.putCount(w, 'out', reply, 'reply', 2)
  await layout.addTag(w, { tag: 'featured', entityId: post, author: A, createdAt: 5 })
  await layout.addTag(w, { tag: 'featured', entityId: post2, author: B, createdAt: 4 })
  await layout.addTag(w, { tag: 'feat', entityId: odd, author: 'not hex', createdAt: 6 })
  // Reads inside the batch see its own writes.
  const inBatch = await layout.activeEdge(w, reply, 'reply', post)
  await w.flush()

  const before = {
    inBatch,
    out: await collect(layout.edges(db, reply)),
    outTyped: await collect(layout.edges(db, post, { type: 'link' })),
    outWrongType: await collect(layout.edges(db, post, { type: 'lin' })),
    in: await collect(layout.edges(db, post, { direction: 'in' })),
    inReverseLimit: await collect(layout.edges(db, post, { direction: 'in', reverse: true, limit: 1 })),
    active: await layout.activeEdge(db, post, 'link', odd),
    counts: [await layout.getCount(db, 'in', post, 'reply'), await layout.getCount(db, 'out', reply, 'reply'), await layout.getCount(db, 'in', odd, 'x')],
    tagged: await collect(layout.tagged(db, 'featured')),
    taggedPrefixOnly: await collect(layout.tagged(db, 'feat')),
    allTags: await collect(layout.tagged(db, null)),
    hasTag: [await layout.hasTag(db, post, 'featured'), await layout.hasTag(db, post, 'feat'), await layout.hasTag(db, odd, 'feat')]
  }

  await layout.removeEdge(db, reply, 'reply', 1000, post)
  await layout.removeTag(db, 'featured', post, A)
  await layout.putCount(db, 'in', post, 'reply', 1)

  const after = {
    out: await collect(layout.edges(db, reply)),
    in: await collect(layout.edges(db, post, { direction: 'in' })),
    active: await layout.activeEdge(db, reply, 'reply', post),
    count: await layout.getCount(db, 'in', post, 'reply'),
    tagged: await collect(layout.tagged(db, 'featured')),
    hasTag: await layout.hasTag(db, post, 'featured')
  }
  return { before, after }
}

test('index-layout: layout 2 answers every index query exactly like layout 1', async (t) => {
  const r1 = await run(layout1, await bee(t))
  const r2 = await run(layout2, await bee(t))
  t.alike(r2, r1, 'identical results')

  // And the results are the right ones, not just equal.
  t.is(r1.before.out.length, 2, 'two outgoing edges')
  t.is(r1.before.out[1].value, 0.5, 'edge value kept')
  t.is(r1.before.outTyped[0].data, '{"size":12}', 'edge data kept')
  t.is(r1.before.outTyped[0].to, 'not-an-entity:with/odd:chars', 'odd target ids round-trip')
  t.is(r1.before.outWrongType.length, 0, 'a type prefix is not a type')
  t.alike(r1.before.in.map(e => e.createdAt), [900, 1000], 'incoming, oldest first')
  t.is(r1.before.inReverseLimit[0].createdAt, 1000, 'reverse + limit')
  t.alike(r1.before.counts, [2, 2, 0])
  t.is(r1.before.tagged.length, 2, 'two tagged')
  t.is(r1.before.taggedPrefixOnly.length, 1, 'a tag prefix is not a tag')
  t.is(r1.before.allTags.length, 3)
  t.alike(r1.before.hasTag, [true, false, true])
  t.ok(r1.after.out.find(e => e.to.startsWith('post/') && e.deleted), 'removed edge is marked deleted')
  t.is(r1.after.in.length, 1, 'and gone from incoming')
  t.is(r1.after.active, null, 'and no longer active')
  t.absent(r1.after.hasTag, 'removed tag is gone')
})

test('index-layout: layout 2 orders entity seqs as numbers (layout 1 ordered them as text)', async (t) => {
  const order = async (layout) => {
    const db = await bee(t)
    for (const seq of [10, 9, 3]) await layout.addEdge(db, { from: `reply/${B}/0`, to: `post/${A}/${seq}`, type: 'reply', author: B, createdAt: 1000 })
    return (await collect(layout.edges(db, `reply/${B}/0`))).map(e => e.to.split('/')[2])
  }
  t.alike(await order(layout2), ['3', '9', '10'], 'layout 2: by number')
  t.alike(await order(layout1), ['10', '3', '9'], 'layout 1: by text (kept as it was)')
})

test('index-layout: layout 2 entries take a fraction of layout 1\'s bytes', async (t) => {
  const size = async (layout) => {
    const db = await bee(t)
    const w = db.batch()
    for (let i = 0; i < 200; i++) {
      await layout.addEdge(w, { from: `folder/${A}/${i % 7}`, to: `file/${B}/${i}`, type: 'contains', author: A, createdAt: 1791000000000 + i })
      await layout.putCount(w, 'out', `folder/${A}/${i % 7}`, 'contains', i)
      await layout.putCount(w, 'in', `file/${B}/${i}`, 'contains', 1)
    }
    await w.flush()
    let bytes = 0
    for await (const e of db.createReadStream({}, { keyEncoding: 'binary', valueEncoding: 'binary' })) bytes += e.key.length + e.value.length
    return bytes
  }
  const one = await size(layout1)
  const two = await size(layout2)
  t.ok(two < one / 2.5, `layout 2 ${two} B vs layout 1 ${one} B`)
})

test('index-layout: new contexts use layout 2; a context without a layout record keeps layout 1, also after conversion', async (t) => {
  const ContextBase = require('../../../src/context-base.js')
  const a = await createGraph(t, 'layout-ctx-a')
  const b = await createGraph(t, 'layout-ctx-b')
  const s1 = a.store.replicate(true, { live: true })
  const s2 = b.store.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(() => { s1.destroy(); s2.destroy() })

  const fresh = await a.graph.openContext(await a.graph.createContext())
  t.is((await fresh.status()).layout, 2, 'a new context: layout 2')
  const rolebase = await a.graph.openContext(await a.graph.createContext({ roles: 'rolebase' }))
  t.is((await rolebase.status()).layout, 2, 'a new RoleBase context: layout 2')

  // A context created before layouts existed: no context/init at all.
  const legacy = new ContextBase(a.store, null, {})
  await legacy.ready()
  t.teardown(() => legacy.close())
  const legacyKey = legacy.key.toString('hex')
  const bLegacy = await b.graph.openContext(legacyKey)
  await legacy.addWriter(bLegacy.localKey)
  for (let i = 0; i < 200 && !bLegacy.writable; i++) { await legacy.update(); await b.graph.update(); await sleep(50) }
  t.ok(bLegacy.writable, 'b writes in the legacy context')
  t.is((await bLegacy.status()).layout, 1, 'legacy context: layout 1')

  // The same writes in both kinds of context read back the same way.
  const bFresh = await b.graph.createContext()
  const answers = []
  for (const ctx of [legacyKey, bFresh]) {
    const p = await b.graph.put({ type: 'post' })
    const r = await b.graph.put({ type: 'reply' })
    await b.graph.relate({ from: r.id, to: p.id, type: 'reply', context: ctx })
    await b.graph.relate({ from: r.id, to: p.id, type: 'like', context: ctx })
    await b.graph.unrelate({ from: r.id, to: p.id, type: 'like', context: ctx })
    await b.graph.tag(p.id, 'hot', { context: ctx })
    await b.graph.update()
    const ins = await collect(b.graph.edges(p.id, { direction: 'in', context: ctx }))
    answers.push({
      in: ins.map(e => [e.type, e.from === r.id]),
      out: (await collect(b.graph.edges(r.id, { context: ctx }))).map(e => e.type),
      replies: await b.graph.countEdgesIn(p.id, 'reply', { context: ctx }),
      likes: await b.graph.countEdgesIn(p.id, 'like', { context: ctx }),
      hot: await b.graph.view.hasTag(p.id, 'hot', { context: ctx }),
      tagged: (await collect(b.graph.getByTag('hot', { context: ctx }))).map(n => n.id === p.id)
    })
  }
  t.alike(answers[1], answers[0], 'layout 2 answers like layout 1')
  t.alike(answers[0], { in: [['reply', true]], out: ['reply'], replies: 1, likes: 0, hot: true, tagged: [true] }, 'and the answers are right')

  await legacy.upgrade({ keyPair: a.graph.identity.deviceKeyPair })
  for (let i = 0; i < 200 && (await bLegacy.status()).version !== 3; i++) { await legacy.update(); await b.graph.update(); await sleep(50) }
  const status = await bLegacy.status()
  t.is(status.version, 3, 'converted to version 3')
  t.is(status.layout, 1, 'still layout 1: its index entries were written that way')
})
