import { readFileSync } from "node:fs";
import { AxiError, runAxiCli } from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { gapMsFor, nextInCycle, renderFrame } from "./charts.js";
import { DEFAULT_INTERVAL_S, DEFAULT_WINDOW, INTERVALS, MIN_INTERVAL_S, WINDOWS, configPath, loadConfig, writeDefaultConfig } from "./config.js";
import { LOCAL_ID, addRecord, historyPath, loadHistory, recordOf } from "./history.js";
import { detectColorDepth, formatHeaderLine, formatQueryTime } from "./render.js";
import { closeConnections, sampleHost, sampleLocal } from "./ssh.js";
import { THRESHOLDS, verdict } from "./verdict.js";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const DESCRIPTION = "Spare-capacity snapshot and live charts of the ssh hosts in the config file (Mac and Linux, agentless)";

const FIELDS = ["host", "verdict", "simsFree", "reason"];
const ALL_FIELDS = [...FIELDS.slice(0, 3), "cpuPct", "memPct", "memPressure", "gpuPct", "load1", "load5", "cores", "diskFreeGB", "sims", "simCeiling", "xcodebuild", "reason"];

const HELP = `usage: resource-monitor-axi [--tui] [flags]
description: ${DESCRIPTION}
commands[3]:
  (none)=snapshot, init, update
output:
  Default TOON snapshot, one row per host with a verdict (free, busy, saturated) from cpu and gpu load, and simsFree for how many more simulators fit. This machine is sampled without ssh and reported apart under local, with the same fields. count, summary and total simsFree cover the remote hosts only. A host that cannot be reached goes under unreachable and never stops the others.
  --fields <a,b,c> picks columns and --full shows all of them: ${ALL_FIELDS.join(",")}. --json prints every field as JSON unless --fields narrows it.
flags[11]:
  --fields <a,b,c>, --full, --json, --config <file>, --tui, --once, --view <charts|cards>, --interval <seconds>, --theme <light|dark>, --help, --version
tui:
  --tui draws the live panel for people and needs a terminal. --once prints one frame, for any output.
  Keys, also shown along its bottom: v this machine or the servers, c charts or cards, w chart window, i sample interval, r refresh, j k or arrows scroll, space or page keys scroll a page, g G top and bottom, q quit.
  It keeps 24 hours of readings per host in a small local file. --view, --interval, --theme and --once need --tui.
config:
  ${configPath()}
  hosts:
    - build-box
    - host: mini
      label: Mac mini
  local: { label: laptop, simCeiling: 2 }
  interval: 15
  window: ${DEFAULT_WINDOW}
  Hosts are ~/.ssh/config aliases, and may be left out to watch only this machine. "local: false" stops sampling this machine. interval is seconds between samples per host (default ${DEFAULT_INTERVAL_S}, minimum ${MIN_INTERVAL_S}). window is the chart span that opens first (${WINDOWS.map((w) => w.label).join(", ")}; default ${DEFAULT_WINDOW}). resource-monitor-axi init writes a starter file.
notes:
  Samples ride one reused ssh connection per host and run stock tools, and never prompt. Nothing is installed on or left running on a host. RESOURCE_MONITOR_AXI_SSH_CONFIG=<file> points ssh at another config file.
examples:
  resource-monitor-axi
  resource-monitor-axi --fields host,verdict,cpuPct,load5
  resource-monitor-axi --full
  resource-monitor-axi --tui
  resource-monitor-axi --tui --view cards --interval 30
  resource-monitor-axi update --check
`;

const INIT_HELP = `usage: resource-monitor-axi init
description: Write a starter config file. Safe to repeat: an existing file is left alone.
config: ${configPath()}
`;

const usage = (message, ...suggestions) => new AxiError(message, "VALIDATION_ERROR", suggestions.length ? suggestions : ["Run `resource-monitor-axi --help`"]);

const VALUE_FLAGS = ["--interval", "--theme", "--config", "--view", "--fields"];
const SWITCHES = ["--tui", "--once", "--json", "--full"];
/** These only mean something to the panel, so without --tui they fail loud. */
const TUI_ONLY = ["once", "view", "interval", "theme"];

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (SWITCHES.includes(arg)) flags[arg.slice(2)] = true;
    else if (VALUE_FLAGS.includes(arg)) {
      flags[arg.slice(2)] = argv[++i];
      if (flags[arg.slice(2)] === undefined) throw usage(`${arg} needs a value`);
    } else if (arg.startsWith("-")) throw usage(`unknown flag ${arg}`);
    else flags._.push(arg);
  }
  return flags;
}

