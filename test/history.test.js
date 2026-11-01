import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyKey, hydrate, normalizeArgv, refresh } from "../src/cli.js";
import { HISTORY_MS, addRecord, historyPath, loadHistory, recordOf } from "../src/history.js";
import { REMOTE_SCRIPT } from "../src/remote-script.js";

const NOW = 1_800_000_000_000;
const inTemp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "rma-history-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("history lives in the state directory, one safely named file per host", () => {
  const path = historyPath("user@host/x", { XDG_STATE_HOME: "/s" });
  assert.equal(path, "/s/resource-monitor-axi/user%40host%2Fx.jsonl");
});

test("a chart record keeps the raw cpu reading, not the smoothed number", () => {
  assert.deepEqual(recordOf({ cpuPct: 60, cpuNowPct: 10, memPct: 3, diskPct: 4 }, 5), { t: 5, cpu: 10, mem: 3, disk: 4 });
});

test("loading trims to 24 hours on disk and survives damaged lines", () => {
  inTemp((dir) => {
    const path = join(dir, "h.jsonl");
    writeFileSync(path, `${JSON.stringify({ t: NOW - HISTORY_MS - 1, cpu: 1 })}\nnot json\n${JSON.stringify({ t: NOW - 5, cpu: 2 })}\n`);
    assert.deepEqual(loadHistory(path, NOW), [{ t: NOW - 5, cpu: 2 }]);
    assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({ t: NOW - 5, cpu: 2 })}\n`);
  });
  assert.deepEqual(loadHistory("/nonexistent/h.jsonl", NOW), []);
});

test("a long-running panel trims memory and disk too", () => {
  inTemp((dir) => {
    const state = { historyPath: join(dir, "a", "h.jsonl"), points: [{ t: NOW - HISTORY_MS - 2 * 3600_000, cpu: 1 }] };
    addRecord(state, { t: NOW, cpu: 2 });
    assert.deepEqual(state.points, [{ t: NOW, cpu: 2 }]);
    assert.equal(readFileSync(state.historyPath, "utf8"), `${JSON.stringify({ t: NOW, cpu: 2 })}\n`);
  });
});

test("an unwritable history never stops the panel", () => {
  const state = { historyPath: "/dev/null/nope/h.jsonl" };
  addRecord(state, { t: NOW, cpu: 2 });
  assert.equal(state.points.length, 1);
});

test("samples and failures both land in history, and a restart reads them back", async () => {
  await inTemp2(async (dir) => {
    const path = join(dir, "h.jsonl");
    const state = { host: "h", historyPath: path };
    await refresh(state, async () => ({ cpuPct: 40, memPct: 5 }));
    await refresh(state, async () => {
      throw new Error("connection refused");
    });
    const reread = { host: "h" };
    const later = Date.now() + 600_000;
    hydrate(reread, 15, { now: later, path });
    assert.equal(reread.points.length, 2);
    assert.equal(reread.points[1].down, 1);
    assert.equal(reread.lastReadingAt, reread.points[0].t);
    assert.equal(reread.panelOff.to, later);
    const soon = { host: "h" };
    hydrate(soon, 15, { now: reread.points[1].t + 5000, path });
    assert.equal(soon.panelOff, undefined);
  });
});

async function inTemp2(fn) {
  const dir = mkdtempSync(join(tmpdir(), "rma-history-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("c switches views, v switches between this machine and the servers, w cycles windows, and scrolling stays in range", () => {
  const ui = { view: "charts", windowS: 3600, scroll: 4, scope: "servers", canToggle: true };
  applyKey("c", ui);
  assert.deepEqual([ui.view, ui.scroll], ["cards", 0]);
  applyKey("c", ui);
  assert.equal(ui.view, "charts");
  ui.scroll = 4;
  assert.equal(applyKey("v", ui), true);
  assert.deepEqual([ui.scope, ui.view, ui.scroll], ["local", "charts", 0]);
  applyKey("v", ui);
  assert.equal(ui.scope, "servers");
  ui.canToggle = false;
  assert.equal(applyKey("v", ui), false, "nothing to switch to");
  assert.equal(ui.scope, "servers");
  const seen = [];
  for (let i = 0; i < 4; i++) {
    applyKey("w", ui);
    seen.push(ui.windowS);
  }
  assert.deepEqual(seen, [21600, 86400, 900, 3600]);
  ui.intervalS = 15;
  applyKey("i", ui);
  assert.equal(ui.intervalS, 30);
  applyKey("i", ui);
  applyKey("i", ui);
  assert.equal(ui.intervalS, 3, "wraps to the floor");
  const range = { page: 10, maxScroll: 15 };
  applyKey("k", ui, range);
  assert.equal(ui.scroll, 0);
  applyKey("j", ui, range);
  applyKey("\x1b[B", ui, range);
  assert.equal(ui.scroll, 2);
  applyKey(" ", ui, range);
  applyKey("\x1b[6~", ui, range);
  assert.equal(ui.scroll, 15);
  applyKey("g", ui, range);
  assert.equal(ui.scroll, 0);
  applyKey("G", ui, range);
  assert.equal(ui.scroll, 15);
  assert.equal(applyKey("\t", ui, range), false, "tab no longer does anything");
});

test("arguments route onto commands the SDK understands", () => {
  assert.deepEqual(normalizeArgv([]), []);
  assert.deepEqual(normalizeArgv(["init", "--help"]), ["init", "--help"]);
  assert.deepEqual(normalizeArgv(["--tui", "--view", "cards"]), ["run", "--tui", "--view", "cards"]);
  assert.deepEqual(normalizeArgv(["update", "--check"]), ["update", "--check"]);
  assert.deepEqual(normalizeArgv(["--config", "f", "init"]), ["init", "--config", "f"]);
  assert.deepEqual(normalizeArgv(["--json"]), ["run", "--json"]);
  assert.deepEqual(normalizeArgv(["--tui", "-h"]), ["--help"]);
  assert.deepEqual(normalizeArgv(["-v"]), ["-v"]);
});

test("cpu on a Mac comes from iostat, not top", () => {
  assert.match(REMOTE_SCRIPT, /iostat -n0 -c 2 -w 1/);
  assert.doesNotMatch(REMOTE_SCRIPT, /\btop -l/);
});
