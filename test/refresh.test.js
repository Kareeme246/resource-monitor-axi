import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { applyKey, panel } from "../src/cli.js";

class MockStdout extends EventEmitter {
  constructor() {
    super();
    this.columns = 80;
    this.rows = 24;
    this.isTTY = true;
    this.frames = [];
  }
  write(chunk) {
    if (typeof chunk === "string" && chunk.startsWith("\x1b[H")) {
      this.frames.push(chunk);
    }
    return true;
  }
}

class MockStdin extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
  }
  setRawMode() {}
  resume() {}
  pause() {}
}

test("r triggers an immediate sample across remotes and local, while R does nothing", async () => {
  const stdout = new MockStdout();
  const stdin = new MockStdin();
  const ui = { view: "charts", windowS: 3600, intervalS: 60, scroll: 0, scope: "servers", canToggle: true };

  let remoteSamples = 0;
  let localSamples = 0;
  const remotes = [
    {
      host: "server1",
      label: "server1",
      points: [],
      sampleFn: async () => {
        remoteSamples++;
        return { os: "Darwin", chip: "M4 Pro", cores: 14, cpuPct: 10 + remoteSamples };
      },
    },
  ];
  const local = {
    host: "_local",
    local: true,
    label: "laptop",
    points: [],
    sampleFn: async () => {
      localSamples++;
      return { os: "Darwin", chip: "M4 Pro", cores: 14, cpuPct: 20 + localSamples };
    },
  };

  const p = panel(remotes, local, { theme: "dark", depth: "none", ui, stdout, stdin });

  // Allow initial samples to complete
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(remoteSamples, 1);
  assert.equal(localSamples, 1);

  // Press 'R' (capital) - must do nothing per owner correction
  stdin.emit("data", Buffer.from("R"));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(remoteSamples, 1, "capital R must not refresh remotes");
  assert.equal(localSamples, 1, "capital R must not refresh local");

  // Press 'r' - triggers immediate sampling regardless of 60s interval
  stdin.emit("data", Buffer.from("r"));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(remoteSamples, 2);
  assert.equal(localSamples, 2);

  // Wait a short duration: no extra poll lands because interval (60s) restarted from sample 2
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(remoteSamples, 2);
  assert.equal(localSamples, 2);

  // Quit cleanly
  stdin.emit("data", Buffer.from("q"));
  await p;
});

test("refresh works in both v views (scope local or servers)", async () => {
  const stdout = new MockStdout();
  const stdin = new MockStdin();
  const ui = { view: "charts", windowS: 3600, intervalS: 60, scroll: 0, scope: "local", canToggle: true };

  let remoteCount = 0;
  let localCount = 0;
  const remotes = [
    {
      host: "box",
      label: "box",
      points: [],
      sampleFn: async () => {
        remoteCount++;
        return { os: "Darwin", chip: "M4", cores: 8, cpuPct: 15 };
      },
    },
  ];
  const local = {
    host: "_local",
    local: true,
    label: "laptop",
    points: [],
    sampleFn: async () => {
      localCount++;
      return { os: "Darwin", chip: "M4", cores: 8, cpuPct: 25 };
    },
  };

  const p = panel(remotes, local, { theme: "dark", depth: "none", ui, stdout, stdin });

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(remoteCount, 1);
  assert.equal(localCount, 1);

  // Even though scope is "local", pressing r samples both local and remote
  stdin.emit("data", Buffer.from("r"));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(remoteCount, 2);
  assert.equal(localCount, 2);

  stdin.emit("data", Buffer.from("q"));
  await p;
});

test("a machine with a sample already in flight is not sampled twice", async () => {
  const stdout = new MockStdout();
  const stdin = new MockStdin();
  const ui = { view: "charts", windowS: 3600, intervalS: 60, scroll: 0, scope: "servers" };

  let active = 0;
  let maxActive = 0;
  let callCount = 0;
  let resolveFlight;

  const remotes = [
    {
      host: "box",
      label: "box",
      points: [],
      sampleFn: async () => {
        callCount++;
        active++;
        maxActive = Math.max(maxActive, active);
        if (callCount === 2) {
          await new Promise((r) => (resolveFlight = r));
        }
        active--;
        return { os: "Darwin", chip: "M4", cores: 8, cpuPct: 15 };
      },
    },
  ];

  const p = panel(remotes, null, { theme: "dark", depth: "none", ui, stdout, stdin });

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(callCount, 1);

  // Trigger sample 2, which will pause in flight
  stdin.emit("data", Buffer.from("r"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(callCount, 2);
  assert.equal(active, 1);

  // While sample 2 is in flight, press r and R multiple times
  stdin.emit("data", Buffer.from("r"));
  stdin.emit("data", Buffer.from("R"));
  await new Promise((r) => setTimeout(r, 20));

  // Should still be only 1 active sample and callCount 2
  assert.equal(callCount, 2);
  assert.equal(maxActive, 1);

  // Complete in-flight sample
  resolveFlight();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(callCount, 2);

  stdin.emit("data", Buffer.from("q"));
  await p;
});

test("a slow or unreachable machine does not delay other machines from sampling and redrawing", async () => {
  const stdout = new MockStdout();
  const stdin = new MockStdin();
  const ui = { view: "charts", windowS: 3600, intervalS: 60, scroll: 0, scope: "servers" };

  let slowFinished = false;
  let fastFinished = false;
  let fastDrawnFirst = false;

  const remotes = [
    {
      host: "slow",
      label: "slow",
      points: [],
      sampleFn: async () => {
        await new Promise((r) => setTimeout(r, 120));
        slowFinished = true;
        return { os: "Darwin", chip: "M4", cores: 8, cpuPct: 10 };
      },
    },
    {
      host: "fast",
      label: "fast",
      points: [],
      sampleFn: async () => {
        await new Promise((r) => setTimeout(r, 15));
        fastFinished = true;
        if (!slowFinished) fastDrawnFirst = true;
        return { os: "Darwin", chip: "M4", cores: 8, cpuPct: 30 };
      },
    },
    {
      host: "broken",
      label: "broken",
      points: [],
      sampleFn: async () => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("Connection refused");
      },
    },
  ];

  const p = panel(remotes, null, { theme: "dark", depth: "none", ui, stdout, stdin });

  // Wait for initial round to complete
  await new Promise((r) => setTimeout(r, 160));
  slowFinished = false;
  fastFinished = false;
  fastDrawnFirst = false;

  // Press 'r'
  stdin.emit("data", Buffer.from("r"));

  // Check at 40ms: fast finished and redrew, slow is still working
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fastFinished, true);
  assert.equal(slowFinished, false);
  assert.equal(fastDrawnFirst, true);

  // Wait for slow to finish
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(slowFinished, true);

  stdin.emit("data", Buffer.from("q"));
  await p;
});

