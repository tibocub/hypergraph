// Spec 021: space.since() between members: a record written earlier and
// received later, a new author, a record received but not indexed, one whose
// key hasn't arrived, a ban, a permission given later, content dropped here,
// and no log's core opened for it.

const test = require('brittle')
const b4a = require('b4a')
const z32 = require('z32')
const forum = require('../forum/forum.js')
const enc = require('../../../lib/encodings.js')
const testing = require('../../../lib/testing.js')
const { account } = require('../forum/_setup.js')
const { eventually } = require('../helpers.js')

const hex = (z) => b4a.toString(z32.decode(z), 'hex')
const has = (f, id) => eventually(async () => !!(await f.get(id)).record, 15000)
const ids = (res) => res.records.map((r) => r.id).sort()

async function pair (t, opts) {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Club', opts)
  const fb = await forum.join(b, await forum.invite(fa))
  return { a, b, fa, fb }
}

// Member b standing after a first post of a: { p, cursor }.
async function standing (fa, fb) {
  const p = await forum.post(fa, 'first', '')
  if (!await has(fb, p.id)) throw new Error('the first post never arrived')
  return { p, cursor: (await fb.since(null)).cursor }
}

test('a record written earlier and received later is returned; query().since() misses it', { timeout: 90000 }, async (t) => {
  const { b, fa, fb } = await pair(t)
  const { cursor } = await standing(fa, fb)
  const saved = JSON.stringify(cursor)
  const key = fa.key
  await b.close()
  const backThen = Date.now() - 864e5 // written yesterday, offline
  const late = await testing.writeRaw(fa, { kind: 'put', type: 'post', fields: { title: 'late', text: '' }, stamp: backThen })
  const b2 = await account(t, 'b2', { dir: b.dir })
  const f2 = b2.space(key)
  t.ok(await has(f2, late), 'it arrives')
  const today = Date.now() - 36e5
  t.absent((await f2.query('post').since(today).latest(20)).items.some((r) => r.id === late), 'by stamps: not new')
  t.alike(ids(await f2.since(JSON.parse(saved))), [late], 'by cursor: new')
})

test('a new author\'s log, unknown to the cursor, counts from its start', { timeout: 90000 }, async (t) => {
  const { fa, fb } = await pair(t)
  const { cursor } = await standing(fa, fb)
  const c = await account(t, 'c')
  const fc = await forum.join(c, await forum.invite(fa))
  const mine = [await forum.post(fc, 'one', ''), await forum.post(fc, 'two', '')]
  for (const r of mine) t.ok(await has(fb, r.id))
  const res = await fb.since(cursor)
  t.alike(ids(res), mine.map((r) => r.id).sort())
  t.is(res.cursor[testing.ownLog(fc)], 3, 'past both records (block 0 is its header)')
})

test('a record received but not indexed yet stays ahead of the cursor', { timeout: 90000 }, async (t) => {
  const { b, fa, fb } = await pair(t)
  const { cursor } = await standing(fa, fb)
  const name = testing.ownLog(fa)
  const log = fb.directory.logs.get(hex(name))
  testing.slowCommits(b, 2000)
  const p = await forum.post(fa, 'slow', '')
  t.ok(await eventually(() => log.length > log.indexed, 15000), 'received, not indexed')
  const early = await fb.since(cursor)
  t.alike(early.records, [], 'not returned')
  t.ok(early.cursor[name] <= log.indexed, 'the cursor stays at what is indexed')
  testing.slowCommits(b, 0)
  let res = null
  t.ok(await eventually(async () => (res = await fb.since(early.cursor)).records.length === 1, 15000), 'returned once indexed')
  t.is(res.records[0].id, p.id)
  t.alike((await fb.since(res.cursor)).records, [], 'once')
})

