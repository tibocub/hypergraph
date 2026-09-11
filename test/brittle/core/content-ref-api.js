/**
 * test/brittle/core/content-ref-api.js
 *
 * Tests for putContentRef() / getContent() against a real Hypergraph instance.
 *
 * Run: npx brittle test/brittle/core/content-ref-api.js
 */

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { createGraph } = require('../helpers.js')
const { CONTENT_LINK_TYPE } = require('../../../src/content-ref.js')

const REF = {
  src: ['swarmfs://9f2ca1b3'],
  size: 2147483648,
  type: 'video/mp4',
  mutable: false
}

/** Total bytes on disk under a directory, recursively. */
function dirSize (dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else {
      try { total += fs.statSync(full).size } catch { /* raced with a write */ }
    }
  }
  return total
}

// ── US1: store and read back ─────────────────────────────────────────────────

test('content-ref-api: putContentRef stores a reference readable by getContent', async t => {
  const { graph } = await createGraph(t, 'cra-basic')

  const entity = await graph.put({ type: 'video' })
  const written = await graph.putContentRef(entity.id, REF)

  t.is(written.contentType, CONTENT_LINK_TYPE, 'returns the link marker')
  t.is(written.entityId, entity.id, 'returns the entity id')
  t.ok(written.reference.valid, 'returns the parsed reference it wrote')

  const record = await graph.getContent(entity.id)

  t.is(record.contentType, CONTENT_LINK_TYPE, 'stored with the link marker')
  t.ok(record.reference, 'getContent surfaces a reference field')
  t.ok(record.reference.valid, 'the reference is valid')
  t.is(record.reference.src[0].address, 'swarmfs://9f2ca1b3', 'address preserved')
  t.is(record.reference.src[0].scheme, 'swarmfs', 'scheme extracted')
  t.is(record.reference.size, 2147483648, 'declared size preserved')
  t.is(record.reference.type, 'video/mp4', 'declared media type preserved')
  t.is(record.reference.mutable, false, 'mutability preserved')
  t.ok(typeof record.body === 'string', 'raw payload still available')
})

test('content-ref-api: inline content is untouched and gets no reference field', async t => {
  const { graph } = await createGraph(t, 'cra-inline')

  const entity = await graph.put({ type: 'post' })
  await graph.putContent(entity.id, 'hello world', 'text')

  const record = await graph.getContent(entity.id)

  t.is(record.body, 'hello world', 'inline content reads back unchanged')
  t.is(record.contentType, 'text', 'content type unchanged')
  t.absent(record.reference, 'no reference field on inline content')
})

// ── US1 / SC-001: a reference costs the graph almost nothing ─────────────────

test('content-ref-api: storage cost is independent of referenced content size', async t => {
  const { graph, dir } = await createGraph(t, 'cra-size')

  const a = await graph.put({ type: 'video' })
  const b = await graph.put({ type: 'video' })
  await graph.update()

  const before = dirSize(dir)

  // 2 GB
  await graph.putContentRef(a.id, { ...REF, size: 2147483648 })
  await graph.update()
  const afterSmallClaim = dirSize(dir)

  // 20 GB — ten times the declared content, same shape of address
  await graph.putContentRef(b.id, { ...REF, size: 21474836480 })
  await graph.update()
  const afterLargeClaim = dirSize(dir)

  const growth1 = afterSmallClaim - before
  const growth2 = afterLargeClaim - afterSmallClaim

  t.ok(growth1 < 100 * 1024, `2GB reference grew storage by ${growth1} bytes, far below its content`)
  t.ok(growth2 < 100 * 1024, `20GB reference grew storage by ${growth2} bytes`)
  t.ok(
    Math.abs(growth1 - growth2) < 64 * 1024,
    `growth is independent of declared size (${growth1} vs ${growth2})`
  )
})

// ── US1: write-time validation ───────────────────────────────────────────────

test('content-ref-api: putContentRef rejects a malformed reference and writes nothing', async t => {
  const { graph } = await createGraph(t, 'cra-reject')

  const entity = await graph.put({ type: 'video' })

  await t.exception(
    () => graph.putContentRef(entity.id, { ...REF, src: [] }),
    'throws on empty src'
  )
  await t.exception(
    () => graph.putContentRef(entity.id, { ...REF, src: ['not a uri'] }),
    'throws on an address with no scheme'
  )
  await t.exception(
    () => graph.putContentRef(entity.id, { ...REF, size: -1 }),
    'throws on negative size'
  )
  await t.exception(
    () => graph.putContentRef(entity.id, { ...REF, mutable: 'yes' }),
    'throws on non-boolean mutable'
  )

  const record = await graph.getContent(entity.id)
  t.is(record, null, 'nothing was appended by any rejected write')
})

// ── US1: read-time tolerance ─────────────────────────────────────────────────

test('content-ref-api: a malformed payload reads back invalid, never throws', async t => {
  const { graph } = await createGraph(t, 'cra-malformed')

  const entity = await graph.put({ type: 'video' })

  // Bypass putContentRef, exactly as a hostile or buggy peer would.
  await graph.putContent(entity.id, '{not json at all', CONTENT_LINK_TYPE)

  let record
  await t.execution(async () => { record = await graph.getContent(entity.id) },
    'getContent does not throw on a malformed payload')

  t.ok(record, 'a record is still returned')
  t.ok(record.reference, 'a reference field is still present')
  t.is(record.reference.valid, false, 'reported invalid')
  t.ok(typeof record.reference.error === 'string', 'explains why')
  t.is(record.body, '{not json at all', 'raw payload preserved for diagnosis')
  t.ok(Array.isArray(record.reference.src), 'src is still iterable')
})

// ── US2: uniform addressing across backends ──────────────────────────────────

