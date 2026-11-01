// A chat room with many authors, one process, a local DHT. Size = the number of authors;
// each writes 50 messages of ~500 B. Then:
//   chat.write        every author writing at once (messages/s, all authors together)
//   chat.fan-out      one author sends; every other author's live list shows it
//   chat.newcomer     a newcomer with a small budget (128 KB: it holds part of the room)
//                     joins and reads a complete latest 50
//   chat.scroll-back  the newcomer's next page of 50 (older messages it may not hold)

import { context, time, record, now, within, eventually, sizes } from '../harness.mjs'
import helpers from '../../test/next/helpers.js'

const types = { message: { fields: { text: 'text' } } }
const PER_AUTHOR = 50
const TEXT = 'x'.repeat(480)

for (const n of sizes([3, 9])) {
  const t = context()
  try {
    const owner = await helpers.open(t, { types, label: 'owner' })
    await owner.connectToSwarm()
    const room = await owner.createSpace({ name: 'Chat' })
    const authors = [{ hg: owner, room }]
    for (let i = 1; i < n; i++) {
      const hg = await helpers.open(t, { types, label: 'author' + i })
      await hg.connectToSwarm()
      authors.push({ hg, room: await hg.redeemInvite(await room.createInvite({ role: 'member' })) })
    }

    // everyone writes at once, in 5 rounds (one rate per round)
    let start = 0
    const rates = []
    for (let r = 0; r < 5; r++) {
      start = now()
      await Promise.all(authors.map(async (a, i) => {
        for (let j = 0; j < PER_AUTHOR / 5; j++) await a.room.put('message', { text: `${i}/${r}/${j} ${TEXT}` })
      }))
      rates.push((n * PER_AUTHOR / 5) / ((now() - start) / 1000))
    }
    record('chat.write', n, 'messages/s', rates, { better: 'higher' })
    const total = n * PER_AUTHOR
    // every author holds the whole room before the next part
    for (const a of authors) {
      if (!await eventually(async () => (await a.room.query('message').latest(total)).items.length === total, 60000)) throw new Error('an author never got every message')
    }

    // fan-out: one live list per author but the sender
    const lists = authors.slice(1).map((a) => {
      const l = { shown: null, wanted: null, done: null }
      l.stop = a.room.query('message').live(({ items }) => {
        l.shown = items[0]?.id
        if (l.wanted && l.shown === l.wanted) l.done()
      }, { limit: 20 })
      return l
    })
    const fan = []
    for (let j = 0; j < 5; j++) {
      start = now()
      const waits = lists.map((l) => new Promise((resolve) => { l.done = resolve }))
      const m = await room.put('message', { text: 'ping ' + j })
      for (const l of lists) { l.wanted = m.id; if (l.shown === m.id) l.done() }
      if (await within(Promise.all(waits), 15000, 'timeout') === 'timeout') throw new Error('a member never showed the message')
      fan.push(now() - start)
    }
    for (const l of lists) l.stop()
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
        start = now()
        const cr = await c.redeemInvite(link)
        let page = null
        do page = await cr.query('message').latest(50, { timeout: 10000 })
        while ((!page.complete || page.items.length < 50) && now() - start < 60000)
        if (!page.complete) throw new Error('the newcomer\'s page never completed')
        pages.push(now() - start)
        const last = page.items[page.items.length - 1]
        scrolls.push(...await time(async () => {
          const older = await cr.query('message').latest(50, { after: last, timeout: 10000 })
          if (older.items.length < Math.min(50, total - 50)) throw new Error('scrolling back came short: ' + older.items.length)
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
