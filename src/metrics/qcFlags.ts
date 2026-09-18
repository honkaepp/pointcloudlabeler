// Per-tree QC (quality-control) anomaly flagging — the shared engine
// behind both the QC panel and Tree Review's flag badges. Robust
// population statistics (median + MAD, less sensitive to a few bad
// trees than mean + sd) over the cached per-tree metrics, plus a few
// QSM-derived checks when a QSM cache is present. Pure + side-effect
// free so any panel can call it; thresholds tuned for typical
// boreal-plot distributions with per-flag rationale inline.

import type { TreeMetric, TreeQsm } from '../persistence/octreeReader';
import { median, mad } from './stats';

export type Severity = 'critical' | 'warning' | 'info';

/** Which check produced a flag. Stable and machine-readable, unlike the
 *  prose in `reason`: the panel filters by it, the CSV carries it, and
 *  the tests assert on it — so rewording a message for a human cannot
 *  break either. */
export type FlagCode =
  | 'no-dbh'
  | 'crown-large'
  | 'crown-small'
  | 'slenderness'
  | 'height-high'
  | 'height-low'
  | 'few-points'
  | 'qsm-coverage'
  | 'qsm-completeness'
  | 'qsm-volume';

/** Short label per check, for the panel's filter chips. */
export const FLAG_LABEL: Record<FlagCode, string> = {
  'no-dbh': 'no DBH fit',
  'crown-large': 'crown too big',
  'crown-small': 'crown too small',
  'slenderness': 'slenderness',
  'height-high': 'tall outlier',
  'height-low': 'short outlier',
  'few-points': 'few points',
  'qsm-coverage': 'QSM coverage',
  'qsm-completeness': 'QSM gaps',
  'qsm-volume': 'QSM volume',
};

export interface Flag {
  treeId: number;
  /** Which check fired. */
  code: FlagCode;
  /** Sort key — higher = more severe. */
  severity: Severity;
  /** Human-readable reason; lists show this verbatim. */
  reason: string;
  /** What the user should do about it. */
  hint: string;
  /** Bbox to frame on the viewport (optional — null if unknown). */
  bbox?: [[number, number, number], [number, number, number]];
}

export const SEV_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };
/** As the UI paints a severity. CSS variables, not literals: a pale
 *  pink that reads on the dark surface is barely there on the white one,
 *  so the theme picks the pair (see styles/globals.css). A figure has no
 *  stylesheet to resolve them against and carries its own — see
 *  figures/panelSvg severityColor. */
export const SEV_COLOR: Record<Severity, string> = {
  critical: 'var(--sev-critical)',
  warning: 'var(--sev-warning)',
  info: 'var(--sev-info)',
};

// 1.4826 * MAD ≈ 1σ for normally-distributed data — the standard scale
// factor for MAD → robust σ.
const robustSigma = (m: number) => 1.4826 * m;

/** Compute every anomaly flag for the tree population. `qsm` / `bboxes`
 *  are optional — pass null to skip the QSM-derived checks or to leave
 *  flags without a fly-to bbox. Returns flags sorted severity-desc, then
 *  tree id. */
/** How far above the plot median a value sits, and whether that counts.
 *
 *  Normally the σ test: more than three robust standard deviations
 *  above the median. But σ is derived from the MAD, and a plot whose
 *  values are all EXACTLY equal has σ = 0 — at which point the σ test
 *  can never fire, however extreme the outlier. That is not
 *  hypothetical: it happens on synthetic data, on a heavily voxel-
 *  downsampled plot, and on any plot small enough that more than half
 *  the trees share a value.
 *
 *  With no spread to measure against, fall back to a ratio: three times
 *  the median is not a tree that happens to be large, it is two trees
 *  fused. The fallback applies ONLY when σ is zero, so on every real
 *  plot the behaviour is exactly the σ test as before.
 *
 *  `z` comes back null on that fallback path, and the caller MUST NOT
 *  print a σ figure then. It used to: the message was built as
 *  `(v − med) / sig` regardless, so every flag raised by the fallback
 *  read "Infinityσ above plot median" — the one path the fallback
 *  exists to serve was the one path whose output was nonsense.
 */
interface Excess { out: boolean; z: number | null; ratio: number }

function farAbove(v: number, med: number, sig: number): Excess {
  const ratio = med > 0 ? v / med : NaN;
  if (sig > 0) {
    const z = (v - med) / sig;
    return { out: z > 3, z, ratio };
  }
  return { out: med > 0 && v > med * 3, z: null, ratio };
}

