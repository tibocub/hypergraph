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
| 2 | **Forum scenario tests** (in this repo, no UI) | the API is easy; every flow tested | built alongside 1, from its first story |
| 3 | **SwarmFS** rewrite on the new core + swarmwire (`E:\Code\P2P\SwarmFS`) | files and folders, two devices, big archives | starts after spec 011's story 3; its needs are in spec 011 |
| 4 | **HyperBrowser** (codename; HyperBBS's vision in a web UI, own repo) | a real app people use; a forum site is the real proof | starts after spec 011's first stories; its needs are in spec 011 |

v1 (`src/`) stays frozen until hyperDNS moves to the new core. HyperBBS (the terminal app) is paused.
Spec 009 (helpers, availability) is retargeted onto the new core after 1.

## Decisions (newest first)

- **2026-10-08 (SwarmFS / HyperBrowser grilling)**:
  - Everything is immutable underneath: an edit is a new record replacing an earlier one, a delete a
    tombstone. A type says who may edit its records (author, a permission, any member) — wikis, shared
    folders.
  - **Sub-spaces** instead of areas: the API offers `createSubspace()`; underneath, a separate space
    linked from its parent, inheriting members and roles; stricter rules or private allowed; its own
    extra members allowed; **a parent ban always wins**. Admins split big archives explicitly.
  - **A personal space per identity** across its own devices (device list, my spaces, settings, what
    each device holds); devices join by code / QR.
  - **One instance, one storage folder, many spaces**, one set of connections.
  - **Storage budget**: one for the whole app, and optionally a budget for a given space taken out of
    it (10 GB app, 1 GB for one space → 9 GB shared by the others). Policies cover records, not file
    bytes moved by apps.
  - Apps can add their own protocol to a space's connections (hypergraph's own stays on by default);
    defaults work untuned, settings adjustable.
  - App rules reject bad data before it is kept or passed on.
  - The reddit-clone app is dropped: **forum scenario tests** (no UI) in this repo instead; the real
    proof is a forum site in HyperBrowser. HyperBrowser = HyperBBS's vision in a web UI (codename,
    renamed before 1.0); HyperMD scripts must be sandboxed (its spec).
  - Spec 011's story order: forum basics, rules, devices + personal space (SwarmFS can start), invites,
    graph vocabulary + shared editing, partial holding, app versions, sub-spaces, big spaces.
  - SwarmFS keeps "full file list per member" in small and medium spaces (auto policy does it; ~0.6 GB
    per million files); huge archives split into sub-spaces; redundancy for huge ones waits for spec 009.

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

1. Spec 011 is planned (branch `011-spaces-core`: spec, plan, research R1–R20, data model, API contract,
   76 tasks).
2. **Worker session 1**: spec 011 phases 1–3 (setup, foundation, story 1: a forum between three members,
   on Node and Bare). Stops at the MVP checkpoint for review here.
3. Then worker sessions for story 2 (rules) and story 3 (devices, personal space) → SwarmFS can start.
