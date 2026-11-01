import assert from "node:assert/strict";
import { test } from "node:test";
import { verdict } from "../src/verdict.js";

const idle = { cores: 14, cpuPct: 5, load1: 1, load5: 3, memPct: 15, memPressure: "normal", gpuPct: 0, diskFreeGB: 259, sims: 0, xcodebuild: 0 };

test("an idle Mac is free with room for both simulators", () => {
  const v = verdict(idle);
  assert.equal(v.label, "free");
  assert.equal(v.simsFree, 2);
});

test("the verdict follows cpu and gpu", () => {
  assert.equal(verdict({ ...idle, cpuPct: 60 }).label, "busy");
  assert.equal(verdict({ ...idle, cpuPct: 95 }).label, "saturated");
  assert.equal(verdict({ ...idle, gpuPct: 60 }).label, "busy");
  assert.equal(verdict({ ...idle, gpuPct: 95 }).label, "saturated");
  assert.deepEqual(verdict({ ...idle, cpuPct: 95, gpuPct: 60 }).reasons, ["cpu 95%", "gpu 60%"]);
});

test("simulators, builds, load, memory and disk do not move it", () => {
  for (const change of [{ sims: 2 }, { xcodebuild: 3 }, { load5: 100 }, { memPressure: "critical" }, { memPct: 95 }, { diskFreeGB: 5 }]) {
    assert.equal(verdict({ ...idle, ...change }).label, "free", JSON.stringify(change));
  }
});

test("a Linux host has no simulator count to report", () => {
  const { sims, xcodebuild, ...linux } = idle;
  const v = verdict(linux);
  assert.equal(v.label, "free");
  assert.equal("simsFree" in v, false);
});

test("simsFree follows the host's ceiling", () => {
  assert.equal(verdict({ ...idle, sims: 2, simCeiling: 4 }).simsFree, 2);
  assert.equal(verdict({ ...idle, sims: 4, simCeiling: 4 }).simsFree, 0);
  assert.equal(verdict({ ...idle, sims: 3, simCeiling: 2 }).simsFree, 0);
  assert.equal(verdict({ ...idle, sims: 1 }).simsFree, 1);
});
