import { encode } from "@toon-format/toon";
import { DEFAULT_INTERVAL_S, MIN_INTERVAL_S, configPath, loadConfig, writeDefaultConfig } from "./config.js";
import { detectColorDepth, renderPanel } from "./render.js";
import { closeConnections, sampleHost } from "./ssh.js";
import { THRESHOLDS, verdict } from "./verdict.js";

const HELP = `usage: resource-monitor-axi [--watch] [flags]
description: Spare-capacity snapshot of the ssh hosts in the config file (Mac and Linux, agentless)
commands[2]:
  (none)=snapshot, init
output:
  Default TOON snapshot, one row per host with a spare-capacity verdict (free, busy, saturated). --json prints the same data as JSON. --watch draws the live card panel (q quits).
  A host that cannot be reached becomes a stale row and never stops the others.
config:
  ${configPath()}
  {"hosts":["build-box.local",{"host":"mini","label":"Mac mini"}],"interval":15}
  Hosts are ~/.ssh/config aliases. interval is seconds between samples per host (default ${DEFAULT_INTERVAL_S}, minimum ${MIN_INTERVAL_S}); resource-monitor-axi init writes a starter file.
flags[6]:
  --watch, --once, --json, --interval <seconds>, --theme <light|dark>, --help
notes:
  Samples ride one reused ssh connection per host and run stock tools. Nothing is installed on or left running on a host.
  --watch with --once prints a single panel frame and exits. RESOURCE_MONITOR_AXI_SSH_CONFIG=<file> points ssh at another config file.
examples:
  resource-monitor-axi
  resource-monitor-axi --json
  resource-monitor-axi --watch
  resource-monitor-axi --watch --interval 30`;

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--watch", "--once", "--json", "--help", "-h"].includes(arg)) flags[arg.replace(/^-+/, "")] = true;
    else if (arg === "--interval" || arg === "--theme" || arg === "--config") {
      flags[arg.slice(2)] = argv[++i];
      if (flags[arg.slice(2)] === undefined) throw new Error(`${arg} needs a value`);
    } else if (arg.startsWith("-")) throw new Error(`unknown flag ${arg}`);
    else flags._.push(arg);
  }
  return flags;
}

function parseInterval(value, fallback) {
  if (value === undefined) return fallback;
  const m = /^(\d+(?:\.\d+)?)(s|m)?$/.exec(String(value));
  if (!m) throw new Error(`--interval wants seconds like 15 or 30s, got ${value}`);
  const seconds = Number(m[1]) * (m[2] === "m" ? 60 : 1);
  if (seconds < MIN_INTERVAL_S) throw new Error(`--interval must be at least ${MIN_INTERVAL_S}s so hosts stay quiet`);
  return seconds;
}

const initialState = ({ host, label }) => ({ host, label });

/** CPU is smoothed over the last few readings: one 1s window swings 20% to 90% on this kind of work. */
const CPU_WINDOW = 3;

/** One sample attempt; failure keeps the previous reading as the stale body. */
export async function refresh(state, sample = sampleHost) {
  try {
    const next = await sample(state.host);
    if (next.cpuPct !== undefined) {
      state.cpuHistory = [...(state.cpuHistory ?? []), next.cpuPct].slice(-CPU_WINDOW);
      next.cpuNowPct = next.cpuPct;
      next.cpuPct = Math.round(state.cpuHistory.reduce((a, b) => a + b, 0) / state.cpuHistory.length);
    }
    state.sample = next;
    state.sampledAt = Date.now();
    delete state.error;
  } catch (error) {
    state.error = error.message;
    state.failedAt = Date.now();
  }
}

