// graph.batch(): many entities, contents and relations in one call.
// Contract: specs/002-scale-indexing/contracts/bulk-write.md

const test = require('brittle')
const { createGraph } = require('../helpers')

const REF = (i) => ({
  src: [`swarmwire://${String(i).padStart(64, '0')}`],
  size: 1000 + i,
  type: 'application/octet-stream',
  mutable: false
})

async function setupScopedGraph (t, label) {
  const { graph } = await createGraph(t, label)
  const owner = graph.identity.deviceKeyPair.publicKey.toString('hex')
  await graph.createRoleBase()
  await graph.roleBase.init(owner)
  await graph.roleBase.append({ type: 'roles/setRolePermissions', role: 'owner', permissions: ['*'], author: owner, timestamp: Date.now() })
  await graph.update()
  await graph.createScopeBase()
  const { scopeId } = await graph.scopeBase.createScope('bulk')
  return { graph, scopeId }
}

// Everything observable about a set of entities, minus timestamps (which
// necessarily differ between two writes).
async function snapshot (graph, ctx, dirId, fileIds) {
  const files = []
  for (const id of fileIds) {
    const node = await graph.get(id)
    const content = await graph.getContent(id)
    const out = []
    for await (const e of graph.edges(id, { direction: 'out', context: ctx })) out.push(e.type)
    files.push({
      type: node.type,
      author: node.author,
      contentType: content.contentType,
      body: content.body,
      encrypted: !!content.encrypted,
      reference: content.reference ? { valid: content.reference.valid, size: content.reference.size, src: content.reference.src.map(s => s.address) } : null,
      out,
      countOut: await graph.countEdgesOut(id, 'in', { context: ctx })
    })
  }
  const into = []
  for await (const e of graph.edges(dirId, { direction: 'in', type: 'in', context: ctx })) into.push(fileIds.indexOf(e.from))
  return { files, into, countIn: await graph.countEdgesIn(dirId, 'in', { context: ctx }) }
}

test('bulk-write: a batch reads back exactly like the same writes made one at a time', async (t) => {
  const { graph, scopeId } = await setupScopedGraph(t, 'bulk-equivalence')
  const single = await graph.createContext()
  const bulk = await graph.createContext()

  // One at a time.
  const sDir = await graph.put({ type: 'dir' })
  const sFiles = []
  for (let i = 0; i < 50; i++) {
    const f = await graph.put({ type: 'file' })
    if (i % 3 === 0) await graph.putContent(f.id, `inline ${i}`, 'text')
    else if (i % 3 === 1) await graph.putContentRef(f.id, REF(i))
    else await graph.putContent(f.id, `secret ${i}`, 'text', { scope: scopeId })
    await graph.relate({ from: f.id, to: sDir.id, type: 'in', context: single })
    sFiles.push(f.id)
  }

  // The same, in one batch.
  const b = graph.batch()
  const bDir = b.put({ type: 'dir' })
  const bRefs = []
  for (let i = 0; i < 50; i++) {
    const f = b.put({ type: 'file' })
    if (i % 3 === 0) b.putContent(f, `inline ${i}`, 'text')
    else if (i % 3 === 1) b.putContentRef(f, REF(i))
    else b.putContent(f, `secret ${i}`, 'text', { scope: scopeId })
    b.relate({ from: f, to: bDir, type: 'in', context: bulk })
    bRefs.push(f)
  }
  const result = await b.flush()

  t.is(result.entities.length, 51, 'flush() reports every entity it created')
  t.alike(result.written, { userCore: true, contexts: [bulk] }, 'flush() reports what it wrote')

  const expected = await snapshot(graph, single, sDir.id, sFiles)
  const actual = await snapshot(graph, bulk, bDir.id, bRefs.map(r => r.id))
  t.alike(actual, expected, 'entities, contents (inline, reference, encrypted), edges and counts all match')

  let files = 0
  for await (const node of graph.getByType('file')) if (node) files++
  t.is(files, 100, 'getByType sees both sets')
})

test('bulk-write: refs resolve within the batch; ids come back in put() order', async (t) => {
  const { graph } = await createGraph(t, 'bulk-refs')
  const ctx = await graph.createContext()

  const b = graph.batch()
  const a = b.put({ type: 'a' })
  const c = b.put({ type: 'c' })
  t.exception(() => a.id, /not flushed/, 'a ref has no id before flush')
  b.relate({ from: c, to: a, type: 'points', context: ctx })
  b.putContentRef(c, REF(1))
  const { entities } = await b.flush()

  t.is(entities[0].id, a.id, 'first entity is the first put()')
  t.is(entities[1].id, c.id, 'second entity is the second put()')
  t.is(entities[0].type, 'a')
  t.ok(a.id.startsWith('a/'), 'ids keep the <type>/<author>/<seq> shape')
  t.is((await graph.get(c.id)).type, 'c', 'the entity exists under that id')

  const edges = []
  for await (const e of graph.edges(a.id, { direction: 'in', context: ctx })) edges.push(e.from)
  t.alike(edges, [c.id], 'the relation resolved both refs')
  t.ok((await graph.getContent(c.id)).reference.valid, 'the reference attached to the ref')

  const other = graph.batch()
  t.exception(() => other.relate({ from: a, to: a, type: 'x', context: ctx }), /another batch/, 'a ref from another batch is rejected')
})

