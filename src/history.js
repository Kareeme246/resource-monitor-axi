/**
 * A small local history per host, so a restarted panel opens with its charts
 * already drawn. One JSON line per sample attempt, on this machine only:
 * `{"t":ms,"cpu":16,"mem":33,"gpu":20,"disk":49}`, or `{"t":ms,"down":1}` for a
 * failed attempt. Nothing here ever fails the panel: a history that cannot be
 * read or written just means emptier charts.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HISTORY_MS = 24 * 3600 * 1000;
/** Files and memory are trimmed once this much has expired, not on every sample. */
const TRIM_SLACK_MS = 3600 * 1000;

export function historyDir(env = process.env) {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "resource-monitor-axi");
}

export function historyPath(host, env = process.env) {
  return join(historyDir(env), `${encodeURIComponent(host)}.jsonl`);
}

/** The chart values of one sample. CPU is the raw reading, not the smoothed title number. */
export function recordOf(sample, t) {
  const rec = { t };
  const cpu = sample.cpuNowPct ?? sample.cpuPct;
  if (cpu !== undefined) rec.cpu = cpu;
  if (sample.memPct !== undefined) rec.mem = sample.memPct;
  if (sample.gpuPct !== undefined) rec.gpu = sample.gpuPct;
  if (sample.diskPct !== undefined) rec.disk = sample.diskPct;
  return rec;
}

function writeAll(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
  renameSync(tmp, path);
}

/** Read one host's records, oldest first, and rewrite the file if any have expired. */
export function loadHistory(path, now = Date.now()) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const cutoff = now - HISTORY_MS;
  const records = [];
  let dropped = false;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      dropped = true;
      continue;
    }
    if (typeof rec?.t !== "number" || rec.t < cutoff) dropped = true;
    else records.push(rec);
  }
  records.sort((a, b) => a.t - b.t);
  if (dropped) {
    try {
      writeAll(path, records);
    } catch {}
  }
  return records;
}

/** Add one record to memory and disk, trimming both once enough has expired. */
export function addRecord(state, rec) {
  const points = (state.points ??= []);
  points.push(rec);
  const expired = points[0].t < rec.t - HISTORY_MS - TRIM_SLACK_MS;
  if (expired) {
    const cutoff = rec.t - HISTORY_MS;
    state.points = points.filter((p) => p.t >= cutoff);
  }
  if (!state.historyPath) return;
  try {
    if (expired) writeAll(state.historyPath, state.points);
    else {
      mkdirSync(dirname(state.historyPath), { recursive: true });
      appendFileSync(state.historyPath, `${JSON.stringify(rec)}\n`);
    }
  } catch {}
}
