# CLAUDE.md

Hypergraph: a P2P data library (spaces, records, roles, private spaces, circles) on
Hypercore/Autobase/HyperDB. The current core is `lib/` (`require('hypergraph/next')`); `src/` is the
frozen v1, to be removed: don't change it. Goal: the easiest kit for server-less social apps. Judge
every task against it, and say so when a request drifts from it.

Binding rules: `.specify/memory/constitution.md` (correctness under concurrency first; test-first for
replication code; a regression test with every fix or behaviour change).

## Tests

Temp data goes on a fast disk with enough room. On this machine C: is nearly full and E: is a
spinning disk, so point all three at E: and keep runs few:

```bash
export TMP='E:\Code\P2P\.tmp\tmp' TEMP='E:\Code\P2P\.tmp\tmp' HG_TEST_TMP='E:\Code\P2P\.tmp\tmp'
```

```bash
npm run test:next          # the core on Node
npm run test:next:bare     # the core on Bare
node scripts/test-runner.js test/next/forum/invites.js   # some files
node test/next/unit/fields.js                            # one file as a plain script
npm run perf               # perf scenarios; a hot-path change runs it before and after
```

Network tests use a local DHT (`test/next/helpers.js`); never `process.exit()` in a test file (it
kills sibling files in the same process): find what is left open instead. Don't pin every core for
long: the machine has rebooted under a long all-core benchmark.

## Live consumers

HyperBBS and hyperDNS link this working tree (`file:../hypergraph`), and SwarmFS builds on the new
core: a change in `lib/` reaches them at once. After a change to the core, run SwarmFS's suite too;
after a breaking change, add a `CHANGELOG.md` entry. Map: [ECOSYSTEM.md](ECOSYSTEM.md).

## Rules for every change

- **The forum scenario tests** (`test/next/forum/`) play a forum through the public API. A change to
  the API or its behaviour updates them in the same change; something awkward to write there is an
  API bug.
- **Comments**: only the why the code can't show, in as few words as it takes. No spec numbers,
  story ids, dates or names; keep warnings about subtle bugs and security choices.
- **JSDoc** on the public API (`Hypergraph`, `Space`, `Query`, `Scope`, `HypergraphError`,
  `hypergraph/testing`) stays complete and true: parameters, options with defaults, returns, error
  codes, events. `npm run docs:check` must pass; `npm run docs` builds the reference into `out/api/`.
- **Docs** move with the code: `docs/next/api.md` (every call), `docs/next/concepts.md` (how it works).

## Where things are

- `docs/README.md`: the docs index. `docs/decisions.md`: the dated decision log (append, don't
  rewrite). `ROADMAP.md`: one page; the maintainer edits it.
- `specs/<NNN-feature>/`: a feature's spec, plan and tasks (spec-kit: `/speckit-*` skills; on Windows
  run their Python scripts with `PYTHONIOENCODING=utf-8`). One branch per feature.
- `API_PROBLEMS.md`, `TODO.md`: short bullet backlogs, not prose.
- Example apps keep state in gitignored folders: wipe it before treating an example's misbehaviour as
  a library bug.
