// A partition healed after both sides wrote. Three members; c goes
// offline and keeps writing (posts, comments, votes, an edit, a shared note)
// while a and b write too, on the same records; once c is back online, every
// member shows the same posts, comments, scores and versions.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { threeMembers, account, device } = require('./_setup.js')
const { eventually, open } = require('../helpers.js')

const view = async (f, post, note) => {
  const posts = (await forum.latest(f, 50)).map((p) => `${p.title}:${p.text}`).sort()
  const comments = (await forum.comments(f, post)).map((x) => x.text).sort()
  const { record } = await f.get(note.id)
  return JSON.stringify({ posts, comments, score: await forum.score(f, post), note: record && record.text })
}

test('a partition healed after both sides wrote: every member shows the same', { timeout: 120000 }, async (t) => {
  const { c, fa, fb, fc } = await threeMembers(t)
  const p = await forum.post(fa, 'Before', 'written while together')
  const note = await forum.pin(fa, 'the board, v1')
  const mine = await forum.post(fc, 'By c', 'v1')
  t.ok(await eventually(async () => (await view(fa, p, note)) === (await view(fc, p, note)), 10000), 'together first')

  await c.close()
  const c2 = await open(t, { dir: c.dir, types: forum.types, rules: forum.rules })
  const gc = c2.space(fc.key)
  await forum.post(gc, 'Offline post', 'by c')
  await forum.comment(gc, p, 'c, offline')
  await forum.vote(gc, p, -1)
  await forum.edit(gc, mine, { text: 'v2, offline' })
  await forum.edit(gc, note, { text: 'the board, by c offline' })

  await forum.post(fb, 'Online post', 'by b')
  await forum.comment(fa, p, 'a, online')
  await forum.vote(fa, p, 1)
  await forum.vote(fb, p, 1)
  await forum.edit(fb, note, { text: 'the board, by b online' })

  await c2.connectToSwarm()
  const all = [fa, fb, gc]
  const agreed = await eventually(async () => {
    const seen = await Promise.all(all.map((f) => view(f, p, note)))
    return seen.every((x) => x === seen[0]) && seen[0]
  }, 20000)
  t.ok(agreed, 'every member shows the same')
  const v = JSON.parse(agreed || '{}')
  t.alike(v.comments, ['a, online', 'c, offline'], 'both sides\' comments')
  t.is(v.score, 1, 'one vote per member: 1 + 1 - 1')
  t.ok(v.posts && v.posts.includes('By c:v2, offline') && v.posts.includes('Offline post:by c') && v.posts.includes('Online post:by b'), 'both sides\' posts and the edit')
  t.ok(['the board, by c offline', 'the board, by b online'].includes(v.note), 'the shared note: one version wins, the same everywhere')
})

// A private forum hiding its history (a secure conversation), offline for a while.

const shows = async (f, id) => (await forum.latest(f, 50)).some((p) => p.id === id)

async function hiddenClub (t, labels) {
  const a = await account(t, 'a')
  const club = await forum.createForum(a, 'Club', { private: true })
  await club.setHistory('hidden')
  const out = { a, club }
  for (const label of labels) {
    out[label] = await account(t, label)
    out['f' + label] = await forum.join(out[label], await forum.invite(club))
    t.ok(await eventually(() => out['f' + label].status().access === 'full', 15000), `${label}'s key came`) // it reads from there on
  }
  const hello = await forum.post(club, 'hello', '')
  for (const label of labels) t.ok(await eventually(() => shows(out['f' + label], hello.id), 15000), `${label} reads it`)
  return out
}

test('hidden history: a writer offline across a key change writes in its last epoch; members read it when it is back, and so does someone removed meanwhile (the documented limit)', { timeout: 120000 }, async (t) => {
  const { club, c, x, fb, fx } = await hiddenClub(t, ['b', 'c', 'x'])
  await c.close()
  const c2 = await open(t, { dir: c.dir, types: forum.types, rules: forum.rules })
  const gc = c2.space(club.key)
  await forum.removeMember(club, x.identity.publicKey) // c doesn't hear of it
  const after = await forum.post(club, 'after x left', '')
  t.ok(await eventually(() => shows(fb, after.id), 15000), 'b reads the new epoch')
  const offline = await forum.post(gc, 'by c, offline', '')
  await c2.connectToSwarm()
  t.ok(await eventually(() => shows(club, offline.id), 20000), 'a reads c\'s post')
  t.ok(await eventually(() => shows(fb, offline.id), 20000), 'b too')
  t.ok((await testing.sealedWith(club, offline.id)).epoch < (await testing.sealedWith(club, after.id)).epoch, 'sealed in the epoch c held')
  t.ok(await eventually(() => shows(fx, offline.id), 20000), 'the limit: x, removed while c was away, reads what c wrote before hearing of it')
  t.absent(await shows(fx, after.id), 'but nothing sealed after its writer knew')
})

test('hidden history: a record whose skipped key expired comes back from the author\'s other device; a newcomer since and an ex-member get nothing', { timeout: 180000 }, async (t) => {
  const { a, club, b, x, fb, fx } = await hiddenClub(t, ['b', 'x'])
  const { code } = await forum.addDevice(a)
  const phone = await device(t, 'phone', code)
  const fp = await eventually(() => { try { return phone.space(club.key) } catch { return null } }, 15000)
  t.ok(await eventually(async () => { try { return !!(await forum.post(fp, 'phone is in', '')) } catch { return false } }, 20000), 'a\'s phone is in')
  for (const f of [fb, fx]) t.ok(await eventually(async () => (await forum.latest(f, 50)).length === 2, 15000), 'b and x caught up')

  // b and x go offline; on each, a's next two keys are skipped (as if a later block came first), then expire
  const reopen = async (hg) => {
    await hg.close()
    const again = await open(t, { dir: hg.dir, types: forum.types, rules: forum.rules })
    const f = again.space(club.key)
    await f.ready()
    testing.skipKeys(f, testing.ownLog(club), 2)
    testing.expireSkipped(f)
    return { hg: again, f }
  }
  const gb = await reopen(b)
  const gx = await reopen(x)
  await forum.removeMember(club, x.identity.publicKey)
  const p0 = await forum.post(club, 'lost on b 1', '')
  const p1 = await forum.post(club, 'lost on b 2', '')
  const p2 = await forum.post(club, 'deleted before b is back', '')
  await forum.remove(club, p2)
  t.ok(await eventually(async () => (await shows(fp, p0.id)) && (await shows(fp, p1.id)), 15000), 'a\'s phone reads them')
  await a.close() // only the author's other device is left to answer

  await gb.hg.connectToSwarm()
  await gx.hg.connectToSwarm()
  t.ok(await eventually(async () => (await shows(gb.f, p0.id)) && (await shows(gb.f, p1.id)), 40000), 'b asked, and a\'s phone sent their keys: b reads both')
  t.ok(await eventually(async () => (await gb.f.query('post').latest(20)).complete, 15000), 'and its reads are complete')
  t.absent(await shows(gx.f, p0.id), 'x, removed, gets nothing')
  const { log, seq } = require('../../../lib/encodings.js').idParts(p2.id)
  t.is(testing.keyStore(gb.f).keyOf(require('b4a').toString(log, 'hex'), seq), null, 'a deleted record is never resent')

  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fp))
  t.ok(await eventually(() => fd.status().access === 'full', 20000), 'd\'s key came, from a\'s phone')
  const later = await forum.post(fp, 'after d', '')
  t.ok(await eventually(() => shows(fd, later.id), 20000), 'd reads what came after it')
  t.absent(await shows(fd, p0.id), 'not the records from before it joined, resent or not')
})
