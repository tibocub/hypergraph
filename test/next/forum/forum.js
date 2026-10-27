// The forum: the reference app for hypergraph's new core (spec 011, SC-002).
// Everything a forum does with its data, through the public API only: no
// networking, replication or cryptography code. Keep it under 400 lines; if
// something here is awkward to write, fix the API, not this file.

const { Hypergraph } = require('hypergraph/next')

// The app's second version added post topics (with an index) and polls.
// Between versions, only add fields at the end of a type and add types:
// members on either version read each other's records.
const types = {
  post: { fields: { title: 'string', text: 'text', topic: 'string' }, index: [['topic', 'stamp']] },
  comment: { fields: { text: 'text', on: 'link' }, links: { on: ['post', 'comment'] } },
  vote: { fields: { value: 'int', on: 'link' }, links: { on: ['post', 'comment'] }, onePerMember: true },
  // The forum's wiki: editors (the 'edit-pages' permission) edit any page.
  page: { fields: { title: 'string', body: 'text' }, editable: { permission: 'edit-pages' } },
  // A notice board any member edits, in columns ('todo', 'done'...).
  note: { fields: { text: 'text', column: 'string' }, editable: 'members', index: [['column', 'stamp']] },
  poll: { fields: { question: 'string', on: 'link' }, links: { on: ['post'] } },
  // A post pointing at another forum or sub-forum, like a shortcut.
  shortcut: { fields: { title: 'string', to: 'space' } }
}

// The forum's own rules: every member checks them before keeping a record.
const rules = [
  { id: 'title-length', validate: (record) => record.type !== 'post' || (record.title || '').length <= 300 }
]

// --- accounts ---

// A new account in this folder, online. `{ password }` keeps the recovery
// phrase sealed by it from the first moment (show it with recoveryPhrase()).
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

// The forum list changed: one joined or created here or on another device of
// the account, or left (the list as argument).
function onForums (hg, fn) {
  hg.on('spaces', fn)
}

// `keepEverything`: every member is asked to keep the whole forum (an
// archive); by default each keeps what fits, then the newest part.
// `private`: only its members read it (relays and storers can't).
function createForum (hg, name, { keepEverything = false, private: priv = false } = {}) {
  return hg.createSpace({ name, policy: keepEverything ? 'everything' : 'auto', private: priv })
}

function keepEverything (forum) {
  return forum.setPolicy('everything')
}

// --- storage (this device's disk) ---

// The room the app may use on this device (null: the default).
function setAppBudget (hg, bytes) {
  return hg.setBudget(bytes)
}

// A forum's own room, out of the app's (null: share the app's).
function setForumBudget (forum, bytes) {
  return forum.setBudget(bytes)
}

// { budget, used, free } in bytes.
function storage (hg) {
  return hg.storage()
}

// --- sub-forums ---

// Seen by every member of the forum, no joining. `onlyRoles`: only these
// roles post (the owner and admins always may); `private`: read only by who
// is invited to it, plus the forum's owner and admins.
function createSubforum (forum, name, { onlyRoles = [], private: priv = false } = {}) {
  return forum.createSubspace({ name, writeRoles: onlyRoles, private: priv })
}

// [{ key, name, private }]; open one with hg.space(key) (members of the forum
// have it).
function subforums (forum) {
  return forum.subspaces()
}

// A link for a guest of a sub-forum only: they don't see the rest.
function inviteGuest (subforum) {
  return subforum.createInvite({ role: 'guest' })
}

function shortcut (forum, title, to) {
  return forum.put('shortcut', { title, to })
}

// The forum a shortcut points at; NOT_FOUND if this person isn't in it (an
// invite lets them in).
function follow (hg, record) {
  return hg.space(record.to)
}

// A link for one person, sent any way you like; `subforums`: private ones
// they get in too.
function invite (forum, { subforums = [] } = {}) {
  return forum.createInvite({ role: 'member', subspaces: subforums })
}

