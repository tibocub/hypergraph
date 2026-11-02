# Scale audit: what each piece's cost grows with

Research note, 2026-11-01. Question (Tibo, 2026-11-01): at big target sizes, what does each piece of
hypergraph, SwarmFS and swarmwire cost, where does it break first, and which design choices would be hard
to change later? Good design, not tuned code. Every finding must serve real apps (forum, chat, SwarmFS,
HyperBrowser sites), not a benchmark.

**Target sizes** ("ever" = every account that ever posted; "online" = connected at once):

| app | size |
|---|---|
| forum | 1,000,000 accounts ever, 10,000,000 posts, 1,000 online |
| chat | 100,000 members ever, unlimited history, 1,000 online |
| SwarmFS | 10,000,000 files in a space, 1,000 people, 100 online, 20 devices per person |
| HyperBrowser | 500 open sites, on a phone, one engine |
| swarmwire | one 100 GB file, 1,000 peers |

**Method**: reading code (hypergraph `1531fb4` `lib/`, SwarmFS `fd1391a`, swarmwire `2d6bfa4`) and existing
measurements; small growth runs (1k / 10k / 100k), one at a time, extrapolated with the curve shown.
Benches: `bench/scale-audit/` (each file says how to run it). Machine: Windows 10, 8 cores, 16 GB, Node
26.4, no network (local only). **M** = measured here; **M-old** = measured before (file named); **E** =
estimated (from what is said).

## Top design risks, ranked

Ranked by **cost to change later × how likely it bites at the target sizes**. "Hard" means everyone must
update together (rules every peer applies, wire, record or key formats); "easy" means one peer's code.

