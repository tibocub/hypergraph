const test = require('brittle')
const Corestore = require('corestore')
const UserCore = require('../../../src/user-core.js')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { createGraph } = require('../helpers')

async function createUserCore (t, label) {
  const dir = path.join(os.tmpdir(), `user-core-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  const store = new Corestore(dir)
  const userCore = new UserCore(store)
  await userCore.ready()

  t.teardown(async () => {
    try { await userCore.close() } catch (err) { /* already closed */ }
    try { await store.close() } catch (err) { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  return userCore
}

test('user-core: append() writes an event and returns its sequence number', async (t) => {
  console.log('TEST: UserCore append - starting')
  const userCore = await createUserCore(t, 'append')

  console.log('  Step 1: append a first event, expect sequence 0')
  const seq1 = await userCore.append({ type: 'entity/create', id: 'post/1', entityType: 'post', author: 'a'.repeat(64) })
  t.is(seq1, 0, 'first appended event has sequence 0')
  t.is(userCore.length, 1, 'core length is 1 after one append')

  console.log('  Step 2: append a second event, expect sequence 1')
  const seq2 = await userCore.append({ type: 'entity/create', id: 'post/2', entityType: 'post', author: 'a'.repeat(64) })
  t.is(seq2, 1, 'second appended event has sequence 1')
  t.is(userCore.length, 2, 'core length is 2 after two appends')
  console.log('TEST: UserCore append - passed')
})

test('user-core: appendBatch() writes multiple events atomically', async (t) => {
  console.log('TEST: UserCore appendBatch - starting')
  const userCore = await createUserCore(t, 'batch')

  const startSeq = await userCore.appendBatch([
    { type: 'entity/create', id: 'post/1', entityType: 'post', author: 'a'.repeat(64) },
    { type: 'entity/create', id: 'post/2', entityType: 'post', author: 'a'.repeat(64) },
    { type: 'entity/create', id: 'post/3', entityType: 'post', author: 'a'.repeat(64) }
  ])
  t.is(startSeq, 0, 'appendBatch returns the sequence number of the first event in the batch')
  t.is(userCore.length, 3, 'core length reflects all three batched events')
  console.log('TEST: UserCore appendBatch - passed')
})

test('user-core: get() retrieves a decoded event by sequence number', async (t) => {
  console.log('TEST: UserCore get - starting')
  const userCore = await createUserCore(t, 'get')

  await userCore.append({ type: 'entity/create', id: 'post/1', entityType: 'post', author: 'a'.repeat(64) })
  const event = await userCore.get(0)
  t.ok(event, 'get() returns the event')
  t.is(event.type, 'entity/create', 'decoded event has the expected type')
  t.is(event.id, 'post/1', 'decoded event has the expected id')
  console.log('TEST: UserCore get - passed')
})

test('user-core: createReadStream() yields all decoded events in order', async (t) => {
  console.log('TEST: UserCore createReadStream - starting')
  const userCore = await createUserCore(t, 'stream')

  await userCore.appendBatch([
    { type: 'entity/create', id: 'post/1', entityType: 'post', author: 'a'.repeat(64) },
    { type: 'entity/create', id: 'post/2', entityType: 'post', author: 'a'.repeat(64) }
  ])

  const events = []
  for await (const e of userCore.createReadStream()) events.push(e)
  t.is(events.length, 2, 'stream yields both events')
  t.is(events[0].id, 'post/1', 'first event is post/1')
  t.is(events[1].id, 'post/2', 'second event is post/2')
  console.log('TEST: UserCore createReadStream - passed')
})

test('user-core: a freshly opened core has length 0 and is writable', async (t) => {
  console.log('TEST: UserCore initial state - starting')
  const userCore = await createUserCore(t, 'initial')

  t.is(userCore.length, 0, 'length is 0 before any append')
  t.ok(userCore.writable, 'a locally created core is writable')
  t.ok(userCore.key, 'core has a public key')
  console.log('TEST: UserCore initial state - passed')
})

test('user-core: graph.openUserCore() opens a remote (read-only) core by key', async (t) => {
  console.log('TEST: graph.openUserCore - starting')
  const { graph: a } = await createGraph(t, 'user-core-graph-a')
  const { graph: b } = await createGraph(t, 'user-core-graph-b')

  console.log('  Step 1: peer B opens peer A user core by key, before any replication')
  const remoteCore = await b.openUserCore(a.key)
  t.ok(remoteCore, 'openUserCore returns a UserCore instance')
  t.is(remoteCore.key.toString('hex'), a.key.toString('hex'), 'opened core key matches peer A key')
  t.absent(remoteCore.writable, 'a remote core opened by key alone is not writable')
  t.is(remoteCore.length, 0, 'remote core has no data without replication')
  console.log('TEST: graph.openUserCore - passed')
})

test('user-core: openUserCore() is idempotent for the same key', async (t) => {
  console.log('TEST: graph.openUserCore idempotency - starting')
  const { graph: a } = await createGraph(t, 'user-core-idempotent-a')
  const { graph: b } = await createGraph(t, 'user-core-idempotent-b')

  const first = await b.openUserCore(a.key)
  const second = await b.openUserCore(a.key)
  t.is(first, second, 'opening the same user core key twice returns the same instance')
  console.log('TEST: graph.openUserCore idempotency - passed')
})

test('user-core: openUserCore() rejects an invalid key', async (t) => {
  console.log('TEST: graph.openUserCore invalid key - starting')
  const { graph } = await createGraph(t, 'user-core-invalid-key')

  await t.exception(graph.openUserCore(''), /Invalid user core key/, 'empty key is rejected')
  await t.exception(graph.openUserCore(undefined), /Invalid user core key/, 'undefined key is rejected')
  console.log('TEST: graph.openUserCore invalid key - passed')
})

test('user-core: concurrent append()/appendBatch() each return the seq their own events landed at', async (t) => {
  // A returned seq is how put() derives an entity id, so a wrong one names
  // someone else's block. Appends that overlap in time must still each get
  // back the position of their own events, not of whichever append finished
  // last. (spec 002, R6)
  const userCore = await createUserCore(t, 'concurrent')
  const author = 'a'.repeat(64)
  const ev = (label) => ({ type: 'entity/create', id: label, entityType: 'post', author })

  const pending = []
  for (let i = 0; i < 20; i++) {
    pending.push(userCore.append(ev(`single-${i}`)).then(seq => ({ seq, labels: [`single-${i}`] })))
    const labels = [`batch-${i}-0`, `batch-${i}-1`, `batch-${i}-2`]
    pending.push(userCore.appendBatch(labels.map(ev)).then(seq => ({ seq, labels })))
  }
  const results = await Promise.all(pending)

  t.is(userCore.length, 20 + 20 * 3, 'every event was written')
  for (const { seq, labels } of results) {
    for (let k = 0; k < labels.length; k++) {
      const event = await userCore.get(seq + k)
      t.is(event.id, labels[k], `${labels[k]} is at the seq its append returned`)
    }
  }
})

test('user-core: withWriteLock() runs with the length the next append will start at', async (t) => {
  const userCore = await createUserCore(t, 'write-lock')
  const author = 'a'.repeat(64)
  const ev = (label) => ({ type: 'entity/create', id: label, entityType: 'post', author })

  await userCore.append(ev('first'))
  const racing = userCore.append(ev('racing'))
  const seen = await userCore.withWriteLock(async (length) => {
    const seq = await userCore.appendBatchUnlocked([ev('locked-0'), ev('locked-1')])
    return { length, seq }
  })
  await racing

  t.is(seen.seq, seen.length, 'the locked batch starts exactly at the length the lock reported')
  t.is((await userCore.get(seen.seq)).id, 'locked-0')
  t.is((await userCore.get(seen.seq + 1)).id, 'locked-1')
})