function parseInterval(value, fallback) {
  if (value === undefined) return fallback;
  const m = /^(\d+(?:\.\d+)?)(s|m)?$/.exec(String(value));
  if (!m) throw usage(`--interval wants seconds like 15 or 30s, got ${value}`);
  const seconds = Number(m[1]) * (m[2] === "m" ? 60 : 1);
  if (seconds < MIN_INTERVAL_S) throw usage(`--interval must be at least ${MIN_INTERVAL_S}s so hosts stay quiet`);
  return seconds;
}

function parseTheme(value) {
  if (value === undefined || value === "dark") return "dark";
  if (value === "light") return value;
  throw usage(`--theme wants light or dark, got ${value}`);
}

function parseFields(value) {
  if (value === undefined) return undefined;
  const fields = value.split(",").filter(Boolean);
  const bad = fields.filter((f) => !ALL_FIELDS.includes(f));
  if (bad.length || !fields.length) throw usage(`--fields does not know ${bad.join(",") || "an empty list"}`, `Choose from ${ALL_FIELDS.join(",")}`);
  return fields.includes("host") ? fields : ["host", ...fields];
}

function parseView(value) {
  if (value === undefined) return "charts";
  if (value === "charts" || value === "cards") return value;
  throw usage(`--view wants charts or cards, got ${value}`);
}

const initialState = ({ host, label, simCeiling }) => ({
  host,
  label,
  simCeiling: simCeiling ?? THRESHOLDS.simCeiling,
});

/** This machine as one more host: same charts, history and verdict, sampled without ssh. */
const localState = ({ name, simCeiling }) => ({
  host: LOCAL_ID,
  local: true,
  name,
  label: `${name} (local)`,
  simCeiling,
});

/** CPU is smoothed over the last few readings: one 1s window swings 20% to 90% on this kind of work. */
const CPU_WINDOW = 3;

/** One sample attempt; failure keeps the previous reading as the stale body. */
export async function refresh(state, sample = state.local ? sampleLocal : sampleHost) {
  try {
    const run = state.sampleFn ?? sample;
    const next = await run(state.host);
    if (next.cpuPct !== undefined) {
      state.cpuHistory = [...(state.cpuHistory ?? []), next.cpuPct].slice(-CPU_WINDOW);
      next.cpuNowPct = next.cpuPct;
      next.cpuPct = Math.round(state.cpuHistory.reduce((a, b) => a + b, 0) / state.cpuHistory.length);
    }
    state.sample = next;
    state.sampledAt = Date.now();
    delete state.error;
    addRecord(state, recordOf(next, state.sampledAt));
  } catch (error) {
    state.error = error.message;
    state.failedAt = Date.now();
    addRecord(state, { t: state.failedAt, down: 1 });
  }
}

export function snapshotData(states, now = Date.now()) {
  const hosts = states.map((st) => {
    const row = { host: st.name ?? st.label, status: st.error ? "unreachable" : st.sample ? "ok" : "waiting" };
    if (st.sample && !st.error) {
      const simCeiling = st.simCeiling ?? st.sample.simCeiling ?? THRESHOLDS.simCeiling;
      const v = verdict({ ...st.sample, simCeiling });
      const s = st.sample;
      Object.assign(row, {
        verdict: v.label,
        simsFree: v.simsFree ?? null,
        cpuPct: s.cpuPct ?? null,
        memPct: s.memPct ?? null,
        memPressure: s.memPressure ?? null,
        gpuPct: s.gpuPct ?? null,
        load1: s.load1 ?? null,
        load5: s.load5 ?? null,
        cores: s.cores ?? null,
        diskFreeGB: s.diskFreeGB ?? null,
        sims: s.sims ?? null,
        simCeiling: s.sims !== undefined ? simCeiling : null,
        xcodebuild: s.xcodebuild ?? null,
        reason: v.reasons.join("; ") || "spare capacity",
      });
    } else {
      Object.assign(row, { verdict: null, error: st.error ?? null });
      if (st.sampledAt) row.lastReadingAgeS = Math.round((now - st.sampledAt) / 1000);
    }
    return row;
  });
  return hosts;
}

