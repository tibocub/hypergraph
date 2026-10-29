// Research R13 (spec 012): a reopened member's `complete` must not turn true
// as it reaches its peer again (the peer's list of logs matches) before it
// knows that one of those logs grew. It doesn't: a peer opens its logs before
// joining the space, so Hypercore's length for each comes before the space's
// summary on the same connection. This guards that order. Reads are polled
// tightly while the peer opens and connects, and a read given { timeout }
// waits across it: the first answer that says complete must show what the
// peer wrote meanwhile.

const test = require('brittle')
const forum = require('../forum/forum.js')
const { account } = require('../forum/_setup.js')
const { eventually, sleep } = require('../helpers.js')

const ROUNDS = 5

test('after a reconnect, complete waits for what the peer wrote meanwhile', { timeout: 240000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Reconnect')
  const fb = await forum.join(b, await forum.invite(fa))
  const first = await forum.post(fb, 'first', '')
  t.ok(await eventually(async () => (await fa.get(first.id)).record, 10000), 'a holds b\'s post')
  await a.close()
  await b.close()

  let adir = a.dir
  let bdir = b.dir
  for (let round = 0; round < ROUNDS; round++) {
    const bw = await account(t, `bw${round}`, { dir: bdir })
    const later = await forum.post(bw.space(fa.key), `written while a was away ${round}`, '')
    await bw.close()

    const a2 = await account(t, `a${round}`, { dir: adir })
    const fa2 = a2.space(fa.key)
    t.is((await fa2.query('post').latest(20)).complete, false, `round ${round}: incomplete while b is away`)
    await sleep(2500) // past the grace a just-opened log gets to hear its length (lib/replication.js HEARD_MS)
    const waited = fa2.query('post').latest(20, { timeout: 30000 })
    const opening = account(t, `b${round}`, { dir: bdir }) // reads polled while b opens and connects

    let r = null
    const t0 = Date.now()
    while (Date.now() - t0 < 30000) {
      r = await fa2.query('post').latest(20)
      if (r.complete) break
      await new Promise((resolve) => setImmediate(resolve))
    }
    t.ok(r.complete, `round ${round}: complete once b is back (${Date.now() - t0} ms)`)
    t.is(r.items[0]?.id, later.id, `round ${round}: the first complete read shows what b wrote meanwhile`)

    const w = await waited
    t.ok(w.complete && w.items[0]?.id === later.id, `round ${round}: a read waiting across the reconnect answers complete with it`)
    const b2 = await opening
    await a2.close()
    await b2.close()
    adir = a2.dir
    bdir = b2.dir
  }
})