| # | risk | breaks at | cost to change later | smallest design change that removes it | which spec |
|---|---|---|---|---|---|
| 1 | **Every account is decision-log state, and every decision re-reads all of it.** *(First step done 2026-11-02: applied in place, ~0.3 KB of memory per member; see "Risk #1, first step".)* Each join writes `member:` + `redeemed:` + a decision-list line; every member rebuilds the whole state on each decision (`lib/decisions/log.js` `reload`/`_read`, `lib/decisions/state.js` `State.from`). | **~10k–30k members** (M: one decision costs every member 28 ms at 1k members, 259 ms at 10k, **25 s at 100k**; ~1 KB of memory per member) | **hard** (apply-time rules and the view's layout: everyone together; spaces already made keep their logs) | Two steps. **Now (easy)**: apply each decision to the state in place, rebuild only when Autobase reorders; read the view on demand instead of holding it all in memory. **Design (hard, do before the forum spreads)**: a plain member is not a decision. A newcomer's log header carries its redemption of an open invite (signed, checked by readers like a device proof); the decision log keeps only exceptions: roles above member, bans and cuts, revocations, and invites with a use count (the only ones that need an order). | a new spec "open spaces at scale" (ROADMAP's "invite-less public spaces later"), before or with the one-engine spec |
| 2 | **Every full member keeps every log open, forever, and swaps whole log lists.** Each accepted log is an open Hypercore with a live download (`lib/directory.js` `accept`, `lib/replication.js` `hold`); all are reopened at start (`lib/space.js` `_open`); a directory difference is settled by sending every key (`#onSummary` → `#onWant`). Every member gets a log on joining even if it never posts (`#onDecisions`). The owner, moderators, helpers and anyone who joined while the space was small are full members. | **~100k logs on a desktop, ~20k on a phone** (M: 18 KB of memory and 0.55 ms to open per log, linear 1k–20k → 1M logs = ~18 GB and ~9 min to start; E: 32 MB per list swap at 1M logs) | **medium**: closing idle logs is easy; the list swap is wire (add messages, keep old ones) | Open a log only while it downloads or is read; keep the rest as index rows. Replace "send the whole list" with a paged exchange (by key range, or "logs since my n-th") so a new log costs one key, not the list. Make no log for a member until its first record. | one-engine spec (memory budget per engine); directory sync item from the 011 audit |
| 3 | **A private space's key change grants every device one by one, and everyone stores every grant.** One `hg/grant` record per entitled device, appended serially (`lib/space.js` `#rotate`/`#grant`); every member holds and indexes all of them; `#grantState` re-reads every grant of every epoch on each key check. A key changes at every removal or ban, and at every join with `history: 'hidden'`. | **chat at ~10k–100k members** (M: 129 µs to seal one, ~165 B of fields; E: 100k members × 2 devices = 200k grants per change ≈ 26 s of sealing for the changer, ~60 MB to download and ~35 s of indexing for every member) | **hard** (grant records and key commitments are format and apply-time) | Grant per member, not per device (a member's devices derive one box key from the identity), and only to members active lately; a member back after a change asks any key holder for the key (one message, checked against the decision log's commitment). Rotation then costs active members, not members ever. Later, if needed: a key tree (MLS-style) for very big private spaces. | private-spaces revision (with the chat app's spec) |
| 4 | **Logs listed in the decision log** (spec 013 `logs/list`, `lib/decisions/apply.js`): one `listed:` entry per log, forever, re-read with everything else (#1) and walked on each decision (`#considerListed`). | spaces with helpers, at the same sizes as #1 | **hard** (apply-time: the view must be the same on every member) | Let helpers serve the log list (they hold every log anyway), or carry it in the activity lists; stop writing `listed:` | one-engine spec or a 013 follow-up |
| 5 | **swarmwire keeps ~205 B of memory per 16 KB group and re-hashes big files on every reopen.** `GroupTree` and `NodeStore` hold one Buffer per group (`lib/tree.js`, `lib/nodes.js`); the hash cache is 32 MB in memory (`lib/source.js` `remember`), so a file over 16 GB is never cached, and served files close after 5 s idle (`lib/on-demand.js`). | **a 100 GB file** (M: 205 B per group → 1.3 GB of memory per open 100 GB file; hashing 126 MB/s → **14 min** before each reopened 100 GB file can be served) | **easy** (format.md: outboard caching and group size are free to change) | Store the outboard (group hashes) next to the file or in the sidecar; keep hashes in one flat buffer (32 B per group); bigger groups for big files (negotiated per transfer already). | swarmwire spec (before the video work) |
| 6 | **SwarmFS holds a whole space's tree in memory and walks it on every change** (`lib/sync.js` `Link.read`/`remote`/`held`, `lib/members.js` `syncHas`): every entry in a Map, every pass loads every `held` record, `has` is one record per device per file. | **~1M files** (E: ~1 KB of disk per record (M-old, design brief) → 10M files = ~10 GB of metadata on every full member, plus the same again for `held`; each pass O(files)) | **medium** (`held`/`has` are records: format, but SwarmFS isn't released) | Read the tree folder by folder (the `parent` index exists); keep `held` in the local index, not as records; replace per-file `has` by a summary per device (ranges or a filter). | SwarmFS scale spec |
| 7 | **One engine = one folder, one identity, one swarm, one set of types; every space opened at start.** (`lib/index.js` `_open` opens and joins every space in turn; a type change anywhere rebuilds the whole index, `#reindex`). | **500 sites on a phone** (M: 30–50 ms and 0.25–0.3 MB per space for hypergraph alone; M-old, site-storage: ~3 MB per site with SwarmFS and peers → **500 sites ≈ 1.5 GB**, 15–25 s to start, 500 DHT topics) | **hard** once apps rely on "one instance = one app" (API) | Spaces open lazily (closed until visited, a capped set seeded); a space's types live in the space and are indexed per space; join a space's topic only while it is open or seeded. | the "one engine for many sites" spec (already planned) |
| 8 | **Moderation of records is decision-log state** (`mod:` per hidden/removed record, `lib/decisions/apply.js` `moderate`), walked whole on each decision (`lib/index/indexer.js` `moderate`). | same curve as #1, from ~10k moderated records (E: 1% of 10M posts = 100k) | **hard** (apply-time) | Falls under #1's first step (state applied in place, read on demand); keep moderation per target, looked up when a record is read. | with #1 |
| 9 | **Activity periods are fixed at one hour** (`lib/activity.js` `PERIOD_MS`), and the entries a member reads are all kept in memory (`lib/space.js` `_act`, `#loadEntries`). | not at the targets for the list size (E: 1,000 online ≈ ≤1,000 active authors an hour ≈ 40 KB per period); **chat scrollback** for memory (E: a year read back ≈ 8,760 periods × a few hundred entries ≈ millions of entries, hundreds of MB) | period length: **hard** (entries carry period numbers every peer reads alike); memory: easy | Keep `_act` on disk (it is in the index already) and in memory only for the periods shown; if a space ever has many thousand authors an hour, a period length per space recorded in its settings. | chat spec |
| 10 | **`count`/`sum` read every reaction** (`lib/space.js` `count` → `#pointingAt` → `linkedRows`). | a post with ~100k votes (M: 16 µs per reaction for `count`, 25 µs for `sum` → 1.6 s / 2.5 s per read) | **easy** (local index only) | Counters kept in the index, updated as records are indexed. | forum F8 (sort by counts) |

**Why #1 and #2 come first**: they are what every member pays for every *silent* account. The other
risks cost what active people do.

### What a silent member costs everyone (question 2, short)

A member who joined once and never came back costs every other member, forever:

- **in the decision log**: a `member:` entry, a `redeemed:` entry, a line in the decision list, and a
  share of `uses:` (`lib/decisions/apply.js` `invite/redeem`). Held in memory by every member (~1 KB,
  M) and re-read at every decision (#1). In a space with helpers, a `listed:` entry per log too (#4).
- **a log**: made and announced on joining even with nothing in it (`lib/space.js` `#onDecisions`):
  32 B in every list swap, 18 KB of memory and 0.55 ms at start on every full member (#2), ~1.5 KB for
  a newcomer who opens it (M-old, research.md A14).
- **in a private space**: one grant per device at every key change, held by every member (#3).
- **nothing** in activity lists or the time-ordered reads: a newcomer to a big space never opens it.

## Risk #1, first step: decisions applied in place (2026-11-02)

Done (no format, wire or apply-time change; the view's entries are byte-identical):

- **The state is kept, not rebuilt** (`lib/decisions/log.js` `_read`, `readChanges`): each change of
  the view is read with Hyperbee's diff between the version read last and the new one, and applied to
  the state in place (`State#apply`). The whole view is read again only on open and when Autobase
  truncated it below what was read (a reorder: concurrent deciders, a decider back from offline). Test:
  `test/next/unit/decisions-in-place.js` (three deciders on real Autobases, partitions, one away for
  several rounds; in place = rebuilt after every step, and a reorder happened).
- **What hangs off a decision looks only where it changed** (`touched()` in `lib/decisions/state.js`):
  `directory.recheck` rechecks the logs of the identities whose `member:`, `banned:`, `cut:`, `admit:`,
  `editcut:` changed (an index by identity, `Directory#byIdentity`); `#considerListed` the new
  `listed:` logs; `indexer.moderate` the changed `mod:` records; `indexer.reauthorize` the rights of
  the touched identities. **Still everything**: after a full read, and for `meta` (settings), `role:`
  (role definitions) and `subspace:` decisions, which can change who may write for everyone.
- **Sub-space states copy nothing** (`SubState`): one identity's role, ban, cuts are worked out from the
  parent's and its own when asked; whole maps only when read (`space.members()`).
- **Not in memory any more**: `redeemed:` and `uses:` (read from the view by `redemptions()` and a
  newcomer's refusal check); a member's writer keys (only apply reads them); repeated strings (makers,
  roles, the space of listed logs) are held once.

Still O(N) per decision (not decision state): `space.status()` sums every held log (`_usage`, O(logs),
risk #2); a private space's key check walks its grants (`#keyWork`, risk #3).

### Perf, before → after (`npm run perf`, medians, ms)

| scenario | size | Node before | Node after | Bare before | Bare after |
|---|---|---|---|---|---|
| `decisions.reload` (one decision, every member) | 1,000 | 21.7 | **0.66** | 20.7 | **0.68** |
| | 4,000 | 63.2 | **0.67** | 55.6 | **0.74** |
| | 10,000 | 133.8 | **0.72** | 138.1 | **0.74** |
| `decisions.rebuild` (open, reorder) | 1k / 4k / 10k | (was reload) | 17.5 / 55.6 / 142 | | 19.5 / 71.3 / 161 |
| `members.decision` (until the `members` event) | 100 | 6.16 | 5.77 | 6.59 | 4.12 |
| | 400 | 7.57 | 4.04 | 7.39 | 3.77 |
| `members.join-kb` (KB, format: unchanged) | 100 / 400 | 105 / 345 | 104 / 341 | 105 / 343 | 106 / 344 |

Before: `c923f12` for `decisions.reload` (it then measured the full rebuild), `9191688` for `members.*`
(the scenario now waits for the `members` event instead of polling `members()`, a list of all N). After:
`dfcf4d5`. `decisions.reload` and `members.decision` are flat; `members.join-kb` is not and can't be
without a format change (below).

### Where a member's bytes go

`bench/scale-audit/member-bytes.js` (N = 10,000; one invite per newcomer, as `space.createInvite()` per
person; real signed redemptions on a real Autobase). *kv*: key + JSON value; *block*: the whole Hyperbee
block with its tree index (grows slowly with N: +10–20% from 2k to 10k).

| what a join writes | kv | on disk (block) | in memory before | in memory now |
|---|---|---|---|---|
| `member:` `{ role, by, stamp, writer, writerDevice }` | 340 B | 557 B | 418 B | 163 B |
| `redeemed:<invite>:<identity>` `{ at, by }` | 198 B | 409 B | 301 B | 0 (read on demand) |
| `uses:<invite>` `{ count }` (an invite per person) | 48 B | 260 B | 97 B | 0 (read on demand) |
| `~log:` the decision list line | 512 B | 747 B | — | — |
| `~count` (rewritten at every decision) | 10 B | 153 B | — | — |
| `listed:<log>` (spaces with helpers, per log) | 147 B | 363 B | 206 B | 130 B |
| the `invite/redeem` decision in the recorder's writer log | | 843 B | — | — |
| **total** | | **~2.1 KB** view (2.5 KB with helpers) + 0.84 KB log | **1,054 B** | **319 B** (163 B without helpers) |

A newcomer downloads ~0.8 KB per member (`members.join-kb`: 105 KB at 100 members, 343 KB at 400):
the writer logs' decisions, which it applies itself. Unchanged by this step (it is format).

### Savings that need a format or apply-time change (not done; for the decision with Tibo)

Per member, at 1M members ("view" changes are apply-time: every peer derives the same view and Autobase
signs it, so all update together, but no record or wire format changes and existing spaces can re-derive
their view from their logs; "format" changes records or the wire too).

| change | saves per member | at 1M members | cost |
|---|---|---|---|
| **A plain member is not a decision**: the redemption travels in the newcomer's log header, checked by readers like a device proof; the decision log keeps roles above member, bans, cuts, revocations, counted invites (the audit's design) | ~2.1 KB disk (`member:`, `redeemed:`, `uses:`, `~log:`, `~count`) + 0.84 KB log; 163 B memory; **the newcomer's 0.8 KB download** | ~2.1 GB + 0.84 GB on every member's disk; **~0.8 GB less for every newcomer**; 163 MB memory | **format + apply-time**, hardest: log headers, readers' checks, invites with use counts still need the log; existing spaces keep their logs |
| Drop `redeemed:` once counted (the "same person once" check moves into the `member:` entry: + ~40 B) | ~370 B disk | ~370 MB | view (apply-time); `redemptions()` would need another source (the decision list) |
| No `uses:` for one-use invites (`redeemed:` already says it's used) | ~260 B disk | ~260 MB | view (apply-time) |
| Binary values instead of JSON with hex (`member:` ~200 → ~80 B, `~log:` ~512 → ~150 B) | ~120 B + ~360 B disk | ~480 MB | view (apply-time); the decision list is read by `decisions()` |
| 32-byte binary keys instead of `prefix:` + 64 hex | ~140 B disk, ~60 B memory | ~140 MB, ~60 MB | view (apply-time); every `view.get` in apply |
| No `~count` entry (sequence from the view's own length or a key that sorts) | ~150 B disk per decision | ~150 MB | view (apply-time) |
| Fewer, bigger entries per join (one entry instead of 4–5): the tree index costs ~150–250 B per entry whatever its size | ~600 B disk | ~600 MB | view (apply-time) |
| Helpers serve the log list instead of `listed:` (the audit's #4) | 363 B disk, 130 B memory per log | ~360 MB, ~130 MB | apply-time + wire |

Not additive (they overlap). Ranked: the first removes nearly everything a silent member costs, including the newcomer's download (the
only part that grows with members for a newcomer); the view-only ones together reach ~1.5 KB per member
but leave the decision in the log and the download.

## hypergraph

### Growth table

N = members ever, L = logs (≈ devices of members ever, about 1–2 × N), R = records, D = decisions,
M = moderated records, S = open spaces, P = active authors per period.

| piece | each peer holds | applies / runs | keeps in memory | sends | where (file, function) |
|---|---|---|---|---|---|
| decision log | the whole view: ~3 entries per member, 1 per decision, 1 per moderated record, 1 per listed log; 87 MB for 100k members (M, ~290 B an entry) | **every decision: re-reads the whole view** (M: 28 ms / 259 ms / 25.4 s at 1k / 10k / 100k members, growing faster than N) and then walks every log (`directory.recheck`), every listed log, every moderated record | the whole state: ~1 KB per member (M: 20 MB at 10k, 98 MB at 100k) | a newcomer downloads the view: ~0.9 KB per member (M) | `lib/decisions/log.js` `reload`, `_read`; `lib/decisions/state.js` `State.from`; `lib/space.js` `#onDecisions` |
| author logs | every log of what it reads; full members: all L | indexing ~5,600 records/s (M-old, design brief) | **an open Hypercore per log: 18 KB, 0.55 ms to open (M, 1k–20k, linear)** | its own records; serves what it holds | `lib/directory.js` `accept`; `lib/replication.js` `hold`; `lib/space.js` `_open` |
| log directory | the key of every log (32 B) | summary every 10 s: O(L) per peer per 10 s | `logs` Map | **on any difference, every key: 32 B × L** (E: 32 MB at 1M logs, at each new log, per full peer); v2 measured Corestore offering every open core to each new connection, ~87 B each (M-old, v2 lessons): 87 MB per connection at 1M open logs | `lib/directory.js` `#onSummary`, `#onWant`, `#summary` |
| time periods / activity lists | entries of the periods it read: 42 B each (M-old) | checks each entry with two block reads | entries from its horizon on (`_act`) | a period's list: 40 KB per 1,000 active authors (M-old) | `lib/activity.js`; `lib/space.js` `#loadEntries`, `#widen` |
| index | ~1,010 B per record held (log + index, M-old) → 10M posts ≈ 10 GB for a full holder | — | — | — | `lib/index/indexer.js` |
| private keys | every grant: one per device per key change (~165 B of fields, M; ~300 B with the record and Hypercore's own, E) | changer: seal 129 µs per device (M) + one append each; everyone: index them; `#grantState` reads all grants of all epochs at each key check | the keys | grants: devices × key changes | `lib/space.js` `#rotate`, `#grant`, `#grantState`; `lib/private/grants.js` |
| roles | one entry per custom role, one per member's role | `reauthorize` (types editable by a permission): walks every member and every change record when rights change | — | — | `lib/index/indexer.js` `reauthorize` |
| bans | `banned:` + `cut:` per banned person, forever | `drop: 'all'`: removes their records on every member (one-off; at indexing speed, E: ~20 s per 100k records) | — | — | `lib/decisions/apply.js` `dropAll`; `lib/directory.js` `recheck` |
| invites | `uses:` per invite, `revoked:` per revoked invite | a decider online writes each redemption | — | — | `lib/invites.js`; `lib/decisions/apply.js` `invite/redeem` |
| `count` / `sum` | — | reads every reaction to the target: 16 / 25 µs each (M) | — | — | `lib/space.js` `count`, `sum`; `lib/index/query.js` `linkedRows` |
| live queries | — | the whole read again on every change of its type anywhere in the space (`_live`); ~1 ms for a latest-20 list (M-old) | one per view | — | `lib/space.js` `_live` |
| helpers | blind peers hold every log | members hand them the space | — | — | `lib/space.js` `#listLogs`; spec 013 |
| one instance per folder | every space, every log | every space opened in turn at start: 30–50 ms each (M) | 0.25–0.3 MB per space (M, hypergraph alone), ~3 MB with SwarmFS and peers (M-old) | one topic per space | `lib/index.js` `_open`, `#reindex` |

### Where it breaks first (question 3)

1. **A big open forum: every join** (#1). At 100k members one join costs every member ~25 s of CPU
   (M); the n-th join costs about n times the first, so the total grows with the square of members.
   It breaks long before 1M accounts, at roughly 10k–30k (E: where a join costs a second or more).
2. **The owner's or a moderator's device in a forum with ~100k logs** (#2): ~1.8 GB of memory and ~1
   minute to start for the open logs alone (M, extrapolated linearly); a phone at ~20k.
3. **A chat with private rooms and 100k members, on a removal** (#3): every member downloads and
   indexes ~200k grants (E).
4. **A newcomer to a forum of 1M accounts**: downloads the decision view (~1 GB, E: 0.9 KB per member),
   then re-reads it (#1). Reading posts is fine: the first page of a big space is 205–227 ms, ~75 KB,
   from 10k to 1M records (M-old, design brief), because activity lists keep it to the authors of the
   newest period.
5. **A ban with `drop: 'all'`**: fine at targets (a one-off removal of what that person wrote).
6. **A full scan**: `count`/`sum` on a hot post (#10); SwarmFS's passes (below).

### Hard to change later (question 4)

- **Hard**: the decision log's apply rules and view layout (members, redemptions, `listed:`, `mod:`,
  grants' meaning, cuts: everyone updates together; spec 014 already did this once); the log header
  (identity proof, admission code; #1's fix adds the redemption there); record encoding (`lib/encodings.js`,
  `VERSION = 1`); activity entries and the one-hour period; the space channel's messages (positions in
  Protomux: new ones can be appended, old ones must stay); invite codes (`hg:` prefix, no version byte:
  a new format needs a new prefix); key derivations (personal space from the phrase, writer proofs).
- **Easy**: how the state is rebuilt (#1 step one), how many cores stay open (#2), `count`/`sum`
  counters, live query re-runs, the summary timer, startup order.

## SwarmFS

### Growth table

F = files in a space, H = files held by this device, Pp = people, Dv = devices (Pp × 20).

| piece | each peer holds | applies / runs | keeps in memory | sends | where |
|---|---|---|---|---|---|
| file and folder records | every entry: ~1 KB each on disk (E, from hypergraph's ~1,010 B per record) → 10M files ≈ 10 GB | read whole at start (pages of 100: 100k reads at 10M) | **every entry, in a Map, for the life of the link** | the records | `lib/sync.js` `read` |
| folders | `parent` index | **every pass walks the whole tree** and rebuilds paths | children Map of everything | — | `lib/sync.js` `read` (walk), `remote` |
| `held` records | one per held file in the personal space (~1 KB each, E) | **every pass loads all of this device's `held`** | all of them during a pass | to this person's other devices (20) | `lib/sync.js` `held`; `lib/holdings.js` `all`, `mine`, `localPath`, `rescanSingles` |
| `has` records | one per (device, file) when "show holdings" is on: up to Dv × F records in the shared space, held by every member | `syncHas` loads all `held` and all own `has` after each pass | — | to every member | `lib/members.js` `syncHas` |
| sync | — | a pass per change batch: O(F) (above) | — | — | `lib/sync.js` `pass` |
| trash | entries in the bin stay records; local trash on disk until emptied | — | — | — | `lib/trash.js`; `types.js` `binned` |
| names | one `profile` per person | `namesOf` reads all profiles at each read | Pp names | — | `lib/members.js` `namesOf` |
| members | 1,000 people × 20 devices = 20k logs (hypergraph's #1 and #2 at their small end: fine) | — | — | — | hypergraph |
| bytes | the files | swarmwire: ~30 ms fixed per file (M-old, site storage) → first sync of 10M small files ≈ 10 h with 8 in parallel (E) | — | — | `lib/transfer.js` |

**Breaks first**: memory and pass time at ~1M files (E: the entries Map at roughly 1 KB of JS memory
per record is ~1 GB, and each pass walks it and loads every `held`). Disk next: 10M files is ~20 GB of
metadata per full member (entries + `held`). With "show holdings" on, `has` is the worst: one record per
device per file, held by everyone.

**Hard to change later**: the record types (`lib/types.js` says "permanent: later versions only append
fields"): `held` as records, `has` per file, `file.content` as a swarmwire link. SwarmFS isn't released, so
now is cheap.

## swarmwire

### Growth table

Numbers for one 100 GB file: G = 6.55M groups of 16 KB; P = peers interested in it (up to 64 open).

| piece | each peer holds | runs | keeps in memory | sends | where |
|---|---|---|---|---|---|
| verification (outboard) | nothing on disk for a served file | **hashes the whole file when opened unless its hashes are in the 32 MB memory cache**: 126 MB/s (M) → 14 min for 100 GB; files over 16 GB never fit | **205 B per group (M): 1.3 GB per open 100 GB file**, served (`GroupTree`) or downloading (`NodeStore`) | each 16 KB group with its proof: 23 × 32 B ≈ 740 B (E: ~4.5%) | `lib/source.js` `ContentSource.open`, `remember`, `buildTree`; `lib/tree.js`; `lib/nodes.js` |
| have-maps | a bitfield per peer per file: G / 8 = 0.8 MB (E) | `Availability.add` walks every bit per peer | 13 MB of counts (Uint16 per group) + 0.8 MB per peer | `have` 0.8 MB to each peer that asks; **`holds` (~40 B) per group gained to every interested peer**: E: 6.55M × 40 B = 262 MB per peer, up to ~16 GB per 100 GB downloaded with 64 peers | `lib/holdings.js`; `lib/swarmwire.js` `_announceHolds`; `lib/wire.js` |
| piece selection | — | scans from a random group for 256 candidates: near the end of a download, up to G checks per request (E) | — | — | `lib/select.js` `candidates` |
| sessions per file | — | SwarmFS: no DHT topic per file (good); on-demand serving keeps ≤64 files open, closes after 5 s idle | — | — | `lib/on-demand.js` |

**Breaks first**: the 100 GB file's memory (1.3 GB per copy, M) and the 14-minute re-hash on every
reopen (M), before any network limit. With 1,000 peers, the `holds` messages are the next cost (E).

**Hard to change later**: the root (plain BLAKE3), link format, collection manifest (format.md). **Easy**:
group size, outboard storage, wire messages (unknown ones are ignored), selection.

## Perf scenarios for the `npm run perf` suites

Each one watches a risk above; sizes small enough to run in a minute, at two or three sizes so the curve
shows.

hypergraph:
1. **Decision cost vs members** (#1, #8): time for one decision (a join) to reach a member's state, at
   1k / 5k / 20k members (`bench/scale-audit/decisions-reload.js` measures the core of it). Watch the
   curve, not the number: it must stay flat.
2. **The n-th join**: time and bytes for a newcomer to join at 1k / 10k members.
3. **Held logs**: memory and start time of a member holding 1k / 10k logs (`bench/scale-audit/open-logs.js`
   is the floor).
4. **Directory sync**: bytes sent between two full members when one log is added among 1k / 10k.
5. **Key change**: time for the changer, bytes and indexing time for each member, at 100 / 1,000 devices.
6. **`count`/`sum`** on a post with 1k / 10k reactions (`bench/scale-audit/count.js`).
7. **Engine with many spaces**: start time and memory at 20 / 100 / 500 spaces (`bench/scale-audit/many-spaces.js`).
8. **Chat scrollback**: memory after reading back 24 / 240 periods.
9. **Ban `drop: 'all'`** of an author with 10k records: time until gone on a member.

SwarmFS:
10. **Pass time and memory** with 1k / 10k / 100k files in a linked folder: one file edited, time until
    the space and the other device agree.
11. **`held` and `has` growth**: records and disk per file, with "show holdings" on.

swarmwire:
12. **Memory per open big file** (1 / 4 / 16 GB) and **time to serve a reopened file** larger than the
    hash cache (`bench/scale-audit/swarmwire-tree.mjs` measures the tree part).
13. **Control bytes per MB downloaded** (`have` + `holds` + proofs) with 4 / 16 / 64 peers.

## What's unchecked

- **No network numbers**: everything ran on one machine without peers. The directory list swap (#2),
  Corestore offering open cores to each connection, `holds` traffic and newcomer downloads are estimated
  from code and older measurements.
- **The 100k-member decision bench is a stand-in**: a Hyperbee with `member:`, `redeemed:` and `listed:`
  entries read the way `_read` reads it, not a real Autobase with 100k redemptions (that would take
  hours). Autobase's own cost of applying 1M decisions, and of a newcomer fast-forwarding to the view, is
  not measured.
- **Why the reload grows faster than N** (×9 from 1k to 10k, ×98 from 10k to 100k) was not profiled
  (Hyperbee's cache, garbage collection, or memory pressure are likely). One run each at 100k.
- **Open-log memory** was measured without peers; a peer adds replication state per core.
- **SwarmFS** numbers are estimates from its code and hypergraph's per-record cost; no SwarmFS bench was
  run (another session is building them).
- **Bare and phones**: nothing measured on Bare or a phone; "breaks on a phone" assumes ~10× less memory
  than this desktop.
- Not read in depth: `lib/space.js` reads and budgets (`#refill`, `#hold`), `lib/index/indexer.js` beyond
  the paths named, hypergraph v1 (`src/`), swarmwire's request window and timeouts, SwarmFS's watcher.
- Forum F8/F9 (sort by counts, text search) and helpers that keep aggregates (design brief, experiment
  3) are out of scope: they are needed for big spaces anyway.
