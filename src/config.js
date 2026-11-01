import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_HOSTS = ["build-box.local"];
export const DEFAULT_INTERVAL_S = 15;
/** A sample is a few commands over ssh; never poll a host faster than this. */
export const MIN_INTERVAL_S = 5;
export const DEFAULT_SIM_CEILING = 2;

export function configPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return env.RESOURCE_MONITOR_AXI_CONFIG || join(base, "resource-monitor-axi", "config.json");
}

/**
 * Hosts are ~/.ssh/config aliases. Each entry is a string or `{host, label, simCeiling}`;
 * `label` only changes the card title; `simCeiling` is the simulator ceiling (default 2).
 * `interval` is seconds between samples. A missing file means the default list.
 */
export function loadConfig(path = configPath()) {
  if (!existsSync(path)) {
    return {
      hosts: DEFAULT_HOSTS.map((host) => ({ host, label: host, simCeiling: DEFAULT_SIM_CEILING })),
      intervalS: DEFAULT_INTERVAL_S,
    };
  }
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`);
  }
  if (!Array.isArray(json.hosts) || json.hosts.length === 0) {
    throw new Error(`${path} needs a non-empty "hosts" array`);
  }
  const hosts = json.hosts.map((entry) => {
    const host = typeof entry === "string" ? entry : entry?.host;
    if (typeof host !== "string" || host === "") {
      throw new Error(`${path}: every host needs an ssh alias`);
    }
    const label = (typeof entry === "object" && entry.label) || host;
    const rawCeiling = typeof entry === "object" ? (entry.simCeiling ?? entry.simsCeiling) : undefined;
    const simCeiling = rawCeiling ?? DEFAULT_SIM_CEILING;
    if (typeof simCeiling !== "number" || !Number.isInteger(simCeiling) || simCeiling < 1) {
      throw new Error(`${path}: "simCeiling" for ${host} must be a positive integer`);
    }
    return { host, label, simCeiling };
  });
  const interval = json.interval ?? DEFAULT_INTERVAL_S;
  if (typeof interval !== "number" || interval < MIN_INTERVAL_S) {
    throw new Error(`${path}: "interval" must be a number of seconds, at least ${MIN_INTERVAL_S}`);
  }
  return { hosts, intervalS: interval };
}

export function writeDefaultConfig(path = configPath()) {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ hosts: DEFAULT_HOSTS, interval: DEFAULT_INTERVAL_S }, null, 2)}\n`);
  return true;
}
