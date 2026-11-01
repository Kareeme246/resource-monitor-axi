import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPanel } from "../src/render.js";
import { snapshotData } from "../src/cli.js";

const sample = { os: "Darwin", chip: "Apple M4 Pro", cores: 14, cpuPct: 62, load1: 4, load5: 4, memPct: 40, memPressure: "normal", gpuPct: 20, diskPct: 44, diskFreeGB: 259, sims: 1, xcodebuild: 1 };
const live = { label: "build-box.local", sample, sampledAt: 1000 };
const stale = { label: "build-box.local", sample, sampledAt: 1000, error: "connection timed out" };
const never = { label: "ghost", error: "host not found" };
const width = (text) => Math.max(...text.split("\n").map((l) => [...l].length));

test("a card is 49 columns wide and plain text without color", () => {
  const out = renderPanel([live], { columns: 100, now: 2000 });
  assert.equal(width(out) <= 100, true);
  assert.match(out, /╭─ ● build-box.local .* M4 Pro · 14c ─╮/);
  assert.equal(out.includes("\x1b"), false);
  assert.match(out, /● busy/);
});

test("cards reflow into columns when the terminal is wide and a column when narrow", () => {
  const two = renderPanel([live, live], { columns: 100, now: 2000 }).split("\n");
  const one = renderPanel([live, live], { columns: 60, now: 2000 }).split("\n");
  assert.equal(two.find((l) => l.startsWith("╭")).split("build-box.local").length - 1, 2);
  assert.equal(two.filter((l) => l.startsWith("╭")).length, 1);
  assert.equal(one.filter((l) => l.startsWith("╭")).length, 2);
});

test("narrow terminals shrink the card instead of overflowing", () => {
  for (const columns of [30, 36, 45]) {
    assert.equal(width(renderPanel([live], { columns, now: 2000 })) <= columns, true, `columns ${columns}`);
  }
});

test("short terminals fall back to tighter shapes that still fit", () => {
  const states = [live, live, live];
  const full = renderPanel(states, { columns: 49, now: 2000 }).split("\n").length;
  const tight = renderPanel(states, { columns: 49, rows: full - 1, now: 2000 }).split("\n").length;
  const line = renderPanel(states, { columns: 49, rows: 8, now: 2000 }).split("\n");
  assert.equal(tight < full, true);
  assert.equal(line.length <= 8, true);
  assert.match(line.join("\n"), /build-box.local/);
});

test("an unreachable host is a clearly stale card that keeps its last reading", () => {
  const out = renderPanel([stale], { columns: 60, now: 31000 });
  assert.match(out, /○ build-box.local .* stale 30s/);
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
  assert.deepEqual([rows[1].status, rows[1].verdict, rows[1].error], ["unreachable", null, "host not found"]);
});
