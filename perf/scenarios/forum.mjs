// A forum of N records (10% posts, 60% comments, 30% votes, as bench/next/first-page.js),
// played through the forum reference app (test/next/forum/forum.js) and its test plumbing,
// two members online on a local DHT:
//   forum.write          the owner writing the N records one by one (records/s)
//   forum.post / comment / vote   a member writing one more
//   forum.latest-page    the board's latest 20 posts, read by the member
//   forum.thread         a post with its comments and replies
//   forum.live-update    the owner posts; the member's live latest list shows it
//   forum.first-page     a newcomer redeems an invite and reads a complete first page
//   account.open         signing up (open + online), the newcomer's first step

import { context, time, record, now, eventually, within, sizes } from '../harness.mjs'
import setup from '../../test/next/forum/_setup.js'
import forum from '../../test/next/forum/forum.js'

const CHUNKS = 5

for (const n of sizes([1000, 4000])) {
  const t = context()
  try {
    const a = await setup.account(t, 'a')
    const b = await setup.account(t, 'b')
    const fa = await forum.createForum(a, 'Perf forum')
    const fb = await forum.join(b, await forum.invite(fa))

    // the owner fills the forum, in chunks (one rate per chunk)
    const posts = []
    const targets = []
    const rates = []
    let i = 0
    for (let c = 0; c < CHUNKS; c++) {
      const start = now()
      const end = Math.round((c + 1) * n / CHUNKS)
      const count = end - i
      for (; i < end; i++) {
        const k = i % 10
        if (k === 0 || !posts.length) {
          const p = await forum.post(fa, 'Post ' + i, 'Some text for post ' + i, 'topic' + (i % 7))
          posts.push(p)
          targets.push(p)
        } else if (k < 7) {
          const on = targets[targets.length - 1 - (i % Math.min(targets.length, 20))]
          targets.push(await forum.comment(fa, on, 'A comment ' + i))
        } else {
          await forum.vote(fa, targets[targets.length - 1 - (i % Math.min(targets.length, 50))], i % 3 ? 1 : -1)
        }
      }
      rates.push(count / ((now() - start) / 1000))
    }
    record('forum.write', n, 'records/s', rates, { better: 'higher' })

    // the member holds the latest page
    const newest = posts[posts.length - 1].id
    if (!await eventually(async () => (await forum.latest(fb, 1))[0]?.id === newest, 60000)) throw new Error('the member never saw the newest post')

    const top = posts[posts.length - 1]
    record('forum.post', n, 'ms', await time((j) => forum.post(fb, 'Mine ' + j, 'text', 'topic1'), 20))
    record('forum.comment', n, 'ms', await time((j) => forum.comment(fb, top, 'reply ' + j), 20))
    record('forum.vote', n, 'ms', await time((j) => forum.vote(fb, posts[posts.length - 1 - j], 1), 20))
    record('forum.latest-page', n, 'ms', await time(() => forum.latest(fb, 20), 20))
    record('forum.thread', n, 'ms', await time(() => forum.thread(fb, posts[posts.length - 3]), 10))

    // a live screen on the member's side
    // (waits on the callback itself: a polling timer is ~16 ms on Windows)
    let shown = null
    let wanted = null
    let seen = null
    const stop = forum.liveLatest(fb, (items) => {
      shown = items[0]?.id
      if (wanted && shown === wanted.id) seen()
    })
    const live = []
    for (let j = 0; j < 10; j++) {
      const start = now()
      const showing = new Promise((resolve) => { seen = resolve })
      wanted = await forum.post(fa, 'Live ' + j, 'text', 'topic2')
      if (shown !== wanted.id && await within(showing, 10000, 'timeout') === 'timeout') throw new Error('the live list never showed the post')
      live.push(now() - start)
      wanted = null
    }
    stop()
    record('forum.live-update', n, 'ms', live)

    // newcomers, one after another, each a fresh account (closed after; on the same DHT, so
    // on the same t)
    const opens = []
    const pages = []
    for (let j = 0; j < 3; j++) {
      let c = null
      try {
        let start = now()
        c = await setup.account(t, 'c' + j)
        opens.push(now() - start)
        const link = await forum.invite(fa)
        start = now()
        const fc = await forum.join(c, link)
        let page = null
        do page = await fc.query('post').latest(20, { timeout: 10000 })
        while (!page.complete && now() - start < 60000)
        if (!page.complete) throw new Error('the newcomer\'s first page never completed')
        pages.push(now() - start)
      } finally {
        await c?.close()
      }
    }
    record('account.open', n, 'ms', opens)
    record('forum.first-page', n, 'ms', pages)
  } finally {
    await t.close()
  }
}
