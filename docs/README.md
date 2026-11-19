# Documentation

For building an app on `require('hypergraph/next')`:

- [Concepts](next/concepts.md): spaces, records, edits and deletes, devices, decisions, roles, private
  spaces, helpers, budgets, big spaces, and how each works underneath.
- [API](next/api.md): every call, with examples, its options and what it refuses.
- ["Deleted" and "incomplete", plainly](next/deleting-and-incomplete.md): what to tell your users.
- [Testing your app](next/testing.md): `hypergraph/testing`, a local DHT and temp folders per test.
- **API reference**: `npm run docs` generates it from the JSDoc in `lib/` into `out/api/` (open
  `out/api/index.html`). It lists every parameter, default, return value, error code and event.
- [The inspector](../tools/inspector/README.md): a read-only web page showing what a running instance
  holds.

For working on hypergraph itself:

- [CONTRIBUTING.md](../CONTRIBUTING.md): set up, test, send a change.
- [ECOSYSTEM.md](../ECOSYSTEM.md): the sibling projects that use this repo, and what to run after a change.
- [decisions.md](decisions.md): the dated decision log, kept as written.
- `specs/`: the design of each feature (spec, plan, tasks, research), one folder per feature.

The old version:

- [v1/](v1/): docs of v1 (`src/`, `require('hypergraph')`), frozen and to be removed with it.
