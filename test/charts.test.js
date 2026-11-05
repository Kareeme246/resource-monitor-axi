import assert from "node:assert/strict";
import { test } from "node:test";
import { chartColumns, chartsFrame, renderFrame, shrinkSteps } from "../src/charts.js";

const NOW = 1_800_000_000_000;
const sample = { os: "Darwin", chip: "Apple M4 Pro", cores: 14, cpuPct: 62, cpuNowPct: 16, load5: 75, memPct: 33, memPressure: "normal", gpuPct: 20, diskPct: 49, diskFreeGB: 233, sims: 1, xcodebuild: 1 };
const series = (count, stepS = 15, end = NOW) =>
  Array.from({ length: count }, (_, i) => ({ t: end - (count - 1 - i) * stepS * 1000, cpu: 50, mem: 33, gpu: 20, disk: 49 }));
const live = { label: "build-box", sample, sampledAt: NOW, points: series(240) };
const opts = { now: NOW, windowMs: 3600_000, n: 45, gapMs: 37_500 };
const longest = (text) => Math.max(...text.split("\n").map((l) => [...l].length));

test("the rightmost column is the latest reading and takes the peak once the slice closes", () => {
  const sliceMs = 80_000;
  const start = Math.floor(NOW / sliceMs) * sliceMs;
  const points = [{ t: start + 1000, cpu: 90 }, { t: start + 75000, cpu: 12 }];
  const now = start + 76000;
  assert.equal(chartColumns(points, "cpu", { ...opts, now }).at(-1).v, 12);
  const later = start + sliceMs + 1000;
  const columns = chartColumns(points, "cpu", { ...opts, now: later });
  assert.equal(columns.at(-2).v, 90);
  assert.equal(columns.at(-1).v, 12, "the new slice holds the latest reading until a sample lands");
});

test("before history is blank, a quiet stretch is a gap, and a wait for the next sample is neither", () => {
  const columns = chartColumns([{ t: NOW - 1000_000, cpu: 40 }, { t: NOW, cpu: 40 }], "cpu", opts);
  assert.equal(columns[0].kind, "blank");
  assert.equal(columns.at(-5).kind, "gap");
  assert.equal(columns.at(-1).kind, "value");
  const fine = chartColumns(series(60), "cpu", { ...opts, windowMs: 900_000, n: 90 });
  assert.equal(fine.slice(-50).every((c) => c.kind === "value"), true, "slices finer than the interval have no holes");
});

test("a failed attempt starts the dashed baseline at once", () => {
  const points = [...series(10, 15, NOW - 400_000), { t: NOW - 390_000, down: 1 }];
  const columns = chartColumns(points, "cpu", opts);
  assert.equal(columns.at(-2).kind, "gap");
  assert.equal(columns.at(-1).kind, "gap");
});

test("rows are lost GPU, memory, CPU, round and round", () => {
  assert.deepEqual(shrinkSteps([3, 3, 3, 1]), [[3, 3, 3, 1], [3, 3, 2, 1], [3, 2, 2, 1], [2, 2, 2, 1], [2, 2, 1, 1], [2, 1, 1, 1], [1, 1, 1, 1]]);
});

test("charts are the default frame, in the approved shape, at 1h", () => {
  const out = renderFrame([live], { columns: 50, now: NOW }).text;
  assert.match(out, /resource-monitor-axi · \d\d:\d\d · 1 live/);
  assert.match(out, /╭─ cpu ─+ 62% ─╮/);
  assert.match(out, /╰─ 1h ─+ peak 50% ─╯/);
  assert.match(out, /33% normal/);
  assert.match(out, /49% · 233G free/);
  assert.match(out, /load 5\.4x {2}sims 1\/2 {2}xcodebuild 1/);
  const lines = out.split("\n");
  assert.equal(lines[2], "● build-box · M4 Pro · 14c", "the host is an unboxed header");
  assert.match(lines.at(-2), /^● busy {2}cpu 62%/, "details sit unboxed under the charts");
  assert.match(lines.at(-1), /^load 5\.4x/);
  assert.equal(lines.some((l) => /^╭─ . build-box/.test(l)), false);
});

