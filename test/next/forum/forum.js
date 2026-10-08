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

// --- accounts ---

// A new account in this folder, online.
async function signUp (dir, opts = {}) {
  const hg = await Hypergraph.open(dir, { types, ...opts })
  await hg.connectToSwarm()
  return hg
}

// The same person on another computer, from their recovery phrase.
async function restore (dir, phrase, opts = {}) {
  const hg = await Hypergraph.open(dir, { types, mnemonic: phrase, ...opts })
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

// --- forums ---

function createForum (hg, name) {
  return hg.createSpace({ name })
}

function invite (forum) {
  return forum.createInvite({ role: 'member' })
}

function join (hg, link) {
  return hg.redeemInvite(link)
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
  signUp,
  restore,
  recoveryPhrase,
  protectPhrase,
  forgetPhrase,
  createForum,
  invite,
  join,
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
