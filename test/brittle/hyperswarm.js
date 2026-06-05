const test = require('brittle')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const { Hypergraph } = require('../../index.js')
const os = require('os')
const path = require('path')
const fs = require('fs')

async function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function createPeer (name, { userCoreKey = null } = {}) {
  const dir = path.join(os.tmpdir(), `hypergraph-hsw-${name}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })

  const store = new Corestore(dir)
  const graph = new Hypergraph(store, { userCoreKey })
  await graph.ready()

  const swarm = new Hyperswarm()
  let connectedResolve
  const connected = new Promise((resolve) => { connectedResolve = resolve })

  swarm.on('connection', (conn) => {
    if (connectedResolve) {
      connectedResolve(true)
      connectedResolve = null
    }
    store.replicate(conn)
  })

  return { name, dir, store, graph, swarm, connected }
}

async function cleanup (peers) {
  for (const p of peers) {
    try { await p.swarm.destroy() } catch {}
    try { await p.graph.close() } catch {}
    try { await p.store.close() } catch {}
    try { fs.rmSync(p.dir, { recursive: true, force: true }) } catch {}
  }
}

test('hypergraph: hyperswarm replication (user core)', async (t) => {
  const a = await createPeer('a')

  const authorA = a.graph.key.toString('hex')
  const post = await a.graph.put({ type: 'post' })
  await a.graph.putContent(post.id, 'hello over hyperswarm', 'text')

  const b = await createPeer('b', { userCoreKey: a.graph.key })

  const topic = a.graph.discoveryKey

  const discA = a.swarm.join(topic, { server: true, client: false })
  await discA.flushed()

  const discB = b.swarm.join(topic, { server: false, client: true })
  await b.swarm.flush()

  t.teardown(async () => {
    await discA.destroy()
    await discB.destroy()
    await cleanup([a, b])
  })

  const connected = await Promise.race([
    Promise.any([a.connected, b.connected]),
    sleep(20000).then(() => false)
  ])

  t.ok(connected, 'peers connected')

  for (let i = 0; i < 100; i++) {
    await b.graph.update()
    const postNode = await b.graph.get(post.id)
    const content = await b.graph.getContent(post.id)
    if (postNode && content) {
      t.is(postNode.id, post.id)
      t.is(content.body, 'hello over hyperswarm')
      return
    }
    await sleep(200)
  }

  t.fail('replication did not complete within timeout')
})
