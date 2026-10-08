// One write queue per instance (the spike: HyperDB refuses to flush during
// another insert). Many logs indexing at once go through it without errors.

const test = require('brittle')
const b4a = require('b4a')
const HyperDB = require('hyperdb')
const crypto = require('hypercore-crypto')
const def = require('../../../lib/index/spec/hyperdb')
const { WriteQueue } = require('../../../lib/index/indexer.js')
const { tmpDir } = require('../helpers.js')

test('concurrent inserts and flushes from several logs all succeed', async (t) => {
  const db = HyperDB.rocks(tmpDir(t, 'queue'), def)
  t.teardown(() => db.close(), { order: 0 })
  const queue = new WriteQueue(db)
  const space = crypto.randomBytes(32)

  const logs = Array.from({ length: 8 }, () => crypto.randomBytes(32))
  const errors = []
  await Promise.all(logs.flatMap((log) => Array.from({ length: 25 }, (_, seq) => queue.run(async (tx) => {
    await tx.insert('@hg/logs', { space, log, identity: log, device: log, indexed: seq + 1, cut: null, refused: false })
    await tx.insert('@hg/records', {
      space, id: b4a.concat([log, b4a.from([seq])]), type: 'post', author: log, device: log, log, seq,
      stamp: seq, vstamp: seq, vdevice: log, fields: null, links: [], ix: [], flags: 0, opm: false, target: null
    })
  }).catch((err) => errors.push(err)))))

  t.alike(errors.map(e => e.message), [], 'no "Insert/delete in progress"')
  const rows = await db.find('@hg/records', { gte: { space }, lte: { space } }).toArray()
  t.is(rows.length, 8 * 25)
  for (const log of logs) t.is((await db.get('@hg/logs', { space, log })).indexed, 25)
})

test('a failing task does not stop the queue', async (t) => {
  const db = HyperDB.rocks(tmpDir(t, 'queue2'), def)
  t.teardown(() => db.close(), { order: 0 })
  const queue = new WriteQueue(db)
  await t.exception(queue.run(async () => { throw new Error('boom') }), /boom/)
  await queue.run((tx) => tx.insert('@hg/meta', { name: 'x', value: null }))
  t.ok(await db.get('@hg/meta', { name: 'x' }))
})