export function snapshotData(states, now = Date.now()) {
  const hosts = states.map((st) => {
    const row = { host: st.label, status: st.error ? "unreachable" : st.sample ? "ok" : "waiting" };
    if (st.sample && !st.error) {
      const v = verdict(st.sample);
      const s = st.sample;
      Object.assign(row, {
        verdict: v.label,
        cpuPct: s.cpuPct ?? null,
        memPct: s.memPct ?? null,
        memPressure: s.memPressure ?? null,
        gpuPct: s.gpuPct ?? null,
        load1: s.load1 ?? null,
        load5: s.load5 ?? null,
        cores: s.cores ?? null,
        diskFreeGB: s.diskFreeGB ?? null,
        sims: s.sims ?? null,
        xcodebuild: s.xcodebuild ?? null,
        reason: v.reasons.join("; ") || (v.simsFree === undefined ? "spare capacity" : `room for ${v.simsFree} more sims`),
      });
    } else {
      Object.assign(row, { verdict: null, error: st.error ?? null });
      if (st.sampledAt) row.lastReadingAgeS = Math.round((now - st.sampledAt) / 1000);
    }
    return row;
  });
  return hosts;
}

function snapshotOutput(states, json) {
  const hosts = snapshotData(states);
  const down = hosts.filter((h) => h.status !== "ok");
  if (json) {
    return JSON.stringify({ generatedAt: new Date().toISOString(), simCeiling: THRESHOLDS.simCeiling, hosts }, null, 2);
  }
  const ok = hosts.filter((h) => h.status === "ok");
  const doc = {
    generatedAt: new Date().toISOString(),
    hosts: ok.map(({ status, error, lastReadingAgeS, ...rest }) => rest),
  };
  if (down.length) doc.unreachable = down.map((h) => ({ host: h.host, error: h.error }));
  doc.help = [
    `simulator ceiling is ${THRESHOLDS.simCeiling} booted simulators; verdict thresholds live in the README`,
    "Run `resource-monitor-axi --watch` for the live card panel",
  ];
  return encode(doc);
}

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l";
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l";
const CLEAR = "\x1b[H\x1b[2J";

async function watch(states, { intervalS, theme, depth }) {
  const out = process.stdout;
  let quit = false;
  let wake;
  const frame = () =>
    renderPanel(states, {
      columns: out.columns || 80,
      rows: out.rows,
      intervalS,
      now: Date.now(),
      depth,
      theme,
    });
  const draw = () => out.write(`${CLEAR}${frame()}`);
  const stop = () => {
    quit = true;
    wake?.();
  };

  out.write(ENTER_SCREEN);
  out.on("resize", draw);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk) => {
      const text = chunk.toString();
      if (/[qQ\x03\x04]/.test(text)) stop();
    });
  }
  draw();

  // Each host owns its cadence: sample, repaint, then wait out the rest of the
  // interval, so a slow host never delays the others and none is polled early.
  const loops = states.map(async (state) => {
    while (!quit) {
      const started = Date.now();
      await refresh(state);
      if (quit) break;
      draw();
      const wait = Math.max(0, intervalS * 1000 - (Date.now() - started));
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, wait);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  });
  // Keep the "stale 42s" ages moving between samples.
  const clock = setInterval(draw, 1000);
  await Promise.race([Promise.all(loops), new Promise((resolve) => (wake = resolve))]);
  quit = true;
  clearInterval(clock);
  out.write(LEAVE_SCREEN);
  out.off("resize", draw);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

export async function main(argv) {
  const flags = parseArgs(argv);
  if (flags.help) return console.log(HELP);
  if (flags._[0] === "init") {
    const path = configPath();
    return console.log(writeDefaultConfig(path) ? `wrote ${path}` : `${path} already exists`);
  }
  if (flags._.length) throw new Error(`unknown command ${flags._[0]}`);

  const config = loadConfig(flags.config);
  const intervalS = parseInterval(flags.interval, config.intervalS);
  const theme = flags.theme === "light" ? "light" : "dark";
  const states = config.hosts.map(initialState);
  const hostNames = config.hosts.map((h) => h.host);

  try {
    if (flags.watch && !flags.once) {
      await watch(states, { intervalS, theme, depth: detectColorDepth(process.env, process.stdout.isTTY) });
      return;
    }
    await Promise.all(states.map((st) => refresh(st)));
    if (flags.watch) {
      const depth = detectColorDepth(process.env, process.stdout.isTTY);
      console.log(renderPanel(states, { columns: process.stdout.columns || 100, rows: undefined, intervalS, depth, theme }));
    } else {
      console.log(snapshotOutput(states, flags.json));
    }
  } finally {
    // A one-shot or quit panel should not leave ssh masters behind.
    await closeConnections(hostNames);
  }
}
