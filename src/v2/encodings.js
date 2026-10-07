const c = require('compact-encoding')
const b4a = require('b4a')
const crypto = require('crypto')

// Wire formats of the v2 prototype (spec 007, data-model.md). Compact, as
// these are the per-message bytes everyone downloads.

const MAX_TEXT = 4096 // bytes of UTF-8 per message
const HAS_REPLY = 1
const SEALED = 2 // a private channel's message: { t, epoch, nonce, box } (spec 008)

// A message block in an author's per-channel log.
const message = {
  preencode (state, m) {
    if (m.box) {
      c.uint.preencode(state, SEALED)
      c.uint.preencode(state, m.t)
      c.uint.preencode(state, m.epoch)
      c.fixed(24).preencode(state, m.nonce)
      c.buffer.preencode(state, m.box)
      return
    }
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
    if (m.box) {
      c.uint.encode(state, SEALED)
      c.uint.encode(state, m.t)
      c.uint.encode(state, m.epoch)
      c.fixed(24).encode(state, m.nonce)
      c.buffer.encode(state, m.box)
      return
    }
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
    if (flags & SEALED) {
      return { t: c.uint.decode(state), epoch: c.uint.decode(state), nonce: c.fixed(24).decode(state), box: c.buffer.decode(state) }
    }
    const out = { t: c.uint.decode(state), text: c.string.decode(state) }
    if (flags & HAS_REPLY) out.reply = { log: c.fixed32.decode(state), seq: c.uint.decode(state) }
    return out
  }
}

const isSealed = (m) => !!(m && m.box)

// What a sealed message's box holds: the text and reply, without the time
// (the time stays in the clear, segments and order need it).
const sealedContent = {
  preencode (state, m) {
    if (b4a.byteLength(m.text) > MAX_TEXT) throw new Error(`message text too long (max ${MAX_TEXT} bytes)`)
    c.uint.preencode(state, m.reply ? HAS_REPLY : 0)
    c.string.preencode(state, m.text)
    if (m.reply) {
      c.fixed32.preencode(state, m.reply.log)
      c.uint.preencode(state, m.reply.seq)
    }
  },
  encode (state, m) {
    c.uint.encode(state, m.reply ? HAS_REPLY : 0)
    c.string.encode(state, m.text)
    if (m.reply) {
      c.fixed32.encode(state, m.reply.log)
      c.uint.encode(state, m.reply.seq)
    }
  },
  decode (state) {
    const flags = c.uint.decode(state)
    const out = { text: c.string.decode(state) }
    if (flags & HAS_REPLY) out.reply = { log: c.fixed32.decode(state), seq: c.uint.decode(state) }
    return out
  }
}

// A keeper's grants bee: [recipient encryption key, epoch] -> sealed epoch
// key, signed by its granter (spec 008, data-model.md).
// `identity`: the recipient's identity, so keepers can refuse revoked members
// and check "key holders may grant" chains.
const grantValue = {
  preencode (state, g) {
    c.fixed32.preencode(state, g.identity)
    c.buffer.preencode(state, g.sealed)
    c.fixed32.preencode(state, g.granter)
    c.fixed64.preencode(state, g.sig)
  },
  encode (state, g) {
    c.fixed32.encode(state, g.identity)
    c.buffer.encode(state, g.sealed)
    c.fixed32.encode(state, g.granter)
    c.fixed64.encode(state, g.sig)
  },
  decode (state) {
    return { identity: c.fixed32.decode(state), sealed: c.buffer.decode(state), granter: c.fixed32.decode(state), sig: c.fixed64.decode(state) }
  }
}

// What a granter sends a keeper.
const grantSubmission = {
  preencode (state, g) {
    c.string.preencode(state, g.channel)
    c.fixed32.preencode(state, g.recipient)
    c.uint.preencode(state, g.epoch)
    grantValue.preencode(state, g)
  },
  encode (state, g) {
    c.string.encode(state, g.channel)
    c.fixed32.encode(state, g.recipient)
    c.uint.encode(state, g.epoch)
    grantValue.encode(state, g)
  },
  decode (state) {
    const channel = c.string.decode(state)
    const recipient = c.fixed32.decode(state)
    const epoch = c.uint.decode(state)
    return { channel, recipient, epoch, ...grantValue.decode(state) }
  }
}

