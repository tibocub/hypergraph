// Spec 017: a member keeps a held log's core open only while it uses it
// (reads, downloads, a hand-off to helpers), and closes it after an idle
// delay (lowered here: testing.idleLogs). Its length is in the summaries, so
// a peer with more of a closed log is found by the range exchange, and
// "complete" never holds while such a difference is unsettled (FR-005).

const test = require('brittle')
const b4a = require('b4a')
const hc = require('hypercore-crypto')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('../forum/_setup.js')
const { helper, holds } = require('./_helper.js')
const { eventually } = require('../helpers.js')

const IDLE = 300

// `n` made-up logs of two blocks, written at `from` and held by every
// space in `to` (scripted, past the gate, as perf/scenarios/members.mjs
// does): those get them by replication, a length claim each (spec 017).
// Their author: `from`'s member, on devices of its own.
async function script (from, to, n) {
  const someone = { identity: from.hg._identity.publicKey, device: hc.randomBytes(32) }
  for (let i = 0; i < n; i++) {
    const core = from.store.get({ name: 'scripted-' + i })
    await core.append(['header', 'x'])
    await from.directory.accept(core.key, core, someone, { announce: false })
    for (const s of to) await s.directory.accept(core.key, s.store.get({ key: core.key }), someone, { announce: false })
  }
}

// Has `space` heard the summary `other` sends now?
const heard = (space, other) => [...space.directory.channels].some((ch) => ch.theirs === testing.digestOf(other))

async function pair (t) {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  testing.idleLogs(a, IDLE)
  testing.idleLogs(b, IDLE)
  const fa = await forum.createForum(a, 'Big')
  const fb = await forum.join(b, await forum.invite(fa))
  return { a, b, fa, fb }
}