/** Counts an agent would otherwise have to work out from the rows. */
function aggregates(hosts) {
  const ok = hosts.filter((h) => h.status === "ok");
  const count = (name) => ok.filter((h) => h.verdict === name).length;
  const summary = `${count("free")} free, ${count("busy")} busy, ${count("saturated")} saturated, ${hosts.length - ok.length} unreachable`;
  return { count: hosts.length, summary, simsFree: ok.reduce((sum, h) => sum + (h.simsFree ?? 0), 0) };
}

const pick = (row, fields) => Object.fromEntries(fields.map((f) => [f, row[f] ?? null]));

function snapshotOutput(remotes, local, { json, full, fields }) {
  const hosts = snapshotData(remotes);
  const ok = hosts.filter((h) => h.status === "ok");
  const down = hosts.filter((h) => h.status !== "ok");
  const columns = fields ?? (full || json ? ALL_FIELDS : FIELDS);
  const localRow = local ? snapshotData([local])[0] : null;
  const localOk = localRow && localRow.status === "ok";
  const localDown = localRow && localRow.status !== "ok";
  const liveCount = (localOk ? 1 : 0) + ok.length;
  const staleCount = (localDown ? 1 : 0) + down.length;
  const generatedAt = new Date().toISOString();
  const time = formatQueryTime(generatedAt);
  const header = formatHeaderLine({ time, live: liveCount, stale: staleCount, columns: Infinity });
  const doc = { header, generatedAt };
  if (localRow) {
    doc.local = localOk ? pick(localRow, columns) : { host: localRow.host, status: localRow.status, error: localRow.error };
  }
  // The counts below are the remote hosts only; this machine speaks for itself above.
  Object.assign(doc, aggregates(hosts), { hosts: ok.map((h) => pick(h, columns)) });
  if (down.length) doc.unreachable = down.map((h) => ({ host: h.host, error: h.error, lastReadingAgeS: h.lastReadingAgeS ?? null }));
  if (json) return JSON.stringify(doc, null, 2);
  doc.help = [
    ...(hosts.length ? [] : [`No remote hosts configured; add ssh aliases to "hosts" in ${configPath()}`]),
    ...(fields || full ? [] : ["Run `resource-monitor-axi --full` for every metric, or --fields <a,b,c> to pick them"]),
    ...(down.length ? ["Run `ssh <host> true` to check an unreachable host"] : []),
    `Simulator ceiling is per host in ${configPath()} (default ${THRESHOLDS.simCeiling})`,
  ];
  return encode(doc);
}

/** Open a host's local history. Time since its last record was time the panel was off. */
export function hydrate(state, intervalS, { now = Date.now(), path = historyPath(state.host) } = {}) {
  state.historyPath = path;
  state.points = loadHistory(path, now);
  const last = state.points.at(-1);
  if (!last) return;
  if (now - last.t > gapMsFor(intervalS)) state.panelOff = { from: last.t, to: now };
  const reading = state.points.findLast((p) => !p.down);
  if (reading) state.lastReadingAt = reading.t;
}

/** A chunk of terminal input as single keys and whole escape sequences. */
const splitKeys = (text) => text.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? [];

const SCROLL_KEYS = {
  j: 1,
  "\x1b[B": 1,
  k: -1,
  "\x1b[A": -1,
  " ": "page",
  "\x1b[6~": "page",
  "\x1b[5~": "-page",
  g: "top",
  "\x1b[H": "top",
  G: "bottom",
  "\x1b[F": "bottom",
};

