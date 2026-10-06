// update() with nothing new must cost (almost) nothing, however many
// contexts are open (bench/channels.js: 200 idle channels cost 121 ms per
// update, and every local write paid it too).

const test = require('brittle')
const crypto = require('hypercore-crypto')
const { createGraph } = require('../helpers')

// Count calls to a method, keeping its behavior.
function spy (obj, name) {
  const counter = { calls: 0 }
  const original = obj[name].bind(obj)
  obj[name] = (...args) => { counter.calls++; return original(...args) }
  return counter
}

test('idle-update: an update with nothing new re-reads no member list and updates each context once', async (t) => {
  const { graph } = await createGraph(t, 'idle-update')
  const contexts = []
  for (let i = 0; i < 20; i++) contexts.push(await graph.openContext(await graph.createContext()))
  await graph.update()

  const lists = contexts.map(c => spy(c.base.system, 'list'))
  const updates = contexts.map(c => spy(c, 'update'))
  for (let i = 0; i < 5; i++) await graph.update()

  t.is(lists.reduce((n, s) => n + s.calls, 0), 0, 'no member list read')
  t.alike(updates.map(s => s.calls), contexts.map(() => 5), 'each context updated once per graph.update()')
})

test('idle-update: a member added later still shows in writerKeys()', async (t) => {
  const { graph } = await createGraph(t, 'idle-update-members')
  const context = await graph.openContext(await graph.createContext())
  await graph.update()
  const before = context.writerKeys().length

  const writer = crypto.keyPair()
  await context.addWriter(writer.publicKey, { keyPair: graph.identity.deviceKeyPair, member: crypto.keyPair().publicKey.toString('hex') })
  await graph.update()
  t.is(context.writerKeys().length, before + 1, 'the new writer is listed')
  t.ok(context.writerKeys().includes(writer.publicKey.toString('hex')))
})

test('idle-update: a local write updates no other context', async (t) => {
  const { graph } = await createGraph(t, 'idle-update-write')
  const keys = []
  for (let i = 0; i < 10; i++) keys.push(await graph.createContext())
  const contexts = []
  for (const k of keys) contexts.push(await graph.openContext(k))
  await graph.update()

  const updates = contexts.map(c => spy(c, 'update'))
  const post = await graph.put({ type: 'post' })
  await graph.relate({ from: post.id, to: post.id, type: 'self', context: keys[0] })
  t.is(updates.slice(1).reduce((n, s) => n + s.calls, 0), 0, 'the other nine contexts were not touched')
  t.is(await graph.countEdgesIn(post.id, 'self', { context: keys[0] }), 1, 'and the write is visible')
})
