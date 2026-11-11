/**
 * The chart view: block charts per host, in the card view's visual language.
 *
 * One character covers a slice of the window, aligned to the clock so columns
 * stay put between repaints. A closed slice draws its highest reading, so a
 * brief spike is never averaged away. The open slice on the right is live: it
 * draws the latest reading, and takes the slice's peak only when it closes.
 */
import { INTERVALS, WINDOWS } from "./config.js";
import { CARD_WIDTH, HEALTH, HEALTH_BOLD, MIN_CARD_WIDTH, ago, cardsFrame, composeFrame, countsText, firstFit, fit, flow, formatHeaderLine, formatHeaderLines, formatQueryTime, hostLevels, lineWidth, coalesce, shortChip, width, words } from "./render.js";
import { THRESHOLDS, loadPerCore, usageLevel, verdict } from "./verdict.js";

/** Below this width boxes stack; from it they pair up; from the next they sit four across. */
const TWO_ACROSS = 66;
const FOUR_ACROSS = 99;
const CHART_ROWS = 3;
/** The least a chart box shrinks to before the view scrolls: 4 lines, 20% under the roomy box. */
const MIN_CHART_ROWS = 2;
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
/** A quiet stretch shorter than this is the wait for the next sample, not a gap. */
const MIN_GAP_MS = 30_000;

export const gapMsFor = (intervalS) => Math.max(MIN_GAP_MS, intervalS * 2500);

const diskLevel = (free) => (free === undefined ? 0 : free < THRESHOLDS.diskFreeGB.saturated ? 2 : free < THRESHOLDS.diskFreeGB.busy ? 1 : 0);

const METRICS = [
  { key: "cpu", label: "cpu", field: "cpuPct", level: (v) => usageLevel(v, THRESHOLDS.cpu) },
  { key: "mem", label: "memory", field: "memPct", level: (v) => usageLevel(v, THRESHOLDS.mem) },
  { key: "gpu", label: "gpu", field: "gpuPct", level: (v) => usageLevel(v, THRESHOLDS.gpu) },
  { key: "disk", label: "disk", field: "diskPct", level: (_v, s) => diskLevel(s?.diskFreeGB) },
];

/**
 * The columns of one chart: `{v, kind}` per character, oldest first, where kind
 * is "value", "gap" (known to have no reading) or "blank" (before any history).
 * A failed attempt in `points` ends a reading at once, so a dashed baseline
 * starts growing as soon as a host goes away.
 */
export function chartColumns(points, key, { now, windowMs, n, gapMs }) {
  const sliceMs = windowMs / n;
  const current = Math.floor(now / sliceMs);
  const first = current - n + 1;
  const start = first * sliceMs;

  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < start) lo = mid + 1;
    else hi = mid;
  }

  // What the chart knows from just before its first slice.
  let last;
  let seen = false;
  for (let i = lo - 1; i >= 0; i--) {
    if (points[i].down) {
      seen = seen || points.slice(0, i).some((p) => p[key] !== undefined);
      break;
    }
    if (points[i][key] !== undefined) {
      last = { v: points[i][key], t: points[i].t };
      seen = true;
      break;
    }
  }

  const out = [];
  let at = lo;
  for (let slice = first; slice <= current; slice++) {
    const end = (slice + 1) * sliceMs;
    let peak;
    let latest;
    while (at < points.length && points[at].t < end) {
      const p = points[at++];
      if (p.down) {
        last = undefined;
        continue;
      }
      const v = p[key];
      if (v === undefined) continue;
      peak = peak === undefined ? v : Math.max(peak, v);
      latest = v;
      last = { v, t: p.t };
      seen = true;
    }
    if (peak !== undefined) out.push({ v: slice === current ? latest : peak, kind: "value" });
    else if (last && Math.min(end, now) - last.t <= gapMs) out.push({ v: last.v, kind: "value" });
    else out.push({ v: 0, kind: seen ? "gap" : "blank" });
  }
  return out;
}

