// A private forum's history (research.md A16): its key changes whenever
// someone loses access, and each new key unlocks the ones before it (a key
// chain), so a newcomer reads everything written before it joined — unless
// the forum hides its history (`setHistory('hidden')`): then a newcomer reads
// from its join on, and what came before doesn't count as missing for it.
// Removed members never read what is written after their removal, and two
// key changes at once (a partition) leave every post readable.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('./_setup.js')
const { eventually, codeOf, open } = require('../helpers.js')

const titles = async (f) => (await forum.latest(f, 50)).map((p) => p.title).sort()
const shows = async (f, id) => (await forum.latest(f, 50)).some((p) => p.id === id)

// A private forum by a with b as a member; three times someone joins (and
// reads a welcome written once a knows of its device) and is removed (each
// removal changes the key), with a post after each removal.
async function rotated (t, { history } = {}) {
  const a = await account(t, 'a')
  const club = await forum.createForum(a, 'Club', { private: true })
  if (history) await club.setHistory(history)
  const b = await account(t, 'b')
  const fb = await join(club, b)
  const posts = [await forum.post(club, 'epoch 0', '')]
  const removed = []
  for (let i = 1; i <= 3; i++) {
    const x = await account(t, 'x' + i)
    const fx = await join(club, x)
    posts.push(await forum.post(club, 'welcome x' + i, ''))
    t.ok(await eventually(() => shows(fx, posts.at(-1).id), 10000), `x${i} reads the welcome`)
    await forum.removeMember(club, x.identity.publicKey)
    posts.push(await forum.post(club, 'after x' + i, '')) // written after the removal: a new key
    removed.push({ fx, after: posts.at(-1) })
  }
  t.ok(await eventually(async () => (await titles(fb)).length === posts.length, 15000), 'b, a member all along, reads every post')
  return { club, removed, count: posts.length }
}

// Joins `club` and waits until its owner knows of the newcomer's device (the
// moment from which a hidden history is readable).
async function join (club, hg) {
  const f = await forum.join(hg, await forum.invite(club))
  await eventually(() => testing.logs(club).includes(testing.ownLog(f)), 10000)
  return f
}

test('history visible: a newcomer after three key changes reads everything', { timeout: 120000 }, async (t) => {
  const { club, removed, count } = await rotated(t)
  t.is(club.history, 'visible', 'the default')
  const d = await account(t, 'd')
  const fd = await join(club, d)
  t.ok(await eventually(async () => (await titles(fd)).length === count, 15000), 'd reads the posts of every epoch')
  t.ok((await fd.query('post').latest(20)).complete, 'and its answers are complete')
  const later = await forum.post(club, 'after d', '')
  t.ok(await eventually(() => shows(fd, later.id), 10000), 'and new ones')
  for (const [i, { fx, after }] of removed.entries()) {
    t.ok(await eventually(() => testing.holdsBlock(fx, later.id), 10000), `x${i + 1} holds the newest post's block`)
    t.absent(await shows(fx, after.id), `x${i + 1}, removed, can't read what came after its removal`)
    t.absent(await shows(fx, later.id), `nor the newest post`)
  }
})

test('history hidden: a newcomer reads from its join on, complete', { timeout: 120000 }, async (t) => {
  const { club } = await rotated(t, { history: 'hidden' })
  t.is(club.history, 'hidden')
  const d = await account(t, 'd')
  const fd = await join(club, d)
  const later = await forum.post(club, 'after d', '')
  t.ok(await eventually(() => shows(fd, later.id), 10000), 'd reads what is written after it joined')
  t.alike(await titles(fd), ['after d'], 'and nothing from before')
  t.ok(await eventually(async () => (await fd.query('post').latest(20)).complete, 10000), 'what came before doesn\'t count as missing for d')
})

test('only who may decide sets the history, of a private space only', async (t) => {
  const a = await account(t, 'a')
  const closed = await forum.createForum(a, 'Open')
  t.is(await codeOf(closed.setHistory('hidden')), 'NOT_ALLOWED', 'a closed forum has no history to hide')
  const club = await forum.createForum(a, 'Club', { private: true })
  t.is(await codeOf(club.setHistory('sometimes')), 'History is \'visible\' or \'hidden\'')
  const b = await account(t, 'b')
  const fb = await forum.join(b, await forum.invite(club))
  t.is(await codeOf(fb.setHistory('hidden')), 'NOT_ALLOWED', 'a plain member may not')
})

test('two key changes at once (a partition): every post stays readable, for members and newcomers', { timeout: 120000 }, async (t) => {
  const a = await account(t, 'a')
  const club = await forum.createForum(a, 'Club', { private: true })
  const b = await account(t, 'b')
  const fb = await forum.join(b, await forum.invite(club))
  await forum.giveRole(club, b.identity.publicKey, 'admin')
  const xs = []
  for (const label of ['x', 'y']) {
    const x = await account(t, label)
    xs.push({ x, fx: await forum.join(x, await forum.invite(club)) })
  }
  const p0 = await forum.post(club, 'together', '')
  for (const f of [fb, ...xs.map((m) => m.fx)]) t.ok(await eventually(() => shows(f, p0.id), 10000), 'everyone reads it')

  // b goes offline and removes x; a, online, removes y: both change the key from the same epoch
  await b.close()
  const b2 = await open(t, { dir: b.dir, types: forum.types, rules: forum.rules })
  const gb = b2.space(club.key)
  await forum.removeMember(gb, xs[0].x.identity.publicKey)
  const pb = await forum.post(gb, 'by b, offline', '')
  await forum.removeMember(club, xs[1].x.identity.publicKey)
  const pa = await forum.post(club, 'by a, online', '')
  await b2.connectToSwarm()

  const all = ['by a, online', 'by b, offline', 'together']
  t.ok(await eventually(async () => JSON.stringify(await titles(club)) === JSON.stringify(all), 20000), 'a reads b\'s post')
  t.ok(await eventually(async () => JSON.stringify(await titles(gb)) === JSON.stringify(all), 20000), 'b reads a\'s post')
  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(club))
  t.ok(await eventually(async () => JSON.stringify(await titles(fd)) === JSON.stringify(all), 20000), 'a newcomer reads both')
  t.ok(await eventually(() => testing.holdsBlock(xs[0].fx, pb.id), 10000), 'x holds b\'s post\'s block')
  t.absent(await shows(xs[0].fx, pb.id), 'x, removed by b, doesn\'t read b\'s post')
  t.absent(await shows(xs[1].fx, pa.id), 'y, removed by a, doesn\'t read a\'s post')
})
