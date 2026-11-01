# resource-monitor-axi

A narrow live terminal panel that shows how hard remote machines are working and
whether they have spare capacity. It is built to run in a second terminal,
stacked above or below [quota-axi](https://github.com/kunchenguid/quota-axi), and
borrows its look: rounded text boxes, thin `━` bars with the percent on the
right, muted labels, a dim status header.

```
  resource-monitor-axi · 00:58 · 15s · 0 free · 1 busy · 0 saturated · 0 stale

╭─ ● build-box.local ──────────────────── M5 Mac ─╮
│                                               │
│   cpu     ━━━━━━━━━━━━━━──────  67%           │
│   memory  ━━━━────────────────  19% normal    │
│   gpu     ────────────────────   0%           │
│   disk    ━━━━━━━━━───────────  45% 254G free │
│   load 5m ━━━━━━━━━━━━━━━━━━━━ 2.7x 27/10c    │
│   sims    ━━━━━━━━━━──────────  1/2           │
│   xcode   1 xcodebuild                        │
│                                               │
│   ● busy  1 sim · 1 xcodebuild · cpu 67%      │
│                                               │
╰───────────────────────────────────────────────╯
```

Each card ends with a plain verdict: `free`, `busy` or `saturated`. On a Mac the
free verdict also says how many more simulators fit ("room for 2 more sims").

## Use

```sh
pnpm install
pnpm link --global          # puts resource-monitor-axi on PATH (or run bin/resource-monitor-axi.js)

resource-monitor-axi                 # TOON snapshot, one row per host (agent mode)
resource-monitor-axi --json          # same data as JSON
resource-monitor-axi --watch         # live card panel, q quits
resource-monitor-axi --watch --once  # print one panel frame and exit
resource-monitor-axi init            # write a starter config
```

Flags: `--interval <seconds>`, `--theme light|dark`, `--config <file>`.
`NO_COLOR`, `TERM=dumb` and piped output turn colour off, leaving the plain
glyph skeleton. `RESOURCE_MONITOR_AXI_SSH_CONFIG=<file>` points ssh at another
config file.

### Config

`~/.config/resource-monitor-axi/config.json` (or `$XDG_CONFIG_HOME`, or
`RESOURCE_MONITOR_AXI_CONFIG`). Without a file the host list is `build-box.local`.

```json
{
  "hosts": ["build-box.local", { "host": "mini", "label": "Mac mini" }],
  "interval": 15
}
```

Hosts are `~/.ssh/config` aliases, so keys, users, jump hosts and ports are
whatever ssh already knows. `interval` is the seconds between samples of each
host: default 15, minimum 5. Hosts are sampled independently, a host is never
polled before its interval has passed, and a slow host does not delay the others.

## What it measures

One POSIX `sh` script is piped to `sh -s` over ssh. Nothing is installed on the
host, no daemon runs there, and nothing needs sudo. ssh connections are reused
through a per-host `ControlMaster` socket in `/tmp/resource-monitor-axi-<uid>`,
and the masters are closed again when the panel quits. A sample takes about
1.3 s of wall time, almost all of it the one second CPU window, and is a handful
of cheap read-only commands.

| Metric | macOS | Linux |
| --- | --- | --- |
| cpu | `top -l 2 -s 1` (second sample) | two `/proc/stat` reads one second apart |
| memory | `memory_pressure` free %, `kern.memorystatus_vm_pressure_level` | `MemAvailable`, `/proc/pressure/memory` when present |
| load | `vm.loadavg` | `/proc/loadavg` |
| disk | `df` on the Data volume | `df /` |
| gpu | `ioreg` IOAccelerator `Device Utilization %` (Apple GPU, no sudo) | `nvidia-smi` when present |
| simulators | count of `launchd_sim` processes (one per booted simulator) | not shown |
| xcodebuild | count of `xcodebuild` processes | not shown |

A metric a host cannot read is left out of its card; it is never shown as zero.
CPU is averaged over the last three readings (45 s at the default interval),
because a single one second window swings between 20 % and 90 % on this kind of
work. The first reading, and one-shot snapshots, are instantaneous.

## Verdict thresholds

The worst signal wins. Thresholds live in `src/verdict.js`.

| Signal | busy | saturated |
| --- | --- | --- |
| booted simulators | 1 or more | 2 (the known ceiling on Pro 16) |
| xcodebuild | 1 or more | |
| cpu (3 reading average) | 40 % | 85 % |
| 5 minute load per core | 1.0 | 6.0 |
| memory used (100 minus free %) | 60 % | 85 % |
| memory pressure | warn | critical |
| gpu | 50 % | 90 % |
| free disk | under 30 GB | under 10 GB |

