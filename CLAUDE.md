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

## You are the hub — live consumers break when you change

**[`ECOSYSTEM.md`](ECOSYSTEM.md) is the canonical map. Read it before any breaking change.**

hypergraph is consumed by four sibling projects on this machine under `E:\Code\P2P\`:
**HyperBBS** (browser), **hyperDNS** (naming), **HyperMD** (document format, doesn't depend on us),
**SwarmFS** (file transfer, paused, will depend on us).

`HyperBBS/node_modules/hypergraph` and `hyperDNS/node_modules/hypergraph` are **symlinks to this
working tree**. That means:

- Editing `src/` here changes both of those projects' runtime **immediately** — no publish, no
  version bump, no lag. Principle V permits intentional breaking changes; it does not make them
  invisible. A `CHANGELOG.md` entry is the *only* signal those consumers get.
- After a breaking or apply-time/wire-format change, run their suites too, not just ours:
  ```bash
  cd E:\Code\P2P\HyperBBS && npm test
  cd E:\Code\P2P\hyperDNS && npm test
  ```
- `package.json` here says version `0.0.1` and has never moved, so **git SHA is the only real
  version identifier**. hyperDNS's lockfile still pins an older commit; a stale copy there is not a
  safe fallback but a silently-incompatible peer that rejects events signed by a current one.

## Two rules that exist specifically to stop drift

These were added after an audit found that `docs/`, `API_PROBLEMS.md`, and `TODO.md` had partly
drifted from the actual code, because nothing enforced keeping them in sync. Don't let it happen
again:

1. **Doc-sync-on-change**: change a module backed by a `docs/contributors/*.md` file (or a
   top-level `docs/*.md`) → update that file in the *same* change. Not a follow-up.
2. **Regression-test-on-change**: fix a bug or change behavior anywhere in `src/` → add or update
   a test that fails before the change and passes after, in the *same* change.

## Spec-kit workflow

Every `/speckit-*` skill has `disable-model-invocation: false` — that means *I* (Claude) can
invoke these directly via the Skill tool, without the user typing the slash command. The user
does not need to learn these commands; when they ask for a fix or a feature in plain language,
decide myself whether to run spec-kit and which stages, rather than waiting to be told.

**When to actually run it**: for anything new or changed (not already-stable, unchanged
modules — don't retroactively spec those) that has real design decisions or multiple sub-parts,
run the pipeline myself:

`/speckit-specify` → (optional `/speckit-clarify`) → `/speckit-plan` → `/speckit-tasks` →
(optional `/speckit-analyze`, `/speckit-checklist`) → `/speckit-implement` → `/speckit-converge`
for periodic backlog sweeps against the codebase.

**When NOT to bother**: a small, already-understood fix (e.g. a confirmed bug with a clear
minimal patch) — just fix it directly with a regression test per the rule below. Running specify
→ plan → tasks → implement for something already fully scoped is ceremony with no payoff.

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

## Debugging an example app before assuming a library bug

Example apps under `examples/*` persist state locally (`.forum-web/`, etc., all gitignored) across
every manual run — device keypairs, a frozen `bootstrap.json`, old identities. That state can go
stale relative to itself (e.g. `bootstrap.json`'s recorded owner key no longer matching the
currently-persisted device-keypair.json, from an earlier partial reset) and produce symptoms that
look exactly like a networking/visibility bug but aren't. Confirmed directly: a real "peer can't
see owner's posts" + "comments don't work" report turned out to be entirely explained by exactly
this — wiping the example's local storage and retesting fresh fixed both, with zero code changes.
**Before treating an example app's misbehavior as a hypergraph bug, wipe its local storage
directory and reproduce fresh first.** If it's a real library bug, write the regression test
directly against the library (real Hyperswarm, two peers, `test/brittle/replication/` or
`test/brittle/networking/`) — that's also what actually caught the one real gap this investigation
found: cross-peer usercore discovery (`openUserCore()`) is the application's job, not automatic,
and it's easy to forget one direction of it.

**Real-network test files: never call `process.exit()` to work around a slow-to-exit process.**
`test:networking`/`test:replication` glob-match and run every file in *one* brittle process — a
force-exit in one file can kill sibling files' still-running tests before they get to report,
silently truncating the suite (confirmed directly: this happened when tried here). If a DHT/swarm
test leaves something alive for a while after finishing, that's an accepted, already-known
cost — slow-but-correct, not fast-but-truncates-siblings.

## Running tests

```bash
npm test                    # full suite: core, networking, replication, forum, integration
npm run test:core           # test/brittle/core/*.js
npm run test:networking     # test/brittle/networking/*.js
npm run test:replication    # test/brittle/replication/*.js
```

See `package.json` for granular per-file scripts (e.g. `test:contexts`, `test:roles`,
`test:late-joiner`). Tests use `brittle`, run via `npx brittle <file>`.
