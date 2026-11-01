import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";

export const DEFAULT_HOSTS = [];
export const DEFAULT_INTERVAL_S = 15;
/** A sample is a few commands over ssh; never poll a host faster than this. */
export const MIN_INTERVAL_S = 3;
/** The chart spans `w` cycles through, in seconds, and the labels they go by. */
export const WINDOWS = [
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
  { label: "6h", seconds: 21600 },
  { label: "24h", seconds: 86400 },
];
export const DEFAULT_WINDOW = "1h";
/** The sample intervals `i` cycles through, in seconds. */
export const INTERVALS = [3, 5, 15, 30, 60];
export const DEFAULT_SIM_CEILING = 2;

export function configPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return env.RESOURCE_MONITOR_AXI_CONFIG || join(base, "resource-monitor-axi", "config.yaml");
}

export function legacyConfigPath(path = configPath()) {
  return path.replace(/\.ya?ml$/, ".json");
}

/** This machine's own entry: on unless `local` is false, with an optional label and ceiling. */
function localEntry(raw, path) {
  if (raw === false) return null;
  if (raw !== undefined && raw !== true && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    throw new Error(`${path}: "local" must be false or {label, simCeiling}`);
  }
  const entry = raw === true || raw === undefined ? {} : raw;
  const simCeiling = entry.simCeiling ?? DEFAULT_SIM_CEILING;
  if (!Number.isInteger(simCeiling) || simCeiling < 1) {
    throw new Error(`${path}: "simCeiling" for local must be a positive integer`);
  }
  return { name: entry.label || hostname().replace(/\.local$/, ""), simCeiling };
}

/**
 * Hosts are ~/.ssh/config aliases. Each entry is a string or `{host, label, simCeiling}`;
 * `label` only changes the card title; `simCeiling` is the simulator ceiling (default 2).
 * `hosts` may be left out or empty when only this machine matters, and `local`
 * configures this machine, which is sampled without ssh.
 * `interval` is seconds between samples and `window` the chart span that opens
 * first (15m, 1h, 6h or 24h). Without a config file, defaults to local machine only.
 */
export function loadConfig(path = configPath()) {
  let effectivePath = path;
  if (!existsSync(effectivePath)) {
    const legacy = legacyConfigPath(effectivePath);
    if (legacy !== effectivePath && existsSync(legacy)) {
      process.stderr.write(`note: ${legacy} found; move to ${effectivePath}\n`);
      effectivePath = legacy;
    }
  }
  if (!existsSync(effectivePath)) {
    return {
      hosts: DEFAULT_HOSTS.map((host) => ({ host, label: host, simCeiling: DEFAULT_SIM_CEILING })),
      intervalS: DEFAULT_INTERVAL_S,
      window: DEFAULT_WINDOW,
      local: localEntry(undefined, effectivePath),
    };
  }
  let parsed;
  try {
    parsed = YAML.parse(readFileSync(effectivePath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${effectivePath}: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object") parsed = {};
  const rawHosts = parsed.hosts ?? [];
  if (!Array.isArray(rawHosts)) throw new Error(`${effectivePath}: "hosts" must be an array`);
  const local = localEntry(parsed.local, effectivePath);
  if (rawHosts.length === 0 && !local) throw new Error(`${effectivePath} has nothing to monitor: add "hosts" or remove "local": false`);
  const hosts = rawHosts.map((entry) => {
    const host = typeof entry === "string" ? entry : entry?.host;
    if (typeof host !== "string" || host === "") {
      throw new Error(`${effectivePath}: every host needs an ssh alias`);
    }
    const label = (typeof entry === "object" && entry.label) || host;
    const rawCeiling = typeof entry === "object" ? (entry.simCeiling ?? entry.simsCeiling) : undefined;
    const simCeiling = rawCeiling ?? DEFAULT_SIM_CEILING;
    if (typeof simCeiling !== "number" || !Number.isInteger(simCeiling) || simCeiling < 1) {
      throw new Error(`${effectivePath}: "simCeiling" for ${host} must be a positive integer`);
    }
    return { host, label, simCeiling };
  });
  const interval = parsed.interval ?? DEFAULT_INTERVAL_S;
  if (typeof interval !== "number" || interval < MIN_INTERVAL_S) {
    throw new Error(`${effectivePath}: "interval" must be a number of seconds, at least ${MIN_INTERVAL_S}`);
  }
  const window = parsed.window ?? DEFAULT_WINDOW;
  if (!WINDOWS.some((w) => w.label === window)) {
    throw new Error(`${effectivePath}: "window" must be one of ${WINDOWS.map((w) => w.label).join(", ")}`);
  }
  return { hosts, intervalS: interval, window, local };
}

export const DEFAULT_CONFIG_YAML = `# SSH host aliases to monitor. Add remote hosts here:
# hosts:
#   - build-box
#   - host: mini
#     label: Mac mini
#     simCeiling: 4
hosts: []

# Sample interval in seconds (default 15, minimum 3)
interval: 15

# Initial chart window: 15m, 1h, 6h, or 24h (default 1h)
window: 1h

# This machine (sampled locally without ssh). Set false to disable:
# local: false
`;

export function writeDefaultConfig(path = configPath()) {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, DEFAULT_CONFIG_YAML);
  return true;
}