test("boxes stack, pair up and sit four across at the agreed widths", () => {
  const across = (columns) => renderFrame([live], { columns, now: NOW }).text.split("\n").find((l) => l.includes("─ cpu ─")).split("╭").length - 1;
  assert.equal(across(65), 1);
  assert.equal(across(66), 2);
  assert.equal(across(98), 2);
  assert.equal(across(99), 4);
});

test("no frame ever overflows, at any size, in either view", () => {
  const down = { label: "mini", error: "connection timed out", sample, sampledAt: NOW - 120000, points: series(20, 15, NOW - 120000) };
  const never = { label: "ghost", error: "host not found" };
  for (const view of ["charts", "cards"]) {
    for (let columns = 20; columns <= 200; columns += 3) {
      for (const rows of [undefined, 4, 8, 13, 19, 25, 40]) {
        const frame = renderFrame([live, down, never], { view, columns, rows, now: NOW });
        assert.equal(longest(frame.text) <= columns, true, `${view} ${columns}x${rows}: ${longest(frame.text)}`);
        if (rows) assert.equal(frame.text.split("\n").length <= rows, true, `${view} ${columns}x${rows} rows`);
      }
    }
  }
});

test("detail text wraps and is never cut off, at every width and in both views", () => {
  const busy = { ...sample, cpuPct: 90, gpuPct: 95 };
  const host = { label: "build-box", sample: busy, sampledAt: NOW, points: series(10) };
  const reasons = ["cpu 90%", "gpu 95%"];
  for (const view of ["charts", "cards"]) {
    for (let columns = 30; columns <= 200; columns += 1) {
      const text = renderFrame([host], { view, columns, now: NOW }).text;
      const flat = text.replace(/[│\n]/g, " ").replace(/\s+/g, " ");
      for (const reason of reasons) assert.equal(flat.includes(reason), true, `${view} at ${columns}: ${reason}`);
      assert.equal(/…\s*│/.test(text.split("\n").filter((l) => !l.includes("disk")).join("\n")), false, `${view} at ${columns} clips`);
    }
  }
  const down = { label: "h", error: "a very long reason that certainly cannot fit in one short line of a box", points: [] };
  const flat = renderFrame([down], { columns: 30, now: NOW }).text.replace(/[│\n]/g, " ").replace(/\s+/g, " ");
  assert.match(flat, /a very long reason that certainly cannot fit in one short line of a box/);
});

test("a host loses chart rows to fit the pane, then falls back to cards", () => {
  const rowsOf = (rows) => renderFrame([live], { columns: 50, rows, now: NOW }).text;
  assert.equal(rowsOf(26).includes("peak"), true);
  const shrunk = rowsOf(19);
  assert.equal(shrunk.includes("peak"), false);
  assert.equal(shrunk.split("\n").length <= 19, true);
  const least = rowsOf(15).split("\n");
  assert.equal(least.length, 15);
  assert.equal(least[0], "● build-box · M4 Pro · 14c");
  assert.match(least.at(-1), /^load 5\.4x/);
  assert.equal(chartsFrame([live], { columns: 50, rows: 14, now: NOW }), null);
  assert.match(rowsOf(14), /live/);
  assert.equal(chartsFrame([live], { columns: 29, now: NOW }), null);
});

test("a short pane scrolls instead of hiding hosts, and the header stays pinned", () => {
  const second = { ...live, label: "mini" };
  const top = renderFrame([live, second], { columns: 60, rows: 20, now: NOW });
  assert.equal(top.maxScroll > 0, true);
  assert.match(top.text, /↓\d+/);
  assert.equal(top.text.includes("mini"), false);
  assert.match(top.text.split("\n")[0], /^ {2}resource-monitor-axi · \d\d:\d\d · 2 live · 0 stale · ↓\d+$/, "the counts stay whole beside the scroll marks");
  const bottom = renderFrame([live, second], { columns: 60, rows: 20, now: NOW, scroll: 9999 });
  assert.equal(bottom.scroll, top.maxScroll);
  assert.match(bottom.text, /mini/);
  assert.match(bottom.text.split("\n")[0], /resource-monitor-axi/);
  assert.match(bottom.text, /↑\d+/);
  const tiny = renderFrame([live, second], { columns: 50, rows: 6, now: NOW, scroll: 9999 });
  assert.equal(tiny.text.split("\n").length, 6);
  assert.equal(tiny.maxScroll > 0, true);
  const crowded = renderFrame([live, second], { columns: 34, rows: 25, now: NOW });
  assert.match(crowded.text.split("\n")[0], /^ {2}resource-monitor-axi · \d\d:\d\d$/);
  assert.match(crowded.text.split("\n").find((l) => l.includes("↓")), /^ {2}2 live · 0 stale · ↓\d+$/);
});

