// A private forum's history: its key changes whenever
// someone loses access, and each new key unlocks the ones before it (a key
// chain), so a newcomer reads everything written before it joined — unless
// the forum hides its history (`setHistory('hidden')`): then a newcomer reads
// from its join on, and what came before doesn't count as missing for it.

const test = require('brittle')
const b4a = require('b4a')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('./_setup.js')
const { eventually, codeOf, open } = require('../helpers.js')

const titles = async (f) => (await forum.latest(f, 50)).map((p) => p.title).sort()
const shows = async (f, id) => (await forum.latest(f, 50)).some((p) => p.id === id)

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

// A hidden history is a secure conversation (lib/private/chains.js): each
// post has its own key, keys change for each newcomer and by themselves.

// The prekeys of a forum's members, as `forum` sees them (one row per prekey).
const prekeys = async (f) => (await f.inspect({ records: { type: 'hg/prekey', limit: 1000 } })).rows.items

test('history hidden: each post sealed with its own key; the store keeps no epoch key, and the key changes for every newcomer', { timeout: 120000 }, async (t) => {
  const a = await account(t, 'a')
  const club = await forum.createForum(a, 'Club', { private: true })
  await club.setHistory('hidden')
  const b = await account(t, 'b')
  const fb = await join(club, b)
  const p1 = await forum.post(club, 'one', '')
  const p2 = await forum.post(club, 'two', '')
  t.ok(await eventually(async () => (await titles(fb)).length === 2, 15000), 'b reads both')
  const ks = testing.keyStore(club)
  t.is(testing.epochKeys(club).length > 0, true, 'the first epoch (before the switch) keeps its key: "keep history"')
  t.ok(ks.epochs.size >= 1 && ks.chains.size >= 2, 'a holds chains, one per writer of its epoch')
  const s1 = await testing.sealedWith(fb, p1.id)
  const s2 = await testing.sealedWith(fb, p2.id)
  t.is(s1.scheme, 1, 'sealed with a message key of its writer\'s chain')
  t.alike([s1.epoch, s1.n + 1], [s2.epoch, s2.n], 'two posts, two steps of one chain')
  const before = (await club.inspect()).secure
  const c = await account(t, 'c')
  const fc = await join(club, c)
  const p3 = await forum.post(club, 'three', '')
  t.ok(await eventually(() => shows(fc, p3.id), 15000), 'c reads what came after it joined')
  t.ok((await club.inspect()).secure.epochs > before.epochs, 'a new epoch for c')
  t.alike(await titles(fc), ['three'], 'nothing before')
})

test('history hidden: a copy of a member\'s key store stops reading after two key changes', { timeout: 120000 }, async (t) => {
  const a = await account(t, 'a')
  const club = await forum.createForum(a, 'Club', { private: true })
  await club.setHistory('hidden')
  const b = await account(t, 'b')
  const fb = await join(club, b)
  const p1 = await forum.post(club, 'before the copy', '')
  t.ok(await eventually(() => shows(fb, p1.id), 15000), 'b reads it')
  const copy = await testing.copyKeyStore(fb) // a snapshot of b's engine folder, then b goes on
  t.ok(await testing.opensWith(fb, copy, p1.id), 'the copy opens what b held')
  const bPrekeys = async () => (await prekeys(club)).filter((r) => r.author === b.identity.publicKey).length
  for (let change = 1; change <= 2; change++) {
    const had = await bPrekeys()
    await forum.changeKey(club)
    const p = await forum.post(club, 'after change ' + change, '')
    t.ok(await eventually(() => shows(fb, p.id), 15000), `b reads the post after change ${change}`)
    t.ok(await eventually(async () => (await bPrekeys()) > had, 15000), 'b published a fresh prekey, and a sees it')
    if (change === 1) t.ok(await testing.opensWith(fb, copy, p.id), 'one change later the copy may still read (its grant went to a prekey the copy held)')
    else t.absent(await testing.opensWith(fb, copy, p.id), 'two changes later it reads nothing more')
  }
})

