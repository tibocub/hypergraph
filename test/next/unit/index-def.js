// The local index's definition (lib/index/spec, built by lib/index/build.js):
// every collection and index works, and every key starts with the space.

const test = require('brittle')
const b4a = require('b4a')
const HyperDB = require('hyperdb')
const crypto = require('hypercore-crypto')
const def = require('../../../lib/index/spec/hyperdb')
const { tmpDir } = require('../helpers.js')

const key = () => crypto.randomBytes(32)

test('insert and find through every collection and index', async (t) => {
  const db = HyperDB.rocks(tmpDir(t, 'index'), def)
  t.teardown(() => db.close(), { order: 0 })

  const space = key()
  const other = key()
  const log = key()
  const author = key()
  const device = key()
  const id = (seq) => b4a.concat([log, b4a.from([seq])])
  const row = (seq, extra = {}) => ({
    space, id: id(seq), type: 'post', author, device, log, seq, stamp: 1000 + seq, vstamp: 1000 + seq, vdevice: device,
    fields: b4a.from([seq]), links: [], ix: [], flags: 0, opm: false, target: null, ...extra
  })

  await db.insert('@hg/records', row(1, { ix: ['forum\u0000news'] }))
  await db.insert('@hg/records', row(2, { ix: ['forum\u0000other'] }))
  await db.insert('@hg/records', row(3, { type: 'comment', links: [id(1)] }))
  await db.insert('@hg/records', row(4, { type: 'vote', links: [id(1)], opm: true, target: id(1) }))
  await db.insert('@hg/records', { ...row(1), space: other }) // same id, another space
  await db.insert('@hg/logs', { space, log, identity: author, device, indexed: 5, cut: null, refused: false })
  await db.insert('@hg/changes', { space, target: id(1), id: id(5), kind: 1, type: 'post', author, device, stamp: 2000, fields: b4a.from([9]), links: [] })
  await db.insert('@hg/spaces', { key: space, ns: 'abc', name: 'Forum', parent: null, joined: 1 })
  await db.insert('@hg/meta', { name: 'types', value: b4a.from('{}') })
  await db.flush()

  const latest = await db.find('@hg/by-type', { gte: { space, type: 'post' }, lte: { space, type: 'post' } }, { reverse: true }).toArray()
  t.alike(latest.map(r => r.seq), [2, 1], 'by-type, newest first, this space only')
  t.is((await db.find('@hg/by-author', { gte: { space, author }, lte: { space, author } }).toArray()).length, 4, 'by-author')
  const linked = await db.find('@hg/by-link', { gte: { space, target: id(1) }, lte: { space, target: id(1) } }).toArray()
  t.alike(linked.map(r => r.type).sort(), ['comment', 'vote'], 'by-link: what points at a record')
  const commentsOnly = await db.find('@hg/by-link', { gte: { space, target: id(1), type: 'comment' }, lte: { space, target: id(1), type: 'comment' } }).toArray()
  t.is(commentsOnly.length, 1, 'by-link, by type')
  const news = await db.find('@hg/by-ix', { gte: { space, type: 'post', ix: 'forum\u0000news' }, lte: { space, type: 'post', ix: 'forum\u0000news' } }).toArray()
  t.alike(news.map(r => r.seq), [1], 'by-ix: app-declared key')
  const vote = await db.findOne('@hg/one-per-member', { gte: { space, type: 'vote', target: id(1), author }, lte: { space, type: 'vote', target: id(1), author } })
  t.is(vote.seq, 4, 'one-per-member')
  t.is((await db.get('@hg/logs', { space, log })).indexed, 5, 'logs')
  t.is((await db.find('@hg/changes', { gte: { space, target: id(1) }, lte: { space, target: id(1) } }).toArray()).length, 1, 'changes by target')
  const byId = await db.findOne('@hg/changes-by-id', { gte: { space, id: id(5) }, lte: { space, id: id(5) } })
  t.alike(byId && byId.target, id(1), 'changes by their own id (cuts remove them)')
  t.is((await db.get('@hg/spaces', { key: space })).name, 'Forum', 'spaces')
  t.is(b4a.toString((await db.get('@hg/meta', { name: 'types' })).value), '{}', 'meta')
  t.is((await db.find('@hg/records', { gte: { space }, lte: { space } }).toArray()).length, 4, 'a space is one key range')
})
