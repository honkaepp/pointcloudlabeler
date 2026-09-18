// Rescan Advisor + coverage heatmap.
//
// The forester is still in the field. They've scanned a plot from a
// handful of positions and want to know two things before packing up:
//
//   (1) Which trees were under-sampled by the existing scans?
//   (2) Where would the next scan position do the most good?
//
// Answer (1) comes from the cached QSM confidence (radius-weighted
// mean angular coverage across accepted slices). Answer (2) is the
// novel bit: each QsmSlice now carries the bit-packed 12-sector mask
// (added to QsmSlice.sector_mask in the Rust struct), so we can
// aggregate the *azimuths* a tree is shadowed from — not just the
// fraction. Combine those per-tree shadow vectors across the plot,
// cluster the resulting "shadow points" with simple grid-DBSCAN, and
// the cluster centroids are the candidate scan positions: stand
// there and the gaps light up.
//
// Plot-wide visualisation is a top-down plan view: every tree dot
// colour-coded by confidence (red → yellow → green), short arrows
// from each shadowed tree toward the missing azimuth, and the
// suggested scan positions as numbered markers. Click any tree row
// in the side list to isolate it in the viewport.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import type { QsmResult, TreeQsm, QsmSlice, OctreeCrs } from '../../persistence/octreeReader';
import { useProject } from '../../context/ProjectContext';
import { csvNum, csvBlob } from '../../io/csv';
import { saveCsvFile, saveTextFile } from '../../io/saveDownload';

interface Desktop {
  octreeReadQsm?: (dir: string) => Promise<QsmResult | null>;
  octreeTreeSummary?: (dir: string) => Promise<{
    treeId: number;
    count: number;
    bboxMin: [number, number, number];
    bboxMax: [number, number, number];
  }[]>;
  // GPX export's coordinate conversion — commands/crs.rs's crs_transform
  // (backed by proj4rs), the one projection implementation PointCloudLabeler carries.
  // This panel used to have its own from-scratch inverse Transverse
  // Mercator (src/utils/projection.ts, since deleted) for exactly this;
  // see CrsChoice below for how the CRS itself gets chosen.
  crsTransform?: (points: Array<[number, number, number]>, from: string, to: string) => Promise<Array<[number, number, number]>>;
}

/** 12 sectors → 24 half-sectors when we look for the largest gap.
 *  Using the bit indices directly is fine because we centre each
 *  sector at (i + 0.5) · 30°. */
const N_SECTORS = 12;
const DEG_PER_SECTOR = 360 / N_SECTORS;

interface TreeViz {
  treeId: number;
  /** Plan-view position (world XY). */
  x: number;
  y: number;
  /** Headline radius-weighted confidence (0..1). */
  confidence: number;
  /** Plot-relative completeness — fraction of expected slices that
   *  produced a usable fit (0..1). Complements `confidence`. */
  completeness: number;
  /** Stem volume + DBH for the tooltip / list. NaN when unknown. */
  stemVolume: number;
  dbh: number;
  /** Shadow azimuth in radians (0 = +X / east, CCW). NaN when no
   *  per-sector data was present (old QSM cache → mask = 0xFFF). */
  shadowAzimuth: number;
  /** Width of the missing sector run in radians. Larger = worse. */
  shadowWidth: number;
}

interface RescanSpot {
  /** Plan-view candidate position (world XY). */
  x: number;
  y: number;
  /** Trees whose shadow direction this position would relight. */
  fixesTreeIds: number[];
}

/** Aggregate a tree's per-slice sector masks into a single 12-bit
 *  occupancy summary, then find the centre of the LARGEST run of
 *  empty sectors. That centre is the azimuth the tree is shadowed
 *  from — i.e. where the next scanner would do the most good when
 *  looking at THIS tree. Returns `NaN` when no per-sector data was
 *  recorded (every slice's mask is 0xFFF → indistinguishable from
 *  "fully encircled" or "we don't know"). */
