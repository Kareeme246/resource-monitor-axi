/**
 * Plain-text card panel in quota-axi's visual language: rounded boxes, thin
 * `━` bars on a `─` track, muted labels, a dim header. Cards are text, so the
 * layout simply reflows: as many columns as the width allows, and tighter card
 * shapes when the height runs short.
 */
import { THRESHOLDS, loadPerCore, usageLevel, verdict } from "./verdict.js";

export const CARD_WIDTH = 49;
export const MIN_CARD_WIDTH = 30;
const GUTTER = 2;
const LABEL_WIDTH = 8;

/** Catppuccin Mocha / Latte, the same palette quota-axi draws with. */
const PALETTES = {
  dark: {
    dim: [[127, 132, 156], "90"],
    dimmer: [[88, 91, 112], "90"],
    dimBold: [[127, 132, 156], "90", true],
    label: [[166, 173, 200], "37"],
    ok: [[166, 227, 161], "32"],
    okBold: [[166, 227, 161], "32", true],
    warn: [[249, 226, 175], "33"],
    warnBold: [[249, 226, 175], "33", true],
    crit: [[243, 139, 168], "31"],
    critBold: [[243, 139, 168], "31", true],
    track: [[69, 71, 90], "90"],
    border: [[88, 91, 112], "90"],
    borderDim: [[49, 50, 68], "2;90"],
    name: [[137, 180, 250], "94", true],
  },
  light: {
    dim: [[124, 127, 147], "90"],
    dimmer: [[132, 136, 154], "90"],
    dimBold: [[124, 127, 147], "90", true],
    label: [[108, 111, 133], "37"],
    ok: [[52, 150, 30], "32"],
    okBold: [[52, 150, 30], "32", true],
    warn: [[188, 108, 0], "33"],
    warnBold: [[188, 108, 0], "33", true],
    crit: [[200, 8, 50], "31"],
    critBold: [[200, 8, 50], "31", true],
    track: [[188, 192, 204], "90"],
    border: [[172, 176, 190], "90"],
    borderDim: [[192, 196, 208], "2;90"],
    name: [[30, 102, 245], "94", true],
  },
};

export const HEALTH = ["ok", "warn", "crit"];
export const HEALTH_BOLD = ["okBold", "warnBold", "critBold"];

/** Honors NO_COLOR, TERM=dumb and non-TTY output; FORCE_COLOR re-enables. */
export function detectColorDepth(env, isTty) {
  const force = env.FORCE_COLOR;
  const forced = force !== undefined && force !== "0";
  if (!forced && (env.NO_COLOR !== undefined || env.TERM === "dumb" || !isTty)) return "none";
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "") || force === "3") return "truecolor";
  if ((env.TERM ?? "").includes("256color") || force === "2") return "256";
  return "16";
}

function rgbTo256([r, g, b]) {
  if (r === g && g === b) return r < 8 ? 16 : r > 248 ? 231 : 232 + Math.round(((r - 8) / 247) * 24);
  const level = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40)));
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

function sgr(style, depth, theme) {
  const [rgb, ansi16, bold] = PALETTES[theme][style];
  const codes = bold ? ["1"] : [];
  if (depth === "truecolor") codes.push(`38;2;${rgb.join(";")}`);
  else if (depth === "256") codes.push(`38;5;${rgbTo256(rgb)}`);
  else codes.push(ansi16);
  return codes.join(";");
}

export function paint(line, { depth = "none", theme = "dark" }) {
  return line
    .map(({ text, style }) =>
      depth === "none" || !style ? text : `\x1b[${sgr(style, depth, theme)}m${text}\x1b[0m`,
    )
    .join("");
}

export const width = (text) => [...text].length;
export const fit = (text, w) => {
  if (w <= 0) return "";
  const chars = [...text];
  return chars.length <= w ? text : `${chars.slice(0, Math.max(0, w - 1)).join("")}…`;
};
export const padEnd = (text, w) => text + " ".repeat(Math.max(0, w - width(text)));
export const lineWidth = (line) => line.reduce((sum, seg) => sum + width(seg.text), 0);

