// Fails when a public class, method, getter or exported function of the API has no JSDoc,
// or when a JSDoc @param names a parameter the function doesn't have.
// Usage: node scripts/docs-check.js [files...] (defaults to the public API's files)

const fs = require('fs')
const path = require('path')
const espree = require('espree')

// Exported classes are checked in every file; exported functions only in files that are an entry point
// (the other files export helpers for lib/ itself).
const PUBLIC = ['lib/index.js', 'lib/space.js', 'lib/scope.js', 'lib/index/query.js', 'lib/errors.js', 'lib/app-testing.js']
const ENTRY = ['lib/app-testing.js']
const root = path.join(__dirname, '..')

function check (file, functions) {
  const src = fs.readFileSync(file, 'utf8')
  const ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'script', comment: true, range: true, loc: true })
  const problems = []
  const blocks = ast.comments.filter((c) => c.type === 'Block' && c.value.startsWith('*'))
  const docOf = (node) => {
    // The JSDoc block that ends right before the node, with only whitespace between.
    const doc = blocks.find((c) => c.range[1] <= node.range[0] && !src.slice(c.range[1], node.range[0]).trim())
    return doc ? doc.value : null
  }
  const at = (node) => `${path.relative(root, file)}:${node.loc.start.line}`

  const exported = new Set()
  for (const st of ast.body) {
    const e = st.type === 'ExpressionStatement' && st.expression
    if (e && e.type === 'AssignmentExpression' && e.left.type === 'MemberExpression' && e.left.object.name === 'module' && e.right.type === 'ObjectExpression') {
      for (const p of e.right.properties) if (p.key) exported.add(p.key.name)
    }
  }

  const fn = (name, node, fnNode) => {
    const doc = docOf(node)
    if (doc === null) { problems.push(`${at(node)} ${name}: no JSDoc`); return }
    const named = []
    const slots = { names: new Set(), patterns: 0 }
    for (const p of fnNode.params) {
      const q = p.type === 'AssignmentPattern' ? p.left : p.type === 'RestElement' ? p.argument : p
      if (q.type === 'Identifier') slots.names.add(q.name)
      else slots.patterns++
    }
    for (const m of doc.matchAll(/@param\s+(?:\{[^}]*\}\s*)?\[?([A-Za-z_$][\w$]*)/g)) {
      if (!named.includes(m[1])) named.push(m[1])
    }
    // A destructured parameter has no name: any one documented name may stand for it.
    const unknown = named.filter((n) => !slots.names.has(n))
    for (const n of unknown.slice(slots.patterns)) problems.push(`${at(node)} ${name}: @param ${n} is not a parameter`)
  }

  for (const st of ast.body) {
    if (functions && st.type === 'FunctionDeclaration' && exported.has(st.id.name)) fn(st.id.name, st, st)
    if (functions && st.type === 'VariableDeclaration') {
      for (const d of st.declarations) {
        const init = d.init && /Function/.test(d.init.type) ? d.init : null
        if (init && d.id.type === 'Identifier' && exported.has(d.id.name)) fn(d.id.name, st, init)
      }
    }
    if (st.type === 'ClassDeclaration' && exported.has(st.id.name)) {
      if (docOf(st) === null) problems.push(`${at(st)} class ${st.id.name}: no JSDoc`)
      for (const m of st.body.body) {
        if (m.type !== 'MethodDefinition' || m.key.type === 'PrivateIdentifier') continue
        const name = m.key.name || m.key.value
        if (!name || name.startsWith('_')) continue
        const label = `${st.id.name}.${name}`
        if (m.kind === 'constructor') { if (docOf(m) !== null) fn(label, m, m.value); continue }
        fn(label, m, m.value)
      }
    }
  }
  return problems
}

module.exports = { check }

if (require.main === module) {
  const files = process.argv.length > 2
    ? process.argv.slice(2).map((f) => [f, true])
    : PUBLIC.map((f) => [path.join(root, f), ENTRY.includes(f)])
  const problems = files.flatMap(([f, functions]) => check(f, functions))
  for (const p of problems) console.log(p)
  const missing = problems.filter((p) => p.endsWith('no JSDoc')).length
  console.log(`${missing} without JSDoc, ${problems.length - missing} wrong @param names`)
  process.exitCode = problems.length ? 1 : 0
}