test("header wraps instead of dropping parts at 37, 49, and 80 columns, including scrolled panes", () => {
  const second = { ...live, label: "mini" };

  // 80 columns: full single line
  const f80 = renderFrame([live, second], { columns: 80, rows: 31, now: NOW });
  const lines80 = f80.text.split("\n");
  assert.match(lines80[0], /^ {2}resource-monitor-axi · \d\d:\d\d · 2 live · 0 stale$/);
  assert.equal(lines80[1], "");

  // 80 columns scrolled: marks on single line
  const f80s = renderFrame([live, second], { columns: 80, rows: 15, now: NOW });
  assert.match(f80s.text.split("\n")[0], /^ {2}resource-monitor-axi · \d\d:\d\d · 2 live · 0 stale · ↓\d+$/);

  // 49 columns: fits on single line without marks
  const f49 = renderFrame([live], { columns: 49, rows: 31, now: NOW });
  const lines49 = f49.text.split("\n");
  assert.match(lines49[0], /^ {2}resource-monitor-axi · \d\d:\d\d · 1 live · 0 stale$/);
  assert.equal(lines49[1], "");

  // 49 columns scrolled: wraps greedily with full header on line 0, marks on line 1
  const f49s = renderFrame([live, second], { columns: 49, rows: 20, now: NOW });
  const lines49s = f49s.text.split("\n");
  assert.match(lines49s[0], /^ {2}resource-monitor-axi · \d\d:\d\d · 2 live · 0 stale$/);
  assert.match(lines49s[1], /^ {2}↓\d+$/);

  // 37 columns: wraps greedily onto 2 lines, preserving blank line when roomy
  const f37 = renderFrame([live], { columns: 37, rows: 31, now: NOW });
  const lines37 = f37.text.split("\n");
  assert.match(lines37[0], /^ {2}resource-monitor-axi · \d\d:\d\d$/);
  assert.match(lines37[1], /^ {2}1 live · 0 stale$/);
  assert.equal(lines37[2], "");

  // 37 columns scrolled: wraps onto 2 lines, marks on second line, pinned header & body reaches last line
  const f37s = renderFrame([live, second], { columns: 37, rows: 25, now: NOW });
  const lines37s = f37s.text.split("\n");
  assert.match(lines37s[0], /^ {2}resource-monitor-axi · \d\d:\d\d$/);
  assert.match(lines37s[1], /^ {2}2 live · 0 stale · ↓\d+$/);
  assert.equal(lines37s.length, 25);

  // Scrolled to bottom reaches the last body line in height layout
  const f37b = renderFrame([live, second], { columns: 37, rows: 25, now: NOW, scroll: 9999 });
  const lines37b = f37b.text.split("\n");
  assert.match(lines37b[0], /^ {2}resource-monitor-axi · \d\d:\d\d$/);
  assert.match(lines37b[1], /^ {2}2 live · 0 stale · ↑\d+$/);
  assert.equal(lines37b.length, 25);
  assert.equal(f37b.scroll, f37s.maxScroll);

  // Cards view at 37 columns
  const fCards = renderFrame([live, second], { view: "cards", columns: 37, rows: 31, now: NOW });
  const cardsLines = fCards.text.split("\n");
  assert.match(cardsLines[0], /^ {2}resource-monitor-axi · \d\d:\d\d$/);
  assert.match(cardsLines[1], /^ {2}2 live · 0 stale$/);

  // Both v views (local and servers) at 37 columns
  const fLocal = renderFrame([live], { columns: 37, rows: 31, now: NOW, toggle: "servers", allStates: [live, second] });
  assert.match(fLocal.text.split("\n")[0], /^ {2}resource-monitor-axi · \d\d:\d\d$/);
  assert.match(fLocal.text.split("\n")[1], /^ {2}2 live · 0 stale$/);

  const fServers = renderFrame([second], { columns: 37, rows: 31, now: NOW, toggle: "local", allStates: [live, second] });
  assert.match(fServers.text.split("\n")[0], /^ {2}resource-monitor-axi · \d\d:\d\d$/);
  assert.match(fServers.text.split("\n")[1], /^ {2}2 live · 0 stale$/);
});