/** Text as flow units: each word stays whole and keeps its style. */
export const words = (text, style) =>
  text.split(/\s+/).filter(Boolean).map((word) => ({ segs: [{ text: word, style }], gap: 1 }));

/**
 * Lay units out left to right, wrapping onto further lines instead of clipping.
 * Later lines start at `indent`; `gap` is the space a unit wants before it. A
 * unit wider than a whole line is broken, so nothing is ever lost.
 */
export function flow(units, w, { indent = 0 } = {}) {
  const room = Math.max(1, w - indent);
  const lines = [[]];
  let used = 0;
  const place = (segs, gap) => {
    const size = lineWidth(segs);
    const fresh = lines.length > 1 ? used === indent : used === 0;
    if (!fresh && used + gap + size > w) {
      lines.push(indent ? [{ text: " ".repeat(indent) }] : []);
      used = indent;
    } else if (!fresh && gap) {
      lines.at(-1).push({ text: " ".repeat(gap) });
      used += gap;
    }
    lines.at(-1).push(...segs);
    used += size;
  };
  for (const { segs, gap = 1 } of units) {
    if (lineWidth(segs) <= room) {
      place(segs, gap);
      continue;
    }
    for (const seg of segs) {
      const chars = [...seg.text];
      for (let i = 0; i < chars.length; i += room) {
        place([{ ...seg, text: chars.slice(i, i + room).join("") }], i === 0 ? gap : 0);
      }
    }
  }
  return lines;
}

/** Quiet-ledger thin bar: fill at half-cell resolution on a dim track. */
export function thinBar(pct, w, style) {
  const fill = pct === undefined ? 0 : Math.min(100, Math.max(0, pct));
  let halves = Math.round((fill / 100) * w * 2);
  if (fill > 0 && halves === 0) halves = 1;
  if (fill < 100 && halves === w * 2) halves = w * 2 - 1;
  const segs = [];
  for (let i = 0; i < w; i++) {
    const h = Math.min(2, Math.max(0, halves - i * 2));
    segs.push(h === 2 ? { text: "━", style } : h === 1 ? { text: "╸", style } : { text: "─", style: "track" });
  }
  return coalesce(segs);
}

export function coalesce(segs) {
  const out = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (last && last.style === seg.style) last.text += seg.text;
    else out.push({ ...seg });
  }
  return out;
}

export function trimRight(line) {
  const out = line.map((s) => ({ ...s }));
  while (out.length) {
    const last = out[out.length - 1];
    if (last.style === undefined) last.text = last.text.replace(/ +$/, "");
    if (last.text === "") out.pop();
    else break;
  }
  return out;
}

function titleLine(w, name, right, border) {
  let r = right ? ` ${right} ` : "";
  let dashes = w - 4 - width(name.text) - width(r);
  if (dashes < 1 && right) {
    const maxR = w - 5 - width(name.text) - 2;
    if (maxR >= 3) {
      r = ` ${fit(right, maxR)} `;
      dashes = w - 4 - width(name.text) - width(r);
    } else {
      r = "";
      dashes = w - 4 - width(name.text);
    }
  }
  if (dashes < 1) {
    const maxName = Math.max(1, w - 5 - 4);
    name = { ...name, text: ` ${name.text.trim().slice(0, 1)} ${fit(name.text.trim().slice(2), maxName)} ` };
    dashes = Math.max(1, w - 4 - width(name.text));
  }
  return [
    { text: "╭─", style: border },
    name,
    { text: "─".repeat(Math.max(1, dashes)), style: border },
    ...(r ? [{ text: r, style: "dim" }] : []),
    { text: "─╮", style: border },
  ];
}

const bottomLine = (w, border) => [{ text: `╰${"─".repeat(w - 2)}╯`, style: border }];

