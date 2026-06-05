const { assertConverged, getWriters, pumpUntil } = require('../harness')

module.exports = async function writerSetConvergence (t, h) {
  const owner = await h.createPeer('writers-owner')
  const peer1 = await h.createPeer('writers-peer1')
  const peer2 = await h.createPeer('writers-peer2')

  // createContext returns a context key (hex).
  const commentsKey = await owner.graph.createContext()
  const moderationKey = await owner.graph.createContext()

  const ownerComments = await owner.graph.openContext(commentsKey)
  const ownerModeration = await owner.graph.openContext(moderationKey)

  // Everyone opens the same contexts.
  const peer1Comments = await peer1.graph.openContext(commentsKey)
  const peer1Moderation = await peer1.graph.openContext(moderationKey)
  const peer2Comments = await peer2.graph.openContext(commentsKey)
  const peer2Moderation = await peer2.graph.openContext(moderationKey)

  owner.storage.commentsContext = commentsKey
  owner.storage.moderationContext = moderationKey
  peer1.storage.commentsContext = commentsKey
  peer1.storage.moderationContext = moderationKey
  peer2.storage.commentsContext = commentsKey
  peer2.storage.moderationContext = moderationKey

  const repl1 = h.replicatePair(owner, peer1)
  const repl2 = h.replicatePair(owner, peer2)
  const repl3 = h.replicatePair(peer1, peer2)

  t.teardown(async () => {
    await repl1.close()
    await repl2.close()
    await repl3.close()
    await h.cleanupPeer(owner)
    await h.cleanupPeer(peer1)
    await h.cleanupPeer(peer2)
  })

  // Ensure owner has opened peer user cores so it can add them as writers.
  await peer1.graph.update()
  await peer2.graph.update()

  await pumpUntil(async () => owner.graph.openUserCore(peer1.graph.key), 30000)
  await pumpUntil(async () => owner.graph.openUserCore(peer2.graph.key), 30000)

  await pumpUntil(async () => peer1.graph.openUserCore(owner.graph.key), 30000)
  await pumpUntil(async () => peer2.graph.openUserCore(owner.graph.key), 30000)
  await pumpUntil(async () => peer1.graph.openUserCore(peer2.graph.key), 30000)
  await pumpUntil(async () => peer2.graph.openUserCore(peer1.graph.key), 30000)

  // Evolve writer set.
  await ownerComments.addWriter(peer1Comments.localKey)
  await ownerComments.addWriter(peer2Comments.localKey)
  // Adversarial: duplicate writer addition.
  await ownerComments.addWriter(peer1Comments.localKey)

  await ownerModeration.addWriter(peer1Moderation.localKey)
  await ownerModeration.addWriter(peer2Moderation.localKey)
  await ownerModeration.addWriter(peer1Moderation.localKey)

  await assertConverged(t, [owner, peer1, peer2], { snapshotOpts: { postIds: [], targetIds: [] } })

  const contexts = [ownerComments, ownerModeration]
  const wOwner = await getWriters(owner, { contexts })
  const w1 = await getWriters(peer1, { contexts })
  const w2 = await getWriters(peer2, { contexts })

  t.alike(w1, wOwner)
  t.alike(w2, wOwner)

  // No duplicates inside each writer list.
  for (const ctxKey of Object.keys(wOwner.contexts)) {
    const list = wOwner.contexts[ctxKey] || []
    t.is(list.length, new Set(list).size)
  }
}
