// Spec 018: hypergraph/testing, the test helper for apps. Required by its
// package name, as an app does.

const test = require('brittle')
const fs = require('fs')
const process = require('process')
const { open, bootstrap, tmpDir, within, eventually, codeOf } = require('hypergraph/testing')

const types = { post: { fields: { title: 'string' } } }

test('a two-member test in a few lines', { timeout: 60000 }, async (t) => {
  const ann = await open(t, { types })
  const bob = await open(t, { types })
  const club = await ann.createSpace({ name: 'Club' })
  const bobs = await bob.redeemInvite(await club.createInvite())
  await club.put('post', { title: 'hello' })
  const seen = await eventually(async () => (await bobs.query('post').latest(10)).items.length === 1, 15000)
  t.ok(seen, 'bob reads ann\'s post')
  t.not(ann.dir, bob.dir, 'each in its own folder')
})

// A runner's test object, its end played by hand.
function fakeTest (kind = 'teardown') {
  const ends = []
  return { [kind]: (fn) => ends.push(fn), end: async () => { for (const fn of ends) await fn() }, ends }
}

test('folders, the DHT and the cleanup: one per test, run at its end', { skip: !!process.env.HG_TEST_PUBLIC_DHT }, async (t) => {
  const ft = fakeTest()
  const a = tmpDir(ft, 'x')
  const b = tmpDir(ft, 'y')
  t.ok(fs.existsSync(a) && fs.existsSync(b) && a !== b, 'two empty folders')
  const first = await bootstrap(ft)
  t.alike(await bootstrap(ft), first, 'one DHT per test')
  t.is(first.length, 1)
  t.is(ft.ends.length, 1, 'one cleanup registered')
  await ft.end()
  t.absent(fs.existsSync(a) || fs.existsSync(b), 'folders removed')
})

test('node:test-style tests (only after()) work; others are refused', async (t) => {
  const ft = fakeTest('after')
  const dir = tmpDir(ft)
  await ft.end()
  t.absent(fs.existsSync(dir))
  t.exception.all(() => tmpDir({}), /teardown\(fn\) or after\(fn\)/)
})

test('HG_TEST_PUBLIC_DHT=1: the public DHT, no local one', async (t) => {
  const ft = fakeTest()
  const was = process.env.HG_TEST_PUBLIC_DHT
  process.env.HG_TEST_PUBLIC_DHT = '1'
  try {
    t.is(await bootstrap(ft), undefined)
  } finally {
    if (was === undefined) delete process.env.HG_TEST_PUBLIC_DHT
    else process.env.HG_TEST_PUBLIC_DHT = was
  }
  t.is(ft.ends.length, 0, 'nothing to clean up')
})

test('within, eventually, codeOf', async (t) => {
  t.is(await within(new Promise(() => {}), 20, 'late'), 'late', 'the fallback when time is up')
  // a timer left behind would keep this file running for a minute
  t.is(await within(Promise.resolve('now'), 60000), 'now')
  t.is(await eventually(() => false, 50), null, 'null when it never happens')
  t.is(await eventually(() => 7), 7)
  t.is(await codeOf(Promise.reject(Object.assign(new Error('no'), { code: 'NOPE' }))), 'NOPE')
  t.is(await codeOf(Promise.resolve()), null)
})
