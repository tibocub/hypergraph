const c = require('compact-encoding')
const b4a = require('b4a')
const crypto = require('crypto')

// Wire formats of the v2 prototype (spec 007, data-model.md). Compact, as
// these are the per-message bytes everyone downloads.

const MAX_TEXT = 4096 // bytes of UTF-8 per message
const HAS_REPLY = 1

// A message block in an author's per-channel log.
const message = {
  preencode (state, m) {
    if (b4a.byteLength(m.text) > MAX_TEXT) throw new Error(`message text too long (max ${MAX_TEXT} bytes)`)
    c.uint.preencode(state, m.reply ? HAS_REPLY : 0)
    c.uint.preencode(state, m.t)
    c.string.preencode(state, m.text)
    if (m.reply) {
      c.fixed32.preencode(state, m.reply.log)
      c.uint.preencode(state, m.reply.seq)
    }
  },
  encode (state, m) {
    c.uint.encode(state, m.reply ? HAS_REPLY : 0)
    c.uint.encode(state, m.t)
    c.string.encode(state, m.text)
    if (m.reply) {
      c.fixed32.encode(state, m.reply.log)
      c.uint.encode(state, m.reply.seq)
    }
  },
  decode (state) {
    const flags = c.uint.decode(state)
    const out = { t: c.uint.decode(state), text: c.string.decode(state) }
    if (flags & HAS_REPLY) out.reply = { log: c.fixed32.decode(state), seq: c.uint.decode(state) }
    return out
  }
}

// A roster entry's value: where an author's messages for a segment start,
// signed by the author.
const rosterValue = {
  preencode (state, v) {
    c.fixed32.preencode(state, v.log)
    c.uint.preencode(state, v.start)
    c.fixed64.preencode(state, v.sig)
  },
  encode (state, v) {
    c.fixed32.encode(state, v.log)
    c.uint.encode(state, v.start)
    c.fixed64.encode(state, v.sig)
  },
  decode (state) {
    return { log: c.fixed32.decode(state), start: c.uint.decode(state), sig: c.fixed64.decode(state) }
  }
}

// A keeper's author index: an author's latest roster entry in a channel.
const authorEntry = {
  preencode (state, v) {
    c.uint.preencode(state, v.segment)
    rosterValue.preencode(state, v)
  },
  encode (state, v) {
    c.uint.encode(state, v.segment)
    rosterValue.encode(state, v)
  },
  decode (state) {
    const segment = c.uint.decode(state)
    return { segment, ...rosterValue.decode(state) }
  }
}

// What an author sends a keeper on first posting in a segment.
const announcement = {
  preencode (state, a) {
    c.string.preencode(state, a.channel)
    c.uint.preencode(state, a.segment)
    c.fixed32.preencode(state, a.author)
    rosterValue.preencode(state, a)
  },
  encode (state, a) {
    c.string.encode(state, a.channel)
    c.uint.encode(state, a.segment)
    c.fixed32.encode(state, a.author)
    rosterValue.encode(state, a)
  },
  decode (state) {
    const channel = c.string.decode(state)
    const segment = c.uint.decode(state)
    const author = c.fixed32.decode(state)
    return { channel, segment, author, ...rosterValue.decode(state) }
  }
}

/**
 * What an author signs for a roster entry: binds its log for this segment
 * to this community and channel, so a keeper can't move it anywhere else.
 */
function rosterSignable (communityKey, channelId, segment, log, start) {
  return crypto.createHash('sha256')
    .update('hg-v2-roster\0')
    .update(communityKey)
    .update(b4a.from(channelId + '\0'))
    .update(b4a.from(`${segment}\0${start}\0`))
    .update(log)
    .digest()
}

const wrap = (enc) => ({
  encode: (v) => c.encode(enc, v),
  decode: (buf) => c.decode(enc, buf),
  enc
})

module.exports = {
  MAX_TEXT,
  message: wrap(message),
  rosterValue: wrap(rosterValue),
  authorEntry: wrap(authorEntry),
  announcement: wrap(announcement),
  rosterSignable
}
