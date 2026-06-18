const Corestore = require('corestore')
const { Hypergraph } = require('../index.js')
const os = require('os')
const path = require('path')
const fs = require('fs')
const crypto = require('hypercore-crypto')

async function test () {
  console.log('Testing Hypergraph...\n')

  // Create a temp directory for testing
  const tmpDir = path.join(os.tmpdir(), `hypergraph-test-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  // Create a corestore
  const store = new Corestore(tmpDir)

  // Create a hypergraph instance
  const graph = new Hypergraph(store)
  await graph.ready()

  console.log('Graph created')
  console.log('Key:', graph.key?.toString('hex').slice(0, 16) + '...')

  // Test 1: Create entities
  console.log('\n--- Test 1: Create entities ---')

  const keyPair = crypto.keyPair()
  const author = keyPair.publicKey.toString('hex')

  await graph.put({
    id: 'post/1',
    type: 'post',
    author
  })
  console.log('Created post/1')

  await graph.put({
    id: 'post/2',
    type: 'post',
    author
  })
  console.log('Created post/2')

  await graph.put({
    id: 'user/alice',
    type: 'user',
    author
  })
  console.log('Created user/alice')

  // Test 2: Get entities
  console.log('\n--- Test 2: Get entities ---')

  const post1 = await graph.get('post/1')
  console.log('post/1:', post1)

  const user = await graph.get('user/alice')
  console.log('user/alice:', user)

  // Test 3: Add content
  console.log('\n--- Test 3: Add content ---')

  await graph.putContent('post/1', 'Hello, World!', 'text')
  console.log('Added content to post/1')

  const content = await graph.getContent('post/1')
  console.log('Content:', content)

  // Test 4: Create relations
  console.log('\n--- Test 4: Create relations ---')

  const context = await graph.createContext()
  await graph.relate({
    from: 'post/2',
    to: 'post/1',
    type: 'reply',
    keyPair,
    context
  })
  console.log('Created reply relation: post/2 -> post/1')

  await graph.relate({
    from: 'user/alice',
    to: 'post/1',
    type: 'author',
    keyPair,
    context
  })
  console.log('Created author relation: user/alice -> post/1')

  // Test 5: Query edges
  console.log('\n--- Test 5: Query edges ---')

  console.log('Outgoing edges from post/2:')
  for await (const edge of graph.edges('post/2', { direction: 'out' })) {
    console.log('  ', edge)
  }

  console.log('Incoming edges to post/1:')
  for await (const edge of graph.edges('post/1', { direction: 'in' })) {
    console.log('  ', edge)
  }

  // Test 6: Tags
  console.log('\n--- Test 6: Tags ---')

  await graph.tag('post/1', 'important', { keyPair, context })
  console.log('Tagged post/1 as important')

  await graph.tag('post/1', 'pinned', { keyPair, context })
  console.log('Tagged post/1 as pinned')

  console.log('Entities with "important" tag:')
  for await (const node of graph.getByTag('important')) {
    console.log('  ', node)
  }

  // Test 7: Query interface
  console.log('\n--- Test 7: Query interface ---')

  const posts = await graph.query().type('post').toArray()
  console.log('All posts:', posts.length)

  // Test 8: Delete
  console.log('\n--- Test 8: Delete ---')

  await graph.del('post/2', { keyPair })
  console.log('Deleted post/2')

  const deleted = await graph.get('post/2')
  console.log('post/2 after delete:', deleted) // Should be null

  // Cleanup
  console.log('\n--- Cleanup ---')
  await graph.close()
  await store.close()

  // Remove temp directory
  fs.rmSync(tmpDir, { recursive: true, force: true })

  console.log('\nAll tests passed!')
}

test().catch(err => {
  console.error('Test failed:', err)
  process.exit(1)
})
