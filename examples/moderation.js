const Corestore = require('corestore')
const { Hypergraph } = require('../index.js')
const crypto = require('hypercore-crypto')

async function main () {
  const store = new Corestore('./data-moderation-example')
  const graph = new Hypergraph(store)
  await graph.ready()

  const author = graph.key.toString('hex')
  const post = await graph.put({ type: 'post' })
  await graph.putContent(post.id, 'Hello!', 'text')

  const moderationContext = await graph.createContext()

  const moderatorKeyPair = crypto.keyPair()
  const moderator = moderatorKeyPair.publicKey.toString('hex')

  await graph.moderateAction({
    context: moderationContext,
    action: 'content.flag',
    target: post.id,
    reason: 'spam',
    keyPair: moderatorKeyPair
  })

  console.log('Moderation context key:', moderationContext.toString('hex'))
  console.log('Moderator pubkey:', moderator)

  for await (const ev of graph.queryContext({
    type: 'moderation',
    context: moderationContext,
    target: post.id
  })) {
    console.log(ev)
  }

  await graph.close()
  await store.close()
}

main().catch(console.error)
