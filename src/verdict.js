/**
 * Spare-capacity verdict for one host. Plain thresholds, no scoring model.
 *
 * Measured on build-box.local (M4 Pro, 14 cores, 24 GB): see README "Where the
 * thresholds come from". The simulator ceiling defaults to 2 (the known ceiling
 * on Pro 16) and can be configured per host.
 */
export const THRESHOLDS = {
  simCeiling: 2,
  /** smoothed over the last three readings */
  cpu: { busy: 40, saturated: 85 },
  /** 5 minute load average divided by core count */
  load: { busy: 1.0, saturated: 6.0 },
  mem: { busy: 60, saturated: 85 },
  gpu: { busy: 50, saturated: 90 },
  /** free GB on the data volume */
  diskFreeGB: { busy: 30, saturated: 10 },
};

export const LEVELS = ["free", "busy", "saturated"];

/** Health colour of a used-percentage bar, from the same cut points as the verdict. */
export function usageLevel(pct, cut) {
  if (pct === undefined) return 0;
  return pct >= cut.saturated ? 2 : pct >= cut.busy ? 1 : 0;
}

export function loadPerCore(sample) {
  if (sample.load5 === undefined || !sample.cores) return undefined;
  return sample.load5 / sample.cores;
}

/**
 * @returns {{level: 0|1|2, label: "free"|"busy"|"saturated", reasons: string[], simsFree?: number}}
 */
export function verdict(sample, t = THRESHOLDS) {
  let level = 0;
  const reasons = [];
  const raise = (to, reason) => {
    level = Math.max(level, to);
    reasons.push(reason);
  };

  const simCeiling = sample?.simCeiling ?? t.simCeiling ?? 2;
  const sims = sample.sims;
  if (sims !== undefined) {
    if (sims >= simCeiling) raise(2, `${sims} sims, at the ceiling`);
    else if (sims > 0) raise(1, `${sims} sim${sims === 1 ? "" : "s"}`);
  }
  if (sample.xcodebuild > 0) raise(1, `${sample.xcodebuild} xcodebuild`);

  const cpu = usageLevel(sample.cpuPct, t.cpu);
  if (cpu) raise(cpu, `cpu ${sample.cpuPct}%`);
  const perCore = loadPerCore(sample);
  const load = perCore === undefined ? 0 : perCore >= t.load.saturated ? 2 : perCore >= t.load.busy ? 1 : 0;
  if (load) raise(load, `load ${perCore.toFixed(1)}/core`);
  if (sample.memPressure === "critical") raise(2, "memory pressure critical");
  else if (sample.memPressure === "warn") raise(1, "memory pressure warn");
  else {
    const mem = usageLevel(sample.memPct, t.mem);
    if (mem) raise(mem, `memory ${sample.memPct}%`);
  }
  const gpu = usageLevel(sample.gpuPct, t.gpu);
  if (gpu) raise(gpu, `gpu ${sample.gpuPct}%`);
  if (sample.diskFreeGB !== undefined) {
    if (sample.diskFreeGB < t.diskFreeGB.saturated) raise(2, `disk ${sample.diskFreeGB}G left`);
    else if (sample.diskFreeGB < t.diskFreeGB.busy) raise(1, `disk ${sample.diskFreeGB}G left`);
  }

  const out = { level, label: LEVELS[level], reasons };
  if (sims !== undefined) out.simsFree = Math.max(0, simCeiling - sims);
  return out;
}
