# Audit of the new core (`lib/`, `tools/inspector/`) — read-only report

2026-10-11, spec 011's final pass (`/ponytail-audit`, task F07). **A report only: nothing here was applied.**
The lead conversation decides which findings to fix. (One problem found by the adversarial tests was fixed
in this pass, test first, and is not repeated here: log keys named by any peer are now fetched 16 at a
time — `lib/directory.js`, research.md A15.)

**What this repo does:** `hypergraph/next` is a library for apps without a server (forums, chats, wikis,
shared folders). Each person writes records in their own signed logs; every member keeps a local index of
what it holds, checks everything it receives against the space's decisions (members, roles, bans), and
answers reads within a time bound, saying when an answer is incomplete. The inspector is a small
read-only web page showing what an instance holds.

**Load assumed:** one app per person on an ordinary computer or phone; spaces from a handful of members
to "thousands of members" and a million records (spec 011, story 9); and **anyone on the internet able to
connect** to a space's topic, including people who are not members and who send anything they like.

Read in full: `gate.js`, `log.js`, `activity.js`, `directory.js`, `replication.js`, `network.js`,
`pairing.js`, `phrase.js`, `storage.js`, `limit.js`, `instance.js`, `identity.js`, `invites.js`,
`private/*`, `decisions/apply.js`, `decisions/log.js`, `index/indexer.js`, `index/query.js`,
`tools/inspector/index.js`. Read in part: `space.js` (2,250 lines: budgets, keys, redeem, ask, open),
`index.js` (open, rebuild, settle), `decisions/state.js`, `tools/inspector/page.js` (escaping only).

## Must fix

