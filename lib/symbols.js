// Internal entry points shared by lib/ and lib/testing.js, kept off the
// public API: symbols, so an app has to go out of its way to reach them.

module.exports = {
  openSpace: Symbol('hypergraph.openSpace') // opens a space by key without joining it
}