test('content-ref-api: one code path resolves every backend, branching only on scheme', async t => {
  const { graph } = await createGraph(t, 'cra-uniform')

  const addresses = [
    'swarmfs://9f2ca1b3',
    'hyper://abc123',
    'https://example.com/file.zip',
    'hypergraph://video/a3f9c2/7'
  ]

  const ids = []
  for (const address of addresses) {
    const entity = await graph.put({ type: 'media' })
    await graph.putContentRef(entity.id, { ...REF, src: [address] })
    ids.push(entity.id)
  }

  // A consumer's loop: switch on scheme, nothing else.
  const seen = []
  for (const id of ids) {
    const record = await graph.getContent(id)
    t.ok(record.reference.valid, `resolved ${record.reference.src[0].address}`)
    seen.push(record.reference.src[0].scheme)
  }

  t.alike(seen, ['swarmfs', 'hyper', 'https', 'hypergraph'], 'every scheme surfaced correctly')
})

test('content-ref-api: an unknown scheme is well-formed, not an error', async t => {
  const { graph } = await createGraph(t, 'cra-unknown')

  const entity = await graph.put({ type: 'media' })
  await graph.putContentRef(entity.id, { ...REF, src: ['somefuturebackend://abc'] })

  const record = await graph.getContent(entity.id)

  t.ok(record.reference.valid, 'well-formed despite nobody knowing the scheme')
  t.is(record.reference.src[0].scheme, 'somefuturebackend',
    'scheme reported so a consumer can say exactly what it lacked')
})

test('content-ref-api: preference order is preserved so a consumer can fall back', async t => {
  const { graph } = await createGraph(t, 'cra-order')

  const entity = await graph.put({ type: 'media' })
  await graph.putContentRef(entity.id, {
    ...REF,
    src: ['somefuturebackend://abc', 'swarmfs://9f2ca1b3']
  })

  const record = await graph.getContent(entity.id)
  const supported = new Set(['swarmfs', 'https'])

  t.is(record.reference.src.length, 2, 'both addresses kept')
  t.is(record.reference.src[0].scheme, 'somefuturebackend', 'unsupported entry stays first')

  const chosen = record.reference.src.find(s => supported.has(s.scheme))
  t.is(chosen.address, 'swarmfs://9f2ca1b3', 'a consumer skips to the entry it supports')
})

// ── US3: stable address while content changes ────────────────────────────────

test('content-ref-api: replacing a reference keeps the entity id, relations and tags', async t => {
  const { graph } = await createGraph(t, 'cra-stable')

  const ctx = await graph.createContext()
  const video = await graph.put({ type: 'video' })
  const post = await graph.put({ type: 'post' })

  await graph.putContentRef(video.id, { ...REF, src: ['swarmfs://original'] })
  await graph.tag(video.id, 'sub:films', { context: ctx })
  await graph.relate({ from: video.id, to: post.id, type: 'attachment', context: ctx })

  // The file is edited, so its hash changes — a whole new address.
  await graph.putContentRef(video.id, { ...REF, src: ['swarmfs://edited'] })

  const record = await graph.getContent(video.id)
  t.is(record.reference.src[0].address, 'swarmfs://edited', 'newest reference wins')

  const tagged = []
  for await (const node of graph.getByTag('sub:films')) tagged.push(node)
  t.is(tagged.length, 1, 'the tag still resolves')
  t.is(tagged[0].id, video.id, 'to the same entity id')

  const edges = []
  for await (const edge of graph.edges(post.id, { type: 'attachment', direction: 'in' })) {
    edges.push(edge)
  }
  t.is(edges.length, 1, 'the relation still resolves')
  t.is(edges[0].from, video.id, 'from the same entity id')
})

test('content-ref-api: an entity can switch between reference and inline content', async t => {
  const { graph } = await createGraph(t, 'cra-switch')

  const entity = await graph.put({ type: 'note' })

  await graph.putContentRef(entity.id, { ...REF, src: ['swarmfs://big'] })
  let record = await graph.getContent(entity.id)
  t.is(record.contentType, CONTENT_LINK_TYPE, 'starts as a reference')
  t.ok(record.reference.valid)

  await graph.putContent(entity.id, 'now it is small enough to inline', 'text')
  record = await graph.getContent(entity.id)
  t.is(record.contentType, 'text', 'switched to inline')
  t.absent(record.reference, 'no reference field once inline')
  t.is(record.body, 'now it is small enough to inline')

  await graph.putContentRef(entity.id, { ...REF, src: ['swarmfs://big-again'] })
  record = await graph.getContent(entity.id)
  t.is(record.contentType, CONTENT_LINK_TYPE, 'and back to a reference')
  t.is(record.reference.src[0].address, 'swarmfs://big-again')
})

// ── SC-003: no backend-specific code ─────────────────────────────────────────

test('content-ref-api: hypergraph gained no backend-specific behavior', async t => {
  const { graph } = await createGraph(t, 'cra-agnostic')

  // A scheme invented in this test must behave identically to swarmfs://.
  // If hypergraph ever special-cases a backend, this diverges.
  const a = await graph.put({ type: 'media' })
  const b = await graph.put({ type: 'media' })

  await graph.putContentRef(a.id, { ...REF, src: ['swarmfs://x'] })
  await graph.putContentRef(b.id, { ...REF, src: ['zzz-invented://x'] })

  const ra = await graph.getContent(a.id)
  const rb = await graph.getContent(b.id)

  t.is(ra.reference.valid, rb.reference.valid, 'both equally valid')
  t.is(ra.reference.size, rb.reference.size, 'both carry declared metadata identically')
  t.is(ra.reference.src.length, rb.reference.src.length, 'treated the same way')
})
