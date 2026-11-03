// The log directory (research R10, R17): a newcomer learns every member's log
// from any one member; a new log is announced and fetched; a non-member's log
// is neither kept nor passed on; members started at the same moment meet.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account, threeMembers } = require('../forum/_setup.js')
const { eventually, sleep } = require('../helpers.js')

test('a newcomer learns every member\'s log from one member', async (t) => {
  const { b, c, fa, fb, fc } = await threeMembers(t)
  const pb = await forum.post(fb, 'from b', '')
  const pc = await forum.post(fc, 'from c', '')
  t.ok(await eventually(async () => (await forum.latest(fa)).length === 2, 3000), 'a holds both')
  await b.close()
  await c.close()

  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fa))
  t.ok(await eventually(async () => {
    const got = (await forum.latest(fd)).map((p) => p.id)
    return got.includes(pb.id) && got.includes(pc.id)
  }, 5000), 'd sees b\'s and c\'s posts, learned from a alone')
  t.is(testing.logs(fd).length, 2, "d knows b's and c's logs (a and d never wrote: no log yet, spec 016)")

  const pd = await forum.post(fd, 'from d', '')
  t.ok(await eventually(async () => (await forum.latest(fa)).some((p) => p.id === pd.id), 2000), 'd\'s new log reached a')
})

test('a non-member\'s log is neither kept nor passed on', async (t) => {
  const { fa, fb } = await threeMembers(t)
  const e = await account(t, 'stranger')
  const fe = await testing.openSpace(e, fa.key)
  await testing.writeRaw(fe, { kind: 'put', type: 'post', fields: { title: 'spam', text: 'buy now' } })
  const marker = await forum.post(fb, 'real', '')
  await eventually(async () => (await forum.latest(fa)).some((p) => p.id === marker.id), 3000)
  await sleep(1500) // time for e's log to be offered and refused
  for (const f of [fa, fb]) {
    t.absent((await forum.latest(f)).some((p) => p.title === 'spam'), 'no spam shown')
    t.absent(testing.logs(f).includes(testing.ownLog(fe)), 'the stranger\'s log is not in the directory')
  }
  t.is(testing.logs(fa).length, 1, "b's only (a and c never wrote: no log yet, spec 016)")
})

test('a second space joined over a connection already open: its channel opens too', async (t) => {
  // Found in story 3 (research.md A7): Protomux turns down a channel the
  // other side opens before this side has one, so a space opened later on a
  // connection already up never got its channel, and its invite was never
  // heard.
  const { a, b, fa } = await threeMembers(t)
  const p = await forum.post(fa, 'connected', '')
  t.ok(await eventually(async () => (await forum.latest(b.space(fa.key))).some((x) => x.id === p.id), 5000), 'a and b are connected')
  const second = await forum.createForum(a, 'Second')
  const fb2 = await forum.join(b, await forum.invite(second), { timeout: 10000 })
  const q = await forum.post(fb2, 'in the second forum', '')
  t.ok(await eventually(async () => (await forum.latest(second)).some((x) => x.id === q.id), 5000), 'a sees b\'s post in it')
})

test('two members started at the same moment still meet', async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Restart')
  await forum.join(b, await forum.invite(fa))
  await a.close()
  await b.close()

  const [a2, b2] = await Promise.all([account(t, 'a2', { dir: a.dir }), account(t, 'b2', { dir: b.dir })])
  const p = await forum.post(a2.space(fa.key), 'after restart', '')
  t.ok(await eventually(async () => (await forum.latest(b2.space(fa.key))).some((x) => x.id === p.id), 20000), 'b sees a\'s new post')
})

