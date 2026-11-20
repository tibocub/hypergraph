# Spec 028: hiding who talks to whom (research first)

**Created**: 2026-11-19 · **Asked by**: the lead session, for Tibo · **Status**: research (no build until Tibo
reviews it)

Today every peer sees every other peer's IP address. hyperdht announces `IP:port` under each space's topic, DHT
nodes see who looks up which topic, holders see sizes and timing, DHT node ids are `hash(host, port)`
(`dht-rpc/lib/peer.js`), and new peers find the network through Holepunch's bootstrap nodes. Our strengths are
hole punching that works almost everywhere and ease of use. GNUnet, Hyphanet, Tor and I2P are far ahead of us on
anonymity, Sybil and eclipse resistance. This research asks what we can borrow or plug in, and says so if a root
choice of ours looks wrong.

One fact makes this tractable: hypercore replication runs over **any duplex stream**. A space doesn't care whether
its bytes travel over Hyperswarm, a TCP socket or a Tor circuit.

## Starting point (the lead's position; the research may argue against it)

- **P1** No home-made anonymity network. Plug in an existing one: Tor (through Arti), I2P (through i2pd) or Veilid.
- **P2** A mode uses Hyperswarm **or** the anonymous network, never both: one Hyperswarm packet leaks the IP.
- **P3** Anonymous networks are slow: fine for chat and forums, not for big files.
- **P4** Phones are mostly clients, not relays.

## Three goals, kept apart

- **G1 Hide my IP from other peers** (not from the network): a member of a space shouldn't learn my address.
- **G2 Anonymity against a network observer**: someone watching links (an ISP, a country) can't tell who talks to
  whom.
- **G3 Reaching the network where it is blocked**: censorship.

## Research questions (answered in `research.md`)

- **RQ1 (G1) Blind relay**: how far does hyperdht `relayThrough` with the helper VPS as a blind relay get us? What
  does the relay learn? What would wiring it in cost?
- **RQ2 (G2) Tor via Arti, I2P via i2pd, Veilid**, each on: platforms (Windows, Linux, macOS, Android, iOS); embed or
  talk to a local service; latency and throughput; relaying on phones (battery, Android background limits);
  licence; who maintains it; known attacks.
- **RQ3 (G3) Censorship**: pluggable transports (Snowflake, obfs4, WebTunnel) vs I2P reseeding, our own DHT bootstrap
  nodes, bootstrapping through Tor.
- **RQ4 Anonymous mode design**: finding peers without the DHT (addresses in member records or invites); keeping one
  identity key from linking sessions (pseudonymity vs anonymity); what must never touch Hyperswarm in that mode.
- **RQ5 Lessons** from GNUnet (R5N, CADET), Hyphanet (friend-to-friend, deniability), Tor and I2P on Sybil, eclipse
  and spam, mapped to our weak spots: free identities in public spaces, DHT eclipse, holder metadata, the Holepunch
  bootstrap dependence. Is any root choice (hyperdht, Autobase, one identity per person) wrong?
- **RQ7 (G2) Mixnets**: Tor and I2P can't stop traffic correlation (an observer of both ends matching timing);
  mixnets resist it with mixing, delays and cover traffic, and our traffic is mostly asynchronous. **Free to use only**
  (no paid credentials for users): Katzenpost, xx network / cMix, Loopix-based systems, anything maintained in 2026.
  Same questions as RQ2, plus: can a Node or Bare client exist, and can it carry whole replication streams or only
  small messages (with Tor or Hyperswarm for the rest)? Does a mixnet option for high-risk users belong in the order?
- **RQ6 Prototype**: two hypergraph engines replicate a space over a candidate network; join time, record latency
  and throughput against plain Hyperswarm.

## Scope

- In: reading primary sources, a prototype under `research/anonymity/`, one recommendation per goal with a rough
  cost and an order.
- Out: any change to `lib/`; a product API for transports; building a relay network; legal advice on running
  relays.

## Done when

`research.md` answers RQ1–RQ6 with sources and dates, gives one recommendation per goal, a cost, an order, and a list
of what could not be verified; the prototype runs and its numbers are in `research.md`.
