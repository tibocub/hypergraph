# Quickstart: validating spec 011

How to check, at any point of the implementation, that what exists works. Contract:
[contracts/api.md](contracts/api.md); data: [data-model.md](data-model.md).

## Prerequisites

- Node (as used by the repo) and Bare 1.27+ on PATH (`bare --version`).
- `npm install` in the repo (adds the dependencies of research R3).

## Run

```bash
npm run test:next            # the new core's tests on Node (unit, network on a local DHT, forum scenarios)
npm run test:next:bare       # the same tests on Bare
node scripts/test-runner.js next            # through the parallel runner
npm test                     # v1's suite still passes (SC-013)
cd ../hyperDNS && npm test   # hyperDNS still passes (SC-013)
```

Expected: every file prints its own `# tests = n/n`; nothing hangs (each test ends within its bound).

## The scenarios, by story

| story | scenario files (`test/next/forum/`) | what passes means |
|---|---|---|
| 1 | `sign-up.js`, `post-comment-vote.js`, `edit-delete.js`, `live.js` | three members agree within 1 s; votes one per member; live list not re-run on comments |
| 2 | `moderation.js`, `rules.js` | hide/reveal/remove/ban with cut; offline member converges; non-member and rule-breaking records never indexed |
| 3 | `devices.js`, `personal.js` | second device by code; latest wins with a clock 1 h ahead; lost device cut |
| 4 | `invites.js` | offline inviter; expired/used/revoked refused; public link + write limit |
| 5 | `graph.js`, `wiki.js` | relations, edges, tags, paging; shared editing by permission |
| 6 | `budgets.js`, `bounded.js`, `rebuild.js` | budgets held; incomplete within the bound; index rebuilt |
| 7 | `versions.js` | two app versions read each other; bad type change refused |
| 8 | `subforums.js`, `private.js` | inheritance; parent ban wins; guests; private read/revoke |
| 9 | `bench/next/` | first page at 10k vs 1M within SC-004; spam not kept |

## Benchmarks (SC-004, SC-005, SC-008, SC-011, SC-012)

```bash
node bench/next/first-page.js --records 10000      # then --records 1000000 (long: ask before running)
node bench/next/writers.js --authors 50
node bench/next/rebuild.js --records 100000
```

Keep runs short by default; the dev machine has rebooted under long all-core runs (CLAUDE.md).

## Manual check (a forum in two terminals)

Two `Hypergraph.open` instances in two folders on the local DHT, one creates a space and an invite, the
other redeems it; both post and see each other's posts. `test/next/forum/forum.js` is the reference app
code for this.
