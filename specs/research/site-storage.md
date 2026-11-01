# Site storage: SwarmFS spaces vs Hyperdrive (HyperBrowser milestone 0)

Research note, 2026-11-01. Question from the HyperBrowser design (`ROADMAP.md`, "The final app"): every
site is a SwarmFS space; a single-writer Hyperdrive is the fallback for static sites only if a space
proves too slow. This note measures before building.

Benches: `bench/site-storage/` (how to run: its README). Machine: Windows 10, 8 cores, 16 GB, Node 26.4.
Code measured: SwarmFS `fd1391a`, swarmwire `2d6bfa4`, hypergraph master (`e483a76`, through SwarmFS's
`file:` link), hyperdrive 13.3.4, corestore 7.16.1, hyperswarm 4.17.2. Every run on a local DHT
(`hyperdht/testnet.js`, 3 nodes on 127.0.0.1): **no real network latency anywhere in these numbers**.

**The test site**: 33 files, 2.2 MB: `site.json`, `index.html` + 19 pages (3–12 KB), `style.css`
(8 KB), `app.js` (30 KB), 10 images of 200 KB. "Entry page readable" = `site.json`, `index.html`,
`style.css` and `app.js` are on the visitor's device. "Whole site" = all 33 files.

**Three variants**:
- **space**: a SwarmFS space, the site folder added as is; every file an entry, its bytes through swarmwire.
- **inline**: the same space, but every file up to 60 KB is stored inside its record (a record is at
  most 64 KB); only the 10 images go through swarmwire. Prototype in the bench only: one extra
  record type, SwarmFS unchanged.
- **drive**: a single-writer Hyperdrive, joined on its discovery key.

## Short answer

- A space works for sites today, but is **slower than a Hyperdrive on a fast link**: whole site
  1.2 s vs 0.12 s on loopback, entry page 0.29 s vs 0.03 s. Inline small files halve it (entry 0.13 s,
  whole site 0.53 s). The rest is swarmwire's cost per file (~30 ms even for 4 KB) and its speed with
  one peer (~10 MB/s vs ~28 MB/s).
- Per open site, a space costs ~3 MB of memory, a Hyperdrive ~1.8 MB; disk is the files in both;
  open files and connections don't grow per site (one connection per peer).
- On a real network the first connection (seconds, not measured here) will dominate all three. The
  gap that stays is round trips per file.
- **What blocks sites is not speed but roles**: a SwarmFS invite makes every visitor an `editor` who can
  rename, move, replace or bin the site's own pages, and the owner's syncing app renames her files on
  her disk to match. Hypergraph already has the pieces to fix it (sub-spaces with `writeRoles`, a role
  with no permissions); SwarmFS doesn't expose them.
- swarmwire **can't** fetch a part of a file first (no ranges, no priorities), so video seeking needs
  new work.
- **Recommendation**: keep SwarmFS-only. Don't build the Hyperdrive fallback now. Before milestone 1,
  SwarmFS needs read-only visitors and protected pages, inline small files and an app-storage mode;
  swarmwire needs a cheaper small-file path. Re-measure on a real network in milestone 1, with the
  threshold below.

## Q1. First visit of a 20-page site with 10 images

