// The reddit clone's main flows on the spike (space.js), three members on a
// local DHT: create, join, post, comment, vote (one per member, latest
// counts), live list, hide, ban cut by length, a non-member's log ignored.
// Prints what each step took; fails loudly if members disagree.
//
//   node bench/experiments/spike/run.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const createTestnet = require('hyperdht/testnet')
const { Space } = require('./space')

const now = () => Number(process.hrtime.bigint()) / 1e6
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Poll until check() is true on every member, at most `ms`.
async function everyone (members, check, ms = 10000) {
  const t0 = now()
  for (;;) {
    const ok = await Promise.all(members.map(check))
    if (ok.every(Boolean)) return Math.round(now() - t0)
    if (now() - t0 > ms) throw new Error('members did not agree within ' + ms + ' ms')
    await sleep(5)
  }
}

async function main () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-spike-'))
  const testnet = await createTestnet(3)
  const dir = (name) => path.join(root, name)
  const timings = {}

  // --- sign up, create a forum, join it ---
  let t0 = now()
  const alice = await Space.create(dir('alice'), testnet.bootstrap)
  const bob = await Space.join(dir('bob'), testnet.bootstrap, alice.key)
  const carol = await Space.join(dir('carol'), testnet.bootstrap, alice.key)
  // Stand-in for invites: the creator adds the members' logs.
  await alice.addMember(bob.writerKey)
  await alice.addMember(carol.writerKey)
  const all = [alice, bob, carol]
  timings.createAndJoinMs = Math.round(now() - t0)

  // --- post, and everyone sees it ---
  t0 = now()
  const post = await bob.put('post', { title: 'Hello', text: 'First!' })
  timings.postVisibleToAllMs = await everyone(all, async (m) => (await m.query('post').latest(20)).some((p) => p.id === post.id))

  // --- live list on carol ---
  const seen = []
  carol.query('post').live((page) => seen.push(page.length))

  // --- comments ---
  const c1 = await alice.put('comment', { text: 'Welcome', on: post })
  await carol.put('comment', { text: 'Hi bob', on: post })
  await bob.put('comment', { text: 'thanks', on: c1 })
  timings.commentsVisibleMs = await everyone(all, async (m) => (await m.linked(post, 'comment')).length === 2 && (await m.linked(c1, 'comment')).length === 1)

  // --- votes: one per member, the latest counts ---
  await alice.put('vote', { value: 1, on: post })
  await carol.put('vote', { value: 1, on: post })
  await bob.put('vote', { value: 1, on: post })
  await bob.put('vote', { value: -1, on: post }) // bob changes his mind
  timings.votesAgreeMs = await everyone(all, async (m) => (await m.sum('vote', 'value', { on: post })) === 1)

  // --- moderation: hide a comment ---
  const rude = await carol.put('comment', { text: 'rude', on: post })
  await everyone(all, async (m) => (await m.linked(post, 'comment')).some((c) => c.id === rude.id))
  t0 = now()
  await alice.hide(rude.id)
  timings.hideAppliedMs = await everyone(all, async (m) => !(await m.linked(post, 'comment')).some((c) => c.id === rude.id))

  // --- ban carol, keeping what she wrote before the spam ---
  const keepUpTo = carol.writerKey && carol.log.length
  const spam = []
  for (let i = 0; i < 5; i++) spam.push(await carol.put('post', { title: 'BUY NOW ' + i, text: 'spam' }))
  await everyone(all, async (m) => (await m.query('post').latest(20)).length === 6)
  t0 = now()
  await alice.ban(carol.writerKey, { keepUpTo })
  timings.banAppliedMs = await everyone(all, async (m) => (await m.query('post').latest(20)).length === 1)
  const carolsVoteStillCounts = (await bob.sum('vote', 'value', { on: post })) === 1
  assert(carolsVoteStillCounts, "carol's vote from before the ban still counts")
  // Carol keeps writing; nobody indexes it.
  await carol.put('post', { title: 'after ban', text: 'x' })
  await sleep(300)
  assert.strictEqual((await bob.query('post').latest(20)).length, 1, 'posts after the ban stay out')

  // --- a non-member writes in its own log: never opened ---
  const mallory = await Space.join(dir('mallory'), testnet.bootstrap, alice.key)
  await mallory.put('post', { title: 'not a member', text: 'x' })
  await sleep(300)
  assert.strictEqual((await alice.query('post').latest(20)).length, 1, "a non-member's records stay out")

  timings.liveUpdatesOnCarol = seen.length
  console.log(JSON.stringify(timings))
  for (const m of [...all, mallory]) await m.close()
  await testnet.destroy()
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
}

main().catch((err) => { console.error(err); process.exit(1) })
