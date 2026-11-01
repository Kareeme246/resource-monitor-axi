import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseSample } from "./parse.js";
import { REMOTE_SCRIPT } from "./remote-script.js";

/** Short on purpose: unix socket paths top out near 104 bytes. */
const CONTROL_DIR = `/tmp/resource-monitor-axi-${process.getuid?.() ?? "u"}`;
const CONNECT_TIMEOUT_S = 5;
const HARD_TIMEOUT_MS = 15_000;

export function sshArgs(host, { reuse = true, sshConfig = process.env.RESOURCE_MONITOR_AXI_SSH_CONFIG } = {}) {
  const args = [];
  if (sshConfig) args.push("-F", sshConfig);
  args.push(
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=2",
    "-o", "LogLevel=ERROR",
  );
  if (reuse) {
    mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
    // %C hashes host, port and user, so one master serves every tick.
    args.push(
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${join(CONTROL_DIR, "%C")}`,
      "-o", "ControlPersist=120",
    );
  }
  args.push(host, "sh", "-s");
  return args;
}

/** Ask each reused master to exit, so a quit panel leaves no ssh behind. */
export async function closeConnections(hosts, options = {}) {
  const config = options.sshConfig ?? process.env.RESOURCE_MONITOR_AXI_SSH_CONFIG;
  await Promise.all(
    hosts.map(
      (host) =>
        new Promise((resolve) => {
          const args = [
            ...(config ? ["-F", config] : []),
            "-o", `ControlPath=${join(CONTROL_DIR, "%C")}`,
            "-O", "exit",
            host,
          ];
          const child = spawn("ssh", args, { stdio: "ignore" });
          child.on("error", resolve);
          child.on("close", resolve);
        }),
    ),
  );
}

/** One ssh round trip; resolves to a sample or rejects with a short reason. */
export function sampleHost(host, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", sshArgs(host, options), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out"));
    }, options.timeoutMs ?? HARD_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(error.code === "ENOENT" ? "ssh not found" : error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(shortReason(stderr, code)));
      try {
        resolve(parseSample(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(REMOTE_SCRIPT);
  });
}

/** Boil ssh's stderr down to one line a card can show. */
export function shortReason(stderr, code) {
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) return `ssh exited ${code}`;
  const lower = line.toLowerCase();
  if (lower.includes("timed out")) return "connection timed out";
  if (lower.includes("refused")) return "connection refused";
  if (lower.includes("could not resolve")) return "host not found";
  if (lower.includes("no route")) return "no route to host";
  if (lower.includes("permission denied")) return "ssh auth failed";
  if (lower.includes("host key")) return "host key problem";
  return line.replace(/^ssh: /, "").slice(0, 60);
}