**Method**: `first-visit.mjs 7`. Each run: a fresh DHT, the owner sets up the site, a fresh visitor
whose engine is already open and online (HyperBrowser's engine runs before you open a site), then the
visit. Owner and visitor in one process. 7 runs per variant, interleaved. Times from the start of the
visit: SwarmFS `join(invite)` → list the folder → fetch the entry files in parallel → fetch the rest in
parallel; Hyperdrive: open by key, join its topic → `get` the entry files → list and `get` the rest.

**Numbers** (median, min–max, n=7):

| | joined (let in / owner found) | entry page readable | whole site | engine open (new identity) |
|---|---|---|---|---|
| space | 90 ms (75–179) | **294 ms** (257–379) | **1,162 ms** (1,089–1,354) | 799 ms |
| inline | 83 ms (72–111) | **127 ms** (106–161) | **531 ms** (504–666) | 751 ms |
| drive | 14 ms (10–30) | **30 ms** (25–58) | **123 ms** (113–148) | 396 ms |

The same visit with the visitor in its own process (from `many-sites.mjs`, 1 site, 2 runs): space entry
323–380 ms, whole 1.18–1.31 s; inline entry 201–206 ms, whole 0.68–0.70 s. Close to the table.

**Why the space is slower** (`probe-fetch.mjs 3`, after joining, 20 files one at a time):

| | one 4 KB file | one 2 MB file |
|---|---|---|
| SwarmFS `fetch` | 40 ms (28–80, n=60) | 200 ms (191–207, n=3), ~10 MB/s |
| swarmwire alone (`download`, no SwarmFS bookkeeping) | 28 ms (15–102, n=60) | – |
| Hyperdrive `get` | 1 ms (1–20, n=60) | 72 ms (72–76, n=3), ~28 MB/s |

- Each swarmwire download has a fixed cost of ~15–30 ms on loopback, even for 4 KB: it opens and
  checks the file on the serving side, asks who holds it, writes `<file>.part` and a progress sidecar,
  renames at the end (Windows file operations are slow). Not profiled further. SwarmFS adds ~10 ms
  (a hypergraph read before, a `held` record written after, per file).
- With one peer, swarmwire moves ~10 MB/s here vs ~28 MB/s for Hypercore (swarmwire's own README:
  "1–16 MB/s" one-to-one, a known TODO).
- Hyperdrive gets small files almost free once its index is there: they are blocks in a core
  already being replicated.
- `joined` for a space is an invite redemption (a member who records decisions lets you in), a few
  round trips; for a Hyperdrive, only a topic lookup.

**Verdict**: on loopback a space is ~4–10× slower than a Hyperdrive; inline small files cut the space's
time in half and make the entry page about 4× the Hyperdrive's (127 vs 30 ms), not 10×. All of these
are well under a second on loopback; on a real network the first connection and round trips decide
(Q5), and the space has more round trips per file.

**Seen on the way (bench artefact, not a product finding)**: with the visitor in another process, a
Hyperdrive visit took ~15 s every time, all of it before the first block. The visitor's Hyperswarm
says it is connected within ~20 ms but the owner's side never completes the handshake; Hyperswarm
retries ~13 s later. Reproduced with plain Hyperswarm (no Hyperdrive) across two processes
(owner `server` only, visitor `client` only), on and off. Spaces don't hit it; making both
Hyperdrive sides dial (`HD_JOIN=both`) didn't help (still ~15 s). Probably the local testnet on this
Windows machine (firewall, loopback UDP); cause not found, not checked on another machine. Q1 numbers are in one process to avoid it.

## Q2. Cost per open site: 1 and 50 sites

**Method**: `node --expose-gc many-sites.mjs 1,50`. The visitor runs in its own process; it opens
each site, fetches all of it, and keeps every site open. Measured after a gc and 3 s: the process's
memory (RSS), its Windows handle count (files, sockets, events...), its UDP/TCP handles and
connections, and the disk under its folder plus the fetched files. 50 sites = 10 owners × 5 sites
(owners in one process; the visitor sees 10 peers), every site with its own bytes. One run each.
"Per site" = (after − engine open with no site) / sites.

**Numbers**:

| variant | sites | memory (RSS), engine alone → with the sites | per site | Windows handles (per site) | connections | engine disk | fetched files | disk per site |
|---|---|---|---|---|---|---|---|---|
| space | 1 | 90.8 → 98.9 MB | +8.1 MB | 316 (+33) | 1 | 0.6 MB | 2.2 MB | 2.66 MB |
| inline | 1 | 90.7 → 99.2 MB | +8.5 MB | 293 (+10) | 1 | 0.8 MB | 2.2 MB | 2.84 MB |
| drive | 1 | 73.8 → 76.9 MB | +3.1 MB | 277 (+0) | 1 | 2.5 MB | – | 2.47 MB |
| space | 50 | 90.8 → 241 MB | **+3.0 MB** | 343 (+1.2) | 10 | 22.8 MB | 110 MB | 2.66 MB |
| inline | 50 | 90.9 → 243 MB | **+3.05 MB** | 315 (+0.6) | 10 | 31.7 MB | 110 MB | 2.84 MB |
| drive | 50 | 74.2 → 166 MB | **+1.8 MB** | 278 (+0) | 10 | 118 MB | – | 2.35 MB |

Visiting all 50 sites one after another took 62 s (space), 27 s (inline), 212 s (drive: the first
site from each of the 10 owners waited ~15 s for its connection, the stall in Q1; the others took
~60 ms). The Hyperdrive rows ran with both sides dialling (`HD_JOIN=both`): with the owner as server
only, one visitor waited 120 s for an owner and the run failed.

- **Disk**: per site, space ≈ the files themselves (2.2 MB) plus ~0.4 MB of records and indexes;
  Hyperdrive ≈ the same 2.2 MB inside its cores (no separate copy). Inline keeps the small files twice
  if they're also written out (record + file); a site engine would serve them from the record.
- **Open files**: none that grow with sites in either: hypergraph keeps every space in one Corestore
  folder (20 files on disk whatever the number of spaces), swarmwire closes a file 5 s after its last
  read. The +33 handles for one space is that: files still open just after the visit.
- **Connections**: one per peer, not per site (10 owners → 10 connections), in both.
- **Memory**: an open space costs ~3 MB, an open Hyperdrive ~1.8 MB (at 50; the first site costs more,
  ~8 MB, one-time code and caches). The engine alone: ~91 MB for hypergraph + SwarmFS, ~74 MB for
  Corestore + Hyperswarm.

**Verdict**: no blocker. 50 open sites cost a space engine ~150 MB of memory, a Hyperdrive one ~90 MB;
disk is the same (the files); handles and connections don't grow per site in either. For hundreds of
open sites (bookmarks and recent visits seeded from the tray) a space costs ~1.6× a Hyperdrive in
memory: the "one engine for many sites" spec should close spaces not used for a while and measure it.

## Q3. Visitors' media: a forum member posts an image into the site's space

**Method**: `visitor-media.mjs`. Alice owns the site (a SwarmFS space, her site folder added, her app
syncing it as spec 002 does). Bob, a forum member, joins with SwarmFS's invite; Carol, another visitor,
too. Part B uses hypergraph's own calls under SwarmFS: the pages in a sub-space with
`writeRoles: ['admin']`. Part C: a role with no permissions and a public link for it. Results as
printed by the script:

| step | result |
|---|---|
| Bob's role after SwarmFS's invite | `editor` (may post) |
| Bob adds `photo.jpg` (200 KB) into `uploads/` | ok; Carol sees it ~0.3 s later and fetches it from Bob in ~0.1 s |
| it lands in Alice's site folder on her disk | yes (her app syncs the folder) |
| Bob renames the site's `index.html` | **ok**, and Alice's own `index.html` on her disk is renamed too |
| Bob moves a page, adds his own `index.html`, bins a page | **all ok** |
| Bob adds `late.jpg` and goes offline at once | Carol: `NOT_AVAILABLE`; Alice's app hadn't fetched it yet |
| a read-only SwarmFS invite, or reading a site without an invite | no call for either (`Drive.invite` always gives `editor`; SwarmFS spaces are private) |
| B: pages in a sub-space with `writeRoles: ['admin']` | Bob lists and fetches them; renaming or adding there: `NOT_ALLOWED` |
| B: Bob uploads into the top space | ok; but he can also rename a picture Alice put there (`file` records are `editable: 'members'`) |
| C: role `reader` with no permissions, public link (`uses: Infinity`) | ok; Dave joins as `reader`, fetches the pages, adding: `NOT_ALLOWED` |
| C: Dave in the (private) top space | stays `access: 'waiting'`, sees nothing for 20 s |

**Verdict**: posting an image works today. What's missing for sites:

1. **Read-only visitors.** SwarmFS lets in only `editor`s. Hypergraph can already do a reader (Part C);
   SwarmFS needs an invite option for it. Not checked: why the reader never got the private top space's
   key. Likely (read in `lib/space.js`, `#entitled`, not proven): keys are granted to devices whose log
   the space knows, and a member who can't write never writes a record, so never gets one. Either a
   site's top space isn't private (a public site needs no secrecy), or hypergraph grants keys to
   readers too. **To ask hypergraph.**
2. **Protected pages.** Anyone who may post can rename, move, replace or bin any entry, the site's own
   pages included, and the owner's app follows on her disk. Sub-spaces with `writeRoles` fix it (Part B);
   SwarmFS has no call to make or list sub-spaces, and its `file` type lets every member edit every
   entry. Needs: a SwarmFS (or site) layout with pages only the owner and admins write, uploads open to
   members, and uploads editable by their author only (`editable: 'author'`, or a moderator).
3. **Uploads must outlive their poster.** A picture is only available while someone holding it is
   online. The owner's app (or a helper) should fetch members' uploads at once, into app storage with a
   cap, not into her own site folder.
4. **Not checked**: forum posts referencing an upload (a `ref` field in the forum's record type), size
   limits on uploads, moderation of uploads (hide/remove work on records; the bytes stay with whoever
   holds them).

## Q4. Video seeking: can swarmwire fetch the watched part first?

**No.** Read in swarmwire `2d6bfa4` (`lib/select.js`, `lib/swarmwire.js` `Download._pump`, `docs/contract.md`,
`docs/roadmap.md`):

- A file moves in groups of 16 KB (`CHUNK_LEN` 1 KB × 2^4). Which group to ask next is **rarest first,
  ties at random, scanning from a random place** in the file (`candidates`, `rank`). Good for a crowd
  of downloaders, the opposite of what a player needs.
- `download(link, path)` takes no range, offset or priority. The contract lists "Peer hints (preferred
  peers, priorities)" as *planned*; the roadmap lists "priority or range reads for a filesystem" as
  missing, not started.
- Verified groups are written into `<path>.part` with a bitfield sidecar, but the file appears only
  when complete (renamed); there is no call to read verified bytes of a download in progress.

So nothing to measure. Needed for video: (1) a priority range on a download (fetch groups `[a, b)`
first, in order, then the rest, or nothing else); (2) changing it while the download runs (the
viewer seeks); (3) reading verified bytes of a `.part` as they arrive (the sidecar already knows which);
(4) on SwarmFS's side, an engine call that serves a byte range of a file to the web view (HTTP
`Range`), waiting for the groups it needs. Hypercore/Hyperdrive has this today (blocks fetched on
demand, `createReadStream({ start, end })`).