/** The highest reading inside the window, or undefined. */
export function windowPeak(points, key, now, windowMs) {
  let peak;
  for (let i = points.length - 1; i >= 0 && points[i].t >= now - windowMs; i--) {
    const v = points[i][key];
    if (v !== undefined && (peak === undefined || v > peak)) peak = v;
  }
  return peak;
}

/** The glyph one column draws at chart row `row`, counted from the bottom. */
function cell(column, row, rows) {
  if (column.kind === "blank") return " ";
  if (column.kind === "gap") return row === 0 ? "╌" : " ";
  const eighths = Math.round((Math.min(100, Math.max(0, column.v)) / 100) * rows * 8);
  const filled = Math.max(column.v > 0 ? 1 : 0, eighths);
  // A known zero keeps a baseline, so it never reads as missing data.
  if (filled === 0) return row === 0 ? "▁" : " ";
  const here = filled - row * 8;
  return here <= 0 ? " " : BLOCKS[Math.min(8, here) - 1];
}

function chartRow(columns, row, rows, { dim, level }) {
  return coalesce(
    columns.map((column) => {
      const text = cell(column, row, rows);
      if (text === " ") return { text };
      if (column.kind === "gap") return { text, style: dim ? "borderDim" : "dimmer" };
      if (dim) return { text, style: "dimmer" };
      if (column.v <= 0) return { text, style: "track" };
      return { text, style: HEALTH[level(column.v)] };
    }),
  );
}

function edge(w, [open, close], left, right, border) {
  const lw = left ? width(left.text) : 0;
  const rw = right ? width(right.text) : 0;
  return [
    { text: open, style: border },
    ...(left ? [left] : []),
    { text: "─".repeat(Math.max(1, w - 4 - lw - rw)), style: border },
    ...(right ? [right] : []),
    { text: close, style: border },
  ];
}

const rimmed = (w, segs, border) => [
  { text: "│ ", style: border },
  ...segs,
  { text: " ".repeat(Math.max(0, w - 4 - lineWidth(segs))) },
  { text: " │", style: border },
];

/** What a box title says, longest first; the dim detail gives way first. */
function titleChoices(metric, value, sample) {
  if (value === undefined) return ["?"];
  const pct = `${Math.round(value)}%`;
  if (metric.key === "mem" && sample?.memPressure) return [`${pct} ${sample.memPressure}`, pct];
  if (metric.key === "disk" && sample?.diskFreeGB !== undefined) return [`${pct} · ${sample.diskFreeGB}G free`, `${sample.diskFreeGB}G free`, pct];
  return [pct];
}

function latestValue(points, key) {
  for (let i = points.length - 1; i >= 0; i--) if (points[i][key] !== undefined) return points[i][key];
  return undefined;
}

