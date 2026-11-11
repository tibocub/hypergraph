// Spec 021: space.since(cursor, { types, limit }): the records created past a
// cursor of a seq per log, no clock involved. One device here; what needs two
// (late arrivals, new authors, keys, bans): test/next/net/since.js.

const test = require('brittle')
const { Hypergraph } = require('../../../lib/index.js')
const testing = require('../../../lib/testing.js')
const { tmpDir, codeOf, eventually } = require('../helpers.js')

const types = { post: { fields: { title: 'string' } }, note: { fields: { text: 'text' } } }
const rules = [{ id: 'no-spam', validate: (r) => r.type !== 'post' || r.title !== 'spam' }]

async function engine (t, opts = {}) {
  const hg = await Hypergraph.open(opts.dir || tmpDir(t, 'since'), { types, rules, bootstrap: null, ...opts })
  t.teardown(() => hg.close(), { order: 0 })
  return hg
}

async function space (t, opts) {
  const hg = await engine(t, opts)
  return { hg, s: await hg.createSpace({ name: 'S' }) }
}

const ids = (res) => res.records.map((r) => r.id).sort()
const sorted = (...records) => records.map((r) => r.id).sort()

test('null: from now on, nothing returned; then each record once, as query() shows it', async (t) => {
  const { s } = await space(t)
  await s.put('post', { title: 'old' })
  const start = await s.since(null)
  t.alike(start.records, [], 'history is not news')
  t.alike(JSON.parse(JSON.stringify(start.cursor)), start.cursor, 'the cursor is plain JSON')
  const p = await s.put('post', { title: 'new' })
  const next = await s.since(start.cursor)
  t.alike(next.records, (await s.query('post').latest(1)).items, 'the shape query() gives')
  t.is(next.records[0].id, p.id)
  const again = await s.since(next.cursor)
  t.alike(again.records, [], 'not twice')
  t.alike(again.cursor, next.cursor)
})

test('a record stamped far in the future silences nothing', async (t) => {
  const { s } = await space(t)
  await s.put('post', { title: 'first' })
  const { cursor } = await s.since(null)
  const ahead = await testing.writeRaw(s, { kind: 'put', type: 'post', fields: { title: 'from 2100' }, stamp: Date.UTC(2100, 0) })
  const after = await testing.writeRaw(s, { kind: 'put', type: 'post', fields: { title: 'now' }, stamp: Date.now() })
  let res = null
  t.ok(await eventually(async () => (res = await s.since(cursor)).records.length === 2, 5000), 'both')
  t.alike(ids(res), [ahead, after].sort())
})

test('creations only; deleted, hidden and rule-rejected records are left out, and passed', async (t) => {
  const { s } = await space(t)
  const old = await s.put('post', { title: 'old' })
  const { cursor } = await s.since(null)
  const gone = await s.put('post', { title: 'gone' })
  const hidden = await s.put('post', { title: 'hidden' })
  const kept = await s.put('post', { title: 'kept' })
  await testing.writeRaw(s, { kind: 'put', type: 'post', fields: { title: 'spam' } })
  await s.edit(old.id, { title: 'old, edited' })
  await s.del(gone.id)
  await s.moderateAction('hide', hidden)
  const last = await s.put('post', { title: 'last' })
  const res = await s.since(cursor)
  t.alike(ids(res), sorted(kept, last), 'only what stands, the edit is not a new record')
  t.alike((await s.since(res.cursor)).records, [], 'all passed')
  await s.moderateAction('reveal', hidden)
  t.alike((await s.since(res.cursor)).records, [], 'a record revealed later stays behind the cursor (docs: what is not covered)')
})

test('an edited record is returned at its current version', async (t) => {
  const { s } = await space(t)
  await s.put('post', { title: 'old' })
  const { cursor } = await s.since(null)
  const p = await s.put('post', { title: 'draft' })
  await s.edit(p.id, { title: 'final' })
  const res = await s.since(cursor)
  t.is(res.records.length, 1)
  t.is(res.records[0].title, 'final')
  t.ok(res.records[0].edited)
})

test('types: only those returned, the cursor goes on; two callers keep separate cursors', async (t) => {
  const { s } = await space(t)
  await s.put('post', { title: 'old' })
  const start = await s.since(null)
  const p = await s.put('post', { title: 'p' })
  const n = await s.put('note', { text: 'n' })
  const posts = await s.since(start.cursor, { types: ['post'] })
  const notes = await s.since(start.cursor, { types: ['note'] })
  t.alike(ids(posts), [p.id])
  t.alike(ids(notes), [n.id], 'the other caller, from its own cursor')
  t.alike(posts.cursor, notes.cursor, 'both passed the same blocks')
  const q = await s.put('post', { title: 'q' })
  t.alike(ids(await s.since(posts.cursor, { types: ['post'] })), [q.id])
  t.alike((await s.since(notes.cursor, { types: ['note'] })).records, [])
  t.is(await codeOf(s.since(null, { types: ['nope'] })), 'INVALID_TYPE', 'as query() says of an unknown type')
})