test('history hidden: a key store copied after the disappearing timer opens nothing from a holder\'s blocks', { timeout: 120000 }, async (t) => {
  const a = await account(t, 'a')
  const club = await forum.createForum(a, 'Club', { private: true })
  await club.setHistory('hidden')
  await forum.disappearAfter(club, 60000)
  const b = await account(t, 'b')
  const fb = await join(club, b)
  const p = await forum.post(club, 'gone in a minute', '')
  t.ok(await eventually(() => shows(fb, p.id), 15000), 'b reads it')
  const held = await testing.block(fb, p.id) // a holder's copy of the block, kept for good
  t.ok(await testing.opensWith(fb, await testing.copyKeyStore(fb), p.id, held), 'the documented limit: a copy taken before the timer opens it')
  testing.setClock(b, 120000, { decisions: true })
  await testing.keyWork(fb)
  t.absent(await shows(fb, p.id), 'past the timer b doesn\'t show it')
  t.absent(await testing.opensWith(fb, await testing.copyKeyStore(fb), p.id, held), 'and a copy of its key store taken now opens nothing, from any holder\'s blocks')
})

// A shared type (names, a site's record): every member reads it, newcomers
// too; it is sealed with a key from the disk key, which an ex-member keeps
// until the forum is secured (the documented limit).
test('history hidden: a newcomer reads shared records, not earlier posts; a holder reads neither; an ex-member reads later shared records until secure()', { timeout: 180000 }, async (t) => {
  const a = await account(t, 'a')
  const club = await forum.createForum(a, 'Club', { private: true })
  await club.setHistory('hidden')
  const x = await account(t, 'x')
  const fx = await join(club, x)
  t.ok(await eventually(() => fx.status().access === 'full', 15000), 'x is in')
  const nick = await forum.setNick(club, 'Ann')
  const early = await forum.post(club, 'early', '')
  t.is((await testing.sealedWith(club, nick.id)).scheme, 2, 'the name is sealed for every member')

  const b = await account(t, 'b')
  const fb = await join(club, b)
  t.ok(await eventually(async () => (await forum.nicks(fb)).includes('Ann'), 15000), 'a newcomer reads the name written before it came')
  t.absent(await testing.opens(fb, early.id), 'not the post written before it came')
  t.absent(await shows(fb, early.id))

  const raw = await testing.rawBlock(club, nick.id) // what a holder without the disk key keeps
  t.ok(raw && b4a.indexOf(raw, b4a.from('Ann')) === -1, 'a holder reads the name nowhere in its block')
  const post = await testing.rawBlock(club, early.id)
  t.ok(post && b4a.indexOf(post, b4a.from('early')) === -1, 'nor the post')

  await forum.removeMember(club, x.identity.publicKey)
  const later = await forum.setNick(club, 'Ann, later')
  const secret = await forum.post(club, 'after x left', '')
  t.ok(await eventually(() => testing.holdsBlock(fx, later.id), 15000), 'x still holds the forum\'s blocks')
  t.ok(await testing.opens(fx, later.id), 'the limit: x, removed, reads a shared record written after (it keeps the disk key)')
  t.ok(await eventually(() => testing.holdsBlock(fx, secret.id), 15000))
  t.absent(await testing.opens(fx, secret.id), 'but no post written after')

  const secured = await forum.secure(club)
  const renamed = await forum.setNick(secured, 'Ann, secured')
  t.ok(await eventually(async () => (await forum.nicks(secured)).includes('Ann, secured'), 15000))
  t.ok(await eventually(() => x.space(club.key).moved, 30000), 'x sees the forum moved')
  t.is(x.space(club.key).movedTo, null, 'without learning where')
  t.is(await codeOf(Promise.resolve().then(() => x.space(secured.key))), 'NOT_FOUND', 'secured: x has neither the new space nor its disk key, so no shared record of it')
  t.ok(renamed)
})
