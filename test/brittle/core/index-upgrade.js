// The global index's compact layout (spec 002, US3): a store written before it
// gets a fresh `graph-view/2` rebuilt from the logs, and the old core's space
// is released; content is read back from the author's own log.

const test = require('brittle')
const os = require('os')
const path = require('path')
const fs = require('fs')
const Corestore = require('corestore')
const hypercoreCrypto = require('hypercore-crypto')
const { Hypergraph } = require('../../../index.js')
const { createGraph } = require('../helpers')

function tmpDir (t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hg-${label}-`))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }))
  return dir
}

async function snapshot (graph) {
  const nodes = []
  for await (const n of graph.getByType('post')) nodes.push(n)
  const query = []
  for await (const n of graph.query().reverse()) query.push(n.id) // chronological, newest first
  const content = []
  for (const n of nodes) content.push(await graph.getContent(n.id))
  return { nodes, query, content, identity: await graph.getIdentity(graph.key.toString('hex')) }
}

test('index-upgrade: a store with an old `graph-view` core rebuilds the new index and frees the old one', { timeout: 120000 }, async (t) => {
  const dir = tmpDir(t, 'upgrade')
  const deviceKeyPair = hypercoreCrypto.keyPair()

  // A store as an older version left it: an index core named `graph-view`.
  let store = new Corestore(dir)
  const legacy = store.get({ name: 'graph-view' })
  await legacy.ready()
  const junk = []
  for (let i = 0; i < 2000; i++) junk.push(Buffer.alloc(200, 7))
  await legacy.append(junk)
  await legacy.close()

  let graph = new Hypergraph(store, { deviceKeyPair })
  await graph.ready()
  await graph.setIdentity({ username: 'tibo', bio: 'hi' })
  const a = await graph.put({ type: 'post' })
  await graph.putContent(a.id, 'first')
  await graph.putContent(a.id, 'second')
  const b = await graph.put({ type: 'post' })
  await graph.putContent(b.id, 'other')
  await graph.del((await graph.put({ type: 'post' })).id)
  const before = await snapshot(graph)
  await graph.close()
  await store.close()

  store = new Corestore(dir)
  const old = store.get({ name: 'graph-view' })
  await old.ready()
  t.is(old.length, 0, 'the old index core was emptied')
  await old.close()

  // Wipe the new index too, so this open must rebuild it from the logs.
  const fresh = store.get({ name: 'graph-view/2' })
  await fresh.ready()
  await fresh.truncate(0)
  await fresh.close()

  graph = new Hypergraph(store, { deviceKeyPair })
  await graph.ready()
  await graph.update()
  const after = await snapshot(graph)
  t.alike(after, before, 'every query answers the same after the rebuild')
  t.is(before.nodes.length, 2, 'the deleted entity stays deleted')
  t.is(before.content[0].body, 'second', 'the latest content version wins')
  t.is(before.identity.username, 'tibo')
  await graph.close()
  await store.close()
})

test('index-upgrade: content versions sort by number, not text, past 10 revisions', async (t) => {
  const { graph } = await createGraph(t, 'upgrade-versions')
  const post = await graph.put({ type: 'post' })
  for (let i = 0; i < 12; i++) await graph.putContent(post.id, `v${i}`)
  t.is((await graph.getContent(post.id)).body, 'v11')
})

test('index-upgrade: content whose block is no longer held reads as null, without throwing', async (t) => {
  const { graph } = await createGraph(t, 'upgrade-missing-block')
  const post = await graph.put({ type: 'post' })
  await graph.putContent(post.id, 'gone soon')
  const seq = graph.core.length - 1
  await graph.core.clear(seq, seq + 1)
  t.is(await graph.getContent(post.id), null)
  t.ok(await graph.get(post.id), 'the entity itself is still there')
})

test('index-upgrade: ids that are not derived ids are simply not found', async (t) => {
  const { graph } = await createGraph(t, 'upgrade-odd-ids')
  for (const id of ['post/does-not-exist', '', `post/${'AB'.repeat(32)}/0`, `post/${'ab'.repeat(32)}/01`]) {
    t.is(await graph.view.getNode(id), null, JSON.stringify(id.slice(0, 16)))
    t.is(await graph.view.getContent(id), null)
  }
  t.is(await graph.getIdentity('not-a-key'), null)
})
