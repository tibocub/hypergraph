// A chat room with many authors on a local DHT. Size = the number of authors: the owner here,
// the others each in their own process (perf/scenarios/_author.mjs), as on their own
// machines (in one process every member shares one thread, and adding authors only slows
// everyone down). Each writes 50 messages of ~500 B. Then:
//   chat.write        every author writing at once, until the owner holds it all
//                     (messages/s, the room's total; should grow with authors)
//   chat.fan-out      the owner sends; every author's live list shows it (ms, the last one)
//   chat.newcomer     a newcomer with a small budget (128 KB: it holds part of the room)
//                     joins and reads a complete latest 50
//   chat.scroll-back  the newcomer's next page of 50 (older messages it may not hold)

import path from 'path'
import process from 'process'
import { context, time, record, now, within, eventually, child, sizes } from '../harness.mjs'
import helpers from '../../test/next/helpers.js'
import testing from '../../lib/testing.js'

const types = { message: { fields: { text: 'text' } } }
const ROUNDS = 5
const PER_ROUND = 10 // per author: 50 messages each
const TEXT = 'x'.repeat(480)
const AUTHOR = path.join(path.dirname(process.argv[1]), '_author.mjs') // (no 'url' on Bare here)

for (const n of sizes([3, 9])) {
  const t = context()
  try {
    const owner = await helpers.open(t, { types, label: 'owner' })
    await owner.connectToSwarm()
    const room = await owner.createSpace({ name: 'Chat' })
    const bootstrap = JSON.stringify(await helpers.testBootstrap(t))
    const base = helpers.tmpDir(t, 'authors')
    const authors = []
    for (let i = 1; i < n; i++) {
      const invite = await room.createInvite({ role: 'member' })
      authors.push(child(t, AUTHOR, [bootstrap, invite, String(PER_ROUND), String(ROUNDS)], path.join(base, 'a' + i)))
    }
    for (const a of authors) await a.line('ready')

    // everyone writes at once, round by round (one rate per round)
    const rates = []
    // done when the owner indexed the others' records (a counter: polling a query of
    // hundreds of items would load the owner's thread, and so the measure)
    for (let r = 1; r <= ROUNDS; r++) {
      const before = testing.indexedBlocks(room)
      const start = now()
      for (const a of authors) a.signal('go' + r)
      for (let j = 0; j < PER_ROUND; j++) await room.put('message', { text: `owner/${r}/${j} ${TEXT}` })
      for (const a of authors) await a.line('wrote ' + r)
      if (!await eventually(() => testing.indexedBlocks(room) - before >= (n - 1) * PER_ROUND, 60000, 2)) throw new Error('the owner never got every message')
      rates.push(n * PER_ROUND / ((now() - start) / 1000))
    }
    record('chat.write', n, 'messages/s', rates, { better: 'higher' })

    // fan-out: the owner pings, every author's live list shows it
    const fan = []
    for (let j = 0; j < 5; j++) {
      const sent = Date.now()
      await room.put('message', { text: `ping ${j}` })
      const seen = await within(Promise.all(authors.map((a) => a.line(`saw ping ${j} `, 15000))), 16000, 'timeout')
      if (seen === 'timeout') throw new Error('an author never showed the ping')
      fan.push(Math.max(...seen.map(Number)) - sent)
    }
    record('chat.fan-out', n, 'ms', fan)

    // newcomers, each fresh, with a small budget
    const pages = []
    const scrolls = []
    for (let j = 0; j < 3; j++) {
      let c = null
      try {
        c = await helpers.open(t, { types, label: 'newcomer' + j })
        await c.setBudget(128 * 1024)
        await c.connectToSwarm()
        const link = await room.createInvite({ role: 'member' })
        const start = now()
        const cr = await c.redeemInvite(link)
        let page = null
        do page = await cr.query('message').latest(50, { timeout: 10000 })
        while ((!page.complete || page.items.length < 50) && now() - start < 60000)
        if (!page.complete) throw new Error('the newcomer\'s page never completed')
        pages.push(now() - start)
        const last = page.items[page.items.length - 1]
        scrolls.push(...await time(async () => {
          const older = await cr.query('message').latest(50, { after: last, timeout: 10000 })
          if (older.items.length < Math.min(50, n * ROUNDS * PER_ROUND - 50)) throw new Error('scrolling back came short: ' + older.items.length)
        }, 1))
      } finally {
        await c?.close()
      }
    }
    record('chat.newcomer', n, 'ms', pages)
    record('chat.scroll-back', n, 'ms', scrolls)
  } finally {
    await t.close()
  }
}
