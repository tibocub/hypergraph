#!/usr/bin/env node
// The inspector demo: three members of a forum on a local DHT (like the
// tests), each with its own inspector, playing the forum scenario slowly.
// Open the printed addresses side by side and watch each step arrive.
//
//   node tools/inspector/demo.js [--port 4401] [--pause 4000] [--once]
//
// --once: stop by itself after the last step (to check the demo still runs).
//
// Ctrl-C stops it and removes everything it created (temp folders included).

const fs = require('fs')
const os = require('os')
const path = require('path')
const createTestnet = require('hyperdht/testnet')
const forum = require('../../test/next/forum/forum.js')
const { serveInspector } = require('./index.js')

const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf('--' + name)
  return i === -1 ? def : Number(args[i + 1])
}
const BASE_PORT = arg('port', 4401)
const PAUSE = arg('pause', 4000)
const PASSWORD = 'demo password'

const dirs = []
const instances = []
const inspectors = []
let testnet = null
let stopping = false

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tmp (label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hg-inspector-demo-${label}-`))
  dirs.push(dir)
  return dir
}

// Polls until fn() is truthy (or `ms` passed): the next step starts once the
// others have seen this one.
async function until (fn, ms = 15000) {
  const end = Date.now() + ms
  while (!stopping && Date.now() < end) {
    try { if (await fn()) return true } catch {}
    await sleep(200)
  }
  return false
}

let n = 0
async function step (title, look) {
  if (stopping) throw new Error('stopped')
  await sleep(PAUSE)
  n++
  console.log(`\n${n}. ${title}`)
  if (look) console.log(`   Look: ${look}`)
}

async function member (label, opts = {}) {
  const hg = opts.joinCode
    ? await forum.joinWithCode(tmp(label), opts.joinCode, { bootstrap: testnet.bootstrap, deviceName: label })
    : await forum.signUp(tmp(label), { bootstrap: testnet.bootstrap, deviceName: label, password: PASSWORD })
  instances.push(hg)
  const inspector = await serveInspector(hg, { port: BASE_PORT + inspectors.length })
  inspectors.push(inspector)
  console.log(`   ${label.padEnd(12)} ${inspector.url}`)
  return hg
}

async function main () {
  console.log('Starting a local DHT (3 nodes on 127.0.0.1)...')
  testnet = await createTestnet(3)

  console.log('Three people sign up, each with an inspector (open these in a browser):')
  const alice = await member('alice')
  const bob = await member('bob')
  const carol = await member('carol')
  console.log(`   Steps every ${PAUSE / 1000} s. Ctrl-C to stop.`)

  await step('Alice creates a forum, "Demo forum".',
    'alice\'s inspector lists it under Spaces; Members & roles: alice is the owner; Decisions: one settler (a SINGLE_SETTLER warning).')
  const fa = await forum.createForum(alice, 'Demo forum')

  await step('Alice invites Bob and Carol; they join.',
    'the forum appears in bob\'s and carol\'s inspectors; Members shows three people; Device logs: one log per person; peers go up.')
  const fb = await forum.join(bob, await forum.invite(fa))
  const fc = await forum.join(carol, await forum.invite(fa))

  await step('Alice posts "Welcome!".',
    'Records → post: the post in all three inspectors (author: alice); alice\'s log grows by one block.')
  const post = await forum.post(fa, 'Welcome!', 'This is our forum.')
  await until(async () => (await fc.get(post.id)).record)

  await step('Bob comments on it; Carol votes +1, Bob +1.',
    'Records → comment and vote; click the post: "Pointing at it" lists the comment and the votes.')
  await forum.comment(fb, post, 'Glad to be here')
  await forum.vote(fc, post, 1)
  await forum.vote(fb, post, 1)
  await until(async () => (await forum.score(fa, post)) === 2)

  await step('Alice edits her post and tags it "news".',
    'the post shows the "edited" flag and its new text; Records → hg/tag has a row; the post\'s details show the tag.')
  await forum.edit(fa, post, { text: 'This is our forum. Be kind.' })
  await forum.tag(fa, post, 'news')

  await step('Alice makes Bob a moderator.',
    'Members & roles: bob is moderator, and "Decides: yes" once his device claims its right; Decisions: more entries.')
  await forum.giveRole(fa, bob.identity.publicKey, 'moderator')
  await until(async () => (await fb.getRole(bob.identity.publicKey)) === 'moderator')

  await step('Carol posts something rude; Bob (moderator) hides it.',
    'the rude post appears in Records → post, then leaves the list (hidden posts are left out of lists); the row count stays.')
  const rude = await forum.post(fc, 'Rude', 'Something rude')
  await until(async () => (await fb.get(rude.id)).record)
  await sleep(PAUSE)
  await forum.hide(fb, rude, 'rude')

  await step('Alice flags Bob\'s comment ("check this"); Carol replies to it.',
    'click the post, then the comment: it is flagged, and the reply points at it.')
  const comments = await forum.comments(fa, post)
  const bobComment = comments.find((c) => c.author === bob.identity.publicKey)
  await forum.flag(fa, bobComment, 'check this')
  await forum.comment(fc, bobComment, 'I agree with Bob')

  await step('Alice adds a second device: her phone.',
    'a fourth inspector (alice-phone) appears below; alice\'s inspectors list two devices; the forum\'s Device logs gain a log for her phone once it writes.')
  const { code } = await forum.addDevice(alice, PASSWORD)
  const phone = await member('alice-phone', { joinCode: code })

  await step('Alice posts from her phone.',
    'the post\'s Device column says alice-phone in alice\'s inspectors (another device key elsewhere); a new log under alice in Device logs.')
  await until(() => phone.spaces().some((s) => s.key === fa.key), 30000)
  await forum.post(phone.space(fa.key), 'From my phone', 'Hello again')

  if (args.includes('--once')) return stop()
  console.log('\nDone. The inspectors stay open: look around. Ctrl-C to stop.')
}

async function stop () {
  if (stopping) return
  stopping = true
  console.log('\nStopping...')
  // If a close hangs, don't leave the terminal stuck.
  setTimeout(() => { console.log('Some part did not close in time; exiting anyway.'); process.exit(1) }, 15000).unref()
  for (const i of inspectors) await i.close().catch(() => {})
  for (const hg of instances) await hg.close().catch(() => {})
  if (testnet) await testnet.destroy().catch(() => {})
  for (const dir of dirs) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
  console.log('Stopped; temp folders removed.')
}

process.on('SIGINT', stop)
main().catch(async (err) => {
  if (!stopping) {
    console.error(err)
    await stop()
    process.exitCode = 1
  }
})
