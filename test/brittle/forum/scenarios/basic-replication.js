const { assertConverged, snapshotCanonical } = require('../harness')

module.exports = async function basicReplication (t, h) {
  const a = await h.createPeer('basic-a')
  const b = await h.createPeer('basic-b')

  await b.graph.openUserCore(a.graph.key)

  const repl = h.replicatePair(a, b)

  t.teardown(async () => {
    await repl.close()
    await h.cleanupPeer(a)
    await h.cleanupPeer(b)
  })

  const post = await a.storage.createPost('hello')

  await assertConverged(t, [a, b])

  const snapB = await snapshotCanonical(b)
  t.is(snapB.posts.length, 1)
  t.is(snapB.posts[0], post.id)
}
