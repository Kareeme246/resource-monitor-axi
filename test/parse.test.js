import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSample } from "../src/parse.js";

const darwin = `os=Darwin
host=build-box
cores=14
model=Mac16,7
chip=Apple M4 Pro
memtotal=25769803776
load=  1.60 4.50 17.55
memfree=85
pressure=1
swap=17.75M
disk=482797652 271635944
gpu=16
sims=2
xcodebuild=1
cpu=4.8
end=1
`;

const linux = `os=Linux
cores=8
chip=AMD EPYC
memtotal=33554432000
load=0.50 0.40 0.30
memfree=20
psi=6.5
swap=0M
disk=100000000 25000000
gpu=55
cpu=12.3
end=1
`;

test("parses a macOS reading", () => {
  assert.deepEqual(parseSample(darwin), {
    os: "Darwin",
    chip: "Apple M4 Pro",
    cores: 14,
    cpuPct: 5,
    load1: 1.6,
    load5: 4.5,
    load15: 17.55,
    memPct: 15,
    memPressure: "normal",
    swapMB: 17.75,
    diskPct: 44,
    diskFreeGB: 259,
    gpuPct: 16,
    sims: 2,
    xcodebuild: 1,
  });
});

test("parses a Linux reading and leaves simulator fields out", () => {
  const s = parseSample(linux);
  assert.equal(s.os, "Linux");
  assert.equal(s.memPct, 80);
  assert.equal(s.memPressure, "warn");
  assert.equal(s.gpuPct, 55);
  assert.equal(s.diskPct, 75);
  assert.equal("sims" in s, false);
  assert.equal("xcodebuild" in s, false);
});

test("a metric the host cannot read is absent, not zero", () => {
  const s = parseSample("os=Linux\ncores=2\ncpu=1\nend=1\n");
  assert.equal("gpuPct" in s, false);
  assert.equal("memPct" in s, false);
});

test("a truncated reading is rejected", () => {
  assert.throws(() => parseSample("os=Darwin\ncores=14\n"), /incomplete/);
  assert.throws(() => parseSample(""), /incomplete/);
});
