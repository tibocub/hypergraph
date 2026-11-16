// The circle crash (HyperBrowser 018, 2026-11-16): with 3 circles and 7+
// people joining with holding on, Autobase threw Writer._loadNextNode
// ('node' of null), uncaught, and the process died. A holder's blind peer
// announced every handed core (message logs too) on the space's Autobase
// wakeup topic as a writer; a member's decision log opened a message log as a
// writer and read its block 0 while the directory cleared it (a log it could
// not accept yet); our 'error' listener (safetyCatch) re-threw the TypeError.

const test = require('brittle')
const process = require('process') // Bare: bare-process (package.json imports)
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('../forum/_setup.js')
const { eventually } = require('../helpers.js')
const { holdsAll } = require('./_circles.js')

function watchUncaught (t) {
  const uncaught = []
  const onerr = (err) => uncaught.push(err)
  process.on('uncaughtException', onerr)
  process.on('unhandledRejection', onerr)
  t.teardown(() => { process.off('uncaughtException', onerr); process.off('unhandledRejection', onerr) })
  return uncaught
}

test('a holder keeps no referrer: no wakeup announces of handed cores as decision writers', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const circle = await a.createCircle({ name: 'Family' })
  await forum.join(b, await circle.createInvite())
  const s = await a.createSpace({ name: 'talk', private: true })
  await forum.post(s, 'hello', 'x') // its log has data
  const keys = [...(await testing.coreKeys(s)).values()]
  await b.setHolding({ on: true })
  t.ok(await eventually(() => holdsAll(b, s, keys), 60000), 'b holds a\'s space')
  const db = b._circles.server.db
  let records = 0
  for (const key of keys) {
    const r = await db.getCoreRecord(key)
    if (!r) continue
    records++
    t.absent(r.referrer, 'no referrer in blind-peer\'s record (it would announce the core on the space\'s wakeup topic)')
  }
  t.ok(records > 0, 'records checked')
})

test('an Autobase error is a space warning, never the end of the process', { timeout: 60000 }, async (t) => {
  const uncaught = watchUncaught(t)
  const a = await account(t, 'a')
  const s = await a.createSpace({ name: 'talk', private: true })
  const told = new Promise((resolve) => s.on('status', (st) => { if (st.warnings.some((w) => w.code === 'DECISIONS_FAILED')) resolve(st) }))
  s.decisionLog.base._onError(new TypeError("Cannot destructure property 'node' of null")) // Autobase's own error path
  const st = await told
  t.ok(st.warnings.find((w) => w.code === 'DECISIONS_FAILED').message.includes("'node' of null"), 'the warning says why')
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.is(uncaught.length, 0, 'nothing uncaught')
})

test('a log named to another space\'s directory keeps the header it had', { timeout: 60000 }, async (t) => {
  const a = await account(t, 'a')
  const s1 = await a.createSpace({ name: 'one' })
  const s2 = await a.createSpace({ name: 'two' })
  await forum.post(s2, 'hello', 'x') // its log's header written
  await s2.ready()
  const own = s2.own.core
  t.ok(await own.has(0), 'its header')
  await s1.directory.consider(own.key) // any peer can name a key (a notice); refused: another space's
  t.ok(s1.directory.refused.has(own.key.toString('hex')), 'refused')
  t.ok(await own.has(0), 'still there: not cleared by the refusal')
})

test('3 circles, 8 people join all three, holding on: nothing uncaught', { timeout: 600000 }, async (t) => {
  const uncaught = watchUncaught(t)
  const a = await account(t, 'a')
  await a.setHolding({ on: true })
  const circles = []
  for (let i = 0; i < 3; i++) circles.push(await a.createCircle({ name: 'C' + i }))
  for (let p = 0; p < 8; p++) {
    const hg = await account(t, 'p' + p)
    for (const c of circles) {
      await forum.join(hg, await c.createInvite())
      await hg.setHolding({ on: true })
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 5000))
  t.is(uncaught.length, 0, 'nothing uncaught')
  for (const c of circles) t.absent(c.status().warnings.some((w) => w.code === 'DECISIONS_FAILED'), 'decisions running')
})