/** Apply one key to the view state. Returns true when it should repaint. */
export function applyKey(key, ui, { page = 10, maxScroll = 0, onRefresh = ui?.onRefresh } = {}) {
  if (key === "r") {
    onRefresh?.();
    return false;
  }
  if (key === "c") {
    ui.view = ui.view === "charts" ? "cards" : "charts";
    ui.scroll = 0;
    return true;
  }
  if (key === "v") {
    if (!ui.canToggle) return false;
    ui.scope = ui.scope === "local" ? "servers" : "local";
    ui.scroll = 0;
    return true;
  }
  if (key === "w") {
    ui.windowS = nextInCycle(WINDOWS.map((w) => w.seconds), ui.windowS);
    return true;
  }
  if (key === "i") {
    ui.intervalS = nextInCycle(INTERVALS, ui.intervalS);
    return true;
  }
  const move = SCROLL_KEYS[key];
  if (move === undefined) return false;
  const next =
    move === "page" ? ui.scroll + page : move === "-page" ? ui.scroll - page : move === "top" ? 0 : move === "bottom" ? maxScroll : ui.scroll + move;
  ui.scroll = Math.min(maxScroll, Math.max(0, next));
  return true;
}

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l";
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l";
const CLEAR = "\x1b[H\x1b[2J";

