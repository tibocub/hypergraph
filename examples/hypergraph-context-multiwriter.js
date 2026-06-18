const Corestore = require('corestore')
const { Hypergraph } = require('../index.js')
const crypto = require('hypercore-crypto')
const os = require('os')
const path = require('path')
const fs = require('fs')

async function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function replicate (storeA, storeB) {
  const s1 = storeA.replicate(true, { live: true })
  const s2 = storeB.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  return { s1, s2 }
}

async function main () {
  const keep = process.argv.includes('--keep')

  const dirA = path.join(os.tmpdir(), `hypergraph-ctx-mw-a-${process.pid}-${Date.now()}`)
  const dirB = path.join(os.tmpdir(), `hypergraph-ctx-mw-b-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dirA, { recursive: true })
  fs.mkdirSync(dirB, { recursive: true })

  const storeA = new Corestore(dirA)
  const storeB = new Corestore(dirB)

  const a = new Hypergraph(storeA)
  const b = new Hypergraph(storeB)
  await a.ready()
  await b.ready()

  console.log('Peer A user core:', a.key.toString('hex'))
  console.log('Peer B user core:', b.key.toString('hex'))

  const { s1, s2 } = await replicate(storeA, storeB)

  // Create some entities on both peers (single-writer cores)
  const authorA = a.key.toString('hex')
  const authorB = b.key.toString('hex')

  const post1 = await a.put({ type: 'post' })
  const comment1 = await b.put({ type: 'comment' })

  // Shared multi-writer context (Autobase)
  const ctxKeyHex = await a.createContext()
  console.log('Context key:', ctxKeyHex)

  const ctxA = await a.openContext(ctxKeyHex)
  const ctxB = await b.openContext(ctxKeyHex)

  console.log('Context local writer A:', ctxA.localKey.toString('hex'))
  console.log('Context local writer B:', ctxB.localKey.toString('hex'))

  // Handshake: A adds B as writer (facts in the context log)
  await ctxA.addWriter(ctxB.localKey)

  // Let both peers converge
  for (let i = 0; i < 100; i++) {
    await a.update(); await b.update()
    await ctxA.update(); await ctxB.update()
    if (ctxA.version > 0 && ctxB.version > 0) break
    await sleep(50)
  }

  // Both peers append to the same context (multi-writer)
  const keyPairB = crypto.keyPair()
  await a.relate({
    from: comment1.id,
    to: post1.id,
    type: 'reply',
    keyPair: keyPairB,
    context: ctxKeyHex
  })

  const modKeyPair = crypto.keyPair()
  await b.moderateAction({
    context: ctxKeyHex,
    action: 'content.flag',
    target: post1.id,
    reason: 'test',
    keyPair: modKeyPair
  })

  // Converge and query from both peers
  for (let i = 0; i < 200; i++) {
    await a.update(); await b.update()

    const edgesA = []
    for await (const e of a.edges(comment1.id, { direction: 'out', type: 'reply' })) edgesA.push(e)

    const edgesB = []
    for await (const e of b.edges(comment1.id, { direction: 'out', type: 'reply' })) edgesB.push(e)

    const modsA = []
    for await (const ev of a.queryContext({ type: 'moderation', context: ctxKeyHex, target: post1.id })) modsA.push(ev)

    const modsB = []
    for await (const ev of b.queryContext({ type: 'moderation', context: ctxKeyHex, target: post1.id })) modsB.push(ev)

    const ok = edgesA.length === 1 && edgesB.length === 1 && modsA.length === 1 && modsB.length === 1
    if (ok) {
      console.log('\nConverged.')
      console.log('Edges (A):', edgesA)
      console.log('Edges (B):', edgesB)
      console.log('Moderation (A):', modsA)
      console.log('Moderation (B):', modsB)
      break
    }

    await sleep(50)

    if (i === 199) {
      throw new Error('Did not converge in time')
    }
  }

  await s1.destroy(); await s2.destroy()
  await a.close(); await b.close()
  await storeA.close(); await storeB.close()

  if (!keep) {
    try { fs.rmSync(dirA, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(dirB, { recursive: true, force: true }) } catch {}
  }
}

main().catch(console.error)
