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
2. hypergraph is **not published to npm**. `package.json` declares it as
   `"hypergraph": "github:tibocub/hypergraph"`, but day-to-day development relies on the symlink.
   A fresh clone needs `npm link` (or `npm install` pulling the GitHub ref, which will be behind
   your local working tree).
3. SwarmFS does not have hypergraph installed at all yet — consistent with its paused status.

**A stale-copy trap has already bitten this ecosystem once**: hyperDNS was running a real
directory copy of hypergraph from a month earlier rather than a symlink, so its passing test
suite said nothing about compatibility with current hypergraph. If a consumer's tests pass
suspiciously easily after a hypergraph change, check that `node_modules/hypergraph` is actually
a symlink and not a snapshot.

### ⚠ `npm ci` / `npm install` will break the symlinks

The lockfiles do not describe the setup that actually works:

- **hyperDNS** pins `hypergraph` to commit `c239938` (2026-08-02) — behind the local checkout by
  apply-time signature-binding and validation changes. `npm ci` yields a peer that **rejects
  tag/relation events signed by a current peer**, presenting as "replication silently doesn't
  work" with nothing pointing at version skew.
- **HyperBBS** has **no `hypergraph` entry in its lockfile at all**, so `npm ci` cannot reproduce
  the working setup.
- Neither lock can be corrected yet: hypergraph's current work is uncommitted and unpushed, so
  there is no commit to pin to. Until hypergraph publishes, **the symlinks are the source of
  truth and the lockfile entries are known-stale.**

Restore a clobbered link with `npm link` in the dependency's checkout, then
`npm link hypergraph` (and/or `npm link hypermd`) in the consumer.

Note also that hypergraph's `package.json` version is `0.0.1` and has never moved across any of
these changes — **the git SHA is the only real version identifier.** That is exactly why a stale
pin is silent rather than loud.

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
| hypergraph | 143 + 12 + 1 tests, 387+ asserts | Real coverage, incl. real-Hyperswarm two-peer replication |
| hyperDNS | 46 tests / 103 asserts | Real coverage |
| HyperBBS | sandbox + db + network + identity | Real coverage, incl. 4 real-swarm suites |
| **HyperMD** | **smoke only** | **Nothing.** `test/*.js` are `console.log` probe scripts reporting **0 asserts**. Green means "did not throw." Cover format changes from HyperBBS's side. |

**Backlogs**: hypergraph keeps `API_PROBLEMS.md` / `TODO.md` as minimal bullet lists of genuinely
open items awaiting a `/speckit-specify` pass. The others don't have an equivalent — open work
lives in their READMEs' status sections or decision logs.

---

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
