/** Turn the remote script's `key=value` lines into one typed sample. */

const num = (value) => {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const round = (n, places = 0) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

const clampPct = (n) => Math.min(100, Math.max(0, n));

/** macOS levels from kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical. */
function macPressure(level, freePct) {
  if (level === 4) return "critical";
  if (level === 2) return "warn";
  if (level === 1) return "normal";
  if (freePct === undefined) return undefined;
  return freePct < 10 ? "critical" : freePct < 25 ? "warn" : "normal";
}

/** Linux has no level; use PSI stall time when the kernel exposes it, else available memory. */
function linuxPressure(psi, freePct) {
  if (psi !== undefined) return psi >= 20 ? "critical" : psi >= 5 ? "warn" : "normal";
  if (freePct === undefined) return undefined;
  return freePct < 5 ? "critical" : freePct < 15 ? "warn" : "normal";
}

export function parseSample(text) {
  const kv = new Map();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) kv.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const os = kv.get("os");
  if (!os || kv.get("end") !== "1") {
    throw new Error("incomplete reading from host");
  }

  const cores = num(kv.get("cores"));
  const [load1, load5, load15] = (kv.get("load") ?? "")
    .split(/\s+/)
    .map(num)
    .filter((n) => n !== undefined);
  const freePct = num(kv.get("memfree"));
  const [diskTotalK, diskFreeK] = (kv.get("disk") ?? "").split(/\s+/).map(num);
  const mac = os === "Darwin";
  const gpuRaw = num(kv.get("gpu"));

  const sample = {
    os,
    chip: kv.get("chip") || kv.get("model") || undefined,
    cores,
    cpuPct: num(kv.get("cpu")) === undefined ? undefined : round(clampPct(num(kv.get("cpu")))),
    load1,
    load5,
    load15,
    memPct: freePct === undefined ? undefined : round(clampPct(100 - freePct)),
    memPressure: mac
      ? macPressure(num(kv.get("pressure")), freePct)
      : linuxPressure(num(kv.get("psi")), freePct),
    swapMB: num((kv.get("swap") ?? "").replace(/M$/, "")),
    diskPct:
      diskTotalK && diskFreeK !== undefined ? round(clampPct(100 - (diskFreeK * 100) / diskTotalK)) : undefined,
    diskFreeGB: diskFreeK === undefined ? undefined : round(diskFreeK / 1024 / 1024),
    gpuPct: gpuRaw === undefined ? undefined : round(clampPct(gpuRaw)),
    sims: mac ? num(kv.get("sims")) : undefined,
    xcodebuild: mac ? num(kv.get("xcodebuild")) : undefined,
  };
  for (const key of Object.keys(sample)) {
    if (sample[key] === undefined) delete sample[key];
  }
  return sample;
}
