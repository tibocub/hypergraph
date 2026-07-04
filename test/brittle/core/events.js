const test = require('brittle')
const { createGraph } = require('../helpers')

test('events: put emits an entity-create change event', async (t) => {
  console.log('TEST: entity-create event - starting')
  const { graph } = await createGraph(t, 'events-entity-create')

  const changes = []
  graph.on('change', (change) => changes.push(change))

  const post = await graph.put({ type: 'post' })
  t.ok(changes.length > 0, 'a change event was emitted')
  t.is(changes[changes.length - 1].type, 'entity-create', 'change type is entity-create')
  t.is(changes[changes.length - 1].id, post.id, 'change includes the entity id')
  console.log('TEST: entity-create event - passed')
})

test('events: putContent emits a content-append change event', async (t) => {
  console.log('TEST: content-append event - starting')
  const { graph } = await createGraph(t, 'events-content-append')

  const post = await graph.put({ type: 'post' })
  const changes = []
  graph.on('change', (change) => changes.push(change))

  await graph.putContent(post.id, 'hello world', 'text')
  t.ok(changes.length > 0, 'a change event was emitted')
  t.is(changes[changes.length - 1].type, 'content-append', 'change type is content-append')
  t.is(changes[changes.length - 1].entityId, post.id, 'change includes the entity id')
  console.log('TEST: content-append event - passed')
})

test('events: relate emits a relation-create change event', async (t) => {
  console.log('TEST: relation-create event - starting')
  const { graph } = await createGraph(t, 'events-relation-create')

  const post = await graph.put({ type: 'post' })
  const context = await graph.createContext({ writeMode: 'open' })
  const changes = []
  graph.on('change', (change) => changes.push(change))

  await graph.relate({ from: 'comment/1', to: post.id, type: 'reply', context })
  t.ok(changes.length > 0, 'a change event was emitted')
  t.is(changes[changes.length - 1].type, 'relation-create', 'change type is relation-create')
  console.log('TEST: relation-create event - passed')
})

test('events: del emits an entity-delete change event', async (t) => {
  console.log('TEST: entity-delete event - starting')
  const { graph } = await createGraph(t, 'events-entity-delete')

  const post = await graph.put({ type: 'post' })
  const changes = []
  graph.on('change', (change) => changes.push(change))

  await graph.del(post.id)
  t.ok(changes.length > 0, 'a change event was emitted')
  t.is(changes[changes.length - 1].type, 'entity-delete', 'change type is entity-delete')
  console.log('TEST: entity-delete event - passed')
})
