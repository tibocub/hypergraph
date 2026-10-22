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

// An invite to a sub-space (story 8) is also signed with the top space's key
// (whose decision log holds the sub-space's decisions); one to a top space
// is signed as before.
const inviteSignable = (inv, root) => {
  const body = c.encode(enc.inviteBody, inv)
  return root && !b4a.equals(root, inv.space) ? b4a.concat([NS_INVITE, body, root]) : b4a.concat([NS_INVITE, body])
}
const redemptionSignable = (inv, identity, writer) => b4a.concat([NS_REDEEM, inv.space, inv.id, identity, writer])

// `root`: the top space's key, for an invite to one of its sub-spaces.
function makeInvite ({ space, role = 'member', uses = 1, expires = 0, subspaces = [] }, identity, root = null) {
  const inv = { space, id: crypto.randomBytes(16), role, uses, expires, subspaces, maker: identity.publicKey }
  inv.proof = identity.attest(inviteSignable(inv, root))
  return inv
}

function verifyInvite (inv, root = null) {
  const info = Identity.verify(inv.proof, inviteSignable(inv, root))
  return !!info && b4a.equals(info.identity, inv.maker)
}

// A link: the invite, followed by the top space's key for a sub-space.
function encodeLink (inv, root = null) {
  const bytes = c.encode(enc.invite, inv)
  return PREFIX + z32.encode(root && !b4a.equals(root, inv.space) ? b4a.concat([bytes, root]) : bytes)
}

// The invite in a link, with `root`: the key of the space whose decision log
// records it (its own, or a sub-space's top space); INVITE_INVALID for
// anything else.
function decodeLink (link) {
  const bad = () => new HypergraphError('INVITE_INVALID', 'Not a hypergraph invite link')
  if (typeof link !== 'string' || !link.startsWith(PREFIX)) throw bad()
  let inv = null
  let root = null
  try {
    const bytes = z32.decode(link.slice(PREFIX.length))
    const state = { start: 0, end: bytes.byteLength, buffer: bytes }
    inv = enc.invite.decode(state)
    if (state.end - state.start === 32) root = bytes.subarray(state.start)
    else if (state.start !== state.end) inv = null
  } catch { throw bad() }
  if (!inv) throw bad()
  root = root || inv.space
  if (!verifyInvite(inv, root)) throw new HypergraphError('INVITE_INVALID', 'This invite link was not signed by its maker')
  return { ...inv, root }
}

// `writer`: the redeemer's device key in the space's decision log, so a role
// that records decisions later can make it a writer (lib/decisions/apply.js).
function makeRedemption (inv, identity, writer) {
  return { invite: inv, identity: identity.publicKey, writer, proof: identity.attest(redemptionSignable(inv, identity.publicKey, writer)) }
}

// Who signed a redemption ({ identity, device }), or null if it doesn't hold.
// `root`: the key of the decision log recording it.
function verifyRedemption (r, root = null) {
  if (!verifyInvite(r.invite, root)) return null
  const info = Identity.verify(r.proof, redemptionSignable(r.invite, r.identity, r.writer))
  return info && b4a.equals(info.identity, r.identity) ? info : null
}

module.exports = { makeInvite, verifyInvite, encodeLink, decodeLink, makeRedemption, verifyRedemption }
