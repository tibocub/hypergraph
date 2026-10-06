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
  version identifier**. The consumers declare this repo as `"hypergraph": "file:../hypergraph"`,
  so `npm install` links them to this working tree instead of copying a snapshot. A stale copy is
  not a safe fallback but a silently-incompatible peer that rejects events signed by a current one —
  hyperDNS ran one for weeks before the switch; see `ECOSYSTEM.md`.

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

**On Windows, prefix these scripts with `PYTHONIOENCODING=utf-8`:**

```bash
PYTHONIOENCODING=utf-8 python3 .specify/scripts/python/setup_tasks.py --json
```

Without it they crash with `UnicodeEncodeError: 'charmap' codec can't encode characters` whenever
their output contains non-ASCII — which it does as soon as a template or spec uses an em-dash.
Python defaults to the cp1252 console encoding here, not UTF-8. Confirmed directly: `setup_tasks.py`
failed exactly this way. The failure looks like a broken script, but the script is fine — it's the
output encoding.

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
`npm run test:serial` (and the per-group scripts) run every file of a group in *one* brittle
process — a force-exit in one file kills sibling files' still-running tests before they report,
silently truncating the suite (it hid 8 never-run networking tests from 2026-07 to 2026-10). If a
file is slow to exit, something is left open: find it (a preload that lists live timers did it
every time: uncancelled `Promise.race` timers, Hyperswarm discovery timers, a `connect()` still
retrying) and close it.

**Network tests use a local DHT, not the internet.** `testSwarm(t)` / `testBootstrap(t)` from
`test/brittle/helpers.js` give each test a 3-node DHT on 127.0.0.1 (real Hyperswarm/UDP, torn
down with the test); `HG_TEST_PUBLIC_DHT=1` runs them on the public DHT instead — with
`--jobs 1`: eight files bootstrapping on the internet DHT at once time out (measured; one at a
time they pass, and faster than before the retry change). Use `within()`
from the same file, not `Promise.race([x, sleep(n)])`, which leaves a timer keeping the process
alive.

## Running tests

```bash
npm test                                   # full suite, one process per file, in parallel (~1 min)
node scripts/test-runner.js core           # one group (core, networking, replication, forum, integration)
node scripts/test-runner.js test/brittle/replication/invites.js   # given files
node scripts/test-timeline.js <file> [re]  # one file, each line with seconds elapsed: where it waits
npm run test:serial                        # the old way: groups one after another, one process per group
```

`npm test` (`scripts/test-runner.js`) uses all cores but two (`HG_TEST_JOBS=n` to change), runs
test processes at below-normal priority, waits while free memory is under 1.5 GB, starts the
longest files first (by their last run, in the gitignored `.test-times.json`), fails a file that
doesn't print its own `# tests = n/n` line, and prints the slowest files. While iterating, run only the affected files or group; run the full
suite once before committing. Tests use `brittle`, run via `npx brittle <file>`.

Measured 2026-10-06 (8 cores): `npm test` 63 s wall with 6 jobs (57 s with 8) for 320 tests (the
old serial `npm test`: 514 s); HyperBBS `npm test` 40 s, hyperDNS 15 s.

**Don't load the machine at 100% for long.** The dev machine rebooted hard (no crash dump, no
low-memory event) during a 100k-message `bench/chat.js` run with 11 Node processes pinning every
core. Benchmarks: start with `npm run bench:quick` (~1 min); run big sizes only when needed, with
fewer writers, and check the machine copes.
