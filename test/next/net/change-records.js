// Spec 012 US2 (FR-007-FR-009): `change` lists the records whose answer
// changed, `{ id, type, deleted }`, edits included (SwarmFS H16), on the
// writing device and on the others; deleted says how a record went.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account, device } = require('../forum/_setup.js')
const { eventually } = require('../helpers.js')

// Every change entry a space reports, from now on.
function watch (space) {
  const seen = []
  space.on('change', ({ types, records }) => {
    seen.push(...records)
    seen.types = (seen.types || []).concat([[types, records]])
  })
  return seen
}

const entry = (seen, id) => seen.filter((e) => e.id === id).at(-1)

// One person, a laptop and a phone, in one forum.
async function twoDevices (t) {
  const laptop = await account(t, 'laptop')
  const fl = await forum.createForum(laptop, 'Files')
  const { code } = await forum.addDevice(laptop)
  const phone = await device(t, 'phone', code)
  t.ok(await eventually(() => forum.forums(phone).some((f) => f.key === fl.key), 15000), 'the phone has the forum')
  return { laptop, phone, fl, fp: phone.space(fl.key) }
}

test('change lists a put, an edit and a delete, on the writing device and the other', { timeout: 90000 }, async (t) => {
  const { laptop, fl, fp } = await twoDevices(t)
  const here = watch(fl)
  const there = watch(fp)

  const p = await forum.post(fl, 'a', '')
  t.alike(entry(here, p.id), { id: p.id, type: 'post', deleted: null }, 'put: listed here')
  t.ok(await eventually(() => entry(there, p.id), 10000), 'put: listed on the other device')
  t.alike(entry(there, p.id), { id: p.id, type: 'post', deleted: null })

  here.length = there.length = 0
  await forum.edit(fl, p, { title: 'b' })
  t.alike(entry(here, p.id), { id: p.id, type: 'post', deleted: null }, 'edit: listed here')
  t.ok(await eventually(() => entry(there, p.id), 10000), 'edit: listed on the other device (H16)')
  t.is((await fp.get(p.id)).record.title, 'b', 'which shows the edit')

  here.length = there.length = 0
  await forum.remove(fl, p)
  const { record } = await fl.inspect({ record: p.id })
  const deleted = { by: 'author', stamp: record.deletes[0].stamp, device: laptop.device.publicKey }
  t.alike(entry(here, p.id), { id: p.id, type: 'post', deleted }, 'delete: listed here, with its stamp and device')
  t.ok(await eventually(() => entry(there, p.id), 10000), 'delete: listed on the other device')
  t.alike(entry(there, p.id), { id: p.id, type: 'post', deleted })

  for (const [types, records] of there.types) t.alike(types.slice().sort(), [...new Set(records.map((r) => r.type))].sort(), 'types: the distinct types of records')
})

test('change lists moderation: hide and reveal as changes, take-down and ban from as gone by the space', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Moderated')
  const fb = await forum.join(b, await forum.invite(fa))
  const seenB = watch(fb)
  const seenA = watch(fa)
  const p = await forum.post(fb, 'rude', '')
  t.ok(await eventually(async () => (await fa.get(p.id)).record, 10000), 'a holds b\'s post')
  seenB.length = 0 // its put

  await forum.hide(fa, p, 'rude')
  t.ok(await eventually(() => entry(seenB, p.id), 10000), 'hide: listed on b')
  t.is(entry(seenB, p.id).deleted, null)
  seenB.length = 0
  await forum.reveal(fa, p)
  t.ok(await eventually(() => entry(seenB, p.id), 10000), 'reveal: listed on b')
  t.is(entry(seenB, p.id).deleted, null)

  await forum.takeDown(fa, p, 'gone')
  t.ok(await eventually(() => entry(seenB, p.id)?.deleted, 10000), 'take-down: listed on b')
  t.alike(entry(seenB, p.id).deleted, { by: 'space' })

  const s1 = await forum.post(fb, 'spam 1', '')
  const s2 = await forum.post(fb, 'spam 2', '')
  t.ok(await eventually(async () => (await fa.get(s2.id)).record, 10000), 'a holds the spam')
  seenA.length = 0
  await forum.ban(fa, b.identity.publicKey, { from: s1 })
  t.ok(await eventually(() => entry(seenA, s1.id)?.deleted && entry(seenA, s2.id)?.deleted, 10000), 'ban from: both listed on a')
  t.alike(entry(seenA, s1.id).deleted, { by: 'space' })
  t.alike(entry(seenA, s2.id).deleted, { by: 'space' })
})

test('an edit nobody may make is never listed', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Mine')
  const fb = await forum.join(b, await forum.invite(fa))
  const p = await forum.post(fa, 'mine', '')
  t.ok(await eventually(async () => (await fb.get(p.id)).record, 10000), 'b holds a\'s post')
  const seen = watch(fa)
  await testing.writeRaw(fb, { kind: 'edit', type: 'post', target: p.id, fields: { title: 'by b', text: '' } })
  const marker = await forum.post(fb, 'after', '') // indexed after the edit, in the same log
  t.ok(await eventually(() => entry(seen, marker.id), 10000), 'a indexed what b wrote after the edit')
  t.absent(entry(seen, p.id), 'the edit isn\'t listed')
  t.is((await fa.get(p.id)).record.title, 'mine')
})