function interior(w, content, border) {
  const pad = Math.max(0, w - 2 - lineWidth(content));
  return [{ text: "│", style: border }, ...content, { text: " ".repeat(pad) }, { text: "│", style: border }];
}

export function shortChip(chip) {
  return (chip ?? "").replace(/^Apple /, "").replace(/\(R\)|\(TM\)/g, "").replace(/\s+/g, " ").trim();
}

/** One metric row: label, thin bar, percent, dim detail. */
function barRow(w, label, pct, { level = 0, text, detail = "", dim = false }) {
  // The dim detail column gives way first when the card gets narrow.
  const dw = w >= 44 ? 9 : w >= 36 ? 6 : 0;
  if (dw < 9) detail = detail.replace(" free", "");
  const pctText = text ?? (pct === undefined ? "?" : `${Math.min(999, Math.round(pct))}%`);
  const tw = Math.max(4, pctText.length);
  const bar = Math.max(4, w - 2 - 3 - LABEL_WIDTH - 1 - tw - 1 - dw - (dw ? 1 : 0));
  const style = dim ? "dimmer" : HEALTH[level];
  return [
    { text: "   " },
    { text: padEnd(label, LABEL_WIDTH), style: dim ? "dimmer" : "label" },
    ...thinBar(pct, bar, dim ? "dimmer" : style),
    { text: " " },
    { text: pctText.padStart(tw), style: pct === undefined && text === undefined ? "dim" : style },
    ...(dw
      ? [
          { text: " " },
          { text: padEnd(fit(detail, dw), dw), style: dim ? "dimmer" : "dim" },
        ]
      : []),
  ];
}

function textRow(w, label, value, valueStyle = "dim", dim = false) {
  return [
    { text: "   " },
    { text: padEnd(label, LABEL_WIDTH), style: dim ? "dimmer" : "label" },
    { text: fit(value, w - 2 - 3 - LABEL_WIDTH - 1), style: dim ? "dimmer" : valueStyle },
  ];
}

/** The metric rows a sample supports, in a fixed order. */
function metricRows(w, s, dim, t = THRESHOLDS) {
  const rows = [];
  if (s.cpuPct !== undefined) {
    rows.push(barRow(w, "cpu", s.cpuPct, { level: usageLevel(s.cpuPct, t.cpu), dim }));
  }
  if (s.memPct !== undefined) {
    const pressureLevel = { normal: 0, warn: 1, critical: 2 }[s.memPressure] ?? 0;
    const level = Math.max(pressureLevel, usageLevel(s.memPct, t.mem));
    rows.push(
      barRow(w, "memory", s.memPct, {
        level,
        detail: s.memPressure === "critical" ? "crit" : (s.memPressure ?? ""),
        dim,
      }),
    );
  }
  if (s.gpuPct !== undefined) {
    rows.push(
      barRow(w, "gpu", s.gpuPct, {
        level: usageLevel(s.gpuPct, t.gpu),
        dim,
      }),
    );
  }
  if (s.diskPct !== undefined) {
    const free = s.diskFreeGB;
    const level = free < t.diskFreeGB.saturated ? 2 : free < t.diskFreeGB.busy ? 1 : 0;
    rows.push(barRow(w, "disk", s.diskPct, { level, detail: `${free}G free`, dim }));
  }
  const perCore = loadPerCore(s);
  if (perCore !== undefined) {
    // Load is shown per core ("0.2x"), full bar at one runnable thread per core.
    const lvl = perCore >= t.load.saturated ? 2 : perCore >= t.load.busy ? 1 : 0;
    rows.push(
      barRow(w, "load 5m", perCore * 100, {
        level: lvl,
        text: `${perCore < 10 ? perCore.toFixed(1) : Math.round(perCore)}x`,
        detail: `${s.load5 < 10 ? s.load5.toFixed(1) : Math.round(s.load5)}/${s.cores}c`,
        dim,
      }),
    );
  }
  if (s.sims !== undefined) {
    const simCeiling = s.simCeiling ?? t.simCeiling ?? 2;
    const ratio = (s.sims / simCeiling) * 100;
    rows.push(
      barRow(w, "sims", ratio, {
        level: s.sims >= simCeiling ? 2 : s.sims > 0 ? 1 : 0,
        text: `${s.sims}/${simCeiling}`,
        dim,
      }),
    );
  }
  if (s.xcodebuild !== undefined) {
    rows.push(
      textRow(w, "builds", s.xcodebuild === 0 ? "no xcodebuild" : `${s.xcodebuild} xcodebuild`, s.xcodebuild ? "warn" : "dim", dim),
    );
  }
  return rows;
}

