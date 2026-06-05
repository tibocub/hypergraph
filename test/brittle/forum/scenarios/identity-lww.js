const { pumpUntil } = require('../harness')

module.exports = async function identityLww (t, h) {
  const a = await h.createPeer('id-a')
  const b = await h.createPeer('id-b')

  const aKeyHex = a.graph.key.toString('hex')
  await b.graph.openUserCore(aKeyHex)

  const repl = h.replicatePair(a, b)

  t.teardown(async () => {
    await repl.close()
    await h.cleanupPeer(a)
    await h.cleanupPeer(b)
  })

  await a.graph.setIdentity({ username: 'alice' })
  await a.graph.setIdentity({ username: 'alice2' })

  const ident = await pumpUntil(async () => {
    await b.graph.update()
    const v = await b.graph.getIdentity(aKeyHex)
    if (!v) throw new Error('identity not yet replicated')
    return v
  }, 30000)

  t.is(ident.username, 'alice2')
}