function chartBox(state, metric, w, rows, { now, windowS, label, intervalS, labels, dim }) {
  const points = state.points ?? [];
  const windowMs = windowS * 1000;
  const border = dim ? "borderDim" : "border";
  const value = state.sample?.[metric.field] ?? latestValue(points, metric.key);
  const level = (v) => metric.level(v, state.sample);
  let valueLevel = level(value ?? 0);
  if (metric.key === "mem") valueLevel = Math.max(valueLevel, { warn: 1, critical: 2 }[state.sample?.memPressure] ?? 0);
  const name = { text: ` ${metric.label} `, style: dim ? "dimmer" : "label" };
  const room = w - 5 - width(name.text);
  const choice = titleChoices(metric, value, state.sample).find((c) => width(c) + 2 <= room) ?? titleChoices(metric, value, state.sample).at(-1);
  const right = { text: ` ${fit(choice, Math.max(1, room - 2))} `, style: dim ? "dimmer" : HEALTH[valueLevel] };
  const lines = [edge(w, ["╭─", "─╮"], name, right, border)];
  const columns = chartColumns(points, metric.key, { now, windowMs, n: w - 4, gapMs: gapMsFor(intervalS) });
  for (let row = rows - 1; row >= 0; row--) lines.push(rimmed(w, chartRow(columns, row, rows, { dim, level }), border));
  if (labels) {
    const peak = windowPeak(points, metric.key, now, windowMs);
    const offFor = state.panelOff && now - state.panelOff.to < windowMs ? ago(state.panelOff.to - state.panelOff.from) : undefined;
    const choices = offFor ? [`panel off for ${offFor}`, `off ${offFor}`] : peak === undefined ? [] : [`peak ${Math.round(peak)}%`];
    const edgeStyle = dim ? "dimmer" : "border";
    const leftEdge = { text: ` ${label} `, style: edgeStyle };
    const text = choices.find((c) => width(c) + 2 + width(leftEdge.text) + 5 <= w);
    const rightEdge = text ? { text: ` ${text} `, style: edgeStyle } : undefined;
    lines.push(edge(w, ["╰─", "─╯"], leftEdge, rightEdge, border));
  } else {
    lines.push([{ text: `╰${"─".repeat(w - 2)}╯`, style: border }]);
  }
  return lines;
}

const statNumber = (n) => (n < 10 ? n.toFixed(1) : `${Math.round(n)}`);

/** The summary row's numbers as flow units: load per core, simulators, xcodebuild. */
function statUnits(s, simCeiling) {
  const units = [];
  const stat = (label, text, style) => units.push({ segs: [{ text: `${label} `, style: "label" }, { text, style }], gap: 2 });
  const perCore = loadPerCore(s);
  if (perCore !== undefined) {
    const lvl = perCore >= THRESHOLDS.load.saturated ? 2 : perCore >= THRESHOLDS.load.busy ? 1 : 0;
    stat("load", `${statNumber(perCore)}x`, HEALTH[lvl]);
  }
  if (s.sims !== undefined) {
    const lvl = s.sims >= simCeiling ? 2 : s.sims > 0 ? 1 : 0;
    stat("sims", `${s.sims}/${simCeiling}`, HEALTH[lvl]);
  }
  if (s.xcodebuild !== undefined) stat("xcodebuild", s.xcodebuild ? `${s.xcodebuild}` : "idle", s.xcodebuild ? "warn" : "dim");
  return units;
}

/** Everything the summary needs about one host, whatever its condition. */
function hostFacts(state, now) {
  const s = state.sample;
  const stale = Boolean(state.error) || !s;
  const lastAt = state.sampledAt ?? state.lastReadingAt;
  const known = lastAt !== undefined;
  if (stale) {
    const status = known ? `stale ${ago(now - lastAt)}` : state.error ? "unreachable" : "waiting";
    const reason = state.error ?? "waiting for first reading";
    const detail = known ? `last reading ${ago(now - lastAt)} ago${state.error ? ", excluded from totals" : ""}` : "no reading yet";
    return { stale, status, reason, detail, reasonStyle: state.error ? "crit" : "dim" };
  }
  const simCeiling = state.simCeiling ?? s.simCeiling ?? THRESHOLDS.simCeiling;
  const v = verdict({ ...s, simCeiling });
  const why = v.level === 0 ? "spare capacity" : v.reasons.join(" · ");
  return { stale, v, why, stats: statUnits(s, simCeiling) };
}

/** The host's section header, unboxed: name, then chip and cores while they fit. */
function hostHeader(state, w, now) {
  const f = hostFacts(state, now);
  const style = f.stale ? "dimBold" : "name";
  const s = state.sample;
  const facts = f.stale
    ? [[f.status]]
    : [[shortChip(s.chip), s.cores ? `${s.cores}c` : ""].filter(Boolean), s.cores ? [`${s.cores}c`] : [], []];
  const dot = `${f.stale ? "○" : "●"} `;
  const room = w - width(dot);
  const tail = (parts) => parts.map((part) => ` · ${part}`).join("");
  const parts = facts.find((p) => width(state.label) + width(tail(p)) <= room) ?? [];
  const rest = tail(parts);
  return [{ text: dot, style }, { text: fit(state.label, room - width(rest)), style }, ...(rest ? [{ text: rest, style: "dim" }] : [])];
}

