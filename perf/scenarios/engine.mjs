// Spec 015 (US2, SC-001–SC-003): one engine holding N spaces (forums, sites), 5 posts each.
// Only the seeded set (maxAnnounced, default 32) opens with the engine; the others open on
// their first call. Size = spaces held.
//   engine.open        Hypergraph.open on the folder (ms)
//   engine.rss         the process's memory once open, after a GC (MB)
//   engine.open-count  spaces open after Hypergraph.open
//   engine.visit       a closed space's first latest(20): opens it and reads (ms)

import { context, time, record, now, mem } from '../harness.mjs'
import helpers from '../../test/next/helpers.js'
import next from '../../lib/index.js'

const { Hypergraph } = next
const types = { post: { fields: { title: 'string', text: 'text' } } }

for (const n of [100, 500]) {
  const t = context()
  try {
    const dir = helpers.tmpDir(t, 'engine')
    let hg = await Hypergraph.open(dir, { types })
    for (let i = 0; i < n; i++) {
      const s = await hg.createSpace({ name: 'Space ' + i })
      for (let j = 0; j < 5; j++) await s.put('post', { title: 'Hello ' + j, text: 'text' })
      // what a real engine holding n spaces would have: most of them closed (spec 015)
      if (i % 50 === 49) await hg.close().then(async () => { hg = await Hypergraph.open(dir, { types }) })
    }
    await hg.close()

    const base = mem().rss
    const opens = []
    const visits = []
    let rss = 0
    let count = 0
    for (let r = 0; r < 3; r++) {
      const start = now()
      hg = await Hypergraph.open(dir, { types })
      try {
        opens.push(now() - start)
        count = hg.spaces().filter((s) => s.opened).length
        rss = (mem().rss - base) / 1e6
        const closed = hg.spaces().filter((s) => !s.opened)
        visits.push(...await time(async (i) => {
          const page = await hg.space(closed[i].key).query('post').latest(20)
          if (page.items.length !== 5) throw new Error('a space lost its posts')
        }, 3))
      } finally {
        await hg.close()
      }
    }
    record('engine.open', n, 'ms', opens)
    record('engine.rss', n, 'MB', [rss])
    record('engine.open-count', n, 'spaces', [count])
    record('engine.visit', n, 'ms', visits)
  } finally {
    await t.close()
  }
}
