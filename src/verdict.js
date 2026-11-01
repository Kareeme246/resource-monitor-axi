/**
 * Spare-capacity verdict for one host. Plain thresholds, no scoring model.
 *
 * Measured on build-box.local (M4 Pro, 14 cores, 24 GB): see README "Where the
 * numbers come from". The simulator ceiling defaults to 2 (the known ceiling on
 * Pro 16) and can be configured per host. The other cut points colour the numbers.
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
 * How loaded a host is, from what its work actually uses: CPU mainly, and GPU.
 * Simulators are a separate question, answered by `simsFree`, and memory, disk
 * and load average are shown but do not move the verdict.
 * @returns {{level: 0|1|2, label: "free"|"busy"|"saturated", reasons: string[], simsFree?: number}}
 */
export function verdict(sample, t = THRESHOLDS) {
  let level = 0;
  const reasons = [];
  const consider = (name, pct, cut) => {
    const at = usageLevel(pct, cut);
    if (!at) return;
    level = Math.max(level, at);
    reasons.push(`${name} ${pct}%`);
  };
  consider("cpu", sample.cpuPct, t.cpu);
  consider("gpu", sample.gpuPct, t.gpu);

  const out = { level, label: LEVELS[level], reasons };
  if (sample.sims !== undefined) {
    out.simsFree = Math.max(0, (sample.simCeiling ?? t.simCeiling ?? 2) - sample.sims);
  }
  return out;
}
