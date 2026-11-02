// A spammer banned with everything they wrote dropped (specs/research/scale-audit.md, perf
// scenario 9), through the forum app (test/next/forum/forum.js), three members on a local
// DHT (setup.threeMembers: a owns the forum, c spams, b reads):
//   mod.ban-drop-all  a spammer wrote N posts; a bans them with dropAll; until b lists none of
//                     them (ms). Three spammers per forum (c, d, e), banned one after another

import { context, record, now, eventually, sizes } from '../harness.mjs'
import setup from '../../test/next/forum/_setup.js'
import forum from '../../test/next/forum/forum.js'

for (const n of sizes([150, 600])) {
  const times = []
  const t = context()
  try {
    const { c, fa, fb, fc } = await setup.threeMembers(t)
    const spammers = [{ hg: c, f: fc }]
    for (const label of ['d', 'e']) {
      const hg = await setup.account(t, label)
      spammers.push({ hg, f: await forum.join(hg, await forum.invite(fa)) })
    }
    const welcome = await forum.post(fa, 'Welcome', '')
    // each spammer writes N posts, the next one after: banned newest first, b's newest post
    // becomes the previous spammer's last (or the welcome)
    const lasts = []
    for (const s of spammers) { let last = null; for (let i = 0; i < n; i++) last = await forum.post(s.f, 'spam ' + i, 'buy now'); lasts.push(last.id) }
    if (!await eventually(async () => (await forum.latest(fb, 1))[0]?.id === lasts[lasts.length - 1], 60000)) throw new Error('b never saw the spam')
    for (let k = spammers.length - 1; k >= 0; k--) {
      const next = k ? lasts[k - 1] : welcome.id
      const start = now()
      await forum.ban(fa, spammers[k].hg.identity.publicKey, { reason: 'spammer', dropAll: true })
      if (!await eventually(async () => (await forum.latest(fb, 1))[0]?.id === next, 60000)) throw new Error('the spam never went')
      times.push(now() - start)
    }
  } finally {
    await t.close()
  }
  record('mod.ban-drop-all', n, 'ms', times)
}