/** The comparison as a phrase, because the two branches do not take the
 *  same preposition: "3.2σ above the plot median" reads, "4.1× above the
 *  plot median" does not, and "4.1× the plot median" is what you want
 *  there. Returning just the figure and gluing a fixed word onto it
 *  gets one of the two wrong every time. */
function excessText(e: Excess): string {
  return e.z !== null ? `${e.z.toFixed(1)}σ above` : `${e.ratio.toFixed(1)}×`;
}

export function computeQcFlags(
  metrics: TreeMetric[] | null,
  qsm: Map<number, TreeQsm> | null,
  bboxes: Map<number, { min: [number, number, number]; max: [number, number, number] }> | null,
): Flag[] {
  if (!metrics || metrics.length === 0) return [];
  const out: Flag[] = [];

  const finite = (sel: (t: TreeMetric) => number) =>
    metrics.filter(t => Number.isFinite(sel(t))).map(sel);

  const heightVals = finite(t => t.height);
  const dbhVals = finite(t => t.dbh);
  const crownVals = finite(t => t.crownArea);
  const countVals = finite(t => t.count);

  const hMed = median(heightVals); const hSig = robustSigma(mad(heightVals, hMed));
  const dMed = median(dbhVals);     const dSig = robustSigma(mad(dbhVals, dMed));
  const cMed = median(crownVals);   const cSig = robustSigma(mad(crownVals, cMed));
  const nMed = median(countVals);

  // vSig lazily computed once — only when a QSM cache exists.
  let vMed = NaN, vSig = 0;
  if (qsm) {
    const vols = [...qsm.values()].map(x => x.stemVolume).filter(Number.isFinite);
    vMed = median(vols);
    vSig = robustSigma(mad(vols, vMed));
  }

  for (const t of metrics) {
    const bbox = bboxes?.get(t.treeId);
    const box = bbox ? [bbox.min, bbox.max] as [[number, number, number], [number, number, number]] : undefined;

    // (1) Stemless tree — DBH fit failed. Critical: every downstream
    // per-tree metric (biomass, volume, basal area) depends on DBH.
    if (!Number.isFinite(t.dbh)) {
      out.push({
        treeId: t.treeId, code: 'no-dbh', severity: 'critical', bbox: box,
        reason: 'No DBH fit',
        hint: 'Breast-height band missed the stem. Run RANSAC stem fit or check whether the trunk is visible at 1.3 m above ground.',
      });
    }

    // (2) Under-segmented — crown area far above the plot median. Two
    // fused trees.
    const crownExcess = Number.isFinite(t.crownArea) ? farAbove(t.crownArea, cMed, cSig) : null;
    if (crownExcess?.out) {
      out.push({
        treeId: t.treeId, code: 'crown-large', severity: 'warning', bbox: box,
        reason: `Crown area ${t.crownArea.toFixed(1)} m² is ${excessText(crownExcess)} the plot median (${cMed.toFixed(1)} m²)`,
        hint: 'Likely two trees fused into one. Isolate this tree, lasso the half to peel off, click Split.',
      });
    }

    // (3) Over-segmented — tiny crown + low point count → a fragment.
    if (Number.isFinite(t.crownArea) && t.crownArea < cMed * 0.15 && Number.isFinite(t.count) && t.count < nMed * 0.10) {
      out.push({
        treeId: t.treeId, code: 'crown-small', severity: 'warning', bbox: box,
        reason: `Crown area ${t.crownArea.toFixed(1)} m² and only ${t.count.toLocaleString()} points`,
        hint: 'Likely a fragment of a neighbouring crown. Merge it into the right tree.',
      });
    }

    // (4) Slenderness (DBH/H) outside the typical range — usually the
    // DBH fit caught a branch, or the height includes leaf scatter.
    // No σ gate here, deliberately. This is an ABSOLUTE range check —
    // 0.3 to 4.0 cm of diameter per metre of height covers every real
    // tree, and a stem outside it is a bad fit whatever the rest of the
    // plot looks like. It used to be gated on `dSig > 0 && hSig > 0`
    // like the outlier tests are, which silently switched it off on any
    // plot with no DBH spread: a 2 m-thick 20 m "tree" went unflagged
    // because its NEIGHBOURS were all the same size as each other.
    if (Number.isFinite(t.dbh) && Number.isFinite(t.height) && t.dbh > 0 && t.height > 0) {
      const ratio = (t.dbh * 100) / t.height; // cm per m
      if (ratio < 0.3 || ratio > 4.0) {
        out.push({
          treeId: t.treeId, code: 'slenderness', severity: 'warning', bbox: box,
          reason: `Slenderness DBH/H = ${ratio.toFixed(2)} cm/m is outside the typical 0.3–4.0 range`,
          hint: 'Height–DBH mismatch usually means the DBH fit caught a branch instead of the stem, or the height includes leaf scatter above the canopy. Recompute or check by eye.',
        });
      }
    }

    // (5) Height outlier — info-only (some plots have real emergents).
    if (Number.isFinite(t.height) && hSig > 0) {
      // Kept σ-gated: unlike a fused crown, a "tall tree" has no
      // ratio at which it stops being plausible, so there is nothing
      // sensible to fall back to when the plot has no spread.
      const z = (t.height - hMed) / hSig;
      if (z > 4.0) {
        out.push({
          treeId: t.treeId, code: 'height-high', severity: 'info', bbox: box,
          reason: `Height ${t.height.toFixed(1)} m is ${z.toFixed(1)}σ above plot median (${hMed.toFixed(1)} m)`,
          hint: 'Real emergent tree, or the height captured a stray noise point in the crown. Inspect.',
        });
      } else if (z < -3.0 && t.height < 3.0) {
        out.push({
          treeId: t.treeId, code: 'height-low', severity: 'info', bbox: box,
          reason: `Height ${t.height.toFixed(1)} m well below plot median (${hMed.toFixed(1)} m)`,
          hint: 'May be a shrub or seedling rather than a tree. Consider raising the min-tree-height threshold.',
        });
      }
    }

    // (6) Few points — sparse tree, statistics unreliable. Info.
    if (Number.isFinite(t.count) && nMed > 0 && t.count < nMed * 0.05) {
      out.push({
        treeId: t.treeId, code: 'few-points', severity: 'info', bbox: box,
        reason: `Only ${t.count.toLocaleString()} points (median ${nMed.toLocaleString()})`,
        hint: 'Tree may be partially occluded or beyond effective scan range. Metrics will be noisier than usual.',
      });
    }

    // --- QSM-derived checks (when a QSM cache exists) ---
    const q = qsm?.get(t.treeId);
    if (q) {
      // (7) Low angular coverage — stem seen from one side only.
      if (q.confidence < 0.50) {
        out.push({
          treeId: t.treeId, code: 'qsm-coverage', severity: 'warning', bbox: box,
          reason: `QSM angular coverage ${(q.confidence * 100).toFixed(0)} % — stem seen from one side only`,
          hint: 'Add a scan position on the missing side before relying on volume / biomass for this tree.',
        });
      }
      // (8) Low height-completeness — large gaps in the slice fit.
      if (q.completeness < 0.50) {
        out.push({
          treeId: t.treeId, code: 'qsm-completeness', severity: 'warning', bbox: box,
          reason: `QSM height completeness ${(q.completeness * 100).toFixed(0)} % — ${q.rejectedSlices} of ${q.acceptedSlices + q.rejectedSlices} slices rejected`,
          hint: 'Stem partially occluded or noisy mid-canopy. Volume CI will be wide; consider re-scanning.',
        });
      }
      // (9) Outlier per-tree stem volume — > 4σ above population median.
      if (vSig > 0) {
        const z = (q.stemVolume - vMed) / vSig;
        if (z > 4.0) {
          out.push({
            treeId: t.treeId, code: 'qsm-volume', severity: 'warning', bbox: box,
            reason: `Stem volume ${q.stemVolume.toFixed(2)} m³ is ${z.toFixed(1)}σ above plot median (${vMed.toFixed(2)} m³)`,
            hint: 'Likely a runaway slice radius. Check the taper sparkline (Metrics panel) and consider re-running QSM with a smaller continuity tolerance.',
          });
        }
      }
    }
  }

  out.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.treeId - b.treeId);
  return out;
}

/** Worst severity per tree, for a compact one-glyph badge. */
export function worstByTree(flags: Flag[]): Map<number, Severity> {
  const m = new Map<number, Severity>();
  for (const f of flags) {
    const cur = m.get(f.treeId);
    if (!cur || SEV_RANK[f.severity] > SEV_RANK[cur]) m.set(f.treeId, f.severity);
  }
  return m;
}
