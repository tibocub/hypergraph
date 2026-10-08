# Roadmap

The project's direction and how we work. **The repo is the memory**: every decision lands in a file
(this one, `specs/research/design-brief.md`, the specs), never only in a conversation. Any session —
a lead conversation or a worker — starts by reading this file.

## The goal

The easiest kit to build server-less, decentralized social apps (forums, chats, wikis, file sharing,
HyperMarkdown sites) without knowing replication, cryptography or networking. Revive the indie web.

## The projects, in order

| # | Project | What it proves | Status |
|---|---|---|---|
| 1 | **hypergraph's new core** ("spaces", spec 011) | the kit itself | spec written; plan next |
| 2 | **The reddit clone** (`examples/`, built with the core) | the API is easy; every flow tested | built alongside 1, from its first story |
| 3 | **SwarmFS prototype** on the new core (repo `E:\Code\P2P\SwarmFS`) | files and folders, big archives | waits for 1's first stories; its needs feed spec 011 now |
| 4 | **The web app** (HyperBBS's successor, name to find) | a real app people use | waits for 1's first stories; its needs feed spec 011 now |

v1 (`src/`) stays frozen until hyperDNS moves to the new core. HyperBBS (the terminal app) is paused.
Spec 009 (helpers, availability) is retargeted onto the new core after 1.

## Decisions (newest first)

- **2026-10-08** — The web app starts as a local Node program plus a browser tab (fast to build), and
  ships later as a Pear app (desktop, then Android and iOS). **The core is tested on Bare as well as
  Node from the start**, not when shipping. Checked: every Holepunch dependency (Hypercore, Corestore,
  Hyperswarm, Autobase, Hyperbee, HyperDB, keet-identity-key, Protomux, sodium) loads in Bare 1.27;
  Node's built-ins (`path`, `fs`, `os`) don't, so the new core never uses them directly.
- **2026-10-08** — SwarmFS and the web app are consumers of the core like the reddit clone: their
  needs go into spec 011 before planning; their own specs start once the core's first stories work
  (earlier, they would drift from the real API).
- **2026-10-08** — Latest wins for edits and votes from several devices (stamped with the later of the
  device clock and one more than the newest own record seen); `context` → `space`; default storage
  policy "auto". See the design brief.
- **2026-10-07** — Redesign instead of porting v1 onto v2: records owned by authors, a decision log per
  space, readers enforce the rules, local indexes (HyperDB). See the design brief.

## How we work

- **Lead conversation** (Tibo + Claude): decides direction, writes and reviews specs, prepares the
  prompts for worker sessions, reviews their work before merge. It may be restarted fresh at any time:
  this file and the specs carry everything.
- **Worker sessions**: one job each (a spec's plan, a phase of tasks, a research question), on their
  own branch and worktree, following CLAUDE.md and the spec-kit flow. They commit on their branch and
  stop; nothing merges to master without a review in the lead conversation.
- **One session building the core at a time** (conflicts, and the dev machine's load limits);
  research, docs or another repo can run alongside.
- Every change to the core's API updates the reddit clone and its tests in the same change
  (CLAUDE.md rule 3).

## Now

1. Feed SwarmFS's and the web app's needs into spec 011; settle the web app's name and scope.
2. `/speckit-plan` and `/speckit-tasks` for spec 011 (in the lead conversation).
3. Then the first worker session: spec 011's foundation and story 1 (a forum in a few lines), with the
   reddit clone's first tests, on Node and Bare.
