const test = require('brittle')
const { createGraph } = require('../helpers')

test('error-cases: openContext() rejects malformed or missing keys', async (t) => {
  console.log('TEST: openContext malformed keys - starting')
  const { graph } = await createGraph(t, 'errors-open-context')

  await t.exception(graph.openContext('not-hex-!!!'), /32-bytes long/, 'rejects a non-hex string')
  await t.exception(graph.openContext('ab'), /32-bytes long/, 'rejects a too-short key')
  await t.exception(graph.openContext(null), /Context key is required/, 'rejects a null key')
  console.log('TEST: openContext malformed keys - passed')
})

test('error-cases: openContext() accepts a well-formed but never-created key (P2P: may still be replicating)', async (t) => {
  // NOT a bug: opening a context by a well-formed key you learned about
  // (e.g. from a bootstrap descriptor received before its data has fully
  // replicated) is a legitimate, intentional use case in a P2P system.
  // openContext() only validates key *shape*, not that the context has any
  // data yet.
  console.log('TEST: openContext unknown-but-valid key - starting')
  const { graph } = await createGraph(t, 'errors-open-context-unknown')

  const neverCreatedKey = 'ab'.repeat(32)
  const context = await graph.openContext(neverCreatedKey)
  t.ok(context, 'openContext succeeds for a well-formed key nobody has created data for yet')
  console.log('TEST: openContext unknown-but-valid key - passed')
})

test('error-cases: openRoleBase() rejects malformed or missing keys', async (t) => {
  console.log('TEST: openRoleBase malformed keys - starting')
  const { graph } = await createGraph(t, 'errors-open-role-base')

  await t.exception(graph.openRoleBase('not-hex-!!!'), /32-bytes long/, 'rejects a non-hex string')
  await t.exception(graph.openRoleBase(null), /RoleBase key is required/, 'rejects a null key')
  console.log('TEST: openRoleBase malformed keys - passed')
})

test('error-cases: relate() does not validate that from/to entities already exist locally (intentional)', async (t) => {
  // NOT a bug: this is required for out-of-order replication, where a
  // relation event can legitimately arrive/be created before the entity it
  // references has replicated locally. The forum test suite's
  // reply-before-parent.js scenario depends on exactly this behavior
  // (relating a comment to a parent post that hasn't synced yet). Adding
  // existence validation here would break that scenario.
  console.log('TEST: relate() with unknown entities - starting')
  const { graph } = await createGraph(t, 'errors-relate-unknown')

  const context = await graph.createContext()
  await t.execution(
    graph.relate({ from: 'post/never-created', to: 'post/also-never-created', type: 'reply', context }),
    'relate() succeeds even when neither entity exists locally yet'
  )
  console.log('TEST: relate() with unknown entities - passed')
})

test('error-cases: tag() rejects tagging a non-existent entity', async (t) => {
  console.log('TEST: tag() with unknown entity - starting')
  const { graph } = await createGraph(t, 'errors-tag-unknown')

  const context = await graph.createContext()
  await t.exception(
    graph.tag('post/never-created', 'featured', { context }),
    /Entity not found/,
    'tag() rejects an entity that does not exist locally'
  )
  console.log('TEST: tag() with unknown entity - passed')
})

test('error-cases: unrelate() rejects a relation that does not exist', async (t) => {
  console.log('TEST: unrelate() unknown relation - starting')
  const { graph } = await createGraph(t, 'errors-unrelate-unknown')

  const context = await graph.createContext()
  await t.exception(
    graph.unrelate({ from: 'post/a', to: 'post/b', type: 'reply', context }),
    /Relation not found/,
    'unrelate() rejects a relation that was never created'
  )
  console.log('TEST: unrelate() unknown relation - passed')
})