## Q5. What these benches can't tell

- **Real-internet first connect**: DHT lookup, holepunching, relays when holepunching fails. Typically
  seconds; it will dominate a first visit for all three variants. Measure in milestone 1 between two
  real machines (and a phone).
- **Latency × round trips**: on loopback a round trip is ~0. A space's first visit has more of them
  (invite redemption, then per file: ask holders, request groups) than a Hyperdrive's; at 50–150 ms per
  round trip this is where the gap would show. Not estimated precisely here.
- **Bandwidth limits, packet loss, mobile links, Bare** (the phone runtime): not measured.
- **Several seeders**: every run had one owner online. swarmwire is built for many peers; Hyperdrive too.
- **The owner offline**: a site then depends on visitors or a helper holding it. Not measured.
- **A real browser in front**: Pear's web view, the engine↔web view messages, sandboxing, many small
  requests from a page: not built yet.
- **Eviction / app-storage mode**: doesn't exist, so its cost can't be measured.
- **Hundreds of sites, days of uptime**: only 50 sites for a few minutes.
- **Other disks and OSes**: Windows' slow file operations may inflate swarmwire's per-file cost; Linux
  and macOS not tried.
- The cross-process Hyperswarm stall (Q1): not checked on another machine.

## Recommendation

**SwarmFS-only stays the plan, but SwarmFS is not fine as is for sites.** Speed isn't what blocks it;
roles and storage are. To add, in rough order:

