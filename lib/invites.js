// Invite links (spec 008's design, research R16; story 1's part): a link is an
// invite signed by its maker's device on the maker's behalf: space, role,
// uses, expiry, sub-spaces. Never a key. A newcomer redeems it with a signed
// request; a member who records decisions writes the redemption into the
// decision log, where the role and the uses are decided the same way for
// everyone (lib/decisions/apply.js). Offline inviters, revocation and public
// links come with story 4.

const c = require('compact-encoding')
const b4a = require('b4a')
const z32 = require('z32')
const crypto = require('hypercore-crypto')
const enc = require('./encodings.js')
const { Identity } = require('./identity.js')
const { HypergraphError } = require('./errors.js')

const PREFIX = 'hg:'
const NS_INVITE = b4a.from('hypergraph/invite\0')
const NS_REDEEM = b4a.from('hypergraph/redeem\0')

const inviteSignable = (inv) => b4a.concat([NS_INVITE, c.encode(enc.inviteBody, inv)])
const redemptionSignable = (inv, identity) => b4a.concat([NS_REDEEM, inv.space, inv.id, identity])

function makeInvite ({ space, role = 'member', uses = 1, expires = 0, subspaces = [] }, identity) {
  const inv = { space, id: crypto.randomBytes(16), role, uses, expires, subspaces, maker: identity.publicKey }
  inv.proof = identity.attest(inviteSignable(inv))
  return inv
}

function verifyInvite (inv) {
  const info = Identity.verify(inv.proof, inviteSignable(inv))
  return !!info && b4a.equals(info.identity, inv.maker)
}

function encodeLink (inv) {
  return PREFIX + z32.encode(c.encode(enc.invite, inv))
}

// The invite in a link; INVITE_INVALID for anything else.
function decodeLink (link) {
  const bad = () => new HypergraphError('INVITE_INVALID', 'Not a hypergraph invite link')
  if (typeof link !== 'string' || !link.startsWith(PREFIX)) throw bad()
  let inv = null
  try { inv = c.decode(enc.invite, z32.decode(link.slice(PREFIX.length))) } catch { throw bad() }
  if (!verifyInvite(inv)) throw new HypergraphError('INVITE_INVALID', 'This invite link was not signed by its maker')
  return inv
}

function makeRedemption (inv, identity) {
  return { invite: inv, identity: identity.publicKey, proof: identity.attest(redemptionSignable(inv, identity.publicKey)) }
}

function verifyRedemption (r) {
  if (!verifyInvite(r.invite)) return false
  const info = Identity.verify(r.proof, redemptionSignable(r.invite, r.identity))
  return !!info && b4a.equals(info.identity, r.identity)
}

module.exports = { makeInvite, verifyInvite, encodeLink, decodeLink, makeRedemption, verifyRedemption }
