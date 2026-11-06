# Testing your app

`require('hypergraph/testing')` (spec 018) gives your tests what hypergraph's own use: a small DHT on your
machine for each test, temp folders, instances closed after the test, and waits that leave no timer behind.
Your tests need no internet, and they test with the hyperdht version hypergraph tests with.

## A two-member test

```js
const test = require('brittle')   // or node:test
const { open, eventually } = require('hypergraph/testing')

const types = { post: { fields: { title: 'string' } } }

test('bob reads ann\'s post', async (t) => {
  const ann = await open(t, { types })
  const bob = await open(t, { types })
  const club = await ann.createSpace({ name: 'Club' })
  const bobs = await bob.redeemInvite(await club.createInvite())
  await club.put('post', { title: 'hello' })
  t.ok(await eventually(async () => (await bobs.query('post').latest(10)).items.length === 1, 15000))
})
```

Both are online on the test's own DHT; after the test, they are closed, the DHT stopped and their folders
deleted. The test file exits on its own.

## What it gives

| Call | What |
|---|---|
| `open(t, opts?)` | a `Hypergraph`, online, in a new temp folder (`opts.dir`: reopen one, e.g. a restart); `hg.dir` is its folder; other options go to `Hypergraph.open` |
| `bootstrap(t)` | the test's DHT, for an app that opens its own wrapper: `MyApp.open(dir, { bootstrap: await bootstrap(t) })` |
| `tmpDir(t, label?)` | a new empty folder, deleted after the test |
| `eventually(fn, ms = 5000, every = 25)` | calls `fn` until it returns something truthy: that value, or `null` after `ms` |
| `within(promise, ms, fallback = null)` | the promise's value, or `fallback` after `ms` |
| `codeOf(promise)` | the error code it rejects with (`'INVITE_EXPIRED'`…), or `null` if it resolves |
| `sleep(ms)` | waits |

At the end of a test, whatever order things were made in: instances close first (each bounded to 10 s),
then the DHT stops, then folders go (with retries: Windows keeps files locked a moment). Close your own
wrapper yourself, in your runner's teardown; it runs before these.

`t` is your runner's test object: anything with `teardown(fn)` (brittle) or `after(fn)` (`node:test`).
The helper doesn't load brittle.

**`HG_TEST_PUBLIC_DHT=1`** runs the same tests on the public DHT (`bootstrap(t)` is then `undefined`). Run
files one at a time then: several bootstrapping on the internet at once time out.

**Use `within`, not `Promise.race([x, sleep(n)])`**: the race leaves the timer running, which keeps the test
process alive until it fires.

Not in it: hypergraph's own test hooks (`hypergraph/lib/testing.js`), which go around the API's checks to
play a misbehaving peer. Your app's tests shouldn't need them.

## Moving an existing app's tests to it

SwarmFS's and the forum example's `test/helpers.js` copied these pieces. To switch: delete their
`eventually`, `codeOf`, `tmpDir` and DHT code, import them from `hypergraph/testing`, and drop the app's own
`hyperdht` pin and override (hypergraph brings it). Their `eventually` waited 10 s by default: pass `ms` where
a test relied on it.
