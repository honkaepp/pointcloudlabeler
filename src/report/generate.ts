// HTML report generator — turns the project's analytics caches into
// a single self-contained .html file the forester can save, e-mail,
// or print as PDF from the browser. Every chart is an inline SVG so
// the report renders the same on any machine without external assets;
// every byte travels in one file.
//
// Input data is the same TreeMetric / QsmResult / DensityMetricsResult
// the other panels already consume. The generator never calls the
// backend itself — callers wire in whatever caches they have.

import { version as APP_VERSION } from '../../package.json';
import { PRODUCT_NAME } from '../components/PointCloudLabelerLogo';
import { countRefined, treeStats } from '../metrics/plotStats';
import type { TreeMetric, QsmResult, TreeQsm, DensityMetricsResult } from '../persistence/octreeReader';
import { median, mean, stdDev as sd } from '../metrics/stats';

export interface ReportInputs {
  /** Project / plot name shown on the cover. */
  projectName: string;
  /** Optional plot description (one or two short lines). */
  description?: string;
  /** Plot area in hectares — whichever basis the caller resolved (see
   *  plotAreaBasis for which one). */
  plotAreaHa: number;
  /** Which measurement produced plotAreaHa. Every per-hectare figure in
   *  this report (stems/ha, basal area/ha, stem volume/ha, biomass t/ha,
   *  revenue per ha) divides by this same number, so one flag next to
   *  "Plot area" is enough to tell the reader whether it's a measured
   *  plot or a rough guess, instead of every card quietly claiming the
   *  same precision. */
  plotAreaBasis: 'boundary' | 'bbox' | 'manual';
  /** Active dataset's CRS / source-coord units, just for the header. */
  crsLabel?: string;
  metrics: TreeMetric[];
  qsm: QsmResult | null;
  density: DensityMetricsResult | null;
  /** Species defaults from the Bucking panel for the revenue line. */
  bucking?: {
    /** Uniform-grade price per m³, used when bucking wasn't computed
     *  per-tree. The reporter currently quotes a uniform price (the
     *  full bucking breakdown comes out of the Bucking panel's CSV
     *  separately); keeping this simple makes the headline robust. */
    unitPrice: number;
    /** Which currency that price — and the revenue figure derived from
     *  it — are in. The report is a client-facing deliverable, so a
     *  number carrying the wrong currency is a false statement about
     *  money, not a cosmetic slip. See metrics/currency.ts; the caller
     *  passes the user's setting and never a default of its own. */
    currency: string;
  };
  /** Species-aware biomass block. Every number here is already computed
   *  per-tree by the caller (each tree used its own assigned species'
   *  density, or the caller's fallback when unassigned) and summed —
   *  the generator only renders them, it never assumes one species for
   *  the whole plot. Undefined ⇒ no biomass / carbon section. */
  biomass?: {
    /** Per-species tree counts behind the totals below, richest first. */
    speciesMix: { label: string; treeCount: number }[];
    /** Trees with no species assignment that used the fallback instead
     *  — must always be shown next to the numbers, never absorbed
     *  silently into a claimed single-species result. */
    fallbackCount: number;
    fallbackLabel: string;
    /** Basic density, kg/m³, the unassigned trees were computed at.
     *
     *  Biomass is ρ·V and carbon a fraction of that, so ρ is the largest
     *  single assumption behind every tonne on this page — and a reader
     *  cannot check the figure, or compare it with another plot, without
     *  knowing it. The report named the species and never the number. */
    fallbackDensity?: number;
    /** Where that density came from — the preset's own provenance
     *  string ("Repola 2006 / Kärkkäinen 2007"). Undefined when the
     *  analyst supplied the figure, which is the normal case outside
     *  the boreal zone: the report then says so instead of crediting a
     *  Finnish wood-density paper for a number it had nothing to do
     *  with. A citation nobody can follow back is worse than none. */
    fallbackSource?: string;
    biomassKg: number;
    biomassKgCi95: number;
    carbonKg: number;
    carbonKgCi95: number;
    co2eKg: number;
    co2eKgCi95: number;
  };
  /** When true, the cover lists the field-data validation block. */
  fieldValidation?: {
    nMatched: number;
    biasCm: number;
    rmseCm: number;
    r2: number;
  };
  /** Per-tree growth between two epochs, from the Tree Growth panel's
   *  already-computed summary. Undefined ⇒ no growth block. */
  growth?: {
    years: number;
    nMatched: number;
    meanDbhGrowthCmPerYear: number;
    meanHeightGrowthMPerYear: number;
    volumeChangeM3: number;
    harvested: number;
    ingrowth: number;
  };
  /** Per-point surface change vs. a reference epoch, from the M3C2 panel's
   *  already-computed summary. Undefined ⇒ no M3C2 block. */
  m3c2?: {
    referenceName: string;
    corePoints: number;
    significantPct: number;
    meanChangeCm: number;
    medianChangeCm: number;
  };
  /** Measured stem-taper profiles, one entry per stem the forester picked
   *  in the Stem Taper panel. Undefined / empty ⇒ no taper block. */
  taper?: {
    label: string;
    dbhCm: number;
    heightM: number;
    stemVolumeM3: number;
    sawlogM3: number;
    pulpwoodM3: number;
  }[];
}

