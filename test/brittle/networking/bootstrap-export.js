const test = require('brittle')
const { Hypergraph } = require('../../../index.js')
const { createGraph } = require('../helpers')

test('bootstrap-export: export() produces a bootstrap descriptor with contexts', async (t) => {
  console.log('TEST: export - starting')
  const { graph } = await createGraph(t, 'bootstrap-export-basic')

  console.log('  Step 1: create a context and some data to export')
  await graph.createContext({ writeMode: 'open' })
  const post = await graph.put({ type: 'post' })
  await graph.putContent(post.id, 'bootstrap test', 'text')

  console.log('  Step 2: export and verify shape')
  const bootstrap = await graph.export()
  t.ok(bootstrap, 'export returns data')
  t.ok(bootstrap.userCoreKey, 'bootstrap has a userCoreKey')
  t.ok(Array.isArray(bootstrap.contexts), 'bootstrap has a contexts array')
  t.ok(bootstrap.contexts.length > 0, 'bootstrap has at least one context')
  console.log('TEST: export - passed')
})

test('bootstrap-export: Hypergraph.join() recreates a graph that can open exported contexts', async (t) => {
  console.log('TEST: join - starting')
  const { graph: a } = await createGraph(t, 'bootstrap-join-a')

  console.log('  Step 1: create an open-mode context on peer A and export')
  const contextKey = await a.createContext({ writeMode: 'open' })
  const post = await a.put({ type: 'post' })
  await a.putContent(post.id, 'bootstrap test', 'text')
  const bootstrap = await a.export()

  console.log('  Step 2: join from a fresh store using the bootstrap descriptor')
  const Corestore = require('corestore')
  const os = require('os')
  const path = require('path')
  const fs = require('fs')
  const dirB = path.join(os.tmpdir(), `hypergraph-bootstrap-join-b-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dirB, { recursive: true })
  const storeB = new Corestore(dirB)
  const joined = await Hypergraph.join(storeB, bootstrap)
  t.ok(joined, 'join returns a graph instance')
  t.teardown(async () => {
    await joined.close()
    await storeB.close()
    fs.rmSync(dirB, { recursive: true, force: true })
  })

  console.log('  Step 3: verify the exported context opens with the correct write mode')
  const exportedContextKey = bootstrap.contexts[0].key
  t.is(exportedContextKey, contextKey, 'exported context key matches the one created on peer A')

  const joinedContext = await joined.openContext(exportedContextKey)
  t.ok(joinedContext, 'context opens from the bootstrap descriptor')
  t.is(joinedContext.writeMode, 'open', 'writeMode is preserved across export/join')
  console.log('TEST: join - passed')
})

test('bootstrap-export: export() with no contexts still returns a usable descriptor', async (t) => {
  console.log('TEST: export with no contexts - starting')
  const { graph } = await createGraph(t, 'bootstrap-export-empty')

  const bootstrap = await graph.export()
  t.ok(bootstrap, 'export returns data even with no contexts created')
  t.ok(bootstrap.userCoreKey, 'bootstrap still has a userCoreKey')
  t.alike(bootstrap.contexts, [], 'contexts array is empty when none were created')
  console.log('TEST: export with no contexts - passed')
})
