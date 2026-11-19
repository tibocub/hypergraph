// Shared by the circles tests (024).

const testing = require('../../../lib/testing.js')

// Does `holder` hold every core of `space`, as much as the member's device has of it?
// `keys`: the space's cores, taken while it was open.
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

// Which of `hgs` hold all of `space`.
async function heldBy (hgs, space, keys = null) {
  const out = []
  for (const hg of hgs) if (!hg.closed && await holdsAll(hg, space, keys)) out.push(hg)
  return out
}

module.exports = { holdsAll, heldBy }
