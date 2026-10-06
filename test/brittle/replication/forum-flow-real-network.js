// Regression guard for the exact flow the forum-web example exercises
// manually: two independent peers, connected over a REAL Hyperswarm/DHT
// connection (not a local store.replicate() pipe), each creating a post and
// a reply/comment on the OTHER peer's post — and both must converge to see
// everything from both sides.
//
// This exists because a manual test session against examples/forum-web
// found what looked like two serious bugs (owner couldn't see peer's posts
// one way, and comments weren't visible/creatable at all) that turned out,
// after investigation, to be caused entirely by stale local example-app
// storage (a bootstrap.json frozen with an old, no-longer-matching owner
// device key from many prior ad hoc test sessions) — not a real bug in
// hypergraph. Confirming that took spinning up the actual example app by
// hand and cross-checking persisted key files. An automated test exercising
// this same shape, over real networking, would have shown "library is
// fine" immediately instead.

const test = require('brittle')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const { Hypergraph } = require('../../../index.js')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { sleep, waitForConnections, withTeardownTimeout, destroySwarm, testSwarm } = require('../helpers')

async function createPeer (t, name) {
  const dir = path.join(os.tmpdir(), `hypergraph-forum-flow-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })

  const store = new Corestore(dir)
  const graph = new Hypergraph(store)
  await graph.ready()

  const swarm = await testSwarm(t)
  swarm.on('connection', (conn) => { store.replicate(conn) })

  return { name, dir, store, graph, swarm }
}

async function cleanup (peers) {
  for (const p of peers) {
    await withTeardownTimeout(p.graph.close().catch(() => {}), 10000, `${p.name}.graph.close()`)
    await withTeardownTimeout(p.store.close().catch(() => {}), 10000, `${p.name}.store.close()`)
    await withTeardownTimeout(destroySwarm(p.swarm), 10000, `${p.name}.swarm destroy`)
    try { fs.rmSync(p.dir, { recursive: true, force: true }) } catch {}
  }
}

async function createPostWithReply (author, { postBody, replyBody, replyToId, context }) {
  const post = await author.graph.put({ type: 'post' })
  await author.graph.putContent(post.id, postBody, 'text')

  if (replyToId) {
    const comment = await author.graph.put({ type: 'comment' })
    await author.graph.putContent(comment.id, replyBody, 'text')
    await author.graph.relate({ from: comment.id, to: replyToId, type: 'reply', context })
  }

  return post
}

test('forum-flow: two peers over a real Hyperswarm connection each post and reply to the other\'s post, and both converge on everything (needs real network)', { timeout: 180000 }, async (t) => {
  console.log('TEST: forum flow real network - starting (requires DHT access)')
  const a = await createPeer(t, 'a') // owner
  const b = await createPeer(t, 'b') // peer

  t.teardown(async () => { await cleanup([a, b]) })

  console.log('  Step 1: owner creates the comments context')
  const contextKey = await a.graph.createContext()
  const aCtx = await a.graph.openContext(contextKey)

  console.log('  Step 2: peer opens the owner\'s usercore + the same context')
  await b.graph.openUserCore(a.graph.key)
  const bCtx = await b.graph.openContext(contextKey)

  console.log('  Step 3: connect over a real Hyperswarm topic')
  const topic = a.graph.discoveryKey
  a.swarm.join(topic, { server: true, client: true })
  b.swarm.join(topic, { server: true, client: true })

  await waitForConnections([
    { name: 'a', swarm: a.swarm },
    { name: 'b', swarm: b.swarm }
  ], 30000, { topic })

  console.log('  Step 4: owner grants the peer write access to the comments context')
  // NOTE: the context's own writer key (bCtx.localKey) is a completely
  // separate key from the peer's USERCORE key (b.graph.key) — granting
  // context write access does not, by itself, make the peer's usercore
  // (where its posts actually live) known to the owner's view at all.
  // Real apps learn the peer's usercore key out-of-band (forum-web does it
  // via a writer-request control message carrying the peer's graph.key)
  // and call openUserCore() explicitly — hypergraph does not do this
  // automatically, by design (see docs/networking.md).
  await a.graph.openUserCore(b.graph.key)
  await a.graph.update()
  await aCtx.addWriter(bCtx.localKey)

  for (let i = 0; i < 100 && !bCtx.writable; i++) {
    await sleep(200)
    await bCtx.update()
  }
  t.ok(bCtx.writable, 'peer became a writer of the comments context')

  console.log('  Step 5: owner posts, peer opens owner\'s usercore already done — owner\'s post reaches peer')
  const ownerPost = await createPostWithReply(a, { postBody: 'post from owner', context: contextKey })

  console.log('  Step 6: peer sees the owner\'s post, then posts + replies to it')
  let peerSeesOwnerPost = false
  for (let i = 0; i < 100; i++) {
    await b.graph.update()
    if (await b.graph.get(ownerPost.id)) { peerSeesOwnerPost = true; break }
    await sleep(200)
  }
  t.ok(peerSeesOwnerPost, "peer can see the owner's post over the real network connection")

  const peerPost = await createPostWithReply(b, {
    postBody: 'post from peer',
    replyBody: 'peer replying to owner\'s post',
    replyToId: ownerPost.id,
    context: contextKey
  })

  console.log('  Step 7: owner sees the peer\'s post, then replies to it')
  let ownerSeesPeerPost = false
  for (let i = 0; i < 100; i++) {
    await a.graph.update()
    if (await a.graph.get(peerPost.id)) { ownerSeesPeerPost = true; break }
    await sleep(200)
  }
  t.ok(ownerSeesPeerPost, "owner can see the peer's post over the real network connection")

  await createPostWithReply(a, {
    postBody: 'post from owner (unused)', // not asserted on; only the reply below matters
    replyBody: 'owner replying to peer\'s post',
    replyToId: peerPost.id,
    context: contextKey
  })

  console.log('  Step 8: wait for both peers to converge, then verify full cross-visibility both ways')
  const snapshot = async (peer) => {
    await peer.graph.update()
    const posts = await peer.graph.query().type('post').toArray()

    const repliesTo = async (postId) => {
      const out = []
      for await (const e of peer.graph.edges(postId, { direction: 'in', type: 'reply', context: contextKey })) {
        const node = await peer.graph.get(e.from)
        const content = node ? await peer.graph.getContent(node.id) : null
        if (node && content) out.push(content.body)
      }
      return out.sort()
    }

    return {
      postCount: posts.length,
      ownerPostReplies: await repliesTo(ownerPost.id),
      peerPostReplies: await repliesTo(peerPost.id)
    }
  }

  let aSnap = null
  let bSnap = null
  for (let i = 0; i < 100; i++) {
    aSnap = await snapshot(a)
    bSnap = await snapshot(b)
    if (
      aSnap.postCount >= 3 && bSnap.postCount >= 3 &&
      aSnap.ownerPostReplies.length === 1 && bSnap.ownerPostReplies.length === 1 &&
      aSnap.peerPostReplies.length === 1 && bSnap.peerPostReplies.length === 1
    ) break
    await sleep(200)
  }

  t.is(aSnap.postCount, bSnap.postCount, 'both peers see the same number of posts')
  t.alike(aSnap.ownerPostReplies, ['peer replying to owner\'s post'], "owner's own view shows the peer's reply on the owner's post")
  t.alike(bSnap.ownerPostReplies, ['peer replying to owner\'s post'], "peer's view agrees on the owner's post's reply")
  t.alike(aSnap.peerPostReplies, ['owner replying to peer\'s post'], "owner's view shows its own reply on the peer's post")
  t.alike(bSnap.peerPostReplies, ['owner replying to peer\'s post'], "peer's view agrees on its own post's reply")
  console.log('TEST: forum flow real network - passed')

  // Same lingering-resource issue documented in
  // test/brittle/networking/peer-connection.js: something after a real DHT
  // connection keeps the process alive for a long time past the last test
  // completing (confirmed: the test itself finishes in ~4s). Deliberately
  // NOT force-exiting here the way that file does — confirmed directly that
  // doing so kills the whole brittle process when this file is glob-matched
  // alongside others (test:replication runs all replication/*.js in one
  // process), silently truncating every test in files that would have run
  // after this one. Slower-but-correct beats fast-but-truncates-siblings.
})
