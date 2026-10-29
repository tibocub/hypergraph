// Beyond the switch-over point (FR-029, story 9, research.md A14), a newcomer
// doesn't open every member's log: only those in the activity lists of the
// periods it reads. Its answers, once complete, are a full member's.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { PERIOD_MS } = require('../../../lib/activity.js')
const { account } = require('../forum/_setup.js')
const { eventually } = require('../helpers.js')

const view = (items) => items.map((p) => [p.id, p.title])

test('a newcomer to a space with many logs opens only those active in the periods it reads', async (t) => {
  t.teardown(testing.bigSpaces({ logs: 4 })) // "many logs", for this test: 4 or more
  const a = await account(t, 'a')
  testing.setClock(a, -200 * PERIOD_MS, { decisions: true })
  const fa = await forum.createForum(a, 'Town square')
  testing.setClock(a, 0, { decisions: true })
  const members = []
  for (let i = 0; i < 4; i++) {
    const m = await account(t, `m${i}`)
    members.push(await forum.join(m, await forum.invite(fa)))
  }
  const [old1, old2, new1, new2] = members
  const ago = (hours) => Date.now() - hours * PERIOD_MS
  // two members wrote long ago only; two others and a write now
  await testing.writeRaw(old1, { kind: 'put', type: 'post', stamp: ago(100), fields: { title: 'old one', text: '' } })
  await testing.writeRaw(old2, { kind: 'put', type: 'post', stamp: ago(90), fields: { title: 'old two', text: '' } })
  for (const f of [new1, new2, fa]) {
    await forum.post(f, `new from ${testing.ownLog(f).slice(0, 4)}`, '')
    await forum.post(f, `newer from ${testing.ownLog(f).slice(0, 4)}`, '')
  }
  t.ok(await eventually(async () => (await forum.latest(fa, 50)).length === 8, 10000), 'a holds every post')

  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fa))
  const first = await fd.query('post').latest(6, { timeout: 10000 }) // the newcomer's read asks to wait (spec 012)
  t.ok(first.complete, 'the first page is complete')
  t.alike(view(first.items), view((await fa.query('post').latest(6)).items), 'and the same as a\'s')
  t.ok(testing.reading(fd).byActivity, 'd reads by activity lists')
  const opened = testing.logs(fd)
  t.absent(opened.includes(testing.ownLog(old1)) || opened.includes(testing.ownLog(old2)), 'the logs of members who wrote long ago are not opened')
  t.ok(opened.includes(testing.ownLog(new1)) && opened.includes(testing.ownLog(new2)), 'those of members who wrote now are')

  const all = await fd.query('post').latest(50, { timeout: 10000 })
  t.ok(all.complete, 'reading back to the beginning: complete')
  t.alike(view(all.items), view((await fa.query('post').latest(50)).items), 'every post, as a has them')
  t.ok(testing.logs(fd).includes(testing.ownLog(old1)), 'the old logs were opened when a read went back there')
})