export interface PlotStats {
  /** Every segmented tree in the plot. A tree is a tree whether or not
   *  every attribute could be measured on it. */
  treeCount: number;
  /** How many of them the diameter statistics rest on. */
  nWithDbh: number;
  /** How many the height statistics rest on. */
  nWithHeight: number;
  /** How many diameters came from the RANSAC stem fit rather than the
   *  algebraic circle over the whole breast-height band. The report is
   *  the document a stand gets measured by, so it has to say which of the
   *  two measurements produced the number — not just quote it. */
  nRefinedDbh: number;
  mean: { dbh: number; height: number; basalArea: number; crownArea: number };
  sd: { dbh: number; height: number };
  median: { dbh: number; height: number };
  loreyMeanHeight: number;     // basal-area weighted
  dominantHeight: number;      // mean of top 10 % stems
  topNCount: number;
  basalAreaTotalM2: number;
  basalAreaPerHa: number;
  stemsPerHa: number;
  // QSM-derived
  totalStemVolumeM3: number | null;
  stemVolumeCi95: number | null;
  totalBranchVolumeM3: number | null;
  meanConfidence: number | null;
  // Biomass / carbon (only when the caller supplied a biomass block).
  biomassKg: number | null;
  carbonKg: number | null;
  co2eKg: number | null;
}


export function summarise(inp: ReportInputs): PlotStats {
  // Each statistic ranges over the trees that have what IT needs.
  //
  // Everything used to be derived from one `valid` set requiring BOTH a
  // diameter and a height, so a tree missing only its height dropped out
  // of the stem count, the basal area and every diameter statistic —
  // none of which need a height. Basal area is measured from the
  // diameter; a missing height has nothing to do with it.
  //
  // That is not a corner case: the metrics pass reports a height of 0
  // for a tree with no ground surface beneath it. With one such tree in
  // four, the report showed 25 % fewer stems and 26 % less basal area
  // than the Plot Boundary panel did for the same plot — two screens
  // disagreeing about how many trees are standing there.
  const ts = treeStats(inp.metrics);
  const withDbh = inp.metrics.filter(t => Number.isFinite(t.dbh) && t.dbh > 0);
  const withHeight = inp.metrics.filter(t => Number.isFinite(t.height) && t.height > 0);
  const dbhs = withDbh.map(t => t.dbh);
  const heights = withHeight.map(t => t.height);
  const bas = withDbh.map(t => Math.PI * (t.dbh * 0.5) ** 2);
  const crowns = inp.metrics.map(t => t.crownArea).filter(Number.isFinite);

  // QSM-derived: only when present.
  let totalVol: number | null = null;
  let volCi: number | null = null;
  let totalBranch: number | null = null;
  let meanConf: number | null = null;
  if (inp.qsm) {
    const trees = inp.qsm.trees as TreeQsm[];
    totalVol = trees.reduce((a, t) => a + (Number.isFinite(t.stemVolume) ? t.stemVolume : 0), 0);
    // CI in quadrature (independent trees).
    const sumVar = trees.reduce((a, t) => {
      const ci = Number.isFinite(t.stemVolumeCi95) ? t.stemVolumeCi95 : 0;
      return a + ci * ci;
    }, 0);
    volCi = Math.sqrt(sumVar);
    totalBranch = trees.reduce((a, t) => a + (Number.isFinite(t.branchVolume) ? t.branchVolume : 0), 0);
    const confs = trees.map(t => t.confidence).filter(Number.isFinite);
    meanConf = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
  }

  // Biomass / carbon — already computed per-tree (species-aware) by the
  // caller; summarise() just carries the totals through to the render
  // functions below, no per-plot density multiply here.
  let biomassKg: number | null = null;
  let carbonKg: number | null = null;
  let co2eKg: number | null = null;
  if (inp.biomass) {
    biomassKg = inp.biomass.biomassKg;
    carbonKg = inp.biomass.carbonKg;
    co2eKg = inp.biomass.co2eKg;
  }

  const haDenom = Math.max(0.0001, inp.plotAreaHa);
  return {
    treeCount: ts.treeCount,
    nWithDbh: ts.nWithDbh,
    nWithHeight: ts.nWithHeight,
    nRefinedDbh: countRefined(inp.metrics),
    mean: {
      dbh: mean(dbhs), height: mean(heights),
      basalArea: mean(bas), crownArea: crowns.length > 0 ? mean(crowns) : NaN,
    },
    sd: { dbh: sd(dbhs), height: sd(heights) },
    median: { dbh: median(dbhs), height: median(heights) },
    loreyMeanHeight: ts.loreyMeanHeight,
    dominantHeight: ts.dominantHeight,
    topNCount: ts.topNCount,
    basalAreaTotalM2: ts.basalAreaTotal,
    basalAreaPerHa: ts.basalAreaTotal / haDenom,
    stemsPerHa: ts.treeCount / haDenom,
    totalStemVolumeM3: totalVol,
    stemVolumeCi95: volCi,
    totalBranchVolumeM3: totalBranch,
    meanConfidence: meanConf,
    biomassKg, carbonKg, co2eKg,
  };
}

// --- SVG chart helpers --------------------------------------------------
//
// Every chart is a small standalone SVG block — no library dependency,
// no JS in the output. Sizes are pixel-based; the print stylesheet
// scales them.

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, ch =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch] as string));
}

function niceBins(min: number, max: number, target: number): { lo: number; hi: number; n: number; step: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return { lo: 0, hi: 1, n: 1, step: 1 };
  }
  const range = max - min;
  const rough = range / target;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  const step = (norm < 1.5 ? pow : norm < 3 ? 2 * pow : norm < 7 ? 5 * pow : 10 * pow);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  return { lo, hi, n: Math.round((hi - lo) / step), step };
}

