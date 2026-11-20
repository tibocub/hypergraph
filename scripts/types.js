// After tsc wrote the declarations (npm run types): adds what tsc doesn't copy. The symbols'
// hand-written declarations, and the types of the packages lib/ uses that ship none
// (types/, referenced from the entry points so TypeScript users get them too), and Node's own types
// (@types/node, a dependency): Hypergraph and Space are EventEmitters, timers are NodeJS.Timeout.

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const out = path.join(root, 'dist', 'types')
const VENDOR = ['hypercore', 'corestore', 'autobase', 'hyperswarm']
// Shipped as modules of ours, not global `declare module`s: swarmwire declares protomux too, and two
// `declare module 'protomux'` clash in a user's build. Imports of them are pointed at our copy.
const PRIVATE = ['protomux']

fs.copyFileSync(path.join(root, 'lib', 'symbols.d.ts'), path.join(out, 'symbols.d.ts'))
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true })
for (const name of [...VENDOR, ...PRIVATE]) fs.copyFileSync(path.join(root, 'types', name + '.d.ts'), path.join(out, 'vendor', name + '.d.ts'))

for (const file of fs.readdirSync(out, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.d.ts')).map((f) => path.join(out, f))) {
  const text = fs.readFileSync(file, 'utf8')
  const fixed = text.replace(/(import\(|from )(["'])([^"']+)\2/g, (all, head, q, spec) => {
    if (!PRIVATE.includes(spec)) return all
    const rel = path.relative(path.dirname(file), path.join(out, 'vendor', spec + '.js')).split(path.sep).join('/')
    return head + q + (rel.startsWith('.') ? rel : './' + rel) + q
  })
  if (fixed !== text) fs.writeFileSync(file, fixed)
}

for (const entry of ['index.d.ts', 'app-testing.d.ts']) {
  const file = path.join(out, entry)
  const refs = '/// <reference types="node" />\n' + VENDOR.map((name) => `/// <reference path="./vendor/${name}.d.ts" />\n`).join('')
  fs.writeFileSync(file, refs + fs.readFileSync(file, 'utf8'))
}
