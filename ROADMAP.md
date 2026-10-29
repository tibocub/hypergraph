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
| 1 | **hypergraph's new core** ("spaces", spec 011) | the kit itself | **merged into master 2026-10-22** (`require('hypergraph/next')`) |
| 2 | **Forum scenario tests** (in this repo, no UI) | the API is easy; every flow tested | built alongside 1, from its first story |
| 3 | **SwarmFS** rewrite on the new core + swarmwire (`E:\Code\P2P\SwarmFS`) | files and folders, two devices, big archives | starts after spec 011's story 3; its needs are in spec 011 |
| 4 | **HyperBrowser** (codename; HyperBBS's vision in a web UI, own repo) | a real app people use; a forum site is the real proof | starts after spec 011's first stories; its needs are in spec 011 |

v1 (`src/`) stays frozen until hyperDNS moves to the new core. HyperBBS (the terminal app) is paused.
Spec 009 (helpers, availability) is retargeted onto the new core after 1.

## Decisions (newest first)

- **2026-10-29 (forum web app, grilled with Tibo)** — Forum before HyperBrowser: a plain web app on `hypergraph/next`,
  its own repo `E:\Code\P2P\hypergraph-forum-example` (a consumer with `specs/requests-to-hypergraph.md`, like
  SwarmFS), built so its pieces seed HyperBrowser. Reddit-style, exactly what `test/next/forum/` covers (boards,
  threads, comments, votes, edit/delete, moderation, invites, devices); one forum, no community creation, no new core
  features. Invite-only (one-time codes sent by any chat), 5–20 friends. Every member keeps everything. Node + browser
  tab on `127.0.0.1` (README + copy-paste install script); plain HTML/JS, no build; a local JSON API mirroring the
  core's calls plus a live channel, random token. Text with basic Markdown, no images, no HyperMD yet. Device pairing
  in v1. Desktop only. Done = Tibo + 4 friends, 2 weeks, nothing lost, every post reaches everyone (a "posted at" vs
  "first seen elsewhere" log). **Helpers** (blind peers) built in parallel as hypergraph spec 013, never required: the
  forum works with no helper or with its VPS down (`addAutobaseBackground`, not `addAutobase`, which hangs while one
  is down — `specs/research/availability.md`). The owner lists helpers in the space's settings (end goal: anyone may
  add helpers unless it's a security risk); members connect to all of them in the background. The VPS runs
  `blind-peer-cli` unchanged, open to any forum, capped by `maxBytes` (blind-peer also has `trustedPubKeys`; untrusted
  clients can't make it announce, so members dial it directly).
- **2026-10-29 (SwarmFS 002 merged; hypergraph review read)** — SwarmFS spec 002 merged into its `001-personal-sync`
  (e450c4a, 63/63 Node and Bare; SC-001 3.8 s for 10,000 files, SC-004 36 s for 1,000). It filed H16 (no `change`
  for another device's edit), H17 (a device paired after a private space got ~1,000 records never gets access:
  blocks real use) and swarmwire S9 (served files stay open: Windows folders can't be renamed). The "Hypergraph
  code review" session (2026-10-28) found the root of H10/H12/H14/H16: reads wait by default and changing state has
  no signal. Decided (Tibo): hypergraph and SwarmFS kept in step: hypergraph is the foundation and must be
  reliable; SwarmFS is its real-usage test. Started in parallel: H17 fix (`lib/`), a spec "reads that don't
  wait, change events for everything that changes" (docs only until H17 merges), swarmwire S9.

- **2026-10-28 (SwarmFS spec 002 "always on", grilled with Tibo)** — Next after v1 (shared workspaces after it).
  Host: the running `swarmfs` shell acts on its own (watch, fetch, serve); no service, no IPC; login start and tray
  come with the desktop app. Desktops only; the library stays on Bare (the phone app, its own project, embeds it).
  Every added folder is a **linked folder** (two-way): new local files added, missing ones fetched; `link` links an
  existing space folder to a local path on another device, `unlink` leaves files. Inside linked folders SwarmFS
  renames, moves and updates files, and what it replaces or removes goes to `.swarmfs-trash` (constitution I amended
  for linked folders only, MINOR). A local delete removes the entry for everyone; a vanished or unreadable linked
  folder is paused, never read as deleted. Concurrent edits → conflict copies `name (device's copy).ext` (a `base`
  field on file records). Watching: a fixed ignore list + a synced `.swarmfsignore` (gitignore subset); hash once
  still 2 s. Auto-fetch stops below max(5 GB, 5 %) free. Trash never emptied on its own (`trash`, `trash empty`).
  Later, as user settings: the floor, trash auto-empty, a bandwidth cap.

- **2026-10-28 (SwarmFS review, lead)** — Branch `claude/vibrant-chaplygin-a50df1` 22/22 Node and Bare, not merged.
  Measured: a paired PC reopened with the phone offline takes ~0.4 s per held file (300 files: 124 s; rescan's two
  `space.get` per file, run before connecting); a second open of the instance folder fails on its lock, so `serve`
  blocks every other command. Decided (Tibo): the CLI is a trial tool → one long-running shell (online, serving,
  commands on stdin), no IPC; one-shot commands stay and refuse clearly while a shell runs. A password at init/join
  (as decided 2026-10-09). The background process comes sooner than "later". Local DHT stays the test network until
  a VPS. Served files stay editable, renamable and deletable by the person (checked: Node's read handles allow it on
  Windows). Before shared workspaces: `resolve` must be scoped by peer and space.

- **2026-10-28 (SwarmFS story 3)** — hypergraph `member-removed` merged (next 263/263): `member-disconnection`, rejoin
  fires `member-connection` again, H10 (`fromDevice(me)` complete at once). swarmwire S7 fixed on `main` (c1e06d0): a
  stream handed to one side late connected on neither (Protomux rejected the early open); unit/fs/swarm/net and Bare
  pass, swarmwire-cli 15/15. H11: `docs/next/api.md` swarmwire example passes `{ publicKey }`. SwarmFS story 3 (fetch)
  and `MOVE_INTO_SELF` merged into `001-personal-sync`: 19/19 Node and Bare, 100 MB in ~10 s. HyperDHT #283 comment
  posted by Tibo. Then: S6 dropped (SwarmFS stats around `hashFile`, rehashes a file changed meanwhile); `stalled`
  already worked (NOT_AVAILABLE ~1 ms after the peer leaves), but a stopped download kept emitting: fixed in swarmwire;
  swarmwire's collection/list/on-demand tests hung ~50% on a busy disk (5000-round test budget): now by time; move onto
  a file → `NOT_FOUND`.

- **2026-10-27 (upstream)** — Hypercore PR merged upstream (#891 fix + stale-queue fix). HyperDHT: 6.35.0 (released
  today) still leaves dead connections (4–7 per run of our demo); open PR #283 (Holepunch staff, branch in their repo)
  applied on 6.35.0: 0 dead out of 100 dials, their suite 107/107 — comment drafted for Tibo. Pin 6.32.0 stays until it
  ships. swarmwire 0.7.0 on `main` (verify before send, bounded cache, `hashFile`). SwarmFS spec 001 stories 1, 2, 4
  built (14/14 Node and Bare); new request H10 (own records must not wait the read bound) sent to the
  `member-removed` session.

- **2026-10-27 (SwarmFS's requests, reviewed by the lead)** — hypergraph `swarmfs-requests` merged into master (next 279/279
  on the lead's run): `space.on('member-connection')` / `memberConnections()` (members' streams for a library with its own
  wire, complements `addProtocol`), `hg.on('spaces')`, H2–H4 confirmed. swarmwire `004-on-demand-serving` merged into its
  `main` locally (0.6.0; unit 88/88, fs 20/20, Bare 190/190; contract test fixed for CRLF): `resolve(root)` on demand,
  no-announce mode by adapter (no code needed), `.part` downloads, `stalled` when every peer says unavailable. Rule
  (Tibo): a device hosts all it holds; nothing per file announced or hashed for serving. SwarmFS spec 001 updated
  against swarmwire `main`. Open, small: swarmwire verify-before-send (a changed file can send wrong bytes and get the
  sender banned), bounded hash cache, stable `hashFile()`; hypergraph event when a connected member is removed.

- **2026-10-22** — **Spec 011 merged into master** (`2a64be8`). Before: hyperDNS tests fixed for Autobase 7.28.2's close
  order (hyperDNS `8cc62f1`; Tibo's uncommitted private-authority work reviewed: v1-only, compatible, untouched);
  hyperdht pinned 6.32.0 (`overrides` + devDependency; demo 0 dead connections); Tibo's ESLint setup kept, `test:all`
  now v1 + next on Node and Bare. Results on master: v1 390/390, next 273/273 Node, hyperDNS 46/46, HyperBBS 126/126.
  Hypercore PR opened by Tibo (#891 fix + stale-queue fix). **Next: SwarmFS.**

- **2026-10-21 (Hypercore PR prepared with Tibo)** — The clear bug was already reported (hypercore #891, Oct 15,
  same cause and fix; no PR). Writing its regression test the Hypercore way found a **second, independent
  bug**: a stale block-queue entry (a `get()` that timed out) can use up a peer's only `_updatePeer` turn and
  leave a live request unsent — in stock 11.39.0, without any clear, the next `get()` fails ~half the time.
  Both fixes and two tests on branch `fix-clear-remote-contiguous` in `E:\Code\P2P\hypercore` (commit
  e33e633, local only); each fix proven necessary on its own; Hypercore's suite 434/434 on Node. PR text:
  `specs/research/upstream/hypercore-pr.md`. Tibo pushes to his fork and opens the PR. HyperDHT: pin 6.32.0
  (issue #304 already covers it).

- **2026-10-17 (last check of the upstream demos, against each library's README, examples, tests and the
  docs.pears.com pages)** — Both demos use only documented calls the documented way (Hypercore:
  `replicate`, `get(index, { timeout })`, `clear(start, end)`, whose README says peers are told; HyperDHT:
  `createServer`, `listen()`, `connect()`, `open`, one node both listening and dialing as Hyperswarm does).
  **Hypercore**: still reproduces on 11.39.0 (published 2026-10-14; the replicator unchanged since
  September); its own `test/clear.js` never clears while connected after a `want`. **HyperDHT**: dead
  connections confirmed with a 15 s wait; **0 on 6.32.0, many on 6.34.1 → a 6.33 regression**, matching issue
  #304 (opened by someone else, same symptom). Tibo will message the Holepunch devs privately first.
  Option for later: pin hyperdht 6.32.0 via npm `overrides` until a fix ships, and drop our workaround.

- **2026-10-15 (review of the dependency update and upstream analysis)** — Branch `deps-and-upstream`:
  every dependency at its latest (Hypercore 11.37.2, Corestore 7.13.0, HyperDHT 6.34.1 were already;
  brittle 4 needs `brittle-node` for Node runs; Autobase 7.28.2 throws if a base is closed after its
  storage — 4 v1 tests reordered, v1 code unchanged; Tibo kept 7.28.2). v1 390/390, core 273/273 Node and
  272/272 Bare. **Blocker before merging**: 3 hyperDNS test files close in the old order and crash on
  this branch — a session in the hyperDNS repo fixes them first. Upstream: **Hypercore** — confirmed theirs
  (after a peer clears a block, a read of a later block hangs if a `want` was already sent; 7-line patch,
  their suite 421/421 with it; nothing similar reported); our workaround stays. **The "Hyperswarm" race is
  really HyperDHT's** (local-address shortcut vs abandoned hole-punch; already issue #304, open PR #283
  fixes our case); the lead's earlier Hyperswarm reading was wrong. Standalone demos for Tibo and
  Holepunch: `specs/research/upstream/demos/` (`npm install`, `npm run hypercore`, `npm run hyperdht`),
  checked in a clean folder by the lead. Posting (a new Hypercore issue; a comment on hyperdht #304)
  waits for Tibo's OK.

- **2026-10-11 (review of the pre-merge fixes)** — Accepted and merged into `011-spaces-core` (272/272 Node,
  re-run in the lead conversation). Closed spaces give log keys only to peers proving the space key;
  phrase file 0600; crash-safe writes; `addProtocol()`, `leaveSpace()`; the key chain and `history`
  setting; dead connections closed and re-dialed (SC-005 now 47 of 50 authors, all posts within 1.5 s).
  `bench/next/double-dial.js` reproduces the Hyperswarm problem with plain Hyperswarm + Protomux across 8
  processes (no hypergraph). Tibo: **before reporting anything, update every dependency to its latest
  version**, then (if problems remain) a full analysis proving each is in the library and not our code,
  pinning the exact cause, with fix suggestions. Dependencies were already recent (Hypercore 11.37.2 and
  Corestore latest); behind: patch releases (Hyperswarm 4.17.0 → 4.17.2, whose changes don't touch
  duplicate connections; Autobase, Protomux, bare-*), and test tools brittle 3 → 4, random-access-memory 3 → 6.
  Pre-merge open questions settled by the lead: in hidden-history mode each newcomer needs an online
  decider for a new key (acceptable, documented); a needless key change when an admin reopens the app is
  harmless, fix later.

- **2026-10-11 (upstream bugs, checked in the lead conversation)** — **Hypercore**: confirmed with plain
  Hypercore (`specs/research/upstream/hypercore-clear-repro.js`) that after a peer clears block k, the other
  side records its contiguous length as k and forgets it holds k+1.. (`onrange` lowers
  `_remoteContiguousLength` without first setting those bits) — **but nothing stalls in plain Hypercore**
  (`get`, range and live downloads still fetch). So our stall (story 2) most likely comes from our own code
  (`get(seq, { wait: false })` reads, ranges restarting at the indexed position); follow-up: find it and
  remove the workaround that calls Hypercore internals (`core.replicator.onhave`). No bug report; at most a
  question with the script. **Hyperswarm**: reading `_handleServerConnection`, the duplicate-connection rule
  mixes a symmetric key tie-break with a timing-dependent "existing already sent and received bytes"
  test, so two sides can keep different connections; consistent with the measurements (joins ~1 s or
  ~15 s, only across processes). Report only if the pre-merge session's plain-Hyperswarm script reproduces
  it, with Tibo's OK.

- **2026-10-11** — Private spaces never re-encrypt data; a **key chain** (each new room key carries the
  previous one, locked with it) lets newcomers read history without re-encryption; per-space setting
  `history: 'visible' | 'hidden'` (default visible). Found in review after Tibo's question: newcomers only
  got the current key. Docs say plainly that a *closed* (non-private) space is readable by anyone holding
  its key, removed members included; only private spaces cut them off. Added to the pre-merge session.
  **Upstream reports** (Hypercore clear, Hyperswarm double dial): only after a minimal script using only
  their library reproduces the problem here, and their trackers are checked; otherwise the bug is ours.

- **2026-10-11 (review of spec 011's final pass)** — Merged into `011-spaces-core` (257/257 Node, re-run in
  the lead conversation). Success criteria met except SC-005 (partly: 34 of 50 authors joined; every post
  seen within 2 s). SC-004 met: first page 227 ms / 77 KB at 1M records (203 ms / 73 KB at 10k). Found and
  **fixed before merging to master** (one session): a closed (non-private) forum is readable by anyone who
  sees its topic — members give the log list only to peers proving they know the space key; the
  recovery-phrase file readable by other local users; a stranger can make a page "complete"; crash-unsafe
  writes of the phrase and the log list; peers dialing each other at once keep a dead connection (plain
  Hyperswarm — hypergraph drops a connection whose space channel doesn't open and reconnects; re-run the
  50-author benchmark); `addProtocol()` (SwarmFS needs it) and `leaveSpace()` were never built. The other
  audit findings (`specs/011-spaces-core/audit.md`: request floods, fake-key floods delaying newcomers,
  decisions re-read in full) go to a follow-up list after the merge. Tibo: **ponytail also for new code**
  from now on (worker sessions use `/ponytail`). Pending with Tibo: upstream reports for the two
  Holepunch bugs (Hypercore clear, Hyperswarm double dial) — drafted by the lead, posted only with his OK.

- **2026-10-11 (review of spec 011 story 9)** — Accepted and merged into `011-spaces-core` (250/250 Node,
  249/249 Bare, re-run in the lead conversation). **All nine stories are built.** Newcomer's first page:
  223 ms / 92 KB at 10k records, 238 ms / 95 KB at 100k (flat); 1M not yet run. Switch-over to activity
  lists at 300 logs (measured). Three "complete while missing the newest posts" bugs fixed. Settled by the
  lead: modified apps writing out of time order can fool members holding part of a space (documented
  limit; full holders are right); write limits rely on stamps (future stamps are flagged); a reply or
  vote is stamped after what it points to. Unproven: SC-005 (50 writers) — the benchmark harness stalls
  with many writers in one process (Hypercore catch-up), to be measured with writers in separate
  processes. Tibo: **yes to the 1M benchmark** (alone, few writers); **ponytail: only the read-only
  `/ponytail-audit` of `lib/` in the final pass**, its findings applied only where agreed in the lead
  conversation — not as a mode for new code, no wholesale rewrite.

- **2026-10-10 (review of spec 011 story 8)** — Accepted and merged into `011-spaces-core` (226/226 Node,
  225/225 Bare, re-run in the lead conversation). Tibo (in the session): a sub-space's decisions live in
  its parent's decision log; a private sub-space is read by those invited to it plus the parent's owner
  and admins. Settled by the lead: only someone who can read a private space changes its key (a
  moderator who made a new key would read everything after it — that's access, not moderation); a
  member holding a private space without its key gets a "not for me" state answered at once instead of
  waiting for the bound (story 9); `createInvite({ subspaces })` comes with story 9; sub-spaces' own
  custom roles later. forum.js is at 395/400: story 9 must not grow it past the limit.

- **2026-10-10 (review of the core follow-ups)** — Accepted and merged into `011-spaces-core` (202/202 on
  Node and on Bare, both re-run in the lead conversation on the merged branch). The link consistency
  bug is fixed (a link to a wrong-type target counts for nothing, on every member, whatever the order).
  New reads: `members()`, `decisions()` (a moderation log), `hg.types()`, `tags()`, `peers()`, events,
  `inspect({ records })`; the inspector uses them. Routed to story 8 (first): members re-exchange the
  log directory summary periodically, so a missed announcement of a log is recovered without a
  reconnect. Accepted limits: a decision by a moderator demoted before it settles can vanish from
  `decisions()`; members on an older app version count links through fields they don't know.
  The swarm now uses each device's own key (so `peers()` can prove who a peer is): peers see a device
  key on connecting. Tibo: accepted for now; **later**, a random key per connection with identity
  proven inside the space channel (better privacy) — not urgent, planned with story 9 or after.

- **2026-10-09 (review of spec 011 story 7 and the inspector)** — Both accepted and merged into
  `011-spaces-core` (story 7: 188/188 on Node and Bare; inspector: read-only, `node
  tools/inspector/demo.js` plays a three-member forum at http://127.0.0.1:4401-4403). On the merged
  branch the full suite passed 188/189: `test/next/forum/inspect.js` fails under load and passes alone
  (4/4) — timing-sensitive, like `budgets.js` on Bare. Next session ("core follow-ups", before story 8):
  (1) **a Principle I bug** found by story 7: a link's allowed target type is checked only if the
  target is held when the record arrives, so two honest members can disagree — fix deterministically
  (a link to a wrong-type target is ignored, the record kept, on every member); (2) unknown `hg/` types
  kept like unknown app types (future hypergraph versions); (3) the two flaky tests wait for
  conditions; (4) the inspector's requests: `members()`, a readable `decisions()` list, declared types,
  a record's tags, connected peers, hidden/deleted records in diagnostics, events when logs or peers
  change; (5) the storage estimate counts app index entries; (6) a field passed as `undefined` counts as
  absent (old and new app code can share helpers); (7) app rules get ids and a space records which are
  active, so `status()` warns when an app's rules differ (rules are code; mismatches can't be prevented,
  only detected).

- **2026-10-09 (review of spec 011 story 6)** — Story 6 accepted (180/180 on Node and on Bare, both
  re-run in the lead conversation; v1 390/390; hyperDNS 46/46; 100k-record index rebuild 20.6 s;
  `011-spaces-core` fast-forwarded). Departures accepted (research.md A10): dropped content keeps a
  ~0.5 KB entry per record so counts stay exact (`OVER_BUDGET` when the list alone exceeds a share);
  rebuild from a file listing accepted logs; self-compaction after dropping a tenth of the budget.
  Routed to story 9 (T071b): a newcomer downloads a space bigger than its share once in full.
  Watch: forum.js is at 371 of 400 lines — story 7 separates test plumbing from app code.

- **2026-10-09** — **An inspector**: a read-only web page (local Node server + browser) showing what is
  inside a hypergraph (spaces, members, roles, decisions, logs and devices, records by type, storage,
  peers). For Tibo to see the core work during development, for app developers to debug, and later
  HyperBrowser's developer-tools panel. Guardrails against rot: read-only first; public API plus one
  documented diagnostics method (`space.inspect()`, built in story 6); a smoke test in the suite; its
  own folder, built by its own session alongside story 7. (Tibo's idea, agreed by the lead.)

- **2026-10-09 (review of spec 011 story 5)** — Story 5 accepted (153/153 on Node and Bare, re-run in the
  lead conversation; `011-spaces-core` fast-forwarded). Accepted by the lead (research.md A9): a link or
  tag counts only if its author may edit the source record (so nobody labels others' posts; community
  labels would be a separate feature); the owner holds every permission, app ones included; a custom
  role can't lose an app permission (like `post`); an edit made by a modified app before its author got
  the permission starts counting once given (everyone still agrees). Next story: `space.roles()`, and a
  device just made admin/moderator waits (bounded) until it may record decisions instead of failing
  (the device tests still retry).

- **2026-10-09** — Shared records (wiki pages, shared folders): **only the author and moderators can
  delete**; other allowed editors can only edit (a blanked page is restored by the next edit). (Tibo)

- **2026-10-09 (review of spec 011 story 4)** — Story 4 accepted (128/128 on Node and Bare, re-run in the
  lead conversation; `011-spaces-core` fast-forwarded). Security: a device counts only if the identity
  key itself vouched for it (a stolen device could mint devices no removal named); decision rights
  follow devices; one settler device per decider (Tibo); unban = the member writes in a new log (Tibo);
  write limits for open spaces moved to story 9 (Tibo). Settled by the lead: joining waits 30 s by
  default (connecting alone can take 5 s on a real network) while reads keep 5 s; a decision method
  first catches up with connected decision writers (bounded) before refusing, and NOT_ALLOWED says why
  (story 5: the forum test had to retry setRole after an unban); the "new log prepared during a ban"
  gap (modified apps only) goes with story 9's spam work; a space whose only settler is lost for good
  can't settle again — docs say "give a space an admin", `status()` warns about a single settler, and
  Autobase `fork()` is studied with spec 009 (resilience).

- **2026-10-09 (review of spec 011 story 3)** — Story 3 accepted (99/99 on Node and Bare, re-run in the
  lead conversation; `011-spaces-core` fast-forwarded). **SwarmFS can start on the core.** Decided by
  Tibo: **removing a device needs the recovery phrase** (signed by the identity key, never by another
  device alone); each device keeps the phrase encrypted with a password by default (Argon2id via
  sodium), forgetting it is opt-in; a device added by code receives the phrase over the pairing
  connection. Routed to story 4 (first): a removed device that could record decisions must lose that
  right (a stolen owner laptop could still ban people), and a member's other devices can record
  decisions; `Hypergraph.open(dir, { password })` / `{ joinCode, password }` so the phrase is protected
  from the first moment; `query().fromDevice(key)` for apps like SwarmFS. Routed to story 6: superseded
  personal-space records (device heads, settings) are cleared locally so they don't pile up.

- **2026-10-09 (review of spec 011 story 2)** — Story 2 and the review fixes accepted (87/87 on Node and
  Bare, re-run in the lead conversation; `011-spaces-core` fast-forwarded). Decided: a ban can start
  from a chosen record ("drop everything from this post on"; built with story 3); **unban** comes with
  story 4 (writes during the ban stay ignored); in story 4 **admins share the settling of the decision
  order with the owner** (Autobase indexers), so a space outlives its owner (v1 spec 003's lesson).
  Settled by the lead: rule-rejected records stay only on their author's device; a custom role can't
  lose `post`. A Hypercore bug was found (a cleared block makes peers forget later held blocks) and
  worked around with a test; an upstream report is drafted only with Tibo's OK.

- **2026-10-08 (review of spec 011 story 1)** — Story 1 accepted (59/59 on Node and Bare, re-run in the
  lead conversation). Found in review, fixed in the story 2 session: removing a member made members
  disagree (fix: a removal is a cut, like a ban — also the pattern for losing an edit permission in
  story 5); deletes must stay wiped after a reconnect (test first). Decided: the person chooses whether
  the recovery phrase is erased after being written down or kept encrypted with a password; "complete"
  means "everything this member knows of is held, and it reached another member since starting".
  Story 5 must decide who may delete shared records (a delete that always wins lets one vandal erase a
  wiki page).

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
- **hypergraph and SwarmFS stay in step**: a SwarmFS request (`SwarmFS/specs/requests-to-*.md`) that shows a flaw
  in the core is fixed in hypergraph as a rule, not patched case by case; after any change to the new core, the
  lead runs SwarmFS's `npm run test:all` too, and marks the request done there.

## Now

(2026-10-29; spec 011 merged into master 2026-10-22, history in Decisions.)

1. ~~H17~~ merged (053324d: the indexer stopped at a full batch of locked records; any private space with 256+
   records ahead of a newcomer's key). ~~swarmwire S9~~ merged (c1f6484). SwarmFS 63/63 Node and Bare on both.
2. ~~Spec 012 "honest reads"~~ merged (2bf51dc): reads at once (`timeout` 0 by default, `readTimeout` removed),
   `change` carries `records: [{ id, type, deleted }]` (edits too: H16's cause was `#settle()` returning true only
   for deletes), events for every read, `get().deleted`. Lead's run: v1 390/390, next 304/304 Node, 303/303 Bare;
   SwarmFS unchanged 63/63 Node, 62/63 Bare (its own `ino` bug, below).
3. ~~SwarmFS adopts 012~~ merged into its `001-personal-sync` (a2db790; 66/66 Node and Bare, lead's run): shortcuts
   gone, re-reads only changed entries, an edit newer than a delete re-added; exact file ids (Node bigint stat; Bare
   has none, so renames there are confirmed by hashing). Filed H18 (a record doesn't say when it was edited).
   ~~R13~~ merged (a9e271b): not a bug, a test's clock-ahead stamps; guard test added. Open question it raised: a
   fast writer's stamps run ahead of the clock, so others' posts sort below theirs (a spam lever in open forums).
4. ~~Spec 013 "helpers"~~ merged (bab86c3): `space.setHelpers(keys)` (owner, top space), `space.helpers`, members hand
   the space to blind peers in the background, never awaited; deciders list logs (`logs/list`) so members find
   authors they never met. Lead's run: next 311 Node / 310 Bare (file by file), SwarmFS 66/66 Node and Bare.
   Not in 013 (forum F4c): whether this device reaches each helper now. One client per space, sub-spaces included
   (fine for a forum; one per account later).
5. Now: forum spec 001 (`hypergraph-forum-example` 8186053) reviewed, waits on Tibo's 4 questions, then builds.
   Next core fix: `test/next/forum/live.js` fails on master run alone (a live post list re-runs 7 extra times on
   comments/votes: `_live` re-runs on `_progress` while incomplete and on any indexing mid-run, and calls back with
   an unchanged result); the full run hid it, and `scripts/test-runner.js` printed 299/299 for 311 tests.
   Small core fix after: sub-spaces inherit their parent's storage policy (forum F5; rules already do).
6. Later: hyperDNS onto the new core or frozen, then v1 removed.

## Follow-ups (not built yet)

- From the audit (`specs/011-spaces-core/audit.md`): request floods, fake-key floods delaying newcomers, decisions
  re-read in full.
- SwarmFS's later requests (`SwarmFS/specs/requests-to-hypergraph.md`), for its later stories:
  - **H5** read-only members: does a member whose role lacks `post` keep receiving a private space's key? If not, a
    `read` role.
  - **H6** concurrent versions of a record (conflict copies): SwarmFS can do it alone with a `base` field; decide
    whether hypergraph exposes "versions that lost to a concurrent edit".
  - **H7** a public test helper for apps (local DHT + tmp dirs, `hypergraph/testing`-style).