function histogramSvg(values: number[], opts: { width?: number; height?: number; xLabel: string; xUnit: string; xScale?: number }): string {
  const w = opts.width ?? 520, h = opts.height ?? 200;
  const padL = 36, padR = 8, padT = 8, padB = 28;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const xs = values.filter(Number.isFinite);
  if (xs.length === 0) {
    return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="12" fill="#888">no data</text></svg>`;
  }
  const sc = opts.xScale ?? 1;
  const scaled = xs.map(x => x * sc);
  const { lo, hi, n: nbins, step } = niceBins(Math.min(...scaled), Math.max(...scaled), 16);
  const bins = new Array(nbins).fill(0);
  for (const v of scaled) {
    const idx = Math.min(nbins - 1, Math.max(0, Math.floor((v - lo) / step)));
    bins[idx]++;
  }
  const ymax = Math.max(1, ...bins);
  const xPx = (b: number) => padL + (b / nbins) * innerW;
  const yPx = (c: number) => padT + innerH - (c / ymax) * innerH;
  const bars = bins.map((c, i) => `<rect x="${xPx(i) + 0.5}" y="${yPx(c)}" width="${(innerW / nbins) - 1}" height="${padT + innerH - yPx(c)}" fill="#67d391" />`).join('');
  const mn = mean(scaled);
  const md = median(scaled);
  const mnPx = padL + ((mn - lo) / (hi - lo)) * innerW;
  const mdPx = padL + ((md - lo) / (hi - lo)) * innerW;
  // Axis ticks every `step`.
  const ticks = [];
  for (let i = 0; i <= nbins; i++) {
    const x = padL + (i / nbins) * innerW;
    const v = lo + i * step;
    ticks.push(`<text x="${x}" y="${h - 8}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="9" fill="#888">${formatTick(v)}</text>`);
  }
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${padL}" y="${padT}" width="${innerW}" height="${innerH}" fill="#1c1c20" stroke="#333" />
  ${bars}
  <line x1="${mnPx}" y1="${padT}" x2="${mnPx}" y2="${padT + innerH}" stroke="#e6c068" stroke-dasharray="3,3" />
  <line x1="${mdPx}" y1="${padT}" x2="${mdPx}" y2="${padT + innerH}" stroke="#6fa8dc" stroke-dasharray="3,3" />
  <text x="${mnPx + 4}" y="${padT + 10}" font-family="ui-monospace,monospace" font-size="9" fill="#e6c068">mean ${mn.toFixed(1)}</text>
  <text x="${mdPx + 4}" y="${padT + 22}" font-family="ui-monospace,monospace" font-size="9" fill="#6fa8dc">median ${md.toFixed(1)}</text>
  ${ticks.join('')}
  <text x="${padL + innerW / 2}" y="${h - 2}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="9.5" fill="#aaa">${escapeXml(opts.xLabel)} (${escapeXml(opts.xUnit)})</text>
</svg>`;
}

function scatterSvg(points: { x: number; y: number }[], opts: { width?: number; height?: number; xLabel: string; yLabel: string }): string {
  const w = opts.width ?? 480, h = opts.height ?? 280;
  const padL = 40, padR = 8, padT = 8, padB = 28;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const valid = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (valid.length === 0) {
    return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="12" fill="#888">no data</text></svg>`;
  }
  const xs = valid.map(p => p.x);
  const ys = valid.map(p => p.y);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const xspan = (xmax - xmin) || 1, yspan = (ymax - ymin) || 1;
  const dots = valid.map(p => {
    const px = padL + ((p.x - xmin) / xspan) * innerW;
    const py = padT + innerH - ((p.y - ymin) / yspan) * innerH;
    return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.2" fill="#6fa8dc" fill-opacity="0.7" />`;
  }).join('');
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${padL}" y="${padT}" width="${innerW}" height="${innerH}" fill="#1c1c20" stroke="#333" />
  ${dots}
  <text x="${padL + innerW / 2}" y="${h - 6}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="9.5" fill="#aaa">${escapeXml(opts.xLabel)}</text>
  <text x="12" y="${padT + innerH / 2}" text-anchor="middle" transform="rotate(-90 12 ${padT + innerH / 2})" font-family="ui-monospace,monospace" font-size="9.5" fill="#aaa">${escapeXml(opts.yLabel)}</text>
  <text x="${padL + 4}" y="${padT + innerH - 4}" font-family="ui-monospace,monospace" font-size="9" fill="#666">${xmin.toFixed(2)}</text>
  <text x="${padL + innerW - 30}" y="${padT + innerH - 4}" font-family="ui-monospace,monospace" font-size="9" fill="#666">${xmax.toFixed(2)}</text>
  <text x="${padL + 4}" y="${padT + 12}" font-family="ui-monospace,monospace" font-size="9" fill="#666">${ymax.toFixed(2)}</text>