/** The verdict and its reasons, wrapped so no reason is ever cut off. */
function verdictRows(w, v, dim) {
  const detail = v.level === 0 ? "spare capacity" : v.reasons.join(" · ");
  const style = dim ? "dimmer" : HEALTH_BOLD[v.level];
  const head = { segs: [{ text: "● ", style }, { text: v.label, style }], gap: 0 };
  const units = [head, ...words(detail, dim ? "dimmer" : "dim").map((u, i) => (i ? u : { ...u, gap: 2 }))];
  const indent = Math.min(2 + v.label.length + 2, 8);
  return flow(units, w - 2 - 3 - 1, { indent }).map((line) => [{ text: "   " }, ...line]);
}

/** Whole seconds as `42s`, `3m`, `2h`. */
export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/**
 * A host card in one of three shapes: "full" (blank padding rows like
 * quota-axi), "tight" (no padding) and "line" (one row, for very short panes).
 * `state` is `{label, sample?, error?, sampledAt?}`; a host with an `error` is
 * stale: its last reading, if any, is drawn dim under the failure.
 */
export function buildCard(state, w, shape, now) {
  const stale = Boolean(state.error) || !state.sample;
  const s = state.sample;
  const simCeiling = state.simCeiling ?? s?.simCeiling ?? THRESHOLDS.simCeiling;
  const t = { ...THRESHOLDS, simCeiling };
  const sampleWithCeiling = s ? { ...s, simCeiling } : undefined;
  const v = sampleWithCeiling && !stale ? verdict(sampleWithCeiling, t) : undefined;
  const name = state.label;

  if (shape === "line") return lineCard(state, v, w, now);

  const border = stale ? "borderDim" : "border";
  const dot = stale ? "○" : "●";
  const right = stale
    ? state.sample
      ? `stale ${ago(now - state.sampledAt)}`
      : state.error
        ? "unreachable"
        : "waiting"
    : w >= 40
      ? [shortChip(s.chip), s.cores ? `${s.cores}c` : ""].filter(Boolean).join(" · ")
      : s.cores
        ? `${s.cores}c`
        : "";
  const rWidth = right ? width(right) + 2 : 0;
  const maxNameWidth = Math.max(4, w - 9 - rWidth);
  const nameSeg = {
    text: ` ${dot} ${fit(name, maxNameWidth)} `,
    style: stale ? "dimBold" : "name",
  };
  const pad = shape === "full";
  const lines = [titleLine(w, nameSeg, right, border)];
  const row = (content) => interior(w, content, border);
  if (pad) lines.push(row([]));

  if (stale) {
    if (s) lines.push(...metricRows(w, sampleWithCeiling, true, t).map(row));
    const msg = state.error ?? "waiting for first reading";
    if (s) lines.push(row([]));
    const room = Math.max(1, w - 6);
    const pushWrapped = (units, indent) =>
      lines.push(...flow(units, room, { indent }).map((line) => row([{ text: "   " }, ...line])));
    pushWrapped(words(`● ${msg}`, state.error ? "crit" : "dim"), 2);
    const staleMsg = s ? `last reading ${ago(now - state.sampledAt)} ago, excluded from totals` : "no reading yet";
    pushWrapped(words(staleMsg, "dimmer"), 0);
  } else {
    lines.push(...metricRows(w, sampleWithCeiling, false, t).map(row));
    if (pad) lines.push(row([]));
    lines.push(...verdictRows(w, v, false).map(row));
  }
  if (pad) lines.push(row([]));
  lines.push(bottomLine(w, border));
  return lines;
}

