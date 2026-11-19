// count() and sum() count the records pointing at one: without `on` they
// failed deep inside (reading `id` of undefined), now a TypeError says why.

const test = require('brittle')
const forum = require('./forum.js')
const { account } = require('./_setup.js')

test('count() and sum() without `on`: a TypeError that says what is missing', async (t) => {
  const a = await account(t, 'a')
  const f = await forum.createForum(a, 'Counts')
  const p = await forum.post(f, 'Post', '')
  await forum.vote(f, p, 1)
  await t.exception.all(f.count('comment'), /count\(type, \{ on: record \}\)/, 'count() without on')
  await t.exception.all(f.sum('vote', 'value'), /sum\(type, field, \{ on: record \}\)/, 'sum() without on')
  t.is((await f.sum('vote', 'value', { on: p })).value, 1, 'with on: as before')
  t.is((await f.count('comment', { on: p })).value, 0)
})
