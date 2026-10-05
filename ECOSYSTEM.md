# The Hyper* Ecosystem

Canonical map of how these projects fit together. Lives in `hypergraph` because hypergraph is
the hub — everything else depends on it, and it depends on none of them. Every sibling repo's
`CLAUDE.md` carries a short summary of this and points here for the full picture.

Written for whoever (or whatever) lands in one of these repos cold and needs the shape of the
whole thing before touching anything.

## The map

```
                    ┌─────────────────┐
                    │   HyperBBS      │  terminal-first P2P browser
                    │  (the client)   │  renders hypersites
                    └────────┬────────┘
                             │ depends on
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
      ┌──────────────┐ ┌───────────┐ ┌─────────────┐
      │  hypergraph  │ │  HyperMD  │ │  hyperDNS   │
      │ (data layer) │ │ (document │ │  (naming)   │
      │              │ │  format)  │ │             │
      └──────▲───────┘ └───────────┘ └──────┬──────┘
             │                              │
             └──────────────────────────────┘
                      depends on

      ┌──────────────┐
      │   SwarmFS    │  bulk file transfer — PAUSED, will depend on hypergraph
      └──────────────┘
```

**Dependency direction is one-way.** hypergraph knows nothing about its consumers. Consumers
know about hypergraph. Nothing consumes HyperBBS.

| Project | Role | Depends on |
|---|---|---|
| **hypergraph** | P2P graph database — entities, relations, tags, content, multi-writer contexts (Autobase), roles/permissions, encrypted read-scopes. The shared data + identity + permission substrate. | Holepunch stack only |
| **HyperMD** | Document format (`.hmd`) — Markdown + directives (`:::query`, `:::script`) for layout, data views, sandboxed scripting | (standalone) |
| **HyperBBS** | Terminal-first P2P browser. A "hypersite" *is* a hypergraph graph; visiting one = replicating it. Renders HyperMD via OpenTUI. | hypergraph, HyperMD |
| **hyperDNS** | Federated naming — `name@authority` resolves to addresses without a central registry. An authority is a trust/moderation boundary, not a global namespace. | hypergraph |
| **SwarmFS** | P2P file transfer — content-addressed (merkle roots), chunked, topic-scoped. **Development paused** pending hypergraph features. | (Holepunch directly, for now) |

## Where they live (and what NOT to open)