test("an unreachable host is dim with reason and age, keeps its chart and leaves the totals", () => {
  const down = { label: "build-box", error: "connection timed out", sample, sampledAt: NOW - 400000, points: [...series(100, 15, NOW - 400000), { t: NOW - 385000, down: 1 }, { t: NOW - 15000, down: 1 }] };
  const out = renderFrame([down], { columns: 50, now: NOW }).text;
  assert.match(out, /^○ build-box · stale 7m$/m);
  assert.match(out, /● connection timed out/);
  assert.match(out, /excluded from totals/);
  assert.match(out, /0 live · 1 stale/);
  assert.match(out, /█╌+ │/);
  const painted = renderFrame([down], { columns: 50, now: NOW, depth: "truecolor" }).text;
  assert.match(painted, /38;2;49;50;68m╭─/);
});

test("a restarted panel shows history before the first reading and names the time it was off", () => {
  const points = series(100, 15, NOW - 180000);
  const state = { label: "build-box", points, lastReadingAt: NOW - 180000, panelOff: { from: NOW - 180000, to: NOW } };
  const out = renderFrame([state], { columns: 50, now: NOW }).text;
  assert.match(out, /^○ build-box · stale 3m$/m);
  assert.match(out, /waiting for first reading/);
  assert.match(out, /panel off for 3m/);
  assert.match(renderFrame([state], { columns: 100, now: NOW }).text, /─ off 3m ─╯/, "narrow boxes keep a shorter label");
  assert.match(out, /╭─ cpu ─+ 50% ─╮/);
});

test("a metric the host cannot read has no box", () => {
  const { gpuPct, ...noGpu } = sample;
  const out = renderFrame([{ label: "linux", sample: noGpu, points: [{ t: NOW, cpu: 4 }] }], { columns: 50, now: NOW }).text;
  assert.equal(out.includes("gpu"), false);
  assert.match(out, /disk/);
});

test("a key of every shortcut stays on the bottom rows, naming what w and i change to next", () => {
  const frame = renderFrame([live], { columns: 120, rows: 40, now: NOW, keys: true, intervalS: 15, windowS: 3600, toggle: "local" });
  const lines = frame.text.split("\n");
  assert.equal(lines.length, 40);
  assert.match(lines.at(-1), /v local {2}c cards {2}w window 1h → 6h {2}i every 15s → 30s {2}r refresh {2}j k scroll {2}space page {2}g G top\/end {2}q quit/);
  const narrow = renderFrame([live], { columns: 36, rows: 40, now: NOW, keys: true }).text.split("\n");
  assert.equal(narrow.length, 40);
  assert.equal(longest(narrow.join("\n")) <= 36, true);
  const flat = narrow.slice(-4).join(" ").replace(/\s+/g, " ");
  assert.match(flat, /q quit/);
  assert.match(flat, /r refresh/);
  assert.match(flat, /w window 1h → 6h/);
  const cards = renderFrame([live], { view: "cards", columns: 120, rows: 40, now: NOW, keys: true }).text;
  assert.match(cards, /c charts/);
  assert.match(cards, /r refresh/);
  assert.doesNotMatch(cards, /\bv /, "no toggle key when there is nothing to toggle to");
  assert.doesNotMatch(cards, /w window/);
  assert.equal(renderFrame([live], { columns: 50, rows: 9, now: NOW, keys: true }).text.includes("q quit"), false, "a tiny pane keeps its room for data");
  assert.equal(renderFrame([live], { columns: 50, now: NOW }).text.includes("q quit"), false, "no key without a live panel");
});

test("the top line re-renders when the minute changes, even between samples and at long interval", () => {
  const base = new Date(2026, 10, 1, 10, 9, 59).getTime();
  const nextMinute = base + 1000;
  const f1 = renderFrame([live], { columns: 80, now: base, intervalS: 60 }).text.split("\n")[0];
  const f2 = renderFrame([live], { columns: 80, now: nextMinute, intervalS: 60 }).text.split("\n")[0];
  assert.match(f1, / · 10:09 · /);
  assert.match(f2, / · 10:10 · /);
  assert.match(f1, / · 0 stale$/);
  assert.match(f2, / · 0 stale$/);
});