</svg>`;
}

function plotMapSvg(trees: TreeMetric[], opts: { width?: number; height?: number; metric?: 'dbh' | 'height' }): string {
  const w = opts.width ?? 520, h = opts.height ?? 480;
  const pad = 24;
  const valid = trees.filter(t => Number.isFinite(t.x) && Number.isFinite(t.y));
  if (valid.length === 0) {
    return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="12" fill="#888">no positioned trees</text></svg>`;
  }
  const xs = valid.map(t => t.x), ys = valid.map(t => t.y);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const xspan = (xmax - xmin) || 1, yspan = (ymax - ymin) || 1;
  const s = Math.min((w - 2 * pad) / xspan, (h - 2 * pad) / yspan);
  const ox = pad + (w - 2 * pad - xspan * s) * 0.5;
  const oy = pad + (h - 2 * pad - yspan * s) * 0.5;
  const metric = opts.metric ?? 'dbh';
  const metVals = valid.map(t => metric === 'dbh' ? t.dbh : t.height);
  const mMin = Math.min(...metVals.filter(Number.isFinite));
  const mMax = Math.max(...metVals.filter(Number.isFinite));
  const mSpan = (mMax - mMin) || 1;
  const colorAt = (v: number): string => {
    const t = Math.max(0, Math.min(1, (v - mMin) / mSpan));
    // forest ramp: dark green → bright green → orange → red
    const stops = [[40, 70, 50], [90, 150, 60], [210, 200, 70], [220, 120, 40], [200, 50, 40]];
    const f = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(f));
    const k = f - i;
    const a = stops[i], b = stops[i + 1];
    const r = (a[0] + (b[0] - a[0]) * k) | 0;
    const g = (a[1] + (b[1] - a[1]) * k) | 0;
    const bl = (a[2] + (b[2] - a[2]) * k) | 0;
    return `rgb(${r},${g},${bl})`;
  };
  const dots = valid.map(t => {
    const px = ox + (t.x - xmin) * s;
    // Flip Y so north is up — plot world is south-first in array.
    const py = h - (oy + (t.y - ymin) * s);
    const r = Math.max(2, Math.min(7, 2 + (Number.isFinite(t.dbh) ? t.dbh * 12 : 0)));
    return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${r.toFixed(1)}" fill="${colorAt(metric === 'dbh' ? t.dbh : t.height)}" stroke="#000" stroke-opacity="0.3" stroke-width="0.6" />`;
  }).join('');
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${w}" height="${h}" fill="#1c1c20" />
  <rect x="${pad - 0.5}" y="${pad - 0.5}" width="${w - 2 * pad + 1}" height="${h - 2 * pad + 1}" fill="#161618" stroke="#333" />
  ${dots}
  <text x="${w - 28}" y="${pad + 14}" font-family="ui-monospace,monospace" font-size="10" fill="#aaa">N ↑</text>
  <text x="${pad + 4}" y="${h - 8}" font-family="ui-monospace,monospace" font-size="9.5" fill="#888">colour = ${metric === 'dbh' ? 'DBH' : 'height'} · size = DBH · n = ${valid.length}</text>