// Watches `space` until `stop()`: did it ever say complete while `present()` was false?
function watch (space, present) {
  let lied = false
  let stopped = false
  const run = async () => {
    while (!stopped) {
      const complete = space.isComplete()
      if (complete && !(await present())) lied = true
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const done = run()
  return async () => { stopped = true; await done; return lied }
}

test('2,000 held logs: few open once idle, none at reopen, reads still work', { timeout: 180000 }, async (t) => {
  const { b, fa, fb } = await pair(t)
  const post = await forum.post(fa, 'hello', 'text')
  t.ok(await eventually(async () => (await forum.latest(fb)).length === 1, 20000), 'b has the post')
  await script(fa, [fb], 2000)
  t.ok(await eventually(() => fb.isComplete() && testing.openLogs(fb).length <= 20, 120000, 100), `caught up and idle: ${testing.openLogs(fb).length} open at b`)
  t.ok(await eventually(() => testing.openLogs(fa).length <= 20, 30000, 100), `idle: ${testing.openLogs(fa).length} open at a`)
  t.ok(testing.logs(fb).length >= 2000, 'every log still held')
  t.ok(await testing.rawBlock(fb, post), 'a closed log\'s block is read')
  t.ok(testing.openLogs(fb).includes(testing.ownLog(fa)), 'opened for the read')
  t.ok(await eventually(() => !testing.openLogs(fb).includes(testing.ownLog(fa)), 10000, 50), 'closed again after the delay')

  await b.close()
  const b2 = await account(t, 'b2', { dir: b.dir })
  testing.idleLogs(b2, IDLE)
  const fb2 = b2.space(fa.key)
  t.alike((await forum.latest(fb2)).map((p) => p.title), ['hello'], 'reopened: the same posts')
  t.is(testing.openLogs(fb2).length, 0, 'reopened: no held log open')
  t.ok(testing.logs(fb2).length >= 2000, `and every log held (${testing.logs(fb2).length})`)
})

test('a record in a log closed at the reader: never complete before it arrives', { timeout: 180000 }, async (t) => {
  const { b, fa, fb } = await pair(t)
  await forum.post(fa, 'first', '')
  t.ok(await eventually(async () => (await forum.latest(fb)).length === 1, 20000))
  await script(fa, [fb], 2000)
  const alog = testing.ownLog(fa)
  t.ok(await eventually(() => !testing.openLogs(fb).includes(alog), 30000, 100), 'a\'s log closed at b')
  t.ok(await eventually(() => fb.isComplete() && testing.openLogs(fb).length <= 20, 120000, 100), 'b complete with the logs closed')

  // from the moment b heard of it (a's summary) until it is in: never complete
  const has = (title) => async () => (await forum.latest(fb, 50)).some((p) => p.title === title)
  testing.slowLists(b, 1500) // the exchange that tells b which log grew takes a while
  const t0 = Date.now()
  await forum.post(fa, 'connected', '')
  t.ok(await eventually(() => heard(fb, fa), 15000, 5), 'b heard a\'s new summary')
  t.absent(fb.isComplete(), 'not complete once it heard')
  const stop = watch(fb, has('connected'))
  t.ok(await eventually(has('connected'), 30000, 50), `arrived in ${Date.now() - t0} ms`)
  testing.slowLists(b, 0)
  t.ok(await eventually(() => fb.isComplete(), 30000, 50), 'complete after')
  t.absent(await stop(), 'never complete before it arrived')
  t.ok(await eventually(() => !testing.openLogs(fb).includes(alog), 30000, 100), 'closed again')

  // written while b is away, met later
  await b.close()
  await forum.post(fa, 'offline', '')
  const b2 = await account(t, 'b2', { dir: b.dir })
  testing.idleLogs(b2, IDLE)
  const fb2 = b2.space(fa.key)
  const has2 = async () => (await forum.latest(fb2, 50)).some((p) => p.title === 'offline')
  await fb2.ready()
  const stop2 = watch(fb2, has2)
  t.ok(await eventually(has2, 60000, 50), 'met later: it arrives')
  t.ok(await eventually(() => fb2.isComplete(), 30000, 50), 'complete after')
  t.absent(await stop2(), 'never complete before it arrived')
})

test('a peer claiming more of a log than anyone serves: not incomplete for ever, and status says who', { timeout: 120000 }, async (t) => {
  const { b, fa, fb } = await pair(t)
  testing.idleLogs(b, IDLE, { claims: 3000 }) // read live by the space
  await forum.post(fa, 'first', '')
  t.ok(await eventually(async () => fb.isComplete() && (await forum.latest(fb)).length === 1, 20000), 'b complete')
  const toB = [...fa.directory.channels][0]
  toB.messages[2].send({ prefix: Buffer.alloc(0), bits: 0, kind: 2, keys: [fa.own.key], lengths: [999] }) // a lie
  t.ok(await eventually(() => !fb.isComplete(), 5000, 20), 'b not complete while the claim stands')
  const warned = () => fb.status().warnings.find((w) => w.code === 'UNSERVED_LENGTH')
  t.ok(await eventually(warned, 20000, 100), 'then status warns')
  t.ok(warned().message.includes(testing.ownLog(fa)), 'naming the log')
  t.ok(await eventually(() => fb.isComplete(), 10000, 50), 'and b is complete again')
})

test('closed logs are handed to the helper, and again when they grow', { timeout: 180000 }, async (t) => {
  const server = await helper(t)
  const { fa } = await pair(t)
  await fa.setHelpers([server.key])
  const made = []
  const someone = { identity: fa.hg._identity.publicKey, device: hc.randomBytes(32) }
  for (let i = 0; i < 100; i++) {
    const core = fa.store.get({ name: 'made-' + i })
    await core.append(['header', 'block ' + i])
    made.push({ key: core.key, length: 2 })
    await fa.directory.accept(core.key, core, someone, { announce: false })
  }
  t.ok(await eventually(() => testing.openLogs(fa).length <= 20, 30000, 100), 'closed once idle')
  const all = async () => { for (const c of made) if (!(await holds(server, c))) return false; return true }
  t.ok(await eventually(all, 60000, 500), 'the helper mirrors all 100')

  const log = fa.directory.logs.get(b4a.toString(made[3].key, 'hex'))
  await fa.directory.use(log, (core) => core.append('grown'))
  t.ok(await eventually(() => holds(server, { key: made[3].key, length: 3 }), 30000, 250), 'and the new block of the one that grew')
})