/** Two spaces before the first word, as between the verdict and its reasons. */
const spaced = (units) => units.map((u, i) => (i ? u : { ...u, gap: 2 }));

/**
 * The status line of a host's section, plain and wrapped, never cut off: the
 * verdict and its reasons, then the short stats, on one row if they fit. It sits
 * under the host title, above the charts.
 */
function hostDetails(state, w, now) {
  const f = hostFacts(state, now);
  const indent = 2;
  let first;
  let second;
  if (f.stale) {
    first = words(`● ${f.reason}`, f.reasonStyle);
    second = words(f.detail, "dimmer");
  } else {
    const level = HEALTH_BOLD[f.v.level];
    first = [{ segs: [{ text: "● ", style: level }, { text: f.v.label, style: level }], gap: 0 }, ...spaced(words(f.why, "dim"))];
    second = f.stats;
  }
  if (!second.length) return flow(first, w, { indent });
  const joined = [...first, { ...second[0], gap: 3 }, ...second.slice(1)];
  const oneRow = flow(joined, w, { indent });
  if (oneRow.length === 1) return oneRow;
  return [...flow(first, w, { indent }), ...flow(second, w, { indent })];
}

/** Join boxes side by side, one space apart. */
function sideBySide(boxes) {
  const height = boxes[0].length;
  const out = [];
  for (let r = 0; r < height; r++) {
    const line = [];
    boxes.forEach((box, i) => {
      if (i) line.push({ text: " " });
      line.push(...box[r]);
    });
    out.push(line);
  }
  return out;
}

const metricsOf = (state) =>
  METRICS.filter((m) => state.sample?.[m.field] !== undefined || (state.points ?? []).some((p) => p[m.key] !== undefined));

function chartHeader(states, { columns, now, allStates }) {
  const monitored = allStates ?? states;
  const live = monitored.filter((st) => st.sample && !st.error).length;
  const stale = monitored.filter((st) => st.error || !st.sample).length;
  const time = formatQueryTime(now);
  const lines = formatHeaderLines({ time, live, stale, columns });
  const toLine = (text) => [{ text: `  ${text}`, style: "dim" }];
  return [...lines.map(toLine), []];
}

/**
 * The chart view as a pinned header and a scrollable body. A host is a section:
 * an unboxed header, its status line, then its charts. A chart box gives up rows
 * only down to its least height, and hosts stack and scroll past it, so a box is
 * never squashed below that and a host is never hidden. Returns null only when
 * the pane is too narrow for a box, which is when the card view's shapes take over.
 */