</svg>`;
}

function formatTick(v: number): string {
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

// --- HTML composition ---------------------------------------------------

const INLINE_CSS = `
:root { --bg:#fafaf8; --fg:#222; --dim:#666; --mute:#999; --line:#ddd; --accent:#3a7e57; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.5; font-size: 14px; }
.report { max-width: 880px; margin: 0 auto; padding: 32px; }
h1 { font-size: 28px; margin: 0 0 4px 0; letter-spacing: -0.01em; }
h2 { font-size: 18px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); color: var(--accent); }
h3 { font-size: 14px; margin: 16px 0 6px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
.cover { padding: 36px 0 24px; border-bottom: 2px solid var(--accent); margin-bottom: 8px; }
.cover .sub { color: var(--dim); font-size: 13px; }
.headline { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 18px 0; }
.head-card { border: 1px solid var(--line); padding: 12px; border-radius: 6px; background: #fff; }
.head-card .label { font-size: 11px; color: var(--mute); text-transform: uppercase; letter-spacing: 0.05em; }
.head-card .value { font-size: 20px; margin-top: 4px; color: var(--fg); }
.head-card .unit { font-size: 11px; color: var(--dim); margin-left: 4px; }
.head-card .ci { font-size: 10px; color: var(--mute); margin-top: 2px; }
table.tree-table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 11px; }
table.tree-table th { text-align: right; padding: 4px 6px; border-bottom: 2px solid var(--line); color: var(--dim); font-weight: 600; font-size: 10.5px; }
table.tree-table td { text-align: right; padding: 3px 6px; border-bottom: 1px solid var(--line); }
table.tree-table th:first-child, table.tree-table td:first-child { text-align: left; }
.svg-wrap { background: #1c1c20; border-radius: 6px; padding: 8px; margin: 8px 0; display: inline-block; max-width: 100%; }
.kvs { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-family: ui-monospace, monospace; font-size: 12px; margin: 8px 0; }
.kvs .k { color: var(--dim); }
.kvs .v { color: var(--fg); }
.method { background: #fff; border: 1px solid var(--line); border-radius: 6px; padding: 14px; font-size: 12px; color: var(--dim); margin-top: 16px; }
.method b { color: var(--fg); font-weight: 600; }
footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--mute); font-size: 11px; }
.charts-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
.biomass-fallback { color: #b45309; font-weight: 600; }
@media print {
  body { background: white; font-size: 11pt; }
  .report { max-width: none; padding: 0; }
  h2 { page-break-after: avoid; }
  table.tree-table { page-break-inside: auto; font-size: 9pt; }
  table.tree-table tr { page-break-inside: avoid; }
  .svg-wrap { background: transparent; padding: 0; }
}
`;

/** Every number the report prints goes through here, because every one
 *  of them can be missing.
 *
 *  A non-finite value renders as an em dash — the measurement was not
 *  made — and never as the string "NaN". The per-tree table used raw
 *  `.toFixed()` in five of its cells and a hand-written
 *  `Number.isFinite(…) ? … : '—'` in a sixth, so a QSM cache from before
 *  the confidence field existed printed `<td>NaN %</td>` to whoever the
 *  report was sent to. */
function fmtN(v: number, digits = 1, unit = ''): string {
  if (!Number.isFinite(v)) return '—';
  const s = unit === 'cm' && Math.abs(v) < 1 ? (v * 100).toFixed(digits) : v.toFixed(digits);
  return unit ? `${s} <span class="unit">${escapeXml(unit)}</span>` : s;
}

/** The date this report was made, as the forester's own calendar has
 *  it — YYYY-MM-DD from the LOCAL day, not the UTC one.
 *
 *  The report used `toISOString().slice(0, 10)`, which is the UTC date.
 *  For everyone east of Greenwich that is yesterday's date for the
 *  first hours of the working day, and for everyone west of it
 *  tomorrow's date for the last hours: a plot measured on Thursday
 *  morning in New Zealand produced a document dated Wednesday. The
 *  report is what gets filed, and its date is what a client and an
 *  auditor read; a day out is a day out.
 *
 *  Deliberately not `toLocaleDateString`, which would render 26/08/2026
 *  or 8/26/2026 depending on the machine — the format here is fixed and
 *  sortable; only the day it names follows the reader. */
export function localIsoDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function headCard(label: string, value: string, ci?: string): string {
  return `<div class="head-card">
    <div class="label">${escapeXml(label)}</div>
    <div class="value">${value}</div>
    ${ci ? `<div class="ci">${ci}</div>` : ''}
  </div>`;
}

function kvSection(rows: [string, string][]): string {
  return `<div class="kvs">${rows.map(([k, v]) => `<div class="k">${escapeXml(k)}</div><div class="v">${v}</div>`).join('')}</div>`;
}

/** Human label for plotAreaBasis, shown once next to "Plot area" — every
 *  per-ha card in the report inherits this same basis since they all
 *  divide by the same plotAreaHa. */
function areaBasisLabel(basis: ReportInputs['plotAreaBasis']): string {
  if (basis === 'boundary') return 'defined plot boundary';
  if (basis === 'manual') return 'manual entry';
  return 'estimated — tree bbox';
}

export function generateReportHtml(inp: ReportInputs): string {
  const s = summarise(inp);
  const today = localIsoDate();
  const valid = inp.metrics.filter(t => Number.isFinite(t.dbh) && t.dbh > 0);
  // DBH in metres → cm for display; height stays in metres.
  const dbhsCm = valid.map(t => t.dbh * 100);
  const heights = valid.map(t => t.height);

  // Headline cards.
  const headline = [
    headCard('Stems / ha', fmtN(s.stemsPerHa, 0)),
    headCard('Mean DBH', `${fmtN(s.mean.dbh * 100, 1)} <span class="unit">cm</span>`,
      `± ${fmtN(s.sd.dbh * 100, 1)} cm SD`),
    headCard('Lorey\'s mean H', `${fmtN(s.loreyMeanHeight, 1)} <span class="unit">m</span>`,
      `dominant ${fmtN(s.dominantHeight, 1)} m`),
    headCard('Basal area', `${fmtN(s.basalAreaPerHa, 1)} <span class="unit">m²/ha</span>`,
      `${fmtN(s.basalAreaTotalM2, 2)} m² total`),
  ].join('');

  // Volume / biomass / carbon card row (only when QSM is present).
  let volumeBlock = '';
  if (s.totalStemVolumeM3 !== null) {
    const stemPerHa = s.totalStemVolumeM3 / Math.max(0.0001, inp.plotAreaHa);
    const ci95PerHa = (s.stemVolumeCi95 ?? 0) / Math.max(0.0001, inp.plotAreaHa);
    const cards = [
      headCard('Stem volume', `${fmtN(stemPerHa, 1)} <span class="unit">m³/ha</span>`,
        `± ${fmtN(ci95PerHa, 2)} m³/ha · 95 % CI`),
      headCard('Mean QSM confidence', s.meanConfidence !== null ? `${fmtN(s.meanConfidence * 100, 0)} <span class="unit">%</span>` : '—',
        'angular coverage'),
    ];
    // Species mix + fallback count — rendered as its own paragraph
    // below, never folded into a single "species preset" caption. A
    // plot where most trees fell back to the default must read that
    // way, not as a clean single-species result.
    let biomassNote = '';
    if (s.biomassKg !== null && inp.biomass) {
      const tonPerHa = (s.biomassKg / 1000) / Math.max(0.0001, inp.plotAreaHa);
      const biomassCiPerHa = (inp.biomass.biomassKgCi95 / 1000) / Math.max(0.0001, inp.plotAreaHa);
      const co2 = (s.co2eKg! / 1000) / Math.max(0.0001, inp.plotAreaHa);
      const co2CiPerHa = (inp.biomass.co2eKgCi95 / 1000) / Math.max(0.0001, inp.plotAreaHa);
      cards.push(headCard('Above-stump biomass', `${fmtN(tonPerHa, 1)} <span class="unit">t/ha</span>`,
        `± ${fmtN(biomassCiPerHa, 2)} t/ha · 95 % CI`));
      cards.push(headCard('CO₂-equivalent', `${fmtN(co2, 1)} <span class="unit">t/ha</span>`,
        `± ${fmtN(co2CiPerHa, 2)} t/ha · 95 % CI`));
      const mix = inp.biomass.speciesMix;
      const mixText = mix.length > 0
        ? mix.map(m => `${escapeXml(m.label)} (${m.treeCount})`).join(', ')
        : 'none assigned';
      // The density, stated. Biomass is ρ·V and carbon a fraction of
      // that, so ρ is the largest single assumption behind every tonne
      // above; the report named the species and never the number, which
      // leaves a reader unable to check the figure or compare it with
      // any other plot.
      const rho = inp.biomass.fallbackDensity;
      const rhoText = rho !== undefined && Number.isFinite(rho)
        ? ` at ${fmtN(rho, 0)} kg/m³`
        : '';
      biomassNote = `<p class="sub" style="color:var(--dim);font-size:12px;">Species mix: ${mixText}.`
        + (inp.biomass.fallbackCount > 0
          ? ` <span class="biomass-fallback">${inp.biomass.fallbackCount} tree${inp.biomass.fallbackCount === 1 ? '' : 's'} had no species assignment and used the ${escapeXml(inp.biomass.fallbackLabel)} fallback density${rhoText} — assign species in Tree Review for a fully species-aware figure.</span>`
          : ' Every tree carried its own species assignment.')
        + `</p>`;
    }
    volumeBlock = `
<h2>Volume · biomass · carbon</h2>
<div class="headline">${cards.join('')}</div>
${inp.qsm ? `<p class="sub" style="color:var(--dim);font-size:12px;">From the cached TreeQSM (Raumonen 2013, ${inp.qsm.trees.length} trees fitted). Per-tree stem volume CIs sum in quadrature for the plot total.</p>` : ''}
${biomassNote}
`;
  }

  // Optional revenue line from the uniform-grade price.
  let revenueBlock = '';
  if (s.totalStemVolumeM3 !== null && inp.bucking) {
    const totalVol = s.totalStemVolumeM3 + (s.totalBranchVolumeM3 ?? 0);
    const revPerHa = (totalVol * inp.bucking.unitPrice) / Math.max(0.0001, inp.plotAreaHa);
    // Escaped: the currency is free text the user types, and it lands in
    // a document somebody else opens.
    const cur = escapeXml(inp.bucking.currency);
    revenueBlock = `<div class="headline"><div class="head-card">
      <div class="label">Revenue estimate</div>
      <div class="value">${fmtN(revPerHa, 0)} <span class="unit">${cur}/ha</span></div>
      <div class="ci">uniform-grade ${inp.bucking.unitPrice} ${cur}/m³ × ${fmtN(totalVol, 1)} m³ total · use the Bucking panel for sawlog / pulp / energy breakdown</div>
    </div></div>`;
  }

  // Field-data validation block.
  let validationBlock = '';
  if (inp.fieldValidation) {
    const v = inp.fieldValidation;
    validationBlock = `
<h2>Field-data validation</h2>
<div class="headline">
  ${headCard('Matched stems', fmtN(v.nMatched, 0))}
  ${headCard('DBH bias', `${v.biasCm >= 0 ? '+' : ''}${fmtN(v.biasCm, 2)} <span class="unit">cm</span>`,
    'PointCloudLabeler − caliper, positive = overestimates')}
  ${headCard('DBH RMSE', `${fmtN(v.rmseCm, 2)} <span class="unit">cm</span>`)}
  ${headCard('R²', fmtN(v.r2, 3))}
</div>
`;
  }

  // Density-metrics block.
  let densityBlock = '';
  if (inp.density) {
    const d = inp.density;
    densityBlock = `
<h2>Point-cloud density metrics</h2>
${kvSection([
  ['Cell size', `${d.cellSize.toFixed(2)} m · ${d.cols}×${d.rows} grid`],
  ['Min height filter', `${d.minHeight.toFixed(2)} m above ground`],
  ['Returns', `${(d.plotCount / 1e6).toFixed(2)} M · ${d.plotDensity.toFixed(1)} pts/m²`],
  ['Mean ± SD', `${d.plotMean.toFixed(2)} ± ${d.plotSd.toFixed(2)} m`],
  ['Median (P50)', `${d.plotP50.toFixed(2)} m`],
  ['P25 → P95', `${d.plotP25.toFixed(2)} → ${d.plotP95.toFixed(2)} m`],
  ['P75 / P90', `${d.plotP75.toFixed(2)} / ${d.plotP90.toFixed(2)} m`],
  ['Canopy cover ≥ ${d.canopyThreshold.toFixed(1)} m', `${(d.plotCanopyCover * 100).toFixed(1)} %`],
  ['Skewness · kurtosis', `${d.plotSkew.toFixed(2)} · ${d.plotKurt.toFixed(2)}`],
])}
`;
  }

  // Tree-growth block — per-tree change between two epochs (Tree Growth panel).
  let growthBlock = '';
  if (inp.growth) {
    const g = inp.growth;
    growthBlock = `
<h2>Tree growth — ${fmtN(g.years, 1)}-year interval</h2>
<div class="headline">
  ${headCard('Matched stems', fmtN(g.nMatched, 0))}
  ${headCard('Mean DBH growth', `${fmtN(g.meanDbhGrowthCmPerYear, 2)} <span class="unit">cm/yr</span>`)}
  ${headCard('Mean height growth', `${fmtN(g.meanHeightGrowthMPerYear, 2)} <span class="unit">m/yr</span>`)}
  ${headCard('Volume change', `${g.volumeChangeM3 >= 0 ? '+' : ''}${fmtN(g.volumeChangeM3, 2)} <span class="unit">m³</span>`,
    `${g.harvested} harvested / fallen · ${g.ingrowth} ingrowth`)}
</div>
`;
  }

  // M3C2 block — per-point surface change vs. a reference epoch (M3C2 panel).
  let m3c2Block = '';
  if (inp.m3c2) {
    const c = inp.m3c2;
    m3c2Block = `
<h2>M3C2 surface change — vs. ${escapeXml(c.referenceName)}</h2>
<div class="headline">
  ${headCard('Core points', fmtN(c.corePoints, 0))}
  ${headCard('Significant change', `${fmtN(c.significantPct, 1)} <span class="unit">%</span>`)}
  ${headCard('Mean change', `${c.meanChangeCm >= 0 ? '+' : ''}${fmtN(c.meanChangeCm, 1)} <span class="unit">cm</span>`)}
  ${headCard('Median change', `${c.medianChangeCm >= 0 ? '+' : ''}${fmtN(c.medianChangeCm, 1)} <span class="unit">cm</span>`)}
</div>
<p class="sub" style="color:var(--dim);font-size:12px;">Positive = the active cloud sits above the reference epoch (upward growth); negative = loss.</p>
`;
  }

  // Per-tree table — show the top 50 by stem volume if QSM exists, else by DBH.
  let table = '';
  const showQsm = inp.qsm !== null && (inp.qsm.trees as TreeQsm[]).length > 0;
  if (showQsm) {
    const qsmMap = new Map((inp.qsm!.trees as TreeQsm[]).map(t => [t.treeId, t]));
    const rows = valid
      .map(t => ({ t, q: qsmMap.get(t.treeId) }))
      .filter(r => r.q !== undefined)
      .sort((a, b) => (b.q!.stemVolume) - (a.q!.stemVolume))
      .slice(0, 50);
    table = `
<table class="tree-table">
  <thead><tr>
    <th>Tree</th><th>DBH (cm)</th><th>Height (m)</th><th>Stem vol (m³)</th><th>± 95 % CI</th><th>Conf</th>
  </tr></thead>
  <tbody>${rows.map(({ t, q }) => `
    <tr>
      <td>#${t.treeId}</td>
      <td>${fmtN(t.dbh * 100, 1)}</td>
      <td>${fmtN(t.height, 1)}</td>
      <td>${fmtN(q!.stemVolume, 3)}</td>
      <td>${Number.isFinite(q!.stemVolumeCi95) ? `±${fmtN(q!.stemVolumeCi95, 3)}` : '—'}</td>
      <td>${Number.isFinite(q!.confidence) ? `${fmtN(q!.confidence * 100, 0)} %` : '—'}</td>
    </tr>`).join('')}</tbody>
</table>`;
  } else {
    const rows = [...valid].sort((a, b) => b.dbh - a.dbh).slice(0, 50);
    table = `
<table class="tree-table">
  <thead><tr>
    <th>Tree</th><th>DBH (cm)</th><th>Height (m)</th><th>Basal area (m²)</th><th>Crown area (m²)</th>
  </tr></thead>
  <tbody>${rows.map(t => `
    <tr>
      <td>#${t.treeId}</td>
      <td>${fmtN(t.dbh * 100, 1)}</td>
      <td>${fmtN(t.height, 1)}</td>
      <td>${fmtN(Math.PI * (t.dbh * 0.5) ** 2, 3)}</td>
      <td>${fmtN(t.crownArea, 1)}</td>
    </tr>`).join('')}</tbody>
</table>`;
  }

  // Stem-taper block — a small table, one row per measured stem (Stem Taper panel).
  let taperBlock = '';
  if (inp.taper && inp.taper.length > 0) {
    taperBlock = `
<h2>Stem taper measurements</h2>
<table class="tree-table">
  <thead><tr>
    <th>Stem</th><th>DBH (cm)</th><th>Height (m)</th><th>Stem vol (m³)</th><th>Sawlog (m³)</th><th>Pulpwood (m³)</th>
  </tr></thead>
  <tbody>${inp.taper.map(t => `
    <tr>
      <td>${escapeXml(t.label)}</td>
      <td>${t.dbhCm.toFixed(1)}</td>
      <td>${t.heightM.toFixed(1)}</td>
      <td>${t.stemVolumeM3.toFixed(3)}</td>
      <td>${t.sawlogM3.toFixed(3)}</td>
      <td>${t.pulpwoodM3.toFixed(3)}</td>
    </tr>`).join('')}</tbody>
</table>`;
  }

  // Methodology references — sized to what the user actually computed.
  const refs: string[] = [];
  refs.push('<b>QSM (volume + uncertainty)</b>: Raumonen, P. et al. (2013), <i>Fast Automatic Precision Tree Models from Terrestrial Laser Scanner Data</i>, Remote Sensing 5(2):491–520.');
  if (s.biomassKg !== null) {
    // Cited only when the density came from the bundled presets. A
    // forester outside the boreal zone supplies their own figure, and
    // crediting a Finnish wood-density paper for a number it had
    // nothing to do with is a false citation in a document somebody
    // else reads — the more so now that the custom path is reachable.
    refs.push(inp.biomass?.fallbackSource
      ? `<b>Biomass density</b>: ${escapeXml(inp.biomass.fallbackSource)}. Repola, J. (2006), <i>Models for vertical wood density of Scots pine, Norway spruce and birch stems</i>, Silva Fennica 40(4):673–685; Repola, J. (2008), <i>Biomass equations for birch in Finland</i>, Silva Fennica 42(4):605–624; Kärkkäinen, M. (2007), <i>Puutieteen perusteet</i>; Zanne, A.E. et al. (2009), <i>Global wood density database</i>, Dryad.`
      : '<b>Biomass density</b>: supplied by the analyst, not taken from a published table. Biomass is (basic density) × (stem + branch volume); carbon is the carbon fraction of that.');
  }
  refs.push('<b>Terrain derivatives</b>: Horn, B.K.P. (1981) slope/aspect and hillshade, Mark, R.K. (1992) multidirectional hillshade, Weiss, A. (2001) TPI, Zevenbergen, L.W. & Thorne, C.R. (1987) curvature.');
  if (inp.density) {
    refs.push('<b>Forestry density metrics</b>: Pixel-level statistics matching lidR\'s <code>pixel_metrics</code> output; type-7 percentile interpolation matches R\'s default.');
  }
  if (inp.fieldValidation) {
    refs.push('<b>Field validation</b>: Greedy bipartite nearest-neighbour matching within the configured search radius; linear regression for the R² figure.');
  }
  if (inp.growth) {
    refs.push('<b>Tree growth</b>: Greedy bipartite nearest-neighbour stem matching between the reference and active epoch by planimetric position; unmatched reference stems are harvested/fallen, unmatched active stems are ingrowth.');
  }
  if (inp.m3c2) {
    refs.push('<b>M3C2 (surface change)</b>: Lague, D., Brodu, N. &amp; Leroux, J. (2013), <i>Accurate 3D comparison of complex topography with terrestrial laser scanner: application to the Rangitikei canyon (N-Z)</i>, ISPRS Journal of Photogrammetry and Remote Sensing 82:10–26.');
  }
  if (inp.taper) {
    refs.push('<b>Stem taper</b>: circle fit every section from stump height upward along the stem axis; stem volume is the truncated-cone (frustum) integral over the fitted sections.');
  }

  // Final HTML.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeXml(inp.projectName)} — PointCloudLabeler forestry report</title>
  <meta name="generator" content="PointCloudLabeler">
  <style>${INLINE_CSS}</style>
</head>
<body>
<div class="report">
  <div class="cover">
    <h1>${escapeXml(inp.projectName)}</h1>
    <div class="sub">PointCloudLabeler forestry inventory report · ${today}${inp.crsLabel ? ` · ${escapeXml(inp.crsLabel)}` : ''}</div>
    ${inp.description ? `<p style="margin-top:12px;color:var(--dim);">${escapeXml(inp.description)}</p>` : ''}
  </div>

  <h2>Plot at a glance</h2>
  <div class="headline">${headline}</div>
  ${kvSection([
    ['Plot area', `${inp.plotAreaHa.toFixed(3)} ha (${(inp.plotAreaHa * 10000).toFixed(0)} m²) — ${areaBasisLabel(inp.plotAreaBasis)}`],
    ['Trees', s.nWithDbh < s.treeCount || s.nWithHeight < s.treeCount
      ? `${s.treeCount} (${s.nWithDbh} with a diameter, ${s.nWithHeight} with a height)`
      : `${s.treeCount}`],
    ['Median DBH', `${(s.median.dbh * 100).toFixed(1)} cm${
      s.nRefinedDbh > 0
        ? ` — ${s.nRefinedDbh} of ${s.nWithDbh} diameter${s.nWithDbh === 1 ? '' : 's'} from the RANSAC stem fit, the rest algebraic`
        : ''}`],
    ['Mean height', `${s.mean.height.toFixed(1)} m (median ${s.median.height.toFixed(1)})`],
    ['Mean crown area', Number.isFinite(s.mean.crownArea) ? `${s.mean.crownArea.toFixed(1)} m²` : '—'],
  ])}

  ${volumeBlock}
  ${revenueBlock}

  ${validationBlock}

  ${growthBlock}

  ${m3c2Block}

  ${densityBlock}

  <h2>Distributions</h2>
  <div class="charts-row">
    <div>
      <h3>DBH distribution (cm)</h3>
      <div class="svg-wrap">${histogramSvg(dbhsCm, { xLabel: 'DBH', xUnit: 'cm' })}</div>
    </div>
    <div>
      <h3>Height distribution (m)</h3>
      <div class="svg-wrap">${histogramSvg(heights, { xLabel: 'Height', xUnit: 'm' })}</div>
    </div>
    <div>
      <h3>DBH × Height (allometry)</h3>
      <div class="svg-wrap">${scatterSvg(valid.map(t => ({ x: t.dbh * 100, y: t.height })), { xLabel: 'DBH (cm)', yLabel: 'Height (m)' })}</div>
    </div>
  </div>

  <h2>Plot map</h2>
  <div class="svg-wrap">${plotMapSvg(inp.metrics, { metric: 'dbh' })}</div>

  <h2>Per-tree (top 50 by ${showQsm ? 'stem volume' : 'DBH'})</h2>
  ${table}

  ${taperBlock}

  <h2>Methodology</h2>
  <div class="method">
    <p style="margin-top:0;">All figures in this report were derived from a single point-cloud dataset using PointCloudLabeler's in-tree analytics (no external R / Python step). The references below cover the algorithms behind the headline numbers.</p>
    <ul style="margin: 8px 0; padding-left: 18px;">
      ${refs.map(r => `<li style="margin-bottom: 6px;">${r}</li>`).join('')}
    </ul>
    <p>Generated by ${PRODUCT_NAME} ${APP_VERSION}. Cite the version: the
    methods above are implemented from their published descriptions and
    what this program measures differs between releases.</p>
  </div>

  <footer>${escapeXml(inp.projectName)} · PointCloudLabeler · ${today}<br>
  Generated by PointCloudLabeler — © 2026 Eppu Honkanen, GPL-3.0-or-later. Measurements carry the uncertainty stated beside them.</footer>
</div>
</body>
</html>`;
}
