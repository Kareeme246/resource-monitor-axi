import assert from "node:assert/strict";
import { test } from "node:test";
import { verdict } from "../src/verdict.js";

const idle = { cores: 14, cpuPct: 5, load1: 1, load5: 3, memPct: 15, memPressure: "normal", gpuPct: 0, diskFreeGB: 259, sims: 0, xcodebuild: 0 };

test("an idle Mac is free with room for both simulators", () => {
  const v = verdict(idle);
  assert.equal(v.label, "free");
  assert.equal(v.simsFree, 2);
});

test("two simulators saturate regardless of cpu", () => {
  assert.equal(verdict({ ...idle, sims: 2 }).label, "saturated");
});

test("one simulator or an xcodebuild is busy", () => {
  assert.equal(verdict({ ...idle, sims: 1 }).label, "busy");
  assert.equal(verdict({ ...idle, xcodebuild: 1 }).label, "busy");
  assert.equal(verdict({ ...idle, sims: 1 }).simsFree, 1);
});

test("cpu, load, memory pressure and low disk raise the level", () => {
  assert.equal(verdict({ ...idle, cpuPct: 60 }).label, "busy");
  assert.equal(verdict({ ...idle, cpuPct: 95 }).label, "saturated");
  assert.equal(verdict({ ...idle, load5: 100 }).label, "saturated");
  assert.equal(verdict({ ...idle, memPressure: "critical" }).label, "saturated");
  assert.equal(verdict({ ...idle, diskFreeGB: 5 }).label, "saturated");
});

test("a Linux host has no simulator ceiling to report", () => {
  const { sims, xcodebuild, ...linux } = idle;
  const v = verdict(linux);
  assert.equal(v.label, "free");
  assert.equal("simsFree" in v, false);
});
