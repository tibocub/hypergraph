// SwarmFS's H17: a device paired, or a member let in, after a private space
// got past one index batch (256 blocks) of records it can't open yet reads
// it: the indexer goes on past them to the grant with their key.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account, device } = require('../forum/_setup.js')
const { eventually } = require('../helpers.js')

const N = 1000 // sealed records before the newcomer's grant: several batches

async function club (t) {
  const a = await account(t, 'a')
  const fa = await forum.createForum(a, 'Club', { private: true })
  for (let i = 0; i < N; i++) await forum.post(fa, `post ${i}`, 'text')
  return { a, fa }
}

const readable = (space) => eventually(async () => (await space.query('post').latest(1)).items[0]?.title === `post ${N - 1}`, 20000)

test('a device paired after a private space got big reads it', async (t) => {
  const { a, fa } = await club(t)
  const { code } = await forum.addDevice(a)
  const laptop = await device(t, 'laptop', code)
  const space = await eventually(() => laptop.spaces().some((s) => s.key === fa.key) && laptop.space(fa.key), 10000)
  t.ok(space, 'the laptop lists the club')
  t.ok(await readable(space), 'the laptop reads the newest post')
  t.is(space.status().access, 'full')
})

test('a member let into a big private space, reading it newest first, reads it', async (t) => {
  t.teardown(testing.bigSpaces({ records: 200 })) // a "big" space for this test: more than 200 records
  const { fa } = await club(t)
  const b = await account(t, 'b')
  const fb = await forum.join(b, await forum.invite(fa))
  t.ok(testing.reading(fb).horizon !== null, 'b reads it newest first')
  t.ok(await readable(fb), 'b reads the newest post')
  t.is(fb.status().access, 'full')
})