test('hypergraph\'s own records are left out unless asked for', async (t) => {
  const { s } = await space(t)
  const p = await s.put('post', { title: 'old' })
  const { cursor } = await s.since(null)
  await s.tag(p, 'rust')
  t.alike((await s.since(cursor)).records, [], 'a tag is not a post')
  t.is((await s.since(cursor, { types: ['hg/tag'] })).records.length, 1, 'asked for')
})

test('limit: the cursor stops at the last record returned, the next call goes on; nothing skipped or repeated', async (t) => {
  const { s } = await space(t)
  await s.put('note', { text: 'old' })
  let { cursor } = await s.since(null)
  const all = []
  for (let i = 0; i < 7; i++) {
    all.push(await s.put('post', { title: 'p' + i }))
    await s.put('note', { text: 'between' })
  }
  const seen = []
  for (let page = 0; page < 3; page++) {
    const res = await s.since(cursor, { types: ['post'], limit: 3 })
    t.is(res.records.length, page < 2 ? 3 : 1)
    seen.push(...res.records.map((r) => r.id))
    cursor = res.cursor
  }
  t.alike(seen.sort(), all.map((r) => r.id).sort())
  t.alike((await s.since(cursor, { types: ['post'], limit: 3 })).records, [])
})

test('across a close of the instance, and from a closed space', async (t) => {
  const dir = tmpDir(t, 'reopen')
  const first = await Hypergraph.open(dir, { types, rules, bootstrap: null })
  const s = await first.createSpace({ name: 'S' })
  await s.put('post', { title: 'old' })
  const { cursor } = await s.since(null)
  const p = await s.put('post', { title: 'written, then closed' })
  const saved = JSON.stringify(cursor)
  await first.close()

  const hg = await engine(t, { dir, maxAnnounced: 1, idleMs: 100 })
  await hg.createSpace({ name: 'most recent: the seeded one' })
  const again = hg.space(s.key)
  t.ok(await eventually(() => !again.opened, 5000), 'closed once idle')
  const res = await again.since(JSON.parse(saved))
  t.alike(ids(res), [p.id], 'it opens by itself, the saved cursor still good')
})

test('a cursor ahead of the index stays: nothing returned, nothing lost', async (t) => {
  const { s } = await space(t)
  const p = await s.put('post', { title: 'p' })
  const log = testing.ownLog(s)
  const res = await s.since({ [log]: 1000 })
  t.alike(res.records, [])
  t.is(res.cursor[log], 1000, 'as an index being rebuilt reaches it again')
  t.alike(ids(await s.since({ [log]: 1 })), [p.id])
})

test('a type that hasn\'t arrived yet is not passed', async (t) => {
  const { s } = await space(t)
  await s.put('post', { title: 'old' })
  const { cursor } = await s.since(null)
  await testing.writeRaw(s, { kind: 'put', type: 'unknown-yet', fields: {} })
  const p = await s.put('post', { title: 'behind it' })
  const pending = s._typesPending
  s._typesPending = () => true
  const waiting = await s.since(cursor)
  t.alike(waiting.records, [], 'stopped at it')
  t.alike(waiting.cursor, cursor, 'not passed')
  s._typesPending = pending
  t.alike(ids(await s.since(waiting.cursor)), [p.id], 'known for good not to be this app\'s: passed')
})

test('bad arguments are refused', async (t) => {
  const { s } = await space(t)
  for (const bad of [undefined, 3, 'x', [], { a: 'b' }, { a: 1.5 }]) await t.exception.all(s.since(bad), TypeError, 'cursor ' + JSON.stringify(bad))
  for (const limit of [0, -1, 1.5, 'x']) await t.exception.all(s.since(null, { limit }), TypeError, 'limit ' + limit)
  await t.exception.all(s.since(null, { types: 'post' }), TypeError, 'types is a list')
})

test('on a site\'s handle too', async (t) => {
  const { hg, s } = await space(t)
  const site = await hg.scope(s.key, { identity: 'main' })
  t.teardown(() => site.close())
  await site.put('post', { title: 'old' })
  const { cursor } = await site.since(null)
  const p = await site.put('post', { title: 'p' })
  t.alike(ids(await site.since(cursor, { types: ['post'] })), [p.id])
})
