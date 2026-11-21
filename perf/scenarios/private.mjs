// A private forum of N records (10% posts, 50% short chat lines, 15% comments, 25% votes), the
// owner writing, a member reading, on a local DHT. Private blocks are padded (256 B minimum, then
// Padmé): this follows what it costs.
//   private.write   the owner writing the N records one by one (records/s)
//   private.read    the member's latest 20 posts, once it holds everything (ms)
//   private.bytes   the owner's log as stored, per record (B/record; the padding's cost)

import { context, time, record, now, eventually, sizes } from '../harness.mjs'
import setup from '../../test/next/forum/_setup.js'
import forum from '../../test/next/forum/forum.js'
import testing from '../../lib/testing.js'

const words = 'the a of to and in is it you that was for on are with as I his they be at one have this from'.split(' ')
let seed = 7
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
const text = (median) => {
  const n = Math.max(1, Math.round(median * Math.exp(Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand()))))
  let s = ''
  while (s.length < n) s += words[Math.floor(rand() * words.length)] + ' '
  return s.slice(0, n)
}

for (const n of sizes([500])) {
  const t = context()
  try {
    const a = await setup.account(t, 'a')
    const b = await setup.account(t, 'b')
    const fa = await forum.createForum(a, 'Perf club', { private: true })
    const fb = await forum.join(b, await forum.invite(fa))

    const posts = [await forum.post(fa, text(40).slice(0, 80), text(600), 'general')]
    const start = now()
    for (let i = 1; i < n; i++) {
      const r = rand()
      if (r < 0.1) posts.push(await forum.post(fa, text(40).slice(0, 80), text(600), 'general'))
      else if (r < 0.6) await forum.comment(fa, posts[posts.length - 1], text(40))
      else if (r < 0.75) await forum.comment(fa, posts[posts.length - 1], text(150))
      else await forum.vote(fa, posts[Math.floor(rand() * posts.length)], 1)
    }
    record('private.write', n, 'records/s', n / ((now() - start) / 1000), { better: 'higher' })

    const own = fa.own
    if (!await eventually(() => testing.indexedBlocks(fb) >= own.length - 1, 120000, 20)) throw new Error('the member never got every record')
    record('private.read', n, 'ms', await time(() => forum.latest(fb), 10, { warmup: 2 }))
    record('private.bytes', n, 'B/record', own.core.byteLength / (own.length - 1))
  } finally {
    await t.close()
  }
}
