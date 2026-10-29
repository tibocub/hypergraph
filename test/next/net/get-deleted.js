// Spec 012 US3 (FR-015, FR-016; SwarmFS H15): get() tells "deleted" from
// "not here (yet)": deleted is { by: 'author', stamp, device }, { by: 'space' }
// or null, and only a delete that counts says deleted.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const enc = require('../../../lib/encodings.js')
const { account } = require('../forum/_setup.js')
const { eventually } = require('../helpers.js')

test('get(): deleted by its author, taken down, held, never heard of', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Deleted')
  const fb = await forum.join(b, await forum.invite(fa))
  const mine = await forum.post(fb, 'mine', '')
  const rude = await forum.post(fb, 'rude', '')
  const kept = await forum.post(fb, 'kept', '')
  t.ok(await eventually(async () => (await fa.get(kept.id)).record, 10000), 'a holds b\'s posts')

  await forum.remove(fb, mine)
  const { record } = await fb.inspect({ record: mine.id })
  const expected = { by: 'author', stamp: record.deletes[0].stamp, device: b.device.publicKey }
  t.ok(await eventually(async () => (await fa.get(mine.id)).deleted, 10000), 'a holds the delete')
  const got = await fa.get(mine.id)
  t.is(got.record, null)
  t.alike(got.deleted, expected, 'deleted by its author, with the delete\'s stamp and device')
  t.alike((await fb.get(mine.id)).deleted, expected, 'the same on the author\'s device')

  await forum.takeDown(fa, rude, 'rude')
  t.ok(await eventually(async () => (await fb.get(rude.id)).deleted, 10000), 'b holds the take-down')
  t.alike((await fb.get(rude.id)).deleted, { by: 'space' }, 'taken down')

  const held = await fa.get(kept.id)
  t.is(held.deleted, null, 'a held record: not deleted')
  t.is(held.record.title, 'kept')

  const { log } = enc.idParts(enc.idFromString(kept.id))
  const unknown = await fa.get(enc.idToString({ log, seq: 1e6 })) // b's log, far past its end
  t.is(unknown.record, null)
  t.is(unknown.deleted, null, 'never heard of: not deleted')
})

test('a delete that doesn\'t count is never reported', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Mine')
  const fb = await forum.join(b, await forum.invite(fa))
  const p = await forum.post(fa, 'a\'s', '')
  t.ok(await eventually(async () => (await fb.get(p.id)).record, 10000), 'b holds a\'s post')
  await testing.writeRaw(fb, { kind: 'delete', type: 'post', target: p.id })
  const marker = await forum.post(fb, 'after', '')
  t.ok(await eventually(async () => (await fa.get(marker.id)).record, 10000), 'a indexed what b wrote after its delete')
  const got = await fa.get(p.id)
  t.is(got.record.title, 'a\'s', 'still shown')
  t.is(got.deleted, null, 'not reported as deleted')
})