test('bulk-write: one invalid operation rejects the whole batch and writes nothing', async (t) => {
  const { graph } = await createGraph(t, 'bulk-invalid')
  const ctx = await graph.createContext()
  const context = await graph.openContext(ctx)

  t.exception(() => graph.batch().putContentRef('x', { src: [] }), /src/, 'a malformed reference throws at the call')
  t.exception(() => graph.batch().relate({ from: 'a', to: 'b', type: 't' }), /context/, 'a relation without a context throws at the call')
  t.exception(() => graph.batch().put({ type: 'x', id: 'nope' }), /id must NOT be provided/, 'a caller-chosen id throws at the call')

  const cases = [
    ['unknown entity', (b) => { b.put({ type: 'file' }); b.putContent('file/' + 'f'.repeat(64) + '/9', 'x') }, /Entity not found/],
    ['unknown scope', (b) => { const f = b.put({ type: 'file' }); b.putContent(f, 'x', 'text', { scope: 'nope' }) }, /ScopeBase|scope/i]
  ]
  for (const [name, fill, error] of cases) {
    const userLen = graph.core.length
    const ctxLen = context.base.local.length
    const b = graph.batch()
    fill(b)
    b.relate({ from: 'file/' + graph.key.toString('hex') + '/0', to: 'x', type: 'in', context: ctx })
    await t.exception(b.flush(), error, `${name}: flush() rejects`)
    t.is(graph.core.length, userLen, `${name}: nothing written to the user core`)
    t.is(context.base.local.length, ctxLen, `${name}: nothing written to the context`)
  }

  const b = graph.batch()
  b.put({ type: 'file' })
  await b.flush()
  await t.exception(b.flush(), /already flushed/, 'a batch flushes once')
})

test('bulk-write: a context failure after the user core was written reports exactly what exists', async (t) => {
  const { graph } = await createGraph(t, 'bulk-partial')
  const good = await graph.createContext()
  const bad = await graph.createContext()
  const badContext = await graph.openContext(bad)
  badContext.appendBatch = async () => { throw new Error('disk full') }

  const b = graph.batch()
  const dir = b.put({ type: 'dir' })
  const f = b.put({ type: 'file' })
  b.relate({ from: f, to: dir, type: 'in', context: good })
  b.relate({ from: f, to: dir, type: 'in', context: bad })

  const err = await b.flush().catch(e => e)
  t.is(err.name, 'BulkWriteError', 'a BulkWriteError is thrown')
  t.ok(/disk full/.test(err.message), 'it carries the cause')
  t.is(err.written.userCore, true, 'the user core was written')
  t.alike(err.written.contexts, [good], 'only the context that succeeded is listed')
  t.alike(err.entities.map(e => e.id), [dir.id, f.id], 'the entities that now exist are listed')
  t.ok(await graph.get(f.id), 'and they really exist')
})

test('bulk-write: works the same in open and closed contexts', async (t) => {
  const { graph } = await createGraph(t, 'bulk-modes')
  for (const writeMode of ['open', 'closed']) {
    const ctx = await graph.createContext({ writeMode })
    await graph.openContext(ctx, { writeMode })
    const b = graph.batch()
    const dir = b.put({ type: 'dir' })
    for (let i = 0; i < 10; i++) b.relate({ from: b.put({ type: 'file' }), to: dir, type: 'in', context: ctx })
    await b.flush()
    t.is(await graph.countEdgesIn(dir.id, 'in', { context: ctx }), 10, `${writeMode}: every relation applied`)
  }
})

test('bulk-write: a batch is written as one user-core append and one append per context', async (t) => {
  const { graph } = await createGraph(t, 'bulk-grouping')
  const ctx = await graph.createContext()
  const context = await graph.openContext(ctx)

  let coreAppends = 0
  const append = graph.core.append.bind(graph.core)
  graph.core.append = (...args) => { coreAppends++; return append(...args) }

  const start = context.base.local.length
  const b = graph.batch()
  const dir = b.put({ type: 'dir' })
  for (let i = 0; i < 200; i++) {
    const f = b.put({ type: 'file' })
    b.putContentRef(f, REF(i))
    b.relate({ from: f, to: dir, type: 'in', context: ctx })
  }
  await b.flush()

  t.is(coreAppends, 1, 'one append to the user core for 401 events')
  t.is((await context.base.local.get(start)).node.batch, 200, 'the 200 relations are one Autobase batch')
})

test('bulk-write: single-item methods are unchanged', async (t) => {
  const { graph } = await createGraph(t, 'bulk-single-unchanged')
  const ctx = await graph.createContext()
  const post = await graph.put({ type: 'post' })
  t.alike(Object.keys(post).sort(), ['author', 'id', 'type'], 'put() returns the same shape')
  t.ok(await graph.get(post.id), 'put() resolves once indexed')
  const written = await graph.putContent(post.id, 'hi')
  t.is(written.body, 'hi', 'putContent() returns what was written')
  const rel = await graph.relate({ from: post.id, to: post.id, type: 'self', context: ctx })
  t.is(rel.type, 'relation/create', 'relate() returns the signed event')
  t.is(await graph.countEdgesOut(post.id, 'self', { context: ctx }), 1, 'and it is indexed when relate() resolves')
})