function shadowFromSlices(slices: QsmSlice[]): { az: number; width: number } {
  if (slices.length === 0) return { az: NaN, width: 0 };
  // OR the slice masks together — a sector is "seen" if ANY slice
  // along the trunk caught a point in it. (We don't want a single
  // height-band gap to dominate the shadow estimate.)
  let union = 0;
  let allKnown = true;
  for (const s of slices) {
    const m = s.sectorMask ?? 0xFFF;
    union |= m;
    if (m !== 0xFFF) allKnown = false;
  }
  // If every slice reports the legacy default (0xFFF), we have no
  // shadow info to surface. Return NaN.
  if (allKnown) return { az: NaN, width: 0 };

  // Find the longest run of zero bits in the 12-bit cyclic mask.
  // We unroll the search by walking 24 slots so a run that wraps
  // (e.g. bits 11→0→1) is found in one pass.
  let bestStart = -1, bestLen = 0;
  let curStart = -1, curLen = 0;
  for (let k = 0; k < N_SECTORS * 2; k++) {
    const i = k % N_SECTORS;
    const filled = (union >> i) & 1;
    if (!filled) {
      if (curLen === 0) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curLen = 0;
    }
  }
  if (bestLen === 0 || bestLen >= N_SECTORS) return { az: NaN, width: 0 };
  // The empty run starts at bestStart (sector index), spans bestLen
  // sectors. Centre azimuth in degrees, then radians.
  const centreSectorIdx = bestStart + (bestLen - 1) / 2;
  // Sector i is centred at (i + 0.5) · 30° (the same convention
  // the Rust side uses when building the mask: atan2 yields -π..π,
  // shifted by π → 0..2π, divided by π/6).
  const degAt0 = (centreSectorIdx + 0.5) * DEG_PER_SECTOR;
  // Convert "atan2 bin centre after the +π shift" back to a
  // conventional CCW-from-+X azimuth: deg − 180°.
  const az = ((degAt0 - 180) * Math.PI) / 180;
  return { az, width: (bestLen * DEG_PER_SECTOR * Math.PI) / 180 };
}

/** Greedy spatial clustering on the suggested-scan candidate set.
 *  Each shadowed tree contributes a "shadow point" S = tree + d · v,
 *  where d ≈ a quarter of the plot extent (so the suggestion sits
 *  inside the plot, not at infinity) and v is the unit shadow
 *  direction. Points are then merged within a fixed radius; each
 *  cluster's centroid becomes a candidate scan position. */
function clusterRescanSpots(
  trees: TreeViz[],
  plotDiagonal: number,
  mergeRadius: number,
): RescanSpot[] {
  const stepOut = Math.min(8, Math.max(2, plotDiagonal * 0.18));
  // Build the per-tree shadow points first, skipping trees with
  // unknown shadow direction.
  const candidates: { x: number; y: number; treeId: number }[] = [];
  for (const t of trees) {
    if (!Number.isFinite(t.shadowAzimuth)) continue;
    candidates.push({
      x: t.x + Math.cos(t.shadowAzimuth) * stepOut,
      y: t.y + Math.sin(t.shadowAzimuth) * stepOut,
      treeId: t.treeId,
    });
  }
  if (candidates.length === 0) return [];

  // Simple O(n²) merge — plot-scale n is in the hundreds, this is
  // fine and avoids pulling in a clustering library.
  const visited = new Array(candidates.length).fill(false);
  const r2 = mergeRadius * mergeRadius;
  const spots: RescanSpot[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (visited[i]) continue;
    visited[i] = true;
    let sx = candidates[i].x, sy = candidates[i].y;
    const ids = [candidates[i].treeId];
    for (let j = i + 1; j < candidates.length; j++) {
      if (visited[j]) continue;
      const dx = candidates[j].x - candidates[i].x;
      const dy = candidates[j].y - candidates[i].y;
      if (dx * dx + dy * dy <= r2) {
        visited[j] = true;
        sx += candidates[j].x; sy += candidates[j].y;
        ids.push(candidates[j].treeId);
      }
    }
    const n = ids.length;
    spots.push({ x: sx / n, y: sy / n, fixesTreeIds: ids });
  }
  // Largest clusters first (those fix the most trees).
  spots.sort((a, b) => b.fixesTreeIds.length - a.fixesTreeIds.length);
  return spots;
}

/** The CRS the GPX export should treat the dataset's x/y as being in.
 *  Older versions of this panel could only ask the user directly, since
 *  nothing recorded a dataset's CRS anywhere — that guess-free default
 *  ('unset') is still exactly how this starts for a dataset with no
 *  recorded CRS, and GPX export is still blocked on it. Now that a
 *  dataset CAN carry a recorded CRS (metadata.json's `crs`, set in the
 *  Layers panel), 'recorded' reuses it as the DEFAULT selection — see
 *  the effect below — while 'tm35fin' / 'utm' remain available as a
 *  manual override for a dataset that hasn't been told its CRS yet, or
 *  whose recorded one is wrong. Guessing here (defaulting to anything
 *  other than what's actually recorded, or than nothing) is how a
 *  forester ends up walking to a coordinate kilometres from the real
 *  one. `zoneText` is kept as the raw typed string (not a number) so
 *  the zone field starts genuinely empty rather than defaulting to some
 *  zone the user never chose. */
