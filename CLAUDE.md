# CLAUDE.md

Guidance for any Claude Code session working in this repo. Read this before doing anything else
here — it's the one file every session auto-loads, unlike `.specify/memory/constitution.md`
below, which only loads during a `/speckit-*` skill invocation.

## What this is

Hypergraph is a P2P graph database (ALPHA, breaking changes expected) built as a thin
composition layer over Hypercore/Corestore/Autobase/Hyperbee/keet-identity-key, for
Holepunch-ecosystem apps. It has no UI and no end-users of its own — the "user" is always the
developer consuming the API via `require('hypergraph')`.

## Governing document

**`.specify/memory/constitution.md` is the project's binding governance document.** Read it before
any non-trivial change. Its non-negotiable core: correctness under concurrency/partition
(Principle I), test-first for CRDT/replication code (Principle II) — and, project-wide, a
regression test for every significant fix or behavior change, not just that core tier.

## Two rules that exist specifically to stop drift

These were added after an audit found that `docs/`, `API_PROBLEMS.md`, and `TODO.md` had partly
drifted from the actual code, because nothing enforced keeping them in sync. Don't let it happen
again:

1. **Doc-sync-on-change**: change a module backed by a `docs/contributors/*.md` file (or a
   top-level `docs/*.md`) → update that file in the *same* change. Not a follow-up.
2. **Regression-test-on-change**: fix a bug or change behavior anywhere in `src/` → add or update
   a test that fails before the change and passes after, in the *same* change.

## Spec-kit workflow

For anything new or changed (not already-stable, unchanged modules — don't retroactively spec
those), use spec-kit in this order:

`/speckit-specify` → (optional `/speckit-clarify`) → `/speckit-plan` → `/speckit-tasks` →
(optional `/speckit-analyze`, `/speckit-checklist`) → `/speckit-implement` → `/speckit-converge`
for periodic backlog sweeps against the codebase.

`specs/<NNN-feature>/spec.md` → `plan.md` → `tasks.md` is the source of truth for that feature's
reasoning going forward — not a CHANGELOG narrative. `CHANGELOG.md` stays a terse, dated,
consumer-facing summary that links back to the spec folder for detail (existing pre-this-rule
"Round N" entries are historical record, left as-is).

## Backlog files

`API_PROBLEMS.md` and `TODO.md` are retired to minimal, undecorated bullet lists — genuinely open
items awaiting a `/speckit-specify` pass. They are NOT developer documentation and NOT a place to
write prose analysis (that habit is exactly what these files used to do before spec-kit was
adopted, and it's why they drifted). The moment an item is promoted into a real spec, delete it
from here.

## Spec-kit tooling requirement

The `/speckit-*` skills shell out to `.specify/scripts/python/*.py` (stdlib-only, no pip installs
needed) — `python3` must resolve on PATH for whatever shell is running the command. If a skill's
`python3 ...` invocation fails with "command not found," retry as `python .specify/scripts/...`
(some Windows setups only expose `python`, not `python3`).

## Git convention: branch per feature

No spec-kit git extension is installed in this repo, so branch creation isn't automatic. Follow
this manually: right after `/speckit-specify` creates `specs/<NNN-name>/`, run
`git checkout -b <NNN-name>` (same name as the spec directory). Merge back to `master` once that
feature's `/speckit-implement` is done and its tests pass.

## Running tests

```bash
npm test                    # full suite: core, networking, replication, forum, integration
npm run test:core           # test/brittle/core/*.js
npm run test:networking     # test/brittle/networking/*.js
npm run test:replication    # test/brittle/replication/*.js
```

See `package.json` for granular per-file scripts (e.g. `test:contexts`, `test:roles`,
`test:late-joiner`). Tests use `brittle`, run via `npx brittle <file>`.
