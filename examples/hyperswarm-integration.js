/**
 * Hyperswarm Integration Example
 * 
 * This example shows how an app would handle replication using Hyperswarm.
 * The database (Hypergraph) provides the primitives, the app handles replication.
 */

const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const { Hypergraph } = require('../index.js')

function argValue (argv, key) {
  const pref = `--${key}=`
  const a = argv.find(v => v.startsWith(pref))
  return a ? a.slice(pref.length) : null
}

async function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main () {
  const argv = process.argv.slice(2)

  // IMPORTANT: Corestore (RocksDB) cannot be opened twice from the same directory.
  // This example REQUIRES you to pass an explicit, unique storage dir per peer.
  const storageDir = argValue(argv, 'storage')
  if (!storageDir) {
    throw new Error('Missing --storage=... (must be unique per peer, due to RocksDB locking)')
  }

  const userCoreKeyHex = argValue(argv, 'userCoreKey')
  let seed = argv.includes('--seed')

  // User cores are single-writer. If you open someone else's user core key,
  // this peer is a read-only mirror and cannot append.
  if (userCoreKeyHex && seed) {
    console.log('NOTE: --seed ignored because --userCoreKey was provided (opened core is read-only on this peer)')
    seed = false
  }

  const store = new Corestore(storageDir)
  const graph = new Hypergraph(store, {
    userCoreKey: userCoreKeyHex ? Buffer.from(userCoreKeyHex, 'hex') : null
  })
  await graph.ready()

  console.log('Storage dir:', storageDir)
  console.log('Graph key:', graph.key.toString('hex'))
  console.log('Discovery key (topic):', graph.discoveryKey.toString('hex'))

  const localAuthor = graph.key.toString('hex')

  // Create swarm
  const swarm = new Hyperswarm()
  let connections = 0

  // Handle incoming connections
  swarm.on('connection', (conn) => {
    console.log('New connection from peer')
    connections++
    
    // Replicate all cores in the store
    // This includes: user core, view core, and any context autobases
    store.replicate(conn)
  })

  // Join the graph's discovery topic
  // Other peers can find us by this key
  const disc = swarm.join(graph.discoveryKey, { server: true, client: true })
  await disc.flushed()
  await swarm.flush()

  if (seed) {
    const localPostId = `post/hello/${localAuthor.slice(0, 8)}`
    await graph.put({ id: localPostId, type: 'post', author: localAuthor })
    await graph.putContent(localPostId, 'Hello from P2P!', 'text')
    console.log('Seeded LOCAL post:', localPostId, 'author:', localAuthor)
  }

  console.log('Waiting for peers / replication...')
  const seenRemote = new Set()
  for (;;) {
    await graph.update()

    // Only consider something "replicated" if it was authored by a different key.
    // This avoids confusing local reads with actual P2P sync.
    const posts = await graph.query().type('post').toArray()
    for (const post of posts) {
      if (!post || !post.id || !post.author) continue
      if (post.author === localAuthor) continue
      if (connections === 0) continue
      if (seenRemote.has(post.id)) continue

      const content = await graph.getContent(post.id)
      if (!content) continue

      seenRemote.add(post.id)
      console.log('REMOTE replicated:', post.id)
      console.log('  author:', post.author)
      console.log('  body:', content.body)
    }

    await sleep(500)
  }
}

main().catch(console.error)
