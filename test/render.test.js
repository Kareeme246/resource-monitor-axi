import assert from "node:assert/strict";
import { test } from "node:test";
import { cardsFrame, composeFrame, formatHeaderLine, formatHeaderLines, formatQueryTime, renderPanel } from "../src/render.js";
import { snapshotData } from "../src/cli.js";

const sample = { os: "Darwin", chip: "Apple M4 Pro", cores: 14, cpuPct: 62, load1: 4, load5: 4, memPct: 40, memPressure: "normal", gpuPct: 20, diskPct: 44, diskFreeGB: 259, sims: 1, xcodebuild: 1 };
const live = { label: "build-box", sample, sampledAt: 1000 };
const stale = { label: "build-box", sample, sampledAt: 1000, error: "connection timed out" };
const never = { label: "ghost", error: "host not found" };
const width = (text) => Math.max(...text.split("\n").map((l) => [...l].length));

test("a card is 49 columns wide and plain text without color", () => {
  const out = renderPanel([live], { columns: 100, now: 2000 });
  assert.equal(width(out) <= 100, true);
  assert.match(out, /╭─ ● build-box .* M4 Pro · 14c ─╮/);
  assert.equal(out.includes("\x1b"), false);
  assert.match(out, /● busy/);
});

test("cards reflow into columns when the terminal is wide and a column when narrow", () => {
  const two = renderPanel([live, live], { columns: 100, now: 2000 }).split("\n");
  const one = renderPanel([live, live], { columns: 60, now: 2000 }).split("\n");
  assert.equal(two.find((l) => l.startsWith("╭")).split("build-box").length - 1, 2);
  assert.equal(two.filter((l) => l.startsWith("╭")).length, 1);
  assert.equal(one.filter((l) => l.startsWith("╭")).length, 2);
});

test("narrow terminals shrink the card instead of overflowing", () => {
  for (const columns of [30, 36, 45]) {
    assert.equal(width(renderPanel([live], { columns, now: 2000 })) <= columns, true, `columns ${columns}`);
    assert.equal(width(renderPanel([stale], { columns, now: 31000 })) <= columns, true, `stale columns ${columns}`);
  }
});

test("sims bar and verdict respect per-host simCeiling", () => {
  const custom = { label: "mini", sample: { ...sample, sims: 2 }, simCeiling: 4 };
  const out = renderPanel([custom], { columns: 60, now: 2000 });
  assert.match(out, /2\/4/);
});

test("two configured hosts reflow cleanly when narrow and wide", () => {
  const h1 = { label: "build-box", sample, simCeiling: 2 };
  const h2 = { label: "mini", sample: { ...sample, sims: 2 }, simCeiling: 4 };

  for (const columns of [25, 30, 35, 49, 60, 100, 120]) {
    const rendered = renderPanel([h1, h2], { columns, now: 2000 });
    assert.equal(width(rendered) <= columns, true, `columns ${columns} overflow: ${width(rendered)}`);
  }
});

test("short terminals drop the card padding before the metrics", () => {
  const states = [live, live, live];
  const full = renderPanel(states, { columns: 49, now: 2000 }).split("\n").length;
  const tight = renderPanel(states, { columns: 49, rows: full - 1, now: 2000 }).split("\n").length;
  const line = renderPanel(states, { columns: 49, rows: 8, now: 2000 }).split("\n");
  assert.equal(tight < full, true);
  assert.equal(line.length <= 8, true);
  assert.match(line.join("\n"), /build-box/);
});

test("a card keeps every metric row when the pane is short, and the body scrolls", () => {
  const textOf = (frame) => frame.body.map((line) => line.map((seg) => seg.text).join(""));
  const states = [live, live, live];
  for (const rows of [6, 10, 16]) {
    const body = textOf(cardsFrame(states, { columns: 49, rows, now: 2000 }));
    assert.equal(body.filter((l) => l.startsWith("╭")).length, 3, `rows ${rows}: every panel keeps its box`);
    assert.equal(body.filter((l) => /^│   cpu /.test(l)).length, 3, `rows ${rows}: every metric row stays`);
    assert.equal(body.filter((l) => l.includes("● busy")).length, 3, `rows ${rows}: the verdict stays`);
    assert.equal(body.filter((l) => /^╰─+╯$/.test(l)).length, 3, `rows ${rows}: the bottom edge stays`);
  }
  // A card's floor is its tight shape: nothing is dropped, the padding goes first.
  const short = textOf(cardsFrame([live], { columns: 49, rows: 4, now: 2000 }));
  assert.equal(short[1].startsWith("│   cpu"), true, "no blank padding row above the metrics");
  const frame = composeFrame(cardsFrame([live], { columns: 49, rows: 4, now: 2000 }), { columns: 49, rows: 4, footer: [[{ text: "  q quit" }]] });
  assert.equal(frame.maxScroll > 0, true, "a card taller than the pane scrolls");
  assert.equal(frame.text.split("\n").length, 4);
});

