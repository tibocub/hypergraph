// Spec 027 (build.md FR-003, FR-006; design changes 4, 5): trimming a
// space's history. A signed decision every member's device follows (index
// rows and blocks go, kept records keep their ids), and every holder too, by
// a `clear-core` request only a member who handed the core may send. A
// renewed space's holders keep its history logs; the old space goes 30 days
// after the move.

const test = require('brittle')
const crypto = require('hypercore-crypto')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('../forum/_setup.js')
const { eventually, codeOf, sleep } = require('../helpers.js')
const { holdsAll } = require('./_circles.js')

const DAY = 24 * 3600 * 1000
const titles = async (f) => (await forum.latest(f, 50)).map((p) => p.title)

// What `hg` holds of blocks [start, end) of core `key`.
async function holds (hg, key, start, end) {
  const core = hg.store.get({ key })
  await core.ready()
  try {
    return end <= core.length && await core.has(start, end)
  } finally {
    await core.close()
  }
}

test('trim: every member\'s device drops what came before, the rest keeps its ids; for owners and admins', { timeout: 120000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Trimmed') // not private: trimming is for every space
  const fb = await forum.join(b, await forum.invite(fa))
  const old = await forum.post(fa, 'old-1', '')
  await forum.post(fb, 'old-2', '')
  t.ok(await eventually(async () => (await titles(fa)).includes('old-2'), 20000))
  await sleep(20)
  const before = Date.now()
  await sleep(20)
  const kept = await forum.post(fa, 'new-1', '')
  t.ok(await eventually(async () => (await titles(fb)).includes('new-1'), 20000))

  t.is(await codeOf(fb.trimHistory({ before })), 'NOT_ALLOWED', 'a member may not')
  await fa.trimHistory({ before })
  t.alike(await titles(fa), ['new-1'], 'gone here at once')
  t.ok(await eventually(async () => JSON.stringify(await titles(fb)) === '["new-1"]', 20000), 'and on b')
  t.absent(await testing.holdsBlock(fb, old.id), 'b holds no block of it any more')
  t.is((await fb.get(kept.id)).record.title, 'new-1', 'what stays keeps its id')
  await forum.post(fb, 'new-2', '')
  t.ok(await eventually(async () => (await titles(fa)).includes('new-2'), 20000), 'and the space goes on')
})

// a and one holder `h` in a circle, plus `m`, a member who doesn't hold.
async function circle (t) {
  const a = await account(t, 'a')
  const c = await a.createCircle({ name: 'C' })
  const h = await account(t, 'h')
  await forum.join(h, await c.createInvite())
  await h.setHolding({ on: true })
  const m = await account(t, 'm')
  await forum.join(m, await c.createInvite())
  return { a, h, m, c }
}

test('holders follow a trim; a clear from anyone else is refused and the holder keeps serving', { timeout: 240000 }, async (t) => {
  const { a, h, m } = await circle(t)
  const fa = await forum.createForum(a, 'Held', { private: true })
  await forum.post(fa, 'old-h1', '')
  await forum.post(fa, 'old-h2', '')
  const log = fa.own.key
  const other = await forum.createForum(a, 'Other', { private: true })
  await forum.post(other, 'stays', '')
  t.ok(await eventually(() => holdsAll(h, fa), 60000), 'the holder holds the space')
  t.ok(await eventually(() => holdsAll(h, other), 60000), 'and the other one')
  const below = fa.own.core.length // everything so far is trimmed below

  const otherLog = other.own.key
  const end = other.own.core.length
  t.is(await testing.askClear(m, h, otherLog, end), false, 'another member of the circle may not clear it')
  t.is(await testing.askClear(m, h, crypto.randomBytes(32), end), false, 'nor a core nobody handed')
  const o = await account(t, 'o')
  await o.connectToSwarm()
  t.not(await testing.askClear(o, h, otherLog, end), true, 'nor an outsider')
  t.ok(await holds(h, otherLog, 1, end), 'the holder still holds it all')

  await fa.trimHistory({ before: Infinity })
  t.ok(await eventually(async () => !(await holds(h, log, 1, 2)), 30000), 'the holder cleared the trimmed blocks')
  t.ok(await holds(h, log, 0, 1), 'and kept the header')
  await forum.post(fa, 'new-h', '')
  t.ok(await eventually(() => holds(h, log, below, fa.own.core.length), 30000), 'it fetches what comes after, verified')
  await sleep(3000)
  t.absent(await holds(h, log, 1, 2), 'and doesn\'t fetch the trimmed part again')
})

test('a renewed space\'s holders keep its history; the old space goes 30 days after the move', { timeout: 240000 }, async (t) => {
  const { a, h } = await circle(t)
  const fa = await forum.createForum(a, 'Moving', { private: true })
  await forum.post(fa, 'moved-post', '')
  t.ok(await eventually(() => holdsAll(h, fa), 60000), 'held before')
  const oldLog = fa.own.key
  const oldBase = fa.decisionLog.key
  const fresh = await fa.renew()
  await forum.post(fresh, 'after-move', '')
  t.ok(await eventually(() => holdsAll(h, fresh), 60000), 'the holder holds the new space')
  t.ok(await holds(h, oldLog, 0, 2), 'its history logs included')

  testing.setClock(a, 31 * DAY, { decisions: true })
  await testing.dropMoved(a)
  t.absent(a._spaces.has(fa.hex), 'the old space left this device after 30 days')
  t.ok((await titles(fresh)).includes('moved-post'), 'its history stays readable')
  t.ok(await eventually(async () => !(await holds(h, oldBase, 0, 1)), 60000), 'the holder dropped the old decision log')
  t.ok(await holds(h, oldLog, 0, 2), 'not the history')
})