1. **SwarmFS — visitors who only read** (Q3): an invite option for a role without `post`; and for a
   public site, reading without being let in at all, or a public `reader` link (works in hypergraph today).
2. **SwarmFS — protected pages, open uploads** (Q3): pages only the owner and admins write (a
   sub-space with `writeRoles`, already in hypergraph), uploads open to members and editable by their
   author only. SwarmFS needs calls for sub-spaces, or a per-folder rule.
3. **SwarmFS — app-storage mode**: a site's files fetched into the engine's folder, not a user folder;
   evicted like a cache; no linked folder; the owner's app keeps members' uploads (Q3).
4. **SwarmFS — small files inside the record** (Q1): measured, halves a first visit. A `file` record
   with the bytes (up to ~60 KB) instead of a swarmwire ref. Costs: no dedupe across sites for those
   files, the space's logs get bigger (fine for pages and scripts).
5. **swarmwire — a cheaper small-file path and a faster one-to-one path** (Q1): ~30 ms per file is
   most of a space's first visit once inlining is done; one-to-one throughput is already its TODO.
6. **swarmwire — range-first downloads** (Q4): priority ranges, changeable while running, and reading
   verified parts of a `.part`; SwarmFS serves byte ranges to the web view.
7. **hypergraph — keys for readers in private spaces** (Q3, to confirm), and the "one engine for many
   sites" spec already in milestone 0 (memory per open space, Q2).

**The static-site Hyperdrive fallback: not needed now.** On loopback it is 4–10× faster, but with
inline small files a space shows the entry page in ~0.13 s and the whole test site in ~0.5 s, far
below what a real network's first connection costs. Building it would mean a second storage model in
the engine. Re-decide in milestone 1 with real numbers: **if, between two real machines, a space's
entry page takes more than about twice a Hyperdrive's (both after connecting), or more than 1 s after
connecting**, and the swarmwire fixes above don't close it, then build the fallback for static sites.

## Not checked (list)

- Real network, phones, Bare (Q5).
- Why swarmwire's per-file cost is 15–30 ms (not profiled).
- The reader that never got the private space's key (Q3 Part C): the cause above is a reading of the
  code, not proven.
- The cross-process Hyperswarm handshake stall on another machine.
- Q2 is one run per row; memory varies by a few MB between runs (1-site rows: ±1 MB over 3 runs).
- Forum records referencing uploads; upload size limits; moderating uploads' bytes.