export async function panel(remotes, local, { theme, depth, ui, stdout = process.stdout, stdin = process.stdin } = {}) {
  const states = [...remotes, ...(local ? [local] : [])];
  const out = stdout;
  let last = { maxScroll: 0 };
  const frame = () =>
    renderFrame(ui.scope === "local" ? [local] : remotes, {
      allStates: states,
      toggle: ui.canToggle ? (ui.scope === "local" ? "servers" : "local") : undefined,
      view: ui.view,
      windowS: ui.windowS,
      scroll: ui.scroll,
      columns: out.columns || 80,
      rows: out.rows,
      intervalS: ui.intervalS,
      now: Date.now(),
      depth,
      theme,
      keys: true,
    });
  // Repaint in place so a once a second redraw never flickers. Each line is
  // erased before it is written: erasing after a full-width line would eat its
  // last character.
  const draw = () => {
    last = frame();
    ui.scroll = last.scroll;
    const lines = last.text.split("\n");
    const below = lines.length < (out.rows ?? Infinity) ? "\r\n\x1b[J" : "";
    out.write(`\x1b[H${lines.map((l) => `\x1b[K${l}`).join("\r\n")}${below}`);
  };
  const redraw = () => {
    out.write(CLEAR);
    draw();
  };

  let stop;
  const stopped = new Promise((resolve) => (stop = resolve));
  let quit = false;
  stopped.then(() => (quit = true));

  const triggers = [];
  const triggerRefresh = () => {
    for (const trigger of triggers) trigger();
  };
  ui.onRefresh = triggerRefresh;

  out.write(ENTER_SCREEN);
  out.on("resize", redraw);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (stdin.isTTY) {
    stdin.setRawMode?.(true);
    stdin.resume?.();
    stdin.on("data", (chunk) => {
      for (const key of splitKeys(chunk.toString())) {
        if (/^[qQ\x03\x04]$/.test(key)) return stop();
        const page = Math.max(1, (out.rows ?? 24) - 3);
        if (applyKey(key, ui, { page, maxScroll: last.maxScroll, onRefresh: triggerRefresh })) draw();
      }
    });
  }
  draw();

  // Each host owns its cadence: sample, repaint, then wait out the rest of the
  // interval, so a slow host never delays the others and none is polled early.
  for (const state of states) {
    let wake = null;
    let sampling = false;
    triggers.push(() => {
      if (!sampling && wake) wake(true);
    });
    (async () => {
      while (!quit) {
        sampling = true;
        await refresh(state);
        sampling = false;
        if (quit) break;
        draw();
        let started = Date.now();
        // Rechecked each second, so changing the interval with i applies at once.
        while (!quit && Date.now() - started < ui.intervalS * 1000) {
          const woken = await Promise.race([
            stopped,
            new Promise((resolve) => {
              wake = resolve;
            }),
            new Promise((resolve) => setTimeout(resolve, Math.min(1000, ui.intervalS * 1000 - (Date.now() - started))).unref()),
          ]);
          wake = null;
          if (woken === true) break;
        }
      }
    })();
  }
  // Keep the "stale 42s" ages and the chart's clock moving between samples.
  const clock = setInterval(draw, 1000);
  await stopped;
  clearInterval(clock);
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  out.write(LEAVE_SCREEN);
  out.off("resize", redraw);
  if (stdin.isTTY) {
    stdin.setRawMode?.(false);
    stdin.pause?.();
  }
}

/** Take one snapshot, or draw the panel when --tui asks for it. */
async function run(argv) {
  const flags = parseArgs(argv);
  if (flags._.length) throw usage(`unknown command ${flags._[0]}`);
  if (!flags.tui) {
    const stray = TUI_ONLY.find((name) => flags[name] !== undefined);
    if (stray) throw usage(`--${stray} needs --tui`, `Run \`resource-monitor-axi --tui --${stray}${stray === "once" ? "" : " <value>"}\``);
  } else {
    for (const name of ["json", "full", "fields"]) if (flags[name] !== undefined) throw usage(`--${name} is for the snapshot, not --tui`);
    if (!flags.once && !(process.stdout.isTTY && process.stdin.isTTY)) {
      throw usage("--tui needs a terminal", "Run `resource-monitor-axi` for a snapshot, or `resource-monitor-axi --tui --once` for one frame");
    }
  }
  const fields = parseFields(flags.fields);
  const theme = parseTheme(flags.theme);
  const view = parseView(flags.view);

  const config = loadConfig(flags.config);
  const intervalS = parseInterval(flags.interval, config.intervalS);
  const windowS = WINDOWS.find((w) => w.label === config.window).seconds;
  const remotes = config.hosts.map(initialState);
  const local = config.local ? localState(config.local) : null;
  const states = [...remotes, ...(local ? [local] : [])];
  const hostNames = config.hosts.map((h) => h.host);
  if (flags.tui) for (const state of states) hydrate(state, intervalS);

  // The panel opens on the servers, or on this machine when there are none.
  const scope = remotes.length ? "servers" : "local";
  try {
    if (flags.tui && !flags.once) {
      const ui = { view, windowS, intervalS, scroll: 0, scope, canToggle: Boolean(local && remotes.length) };
      await panel(remotes, local, { theme, depth: detectColorDepth(process.env, process.stdout.isTTY), ui });
      return "";
    }
    await Promise.all(states.map((st) => refresh(st)));
    if (flags.tui) {
      const depth = detectColorDepth(process.env, process.stdout.isTTY);
      return renderFrame(scope === "local" ? [local] : remotes, { allStates: states, view, windowS, columns: process.stdout.columns || 100, intervalS, depth, theme }).text;
    }
    return snapshotOutput(remotes, local, { json: flags.json, full: flags.full, fields });
  } finally {
    // A one-shot or quit panel should not leave ssh masters behind.
    await closeConnections(hostNames);
    // A sample still in flight at quit has nothing left to report to.
    if (flags.tui && !flags.once) process.exit(0);
  }
}

function init(argv) {
  if (argv.length) throw usage(`init takes no arguments, got ${argv[0]}`, "Set RESOURCE_MONITOR_AXI_CONFIG to choose another path");
  const path = configPath();
  const created = writeDefaultConfig(path);
  return { config: path, status: created ? "created" : "already exists", help: [`Edit ${path} to list your ssh aliases`, "Run `resource-monitor-axi` for a snapshot"] };
}

/**
 * Bare flags mean the snapshot or panel, so route them onto a command name for
 * runAxiCli, which owns help, version, the built-in `update` and error framing.
 */
export function normalizeArgv(raw) {
  // No arguments at all is the home view: live data under the SDK's bin and description.
  if (raw.length === 0) return [];
  for (let i = 0; i < raw.length; i++) {
    if (VALUE_FLAGS.includes(raw[i])) i++;
    else if (!raw[i].startsWith("-")) return [raw[i], ...raw.slice(0, i), ...raw.slice(i + 1)];
  }
  if (raw.includes("--help") || raw.includes("-h")) return ["--help"];
  const version = raw.find((arg) => arg === "--version" || arg === "-v" || arg === "-V");
  if (version) return [version];
  return ["run", ...raw];
}

export async function main(argv) {
  await runAxiCli({
    argv: normalizeArgv(argv),
    description: DESCRIPTION,
    version: PACKAGE.version,
    packageName: PACKAGE.name,
    topLevelHelp: HELP,
    commands: { run, init },
    home: run,
    getCommandHelp: (command) => (command === "init" ? INIT_HELP : HELP),
  });
}
