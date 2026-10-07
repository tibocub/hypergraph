const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const { grantKey, grantValue } = require('./encodings')
const { sha256 } = require('./crypto')

// Grants of a private channel as one keeper keeps them (spec 008, research
// R1). A grants store is { bee, who }:
//   bee: [recipient key prefix, epoch, commit prefix] -> { identity, commit, sealed, granter, sig }
//   who: recipient identity -> recipient encryption key
// Members read only `bee`, and only their own keys. `who` is its own core
// (named in `bee`'s header): in the same tree it doubled the entries a
// member's lookup walks through (50,000 members: 44.6 KB to get access).
// Keepers use it to refuse revoked members and vouch for key holders who
// grant; admins to list members.

const entryKey = (recipient, epoch, commit) => grantKey.encode([recipient, epoch, commit])

/** What a granter signs: binds the sealed key to community, channel, recipient, epoch and commitment. */
function grantSignable (communityKey, channel, g) {
  return sha256('hg-v2-grant\0', communityKey, channel + '\0', g.recipient, g.identity, `${g.epoch}\0`, g.commit, g.sealed)
}

function signGrant (communityKey, channel, g, keyPair) {
  return hcrypto.sign(grantSignable(communityKey, channel, g), keyPair.secretKey)
}

function verifyGrant (communityKey, channel, g) {
  try {
    return hcrypto.verify(grantSignable(communityKey, channel, g), g.sig, g.granter)
  } catch {
    return false
  }
}

/** Write a grant (and its identity index) unless that recipient's epoch is there. */
async function putGrant (gs, g) {
  return (await putGrants(gs, [g])) === 1
}

/** Many grants in one batch (a rotation's re-grants, bulk grants): one flush. */
async function putGrants (gs, list) {
  const batch = gs.bee.batch()
  const who = gs.who.batch()
  let written = 0
  for (const g of list) {
    const key = entryKey(g.recipient, g.epoch, g.commit)
    if (await batch.get(key)) continue
    await batch.put(key, grantValue.encode(g))
    await who.put(g.identity, g.recipient)
    written++
  }
  await batch.flush()
  await who.flush()
  return written
}

async function hasGrant (gs, recipient, epoch, commit, opts) {
  return !!(await gs.bee.get(entryKey(recipient, epoch, commit), opts))
}

/**
 * `recipient`'s grants for these epochs, one lookup each. A range read over
 * the same keys fetched ~30 blocks of an 80-block bee (Hyperbee keeps keys in
 * their own blocks and a range loads every key it passes); a lookup is a
 * binary search.
 */
async function grantsForEpochs (gs, recipient, epochs, opts) {
  const found = await Promise.all(epochs.map(async ({ epoch, commit }) => {
    const node = await gs.bee.get(entryKey(recipient, epoch, commit), opts)
    return node ? { recipient, epoch, ...grantValue.decode(node.value) } : null
  }))
  return found.filter(Boolean)
}

/** Every recipient: [{ identity, recipient }] (an admin's view, O(members)). */
async function allRecipients (gs) {
  const out = []
  for await (const { key, value } of gs.who.createReadStream()) out.push({ identity: key, recipient: value })
  return out
}

async function recipientOf (gs, identity, opts) {
  const node = await gs.who.get(identity, opts)
  return node ? node.value : null
}

module.exports = { grantSignable, signGrant, verifyGrant, putGrant, putGrants, hasGrant, grantsForEpochs, allRecipients, recipientOf }