test("applyKey handles r and ignores R without repainting immediately", () => {
  const ui = { view: "charts", windowS: 3600, intervalS: 60, scroll: 0 };
  let count = 0;
  assert.equal(applyKey("r", ui, { onRefresh: () => count++ }), false);
  assert.equal(count, 1);
  assert.equal(applyKey("R", ui, { onRefresh: () => count++ }), false, "capital R does nothing");
  assert.equal(count, 1);

  ui.onRefresh = () => count++;
  assert.equal(applyKey("r", ui), false);
  assert.equal(count, 2);
  assert.equal(applyKey("R", ui), false);
  assert.equal(count, 2);
});

test("interactive panel in pseudo-terminal at 60s interval refreshes reading immediately on r", async () => {
  const { spawn } = await import("node:child_process");
  const pyCode = `
import pty, os, subprocess, time, select, tempfile, shutil, fcntl, termios, struct, threading

d = tempfile.mkdtemp()
try:
    bin_dir = os.path.join(d, 'bin')
    os.makedirs(bin_dir)
    ssh_path = os.path.join(bin_dir, 'ssh')
    sample_file = os.path.join(d, 'sample_count')
    with open(sample_file, 'w') as f:
        f.write('0')

    with open(ssh_path, 'w') as f:
        f.write('#!/bin/sh\\ncase "$*" in\\n*-O*exit*) exit 0 ;;\\n*)\\n  cat >/dev/null\\n  cnt=$(cat ' + repr(sample_file) + ')\\n  cnt=$((cnt + 1))\\n  echo "$cnt" > ' + repr(sample_file) + '\\n  printf "os=Darwin\\\\ncores=4\\\\nchip=M4\\\\nload=1 1 1\\\\nmemfree=70\\\\npressure=1\\\\ndisk=1000 500\\\\ngpu=5\\\\nsims=0\\\\nxcodebuild=0\\\\ncpu=10\\\\nend=1\\\\n"\\n;;\\nesac\\n')
    os.chmod(ssh_path, 0o755)

    cfg_path = os.path.join(d, 'config.yaml')
    with open(cfg_path, 'w') as f:
        f.write('hosts:\\n  - ptybox\\nlocal: false\\ninterval: 60\\n')

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    env = dict(os.environ)
    env['PATH'] = f"{bin_dir}:{env['PATH']}"
    env['RESOURCE_MONITOR_AXI_CONFIG'] = cfg_path

    proc = subprocess.Popen(
        ['node', 'bin/resource-monitor-axi.js', '--tui', '--interval', '60'],
        stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True
    )
    os.close(slave)

    stop_drain = False
    chunks = []
    def drain():
        while not stop_drain:
            r, _, _ = select.select([master], [], [], 0.02)
            if r:
                try:
                    c = os.read(master, 4096)
                    if not c: break
                    chunks.append(c)
                except OSError:
                    break

    t = threading.Thread(target=drain)
    t.daemon = True
    t.start()

    # Wait for initial sample
    start = time.time()
    while time.time() - start < 4:
        with open(sample_file, 'r') as f:
            if f.read().strip() == '1':
                break
        time.sleep(0.05)

    # Press 'r' to trigger immediate sample without waiting 60s
    os.write(master, b'r')

    # Wait for refreshed sample
    start = time.time()
    refreshed = False
    while time.time() - start < 4:
        with open(sample_file, 'r') as f:
            if f.read().strip() == '2':
                refreshed = True
                break
        time.sleep(0.05)

    assert refreshed, "Sample count did not reach 2 after pressing r"

    # Press 'q'
    os.write(master, b'q')
    proc.wait(timeout=3)
    stop_drain = True
    os.close(master)
    assert proc.returncode == 0, f"Process exited with {proc.returncode}"
    print("PTY_OK")
finally:
    shutil.rmtree(d, ignore_errors=True)
`;
  const res = await new Promise((resolve) => {
    const cp = spawn("python3", ["-c", pyCode], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    cp.stdout.on("data", (d) => (out += d));
    cp.stderr.on("data", (d) => (err += d));
    cp.on("close", (code) => resolve({ code, out, err }));
  });
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /PTY_OK/);
});
