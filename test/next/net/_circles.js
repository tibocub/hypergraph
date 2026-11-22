// Shared by the circles tests (024).

const testing = require('../../../lib/testing.js')
const forum = require('../forum/forum.js')
const { account } = require('../forum/_setup.js')
const { eventually, sleep } = require('../helpers.js')

async function holdsAll (holder, space, keys = null) {
  for (const key of keys || (await testing.coreKeys(space)).values()) {
    const mine = space.hg.store.get({ key })
    await mine.ready()
    const length = mine.contiguousLength // what the member has to hand
    await mine.close()
    if (!length) continue
    const copy = holder.store.get({ key })
    await copy.ready()
    const ok = copy.length >= length && await copy.has(0, length)
    await copy.close()
    if (!ok) return false
  }
  return true
}

async function heldBy (hgs, space, keys = null) {
  const out = []
  for (const hg of hgs) if (!hg.closed && await holdsAll(hg, space, keys)) out.push(hg)
  return out
}

// Setup shared by the circles and copies files.

const titles = async (f) => (await forum.latest(f)).map((p) => p.title).sort().join()

async function fill (f, n, ch) {
  for (let i = 0; i < n; i++) await forum.post(f, ch + i, ch.repeat(50000))
}

async function pair (t, opts = {}) {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const circle = await a.createCircle({ name: 'Family' })
  await forum.join(b, await circle.createInvite())
  await b.setHolding({ on: true, ...opts })
  return { a, b, circle }
}

async function circleOf (t, n, { name = 'C', a = null, prefix = 'h' } = {}) {
  a = a || await account(t, 'a')
  const circle = await a.createCircle({ name })
  const holders = []
  for (let i = 0; i < n; i++) {
    const h = await account(t, prefix + i)
    await forum.join(h, await circle.createInvite())
    await h.setHolding({ on: true })
    holders.push(h)
  }
  return { a, circle, holders }
}

async function keptByExactly (hgs, space, n, ms = 60000) {
  if (!await eventually(async () => (await heldBy(hgs, space)).length === n, ms)) return false
  await sleep(3000)
  return (await heldBy(hgs, space)).length === n
}

module.exports = { holdsAll, heldBy, titles, fill, pair, circleOf, keptByExactly }