type CrsChoice =
  | { kind: 'unset' }
  | { kind: 'recorded'; spec: string; label: string }
  | { kind: 'tm35fin' }
  | { kind: 'utm'; zoneText: string; hemisphere: 'N' | 'S' };

/** `crs.epsg` / `crs.proj` (`OctreeCrs`, set via `octree_set_crs`) into
 *  the "epsg:XXXX" / raw-proj4 spec string `crsTransform`'s `from`
 *  argument expects — the same two shapes `resolve_proj` (commands/
 *  crs.rs) accepts, so this never needs its own copy of that logic. */
function crsSpecOf(crs: OctreeCrs): string {
  return 'epsg' in crs ? `epsg:${crs.epsg}` : crs.proj;
}

export default function RescanPanel() {
  const { octree, api, setFilters } = useOctreeShell();
  const { project } = useProject();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  const [qsm, setQsm] = useState<QsmResult | null>(null);
  const [bboxes, setBboxes] = useState<Map<number, { min: [number, number, number]; max: [number, number, number] }> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tuning — slider thresholds keep the panel useful across plot sizes.
  const [confThreshold, setConfThreshold] = useState(0.70); // trees below this are "shadowed"
  const [mergeRadius, setMergeRadius] = useState(3.0);      // metres — cluster shadow points
  const [showArrows, setShowArrows] = useState(true);
  const [showSpots, setShowSpots] = useState(true);

  // GPX needs real lat/lon, which means knowing the dataset's CRS — see
  // CrsChoice above. Starts unset; the effect below fills in 'recorded'
  // the moment the active dataset's own CRS is known, UNLESS the user
  // has already picked something manually (crsManuallySet) — never
  // overwrites a deliberate choice, including a deliberate switch back
  // to "not set".
  const [crs, setCrs] = useState<CrsChoice>({ kind: 'unset' });
  const crsManuallySet = useRef(false);
  useEffect(() => {
    if (crsManuallySet.current) return;
    const recorded = octree?.meta.crs;
    if (recorded) setCrs({ kind: 'recorded', spec: crsSpecOf(recorded), label: recorded.label });
  }, [octree]);

  const refresh = useCallback(async () => {
    if (!project?.folder || !octree?.dir) { setQsm(null); setBboxes(null); return; }
    setLoading(true); setError(null);
    try {
      if (desktop?.octreeReadQsm) {
        const res = await desktop.octreeReadQsm(octree.dir);
        setQsm(res);
      }
      if (desktop?.octreeTreeSummary) {
        const list = await desktop.octreeTreeSummary(octree.dir);
        const m = new Map<number, { min: [number, number, number]; max: [number, number, number] }>();
        for (const r of list) m.set(r.treeId, { min: r.bboxMin, max: r.bboxMax });
        setBboxes(m);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [project?.folder, octree?.dir, desktop]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Build the per-tree visualisation summary from the cached QSM.
  const trees = useMemo<TreeViz[]>(() => {
    if (!qsm) return [];
    const out: TreeViz[] = [];
    for (const t of qsm.trees as TreeQsm[]) {
      const { az, width } = shadowFromSlices(t.slices);
      out.push({
        treeId: t.treeId,
        x: t.baseX, y: t.baseY,
        confidence: t.confidence,
        completeness: t.completeness,
        stemVolume: t.stemVolume,
        dbh: t.dbh,
        shadowAzimuth: az,
        shadowWidth: width,
      });
    }
    return out;
  }, [qsm]);

  // Plot bounds (for the plan-view aspect + the cluster step-out
  // distance). Derived from the QSM trees, not bboxes, so we
  // don't depend on the tree-summary being loaded.
  const bounds = useMemo(() => {
    if (trees.length === 0) return null;
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (const t of trees) {
      if (t.x < xMin) xMin = t.x; if (t.x > xMax) xMax = t.x;
      if (t.y < yMin) yMin = t.y; if (t.y > yMax) yMax = t.y;
    }
    // Pad so points aren't right at the canvas edge.
    const pad = Math.max(5, (xMax - xMin + yMax - yMin) * 0.05);
    return {
      xMin: xMin - pad, xMax: xMax + pad,
      yMin: yMin - pad, yMax: yMax + pad,
      diag: Math.hypot(xMax - xMin, yMax - yMin),
    };
  }, [trees]);

  // Shadowed trees + cluster rescan candidates.
  const shadowed = useMemo(
    () => trees.filter(t => t.confidence < confThreshold),
    [trees, confThreshold],
  );
  const spots = useMemo(
    () => bounds ? clusterRescanSpots(shadowed, bounds.diag, mergeRadius) : [],
    [shadowed, bounds, mergeRadius],
  );

  // --- Canvas rendering --------------------------------------------------
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Tracks tree-row hit testing — pixel position of each tree dot.
  const dotPx = useRef<{ x: number; y: number; r: number; treeId: number }[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bounds || trees.length === 0) {
      dotPx.current = [];
      // Still wipe so a stale frame doesn't linger after a dataset
      // change.
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // World → canvas: maintain aspect, flip Y (north up).
    const xs = (bounds.xMax - bounds.xMin) || 1;
    const ys = (bounds.yMax - bounds.yMin) || 1;
    const s = Math.min((cssW - 24) / xs, (cssH - 24) / ys);
    const ox = 12 + (cssW - 24 - xs * s) * 0.5;
    const oy = 12 + (cssH - 24 - ys * s) * 0.5;
    const toPx = (wx: number, wy: number): [number, number] => [
      ox + (wx - bounds.xMin) * s,
      // Flip so north (+Y) is up.
      cssH - (oy + (wy - bounds.yMin) * s),
    ];

    // Plot frame.
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      ox - 0.5,
      cssH - (oy + ys * s) - 0.5,
      xs * s + 1,
      ys * s + 1,
    );

    // North marker — a tiny "N" arrow at the top-right corner.
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '10px ui-monospace,monospace';
    ctx.fillText('N ↑', cssW - 28, 18);

    // Scale bar — 1, 5, 10 m or 0.1 m, whichever covers ~20 % of width.
    {
      const targetPx = cssW * 0.22;
      const candidates = [0.5, 1, 2, 5, 10, 20, 50, 100];
      let pick = 5;
      for (const c of candidates) if (c * s <= targetPx) pick = c;
      const xa = 12, ya = cssH - 14;
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath();
      ctx.moveTo(xa, ya); ctx.lineTo(xa + pick * s, ya);
      ctx.moveTo(xa, ya - 3); ctx.lineTo(xa, ya + 3);
      ctx.moveTo(xa + pick * s, ya - 3); ctx.lineTo(xa + pick * s, ya + 3);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(`${pick} m`, xa + 4, ya - 4);
    }

    // Shadow arrows — drawn BEFORE the dots so the dots land on top.
    if (showArrows) {
      for (const t of trees) {
        if (!Number.isFinite(t.shadowAzimuth)) continue;
        if (t.confidence >= confThreshold) continue;
        const [px, py] = toPx(t.x, t.y);
        // Length scales with how wide the shadow is — wider gap, longer
        // arrow. Clamped so very wide gaps don't overdraw the plot.
        const arrowLenPx = Math.min(40, 8 + (t.shadowWidth / Math.PI) * 24);
        // Note: canvas Y is flipped, so we negate sin to keep azimuth
        // sensible (CCW from east).
        const tipX = px + Math.cos(t.shadowAzimuth) * arrowLenPx;
        const tipY = py - Math.sin(t.shadowAzimuth) * arrowLenPx;
        ctx.strokeStyle = 'rgba(230,192,104,0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();
        // Arrowhead.
        const ah = 4;
        const angle = Math.atan2(tipY - py, tipX - px);
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - ah * Math.cos(angle - 0.5), tipY - ah * Math.sin(angle - 0.5));
        ctx.lineTo(tipX - ah * Math.cos(angle + 0.5), tipY - ah * Math.sin(angle + 0.5));
        ctx.closePath();
        ctx.fillStyle = 'rgba(230,192,104,0.7)';
        ctx.fill();
      }
    }

    // Tree dots.
    const newDotPx: { x: number; y: number; r: number; treeId: number }[] = [];
    for (const t of trees) {
      const [px, py] = toPx(t.x, t.y);
      const r = Math.max(3, Math.min(6, 3 + (Number.isFinite(t.dbh) ? t.dbh * 12 : 0)));
      const col = colourForConfidence(t.confidence);
      ctx.fillStyle = col;
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      newDotPx.push({ x: px, y: py, r: r + 4, treeId: t.treeId });
    }
    dotPx.current = newDotPx;

    // Rescan spots — numbered crosshairs.
    if (showSpots) {
      for (let i = 0; i < spots.length; i++) {
        const sp = spots[i];
        const [px, py] = toPx(sp.x, sp.y);
        ctx.strokeStyle = '#67d391';
        ctx.fillStyle = '#67d391';
        ctx.lineWidth = 1.4;
        // Crosshair.
        ctx.beginPath();
        ctx.moveTo(px - 7, py); ctx.lineTo(px + 7, py);
        ctx.moveTo(px, py - 7); ctx.lineTo(px, py + 7);
        ctx.stroke();
        // Ring.
        ctx.beginPath();
        ctx.arc(px, py, 8, 0, Math.PI * 2);
        ctx.stroke();
        // Label.
        ctx.font = '11px ui-monospace,monospace';
        ctx.fillStyle = '#67d391';
        ctx.fillText(`${i + 1}`, px + 11, py + 4);
        ctx.fillStyle = 'rgba(103,211,145,0.6)';
        ctx.font = '9px ui-monospace,monospace';
        ctx.fillText(`+${sp.fixesTreeIds.length}`, px + 11, py + 14);
      }
    }
  }, [trees, bounds, shadowed, spots, confThreshold, showArrows, showSpots]);

  // Click → isolate the closest tree dot under the cursor.
  const onCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best: { treeId: number; d2: number } | null = null;
    for (const d of dotPx.current) {
      const dx = d.x - x, dy = d.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= d.r * d.r && (!best || d2 < best.d2)) {
        best = { treeId: d.treeId, d2 };
      }
    }
    if (best && bboxes) {
      const bb = bboxes.get(best.treeId);
      if (bb) {
        setFilters({ isolateTreeId: best.treeId, isolateBox: [bb.min, bb.max] });
        api?.frameBox(bb.min, bb.max);
      }
    }
  }, [bboxes, setFilters, api]);

  // --- Render ------------------------------------------------------------
  const hasData = trees.length > 0;
  const shadowedCount = shadowed.length;
  const worst = useMemo(
    () => [...shadowed].sort((a, b) => a.confidence - b.confidence).slice(0, 20),
    [shadowed],
  );
  const stats = useMemo(() => {
    if (trees.length === 0) return null;
    const conf = trees.map(t => t.confidence).filter(Number.isFinite);
    const mean = conf.length === 0 ? 0 : conf.reduce((a, b) => a + b, 0) / conf.length;
    const min = conf.length === 0 ? 0 : Math.min(...conf);
    return { mean, min, total: trees.length };
  }, [trees]);

  const hasShadowInfo = useMemo(
    () => trees.some(t => Number.isFinite(t.shadowAzimuth)),
    [trees],
  );

  // --- CSV export ---
  // Two sections in one file (one button, one download — the field
  // deliverable should be a single thing to carry): the recommended
  // scan positions, then the per-tree shadow detail explaining WHY
  // each position was suggested. The per-tree section covers the
  // full `shadowed` set (every tree below the confidence threshold),
  // not just the "worst 20" truncated list rendered below, so a
  // spot's relit-count always reconciles against real rows in the
  // file.
  const exportCsv = useCallback(() => {
    if (spots.length === 0 && shadowed.length === 0) return;
    const lines = ['idx,x,y,trees_relit'];
    spots.forEach((sp, i) => {
      lines.push([i + 1, csvNum(sp.x, 3), csvNum(sp.y, 3), sp.fixesTreeIds.length].join(','));
    });
    lines.push('');
    lines.push('tree_id,x,y,confidence,shadow_azimuth_deg,gap_width_deg');
    for (const t of shadowed) {
      const hasShadow = Number.isFinite(t.shadowAzimuth);
      lines.push([
        t.treeId,
        csvNum(t.x, 3),
        csvNum(t.y, 3),
        csvNum(t.confidence, 3),
        hasShadow ? csvNum(t.shadowAzimuth * 180 / Math.PI, 2) : '',
        hasShadow ? csvNum(t.shadowWidth * 180 / Math.PI, 2) : '',
      ].join(','));
    }
    void saveCsvFile(lines, 'rescan-positions.csv');
  }, [spots, shadowed]);

  // --- GPX export ---
  // The resolved `crsTransform` "from" spec for the chosen CRS, or null
  // while nothing valid has been chosen yet (unset, or an in-progress /
  // invalid UTM zone). This is the single gate the GPX button's
  // `disabled` is keyed off — see CrsChoice above for why it can't
  // default to anything but 'unset' / the dataset's own recorded CRS.
  // UTM resolves to a bare EPSG code (326zz / 327zz — WGS84 UTM north /
  // south, exactly what crs.rs's curated table carries for every zone)
  // rather than a hand-written proj4 string, so this panel carries no
  // projection maths of its own at all — crs_transform (backed by
  // proj4rs) is the one implementation.
  const crsSpec = useMemo<string | null>(() => {
    if (crs.kind === 'recorded') return crs.spec;
    if (crs.kind === 'tm35fin') return 'epsg:3067';
    if (crs.kind === 'utm') {
      const zone = Number(crs.zoneText.trim());
      if (!Number.isInteger(zone) || zone < 1 || zone > 60) return null;
      return `epsg:${(crs.hemisphere === 'S' ? 32700 : 32600) + zone}`;
    }
    return null;
  }, [crs]);

  // Human-readable statement of exactly what CRS is about to be used —
  // shown next to the export controls so the assumption is visible, not
  // just enforced silently by the disabled button.
  const crsLabel = useMemo(() => {
    if (crs.kind === 'recorded') return crs.label;
    if (crs.kind === 'tm35fin') return 'ETRS-TM35FIN (EPSG:3067)';
    if (crs.kind === 'utm' && crsSpec) return `UTM zone ${crs.zoneText.trim()} ${crs.hemisphere} (WGS84)`;
    return null;
  }, [crs, crsSpec]);

  const [gpxBusy, setGpxBusy] = useState(false);
  const [gpxError, setGpxError] = useState<string | null>(null);

  // Same recommended positions as the CSV/plan view (spots[].x/y, the
  // dataset's own projected coordinates) — converted through the chosen
  // CRS via the bridge's crsTransform (commands/crs.rs), never
  // recomputed from anything else, so GPX and CSV can never silently
  // disagree about where a spot is. One batched call for every spot
  // rather than one per waypoint — there are rarely more than a
  // handful, but there's no reason to round-trip the bridge per point
  // when crsTransform already takes a batch.
  const exportGpx = useCallback(async () => {
    if (!crsSpec || spots.length === 0 || !desktop?.crsTransform) return;
    setGpxBusy(true);
    setGpxError(null);
    try {
      const points: Array<[number, number, number]> = spots.map(sp => [sp.x, sp.y, 0]);
      const converted = await desktop.crsTransform(points, crsSpec, 'epsg:4326');
      const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="PointCloudLabeler Rescan Advisor" xmlns="http://www.topografix.com/GPX/1/1">',
      ];
      spots.forEach((sp, i) => {
        const [lon, lat] = converted[i];
        lines.push(
          `  <wpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">`,
          `    <name>Scan ${i + 1}</name>`,
          `    <desc>Relights ${sp.fixesTreeIds.length} tree${sp.fixesTreeIds.length === 1 ? '' : 's'}</desc>`,
          '  </wpt>',
        );
      });
      lines.push('</gpx>');
      void saveTextFile(lines.join('\n'), 'rescan-positions.gpx', 'application/gpx+xml');
    } catch (e) {
      setGpxError(e instanceof Error ? e.message : String(e));
    } finally {
      setGpxBusy(false);
    }
  }, [spots, crsSpec, desktop]);

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 420 }}>
      <div className="flex items-center gap-1.5">
        <button
          className="btn !h-7 !px-2 mono text-[11px] flex-1"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)', lineHeight: 1.5 }}>{error}</div>
      )}

      {!hasData && !loading && (
        <div className="mono text-[10.5px] px-1.5 py-2" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Compute QSM in the Metrics module first. The Rescan Advisor reads the cached QSM (per-tree confidence + per-slice sector masks) to colour the plan view and suggest where to put the next scan position.
        </div>
      )}

      {hasData && stats && (
        <>
          {/* Summary line */}
          <div className="mono text-[10.5px] flex items-center gap-2" style={{ color: 'var(--text-dim)' }}>
            <span>{stats.total} trees</span>
            <span style={{ color: 'var(--text-mute)' }}>·</span>
            <span>mean conf <span style={{ color: 'var(--text)' }}>{(stats.mean * 100).toFixed(0)} %</span></span>
            <span style={{ color: 'var(--text-mute)' }}>·</span>
            <span style={{ color: shadowedCount > 0 ? '#e6c068' : 'var(--text-dim)' }}>{shadowedCount} shadowed</span>
          </div>

          {/* Plan view */}
          <div className="rounded-md" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.18)', height: 320 }}>
            <canvas
              ref={canvasRef}
              onClick={onCanvasClick}
              style={{ width: '100%', height: '100%', cursor: 'pointer' }}
            />
          </div>

          {/* Threshold + cluster controls */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <label className="mono text-[10px] w-[120px]" style={{ color: 'var(--text-dim)' }}>Shadow ≤</label>
              <input
                type="range" min={0.30} max={0.95} step={0.05}
                value={confThreshold}
                onChange={(e) => setConfThreshold(parseFloat(e.target.value))}
                className="flex-1"
              />
              <span className="mono text-[10px] w-[44px] text-right" style={{ color: 'var(--text)' }}>{(confThreshold * 100).toFixed(0)} %</span>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="mono text-[10px] w-[120px]" style={{ color: 'var(--text-dim)' }}>Cluster radius</label>
              <input
                type="range" min={1.0} max={10.0} step={0.5}
                value={mergeRadius}
                onChange={(e) => setMergeRadius(parseFloat(e.target.value))}
                className="flex-1"
              />
              <span className="mono text-[10px] w-[44px] text-right" style={{ color: 'var(--text)' }}>{mergeRadius.toFixed(1)} m</span>
            </div>
            <div className="flex items-center gap-3">
              <label className="mono text-[10px] flex items-center gap-1" style={{ color: 'var(--text-dim)', cursor: 'pointer' }}>
                <input type="checkbox" checked={showArrows} onChange={() => setShowArrows(s => !s)} /> shadow arrows
              </label>
              <label className="mono text-[10px] flex items-center gap-1" style={{ color: 'var(--text-dim)', cursor: 'pointer' }}>
                <input type="checkbox" checked={showSpots} onChange={() => setShowSpots(s => !s)} /> rescan spots
              </label>
            </div>
          </div>

          {!hasShadowInfo && (
            <div className="mono text-[9.5px] px-1.5 py-1 rounded-md" style={{ color: 'var(--text-mute)', background: 'var(--wash-1)', lineHeight: 1.4 }}>
              Per-sector data missing on this QSM cache (legacy run before the rescan-advisor wiring). Coverage colours still work; arrows + rescan-spot suggestions need a fresh QSM run.
            </div>
          )}

          {/* Suggested scan positions */}
          {spots.length > 0 && (
            <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
              <div className="px-2 py-1 mono text-[10px] flex items-center justify-between" style={{ color: 'var(--text-dim)', background: 'rgba(103,211,145,0.06)', borderBottom: '1px solid var(--line)' }}>
                <span>Suggested next scan positions ({spots.length})</span>
                <div className="flex items-center gap-1">
                  <button className="btn !h-5 !px-1.5 mono text-[10px]" onClick={exportCsv} title="Coordinates are in the dataset's source CRS (the point cloud's projected system) — not GPS / WGS84.">CSV</button>
                  <button
                    className="btn !h-5 !px-1.5 mono text-[10px]"
                    onClick={() => void exportGpx()}
                    disabled={!crsSpec || gpxBusy}
                    title={crsSpec
                      ? `Export GPX waypoints (WGS84 lat/lon), converted from ${crsLabel}.`
                      : "Choose the dataset's CRS below first — PointCloudLabeler can't detect it, and exporting under the wrong one puts the waypoints kilometres away."}
                  >
                    {gpxBusy ? '…' : 'GPX'}
                  </button>
                </div>
              </div>
              <div className="mono text-[9px] px-2 py-1 flex flex-col gap-1.5" style={{ color: 'var(--text-mute)', borderBottom: '1px solid var(--line)' }}>
                <div>
                  Coordinates below are in the dataset's source CRS (the point cloud's projected system), not GPS / WGS84 — this panel doesn't reproject for the plan view or CSV.
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span>GPX needs that CRS stated explicitly to convert to lat/lon:</span>
                  <select
                    className="mono text-[9px] py-0.5 px-1 rounded-md outline-none"
                    style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
                    value={crs.kind}
                    onChange={(e) => {
                      crsManuallySet.current = true;
                      const kind = e.target.value;
                      const recorded = octree?.meta.crs;
                      if (kind === 'recorded' && recorded) setCrs({ kind: 'recorded', spec: crsSpecOf(recorded), label: recorded.label });
                      else if (kind === 'tm35fin') setCrs({ kind: 'tm35fin' });
                      else if (kind === 'utm') setCrs({ kind: 'utm', zoneText: '', hemisphere: 'N' });
                      else setCrs({ kind: 'unset' });
                    }}
                  >
                    <option value="unset">not set</option>
                    {octree?.meta.crs && (
                      <option value="recorded">{octree.meta.crs.label} (recorded for this dataset)</option>
                    )}
                    <option value="tm35fin">ETRS-TM35FIN (EPSG:3067)</option>
                    <option value="utm">UTM zone … N/S (WGS84)</option>
                  </select>
                  {crs.kind === 'utm' && (
                    <>
                      <input
                        type="number" min={1} max={60} step={1}
                        placeholder="zone"
                        value={crs.zoneText}
                        onChange={(e) => { crsManuallySet.current = true; setCrs({ kind: 'utm', zoneText: e.target.value, hemisphere: crs.hemisphere }); }}
                        className="mono text-[9px] py-0.5 px-1 rounded-md outline-none"
                        style={{ width: 40, background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
                      />
                      <select
                        className="mono text-[9px] py-0.5 px-1 rounded-md outline-none"
                        style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
                        value={crs.hemisphere}
                        onChange={(e) => { crsManuallySet.current = true; setCrs({ kind: 'utm', zoneText: crs.zoneText, hemisphere: e.target.value === 'S' ? 'S' : 'N' }); }}
                      >
                        <option value="N">N</option>
                        <option value="S">S</option>
                      </select>
                    </>
                  )}
                </div>
                <div style={{ color: crsSpec ? 'var(--text-dim)' : '#e6c068' }}>
                  {crsSpec
                    ? `GPX will convert from ${crsLabel}. Picking the wrong CRS here silently produces the wrong positions — double-check it against how this dataset was actually surveyed.`
                    : 'GPX is disabled until a CRS is chosen above — PointCloudLabeler has no way to detect it from the dataset itself.'}
                </div>
                {gpxError && (
                  <div style={{ color: '#e0506b' }}>GPX conversion failed: {gpxError}</div>
                )}
              </div>
              <div className="max-h-[120px] overflow-y-auto scroll-thin">
                {spots.map((sp, i) => (
                  <div key={i} className="flex items-center gap-2 px-2 py-1" style={{ borderBottom: '1px solid var(--line)' }}>
                    <span className="mono text-[11px]" style={{ color: '#67d391', width: 18 }}>{i + 1}</span>
                    <span className="mono text-[10px] flex-1" style={{ color: 'var(--text-dim)' }}>
                      ({sp.x.toFixed(1)}, {sp.y.toFixed(1)})
                    </span>
                    <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
                      relights {sp.fixesTreeIds.length}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Worst-covered trees list */}
          {worst.length > 0 && (
            <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
              <div className="px-2 py-1 mono text-[10px]" style={{ color: 'var(--text-dim)', background: 'var(--wash-1)', borderBottom: '1px solid var(--line)' }}>
                Worst-covered trees
              </div>
              <div className="max-h-[200px] overflow-y-auto scroll-thin">
                {worst.map((t) => (
                  <button
                    key={t.treeId}
                    onClick={() => {
                      const bb = bboxes?.get(t.treeId);
                      if (!bb) return;
                      setFilters({ isolateTreeId: t.treeId, isolateBox: [bb.min, bb.max] });
                      api?.frameBox(bb.min, bb.max);
                    }}
                    className="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-white/[0.025]"
                    style={{ borderBottom: '1px solid var(--line)', borderLeft: `3px solid ${colourForConfidence(t.confidence)}` }}
                  >
                    <span className="mono text-[11px]" style={{ color: 'var(--text)', width: 50 }}>tree {t.treeId}</span>
                    <span className="mono text-[10px]" style={{ color: 'var(--text-dim)', width: 60 }}>{(t.confidence * 100).toFixed(0)} %</span>
                    <span className="mono text-[9.5px] flex-1" style={{ color: 'var(--text-mute)' }}>
                      {Number.isFinite(t.dbh) ? `DBH ${(t.dbh * 100).toFixed(1)} cm` : 'no DBH'}
                      {Number.isFinite(t.shadowAzimuth) ? ` · gap ${(t.shadowWidth * 180 / Math.PI).toFixed(0)}°` : ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Red → yellow → green ramp based on confidence (0..1). */
function colourForConfidence(c: number): string {
  if (!Number.isFinite(c)) return '#888';
  const t = Math.max(0, Math.min(1, c));
  // Piecewise: 0..0.5 red→yellow, 0.5..1 yellow→green.
  if (t < 0.5) {
    const k = t / 0.5;
    const r = 224 + (230 - 224) * k;
    const g = 80 + (192 - 80) * k;
    const b = 107 + (104 - 107) * k;
    return `rgb(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})`;
  }
  const k = (t - 0.5) / 0.5;
  const r = 230 + (103 - 230) * k;
  const g = 192 + (211 - 192) * k;
  const b = 104 + (145 - 104) * k;
  return `rgb(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})`;
}
