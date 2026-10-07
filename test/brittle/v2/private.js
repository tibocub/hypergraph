// v2 private channels: only members can read (spec 008, US1, FR-001..005).

const test = require('brittle')
const b4a = require('b4a')
const { member, link, until } = require('./_helpers')

async function setup (t, label) {
  const owner = await member(t, `${label}-owner`)
  const channel = await owner.community.createChannel({ name: 'secret', private: true, keep: true, segmentMs: 60000 })
  const outsider = await member(t, `${label}-outsider`, { key: owner.community.key })
  t.teardown(link(owner, outsider))
  await until(async () => { await outsider.community.update(); return outsider.community.keepers(channel).length === 1 })
  return { owner, outsider, channel }
}

test('v2 private: the creator reads its posts; everyone else sees them as unreadable', async (t) => {
  const { owner, outsider, channel } = await setup(t, 'priv-read')
  t.is(owner.community.channel(channel).private, true)
  t.is(owner.community.epoch(channel), 0)
  t.is(typeof owner.community.encryptionKey, 'string')
  t.is(owner.community.encryptionKey.length, 64)

  const posted = await owner.community.post(channel, 'the secret plan')
  const mine = await owner.community.latest(channel)
  t.is(mine.length, 1)
  t.is(mine[0].text, 'the secret plan', 'the creator reads it')
  t.is(mine[0].encrypted, true)
  t.is(mine[0].epoch, 0)

  let theirs = []
  t.ok(await until(async () => (theirs = await outsider.community.latest(channel)).length === 1), 'the outsider sees a message')
  t.is(theirs[0].text, null, 'without its text')
  t.is(theirs[0].unreadable, true)
  t.is(theirs[0].author, owner.pub, 'but with its author')
  t.is(theirs[0].t, posted.t, 'and its time')

  // Nothing readable in the raw block either.
  const core = outsider.store.get({ key: b4a.from(posted.log, 'hex') })
  await core.ready()
  const block = await core.get(posted.seq)
  await core.close()
  t.is(b4a.indexOf(block, b4a.from('secret plan')), -1, 'no text in the stored block')
})

test('v2 private: a member without the key can’t post; a keeper lists posts it can’t read', async (t) => {
  const { owner, outsider, channel } = await setup(t, 'priv-post')
  await t.exception(outsider.community.post(channel, 'let me in'), /key/, 'posting without the key throws')
  const posted = await owner.community.post(channel, 'hello')
  // The owner is the keeper here; a member following sees the listing arrive.
  t.ok(await until(async () => (await outsider.community.rosterEntries(channel, Math.floor(posted.t / 60000))).length === 1), 'the post is listed')
})
