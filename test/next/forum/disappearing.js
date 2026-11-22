// Disappearing posts in a private forum hiding its history: past the timer,
// every member's device erases their keys and drops them; a device that may
// decide trims them, so holders free the room too.

const test = require('brittle')
const b4a = require('b4a')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { idParts } = require('../../../lib/encodings.js')
const { account } = require('./_setup.js')
const { eventually, codeOf } = require('../helpers.js')

const shows = async (f, id) => (await forum.latest(f, 50)).some((p) => p.id === id)

test('the timer erases keys on every member, and the deciders trim', { timeout: 120000 }, async (t) => {
  const a = await account(t, 'a')
  const club = await forum.createForum(a, 'Club', { private: true })
  await club.setHistory('hidden')
  await forum.disappearAfter(club, 60000)
  t.is(club.disappearing, 60000)
  const b = await account(t, 'b')
  const fb = await forum.join(b, await forum.invite(club))
  t.ok(await eventually(() => fb.disappearing === 60000, 10000), 'b sees the timer')
  const p = await forum.post(club, 'gone in a minute', '')
  t.ok(await eventually(() => shows(fb, p.id), 15000), 'b reads it')
  const { log, seq } = idParts(p.id)
  const h = b4a.toString(log, 'hex')
  t.ok(testing.keyStore(fb).keyOf(h, seq), 'b keeps its key while it lasts')

  for (const hg of [a, b]) testing.setClock(hg, 120000, { decisions: true })
  await testing.keyWork(club)
  await testing.keyWork(fb)
  t.is(testing.keyStore(fb).keyOf(h, seq), null, 'b erased its key')
  t.is(testing.keyStore(club).keyOf(h, seq), null, 'and so did its author')
  t.absent(await shows(fb, p.id), 'b doesn\'t show it')
  t.absent(await shows(club, p.id), 'nor a')
  t.ok(await eventually(async () => (await club.decisions({ limit: 200 })).items.some((d) => d.type === 'history/trim'), 10000), 'a, who may decide, trimmed it for the holders')
  const q = await forum.post(club, 'new', '')
  t.ok(await eventually(() => shows(fb, q.id), 15000), 'what is new still shows')

  await forum.disappearAfter(club, null)
  t.ok(await eventually(() => fb.disappearing === null, 10000), 'switched off')
  t.is(await codeOf(fb.setDisappearing(60000)), 'NOT_ALLOWED', 'a plain member may not set it')
  await t.exception.all(async () => club.setDisappearing(10), /at least 60000/, 'under a minute: refused')
  const plain = await forum.createForum(a, 'Open')
  t.is(await codeOf(plain.setDisappearing(60000)), 'NOT_ALLOWED', 'only a private forum')
})
