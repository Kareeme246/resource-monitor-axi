import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/resource-monitor-axi.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "rma-cli-"));
const fakeBin = join(dir, "bin");
spawnSync("mkdir", ["-p", fakeBin]);
// A stand-in ssh: one host answers with a fixed reading, every other is refused.
writeFileSync(
  join(fakeBin, "ssh"),
  `#!/bin/sh
case "$*" in
*-O*exit*) exit 0 ;;
*blip*) cat >/dev/null
  # Drops once without a word, as a dying shared connection does, then answers.
  if [ ! -e "$BLIP_FILE" ]; then : > "$BLIP_FILE"; exit 255; fi
  printf 'os=Linux\\ncores=2\\ncpu=3\\nend=1\\n' ;;
*silent*) cat >/dev/null; exit 255 ;;
*good*) cat >/dev/null; printf 'os=Darwin\\ncores=14\\nchip=Apple M4 Pro\\nload=1 2 3\\nmemfree=70\\npressure=1\\ndisk=100000000 50000000\\ngpu=5\\nsims=1\\nxcodebuild=0\\ncpu=10\\nend=1\\n' ;;
*) echo 'ssh: connect to host bad port 22: Connection refused' >&2; exit 255 ;;
esac
`,
  { mode: 0o755 },
);
const config = join(dir, "config.json");
writeFileSync(config, JSON.stringify({ hosts: ["good", "bad"], local: false }));

const cli = (...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, RESOURCE_MONITOR_AXI_CONFIG: config, BLIP_FILE: join(dir, "blip"), XDG_STATE_HOME: join(dir, "state") },
  });
  return { out: r.stdout, err: r.stderr, code: r.status };
};

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("no arguments is the home view: bin, description and live data with aggregates", () => {
  const { out, code } = cli();
  assert.equal(code, 0);
  assert.match(out, /^bin: /);
  assert.match(out, /description: /);
  assert.match(out, /count: 2/);
  assert.match(out, /summary: "1 free, 0 busy, 0 saturated, 1 unreachable"/);
  assert.match(out, /hosts\[1\]\{host,verdict,simsFree,reason\}:/);
  assert.match(out, /unreachable\[1\]/);
  assert.match(out, /connection refused/);
  assert.match(out, /help\[\d\]/);
});

test("--fields picks columns, --full shows all, --json is complete", () => {
  assert.match(cli("--fields", "verdict,cpuPct").out, /hosts\[1\]\{host,verdict,cpuPct\}:/);
  assert.match(cli("--full").out, /load5,cores,diskFreeGB/);
  const doc = JSON.parse(cli("--json").out);
  assert.equal(doc.count, 2);
  assert.equal(doc.simsFree, 1);
  assert.equal(doc.hosts[0].cores, 14);
});

test("anything invalid fails loud on stdout with exit 2", () => {
  for (const args of [["--watch"], ["--nope"], ["--fields", "nope"], ["--view", "cards"], ["--once"], ["--interval", "5"], ["--theme", "pink"], ["--tui", "--once", "--view", "nope"], ["--tui", "--json"], ["--tui"], ["nope"], ["init", "x"]]) {
    const { out, err, code } = cli(...args);
    assert.equal(code, 2, args.join(" "));
    assert.match(out, /^error: /, args.join(" "));
    assert.match(out, /code: VALIDATION_ERROR/, args.join(" "));
    assert.equal(err, "", args.join(" "));
  }
});

test("a bad config is a structured failure with exit 1", () => {
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{");
  const { out, code } = cli("--config", bad);
  assert.equal(code, 1);
  assert.match(out, /^error: /);
});

test("--tui --once prints a frame without a terminal, and help comes per command", () => {
  const frame = cli("--tui", "--once");
  assert.equal(frame.code, 0);
  assert.match(frame.out, /● good · M4 Pro · 14c/);
  assert.match(frame.out, /○ bad · unreachable/);
  assert.match(cli("--help").out, /--tui/);
  assert.doesNotMatch(cli("--help").out, /--watch/);
  assert.match(cli("init", "--help").out, /starter config/);
});

test("a connection that drops without a reason recovers, and if it does not, says so plainly", () => {
  const hosts = join(dir, "blip.json");
  writeFileSync(hosts, JSON.stringify({ hosts: ["blip", "silent"], local: false }));
  const doc = JSON.parse(cli("--config", hosts, "--json").out);
  assert.deepEqual(doc.hosts.map((h) => h.host), ["blip"], "one dropped connection is not a host going away");
  assert.equal(doc.unreachable[0].error, "connection lost");
  assert.doesNotMatch(JSON.stringify(doc), /exited/);
});

test("the example config is valid and the package ships it", async () => {
  const { loadConfig } = await import("../src/config.js");
  const example = fileURLToPath(new URL("../config.example.json", import.meta.url));
  assert.equal(loadConfig(example).hosts.length, 3);
});

// These run the real script on this machine. A stand-in sh is not possible: it is sh.
test("this machine is reported apart, with no ssh, and stays out of the remote counts", () => {
  const both = join(dir, "both.json");
  writeFileSync(both, JSON.stringify({ hosts: ["bad"], local: { label: "laptop" } }));
  const doc = JSON.parse(cli("--config", both, "--json").out);
  assert.equal(doc.local.host, "laptop");
  assert.ok(["free", "busy", "saturated"].includes(doc.local.verdict));
  assert.equal(typeof doc.local.cores, "number");
  assert.equal(doc.count, 1);
  assert.match(doc.summary, /^0 free, 0 busy, 0 saturated, 1 unreachable$/, "no remote reachable leaves this machine reporting");
  const toon = cli("--config", both).out;
  assert.match(toon, /local:\n {2}host: laptop\n {2}verdict: /);
  assert.match(toon, /hosts: \[\]/);
});

test("a config with no remote hosts says so, and the panel frame shows this machine", () => {
  const solo = join(dir, "solo.json");
  writeFileSync(solo, JSON.stringify({ local: { label: "laptop" } }));
  const r = cli("--config", solo);
  assert.equal(r.code, 0);
  assert.match(r.out, /count: 0/);
  assert.match(r.out, /hosts: \[\]/);
  assert.match(r.out, /No remote hosts configured/);
  assert.match(cli("--config", solo, "--tui", "--once").out, /● laptop \(local\) · /);
});
