# Spec 029: privacy and deniability in HyperBrowser (research first)

**Created**: 2026-11-21 · **Asked by**: the lead session, for Tibo · **Status**: research (no build until Tibo
reviews it) · **Builds on**: spec 028 (opt-in Tor mode, measured Tor)

## The goal

HyperBrowser should be minimally safe and private, with **deniability** as the aim. With Tor on and no user
mistakes:

- nobody can link a forum pseudonym to a real IP address or person;
- someone who seizes the device can't prove that a hidden identity exists.

Today none of this holds. One account lives in one engine folder; its 24-word recovery phrase is a file in that
folder (`phrase.save(dir, …)`, `lib/phrase.js`); every site sees the same identity key; holders see record sizes
and timing; every peer sees our IP (spec 028).

## Decisions already made with Tibo (constraints)

The research may argue against one, with evidence; it doesn't silently drop any.

- **D1 Threats, in order**: other users and sites, then network observers, then device seizure. Work order:
  identities first, device deniability second, Tor mode third.
- **D2** An ID manager with named identities. Per-contact keys inside an identity come later (SimpleX's lesson).
- **D3** Identities without Tor are allowed, with a warning that they share an IP. An "only over Tor" switch per
  identity.
- **D4 The vault**: a VeraCrypt-style vault on every install. One file of a chosen size, filled with random bytes,
  with slots that only a password finds, so it can't be told from random. Reuse VeraCrypt's *design*, not its code
  (TrueCrypt License 3.0, not MIT-compatible; C/C++ disk drivers). Build on libsodium (Argon2id,
  XChaCha20-Poly1305). Capacity is one data budget shared by all identities. Growth: copy the raw bytes into a
  bigger file and fill the rest with random, ideally with no password. Research first: hidden volumes are easy to
  get wrong.
- **D5 Chats are secure by default**: 1:1 and groups get MLS-style ratcheting (forward secrecy, post-compromise
  security), no history on new devices, optional disappearing messages, and a "keep history for newcomers" switch
  for community channels with its costs explained. Forums keep the current model.
- **D6** Deniable authentication in secure conversations: no identity signature a third party can check. Public
  spaces and forums keep signatures (moderation needs them); their anonymity comes from a dedicated identity plus
  Tor.
- **D7 Metadata**: pad records to a few fixed sizes in private spaces; random delays when syncing with holders;
  cover traffic later, together with mixnet notices (spec 028).
- **D8 Order**: research → ID manager → secure conversations → padding and delays → vault → Tor mode (one onion
  address and one Tor circuit per identity, e.g. SOCKS-auth stream isolation).
- **D9** Everything of a hidden identity lives in the vault: spaces, keys, recovery phrase, site profiles, data
  held for circles (with a per-identity switch for holding).
- **D10** No panic or duress wipe for now.
- **D11 Outside traces**: no notification content and no logs while a hidden identity is open; memory over disk
  where possible; OS traces documented honestly, with advice.

## Research questions (answered in `research.md`)

- **RQ1 The vault**
  - a. A layout (header, slots, how a password finds its slot, Argon2id parameters, random fill), learning from
    VeraCrypt's hidden volume and deniable-storage papers (Mobiflage, HIVE, DEFY, Artifice, Shufflecake, …).
    Sources and known attacks.
  - b. Snapshot attacks: someone who sees the vault twice sees which bytes changed. What defends against that?
  - c. Growth without passwords: possible, and how?
  - d. Capacity math: overhead, fragmentation, how to show "X GB left".
  - e. How hypercore/corestore storage (RocksDB in the installed corestore) can live inside the vault: a virtual
    file system, a custom storage, or something else. Costs and speed, with a prototype that measures write and
    read speed.
- **RQ2 Device traces** on Windows, Linux and Android: site profiles, GPU and shader caches, crash dumps, logs,
  temp files, notification history, jump lists, thumbnails, swap, hibernation, the Pear update folder, recent
  files. For each: avoid it, move it into the vault, or keep it in memory? Can an Electron session be memory-only
  (a non-`persist:` partition)? Test what it writes.
- **RQ3 Identities in hypergraph**: what changes for several identities in one engine (each with its own personal
  space, devices, circles and site profiles; one at a time or side by side; no shared keys or swarm key pairs), and
  what links two identities on one device today (swarm key pair, device key, DHT announces, holder membership,
  timing).
- **RQ4 Secure conversations**
  - a. MLS (RFC 9420) vs Signal's protocols (Double Ratchet, Sender Keys, X3DH/PQXDH) for 1:1 and groups up to
    ~50, over asynchronous replicated logs with holders as the delivery service.
  - b. Mature JS/WASM libraries (licence, audit, Bare).
  - c. How members, new devices, removal and disappearing messages map onto spaces and `trimHistory`.
  - d. Deniable authentication inside hypergraph's permission model (who may write, if records aren't signed by
    identities).
- **RQ5 Metadata**
  - a. Padding bucket sizes (Signal's, SimpleX's), with measured storage and bandwidth cost on realistic chat and
    forum data.
  - b. What holders still learn.
  - c. Sync delay jitter: what it costs and what it hides.
  - d. What Tor's 514-byte cells already cover.
- **RQ6 Lessons** from SimpleX, Signal, Briar, Session, Cwtch and Tor Browser not covered above. Say plainly if a
  decision above looks wrong, with evidence.

## Scope

- **In**: primary sources; small prototypes under `research/privacy/` where a number or a feasibility question
  needs one; a proposed build order with rough costs; risks; what couldn't be verified.
- **Out**: any change to `lib/`, HyperBrowser, SwarmFS or other product code; downloading binaries; legal advice.

## Done when

`research.md` answers RQ1–RQ6 with sources and dates, the prototypes run and their numbers are in it, and it ends
with a build order, costs, risks and a list of what couldn't be verified.