function lineCard(state, v, w, now) {
  const s = state.sample;
  const stale = Boolean(state.error) || !s;
  const dim = stale;
  const bits = [];
  const simCeiling = state.simCeiling ?? s?.simCeiling ?? THRESHOLDS.simCeiling;
  if (s?.cpuPct !== undefined) bits.push(`cpu ${s.cpuPct}%`);
  if (s?.memPct !== undefined) bits.push(`mem ${s.memPct}%`);
  if (s?.sims !== undefined) bits.push(`${s.sims}/${simCeiling} sims`);
  const status = stale ? (state.error ? "unreachable" : "waiting") : v.label;
  const style = stale ? "dimBold" : HEALTH_BOLD[v.level];
  const lw = w >= 27 ? 14 : Math.max(4, Math.min(14, Math.floor((w - 2) / 2)));
  const sw = w >= 27 ? 11 : Math.max(4, w - 2 - lw);
  const head = [
    { text: `${stale ? "○" : "●"} `, style },
    { text: padEnd(fit(state.label, lw), lw), style: stale ? "dimBold" : "name" },
    { text: padEnd(fit(status, sw), sw), style },
  ];
  const tail = stale && s ? `stale ${ago(now - state.sampledAt)}` : bits.join(" · ");
  // The columns stay aligned; the tail wraps beneath them rather than clip.
  const units = [{ segs: head, gap: 0 }, ...words(tail, dim ? "dimmer" : "dim").map((u, i) => (i ? u : { ...u, gap: 0 }))];
  return flow(units, w, { indent: 2 });
}

function layout(cards, w, columns) {
  const cols = Math.max(1, Math.floor((columns + GUTTER) / (w + GUTTER)));
  const out = [];
  for (let i = 0; i < cards.length; i += cols) {
    const group = cards.slice(i, i + cols);
    const height = Math.max(...group.map((c) => c.length));
    for (let r = 0; r < height; r++) {
      const line = [];
      group.forEach((card, idx) => {
        const cell = card[r] ?? [];
        line.push(...cell);
        if (idx < group.length - 1) line.push({ text: " ".repeat(Math.max(0, w + GUTTER - lineWidth(cell))) });
      });
      out.push(line);
    }
    if (i + cols < cards.length) out.push([]);
  }
  return out;
}

/** The fleet counts, without the zeros when the full list does not fit. */
export function countsText(levels, stale, room) {
  const counts = [0, 1, 2].map((lvl) => [levels.filter((x) => x === lvl).length, ["free", "busy", "saturated"][lvl]]);
  counts.push([stale, "stale"]);
  const all = counts.map(([n, name]) => `${n} ${name}`).join(" · ");
  if (width(all) <= room) return all;
  return counts.filter(([n]) => n > 0).map(([n, name]) => `${n} ${name}`).join(" · ");
}

/** The first of `choices` that fits, or the last one cut to fit. */
export const firstFit = (choices, room) => choices.find((c) => width(c) <= room) ?? fit(choices.at(-1), room);

/** The fleet summary: one dim line when it fits, otherwise two. */
function headerLines(states, v, intervalS, now, columns) {
  const stale = states.filter((st) => st.error || !st.sample).length;
  const counts = [0, 1, 2].map((lvl) => `${v.filter((x) => x === lvl).length} ${["free", "busy", "saturated"][lvl]}`);
  counts.push(`${stale} stale`);
  const time = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const room = columns - 2;
  const one = ["resource-monitor-axi", time, `${intervalS}s`, ...counts].join(" · ");
  if (width(one) <= room) return [one];
  const top = ["resource-monitor-axi", time, `every ${intervalS}s`];
  return [
    firstFit([top.join(" · "), ["resource-monitor-axi", time, `${intervalS}s`].join(" · "), [time, `every ${intervalS}s`].join(" · ")], room),
    countsText(v, stale, room),
  ];
}

