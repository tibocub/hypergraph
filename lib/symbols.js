// Internal entry points shared by lib/ and lib/testing.js. Symbols, so an app
// has to go out of its way to reach them.

module.exports = {
  openSpace: Symbol('hypergraph.openSpace'), // opens a space by key without joining it
  crashAfter: Symbol('hypergraph.crashAfter'), // tests: the next instance stops committing after n indexing batches
  deaf: Symbol('hypergraph.deaf'), // tests: a directory ignores the notices and summaries it receives
  epochKeys: Symbol('hypergraph.epochKeys'), // tests: a private space's keys held here
  keyWork: Symbol('hypergraph.keyWork'), // tests: a private space's key work, run now
  opensWith: Symbol('hypergraph.opensWith'), // tests: does a copied key store open a record's block
  ownLog: Symbol('hypergraph.ownLog'), // tests: this device's log in a space, accepted as at a first record
  slowLists: Symbol('hypergraph.slowLists'), // tests: directory lists from peers are looked at this many ms late
  idleLogs: Symbol('hypergraph.idleLogs') // tests: a held log unused this many ms closes
}