All on this machine under `E:\Code\P2P\`:

```
E:\Code\P2P\hypergraph\     ← the hub
E:\Code\P2P\HyperBBS\
E:\Code\P2P\HyperMD\
E:\Code\P2P\hyperDNS\
E:\Code\P2P\SwarmFS\
```

⚠ **`E:\Code\P2P\` contains many near-duplicate and abandoned directories.** Before working in
one, confirm you're in the right one:

- `SwarmFS\` is the live one. **`SwarmFS-main\`, `SwarmFS-copy\`, `SwarmFS.old\`, `SwarmFS-0.1\`
  are not** — do not edit them, do not read them for "current" behavior.
- `HyperBBS\` is the live one. **`hyper-bbs\` (lowercase, hyphenated) is a different, older
  directory** — not the same project state.
- Many other `E:\Code\P2P\*` directories are vendored upstream libraries (`hypercore`,
  `corestore`, `autobase`, `hyperswarm`, `hyperbee`) or unrelated experiments. Reading upstream
  source there is legitimate and often useful; editing it is almost never what you want.

## How they're actually wired

**Local sibling repos are symlinked into `node_modules`, not installed from a registry.**

```
HyperBBS/node_modules/hypergraph -> E:\Code\P2P\hypergraph   (live symlink)
HyperBBS/node_modules/hypermd    -> E:\Code\P2P\HyperMD      (live symlink)
hyperDNS/node_modules/hypergraph -> E:\Code\P2P\hypergraph   (live symlink)
```

Consequences that matter:

1. **Edits to hypergraph are immediately live in HyperBBS and hyperDNS.** There is no publish
   step, no version bump, no lag. A breaking change lands in every consumer the instant you save.
2. hypergraph and HyperMD are **not published to npm**. Consumers declare them as **local folder
   paths**: `"hypergraph": "file:../hypergraph"` and `"hypermd": "file:../HyperMD"`. On
   `npm install` or `npm ci`, npm creates a real link (a Windows junction) to the sibling checkout
   by itself, and the lockfile records it as `"resolved": "../hypergraph", "link": true`. The
   sibling folder must sit next to the consumer, as it does under `E:\Code\P2P\`.
3. SwarmFS does not have hypergraph installed at all yet — consistent with its paused status.

**Why local paths rather than `github:` references** (switched 2026-09-13): npm 12 refuses git
dependencies by default — its built-in `allow-git` setting is `"none"` — so
`"github:tibocub/hypergraph"` made a fresh `npm install` fail outright. And even when git installs
worked, they produced a *snapshot* of GitHub's copy, which went stale as soon as the local checkout
moved on. Local paths fix both: nothing is fetched, and the link always points at the current
working tree.

Verified rather than assumed, on a throwaway project: a fresh `npm install` creates a junction,
`npm ci` (which wipes `node_modules` first) recreates it, and — the property that matters most —
the linked source folder survives `npm ci` intact rather than being deleted *through* the link.

**The cost**: cloning HyperBBS or hyperDNS on its own, without hypergraph (and HyperMD) beside it,
will not install. That is acceptable while everything is developed side by side and nothing is on
npm. Revisit when publishing.

### The stale-copy trap, and why `ln -s` must not be used

**This trap bit twice before the switch**: hyperDNS was running a real directory copy of
hypergraph rather than a link, so its passing test suite said nothing about compatibility with
current hypergraph.

**The second time, the copy was created by `ln -s` itself.** In Git Bash on Windows, `ln -s`
does not make a link unless the `MSYS` environment variable enables native symlinks — by default it
**silently copies the whole directory** and reports success. The "fix" for the first stale copy
(Sep 9) therefore produced a second one: a 765 MB snapshot including hypergraph's own `.git` and
`node_modules`, which quietly went stale the moment hypergraph changed again. Tests passed against
it for days.

With `file:` dependencies there is no reason to link by hand — `npm install` does it. If a link
ever needs manual repair, **never use `ln -s` on Windows**; make a junction:

```bash
cmd //c "mklink /J node_modules\\hypergraph E:\\Code\\P2P\\hypergraph"
```

**Verify a link is real — don't trust a command's success message:**

```bash
cmd //c "dir /AL node_modules"   # a real link shows <JUNCTION> or <SYMLINKD>; a copy shows nothing
```

Checking that the files look right proves nothing, since a fresh copy looks identical to the
original until the original changes.

Note also that hypergraph's `package.json` version is `0.0.1` and has never moved across any of
these changes — **the git SHA is the only real version identifier.** That is why a stale copy was
silent rather than loud.

## Cross-repo working rules

1. **Changing hypergraph? Run the consumers' tests too.** They are symlinked, so you have already
   changed them whether you meant to or not.
   ```bash
   cd E:\Code\P2P\hypergraph && npm test
   cd E:\Code\P2P\HyperBBS   && npm test
   cd E:\Code\P2P\hyperDNS   && npm test
   ```
2. **hypergraph is ALPHA and takes intentional breaking changes** — that's allowed, but they must
   land in `hypergraph/CHANGELOG.md` as a dated entry saying what broke and how to migrate
   (constitution Principle V). Consumers have no other signal.
3. **Debugging across a boundary?** Read the other repo's source directly — it's right there on
   disk. Isolate which side the bug is on by reproducing the dependency's own proven usage
   pattern before assuming either side (this is HyperBBS constitution Principle IV; the
   `bin/scratch-*.js` scripts there exist precisely for this).
4. **Don't duplicate hypergraph's job.** Consumers compose its primitives; they don't reimplement
   graph/replication/permission logic locally. hyperDNS already retired one hand-rolled
   networking class for exactly this reason.

## Long-term direction

The through-line: **a serverless web stack.** Naming (hyperDNS) + data and permissions
(hypergraph) + documents (HyperMD) + bulk files (SwarmFS), browsed through a terminal-first
client (HyperBBS) — with no servers anywhere, only peers.

Per-project direction, and how firm it is:

- **hypergraph** — the load-bearing one. Its job is to be a foundation the others can trust for
  data, replication, and identity/permissions. Its own constitution names correctness under
  concurrency/partition as the non-negotiable core, because downstream projects cannot work
  around it being wrong. *(Documented: `.specify/memory/constitution.md`)*
- **HyperBBS** — nearest-term consumer and the reason hypergraph's ergonomics matter. Current
  state is honest and specific: hosting/visiting a hypersite is actively being debugged.
  *(Documented: `README.md` "Status" checklist — kept current, trust it)*
- **hyperDNS** — beyond current resolution: federation, moderation, and eventually browser
  `hyper://` integration so HyperBBS can address sites by name instead of raw pubkey.
  *(Partly documented; `WORKFLOW.md`'s embedded roadmap is stale — the project is well past the
  phase it describes. Prefer `DECISIONS.md`'s recent entries for actual direction.)*
- **SwarmFS** — paused by choice, waiting on hypergraph to provide multi-writer virtual
  directories, users/friends, and moderated swarms rather than duplicating that work.
  *(Documented: `README.md` top note)*

## Where each project documents itself

Each repo has its own spec-kit setup (`.specify/memory/constitution.md` + `.claude/skills/`) and
a `CLAUDE.md`. Beyond that they differ, and the differences are mostly deliberate:

| Project | Read these, in this order |
|---|---|
| hypergraph | `CLAUDE.md` → constitution → `docs/` (current-state reference) → `docs/contributors/` (internals) → `CHANGELOG.md` (why things changed) |
| HyperBBS | `CLAUDE.md` → constitution → `README.md` (architecture + HyperMD spec + honest Status checklist) |
| hyperDNS | `CLAUDE.md` → constitution → `docs/` (`ADDRESSING`, `NETWORKING`, `PRIVACY` are authoritative) → `DECISIONS.md` (dated decision log). `WORKFLOW.md` is legacy (banner-marked). |
| SwarmFS | `AGENTS.md` (primary) → `INVARIANTS.md` (authoritative rules) → `AI_CONTEXT.md` → `DATAFLOW.md` → constitution. `CLAUDE.md` is just a pointer. Working branch is `dev`, not `master`. |
| HyperMD | `CLAUDE.md`. The format spec itself lives in **HyperBBS's** `README.md`, not here. |

### Test-suite trustworthiness varies — know what a green run proves

| Project | `npm test` | What green actually means |
|---|---|---|
| hypergraph | 305 tests in 5 stages (core 226, networking 37, replication 29, forum 12, integration 1) | Real coverage, incl. real-Hyperswarm two-peer replication. Every stage must print its own `# tests = n/n` line: until 2026-10-05 a `process.exit(0)` workaround cut networking short (8 tests silently never ran) while still exiting 0 |
| hyperDNS | 46 tests / 103 asserts | Real coverage |
| HyperBBS | sandbox + db + network + identity | Real coverage, incl. 4 real-swarm suites |
| **HyperMD** | **smoke only** | **Nothing.** `test/*.js` are `console.log` probe scripts reporting **0 asserts**. Green means "did not throw." Cover format changes from HyperBBS's side. |

**Backlogs**: hypergraph keeps `API_PROBLEMS.md` / `TODO.md` as minimal bullet lists of genuinely
open items awaiting a `/speckit-specify` pass. The others don't have an equivalent — open work
lives in their READMEs' status sections or decision logs.

---

*Verified compatible 2026-10-05 (compact index keys): hypergraph (305/305 across all five
stages), hyperDNS (46/46) and HyperBBS (full chained suite) pass against the working tree.*

*Verified compatible 2026-09-10: hypergraph (143/143 + 12/12 + 1/1), hyperDNS (46/46), and
HyperBBS (full chained suite) all pass against the current hypergraph working tree — after
hypergraph's breaking changes to `removeRole()`'s signature and to relation/tag signature binding.*

*Two real cross-boundary bugs were found and fixed in HyperBBS during that verification, both
caused by its `src/db.js` header comment having drifted from hypergraph's actual behavior: it
minted a fresh context per sandbox write (which made hypergraph throw on every later
context-scoped read, and made the writes invisible), and it treated `encrypted: true` as
"unreadable" when hypergraph returns that flag alongside successfully decrypted plaintext. Both
now have regression tests in `HyperBBS/test/brittle/db/sandbox-writes.js`, verified to fail
without the fix. The lesson is in the table above: a consumer's notes about the hub go stale
silently, because nothing tests a comment.*