// An invite, as a link carries it, signed by its maker.
const invite = {
  preencode (state, v) {
    c.fixed(16).preencode(state, v.id)
    c.fixed32.preencode(state, v.community)
    c.string.preencode(state, v.role || '')
    c.array(c.string).preencode(state, v.channels || [])
    c.uint.preencode(state, v.expires || 0)
    c.uint.preencode(state, v.uses || 0)
    c.fixed32.preencode(state, v.maker)
    c.fixed64.preencode(state, v.sig)
  },
  encode (state, v) {
    c.fixed(16).encode(state, v.id)
    c.fixed32.encode(state, v.community)
    c.string.encode(state, v.role || '')
    c.array(c.string).encode(state, v.channels || [])
    c.uint.encode(state, v.expires || 0)
    c.uint.encode(state, v.uses || 0)
    c.fixed32.encode(state, v.maker)
    c.fixed64.encode(state, v.sig)
  },
  decode (state) {
    return {
      id: c.fixed(16).decode(state),
      community: c.fixed32.decode(state),
      role: c.string.decode(state) || null,
      channels: c.array(c.string).decode(state),
      expires: c.uint.decode(state),
      uses: c.uint.decode(state),
      maker: c.fixed32.decode(state),
      sig: c.fixed64.decode(state)
    }
  }
}

// A newcomer's request to redeem an invite, signed by the newcomer.
const redemption = {
  preencode (state, r) {
    invite.preencode(state, r.invite)
    c.fixed32.preencode(state, r.identity)
    c.fixed32.preencode(state, r.encryptionKey)
    c.uint.preencode(state, r.writer ? 1 : 0)
    if (r.writer) c.fixed32.preencode(state, r.writer)
    c.uint.preencode(state, r.t)
    c.fixed64.preencode(state, r.sig)
  },
  encode (state, r) {
    invite.encode(state, r.invite)
    c.fixed32.encode(state, r.identity)
    c.fixed32.encode(state, r.encryptionKey)
    c.uint.encode(state, r.writer ? 1 : 0)
    if (r.writer) c.fixed32.encode(state, r.writer)
    c.uint.encode(state, r.t)
    c.fixed64.encode(state, r.sig)
  },
  decode (state) {
    const inv = invite.decode(state)
    const identity = c.fixed32.decode(state)
    const encryptionKey = c.fixed32.decode(state)
    const writer = c.uint.decode(state) ? c.fixed32.decode(state) : null
    return { invite: inv, identity, encryptionKey, writer, t: c.uint.decode(state), sig: c.fixed64.decode(state) }
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

// A grants bee key: [recipient encryption key, epoch].
const grantKey = {
  encode: ([recipient, epoch]) => c.encode(grantKeyEnc, { recipient, epoch }),
  decode: (buf) => { const { recipient, epoch } = c.decode(grantKeyEnc, buf); return [recipient, epoch] },
  // All of one recipient's grants.
  range: (recipient) => ({ gte: c.encode(grantKeyEnc, { recipient, epoch: 0 }), lt: c.encode(grantKeyEnc, { recipient: nextKey(recipient), epoch: 0 }) })
}
// Fixed-width so keys sort by recipient, then epoch (big-endian epoch).
const grantKeyEnc = {
  preencode (state) { state.end += 32 + 4 },
  encode (state, v) {
    c.fixed32.encode(state, v.recipient)
    state.buffer.writeUInt32BE(v.epoch, state.start)
    state.start += 4
  },
  decode (state) {
    const recipient = c.fixed32.decode(state)
    const epoch = state.buffer.readUInt32BE(state.start)
    state.start += 4
    return { recipient, epoch }
  }
}
function nextKey (key) {
  const out = b4a.from(key)
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] < 255) { out[i]++; return out }
    out[i] = 0
  }
  return b4a.alloc(out.length, 255)
}

module.exports = {
  MAX_TEXT,
  isSealed,
  message: wrap(message),
  sealedContent: wrap(sealedContent),
  grantValue: wrap(grantValue),
  grantSubmission: wrap(grantSubmission),
  grantKey,
  invite: wrap(invite),
  redemption: wrap(redemption),
  rosterValue: wrap(rosterValue),
  authorEntry: wrap(authorEntry),
  announcement: wrap(announcement),
  rosterSignable
}
