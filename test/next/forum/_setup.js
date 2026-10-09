// Test plumbing for the forum scenarios: accounts in temp folders on the
// test's local DHT, closed after the test. Not part of the forum app.

const forum = require('./forum.js')
const { tmpDir, testBootstrap, bounded } = require('../helpers.js')

async function account (t, label, opts = {}) {
  const dir = opts.dir || tmpDir(t, label)
  const bootstrap = await testBootstrap(t)
  const hg = opts.phrase ? await forum.restore(dir, opts.phrase, { bootstrap, deviceName: label }) : await forum.signUp(dir, { bootstrap, deviceName: label })
  t.teardown(() => bounded(hg.close(), 10000, `${label}.close()`), { order: 0 })
  hg.dir = dir
  return hg
}

// Another device of an account, joined with a code from addDevice.
async function device (t, label, code, opts = {}) {
  const dir = opts.dir || tmpDir(t, label)
  const bootstrap = await testBootstrap(t)
  const hg = await forum.joinWithCode(dir, code, { bootstrap, deviceName: label, ...opts })
  t.teardown(() => bounded(hg.close(), 10000, `${label}.close()`), { order: 0 })
  hg.dir = dir
  return hg
}

// Three members of one forum: a created it and invited b and c.
async function threeMembers (t) {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const c = await account(t, 'c')
  const fa = await forum.createForum(a, 'Hypergraph fans')
  const fb = await forum.join(b, await forum.invite(fa))
  const fc = await forum.join(c, await forum.invite(fa))
  return { a, b, c, fa, fb, fc, all: [fa, fb, fc] }
}

module.exports = { account, device, threeMembers }
