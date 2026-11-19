// Two claims the design of space.renew() rests on.
// 1. A core written with a new disk key is unreadable with the old one (a renew hides new writes).
// 2. Truncation needs no copy: clearing old blocks keeps the rest readable and verifiable,
//    and a newcomer fetching from a trimmed peer gets the kept blocks only.
// Run: node research/renew/test.js
const test = require('brittle')
const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

function replicate (a, b) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.pipe(s2).pipe(s1)
  return () => { s1.destroy(); s2.destroy() }
}

test('a new disk key: the old one reads nothing of the new core', async (t) => {
  const oldKey = crypto.randomBytes(32)
  const newKey = crypto.randomBytes(32)
  const a = new Corestore(await t.tmp())
  const b = new Corestore(await t.tmp())
  t.teardown(async () => { await a.close(); await b.close() })

  const core = a.get({ name: 'log/renewed', encryption: { key: newKey } })
  await core.append(b4a.from('posted after the renew'))

  const spy = b.get({ key: core.key, encryption: { key: oldKey } })
  await spy.ready()
  const done = replicate(a, b)
  const block = await spy.get(0)
  done()
  t.absent(b4a.toString(block).includes('posted'), 'old key: noise, not the text')
  t.is(block.byteLength, 'posted after the renew'.length, 'still learns the size (why the core keys stay sealed too)')
})

test('truncation without copying: clear old blocks, the rest still verifies', async (t) => {
  const key = crypto.randomBytes(32)
  const a = new Corestore(await t.tmp())
  const c = new Corestore(await t.tmp())
  t.teardown(async () => { await a.close(); await c.close() })

  const core = a.get({ name: 'log', encryption: { key } })
  for (let i = 0; i < 10; i++) await core.append(b4a.from('record ' + i))
  await core.clear(0, 6) // "keep the last N months": blocks before the cutoff go

  t.is(await core.get(0, { wait: false }), null, 'cleared here')
  t.is(b4a.toString(await core.get(7)), 'record 7', 'kept block still reads')

  const late = c.get({ key: core.key, encryption: { key } })
  await late.ready()
  const done = replicate(a, c)
  await late.update({ wait: true })
  t.is(late.length, 10, 'length (and signed tree) unchanged: ids (log, seq) of kept records stay')
  t.is(b4a.toString(await late.get(8)), 'record 8', 'kept block verified and read')
  t.is(await late.get(2, { timeout: 300 }).catch(() => null), null, 'cleared block: nobody serves it')
  done()
})
