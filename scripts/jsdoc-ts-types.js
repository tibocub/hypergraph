// A jsdoc plugin (jsdoc.json): lib/'s JSDoc types are TypeScript's (`import('./x.js').T`, arrow
// functions, `{ a?: T }`), which jsdoc's own parser refuses. A type it can't read is shown as
// written, as text (the `import('...')` part left out); the others are left alone.

const catharsis = require('catharsis')

const TAG = /@(?:param|arg|argument|returns?|type|typedef|property|prop|throws|exception|yields?)\s*\{/g

function readable (type) {
  try {
    catharsis.parse(type, { jsdoc: true })
    return true
  } catch {
    return false
  }
}

function rewrite (type) {
  if (readable(type)) return type
  const plain = type.replace(/import\((['"])[^'"]*\1\)\./g, '')
  if (readable(plain)) return plain
  return JSON.stringify(plain.replace(/\s+/g, ' ').trim())
}

exports.handlers = {
  jsdocCommentFound (e) {
    let out = ''
    let last = 0
    for (const m of e.comment.matchAll(TAG)) {
      const open = m.index + m[0].length - 1
      if (open < last) continue
      let depth = 0
      let end = open
      for (; end < e.comment.length; end++) {
        if (e.comment[end] === '{') depth++
        else if (e.comment[end] === '}' && --depth === 0) break
      }
      if (end >= e.comment.length) break
      const type = e.comment.slice(open + 1, end).replace(/\n\s*\*\s*/g, ' ')
      out += e.comment.slice(last, open + 1) + rewrite(type)
      last = end
    }
    e.comment = out + e.comment.slice(last)
  }
}
