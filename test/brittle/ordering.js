const test = require('brittle')
const Corestore = require('corestore')
const { Hypergraph } = require('../../index.js')
const os = require('os')
const path = require('path')
const fs = require('fs')
const crypto = require('hypercore-crypto')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('hypergraph: edge ordering + limit (in/out)', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `hypergraph-test-ordering-${process.pid}-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const store = new Corestore(tmpDir)
  const graph = new Hypergraph(store)
  await graph.ready()

  t.teardown(async () => {
    await graph.close()
    await store.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const author = graph.identity.deviceKeyPair.publicKey.toString('hex')
  const ctx = await graph.createContext()

  const post = await graph.put({ type: 'post' })
  const c1 = await graph.put({ type: 'comment' })
  const c2 = await graph.put({ type: 'comment' })
  const c3 = await graph.put({ type: 'comment' })

  await graph.relate({ from: c1.id, to: post.id, type: 'reply', context: ctx })
  await sleep(2)
  await graph.relate({ from: c2.id, to: post.id, type: 'reply', context: ctx })
  await sleep(2)
  await graph.relate({ from: c3.id, to: post.id, type: 'reply', context: ctx })

  const inAsc = []
  for await (const e of graph.edges(post.id, { direction: 'in', type: 'reply', order: 'asc' })) inAsc.push(e)
  t.is(inAsc.length, 3)
  t.ok(inAsc[0].createdAt <= inAsc[1].createdAt)
  t.ok(inAsc[1].createdAt <= inAsc[2].createdAt)

  const inDescLimit2 = []
  for await (const e of graph.edges(post.id, { direction: 'in', type: 'reply', order: 'desc', limit: 2 })) inDescLimit2.push(e)
  t.is(inDescLimit2.length, 2)
  t.ok(inDescLimit2[0].createdAt >= inDescLimit2[1].createdAt)
  t.is(inDescLimit2[0].from, c3.id)

  const outDescLimit1 = []
  for await (const e of graph.edges(c1.id, { direction: 'out', type: 'reply', order: 'desc', limit: 1 })) outDescLimit1.push(e)
  t.is(outDescLimit1.length, 1)
  t.is(outDescLimit1[0].to, post.id)
})
