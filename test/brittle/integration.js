const test = require('brittle')
const Corestore = require('corestore')
const { Hypergraph } = require('../../index.js')
const os = require('os')
const path = require('path')
const fs = require('fs')

async function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function replicatePair (peerA, peerB) {
  const s1 = peerA.store.replicate(true, { live: true })
  const s2 = peerB.store.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)

  const close = async () => {
    try { s1.destroy() } catch {}
    try { s2.destroy() } catch {}
  }

  return { close }
}

async function pumpUntil (fn, timeoutMs = 20000, intervalMs = 50) {
  const start = Date.now()
  let lastErr = null

  for (;;) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
    }

    if (Date.now() - start > timeoutMs) {
      const e = new Error('Timeout waiting for condition')
      e.cause = lastErr
      throw e
    }

    await sleep(intervalMs)
  }
}

async function createPeer (name) {
  const tmpDir = path.join(os.tmpdir(), `hypergraph-test-${name}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const store = new Corestore(tmpDir)
  const graph = new Hypergraph(store)
  await graph.ready()

  return { name, store, graph, tmpDir }
}

async function cleanup (peers) {
  for (const { graph, store, tmpDir } of peers) {
    await graph.close()
    await store.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

test('hypergraph: integration (single peer, multi-context)', async (t) => {
  const peer1 = await createPeer('peer1')
  t.teardown(async () => cleanup([peer1]))

  const author1 = peer1.graph.key.toString('hex')

  const post1 = await peer1.graph.put({ type: 'post' })
  await peer1.graph.putContent(post1.id, 'Hello from peer 1!', 'text')
  t.is((await peer1.graph.getContent(post1.id)).body, 'Hello from peer 1!')

  const tagContext = await peer1.graph.createContext()
  await peer1.graph.tag(post1.id, 'important', { author: author1, context: tagContext })

  const commentsContext = await peer1.graph.createContext()
  const c1 = await peer1.graph.put({ type: 'comment' })
  const c2 = await peer1.graph.put({ type: 'comment' })
  await peer1.graph.relate({ from: c1.id, to: post1.id, type: 'reply', author: author1, context: commentsContext })
  await peer1.graph.relate({ from: c2.id, to: post1.id, type: 'reply', author: author1, context: commentsContext })

  const replies = []
  for await (const edge of peer1.graph.edges(post1.id, { direction: 'in', type: 'reply' })) replies.push(edge)
  t.is(replies.length, 2)

  const post2 = await peer1.graph.put({ type: 'post' })
  const post3 = await peer1.graph.put({ type: 'post' })
  const alice = await peer1.graph.put({ type: 'user' })
  const bob = await peer1.graph.put({ type: 'user' })

  const authorContext = await peer1.graph.createContext()
  await peer1.graph.relate({ from: alice.id, to: post1.id, type: 'author', author: author1, context: authorContext })
  await peer1.graph.relate({ from: alice.id, to: post3.id, type: 'author', author: author1, context: authorContext })

  await peer1.graph.tag(post1.id, 'tech', { author: author1, context: tagContext })
  await peer1.graph.tag(post3.id, 'tech', { author: author1, context: tagContext })

  const posts = await peer1.graph.query().type('post').toArray()
  t.is(posts.length, 3)

  const tech = []
  for await (const node of peer1.graph.getByTag('tech')) tech.push(node)
  t.is(tech.length, 2)

  await peer1.graph.del(post3.id, { author: author1 })
  t.is(await peer1.graph.get(post3.id), null)

  const reactionsContext = await peer1.graph.createContext()
  const reaction = await peer1.graph.put({ type: 'reaction' })
  await peer1.graph.relate({ from: reaction.id, to: post1.id, type: 'like', author: author1, context: reactionsContext })

  const likes = []
  for await (const edge of peer1.graph.edges(post1.id, { direction: 'in', type: 'like' })) likes.push(edge)
  t.is(likes.length, 1)

  await peer1.graph.putContent(post1.id, 'Version 1', 'text')
  await peer1.graph.putContent(post1.id, 'Version 2', 'text')
  await peer1.graph.putContent(post1.id, 'Version 3', 'text')

  const latest = await peer1.graph.getContent(post1.id)
  t.is(latest.body, 'Version 3')
})

test('hypergraph: context writeMode T-open (auto writers)', async (t) => {
  const a = await createPeer('write-open-a')
  const b = await createPeer('write-open-b')
  t.teardown(async () => cleanup([a, b]))

  const repl = replicatePair(a, b)
  t.teardown(async () => repl.close())

  const ctxKey = await a.graph.createContext()
  const aCtx = await a.graph.openContext(ctxKey)
  const bCtx = await b.graph.openContext(ctxKey)

  await aCtx.addWriter(bCtx.localKey)

  await pumpUntil(async () => {
    await b.graph.update()
    if (!bCtx.writable) throw new Error('peer not writable yet')
  }, 30000)

  await aCtx.append({
    type: 'tag/add',
    entityId: 'post/a',
    tag: 'a',
    author: a.graph.key.toString('hex'),
    timestamp: Date.now()
  })

  await bCtx.append({
    type: 'tag/add',
    entityId: 'post/b',
    tag: 'b',
    author: b.graph.key.toString('hex'),
    timestamp: Date.now()
  })

  const aAuthor = a.graph.key.toString('hex')
  const bAuthor = b.graph.key.toString('hex')

  await pumpUntil(async () => {
    await a.graph.update()
    const a1 = await aCtx.get(`tref:a:post/a:${aAuthor}`)
    const b1 = await aCtx.get(`tref:b:post/b:${bAuthor}`)
    if (!a1) throw new Error('missing a tag')
    if (!b1) throw new Error('missing b tag')
  }, 30000)
})

test('hypergraph: context writeMode T-closed-authorized', async (t) => {
  const a = await createPeer('write-closed-owner')
  const b = await createPeer('write-closed-peer')
  t.teardown(async () => cleanup([a, b]))

  const repl = replicatePair(a, b)
  t.teardown(async () => repl.close())

  const owner = a.graph.key.toString('hex')
  const peerB = b.graph.key.toString('hex')

  const roleKey = await a.graph.createRoleBase()
  await a.graph.openRoleBase(roleKey)
  await b.graph.openRoleBase(roleKey)
  await a.graph.roleBase.init(owner)
  await a.graph.setRole(peerB, 'admin', { author: owner })

  await a.graph.update()

  const ctxKey = await a.graph.createContext({ writeMode: 'closed' })
  const aCtx = await a.graph.openContext(ctxKey, { writeMode: 'closed' })
  const bCtx = await b.graph.openContext(ctxKey, { writeMode: 'closed' })

  await aCtx.addWriter(bCtx.localKey, { author: owner })

  await pumpUntil(async () => {
    await b.graph.update()
    if (!bCtx.writable) throw new Error('peer not writable yet')
  }, 30000)

  await bCtx.append({
    type: 'tag/add',
    entityId: 'post/x',
    tag: 'x',
    author: peerB,
    timestamp: Date.now()
  })

  await pumpUntil(async () => {
    await a.graph.update()
    const v = await aCtx.get(`tref:x:post/x:${peerB}`)
    if (!v) throw new Error('missing x tag')
  }, 30000)
})

test('hypergraph: context writeMode T-closed-unauthorized', async (t) => {
  const a = await createPeer('write-closed-unauth-owner')
  const b = await createPeer('write-closed-unauth-peer')
  t.teardown(async () => cleanup([a, b]))

  const repl = replicatePair(a, b)
  t.teardown(async () => repl.close())

  const owner = a.graph.key.toString('hex')

  const roleKey = await a.graph.createRoleBase()
  await a.graph.openRoleBase(roleKey)
  await b.graph.openRoleBase(roleKey)
  await a.graph.roleBase.init(owner)

  const ctxKey = await a.graph.createContext({ writeMode: 'closed' })
  const aCtx = await a.graph.openContext(ctxKey, { writeMode: 'closed' })
  const bCtx = await b.graph.openContext(ctxKey, { writeMode: 'closed' })

  try {
    await bCtx.append({
      type: 'tag/add',
      entityId: 'post/y',
      tag: 'y',
      author: b.graph.key.toString('hex'),
      timestamp: Date.now()
    })
  } catch {}

  await a.graph.update()
  const v = await aCtx.get(`tref:y:post/y:${b.graph.key.toString('hex')}`)
  t.is(v, null)
})
