// The forum: the reference app for hypergraph's new core (spec 011, SC-002).
// Everything a forum does with its data, through the public API only: no
// networking, replication or cryptography code. Keep it under 400 lines; if
// something here is awkward to write, fix the API, not this file.

const { Hypergraph } = require('hypergraph/next')

const types = {
  post: { fields: { title: 'string', text: 'text' } },
  comment: { fields: { text: 'text', on: 'link' }, links: { on: ['post', 'comment'] } },
  vote: { fields: { value: 'int', on: 'link' }, links: { on: ['post', 'comment'] }, onePerMember: true }
}

// The forum's own rules: every member checks them before keeping a record.
const rules = [
  { id: 'title-length', validate: (record) => record.type !== 'post' || (record.title || '').length <= 300 }
]

// --- accounts ---

// A new account in this folder, online.
async function signUp (dir, opts = {}) {
  const hg = await Hypergraph.open(dir, { types, rules, ...opts })
  await hg.connectToSwarm()
  return hg
}

// The same person on another computer, from their recovery phrase.
async function restore (dir, phrase, opts = {}) {
  const hg = await Hypergraph.open(dir, { types, rules, mnemonic: phrase, ...opts })
  await hg.connectToSwarm()
  return hg
}

// The words the person writes down (the password, once they protected them).
function recoveryPhrase (hg, password) {
  return hg.recoveryPhrase(password)
}

// Right after showing the phrase, the app asks: keep it on this device behind
// a password, or forget it here (it is written down)?
function protectPhrase (hg, password) {
  return hg.protectRecoveryPhrase(password)
}

function forgetPhrase (hg) {
  return hg.forgetRecoveryPhrase()
}

// --- devices ---

// On a device already in: a code for the new one (show it as text or a QR).
// `password`: the one protecting the recovery phrase on this device.
function addDevice (hg, password) {
  return hg.addDevice({ password })
}

// On the new device: the same person, with their forums and settings. It
// receives the recovery phrase: ask the person to protect it here too.
async function joinWithCode (dir, code, opts = {}) {
  const hg = await Hypergraph.open(dir, { types, rules, joinCode: code, ...opts })
  await hg.connectToSwarm()
  return hg
}

function devices (hg) {
  return hg.devices()
}

// A lost device: what it wrote so far stays, nothing after counts. Needs the
// recovery phrase, unlocked here by its password.
function removeDevice (hg, device, password) {
  return hg.removeDevice(device, { password })
}

// The person's settings, the same on all their devices.
function setSetting (hg, name, value) {
  return hg.setSetting(name, value)
}

async function setting (hg, name) {
  return (await hg.settings())[name]
}

// --- forums ---

// The forums this person is in (on any of their devices).
function forums (hg) {
  return hg.spaces()
}

function createForum (hg, name) {
  return hg.createSpace({ name })
}

// A link for one person, sent any way you like.
function invite (forum) {
  return forum.createInvite({ role: 'member' })
}

// An open forum: a public link for anyone, until revoked.
function openLink (forum) {
  return forum.createInvite({ role: 'member', uses: Infinity })
}

// Nobody else gets in with it; who came in stays.
function revokeLink (forum, link) {
  return forum.revokeInvite(link)
}

// Who came in with a link: [{ identity, at }].
function whoJoined (forum, link) {
  return forum.redemptions(link)
}

// Refused with the reason: INVITE_EXPIRED, INVITE_USED_UP, INVITE_REVOKED,
// NOT_ALLOWED; INVITE_INVALID if nobody able to let us in is online.
function join (hg, link, opts) {
  return hg.redeemInvite(link, opts)
}

// --- roles and moderation ---

// 'moderator', 'admin', 'member', or a role the forum defined (addRole).
function giveRole (forum, who, role) {
  return forum.setRole(who, role)
}

function roleOf (forum, who) {
  return forum.getRole(who)
}

function addRole (forum, name, permissions) {
  return forum.defineRole(name, permissions)
}

// Takes someone out of the forum (v1's removeRole): what they wrote so far stays.
function removeMember (forum, who) {
  return forum.removeRole(who)
}

// Hidden records leave every list (get() still finds them, marked hidden)
// until revealed; a taken-down record is gone for good.
function hide (forum, record, reason) {
  return forum.moderateAction('hide', record, { reason })
}

function reveal (forum, record) {
  return forum.moderateAction('reveal', record)
}

function takeDown (forum, record, reason) {
  return forum.moderateAction('remove', record, { reason })
}

function flag (forum, record, reason) {
  return forum.moderateAction('flag', record, { reason })
}

// Lifts a ban: they can be let back in (an invite, or giveRole); what they
// wrote during the ban never counts.
function unban (forum, who) {
  return forum.moderateAction('unban', who)
}

// Out until unbanned: what they wrote up to what this moderator holds stays,
// anything after is ignored. `from` (one of their records, e.g. the first
// spam): that record and everything after it in the same log go too.
function ban (forum, who, { reason = '', from } = {}) {
  return forum.moderateAction('ban', who, { reason, from })
}

// --- posting ---

function post (forum, title, text) {
  return forum.put('post', { title, text })
}

// On a post, or a reply to a comment.
function comment (forum, on, text) {
  return forum.put('comment', { on, text })
}

// +1 or -1; voting again replaces the member's earlier vote.
function vote (forum, on, value) {
  return forum.put('vote', { on, value })
}

function edit (forum, record, changes) {
  return forum.edit(record.id, changes)
}

function remove (forum, record) {
  return forum.del(record.id)
}

// --- reading ---

async function latest (forum, n = 20) {
  return (await forum.query('post').latest(n)).items
}

async function comments (forum, on) {
  return (await forum.linked(on, 'comment')).items
}

// A post with its comments and their replies, oldest first.
async function thread (forum, record) {
  const replies = await comments(forum, record)
  replies.sort((a, b) => a.stamp - b.stamp)
  return { ...record, replies: await Promise.all(replies.map((r) => thread(forum, r))) }
}

async function score (forum, on) {
  return (await forum.sum('vote', 'value', { on })).value
}

// Calls onUpdate(posts) now and whenever posts change; returns stop().
function liveLatest (forum, onUpdate, n = 20) {
  return forum.query('post').live(({ items }) => onUpdate(items), { limit: n })
}

module.exports = {
  types,
  rules,
  signUp,
  restore,
  recoveryPhrase,
  protectPhrase,
  forgetPhrase,
  addDevice,
  joinWithCode,
  devices,
  removeDevice,
  setSetting,
  setting,
  forums,
  createForum,
  invite,
  openLink,
  revokeLink,
  whoJoined,
  join,
  giveRole,
  roleOf,
  addRole,
  removeMember,
  hide,
  reveal,
  takeDown,
  flag,
  ban,
  unban,
  post,
  comment,
  vote,
  edit,
  remove,
  latest,
  comments,
  thread,
  score,
  liveLatest
}
