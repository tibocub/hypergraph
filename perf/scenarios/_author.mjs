// One chat author in its own process, for chat.mjs (a member on another machine, in effect).
//   <runtime> _author.mjs <control dir> <bootstrap json> <invite> <per round> <rounds>
// Joins and prints 'ready'; on each signal 'go<r>' writes its share of round r; prints
// 'saw <text> <Date.now()>' when a 'ping' tops its live list; closes on 'stop'.

import process from 'process'
import path from 'path'
import { signalled } from '../harness.mjs'
import next from '../../lib/index.js'

const [dir, bootstrapJson, invite, perRound, rounds] = process.argv.slice(2)
const types = { message: { fields: { text: 'text' } } }
const TEXT = 'x'.repeat(480)

const hg = await next.Hypergraph.open(path.join(dir, 'hg'), { types, bootstrap: JSON.parse(bootstrapJson) })
await hg.connectToSwarm()
const room = await hg.redeemInvite(invite)
const stop = room.query('message').live(({ items }) => {
  const top = items[0]?.text
  if (top && top.startsWith('ping')) console.log(`saw ${top} ${Date.now()}`)
}, { limit: 20 })
console.log('ready')
for (let r = 1; r <= Number(rounds); r++) {
  await signalled(dir, 'go' + r)
  for (let j = 0; j < Number(perRound); j++) await room.put('message', { text: `${dir}/${r}/${j} ${TEXT}` })
  console.log('wrote ' + r)
}
await signalled(dir, 'stop')
stop()
await hg.close()
