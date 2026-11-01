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
          "build-box",
          { host: "mini", label: "Mac mini", simCeiling: 4 },
          { host: "studio", simCeiling: 1 },
        ],
        interval: 10,
      }),
    );
    const cfg = loadConfig(tmp);
    assert.equal(cfg.intervalS, 10);
    assert.deepEqual(cfg.hosts, [
      { host: "build-box", label: "build-box", simCeiling: 2 },
      { host: "mini", label: "Mac mini", simCeiling: 4 },
      { host: "studio", label: "studio", simCeiling: 1 },
    ]);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
});

test("loadConfig without a file defaults to local machine only with no remote hosts", () => {
  const nonExistent = join(tmpdir(), `resource-monitor-axi-none-${Date.now()}.json`);
  const cfg = loadConfig(nonExistent);
  assert.deepEqual(cfg.hosts, []);
  assert.equal(cfg.intervalS, 15);
  assert.equal(cfg.window, "1h");
  assert.ok(cfg.local);
  assert.equal(cfg.local.simCeiling, 2);
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

test("this machine is on by default, configurable, and a config can have only it", () => {
  const tmp = join(tmpdir(), `resource-monitor-axi-cfg-local-${Date.now()}.json`);
  const write = (json) => writeFileSync(tmp, JSON.stringify(json));
  try {
    write({ hosts: ["a"] });
    assert.equal(loadConfig(tmp).local.simCeiling, 2);
    write({ hosts: [], local: { label: "laptop", simCeiling: 3 } });
    assert.deepEqual(loadConfig(tmp).local, { name: "laptop", simCeiling: 3 });
    assert.deepEqual(loadConfig(tmp).hosts, []);
    write({});
    assert.deepEqual(loadConfig(tmp).hosts, []);
    write({ hosts: ["a"], local: false });
    assert.equal(loadConfig(tmp).local, null);
    write({ hosts: [], local: false });
    assert.throws(() => loadConfig(tmp), /nothing to monitor/);
    write({ hosts: "a" });
    assert.throws(() => loadConfig(tmp), /array/);
    write({ local: "yes" });
    assert.throws(() => loadConfig(tmp), /local/);
  } finally {
    unlinkSync(tmp);
  }
});

test("loadConfig parses YAML and writeDefaultConfig writes valid YAML with commented example", async () => {
  const { writeDefaultConfig, DEFAULT_CONFIG_YAML } = await import("../src/config.js");
  const tmpYaml = join(tmpdir(), `resource-monitor-axi-init-${Date.now()}.yaml`);
  try {
    const created = writeDefaultConfig(tmpYaml);
    assert.equal(created, true);
    assert.match(DEFAULT_CONFIG_YAML, /# hosts:\n#   - build-box/);
    assert.match(DEFAULT_CONFIG_YAML, /hosts: \[\]/);
    const cfg = loadConfig(tmpYaml);
    assert.deepEqual(cfg.hosts, []);
    assert.equal(cfg.intervalS, 15);
    assert.equal(cfg.window, "1h");
  } finally {
    try { unlinkSync(tmpYaml); } catch {}
  }
});

test("loadConfig falls back to legacy config.json when config.yaml is absent and prints a note", () => {
  const tmpBase = join(tmpdir(), `resource-monitor-axi-legacy-${Date.now()}`);
  const yamlPath = `${tmpBase}.yaml`;
  const jsonPath = `${tmpBase}.json`;
  try {
    writeFileSync(jsonPath, JSON.stringify({ hosts: ["legacy-host"], interval: 20 }));
    let stderr = "";
    const origStderrWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderr += chunk; return true; };
    try {
      const cfg = loadConfig(yamlPath);
      assert.equal(cfg.hosts[0].host, "legacy-host");
      assert.equal(cfg.intervalS, 20);
      assert.match(stderr, /found; move to/);
    } finally {
      process.stderr.write = origStderrWrite;
    }
  } finally {
    try { unlinkSync(jsonPath); } catch {}
  }
});
