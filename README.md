# resource-monitor-axi

An agent-first CLI, following [AXI](https://axi.md/), that reports how hard remote
machines are working and whether they have spare capacity. Its `--tui` is a narrow
live panel for people, built to run in a second terminal, stacked above or below [quota-axi](https://github.com/kunchenguid/quota-axi), and
borrows its look: rounded text boxes, muted labels, a dim status header.

```
  resource-monitor-axi · 10:09 · 2 live

● build-box · M5 Mac
╭─ cpu ─────────────────────────────────── 16% ─╮
│    ▃▇▅▃████▃▁▂▂▆▃███   ▁       ██▂    ███     │
│   ▁█████████████████▅▄▄█▆▅▅  ▁ ███▆▃  ███▇▄   │
│ ▃▄█████████████████████████▅▇█▇█████▇▆█████▃▄ │
╰─ 1h ────────────────────────────── peak 100% ─╯
╭─ memory ───────────────────────── 33% normal ─╮
│                                               │
│           ▂▁▁▁▂▂▂▁▁▁▁▁▁▁▂▂▂▁▂▁▁ ▁▁▁▁   ▁▁▁ ▁  │
│ ▆▆▆▇▇▇▇▇▇████████████████████████████████████ │
╰─ 1h ─────────────────────────────── peak 41% ─╯
● busy  1 sim · 1 xcodebuild
load 5.4x  sims 1/2  xcodebuild 1
```

Each host states a plain verdict on how loaded it is: `free`, `busy` or `saturated`,
from its CPU and GPU. Whether another simulator fits is a separate number: `simsFree`
in the snapshot, `sims 1/2` in the panel.

## Use

```sh
pnpm install
pnpm add -g .               # puts resource-monitor-axi on PATH (or run bin/resource-monitor-axi.js)

resource-monitor-axi                       # TOON snapshot, one row per host (agent mode)
resource-monitor-axi --fields host,cpuPct  # choose the columns (--full for all)
resource-monitor-axi --json                # every field as JSON
resource-monitor-axi --tui                 # live charts, for people
resource-monitor-axi --tui --view cards    # start on the summary cards
resource-monitor-axi --tui --once          # print one frame and exit
resource-monitor-axi init                  # write a starter config
resource-monitor-axi update                # upgrade from npm (--check only reports)
```

The snapshot reports this machine apart under `local`, with the same fields as a host row.
`count`, a `summary` such as `0 free, 1 busy, 0 saturated, 0 unreachable` and the total
`simsFree` cover the remote hosts only, because they answer how much room the servers have.
With no remote hosts they are zero, `hosts: []` says so, and `help` says what to add. Rows default to `host,verdict,simsFree,reason`.
Unreachable hosts are listed apart with their reason and never stop the others. Errors
are structured, on stdout: exit 1 for a failure, exit 2 for a bad command or flag. Nothing
ever prompts, and `--tui` without a terminal fails instead of hanging.

Flags for `--tui`: `--view charts|cards`, `--interval <seconds>`, `--theme light|dark`,
`--once`. They fail without `--tui`. `--config <file>` works everywhere. `NO_COLOR`,
`TERM=dumb` and piped output turn colour off, leaving the plain glyph skeleton.
`RESOURCE_MONITOR_AXI_SSH_CONFIG=<file>` points ssh at another config file.

The panel shows this key along its bottom, including what `w` and `i` change to next.
They last until you quit; to change what it opens with, use the config.

| Key | Does |
| --- | --- |
| `v` | switch between this machine and the servers |
| `c` | switch between charts and cards |
| `w` | cycle the chart window: 15m, 1h, 6h, 24h |
| `i` | cycle the sample interval: 3, 5, 15, 30, 60 s |
| `j` `k`, arrows | scroll a line |
| space, page keys | scroll a page |
| `g` `G`, home, end | top and bottom |
| `q` | quit |

### Config

`~/.config/resource-monitor-axi/config.yaml` (or `$XDG_CONFIG_HOME`, or
`RESOURCE_MONITOR_AXI_CONFIG`). Without a file no remote hosts are configured and it monitors the local machine only.
`resource-monitor-axi init` writes a starter file, and
[`config.example.yaml`](config.example.yaml) shows every setting. The file is read at
start, so restart the panel after editing it.

```yaml
hosts:
  - my-mac
  - host: build-box
    label: Build box
    simCeiling: 4
  - linux-server

local:
  label: laptop
  simCeiling: 2

interval: 15
window: 1h
```

This machine is monitored too, without ssh. `local` sets its label and simulator ceiling,
and `local: false` stops sampling it. `hosts` may be left out or empty to watch only this
machine.

Hosts are `~/.ssh/config` aliases, so keys, users, jump hosts and ports are
whatever ssh already knows. Each entry is an alias string or `{host, label, simCeiling}`;
`label` changes the title and `simCeiling` sets the simulator ceiling for that
host (default 2). `interval` is the seconds between samples of each host: default 15,
minimum 3. `window` is the chart span the panel opens on: `15m`, `1h` (default), `6h`
or `24h`. Hosts are sampled independently, a host is never polled before its interval
has passed, and a slow host does not delay the others.

### This machine and the servers

The panel samples this machine and every server all the time, so `v` switches between them
at once with their charts already drawn. It opens on the servers, or on this machine when
none are configured, and `v` then has nothing to switch to and leaves the key. The
header reports total live and stale machines across the monitored fleet. This machine reads the same `sh` script as a host, piped
to `sh -s` with no ssh, and keeps its history in `_local.jsonl`.

### History

`--tui` keeps 24 hours of readings per host in one small file under
`~/.local/state/resource-monitor-axi/` (or `$XDG_STATE_HOME`), about 1 MB at the
default interval, so charts come back at once after a restart. Time the panel was
off stays visibly empty and is named on the box's bottom edge. Nothing is written
to the hosts, and the agent snapshot neither reads nor writes these files.

## What it measures

One POSIX `sh` script is piped to `sh -s` over ssh. Nothing is installed on the
host, no daemon runs there, and nothing needs sudo. ssh connections are reused
through a `ControlMaster` socket per host and per run in `/tmp/resource-monitor-axi-<uid>`,
so one run exiting cannot disturb another, and each run closes its own when it ends. A
connection that drops without a reason gets one fresh try before a host reads as away. A sample takes about
1.3 s of wall time, almost all of it the one second CPU window, and is a handful
of cheap read-only commands.

| Metric | macOS | Linux |
| --- | --- | --- |
| cpu | `iostat -c 2 -w 1` (second line, whole numbers) | two `/proc/stat` reads one second apart |
| memory | `memory_pressure` free %, `kern.memorystatus_vm_pressure_level` | `MemAvailable`, `/proc/pressure/memory` when present |
| load | `vm.loadavg` | `/proc/loadavg` |
| disk | `df` on the Data volume | `df /` |
| gpu | `ioreg` IOAccelerator `Device Utilization %` (Apple GPU, no sudo) | `nvidia-smi` when present |
| simulators | count of `launchd_sim` processes (one per booted simulator) | not shown |
| xcodebuild | count of `xcodebuild` processes | not shown |

A metric a host cannot read is left out of its section; it is never shown as zero.
The CPU number and verdict use the average of the last three readings (45 s at the
default interval), because a single one second window swings between 20 % and 90 %
on this kind of work. The chart draws the raw readings. The first reading, and
one-shot snapshots, are instantaneous.

## Verdict thresholds

The verdict answers one question: how loaded is this machine? The worse of two signals
wins, with CPU the one that matters for most work. Thresholds live in `src/verdict.js`.

| Signal | busy | saturated |
| --- | --- | --- |
| cpu (3 reading average) | 40 % | 85 % |
| gpu | 50 % | 90 % |

Everything else is reported but leaves the verdict alone. Simulators are a count: check
`simsFree` to decide whether another one fits, against a ceiling of 2 per host by default
(`simCeiling`). Memory, disk, load average and `xcodebuild` are shown as their own numbers,
and the memory and disk numbers change colour at their own cut points, also in
`src/verdict.js`.

## License

MIT
