// Opening an account that is in N spaces (forums, chats, sites), each with a few records:
// what an app pays at start-up. Size = the number of spaces.
//   spaces.create   creating one more space (ms each)
//   spaces.reopen   Hypergraph.open on the account's folder, every space open (the app's start)
//   spaces.online   then connectToSwarm, until the first space's query answers
//   spaces.read     the latest 20 of every space, one after another, after reopening

import { context, time, record, now, sizes } from '../harness.mjs'
import helpers from '../../test/next/helpers.js'
import next from '../../lib/index.js'

const { Hypergraph } = next
const types = { post: { fields: { title: 'string', text: 'text' } } }

for (const n of sizes([20, 80])) {
  const t = context()
  try {
    const dir = helpers.tmpDir(t, 'spaces')
    const bootstrap = await helpers.testBootstrap(t)
    let hg = await Hypergraph.open(dir, { types, bootstrap })
    const creates = await time(async (i) => {
      const s = await hg.createSpace({ name: 'Space ' + i })
      for (let j = 0; j < 5; j++) await s.put('post', { title: 'Hello ' + j, text: 'text' })
    }, n)
    record('spaces.create', n, 'ms', creates)
    await hg.close()

    const reopens = []
    const onlines = []
    const reads = []
    for (let r = 0; r < 3; r++) {
      let start = now()
      hg = await Hypergraph.open(dir, { types, bootstrap })
      try {
        if (hg.spaces().length !== n) throw new Error(`reopened with ${hg.spaces().length} spaces, not ${n}`)
        reopens.push(now() - start)
        start = now()
        await hg.connectToSwarm()
        await hg.space(hg.spaces()[0].key).query('post').latest(20)
        onlines.push(now() - start)
        start = now()
        for (const s of hg.spaces()) {
          const page = await hg.space(s.key).query('post').latest(20)
          if (page.items.length !== 5) throw new Error('a space lost its posts')
        }
        reads.push(now() - start)
      } finally {
        await hg.close()
      }
    }
    record('spaces.reopen', n, 'ms', reopens)
    record('spaces.online', n, 'ms', onlines)
    record('spaces.read', n, 'ms', reads)
  } finally {
    await t.close()
  }
}
