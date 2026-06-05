function key (ev) {
  return `${ev.author}:${ev.action}:${ev.target}`
}

function dedupe (events) {
  const seen = new Set()
  const out = []
  for (const ev of events) {
    const k = key(ev)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(ev)
  }
  return out
}

module.exports = class ForumPolicy {
  constructor (opts = {}) {
    this.trustedModeratorKeys = new Set(opts.trustedModeratorKeys || [])
    this.maxFlags = typeof opts.maxFlags === 'number' ? opts.maxFlags : 3
  }

  evaluate (moderationEvents) {
    const events = dedupe(moderationEvents || [])

    let flags = 0
    let action = null
    let removed = false
    let lastVisAction = null
    let lastVisTs = -1

    for (const ev of events) {
      if (ev.action === 'content.flag') {
        flags++
        continue
      }

      if (!this.trustedModeratorKeys.has(ev.author)) continue

      if (ev.action === 'content.remove') {
        removed = true
        continue
      }

      if (ev.action === 'content.hide' || ev.action === 'content.reveal') {
        const ts = typeof ev.timestamp === 'number' ? ev.timestamp : 0
        if (ts >= lastVisTs) {
          lastVisTs = ts
          lastVisAction = ev.action
        }
      }
    }

    if (removed) {
      action = 'content.remove'
    } else if (lastVisAction === 'content.hide') {
      action = 'content.hide'
    } else {
      action = null
    }

    const visible = action !== 'content.remove' && action !== 'content.hide'
    return { visible, action, flags }
  }

  shouldShow (moderationEvents) {
    return this.evaluate(moderationEvents).visible
  }
}
