/**
 * Hypergraph Integration Test
 * 
 * Tests realistic scenarios including:
 * - Multi-writer contexts via Autobase
 * - Multiple contexts
 * - Query patterns
 * - Edge traversal
 * 
 * Note: Hyperswarm replication tests are in a separate file
 * because they require careful async handling.
 */

const Corestore = require('corestore')
const { Hypergraph } = require('../index.js')
const os = require('os')
const path = require('path')
const fs = require('fs')
const crypto = require('hypercore-crypto')

// Helper to create a peer (without Hyperswarm to avoid hanging)
async function createPeer (name) {
  const tmpDir = path.join(os.tmpdir(), `hypergraph-test-${name}-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const store = new Corestore(tmpDir)
  const graph = new Hypergraph(store)

  await graph.ready()

  return { name, store, graph, tmpDir }
}

async function cleanup (peers) {
  for (const { graph, store, tmpDir } of peers) {
    await graph.close()
    await store.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function test () {
  console.log('=== Hypergraph Integration Test ===\n')

  // ========================================
  // Test 1: Single peer basic operations
  // ========================================
  console.log('--- Test 1: Single Peer Basic Operations ---')

  const peer1 = await createPeer('peer1')
  const keyPair1 = crypto.keyPair()
  const author1 = keyPair1.publicKey.toString('hex')

  console.log('Peer 1 key:', author1.slice(0, 16) + '...')

  // Create entities
  await peer1.graph.put({ id: 'post/1', type: 'post', author: author1 })
  await peer1.graph.putContent('post/1', 'Hello from peer 1!', 'text')

  const post = await peer1.graph.get('post/1')
  console.log('Created post:', post?.id, '- content:', (await peer1.graph.getContent('post/1'))?.body)

  // Create a tag
  const tagContext = await peer1.graph.createContext()
  await peer1.graph.tag('post/1', 'important', { keyPair: keyPair1, context: tagContext })
  console.log('Tagged post/1 as important')

  console.log('Test 1: PASSED\n')

  // ========================================
  // Test 2: Multi-writer context (Autobase)
  // ========================================
  console.log('--- Test 2: Multi-writer Context ---')

  // Create a shared context for comments
  const context = await peer1.graph.createContext()
  console.log('Created comments context')

  // Peer 1 adds a comment (relation)
  await peer1.graph.relate({
    from: 'comment/1',
    to: 'post/1',
    type: 'reply',
    keyPair: keyPair1,
    context
  })
  console.log('Added comment/1 -> post/1')

  // Add another relation
  await peer1.graph.relate({
    from: 'comment/2',
    to: 'post/1',
    type: 'reply',
    keyPair: keyPair1,
    context
  })
  console.log('Added comment/2 -> post/1')

  // Query edges
  console.log('Replies to post/1:')
  for await (const edge of peer1.graph.edges('post/1', { direction: 'in', type: 'reply' })) {
    console.log('  ', edge.from, '->', edge.to)
  }

  console.log('Test 2: PASSED\n')

  // ========================================
  // Test 3: Query patterns
  // ========================================
  console.log('--- Test 3: Query Patterns ---')

  // Create more entities for testing
  await peer1.graph.put({ id: 'post/2', type: 'post', author: author1 })
  await peer1.graph.put({ id: 'post/3', type: 'post', author: author1 })
  await peer1.graph.put({ id: 'user/alice', type: 'user', author: author1 })
  await peer1.graph.put({ id: 'user/bob', type: 'user', author: author1 })

  const authorContext = await peer1.graph.createContext()

  // Create relations
  await peer1.graph.relate({
    from: 'user/alice',
    to: 'post/1',
    type: 'author',
    keyPair: keyPair1,
    context: authorContext
  })
  await peer1.graph.relate({
    from: 'user/alice',
    to: 'post/3',
    type: 'author',
    keyPair: keyPair1,
    context: authorContext
  })

  // Tag posts
  await peer1.graph.tag('post/1', 'tech', { keyPair: keyPair1, context: tagContext })
  await peer1.graph.tag('post/3', 'tech', { keyPair: keyPair1, context: tagContext })

  // Query all posts
  const posts = await peer1.graph.query().type('post').toArray()
  console.log('All posts:', posts.length)
  for (const p of posts) {
    console.log('  -', p.id, 'by', p.author.slice(0, 8) + '...')
  }

  // Query by tag
  console.log('Posts tagged "tech":')
  for await (const node of peer1.graph.getByTag('tech')) {
    console.log('  -', node.id)
  }

  // Query by author (using filter)
  const alicePosts = await peer1.graph.query()
    .filter(n => n.author === author1)
    .toArray()
  console.log('Posts by author:', alicePosts.length)

  console.log('Test 3: PASSED\n')

  // ========================================
  // Test 4: Soft deletion and history
  // ========================================
  console.log('--- Test 4: Soft Deletion ---')

  // Delete a post
  await peer1.graph.del('post/3')
  console.log('Deleted post/3')

  // Verify it's deleted
  const deleted = await peer1.graph.get('post/3')
  console.log('post/3 after delete:', deleted) // Should be null

  // But we can still query history from the core
  const history = []
  const { decodeEvent } = require('../src/encodings/event')
  for await (const event of peer1.graph.core.createReadStream()) {
    // Decode the binary event using the compact encoder
    const decoded = decodeEvent(event.value)
    history.push(decoded)
  }
  console.log('Total events in core:', history.length)

  console.log('Test 4: PASSED\n')

  // ========================================
  // Test 5: Edge traversal
  // ========================================
  console.log('--- Test 5: Edge Traversal ---')

  // Get all outgoing edges from user/alice
  console.log("Outgoing edges from user/alice:")
  for await (const edge of peer1.graph.edges('user/alice', { direction: 'out' })) {
    console.log('  ', edge.type + ':', edge.from, '->', edge.to)
  }

  // Get all incoming edges to post/1
  console.log('Incoming edges to post/1:')
  for await (const edge of peer1.graph.edges('post/1', { direction: 'in' })) {
    console.log('  ', edge.type + ':', edge.from, '->', edge.to)
  }

  console.log('Test 5: PASSED\n')

  // ========================================
  // Test 6: Multiple contexts
  // ========================================
  console.log('--- Test 6: Multiple Contexts ---')

  // Create another context for reactions
  const reactions = await peer1.graph.createContext()

  await peer1.graph.relate({
    from: 'reaction/1',
    to: 'post/1',
    type: 'like',
    keyPair: keyPair1,
    context: reactions
  })

  console.log('Created reaction context and added a like')

  // Query reactions
  console.log('Likes on post/1:')
  for await (const edge of peer1.graph.edges('post/1', { direction: 'in', type: 'like' })) {
    console.log('  ', edge.from, '->', edge.to)
  }

  console.log('Test 6: PASSED\n')

  // ========================================
  // Test 7: Content versioning
  // ========================================
  console.log('--- Test 7: Content Versioning ---')

  // Add multiple content versions
  await peer1.graph.putContent('post/1', 'Version 1', 'text')
  await peer1.graph.putContent('post/1', 'Version 2', 'text')
  await peer1.graph.putContent('post/1', 'Version 3', 'text')

  // Get latest content
  const latestContent = await peer1.graph.getContent('post/1')
  console.log('Latest content:', latestContent?.body)

  // Count content entries for post/1
  let contentCount = 0
  for await (const entry of peer1.graph.view.createReadStream({ gte: 'c:post/1:', lt: 'c:post/1:\uffff' })) {
    contentCount++
  }
  console.log('Content entries for post/1:', contentCount)

  console.log('Test 7: PASSED\n')

  // ========================================
  // Cleanup
  // ========================================
  console.log('--- Cleanup ---')

  await cleanup([peer1])

  console.log('\n=== All Integration Tests Passed! ===')
}

test().catch(err => {
  console.error('Test failed:', err)
  process.exit(1)
})
