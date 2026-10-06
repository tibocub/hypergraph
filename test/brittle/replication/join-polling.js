// A newcomer that starts reading the instant it opens a context still ends
// up reading it right.
//
// The context's index layout is remembered locally once known. A first
// version also concluded "layout 1" when the view was non-empty but held no
// record yet; a joining peer can see exactly that for a moment (the view's
// first block is a header), remembered the wrong layout for good, and read
// nothing ever after (bench/chat.js: 3 newcomers in 5 hung at 0 messages).

const test = require('brittle')
const { createGraph, sleep } = require('../helpers')

async function page (graph, ctx, channel) {
  const out = []
  for await (const e of graph.edges(channel, { direction: 'in', type: 'msg', context: ctx, reverse: true, limit: 50 })) out.push(e)
  return out
}

test('join-polling: newcomers reading from the first moment all reach the latest page', { timeout: 300000 }, async (t) => {
  const owner = await createGraph(t, 'join-poll-owner')
  const ctx = await owner.graph.createContext()
  const octx = await owner.graph.openContext(ctx)
  const channel = (await owner.graph.put({ type: 'channel' })).id
  for (let s = 0; s < 2000; s += 50) { // 40 batches: newcomers fast-forward
    const b = owner.graph.batch()
    for (let i = s; i < s + 50; i++) b.relate({ from: b.put({ type: 'msg' }), to: channel, type: 'msg', context: ctx, data: `m${i}` })
    await b.flush()
  }
  while (octx.view.core.signedLength < octx.view.core.length) { await owner.graph.update(); await sleep(50) }

  for (let n = 0; n < 8; n++) {
    const newcomer = await createGraph(t, `join-poll-newcomer-${n}`)
    const s1 = owner.graph.replicate(true)
    const s2 = newcomer.graph.replicate(false)
    s1.pipe(s2).pipe(s1)
    await newcomer.graph.openContext(ctx)
    let shown = []
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      shown = await page(newcomer.graph, ctx, channel).catch(() => [])
      if (shown[0] && shown[0].data === 'm1999') break
      await sleep(5) // reading as fast as an eager client would
    }
    t.is(shown[0] && shown[0].data, 'm1999', `newcomer ${n} shows the latest page`)
    s1.destroy(); s2.destroy()
  }
})
