// A member polling graph.update() in a tight loop still receives live
// messages. update() with nothing new does no I/O since the idle-update fix,
// so without yielding to the event loop such a loop starved replication:
// the second message never arrived until a third pushed it through.

const test = require('brittle')
const { createGraph } = require('../helpers')

test('live-polling: messages arrive while a member polls update() without pausing', { timeout: 60000 }, async (t) => {
  const member = await createGraph(t, 'live-poll-member')
  const other = await createGraph(t, 'live-poll-other')
  const s1 = member.graph.replicate(true)
  const s2 = other.graph.replicate(false)
  s1.pipe(s2).pipe(s1)
  t.teardown(() => { s1.destroy(); s2.destroy() })

  const ctx = await member.graph.createContext()
  const mctx = await member.graph.openContext(ctx)
  const channel = (await member.graph.put({ type: 'channel' })).id
  const octx = await other.graph.openContext(ctx)
  await mctx.addWriter(octx.localKey, { keyPair: member.graph.identity.deviceKeyPair, member: other.graph.identity.deviceKeyPair.publicKey.toString('hex') })
  while (!octx.writable) await other.graph.update()

  for (let k = 0; k < 5; k++) {
    const msg = await other.graph.put({ type: 'msg' })
    await other.graph.relate({ from: msg.id, to: channel, type: 'msg', context: ctx, data: `live ${k}` })
    const started = Date.now()
    let arrived = false
    while (Date.now() - started < 5000) {
      await member.graph.update() // no sleep: the loop an impatient app writes
      const page = []
      for await (const e of member.graph.edges(channel, { direction: 'in', type: 'msg', context: ctx, reverse: true, limit: 1 })) page.push(e)
      if (page[0] && page[0].from === msg.id) { arrived = true; break }
    }
    t.ok(arrived, `message ${k} arrived (${Date.now() - started} ms)`)
  }
})
