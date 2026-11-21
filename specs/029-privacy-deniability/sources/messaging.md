# 029 research: secure messaging protocols for hypergraph (MLS, Signal, deniability, padding, lessons)

Accessed 2026-11-21. Primary sources only. **[unverified]** marks claims I could not confirm from a primary source this session. Repo facts (licence, last push, latest release) come from the GitHub API on 2026-11-21.

## TL;DR

- **MLS needs one agreed Commit per epoch.** Our Autobase gives a causal DAG and later one agreed order, which fits RFC 9750's "eventually consistent" delivery service. The cost: you keep old epoch state around until the order settles, and forward secrecy is weaker during that window. Decentralised-MLS drafts (DMLS) shrink that cost with a puncturable PRF. They are drafts with no standard status.
- **Signal-style pairwise crypto (DCGKA, SimpleX, Signal's original groups) needs no ordering.** It costs O(n) messages per key change. That's fine for 50 members.
- **Libraries:** ts-mls (MIT, pure TS, **no audit**) is the only JS MLS that fits our runtime. libsignal is **AGPL-3.0**, so it's out for an MIT library. vodozemac (Apache-2.0, audited 2022) runs in Node as WASM. **Bare runs WebAssembly** when built with V8, which is the default, and on iOS through an interpreter.
- **Deniability:** MLS makes no deniability claim (RFC 9750). Signal 1:1 is deniable because it authenticates with DH-derived MACs. Signal group Sender Keys are signed. A space can restrict writers without signatures by using per-epoch MAC keys: any member could have forged the message, so no outsider can prove who wrote it.
- **Padding:** Signal pads to **80-byte** blocks, not 160. SimpleX uses 16384-byte blocks, Cwtch 1800 bytes for group text, Briar frames up to 1024 bytes, and Tor cells are 514 bytes (509-byte body). Padmé costs at most 12% overhead.

---

## 1. MLS vs Signal over replicated logs with no delivery service

### What MLS needs

RFC 9750 (MLS architecture, April 2025) says "the group must agree on a single MLS Commit message that ends each epoch and begins the next one" (§5.2). It allows two kinds of delivery service (https://www.rfc-editor.org/rfc/rfc9750.html, Apr 2025):

- **Strongly consistent:** the DS fixes the order, and clients apply only the first valid Commit per epoch.
- **Eventually consistent:** clients reconcile on their own. They either wait briefly and apply a deterministic tie-break, or accept a Commit at once, keep the previous state, and roll back if another Commit wins. "Forked state must be deleted in a reasonable time" to keep forward secrecy.

RFC 9750 also warns that a delivery service can split a group, and that only out-of-band comparison of `epoch_authenticator` detects it (§5.2). A buggy or malicious member can send a Commit that only some members accept (§5.3).

### How decentralised designs handle forks

- **DMLS** (draft-kohbrok-mls-dmls-03, 2025-10-20, expired 2026-04-23, individual draft with no IETF standing; https://datatracker.ietf.org/doc/draft-kohbrok-mls-dmls/). The author is Konrad Kohbrok. OpenMLS is maintained by Phoenix R&D (https://github.com/openmls/openmls); I did not confirm that Kohbrok works there **[unverified]**. How it works:
  - Each fork gets an id, `dmls_epoch = DeriveSecret(epoch_secret, "epoch")`, because the integer epoch number is no longer unique.
  - The next init secret is derived from a **puncturable PRF**. Each evaluated branch is deleted, so keeping the parent key does not expose Commits you have already processed.
  - Other epoch secrets and tree keys must still be kept longer than in plain MLS. That weakens forward secrecy and post-compromise security.
  - Suggested deletion rule: drop an old state once every member has committed on some fork descended from it.
  - There is no merge procedure: forks should be short-lived and members should converge on one. An earlier version of the draft picked the fork whose first differing Commit has the lexicographically higher confirmation tag (https://potaroo.net/ietf/ids/draft-kohbrok-mls-dmls-01.html, June 2025; mirror, not the datatracker).
  - Based on FREEK and Fork-Resilient CGKA.
- **Fork-Resilient CGKA**, Alwen, Mularczyk, Tselekounis (AWS-Wickr/CMU), CRYPTO 2023 (https://eprint.iacr.org/2023/394, rev. 2024-02-22). It lets clients process out-of-order and forked traffic. Its stated tension: replaying missed messages "conflict[s] with the way the protocols enforce group state agreement and forward secrecy."
- **Matrix:** MSC2883 "Matrix-flavoured MLS" is listed as preliminary. Hubert Chathi's FOSDEM 2022 talk describes the approach: "allow epochs to fork, but keep track of who created them", then pick a base and re-apply the other forks' changes as ordinary MLS operations. The talk says the design still needs security review (https://www.uhoreg.ca/documents/fosdem-2022/__/index.html, Feb 2022). I could not confirm the current status of MSC2883 **[unverified]**.
- **DCGKA**, Weidner, Kleppmann, Hugenroth, Beresford, ACM CCS 2021 (https://eprint.iacr.org/2020/1281, rev. 2021-05-31). It targets exactly our setting: no server trusted "to provide a consistent total order", and it still gives forward secrecy and post-compromise security. The PDF returned 403, so these details are from memory **[unverified]**:
  - It assumes authenticated causal broadcast (a causal order, not a total order).
  - Each member keeps its own hash ratchet.
  - Updates go out as pairwise two-party messages, so a key change costs O(n).
  - Membership uses CRDT-like rules, so concurrent adds and removes all take effect.
- **Cost of concurrency in TreeKEM:** Auerbach et al., CRYPTO 2025 (https://eprint.iacr.org/2025/1035, Jun 2025). With concurrent proposals, update cost grows past √N and towards N. The paper proposes a variant that stays logarithmic.
- **Wire** runs MLS with a central server, so it isn't a model for us. Its support pages cover the migration from Proteus to MLS, not fork handling (https://support.wire.com/hc/en-us/articles/18666343787293-Migration-from-Proteus-to-MLS-protocol, accessed 2026-11-21).

### Mapping to Autobase

- Autobase's causal DAG is what DCGKA wants. Its eventual linearisation is RFC 9750's "eventually consistent DS" with a deterministic tie-break that every peer computes the same way. The catch: the linearisation can **reorder** until it is confirmed, so we would be in the "accept, keep the old state, revert" mode.
- A practical MLS plan over Autobase would:
  1. Let only some roles (admins) commit, which cuts concurrent Commits.
  2. Treat a Commit as final only once the Autobase order is confirmed.
  3. Keep the pre-Commit epoch state until then, and drop it afterwards; that is DMLS's deletion rule.
  4. Handle losing Commits by having their authors re-propose.
- Our current epoch keys already rotate on member removal, so we are closer to "admin-ordered rekey" than to full CGKA.
- **Group size ~50:** the O(n) pairwise cost of a DCGKA or Signal-style scheme is about 50 small messages per rekey, which is cheap. MLS's log(n) advantage matters only for much bigger groups, and concurrent updates erode it anyway (Auerbach 2025).

### Signal side

- **X3DH** (rev. 1, 2016-11-04, https://signal.org/docs/specifications/x3dh/) and **PQXDH** (rev. 3, 2023-05-24, updated 2024-01-23, https://signal.org/docs/specifications/pqxdh/) set up 1:1 sessions from published prekeys. PQXDH adds an ML-KEM shared secret. Prekey signatures are needed: without them a malicious server enables a "weak forward secrecy" attack.
- **Double Ratchet** (rev. 4, 2025-11-04, https://signal.org/docs/specifications/doubleratchet/):
  - Each message gets its own key, which is deleted after use.
  - Keys for skipped messages are capped by MAX_SKIP and should expire. Stored skipped keys are a forward-secrecy risk. That matters for us, because logs deliver out of order.
  - Optional header encryption hides which session a message belongs to.
- **SPQR / Triple Ratchet** (Signal blog, 2025-10-02, https://signal.org/blog/spqr/) adds a post-quantum ratchet. libsignal now has `triple_ratchet.rs` and `pqxdh.rs` (https://github.com/signalapp/libsignal/tree/main/rust/protocol/src, accessed 2026-11-21).
- **Signal groups:**
  - The 2014 scheme sent group messages over the pairwise channels, tagged with a random 128-bit group id.
  - The 2019 private group system keeps membership encrypted on the server under a GroupMasterKey, with anonymous credentials (https://signal.org/blog/signal-private-group-system/, 2019-12-09).
  - libsignal has `sender_keys.rs` / `group_cipher.rs`: one symmetric chain per sender, with a **signing key** per sender-key state (source read 2026-11-21).
  - I did not confirm from a primary source when Signal switched group sends to Sender Keys **[unverified]**.
- **Fit for us:** Sender Keys (one chain per writer, handed to each member over pairwise channels) map cleanly onto "one Hypercore per writer". Ordering problems vanish because each writer's chain is linear in its own core. Rekey on removal costs O(n) pairwise sends.

## 2. Libraries

| Library | Licence | Audit | Maintenance (2026-11) | Node / Bare |
|---|---|---|---|---|
| **ts-mls** (https://github.com/LukaJCB/ts-mls) | MIT | **None** ("has not undergone a formal security audit") | Active; v1.6.4, 2026-08-28; pushed 2026-11-19 | Pure TS, Node 20+. Deps `@hpke/core`, optional `@noble/curves`, `@hpke/ml-kem`. Supports ML-KEM / ML-DSA / X-Wing. Should run on Bare, as it is plain JS plus WebCrypto-free noble options **[unverified: not tested on Bare; check that the `@hpke` packages don't require WebCrypto]** |
| **OpenMLS** (https://github.com/openmls/openmls) | MIT | None found | Active; openmls-v0.9.0, 2026-08-25 | Rust. `wasm32` builds in CI but is "not tested". An `openmls-wasm` dir exists with no documented JS API |
| **mls-rs** (AWS, https://github.com/awslabs/mls-rs) | Apache-2.0 or MIT | None ("has not yet received a full security audit"); RFC 9420 conformance validated | Active; pushed 2026-11-18; no GitHub releases | Rust. "Support for WASM builds"; webcrypto backend "experimental". No JS bindings |
| **libsignal** (https://github.com/signalapp/libsignal) | **AGPL-3.0** (confirmed) | No public full audit found **[unverified]**. PQXDH and SPQR had formal analysis (Signal blog) | Very active; v0.108.5, 2026-11-21 | Node bindings via native addon (TS library). Wrong licence for an MIT lib |
| **libsignal-protocol-javascript** (https://github.com/signalapp/libsignal-protocol-javascript) | GPL-3.0 | none | **Archived 2021-08-05**; "no longer used by us or maintained" | Do not use |
| **vodozemac** (https://github.com/matrix-org/vodozemac) | Apache-2.0 | Least Authority, May 2022: 10 issues, 8 fixed during the audit (https://matrix.org/blog/2022/05/16/independent-public-audit-of-vodozemac-a-native-rust-reference-implementation-of-matrix-end-to-end-encryption/) | Active; 0.11.2, 2026-11-05 | Olm/Megolm only, no MLS. Reachable from JS via **matrix-sdk-crypto-wasm** (Apache-2.0, v19.0.1, 2026-11-06, has Node entry points; https://github.com/matrix-org/matrix-rust-sdk-crypto-wasm). That wraps the whole Matrix crypto state machine, so it is heavy and Matrix-shaped |
| **@noble/curves** (https://github.com/paulmillr/noble-curves) | MIT | Trail of Bits Feb 2023; Kudelski Sep 2023; Cure53 Sep 2024; Trail of Bits Aug 2026 (README) | Active; pushed 2026-09-08 | Pure JS, runs anywhere |

**Bare and WebAssembly:**

- Bare runs WebAssembly when built with V8, which is the default. Maintainer kasperisager answered in issue #81: "It's already supported when compiling with V8, which is the default" (`bare -p WebAssembly` prints the object) (https://github.com/holepunchto/bare/issues/81, closed 2025-05-26).
- Holepunch's V8 prebuilds include the DrumBrake interpreter, "which is required on iOS" for `--jitless`. Android lacks DrumBrake but allows a JIT (https://github.com/holepunchto/chromium-prebuilds README, accessed 2026-11-21).
- One caveat from libjs `include/js.h`: a snapshot-warmup environment lacks the `WebAssembly` global.
- On iOS the interpreter will be slow, and WASM SIMD speed is not guaranteed **[unverified: no benchmark]**.
- We already have sodium-native, so native crypto beats WASM crypto anyway.

**Verdict:** for an MIT JS kit, ts-mls (unaudited) or a small in-house Sender-Keys/epoch scheme on sodium-native. Not libsignal.

## 3. Deniability

- **Signal 1:1 is deniable.** X3DH "doesn't give either Alice or Bob a publishable cryptographic proof of the contents"; this breaks down if a party collaborates with a third party online (X3DH §4.4). PQXDH gives 1-out-of-2 deniability in the classical setting, and replacing its DH authentication with signatures "would reduce deniability" (PQXDH spec). The mechanism: authentication comes from shared DH secrets and symmetric MACs/AEAD, which either side could have produced.
- **MLS is not deniable.** "MLS does not make any claims with regard to deniability" and it supports non-repudiation (RFC 9750 §8.2.3). Its one escape hatch: content can be deniable if signature keys are exchanged over a deniable channel before messages are signed (§8.2.1). That is the "ephemeral signing key certified over a deniable channel" idea.
- **Signal groups:** Sender Key messages carry a per-sender signature (libsignal `sender_keys.rs`). Inside a group, a member can show others who wrote a message. The signing key is not tied to the long-term identity, though, so the proof only reaches outsiders via the pairwise (deniable) channel. I did not check this nuance in a paper **[unverified]**.
- **Cwtch groups sign each message** with the peer's key and hash-chain them (https://docs.cwtch.im/security/components/cwtch/groups, accessed 2026-11-21). That gives integrity and no deniability.
- **Research:**
  - Celi, "Deniability in MLS" (IETF 110 slides, Mar 2021): implicit authentication keeps a weak deniability; you can show "someone in the group" sent it, not who (https://datatracker.ietf.org/meeting/110/materials/slides-110-mls-deniability-in-mls-00.pdf).
  - RWC 2024 (Barnes, Beurdouche, Robert) still lists "Deniability in MLS?" as open (https://iacr.org/submit/files/slides/2024/rwc/rwc2024/81/slides.pdf).
  - Chakraborty, Hofheinz, Maurer, Rito, "Deniable Authentication when Signing Keys Leak", EUROCRYPT 2023 (https://eprint.iacr.org/2023/213): MDRS-PKE (multi-designated-receiver signed PKE) stays deniable even after the signing key leaks; earlier constructions grow quadratically with the number of receivers.
  - I found **no paper named "DeCAF"** on deniable MLS **[unverified / possibly misremembered]**.
  - OTR: Borisov, Goldberg, Brewer, WPES 2004 (not fetched this session **[unverified link]**).

**Restricting writers without identity signatures (options, cheapest first):**

1. **Per-epoch group MAC key:** every member can write and verify. It is deniable towards outsiders, but any member can forge as any other member, so it cannot enforce roles (who is a moderator).
2. **Per-writer symmetric chains, Sender-Keys style but MAC instead of signature:** each writer's key goes pairwise to each member. A reader knows "this came from the holder of writer W's key", but every reader also holds that key and could forge it. So it is deniable, but a malicious member can impersonate others to third members. Signal fixes that with a signature; we'd accept it or add per-recipient MACs (O(n) tags per message, fine at 50).
3. **Ephemeral signing key per writer per epoch,** certified only over the deniable pairwise channel (RFC 9750 §8.2.1 idea). Gives integrity within the group and deniability to outsiders. This is the best fit for "roles enforced by signatures" plus Autobase.
4. **Ring signatures:** "someone in this set signed". Deniable inside the set, but no per-member roles.
5. **Designated-verifier signatures / MDRS-PKE:** strongest, research-grade, no JS library known **[unverified]**.

**Conflict with our design:** Autobase and Hypercore sign every block with the writer core's key, and holders store those signed blocks. If the core key is a long-term identity, nothing above it is deniable. Deniability needs writer cores keyed by ephemeral keys, rotated per epoch and linked to the identity only through a deniable channel.

## 4. New devices, history, disappearing messages

- **MLS:** a new member doesn't get earlier history (RFC 9750 §6.7), and a member recovering from lost state doesn't get messages from the gap (§6.6). Any history mechanism lives outside MLS "and may weaken forward secrecy and post-compromise security" (§6.7).
- **Signal:**
  - Linked devices get an optional, one-time encrypted archive of chats plus the last 45 days of media. A one-time AES-256 key travels in the provisioning message. Servers delete attachments after 45 days (https://signal.org/blog/a-synchronized-start-for-linked-devices/, 2025-01-27).
  - Before that, linked devices started empty **[unverified for exact dates]**.
- **Wire:** "messages are only stored on your devices", so a new device shows only new messages, unless you restore a backup (https://support.wire.com/hc/en-us/articles/207834645, accessed 2026-11-21).
- **Matrix:**
  - Megolm keys can be backed up server-side, encrypted to a recovery key (spec v1.19 §server-side key backups, https://spec.matrix.org/latest/client-server-api/#server-side-key-backups; body text not read **[partly unverified]**).
  - **MSC3061** (share keys for past messages at invite) was merged in 2023, then **reverted on 2024-10-29** after a security disclosure. The concern: a server can add a fake member or device and harvest past keys (https://github.com/matrix-org/matrix-spec-proposals/pull/3061).
  - It was replaced by **MSC4268**, merged 2026-04-08; spec PR merged 2026-06-24 (https://github.com/matrix-org/matrix-spec-proposals/pull/4268). The design (https://raw.githubusercontent.com/matrix-org/matrix-spec-proposals/main/proposals/4268-encrypted-history-sharing.md):
    - The inviter bundles only sessions flagged `shared_history`, meaning history visibility was `shared` at send time.
    - The bundle is encrypted with AES-256-CTR, uploaded, and the key goes by Olm to the invitee's cross-signed devices only.
    - Clients must start a new Megolm session whenever anyone leaves.
    - Messages show "Alice shared this message", since you only have the inviter's word about who sent them.
    - Bundles are accepted only from the inviter and within 24 hours.
- **Cost to forward secrecy:** keeping history for newcomers means keeping old keys, or old plaintext, somewhere. Whoever later steals those keys reads all that history. MSC4268 calls bundle sharing "a significantly greater risk than sharing keys ad hoc".
- **Our design:** our epoch keys plus holders storing old encrypted blocks already amount to "history kept". Forward secrecy then only covers what `trimHistory` really removes from every holder, plus old epoch keys a member deletes. A per-space switch makes sense:
  - **shared history** (Matrix-style, the inviter hands over old epoch keys); or
  - **no history** (MLS-style; new members get only the current epoch; old keys are deleted after a delay).
- **Disappearing messages:** with holders this is advisory only. A holder or member can keep blocks. Only key deletion is real.

## 5. Padding and metadata

- **Signal:** message plaintext is padded to multiples of **80 bytes**, not 160. Signal-Android `PushTransportDetails.java`: `PADDING_BLOCK_SIZE = 80`, length + 1 terminator, rounded up. Signal-Desktop `OutgoingMessage.preload.ts`: `PADDING_BLOCK = 80` (https://github.com/signalapp/Signal-Android/blob/main/lib/libsignal-service/src/main/java/org/whispersystems/signalservice/internal/push/PushTransportDetails.java, read 2026-11-21).
- **SimpleX:** "Each transport block has a fixed size of 16384 bytes for traffic uniformity"; some fields are also padded with a length prefix (SMP doc, version 21, 2026-07-05: https://github.com/simplex-chat/simplexmq/blob/stable/protocol/simplex-messaging.md). The PQ ratchet keys fit inside the 16 KB block (~2.2 KB spare; zstd for big messages) (https://simplex.chat/blog/20240314-simplex-chat-v5-6-quantum-resistance-signal-double-ratchet-algorithm.html, 2024-03-14).
- **Cwtch:** decrypted group messages have random padding so that padding plus text = **1800 bytes**. Older handbook text says every encrypted group message is the same length; the two docs differ slightly (https://docs.cwtch.im/security/components/cwtch/message_formats, accessed 2026-11-21).
- **Briar (BTP):** frames carry data plus optional padding. Data plus padding is at most 988 bytes, so an encrypted frame is at most **1024 bytes**. There are no plaintext headers. Frame lengths are variable up to the max, so padding is optional, not forced (https://code.briarproject.org/briar/briar-spec/-/commit/3231cb17b397617b33bbd14d74399177bb2ed299; current master returned 403 **[current spec unverified]**).
- **Session:** I found no primary source on Session's padding **[unverified]**.
- **Tor:**
  - `CELL_LEN` = **514** for link protocol ≥4 (512 before); `CIRCID_LEN` = 4; `CELL_BODY_LEN` = **509** (https://spec.torproject.org/tor-spec/preliminaries.html).
  - The relay cell header is 11 bytes, leaving padding `CELL_BODY_LEN − 11 − Length`, so data is at most **498** bytes (https://spec.torproject.org/tor-spec/relay-cells.html). Proposal 340 (packed/fragmented relay messages) may change this.
  - Padding: connection-level PADDING cells are single-hop. Relays see them, outside watchers don't. Circuit-level DROP cells are multi-hop and hidden from intermediate relays (https://spec.torproject.org/padding-spec/overview.html).
  - The overview I read doesn't state the threat. From memory **[unverified]**: connection padding defeats coarse ISP netflow records, and circuit padding targets onion-service circuit fingerprinting. Neither stops end-to-end timing correlation.
- **Padmé** (Nikitin, Barman, Lueks, Underwood, Hubaux, Ford, PoPETs 2019(4), https://petsymposium.org/popets/2019/popets-2019-0056.php):
  - Rounds a length L to a float-like bucket: keep the top bits of L, zero the low bits.
  - At most **12%** overhead, shrinking for larger payloads.
  - Leaks O(log log M) bits, about as good as power-of-two padding at much lower cost.
  - A good default for records and blobs of any size. Use fixed blocks (SimpleX/Tor) only for the live transport.

**For hypergraph:** pad record plaintext with Padmé before encrypting. Optionally batch small posts into fixed-size blocks on the wire. Note that Hypercore block sizes and the timing of appends stay visible to holders.

## 6. Lessons from deployed systems

- **SimpleX** (SMP doc above):
  - No user identifiers. Each queue is one-way, with separate recipient and sender ids, so the router can't link them. New keys and queue ids per contact.
  - Lesson: per-contact or per-space keys, never one global identity key that every holder sees.
  - Our discovery keys per space already help. A single identity key reused across spaces links them.
- **Signal sealed sender** (https://signal.org/blog/sealed-sender/, 2018-10-29):
  - Hides the sender from the server; the recipient stays visible.
  - IP and timing correlation are explicitly "ongoing development".
  - Martiny et al., NDSS 2021: a statistical disclosure attack, helped by delivery receipts, links users in as few as 5 messages (https://www.ndss-symposium.org/ndss-paper/improving-signals-sealed-sender/; PDF https://cs.umd.edu/~kaptchuk/publications/ndss21.pdf).
  - Lesson: hiding who sent one message is worthless if replies and receipts flow back. Automatic acks to holders, and read receipts, leak.
- **Briar:** each device runs its own Tor onion service and talks peer to peer, with no servers. Not re-checked this session **[unverified, from Briar docs not fetched]**. Lesson: per-device onions give strong metadata protection but need both sides online, or a "mailbox" helper. That is our holder role.
- **Session:**
  - **Dropped PFS** (and deniability in 1:1) in its new protocol, first rolled out 2020-12-11 (https://getsession.org/blog/session-protocol-technical-information, 2020-12-15). Reason given: Signal's protocols "were simply not designed to be run over a decentralised network" (reliability, multi-device, restore).
  - Messages are encrypted to the long-term X25519 key; closed groups share one keypair.
  - **Protocol V2** (announced 2025-12-01, https://getsession.org/session-protocol-v2): rotating per-device and per-account keys to restore PFS, ML-KEM, device-link notices. Still in design; specs promised for 2026.
  - Routing is "onion-routed by default"; Lokinet is used only for planned calls (https://docs.getsession.org/). Third-party reports of 12-hour key rotation are **[unverified]**.
  - Lesson: in decentralised, multi-device, async settings, teams have traded away FS for reliability. That is a warning about our epoch-key design. Rotate on a timer, not only on removal.
- **Cwtch:**
  - Profiles are encrypted at rest with a PBKDF2-derived key. "Unencrypted" profiles use a "defacto, hardcoded password", so anyone with disk access can open them.
  - Profiles are not listed until a password is entered: "it isn't possible to provide a full list of profiles a user might have access to until they enter a password" (https://docs.cwtch.im/security/components/cwtch/profile-encryption, accessed 2026-11-21).
  - Constant `DefactoPasswordForUnencryptedProfiles` in libcwtch-go (https://git.openprivacy.ca/cwtch.im/libcwtch-go/src/tag/v1.4.1/constants/globals.go).
  - Servers are "untrusted and discardable"; groups sign and hash-chain messages.
  - Lessons:
    - **Several identities in one app:** keep each identity in its own encrypted store, so that its existence can't be seen without its password. That is cheap deniable local storage.
    - Use one storage format for passworded and passwordless profiles, so the code path is the same.
- **Tor Browser:**
  - First-party isolation: "all identifier sources and browser state are scoped (isolated) using the URL bar domain".
  - "New Identity" wipes all tokens and state (design doc, draft 2018-06-15, https://2019.www.torproject.org/projects/torbrowser/design/).
  - Letterboxing, since 9.0 (https://blog.torproject.org/new-release-tor-browser-90/, 2019-10-22), keeps window sizes in a few buckets.
  - Lessons:
    - Scope every identifier (keys, DHT announces, swarm topics, holder connections) per identity and per space.
    - Offer "new identity", meaning new keys and new connections, as a single action.
    - Bucket anything observable: sizes (Padmé) and timing (batching).

## What this means for hypergraph (opinion, judged against "easiest kit for server-less social apps")

1. **Don't adopt full MLS now.**
   - ts-mls is unaudited.
   - Fork handling over Autobase is draft-level research.
   - The log(n) gain doesn't matter at 50 members.
   - An admin-ordered epoch rekey, with pairwise key delivery (sodium `crypto_box`), is simpler and fits Autobase's order.
2. **Do steal from the research:**
   - Rotate epochs on a timer as well as on removal.
   - Delete old epoch keys after the Autobase order is confirmed (DMLS's deletion rule).
   - Treat skipped and old keys as a forward-secrecy liability (Double Ratchet §8.4).
3. **Deniability conflicts with signed Hypercore blocks.** Offer it only as an opt-in "deniable space" with ephemeral per-epoch writer keys. Tell users plainly that a normal space is non-repudiable.
4. **Padding:** Padmé on record plaintext is cheap, so on by default.
5. **History:** per-space choice, `shared` (inviter hands over old epoch keys, MSC4268-style, cross-signed devices only) or `none`. The default is debatable: the social-app goal favours `shared`.
6. **Local storage:** use a Cwtch-style encrypted store per identity.

Not checked this session: DCGKA's full text (PDF 403), Briar's current spec (403), Session padding, the Matrix MSC2883 status, any libsignal audit, and ts-mls actually running on Bare.
