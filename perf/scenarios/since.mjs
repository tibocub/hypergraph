// Spec 021: an unread check over a forum: what a board's dot and a notification cost.
// flat: the cost follows what is new, not the forum's size.
//   since.unread         a member, 20 new posts past its cursor: the check (ms)
//   since.nothing-new    the same check when nothing is new (ms)
//   since.after-restart  the first check after the app restarted, offline (ms)
//   since.held-open      a member holding N other authors' logs (scripted, as logs.mjs): cores open
//                        after a check, after a restart (count). flat: none
//   since.held-logs      that check (ms). Not flat: a look at each held log's numbers, in memory

import hc from 'hypercore-crypto'
import { context, time, record, now, eventually, sizes } from '../harness.mjs'
import setup from '../../test/next/forum/_setup.js'
import forum from '../../test/next/forum/forum.js'
import helpers from '../../test/next/helpers.js'
import testing from '../../lib/testing.js'

const NEW = 20
const WATCHED = { types: ['post', 'comment'], limit: 500 }
const flat = true

for (const n of sizes([2000, 8000])) {
  const t = context()
  try {
    const a = await setup.account(t, 'a')
    const b = await setup.account(t, 'b')
    const fa = await forum.createForum(a, 'Perf forum')
    const fb = await forum.join(b, await forum.invite(fa))
    const key = fa.key

    const targets = []
    let last = null
    for (let i = 0; i < n; i++) { // as forum.mjs: 10% posts, 60% comments, 30% votes
      const k = i % 10
      if (k === 0 || !targets.length) targets.push(last = await forum.post(fa, 'Post ' + i, 'Some text for post ' + i, 'topic' + (i % 7)))
      else if (k < 7) targets.push(last = await forum.comment(fa, targets[targets.length - 1 - (i % Math.min(targets.length, 20))], 'A comment ' + i))
      else await forum.vote(fa, targets[targets.length - 1 - (i % Math.min(targets.length, 50))], i % 3 ? 1 : -1)
    }
    if (!await eventually(async () => !!(await fb.get(last.id)).record, 120000, 50)) throw new Error('the member never caught up')

    const { cursor } = await fb.since(null)
    for (let i = 0; i < NEW; i++) await forum.post(fa, 'New ' + i, 'text', 'topic1')
    const got = await eventually(async () => {
      const res = await fb.since(cursor, WATCHED)
      return res.records.length === NEW && res
    }, 60000, 20)
    if (!got) throw new Error('the new posts never showed')

    record('since.unread', n, 'ms', await time(() => fb.since(cursor, WATCHED), 10, { batch: 10, warmup: 10 }), { flat })
    record('since.nothing-new', n, 'ms', await time(() => fb.since(got.cursor, WATCHED), 10, { batch: 20, warmup: 20 }), { flat })

    await a.close()
    await b.close()
    const restarts = []
    for (let r = 0; r < 3; r++) {
      const again = await setup.account(t, 'b' + r, { dir: b.dir })
      const space = again.space(key)
      await space.ready()
      const start = now()
      const res = await space.since(cursor, WATCHED)
      restarts.push(now() - start)
      if (res.records.length !== NEW) throw new Error(`found ${res.records.length} after a restart, not ${NEW}`)
      await again.close()
    }
    record('since.after-restart', n, 'ms', restarts, { flat })
  } finally {
    await t.close()
  }
}

// Many authors: the check looks at each held log's numbers, opening none.
const t = context()
try {
  const types = { post: { fields: { title: 'string' } } }
  const dir = helpers.tmpDir(t, 'held')
  let hg = await helpers.open(t, { types, label: 'held', dir, bootstrap: null })
  let space = await hg.createSpace({ name: 'Held' })
  const key = space.key
  await space.put('post', { title: 'hello' })
  const author = hc.randomBytes(32)
  await testing.decide(space, { type: 'member/add', identity: author })
  if (!await eventually(() => space.state.isMember(author), 30000)) throw new Error('the member never showed')
  const indexed = async () => (await space.db.find('@hg/logs', { gte: { space: space.keyBytes }, lte: { space: space.keyBytes } }).toArray()).length
  let held = 0
  for (const n of sizes([1000, 5000])) {
    for (; held < n; held++) {
      const core = space.store.get({ name: 'scripted-' + held })
      await core.ready()
      await core.append(['header', 'x'])
      await space.directory.accept(core.key, core, { identity: author, device: hc.randomBytes(32) }, { announce: false })
    }
    if (!await eventually(async () => (await indexed()) >= n, 120000, 200)) throw new Error('the logs were never indexed')
    const { cursor } = await space.since(null)
    await hg.close()
    hg = await helpers.open(t, { types, label: 'held', dir, bootstrap: null })
    space = hg.space(key)
    await space.ready()
    const samples = await time(() => space.since(cursor), 10, { batch: 5, warmup: 5 })
    record('since.held-logs', n, 'ms', samples)
    record('since.held-open', n, 'cores', testing.openLogs(space).length, { flat })
  }
  await hg.close()
} finally {
  await t.close()
}
