# Holder picking: simulator and online-hour export (spec 025)

- `sim.js`: the simulator (made-up patterns, strategies, the replay). `run.js`: prints the tables in
  `specs/025-holder-picking/research.md`. `export.js`: a device's recorded online hours, keys replaced by labels.
- Test: `node research/holders/test.js` (not in `npm test`: research, not the library).

```bash
node research/holders/run.js                 # all strategies, mixes friends/global/phones, 2 5 15 50 people, +/- helper (~1 min)
node research/holders/run.js --repair --mix friends --strategies hash,s15
node research/holders/run.js --analytic
node research/holders/run.js --real pc.json other.json vps.json --sizes 5,15
node research/holders/run.js --real vps.json --seen --sizes 15     # the helper's view of every holder (see below)
```

## Exporting real online hours (D3)

What gets recorded: a device counts an hour online when its hypergraph runs (HyperBrowser open, or the helper running)
**and** it is in a circle (hypergraph 024+). Kept 30 days. So start collecting now and export after **30 days**.

What the file holds: `self` = this device's own hours (its true pattern). `holder-N` = hours this device was online
**and** connected to that holder: from a PC that's only the overlap, but from the always-on helper it's (nearly) the
holder's own pattern, which is why the VPS file is the most useful one. No keys, no names; the hours themselves
(when each device is on) are in it.

The export opens the index **read only**: the app or helper can keep running (checked on Windows by the test; RocksDB's
read-only open takes no lock on Linux either). Hours are saved every 5 minutes, so the last few minutes may be
missing. The script needs this branch merged into the hypergraph checkout it runs from.

### Tibo's Windows PC (HyperBrowser app, engine folder `%APPDATA%\HyperBrowser\engine`)

```powershell
cd E:\Code\P2P\hypergraph
node research\holders\export.js "$env:APPDATA\HyperBrowser\engine" --out E:\Code\P2P\.tmp\025\pc.json
```

### The other device (no hypergraph checkout needed there)

Quit HyperBrowser on it, copy its `index` folder (Windows: `%APPDATA%\HyperBrowser\engine\index`; Linux:
`~/.config/HyperBrowser/engine/index`; macOS: `~/Library/Application Support/HyperBrowser/engine/index`) to the PC as
`E:\Code\P2P\.tmp\025\other\index`, then on the PC:

```powershell
cd E:\Code\P2P\hypergraph
node research\holders\export.js E:\Code\P2P\.tmp\025\other --out E:\Code\P2P\.tmp\025\other.json
```

### The Ubuntu VPS helper (service `hyperbrowser-helper`, user `hyperbrowser`, code in `/opt/hyperbrowser`)

Pulling hypergraph changes the helper's code at its next restart: do it when you update the helper anyway.

```bash
cd /opt/hyperbrowser/hypergraph && sudo -u hyperbrowser git pull
sudo -u hyperbrowser node /opt/hyperbrowser/hypergraph/research/holders/export.js /var/lib/hyperbrowser/.local/share/hyperbrowser-helper --out /tmp/vps.json
```

If the read-only open fails (an error naming LOCK or IO), stop the helper for the export:

```bash
sudo systemctl stop hyperbrowser-helper
sudo -u hyperbrowser node /opt/hyperbrowser/hypergraph/research/holders/export.js /var/lib/hyperbrowser/.local/share/hyperbrowser-helper --out /tmp/vps.json
sudo systemctl start hyperbrowser-helper
```

Then from the PC (PowerShell): `scp <you>@<vps>:/tmp/vps.json E:\Code\P2P\.tmp\025\vps.json`.