/** The verdict levels of the hosts that count towards the totals. */
export function hostLevels(states) {
  return states
    .map((st) => {
      if (!st.sample || st.error) return undefined;
      const simCeiling = st.simCeiling ?? st.sample.simCeiling ?? THRESHOLDS.simCeiling;
      return verdict({ ...st.sample, simCeiling }).level;
    })
    .filter((l) => l !== undefined);
}

/**
 * The card view as a pinned header and a scrollable body. Picks the roomiest
 * card shape whose total height fits.
 */
export function cardsFrame(states, { columns = 80, rows, intervalS = 15, now = Date.now() } = {}) {
  const w = Math.max(MIN_CARD_WIDTH, Math.min(CARD_WIDTH, columns));
  const header = headerLines(states, hostLevels(states), intervalS, now, columns).map((text) => [{ text: `  ${text}`, style: "dim" }]);

  const build = (shape) => layout(states.map((st) => buildCard(st, w, shape, now)), w, columns);
  // The one-row shape is a plain list, so it bypasses the box layout.
  const lineRows = () => states.flatMap((st) => buildCard(st, Math.max(1, columns - 2), "line", now).map((line) => [{ text: "  " }, ...line]));

  let body;
  const shapes = columns < MIN_CARD_WIDTH ? ["line"] : ["full", "tight", "line"];
  for (const shape of shapes) {
    const candidate = shape === "line" ? lineRows() : build(shape);
    body = candidate;
    if (rows === undefined || candidate.length + header.length + 1 <= rows) break;
  }
  return { header: [...header, []], body };
}

/**
 * Fit a pinned header and a body to the pane. A body taller than the pane
 * scrolls, and the last header line with text says how much is out of sight.
 * @returns {{text: string, maxScroll: number, scroll: number}}
 */
export function composeFrame({ header, body }, { columns = 80, rows, scroll = 0, depth = "none", theme = "dark", footer = [] } = {}) {
  const view = rows === undefined ? body.length : Math.max(1, rows - header.length);
  const maxScroll = Math.max(0, body.length - view);
  const top = Math.min(Math.max(0, scroll), maxScroll);
  let head = header;
  if (maxScroll > 0) {
    const marks = [top > 0 ? `↑${top}` : "", top < maxScroll ? `↓${maxScroll - top}` : ""].filter(Boolean).join(" ");
    const suffix = ` · ${marks}`;
    const at = header.findLastIndex((line) => line.length > 0);
    if (at >= 0) {
      const text = header[at].map((seg) => seg.text).join("");
      const room = Math.max(0, columns - width(suffix));
      // Counts of zero go first, then the name, so the numbers that matter stay whole.
      const noZeros = text.replace(/(?<= )0 (free|busy|saturated|stale)( · )?/g, "").replace(/ · $/, "");
      const short = width(noZeros) <= room ? noZeros : noZeros.replace("resource-monitor-axi · ", "");
      head = header.with(at, [{ text: `${width(text) <= room ? text : fit(short, room)}${suffix}`, style: "dim" }]);
    }
  }
  const lines = [...head, ...body.slice(top, top + view)];
  const limited = rows === undefined ? lines : lines.slice(0, rows);
  // The key stays on the pane's very last rows, however little the body fills.
  const padding = rows === undefined || !footer.length ? [] : Array.from({ length: Math.max(0, rows - limited.length) }, () => []);
  const all = [...limited, ...padding, ...footer];
  return { text: all.map((line) => paint(trimRight(line), { depth, theme })).join("\n"), maxScroll, scroll: top };
}

/** Render the card panel for `states`, sized to `columns` x `rows` (rows optional). */
export function renderPanel(states, { columns = 80, rows, intervalS = 15, now = Date.now(), depth = "none", theme = "dark", scroll = 0 } = {}) {
  return composeFrame(cardsFrame(states, { columns, rows, intervalS, now }), { columns, rows, scroll, depth, theme }).text;
}
