import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addHostToConfig, configPath } from "../src/config.js";
import { normalizeArgv } from "../src/cli.js";
import { checkReachability, inspectSshHost } from "../src/ssh.js";

const BIN = fileURLToPath(new URL("../bin/resource-monitor-axi.js", import.meta.url));

test("addHostToConfig creates a commented starter config when file is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "rma-add-cfg-"));
  const cfg = join(dir, "config.yaml");
  try {
    const res = addHostToConfig("my-new-box", cfg);
    assert.equal(res.added, true);
    assert.equal(res.alreadyPresent, false);
    assert.equal(res.created, true);
    assert.equal(res.path, cfg);

    const content = readFileSync(cfg, "utf8");
    assert.match(content, /# SSH host aliases to monitor/);
    assert.match(content, /hosts:\n\s+- my-new-box/);
    assert.match(content, /interval: 15/);
    assert.match(content, /window: 1h/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addHostToConfig preserves existing YAML comments, order and structure", () => {
  const dir = mkdtempSync(join(tmpdir(), "rma-add-cfg-"));
  const cfg = join(dir, "config.yaml");
  try {
    const initial = `# Custom header comment
hosts:
  # First host comment
  - build-box # inline comment
  - host: mini
    label: Mac mini
    simCeiling: 4

# Custom setting
interval: 20
window: 6h
`;
    writeFileSync(cfg, initial);

    const res = addHostToConfig("prod-server", cfg);
    assert.equal(res.added, true);
    assert.equal(res.alreadyPresent, false);
    assert.equal(res.created, false);

    const content = readFileSync(cfg, "utf8");
    assert.match(content, /# Custom header comment/);
    assert.match(content, /# First host comment/);
    assert.match(content, /- build-box # inline comment/);
    assert.match(content, /label: Mac mini/);
    assert.match(content, /simCeiling: 4/);
    assert.match(content, /- prod-server/);
    assert.match(content, /# Custom setting/);
    assert.match(content, /interval: 20/);
    assert.match(content, /window: 6h/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addHostToConfig is a no-op when host already exists (string or object)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rma-add-cfg-"));
  const cfg = join(dir, "config.yaml");
  try {
    const initial = `hosts:
  - existing-box
  - host: obj-box
    label: Object Box
`;
    writeFileSync(cfg, initial);

    const res1 = addHostToConfig("existing-box", cfg);
    assert.equal(res1.added, false);
    assert.equal(res1.alreadyPresent, true);
    assert.equal(readFileSync(cfg, "utf8"), initial);

    const res2 = addHostToConfig("obj-box", cfg);
    assert.equal(res2.added, false);
    assert.equal(res2.alreadyPresent, true);
    assert.equal(readFileSync(cfg, "utf8"), initial);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addHostToConfig adds hosts key if absent from existing YAML", () => {
  const dir = mkdtempSync(join(tmpdir(), "rma-add-cfg-"));
  const cfg = join(dir, "config.yaml");
  try {
    writeFileSync(cfg, "interval: 30\nlocal: false\n");
    const res = addHostToConfig("first-remote", cfg);
    assert.equal(res.added, true);
    assert.equal(res.alreadyPresent, false);
    const content = readFileSync(cfg, "utf8");
    assert.match(content, /interval: 30/);
    assert.match(content, /hosts:\n\s+- first-remote/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addHostToConfig supports legacy json configs", () => {
  const dir = mkdtempSync(join(tmpdir(), "rma-add-cfg-"));
  const jsonCfg = join(dir, "config.json");
  const yamlCfg = join(dir, "config.yaml");
  try {
    writeFileSync(jsonCfg, JSON.stringify({ hosts: ["box-a"], interval: 10 }));
    // Passing yamlCfg falls back to jsonCfg when yaml is absent
    const res = addHostToConfig("box-b", yamlCfg);
    assert.equal(res.added, true);
    assert.equal(res.alreadyPresent, false);
    assert.equal(res.path, jsonCfg);

    const parsed = JSON.parse(readFileSync(jsonCfg, "utf8"));
    assert.deepEqual(parsed.hosts, ["box-a", "box-b"]);

    const resNoop = addHostToConfig("box-b", yamlCfg);
    assert.equal(resNoop.added, false);
    assert.equal(resNoop.alreadyPresent, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectSshHost parses ssh -G output and checkReachability reports connectivity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rma-ssh-test-"));
  const fakeBin = join(dir, "bin");
  spawnSync("mkdir", ["-p", fakeBin]);

  writeFileSync(
    join(fakeBin, "ssh"),
    `#!/bin/sh
case "$*" in
*-G*configured-host*)
  echo "hostname 192.168.1.99"
  echo "user deploy"
  echo "port 2222"
  exit 0
  ;;
*-G*typo-host*)
  echo "hostname typo-host"
  echo "user localuser"
  echo "port 22"
  exit 0
  ;;
*-G*)
  echo "hostname default"
  echo "user default"
  echo "port 22"
  exit 0
  ;;
*good-host*)
  exit 0
  ;;
*bad-host*)
  echo "ssh: connect to host bad-host port 22: Connection refused" >&2
  exit 255
  ;;
*)
  exit 0
  ;;
esac
`,
    { mode: 0o755 },
  );

  const prevPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeBin}:${prevPath}`;

    const info1 = await inspectSshHost("configured-host");
    assert.equal(info1.hostname, "192.168.1.99");
    assert.equal(info1.user, "deploy");
    assert.equal(info1.port, 2222);

    const info2 = await inspectSshHost("typo-host");
    assert.equal(info2.hostname, "typo-host");
    assert.equal(info2.user, "localuser");
    assert.equal(info2.port, 22);

    const reachGood = await checkReachability("good-host");
    assert.equal(reachGood.reachable, true);

    const reachBad = await checkReachability("bad-host");
    assert.equal(reachBad.reachable, false);
    assert.equal(reachBad.error, "connection refused");
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI resource-monitor-axi add end-to-end", () => {
  const dir = mkdtempSync(join(tmpdir(), "rma-cli-add-"));
  const fakeBin = join(dir, "bin");
  spawnSync("mkdir", ["-p", fakeBin]);

  writeFileSync(
    join(fakeBin, "ssh"),
    `#!/bin/sh
case "$*" in
*-G*work-server*)
  echo "hostname 10.0.0.50"
  echo "user dev"
  echo "port 22"
  exit 0
  ;;
*-G*broken-box*)
  echo "hostname broken-box.internal"
  echo "user admin"
  echo "port 2222"
  exit 0
  ;;
*-G*)
  echo "hostname fallback"
  echo "user default"
  echo "port 22"
  exit 0
  ;;
*work-server*)
  exit 0
  ;;
*broken-box*)
  echo "ssh: connect to host broken-box.internal port 2222: Connection refused" >&2
  exit 255
  ;;
*)
  exit 0
  ;;
esac
`,
    { mode: 0o755 },
  );

  const config = join(dir, "config.yaml");
  writeFileSync(config, "hosts: []\ninterval: 15\n");

  const runCli = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        RESOURCE_MONITOR_AXI_CONFIG: config,
      },
    });
    return { out: r.stdout, err: r.stderr, code: r.status };
  };

  try {
    // 1. Add reachable host
    const r1 = runCli("add", "work-server");
    assert.equal(r1.code, 0);
    assert.match(r1.out, /host: work-server/);
    assert.match(r1.out, /hostname: 10\.0\.0\.50/);
    assert.match(r1.out, /user: dev/);
    assert.match(r1.out, /port: 22/);
    assert.match(r1.out, /status: added/);
    assert.match(r1.out, /reachable: true/);
    assert.match(readFileSync(config, "utf8"), /- work-server/);

    // 2. Add same host again -> no-op
    const r2 = runCli("add", "work-server");
    assert.equal(r2.code, 0);
    assert.match(r2.out, /host: work-server/);
    assert.match(r2.out, /status: already in config/);
    assert.match(r2.out, /no-op: host is already in config/);

    // 3. Add unreachable host -> reports unreachable, error, still saves it
    const r3 = runCli("add", "broken-box");
    assert.equal(r3.code, 0);
    assert.match(r3.out, /host: broken-box/);
    assert.match(r3.out, /hostname: broken-box\.internal/);
    assert.match(r3.out, /status: added/);
    assert.match(r3.out, /reachable: false/);
    assert.match(r3.out, /error: connection refused/);
    assert.match(r3.out, /saved to config but host is unreachable/);
    assert.match(readFileSync(config, "utf8"), /- broken-box/);

    // 4. Test --json flag on add
    const r4 = runCli("add", "work-server", "--json");
    assert.equal(r4.code, 0);
    const json = JSON.parse(r4.out);
    assert.equal(json.host, "work-server");
    assert.equal(json.hostname, "10.0.0.50");
    assert.equal(json.status, "already in config");
    assert.equal(json.reachable, true);

    // 5. Test validation errors
    const rNoArgs = runCli("add");
    assert.equal(rNoArgs.code, 2);
    assert.match(rNoArgs.out, /code: VALIDATION_ERROR/);
    assert.match(rNoArgs.out, /add needs an ssh host alias/);

    const rTooMany = runCli("add", "a", "b");
    assert.equal(rTooMany.code, 2);
    assert.match(rTooMany.out, /code: VALIDATION_ERROR/);
    assert.match(rTooMany.out, /add takes one ssh alias/);

    const rBadFlag = runCli("add", "a", "--unknown");
    assert.equal(rBadFlag.code, 2);
    assert.match(rBadFlag.out, /unknown flag --unknown/);

    // 6. Test help output
    const rHelp = runCli("add", "--help");
    assert.equal(rHelp.code, 0);
    assert.match(rHelp.out, /usage: resource-monitor-axi add <ssh-alias>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeArgv routes add command correctly", () => {
  assert.deepEqual(normalizeArgv(["add", "box1"]), ["add", "box1"]);
  assert.deepEqual(normalizeArgv(["add", "--help"]), ["add", "--help"]);
  assert.deepEqual(normalizeArgv(["add"]), ["add"]);
  assert.deepEqual(normalizeArgv(["--config", "cfg.yaml", "add", "box1"]), ["add", "--config", "cfg.yaml", "box1"]);
});
