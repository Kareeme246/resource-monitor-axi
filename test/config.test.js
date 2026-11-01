import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

test("loadConfig parses hosts with default and custom simCeiling", () => {
  const tmp = join(tmpdir(), `resource-monitor-axi-cfg-${Date.now()}.json`);
  try {
    writeFileSync(
      tmp,
      JSON.stringify({
        hosts: [
          "build-box.local",
          { host: "mini", label: "Mac mini", simCeiling: 4 },
          { host: "studio", simCeiling: 1 },
        ],
        interval: 10,
      }),
    );
    const cfg = loadConfig(tmp);
    assert.equal(cfg.intervalS, 10);
    assert.deepEqual(cfg.hosts, [
      { host: "build-box.local", label: "build-box.local", simCeiling: 2 },
      { host: "mini", label: "Mac mini", simCeiling: 4 },
      { host: "studio", label: "studio", simCeiling: 1 },
    ]);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
});

test("loadConfig rejects invalid simCeiling", () => {
  const tmp = join(tmpdir(), `resource-monitor-axi-cfg-err-${Date.now()}.json`);
  try {
    writeFileSync(
      tmp,
      JSON.stringify({
        hosts: [{ host: "mini", simCeiling: 0 }],
      }),
    );
    assert.throws(() => loadConfig(tmp), /simCeiling/);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
});

test("the interval floor is 3 s and the window defaults to 1h", () => {
  const tmp = join(tmpdir(), `resource-monitor-axi-cfg-win-${Date.now()}.json`);
  try {
    writeFileSync(tmp, JSON.stringify({ hosts: ["a"], interval: 3 }));
    assert.deepEqual([loadConfig(tmp).intervalS, loadConfig(tmp).window], [3, "1h"]);
    writeFileSync(tmp, JSON.stringify({ hosts: ["a"], window: "15m" }));
    assert.equal(loadConfig(tmp).window, "15m");
    writeFileSync(tmp, JSON.stringify({ hosts: ["a"], window: "2h" }));
    assert.throws(() => loadConfig(tmp), /window/);
    writeFileSync(tmp, JSON.stringify({ hosts: ["a"], interval: 2 }));
    assert.throws(() => loadConfig(tmp), /interval/);
  } finally {
    unlinkSync(tmp);
  }
});