1. **Anyone who sees a space's topic on the DHT can read it** (`lib/directory.js:276-286`, `#onWant` at :367)
   - **What this is:** Members find each other on a "topic" (the space's discovery key, a hash of its key).
     DHT nodes see topics; Hypercore's model is that the discovery key reveals nothing, the key is what lets
     you read.
   - **Problem:** The space channel is opened with the discovery key as its id, and a `want` message on it
     is answered with every log key of the space, to any peer, member or not. With those keys a peer
     downloads every log. So a DHT node that saw the topic, or anyone a member gossips the topic to, reads
     a closed (non-private) forum without an invite. Private spaces and the personal space are encrypted,
     so only their sizes and timing leak.
   - **Fix:** Answer `want`, `get` and notices only on a channel whose peer proved it knows the space key
     (the `hello` gets a MAC of the space key over the connection's handshake hash), or whose identity is a
     member or a newcomer with a redemption under way. One check in `#onWant`/`get`/`#onLogs`.
   - **If we skip it:** "closed forum" means "closed for writing, open for reading to whoever watches the
     DHT". At least the docs must say so (FR-033), which apps will not expect.

2. **The recovery phrase file can be read by other users of the computer** (`lib/phrase.js:26-29`)
   - **What this is:** Until the person chooses, the phrase (the whole identity) sits in
     `<folder>/recovery-phrase`; afterwards a copy sealed by a password does.
   - **Problem:** It is written with the default file mode: on Linux and macOS, usually readable by every
     user of the machine (`0644`). Another account on a shared computer copies the 24 words and owns the
     identity; or copies the sealed one and guesses the password offline (Argon2id "interactive" limits).
     The same goes for the rest of the folder (device key pair inside `cores/`).
   - **Fix:** `fs.writeFileSync(tmp, …, { mode: 0o600 })`, and create the instance folder with
     `mode: 0o700` at open. Two small changes; Windows ignores them.
   - **If we skip it:** an account can be taken over by anyone with a login on the same computer.

3. **A stranger can make a newcomer's first page say "complete" too early**
   (`lib/activity.js:266`, `onList`)
   - **What this is:** A newcomer to a big space asks one member at a time for the activity lists from a
     period on; once a list is whole, reads from that period can say `complete: true`.
   - **Problem:** `onList` accepts a list with `done: true` from any channel, asked or not, member or not.
     A stranger sends `{ from: 0, entries: [], done: true }` and the newcomer believes it knows every
     active log since the beginning: its first page says complete while posts are missing. (The adversarial
     test sends such a list; nothing wrong is *shown*, but `complete` lies.)
   - **Fix:** In `onList`, ignore a list unless `this.asking` exists and `this.asking.asked.has(ch)`; ask
     only channels whose identity is a member (`ch.identity` from `hello`).
   - **If we skip it:** apps trust `complete` (a "still syncing…" hint disappears), so missing posts look
     like there are none.

## Should fix

4. **Any peer gets the whole list of logs and activity entries, as often as it asks**
   (`lib/directory.js:367` `#onWant`, `lib/activity.js:251` `onWant`)
   - **What this is:** A 1-byte `want` is answered with every log key (32 B each); a 3-byte activity `want`
     with every entry from that period (~41 B each).
   - **Problem:** No limit per peer: a stranger repeating `want` makes a member of a space with 10,000 logs
     send ~320 KB per request (a 100,000× amplification), all day.
   - **Fix:** Answer each channel at most once per summary period (10 s) unless the directory changed;
     together with finding 1, only to peers allowed to ask.
   - **If we skip it:** one connected stranger can eat members' upload.

5. **A flood of made-up log keys delays real ones** (`lib/directory.js` `#fetch`, this pass's fix)
   - **What this is:** Log keys anyone names are now fetched 16 at a time, 1,024 waiting (more dropped).
   - **Problem:** Each made-up key waits up to 10 s for a header that never comes, in arrival order. A
     stranger who keeps the queue full delays a new member's real log by up to ~10 minutes (1,024 ÷ 16 ×
     10 s), and drops it when the queue is full (the next summary brings it back).
   - **Fix:** Two queues: keys named by members (`ch.identity` a member) or in a list we asked for go
     first; keys from others only when nothing else waits, with a small per-channel quota.
   - **If we skip it:** no crash, but spam can make new members invisible for minutes.

6. **Protecting the phrase can lose it** (`lib/phrase.js:62`, `protect`)
   - **What this is:** `protect` replaces the plain phrase by a sealed copy.
   - **Problem:** It first overwrites and deletes the plain file (`forget`), then writes the sealed one. A
     crash or power cut in between leaves no phrase on the device. Someone who never wrote it down (the
     reason they chose "keep it here") has lost it.
   - **Fix:** Write the sealed copy to the `.tmp` file and rename it over the plain one (atomic), then
     nothing else; overwriting freed blocks gives little on SSDs and journaling file systems anyway. One
     test: the sealed file exists whatever step stops.
   - **If we skip it:** rare, but the loss is permanent.

7. **A torn entry in the `logs` file shifts every later one** (`lib/instance.js:32`, `readLogs`; `addLog`)
   - **What this is:** `logs` lists every accepted log (64 B per entry), so a lost index can be rebuilt.
   - **Problem:** A crash mid-append leaves e.g. 40 bytes. Reading ignores a torn *last* entry, but the next
     appends start at that offset: every later entry is read 40 bytes off, as garbage. After a later index
     loss, those logs are not indexed again until peers bring them back (offline: never).
   - **Fix:** In `readLogs`, if the size isn't a multiple of 64, truncate the file to the last whole entry
     (`fs.truncateSync`). Two lines, plus a test appending after a torn entry.
   - **If we skip it:** a rebuild after a crash can silently miss logs.

8. **Every decision re-reads all the decisions** (`lib/decisions/log.js:165-192`, `reload`)
   - **What this is:** After each change of the decision log, the whole view (members, roles, bans,
     moderation, redeemed invites…) is read again and the state rebuilt; listeners then go over every log
     and every moderated record.
   - **Problem:** It assumes "decisions are few". An open forum of 5,000 members has ≥15,000 view entries
     (member, redeemed, uses per join), so each join reads them all on every member: joining the 5,000th
     costs all members ~5,000× more than the first, and the total grows with the square of members.
   - **Fix:** Coalesce reloads (one per 100 ms burst, as the directory's summary does), and later apply
     each new decision to the state instead of rebuilding it.
   - **If we skip it:** big open spaces (story 9's "thousands of members") slow down on every join.

9. **One vote per member reads all the member's earlier votes** (`lib/index/indexer.js:785`, `#onePerMember`)
   - **What this is:** For `onePerMember` types, each new record looks up the member's other records on the
     same target to mark the older ones superseded.
   - **Problem:** The lookup returns superseded rows too, so a member who changes a vote n times costs n
     reads the next time: quadratic. Measured by accident in this pass: a benchmark writer voting on the same
     two posts read 970,000 rows for 3,000 votes and indexed ~100 records/s. A modified app can do it on
     purpose.
   - **Fix:** Skip rows already superseded in the index key (add `superseded` to the index's key, or keep
     only the current row in `@hg/one-per-member`), so the lookup returns at most one row.
   - **If we skip it:** one member toggling a like thousands of times slows every member's indexing.

10. **"Keep everything" loads every record to find dropped ones** (`lib/space.js:1950`, `#refill`)
    - **What this is:** In a space whose creator asks to keep everything, dropped content is fetched again
      once it fits, `REFILL` records at a time.
    - **Problem:** Each pass reads every row of every app type into memory (`toArray()`) to pick a few:
      ~1 GB of rows for a million records, at each budget pass.
    - **Fix:** Stream with `for await` and stop at `REFILL` rows, as `#droppable` already does.
    - **If we skip it:** memory spikes and long pauses on big archives (SwarmFS's case).

11. **Catching up a long log scans every missing block** (`lib/index/indexer.js:308` `#run`, `:436` `#wipedByAuthor`, `:899` `lowest`)
    - **What this is:** The indexer walks a log up to its known length; blocks not here yet become "holes".
    - **Problem:** When a log of 500,000 blocks becomes known before its blocks arrive (a full member
      catching up), each missing block costs a database range query (`#wipedByAuthor`), every batch of 256
      computes the lowest of up to 500,000 holes (`lowest`), and every recheck (≤5 s) puts all holes back
      in the queue. At 1,000,000 records the owner indexed 1,000–2,400 records/s while downloading, against
      5,600/s for an instance alone.
    - **Fix:** Look up deletes for a whole range of missing blocks at once (one query per run), keep the
      lowest hole as a number updated on insert/delete, and recheck holes from the lowest only.
    - **If we skip it:** big spaces take several times longer to catch up.

12. **The inspector answers any web page that rebinds a name to 127.0.0.1** (`tools/inspector/index.js:64`)
    - **What this is:** The inspector listens on 127.0.0.1 and returns JSON about everything held.
    - **Problem:** It doesn't check the `Host` header. A web page can point its own domain at 127.0.0.1
      (DNS rebinding) and read `/api/records` from the browser: the person's spaces, private sub-spaces'
      records this device can read included.
    - **Fix:** Answer only when `Host` is `127.0.0.1:<port>` or `localhost:<port>` (403 otherwise). Three
      lines and one test.
    - **If we skip it:** fine while it is a developer tool; not once it is HyperBrowser's panel.

## Nice to have

13. **An author's posts scan all their records** (`lib/index/query.js:147`)
    - **What this is:** `query('post').by(author)` uses the by-author index, which isn't split by type.
    - **Problem:** Measured 5 ms for an author with 100,000 records (90% comments and votes), against 1 ms
      for "latest posts".
    - **Fix:** Add `type` to the by-author key (`space, author, type, stamp`); index rebuild needed.
    - **If we skip it:** profile pages of very active members are a little slower.

14. **An empty module** (`lib/personal.js`)
    - **What this is:** `module.exports = {}` with "filled in by the task that needs it"; nothing requires it.
    - **Fix:** Delete the file.
    - **If we skip it:** one more file to wonder about.

15. **Two queues for the same job** (`lib/directory.js` `considerSome` / `#drainSome` and `#fetch`)
    - **What this is:** Logs learnt from activity entries have their own bounded queue (16 at once, 256
      waiting); since this pass every log key goes through `#fetch`'s (16 at once, 1,024 waiting).
    - **Fix:** Drop `some`, `SOME`, `MAX_SOME`, `#drainSome`; `considerSome` calls `consider` (≈20 lines).
      Keep `logRefused` on refusal.
    - **If we skip it:** two limits to tune and explain for one thing.

**Verdict:** sound core (inputs are checked before use, decisions are deterministic, crypto is careful);
fix 1–3 first: a closed forum is readable from the DHT, the phrase file's permissions, and `complete` can
be faked by a stranger.

**Lean:** −25 lines possible (14, 15), no dependency to remove.

**Not checked:** most of `lib/space.js` (reads and "complete", widening, private-space sealing paths),
`lib/decisions/state.js` and `lib/types.js`/`fields.js` beyond what the tests cover, `page.js` beyond its
escaping, and Bare-specific behaviour of file modes. Finding 1 was found by reading, not reproduced by a test.