// An open forum: a public link for anyone, until revoked. `perHour`: how
// much each device may post in an hour (against spam).
async function openLink (forum, { perHour } = {}) {
  if (perHour) await forum.setWriteLimit({ records: perHour, periodMs: 3600e3 })
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

// The forum's roles, highest first: [{ name, permissions, custom }].
function roles (forum) {
  return forum.roles()
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

function post (forum, title, text, topic) {
  return forum.put('post', { title, text, topic })
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

async function byTopic (forum, topic, n = 20) {
  return (await forum.query('post').where({ topic }).latest(n)).items
}

// Who is here: members with their role (highest first), then people banned
// or removed. [{ identity, role, you, banned, removed, devices }]
function people (forum) {
  return forum.members()
}

// The moderation log: who decided what, when and why, newest first.
async function modLog (forum, n = 50) {
  return (await forum.decisions({ limit: n })).items
}

// Who is online in this forum right now: [{ identity, device }].
function online (forum) {
  return forum.peers()
}

// A page of posts, newest first: { after } the last post of the previous page.
async function postsPage (forum, n, after) {
  return (await forum.query('post').latest(n, { after })).items
}

// --- tags and links between posts ---

// Tags are the post's: its author (or an editor, for pages) tags it.
function tag (forum, record, name) {
  return forum.tag(record, name)
}

function untag (forum, record, name) {
  return forum.untag(record, name)
}

async function tagsOf (forum, record) {
  return (await forum.tags(record)).items
}

// Posts with a tag, newest first; { after } pages.
async function tagged (forum, name, { limit = 20, after } = {}) {
  return (await forum.getByTag(name, { type: 'post', limit, after })).items
}

// "See also": a link from one of your posts to any post, with a note.
function seeAlso (forum, from, to, note) {
  return forum.relate(from, to, 'see-also', { data: note })
}

function unlink (forum, from, to) {
  return forum.unrelate(from, to, 'see-also')
}

// The posts pointing at this one with "see also", and how many.
async function referencedBy (forum, record) {
  const { items, count } = await forum.edges(record, { direction: 'in', type: 'see-also' })
  return { from: items.map((e) => e.from), count }
}

// --- the wiki ---

// Editors: members who may edit any page (and post). The role is defined the
// first time someone is made an editor.
async function makeEditor (forum, who) {
  if (!(await forum.roles()).some((r) => r.name === 'editor')) await forum.defineRole('editor', ['post', 'edit-pages'])
  await forum.setRole(who, 'editor')
}

function writePage (forum, title, body) {
  return forum.put('page', { title, body })
}

async function readPage (forum, id) {
  return (await forum.get(id)).record
}

// A note on the board, edited by any member.
function pin (forum, text, column = 'todo') {
  return forum.put('note', { text, column })
}

// Any member moves a note to another column.
function moveNote (forum, note, column) {
  return forum.edit(note, { column })
}

// The notes in a column, newest first.
async function column (forum, name) {
  return (await forum.query('note').where({ column: name }).latest(50)).items
}

// A poll under a post.
function ask (forum, on, question) {
  return forum.put('poll', { on, question })
}

async function polls (forum, on) {
  return (await forum.linked(on, 'poll')).items
}

// Calls onUpdate(posts) now and whenever posts change; returns stop().
function liveLatest (forum, onUpdate, n = 20) {
  return forum.query('post').live(({ items }) => onUpdate(items), { limit: n })
}

module.exports = {
  types, rules, signUp, restore, recoveryPhrase, protectPhrase, forgetPhrase,
  addDevice, joinWithCode, onForums, devices, removeDevice, setSetting, setting,
  forums, createForum, keepEverything, setAppBudget, setForumBudget, storage,
  createSubforum, subforums, inviteGuest, shortcut, follow,
  invite, openLink, revokeLink, whoJoined, join,
  giveRole, roleOf, addRole, roles, removeMember, people, modLog, online,
  hide, reveal, takeDown, flag, ban, unban,
  post, comment, vote, edit, remove, latest, comments, thread, score, postsPage, byTopic,
  tag, untag, tagsOf, tagged, seeAlso, unlink, referencedBy,
  makeEditor, writePage, readPage, pin, moveNote, column, ask, polls, liveLatest
}
