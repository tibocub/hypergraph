// v2 prototype: the rest of the community stays out of the way (spec 007, US5, SC-005).
// A member holds open only what it reads: the logs and rosters of the
// channels it has open, whatever the community's channel count, and closing
// a channel releases them.

const test = require('brittle')
const { member, link, until, sleep } = require('./_helpers')

test('v2 idle: only open channels hold logs and rosters; closing a channel releases them', async (t) => {
  const owner = await member(t, 'idle-owner')
  const channels = []
  for (let i = 0; i < 50; i++) {
    const id = await owner.community.createChannel({ name: `c${i}`, segmentMs: 60000 })
    await owner.community.keep(id)
    channels.push(id)
  }
  for (const id of channels) await owner.community.post(id, 'hello')

  const reader = await member(t, 'idle-reader', { key: owner.community.key })
  t.teardown(link(owner, reader))
  await until(async () => { await reader.community.update(); return reader.community.channels().length === 50 })
  const before = await reader.community.stats()
  t.is(before.openLogs, 0, 'nothing open before reading')
  t.is(before.rosterKeepers, 0, 'no roster open before reading')

  const open = channels.slice(0, 5)
  for (const id of open) t.ok(await until(async () => (await reader.community.latest(id, { timeout: 2000 })).length === 1), 'read a channel')
  const stops = open.map(id => reader.community.follow(id, () => {}))
  t.teardown(() => stops.forEach(stop => stop()))
  await sleep(600)
  const reading = await reader.community.stats()
  t.is(reading.openLogs, 5, 'five channels read: five logs open, not fifty')
  t.is(reading.rosterKeepers, 5, 'and five rosters')

  await reader.community.closeChannel(open[0])
  await reader.community.closeChannel(open[1])
  const after = await reader.community.stats()
  t.is(after.openLogs, 3, 'closing two channels releases their logs')
  t.is(after.rosterKeepers, 3, 'and their rosters')
  t.is(after.follows, 3, 'and stops their follows')
  t.is((await reader.community.latest(open[0], { timeout: 2000 })).length, 1, 'a closed channel can be read again')
})

test('v2 idle: closing a channel a member keeps leaves its own roster and log alone', async (t) => {
  const owner = await member(t, 'idle-keeper')
  const id = await owner.community.createChannel({ name: 'general', segmentMs: 60000 })
  await owner.community.keep(id)
  await owner.community.post(id, 'mine')
  await owner.community.closeChannel(id)
  const second = await owner.community.post(id, 'still mine')
  t.ok(second.seq === 1, 'its own log stays open and writable')
  t.ok((await owner.community.rosterEntries(id, Math.floor(second.t / 60000))).length === 1, 'and it still keeps the roster')
})