// Routed from the core follow-ups' review: a log whose single announcement
// was missed (a notice lost, a header fetch that timed out) stayed unknown
// until a reconnect. Members now send their summary again when their
// directory changes and every little while.
test('a log whose announcement was missed still arrives: the summary after a change', async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Missed')
  const fb = await forum.join(b, await forum.invite(fa))
  await forum.post(fa, 'from a', '') // a log exists from its first record (spec 016)
  await forum.post(fb, 'from b', '')
  await eventually(async () => testing.logs(fa).length === 2, 5000)
  const restore = testing.deafen(fa, { notices: true }) // a never hears a notice
  t.teardown(restore)
  const c = await account(t, 'c')
  const fc = await forum.join(c, await forum.invite(fa))
  const p = await forum.post(fc, 'from c', '')
  t.ok(await eventually(async () => (await forum.latest(fa)).some((x) => x.id === p.id), 10000), 'a learnt c\'s log without its notice')
  t.ok(await eventually(async () => (await forum.latest(fb)).some((x) => x.id === p.id), 10000), 'b too')
})

test('a log whose announcement was missed still arrives: the summaries settle it', async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Missed')
  const fb = await forum.join(b, await forum.invite(fa))
  await forum.post(fa, 'from a', '') // a log exists from its first record (spec 016)
  await forum.post(fb, 'from b', '')
  await eventually(async () => testing.logs(fa).length === 2, 5000)
  // a hears no notices and no summaries while c joins and posts: the
  // summary a sends still differs from b's and c's, and they settle the
  // difference with it by ranges (spec 016: either side's summary starts it)
  const restore = testing.deafen(fa, { notices: true, summaries: true })
  t.teardown(restore)
  const c = await account(t, 'c')
  const fc = await forum.join(c, await forum.invite(fa))
  const p = await forum.post(fc, 'from c', '')
  t.ok(await eventually(async () => testing.logs(fc).length === 3 && testing.logs(b.space(fa.key)).length === 3, 10000), 'b and c know every log')
  t.ok(await eventually(async () => (await forum.latest(fa)).some((x) => x.id === p.id), 25000), 'a learnt the log of c, deaf to notices and summaries, connections untouched')
  t.ok(restore.dropped.length > 0, 'a did drop summaries')
})

// Found by bench/next/first-page.js (story 9): a newcomer said "complete" as
// soon as a member's summary arrived, before it had looked at that member's
// list of logs, so a first page could be complete and wrong.
test('a newcomer is not complete before it has looked at a member\'s list of logs', async (t) => {
  const { fa, fb, fc } = await threeMembers(t)
  for (const f of [fa, fb, fc]) await forum.post(f, 'hello', '')
  t.ok(await eventually(async () => (await forum.latest(fa)).length === 3, 5000))
  const d = await account(t, 'd')
  testing.slowLists(d, 1500) // the lists arrive late
  const fd = await forum.join(d, await forum.invite(fa))
  const first = await fd.query('post').latest(20, { timeout: 0 })
  t.ok(!first.complete || first.items.length === 3, `never complete with fewer posts (${first.items.length}, complete ${first.complete})`)
  const later = await fd.query('post').latest(20, { timeout: 10000 })
  t.ok(later.complete, 'complete once the list was looked at')
  t.is(later.items.length, 3)
})

// Found by bench/next/first-page.js (story 9): the indexer counted blocks as
// looked at before their batch was committed, so a read in between said
// "complete" without the newest records.
test('a read is not complete while what was looked at is still being committed', async (t) => {
  const a = await account(t, 'a')
  const fa = await forum.createForum(a, 'Busy')
  for (let i = 0; i < 10; i++) await forum.post(fa, `post ${i}`, '')
  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fa))
  t.ok(await eventually(async () => (await fd.query('post').latest(20, { timeout: 0 })).complete, 10000), 'd holds the forum')
  testing.slowCommits(d, 300) // d's disk gets slow
  let newest = null
  for (let i = 0; i < 5; i++) newest = await forum.post(fa, `new ${i}`, '')
  const until = Date.now() + 8000
  let seen = false
  while (Date.now() < until && !seen) {
    const r = await fd.query('post').latest(20, { timeout: 0 })
    if (r.complete) t.is(r.items[0].id, newest.id, 'a complete page starts with the newest post')
    seen = r.complete
    await sleep(10)
  }
  t.ok(seen, 'it becomes complete')
})

