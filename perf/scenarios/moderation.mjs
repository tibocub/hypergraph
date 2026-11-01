// A spammer banned with everything they wrote dropped (specs/research/scale-audit.md, perf
// scenario 9), through the forum app (test/next/forum/forum.js), three members on a local
// DHT (setup.threeMembers: a owns the forum, c spams, b reads):
//   mod.ban-drop-all  c wrote N posts; a bans c with dropAll; until b lists none of them (ms)

import { context, record, now, eventually, sizes } from '../harness.mjs'
import setup from '../../test/next/forum/_setup.js'
import forum from '../../test/next/forum/forum.js'

for (const n of sizes([300, 1200])) {
  const times = []
  for (let r = 0; r < 1; r++) { // one: a forum of three accounts per run is the cost
    const t = context()
    try {
      const { c, fa, fb, fc } = await setup.threeMembers(t)
      const welcome = await forum.post(fa, 'Welcome', '')
      let last = null
      for (let i = 0; i < n; i++) last = await forum.post(fc, 'spam ' + i, 'buy now')
      if (!await eventually(async () => (await forum.latest(fb, 1))[0]?.id === last.id, 60000)) throw new Error('b never saw the spam')
      const start = now()
      await forum.ban(fa, c.identity.publicKey, { reason: 'spammer', dropAll: true })
      if (!await eventually(async () => (await forum.latest(fb, 1))[0]?.id === welcome.id, 60000)) throw new Error('the spam never went')
      times.push(now() - start)
    } finally {
      await t.close()
    }
  }
  record('mod.ban-drop-all', n, 'ms', times)
}
