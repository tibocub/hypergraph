# Site storage benches (HyperBrowser milestone 0)

Results and verdicts: [`specs/research/site-storage.md`](../../specs/research/site-storage.md).

Every run uses a local DHT (`hyperdht/testnet.js`, 3 nodes on 127.0.0.1) and removes its data.
They read SwarmFS from `../SwarmFS` (next to this repo; `SWARMFS_DIR` to change) and need a scratch
folder with Hyperdrive, kept out of this repo's dependencies:

```bash
mkdir E:\Code\P2P\.tmp\site-storage-deps && cd E:\Code\P2P\.tmp\site-storage-deps
npm init -y && npm i hyperdrive corestore hyperswarm hyperdht
```

(`SITE_DEPS` for another folder, `BENCH_TMP` for where run data goes; both default under `E:\Code\P2P\.tmp`.)

| script | question | what it does |
|---|---|---|
| `first-visit.mjs [runs] [variants]` | Q1 | a cold visitor opens the test site (33 files, 2.2 MB: 20 pages, css, js, 10 images of 200 KB); time to the entry page and to the whole site. Owner and visitor in one process |
| `probe-fetch.mjs [runs]` | Q1, why | one 4 KB file at a time and one 2 MB file: SwarmFS fetch, swarmwire alone, Hyperdrive |
| `many-sites.mjs [sites] [variants]` | Q2 | the visitor (a child process) opens 1 or 50 sites and keeps them open: memory, Windows handle count, connections, disk. Run with `node --expose-gc` |
| `visitor-media.mjs` | Q3 | a member posts an image into the site's space; what roles allow (rename, move, replace pages) and what happens when the poster leaves |

Variants: `space` (a SwarmFS space, every file through swarmwire), `inline` (files up to 60 KB inside the
record: an extra record type in the bench only, SwarmFS unchanged), `drive` (a single-writer Hyperdrive).

`HD_JOIN=both`: both Hyperdrive sides join as client and server (the 50-site Hyperdrive run needed it).

Keep runs short (a few repeats). `first-visit.mjs 7` takes about a minute; `many-sites.mjs 1,50` about
ten (most of it the Hyperdrive visitor's slow first connection across processes, see the study).