export function chartsFrame(states, { columns = 80, rows, intervalS = 15, windowS = 3600, now = Date.now(), allStates } = {}) {
  if (columns < MIN_CARD_WIDTH) return null;
  const perRow = columns < TWO_ACROSS ? 1 : columns < FOUR_ACROSS ? 2 : 4;
  const w = perRow === 1 ? Math.min(CARD_WIDTH, columns) : Math.floor((columns - (perRow - 1)) / perRow);
  const label = WINDOWS.find((x) => x.seconds === windowS)?.label ?? `${windowS}s`;
  const metrics = METRICS;

  // Heights are per row of boxes: the disk box stays one row when boxes stack.
  const heightsFor = (chartRows) =>
    perRow === 1 ? [chartRows, chartRows, chartRows, 1] : perRow === 2 ? [chartRows, chartRows] : [chartRows];
  const groupOf = (index) => (perRow === 1 ? index : perRow === 2 ? Math.floor(index / 2) : 0);

  const buildHost = (state, heights) => {
    const present = metricsOf(state);
    const dim = Boolean(state.error) || !state.sample;
    const textWidth = perRow === 1 ? w : columns;
    // The status line sits right under the host title, before its charts.
    const out = [hostHeader(state, textWidth, now), ...hostDetails(state, textWidth, now)];
    const opts = { now, windowS, label, intervalS, labels: true, dim };
    for (let i = 0; i < present.length; i += perRow) {
      if (i > 0) out.push([]);
      const group = present.slice(i, i + perRow);
      const h = heights[groupOf(metrics.indexOf(group[0]))];
      out.push(...sideBySide(group.map((m) => chartBox(state, m, w, h, opts))));
    }
    return out;
  };

  const header = chartHeader(states, { columns, now, allStates });
  // The roomiest boxes the pane holds for one host, else its least boxes, and
  // only below those does the body scroll.
  const roomy = heightsFor(CHART_ROWS);
  const least = heightsFor(MIN_CHART_ROWS);
  const fits = (heights) =>
    rows === undefined || header.length + Math.max(0, ...states.map((state) => buildHost(state, heights).length)) <= rows;
  const heights = fits(roomy) ? roomy : least;

  const body = [];
  states.forEach((state, i) => {
    if (i) body.push([], []);
    body.push(...buildHost(state, heights));
  });
  return { header, body };
}

/** The next stop on a cycle: the first value past `current`, or back to the start. */
export const nextInCycle = (cycle, current) => cycle.find((value) => value > current) ?? cycle[0];

/** The key of every shortcut, showing what `w` and `i` would change to next. */
function keyFooter(view, { columns, intervalS, windowS, toggle }) {
  const labelOf = (seconds) => WINDOWS.find((x) => x.seconds === seconds)?.label ?? `${seconds}s`;
  const nextWindow = nextInCycle(WINDOWS.map((x) => x.seconds), windowS);
  const nextInterval = nextInCycle(INTERVALS, intervalS);
  const keys = [
    ...(toggle ? [["v", toggle]] : []),
    ["c", view === "charts" ? "cards" : "charts"],
    ...(view === "charts" ? [["w", `window ${labelOf(windowS)} → ${labelOf(nextWindow)}`]] : []),
    ["i", `every ${intervalS}s → ${nextInterval}s`],
    ["r", "refresh"],
    ["j k", "scroll"],
    ["space", "page"],
    ["g G", "top/end"],
    ["q", "quit"],
  ];
  const units = keys.map(([key, what]) => ({ segs: [{ text: key, style: "label" }, { text: ` ${what}`, style: "dimmer" }], gap: 2 }));
  return flow(units, Math.max(1, columns - 2)).map((line) => [{ text: "  " }, ...line]);
}

/**
 * One frame of either view. A chart view that cannot fit scrolls its body, or
 * falls back to cards when the pane is too narrow for a chart box. `keys` adds
 * the key of shortcuts under the panels, for a panel that is taking input, and
 * `toggle` names what `v` would switch to, when there is anything to switch to.
 * The key takes no rows of its own: a short pane scrolls down to it.
 * @returns {{text: string, maxScroll: number, scroll: number}}
 */
export function renderFrame(states, { view = "charts", columns = 80, rows, intervalS = 15, windowS = 3600, now = Date.now(), depth = "none", theme = "dark", scroll = 0, keys = false, toggle, allStates } = {}) {
  const footer = keys ? keyFooter(view, { columns, intervalS, windowS, toggle }) : [];
  const charts = view === "charts" ? chartsFrame(states, { columns, rows, intervalS, windowS, now, allStates }) : null;
  const frame = charts ?? cardsFrame(states, { columns, rows, intervalS, now, allStates });
  return composeFrame(frame, { rows, scroll, depth, theme, footer });
}
