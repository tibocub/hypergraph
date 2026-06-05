const Corestore = require('corestore')
const { Hypergraph } = require('../index.js')
const crypto = require('hypercore-crypto')

async function main () {
  const store = new Corestore('./data-moderation-example')
  const graph = new Hypergraph(store)
  await graph.ready()

  const author = graph.key.toString('hex')
  await graph.put({ id: 'post/1', type: 'post', author })
  await graph.putContent('post/1', 'Hello!', 'text')

  const moderationContext = await graph.createContext()

  const moderatorKeyPair = crypto.keyPair()
  const moderator = moderatorKeyPair.publicKey.toString('hex')

  await graph.moderateAction({
    context: moderationContext,
    action: 'flag',
    target: 'post/1',
    reason: 'spam',
    keyPair: moderatorKeyPair
  })

  console.log('Moderation context key:', moderationContext.toString('hex'))
  console.log('Moderator pubkey:', moderator)

  for await (const ev of graph.queryContext({
    type: 'moderation',
    context: moderationContext,
    target: 'post/1'
  })) {
    console.log(ev)
  }

  await graph.close()
  await store.close()
}

main().catch(console.error)