test("an unreachable host is a clearly stale card that keeps its last reading", () => {
  const out = renderPanel([stale], { columns: 60, now: 31000 });
  assert.match(out, /○ build-box .* stale 30s/);
  assert.match(out, /connection timed out/);
  assert.match(out, /excluded from totals/);
  assert.match(out, /1 stale/);
  assert.equal(out.includes("● busy"), false);
});

test("a host never reached shows no reading yet", () => {
  const out = renderPanel([never], { columns: 60, now: 5000 });
  assert.match(out, /unreachable/);
  assert.match(out, /no reading yet/);
});

test("snapshot rows mark unreachable hosts and keep the others", () => {
  const rows = snapshotData([live, never], 2000);
  assert.equal(rows[0].verdict, "busy");
  assert.equal(rows[0].simsFree, 1);
  assert.deepEqual([rows[1].status, rows[1].verdict, rows[1].error], ["unreachable", null, "host not found"]);
});

test("formatHeaderLine wraps onto further lines instead of dropping parts across widths", () => {
  assert.equal(formatHeaderLine({ time: "11:25", live: 2, stale: 0, columns: 80 }), "resource-monitor-axi · 11:25 · 2 live · 0 stale");
  assert.deepEqual(formatHeaderLines({ time: "11:25", live: 2, stale: 0, columns: 80 }), ["resource-monitor-axi · 11:25 · 2 live · 0 stale"]);

  assert.equal(formatHeaderLine({ time: "11:25", live: 2, stale: 0, columns: 49 }), "resource-monitor-axi · 11:25 · 2 live · 0 stale");
  assert.deepEqual(formatHeaderLines({ time: "11:25", live: 2, stale: 0, columns: 49 }), ["resource-monitor-axi · 11:25 · 2 live · 0 stale"]);

  assert.equal(formatHeaderLine({ time: "11:25", live: 2, stale: 0, columns: 45 }), "resource-monitor-axi · 11:25 · 2 live\n0 stale");
  assert.deepEqual(formatHeaderLines({ time: "11:25", live: 2, stale: 0, columns: 45 }), ["resource-monitor-axi · 11:25 · 2 live", "0 stale"]);

  assert.equal(formatHeaderLine({ time: "11:25", live: 2, stale: 0, columns: 37 }), "resource-monitor-axi · 11:25\n2 live · 0 stale");
  assert.deepEqual(formatHeaderLines({ time: "11:25", live: 2, stale: 0, columns: 37 }), ["resource-monitor-axi · 11:25", "2 live · 0 stale"]);

  assert.deepEqual(formatHeaderLines({ time: "11:25", live: 2, stale: 0, columns: 25 }), ["resource-monitor-axi", "11:25 · 2 live", "0 stale"]);
  assert.equal(formatHeaderLine({ time: "11:25", live: 2, stale: 1, columns: 80 }), "resource-monitor-axi · 11:25 · 2 live · 1 stale");
});

test("formatHeaderLines greedily fills the first line instead of prematurely wrapping on name", () => {
  // At width 45 (room 43): name (20) + time (8) + 2 live (9) = 37 chars fits on line 1, only 0 stale wraps
  const lines45 = formatHeaderLines({ time: "11:25", live: 2, stale: 0, columns: 45 });
  assert.deepEqual(lines45, [
    "resource-monitor-axi · 11:25 · 2 live",
    "0 stale",
  ]);

  // At width 40 (room 38): name + time + 2 live (37 chars) still fits on line 1
  const lines40 = formatHeaderLines({ time: "11:25", live: 2, stale: 0, columns: 40 });
  assert.deepEqual(lines40, [
    "resource-monitor-axi · 11:25 · 2 live",
    "0 stale",
  ]);

  // At width 37 (room 35): name + time (28 chars) fits on line 1, live and stale wrap
  const lines37 = formatHeaderLines({ time: "11:25", live: 2, stale: 0, columns: 37 });
  assert.deepEqual(lines37, [
    "resource-monitor-axi · 11:25",
    "2 live · 0 stale",
  ]);

  // At width 25 (room 23): name fits on line 1, time + live on line 2, stale on line 3
  const lines25 = formatHeaderLines({ time: "11:25", live: 2, stale: 0, columns: 25 });
  assert.deepEqual(lines25, [
    "resource-monitor-axi",
    "11:25 · 2 live",
    "0 stale",
  ]);
});

test("formatQueryTime formats in the machine's 24h time and handles midnight", () => {
  const d1 = new Date(2026, 10, 1, 11, 25);
  assert.equal(formatQueryTime(d1), "11:25");
  const d2 = new Date(2026, 10, 1, 0, 5);
  assert.equal(formatQueryTime(d2), "00:05");
});