test('a private space: a record whose key hasn\'t arrived is not passed', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Secret', { private: true })
  const first = await forum.post(fa, 'before', '')
  await fa._keying
  fa._keying = true // the only key holder grants nothing for now
  const fb = await forum.join(b, await forum.invite(fa))
  const name = testing.ownLog(fa)
  t.ok(await eventually(() => testing.holdsBlock(fb, first.id), 15000), 'b holds the sealed block')
  t.is(fb.status().access, 'waiting', 'without its key')
  const start = await fb.since(null)
  t.alike(start.records, [])
  t.is(start.cursor[name], enc.idParts(first.id).seq, 'stands before it (its key\'s grants come first in the log, readable)')
  const later = await fb.since(start.cursor)
  t.alike(later.records, [], 'nothing to read yet')
  t.alike(later.cursor, start.cursor, 'and not passed')

  fa._keying = null
  await forum.addRole(fa, 'wakes-the-key-work', ['post']) // any decision runs it again
  t.ok(await has(fb, first.id), 'the key arrived')
  let res = null
  t.ok(await eventually(async () => (res = await fb.since(later.cursor, { types: ['post'] })).records.length === 1, 15000), 'returned then')
  t.is(res.records[0].title, 'before', 'readable')
})

test('a banned author\'s dropped records aren\'t returned; other authors\' are', { timeout: 90000 }, async (t) => {
  const { fa, fb } = await pair(t)
  const c = await account(t, 'c')
  const fc = await forum.join(c, await forum.invite(fa))
  const { cursor } = await standing(fa, fb)
  const bad = await forum.post(fc, 'spam', '')
  t.ok(await has(fb, bad.id))
  await forum.ban(fa, c.identity.publicKey, { dropAll: true })
  t.ok(await eventually(async () => !(await fb.get(bad.id)).record, 15000), 'gone at b')
  const good = await forum.post(fa, 'good', '')
  t.ok(await has(fb, good.id))
  const res = await fb.since(cursor)
  t.alike(ids(res), [good.id])
  t.alike((await fb.since(res.cursor)).records, [], 'nothing left behind')
})

test('not covered: a record counting only after its author got a permission stays behind the cursor', { timeout: 90000 }, async (t) => {
  const { fa, fb } = await pair(t)
  const c = await account(t, 'c')
  const fc = await forum.join(c, await forum.invite(fa))
  const { cursor } = await standing(fa, fb)
  const forced = await testing.writeRaw(fc, { kind: 'put', type: 'theme', fields: { css: 'early' } })
  const mark = await forum.post(fc, 'mark', '') // after it in the same log
  t.ok(await has(fb, mark.id))
  const res = await fb.since(cursor)
  t.alike(ids(res), [mark.id], 'the theme doesn\'t count yet')
  await forum.giveRole(fa, c.identity.publicKey, 'admin')
  t.ok(await eventually(async () => (await forum.theme(fb))?.id === forced, 15000), 'it counts now for reads')
  t.alike((await fb.since(res.cursor)).records, [], 'and stays behind the cursor')
})

test('content dropped by the storage budget doesn\'t throw: listed without its fields', { timeout: 90000 }, async (t) => {
  const { fa, fb } = await pair(t)
  const { cursor } = await standing(fa, fb)
  const p = await forum.post(fa, 'big', 'lots of text')
  t.ok(await has(fb, p.id))
  const log = fb.directory.logs.get(hex(testing.ownLog(fa)))
  t.ok(await eventually(() => log.indexed > 2, 15000))
  const row = await fb.db.get('@hg/records', { space: fb.keyBytes, id: enc.idBytes(p.id) })
  await fb.indexer.drop([row])
  const res = await fb.since(cursor)
  t.is(res.records.length, 1)
  t.is(res.records[0].id, p.id)
  t.is(res.records[0].type, 'post')
  t.ok(res.records[0].dropped, 'says its content isn\'t here')
  t.absent(res.records[0].text, 'no content')
})

test('no log\'s core is opened: not while running, not after a restart', { timeout: 90000 }, async (t) => {
  const { a, b, fa, fb } = await pair(t)
  testing.idleLogs(b, 200)
  const { cursor } = await standing(fa, fb)
  const p = await forum.post(fa, 'new', '')
  t.ok(await has(fb, p.id))
  const saved = JSON.stringify(cursor)
  const key = fa.key
  await a.close()
  await b.close()

  const b2 = await account(t, 'b2', { dir: b.dir })
  testing.idleLogs(b2, 200)
  const f2 = b2.space(key)
  await f2.ready()
  t.alike(testing.openLogs(f2), [], 'held logs start closed')
  const res = await f2.since(JSON.parse(saved))
  t.alike(ids(res), [p.id], 'read from the index')
  t.alike(testing.openLogs(f2), [], 'still closed')
})