// Spec 016 (US5, research R7): a difference in the log lists is settled by
// key ranges, so one new log costs about a key, not the whole list.
test('2,000 logs each, one new log: settled by ranges in under 3 KB', { timeout: 90000 }, async (t) => {
  const crypto = require('hypercore-crypto')
  const c = require('compact-encoding')
  const enc = require('../../../lib/encodings.js')
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Big')
  const link = await forum.openLink(fa)
  const fb = await forum.join(b, link)
  // 2,000 logs both hold (scripted: keys in both directories, no content)
  const who = { identity: crypto.randomBytes(32), device: crypto.randomBytes(32) }
  for (let i = 0; i < 2000; i++) {
    const key = crypto.randomBytes(32)
    for (const f of [fa, fb]) await f.directory.accept(key, f.store.get({ key }), who, { announce: false })
  }
  t.ok(await eventually(() => testing.digestOf(fa) === testing.digestOf(fb), 10000), 'the same lists')
  // count what a and b send each other on their space channel from now on
  let bytes = 0
  const codecs = [enc.summary, enc.ranges, enc.keys]
  const toward = (f, peer) => [...f.directory.channels].find((ch) => ch.peer && ch.peer.equals(peer))
  for (const ch of [toward(fa, fb.hg._identity.device.publicKey), toward(fb, fa.hg._identity.device.publicKey)]) {
    for (let i = 1; i <= 2; i++) {
      const send = ch.messages[i].send.bind(ch.messages[i])
      ch.messages[i].send = (m) => { bytes += c.encode(codecs[i], m).byteLength; return send(m) }
    }
  }
  const learnt = []
  const consider = fb.directory.consider.bind(fb.directory)
  fb.directory.consider = (k, urgent) => { learnt.push(k); return consider(k, urgent) }
  const fresh = crypto.randomBytes(32) // a new log at a, never announced: only the ranges tell b
  await fa.directory.accept(fresh, fa.store.get({ key: fresh }), who, { announce: false })
  t.ok(await eventually(() => learnt.some((k) => k.equals(fresh)), 30000), 'b learnt the new log from a by ranges')
  await sleep(1000) // the exchanges both summaries started are over
  t.alike([...new Set(learnt.map((k) => k.toString('hex')))], [fresh.toString('hex')], 'and nothing else') // once per exchange: both summaries start one
  t.ok(bytes < 3000, `${bytes} bytes of ranges and keys`)
})

test('a peer of the previous version: no channel, OTHER_VERSION in status()', { timeout: 60000 }, async (t) => {
  const Hyperswarm = require('hyperswarm')
  const Protomux = require('protomux')
  const { OTHER_PROTOCOL } = require('../../../lib/directory.js')
  const { testBootstrap } = require('../helpers.js')
  const a = await account(t, 'a')
  const fa = await forum.createForum(a, 'New')
  t.absent(fa.status().warnings.some((w) => w.code === 'OTHER_VERSION'))
  const swarm = new Hyperswarm({ bootstrap: await testBootstrap(t) })
  let opened = false
  swarm.on('connection', (conn) => {
    conn.on('error', () => {})
    const ch = Protomux.from(conn).createChannel({ protocol: OTHER_PROTOCOL, id: fa.discoveryKey, onopen () { opened = true } })
    if (ch) ch.open()
  })
  const discovery = swarm.join(fa.discoveryKey, { server: false, client: true })
  t.teardown(async () => {
    await swarm.destroy({ force: true })
    await discovery.destroy()
  }, { order: 0 })
  t.ok(await eventually(() => fa.status().warnings.some((w) => w.code === 'OTHER_VERSION'), 20000), 'a warns')
  t.absent(opened, 'the old channel never opened')
  t.is(fa.directory.channels.size, 0, 'no space channel with it')
})
