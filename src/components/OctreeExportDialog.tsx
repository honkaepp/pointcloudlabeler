// Export-options dialog for the octree → LAS/LAZ writer. Lets the user
// choose the container format, which attribute columns ride along, the
// coordinate precision, and whether to normalise Z to height-above-ground
// before the native save-file picker opens. Styled to match the editor
// shell + the New-project / Import dialogs (glass backdrop, chip section
// labels, accent-lit controls, keyboard hints).

import { useEffect, useMemo, useState } from 'react';
import { isDeadwoodExtra } from '../persistence/octreeReader';
import type { CrsListEntry, EpsgLookupEntry, GeoidStatus, OctreeCrs, VerticalCrs } from '../persistence/octreeReader';
import type { FilterConfig } from './shell/OctreeShellContext';

export interface OctreeExportOptions {
  format: 'las' | 'laz';
  /** Write Z as height above ground (point Z − DTM); X/Y stay loss-less. */
  normalize: boolean;
  /** DTM cell size (m) for the normalise pass. */
  cellSize: number;
  includeTreeId: boolean;
  includeSemantic: boolean;
  /** Emit the standing / laying deadwood id columns (i32 Extra-Bytes
   *  under their reserved names) so a round-trip keeps the deadwood. */
  includeStandingDeadwood: boolean;
  includeLayingDeadwood: boolean;
  keepClassification: boolean;
  keepIntensity: boolean;
  /** X/Y/Z decimal places; undefined = the octree's native quantisation. */
  decimals?: number;
  /** Names of numeric extras (from metadata.extras) to carry through to
   *  the output's Extra-Bytes (one f32 each). The dataset's
   *  height_above_ground / reflectance / amplitude / etc. live here. The
   *  deadwood channels are excluded — they have their own includes. */
  extrasToExport: string[];
  /** "Export what the filters show" payload — undefined when the
   *  checkbox is off (the default: unfiltered export) or when it's on
   *  but no Filters-panel constraint happens to be active. */
  filter?: OctreeExportFilter;
  /** Reproject every point into this CRS while streaming. `spec` is
   *  what actually goes over the wire to cloud_export_octree_las
   *  ("epsg:XXXX" or a raw proj4 string); `label` is display-only, for
   *  the export module's status message. undefined = no transformation
   *  — every point is written exactly as it's stored, the default and
   *  the only option when the dataset has no recorded source CRS. */
  targetCrs?: { spec: string; label: string };
  /** Geoid grid file name to convert ellipsoidal heights to orthometric
   *  on the way out (H = h - N). undefined = heights written exactly as
   *  stored, the default and the only option unless the dataset is
   *  recorded as ellipsoidal AND a grid is available. */
  geoid?: string;
  /** LAS 1.4 / point format 6 instead of LAS 1.2 / format 0. */
  las14?: boolean;
}

/** Mirrors src-tauri's `SubsetFilter` (commands/octree.rs) — the same
 *  predicate shape the Subset/extract command sends. Every field is
 *  optional on the wire; `buildExportFilter` below populates only the
 *  constraints that are currently active in the Filters panel. */
export interface OctreeExportFilter {
  xRange?: [number, number];
  yRange?: [number, number];
  zRange?: [number, number];
  intensityRange?: [number, number];
  treeIdRange?: [number, number];
  classes?: number[];
  extraRanges?: { name: string; min: number; max: number }[];
  hideUnassigned?: boolean;
  isolateTreeId?: number;
  semanticHidden?: number[];
  returnsHidden?: number[];
  hideStandingDeadwood?: boolean;
  hideLayingDeadwood?: boolean;
  onlyDeadwood?: boolean;
  /** Arbitrary-orientation cross-section, world coordinates. */
  planeSlab?: { anchor: [number, number, number]; normal: [number, number, number]; halfHeight: number };
}

/** Build the "export what the filters show" payload from the live
 *  Filters-panel state.
 *
 *  The isolate-neighbourhood opt-ins and the scan-inspection viewpoint
 *  (HPR) are genuinely view-dependent — they answer "what can I see from
 *  here", which no file can encode — so they are never included, and the
 *  dialog says so next to the checkbox.
 *
 *  The cross-section slab used to be grouped with them, and is not the
 *  same kind of thing: it is a static predicate on a point's world
 *  position, no different from the X/Y/Z ranges that do make the trip
 *  except for its orientation. Cutting a section and exporting what the
 *  filters show returned the whole cloud. It now travels.
 *
 *  Returns undefined when nothing is actually active, so the invoke
 *  omits `filter` entirely and the exporter takes its normal unfiltered
 *  path. */
export function buildExportFilter(f: FilterConfig): OctreeExportFilter | undefined {
  const out: OctreeExportFilter = {};
  if (f.hideUnassigned) out.hideUnassigned = true;
  if (f.planeSlab) out.planeSlab = f.planeSlab;
  if (f.isolateTreeId !== null) out.isolateTreeId = f.isolateTreeId;
  if (f.treeIdRange !== null) out.treeIdRange = f.treeIdRange;
  if (f.hiddenClasses.length > 0) {
    // SubsetFilter.classes is a KEEP-list (existing Subset-panel
    // behaviour, left unchanged server-side) while the panel exposes a
    // HIDE-list — convert via the complement over the full ASPRS byte
    // range so the export keeps exactly the classes the panel isn't
    // hiding.
    const hidden = new Set(f.hiddenClasses);
    const keep: number[] = [];
    for (let c = 0; c < 256; c++) if (!hidden.has(c)) keep.push(c);
    out.classes = keep;
  }
  if (f.hiddenSemantic.length > 0) out.semanticHidden = f.hiddenSemantic;
  if (f.hiddenReturns.length > 0) out.returnsHidden = f.hiddenReturns;
  if (f.hideStandingDeadwood) out.hideStandingDeadwood = true;
  if (f.hideLayingDeadwood) out.hideLayingDeadwood = true;
  if (f.onlyDeadwood) out.onlyDeadwood = true;
  if (f.xRange !== null) out.xRange = f.xRange;
  if (f.yRange !== null) out.yRange = f.yRange;
  if (f.zRange !== null) out.zRange = f.zRange;
  if (f.intensityRange !== null) out.intensityRange = f.intensityRange;
  if (f.extraRange !== null) {
    out.extraRanges = [{ name: f.extraRange.name, min: f.extraRange.lo, max: f.extraRange.hi }];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const SEMANTIC_LABEL: Record<number, string> = { 0: 'unlabelled', 1: 'stem', 2: 'branch' };

function fmtRange(r: [number, number]): string {
  const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2));
  return `${fmt(r[0])}…${fmt(r[1])}`;
}

/** Short, plain-English label for each active FilterConfig constraint
 *  that DOES reach the export — drives the checkbox's "will apply"
 *  list. Order matches `buildExportFilter` above. */
export function describeActiveFilters(f: FilterConfig): string[] {
  const out: string[] = [];
  if (f.hideUnassigned) out.push('hide unassigned');
  if (f.planeSlab) out.push(`cross-section ${(f.planeSlab.halfHeight * 200).toFixed(0)} cm thick`);
  if (f.isolateTreeId !== null) out.push(`isolate tree ${f.isolateTreeId}`);
  if (f.treeIdRange !== null) out.push(`tree_id ${fmtRange(f.treeIdRange)}`);
  if (f.hiddenClasses.length > 0) out.push(`hidden classes ${f.hiddenClasses.join(', ')}`);
  if (f.hiddenSemantic.length > 0) out.push(`hidden semantic ${f.hiddenSemantic.map(s => SEMANTIC_LABEL[s] ?? s).join(', ')}`);
  if (f.hiddenReturns.length > 0) out.push(`hidden returns ${f.hiddenReturns.join(', ')}`);
  if (f.hideStandingDeadwood) out.push('hide standing deadwood');
  if (f.hideLayingDeadwood) out.push('hide laying deadwood');
  if (f.onlyDeadwood) out.push('only deadwood-labelled points');
  if (f.xRange !== null) out.push(`X ${fmtRange(f.xRange)}`);
  if (f.yRange !== null) out.push(`Y ${fmtRange(f.yRange)}`);
  if (f.zRange !== null) out.push(`Z ${fmtRange(f.zRange)}`);
  if (f.intensityRange !== null) out.push(`intensity ${fmtRange(f.intensityRange)}`);
  if (f.extraRange !== null) out.push(`${f.extraRange.name} ${fmtRange([f.extraRange.lo, f.extraRange.hi])}`);
  return out;
}

/** One numeric extra column the source dataset carries, surfaced as a
 *  checkbox in the export dialog. The min/max + label is informational. */
export interface OctreeExportExtra {
  name: string;
  min: number;
  max: number;
}

interface Props {
  /** The dataset being exported, for the source-grid realignment below. */
  octreeDir?: string;
  /** Called after the dataset's offset was moved, so the viewer reloads it. */
  onRealigned?: () => void;
  datasetName: string;
  /** Numeric extras the source dataset carries (metadata.extras). Each
   *  gets a checkbox; checked names ride along as f32 Extra-Bytes. */
  availableExtras?: OctreeExportExtra[];
  /** Live Filters-panel state — used to build the optional "export what
   *  the filters show" payload and to describe which constraints are
   *  currently active in the "Apply current view filters" disclosure. */
  filters: FilterConfig;
  /** The dataset's own recorded CRS (metadata.json's `crs`, set via the
   *  Layers panel), if any. Shown beside the "Output coordinate system"
   *  row as the SOURCE the reprojection would start from; undefined
   *  disables that row entirely (see its own note) rather than letting
   *  a transform run against a guessed source. */
  sourceCrs?: OctreeCrs;
  /** The dataset's recorded vertical datum (metadata.json's `vertical`).
   *  undefined means UNRECORDED, which is why the height-conversion row
   *  is offered only when this says "ellipsoidal": the backend refuses
   *  to guess, and a control that always fails is worse than one that
   *  says why it is unavailable. */
  verticalCrs?: VerticalCrs;
  onCancel: () => void;
  onExport: (opts: OctreeExportOptions) => void;
}

/** Bridge surface this dialog reaches directly for the "Output
 *  coordinate system" row's search box — the same read-only-query
 *  pattern the Layers panel's own CRS row uses for crs_list. Everything
 *  else the dialog needs travels through onExport's plain options
 *  object; this is reference data the row looks up as the user types,
 *  not an export action. */
interface Desktop {
  openFileDialog?: (opts?: { filters?: { name: string; extensions: string[] }[] }) => Promise<{ path: string } | null>;
  octreeRealignToSource?: (octreeDir: string, lasPath: string) => Promise<{
    shiftMm: [number, number, number]; alreadyAligned: boolean;
    scale: [number, number, number]; sourceScale: [number, number, number];
  }>;
  crsList?: () => Promise<CrsListEntry[]>;
  crsSearch?: (query: string, limit: number) => Promise<EpsgLookupEntry[]>;
  crsLookup?: (code: number) => Promise<EpsgLookupEntry>;
}

// Precision presets. 'native' keeps the octree's own scale (loss-less);
// the others re-quantise X/Y/Z to that many decimals.
const PRECISION: { key: string; label: string; sub: string; decimals?: number }[] = [
  { key: 'native', label: 'Native', sub: 'loss-less' },
  { key: 'mm', label: '1 mm', sub: '3 dp', decimals: 3 },
  { key: 'cm', label: '1 cm', sub: '2 dp', decimals: 2 },
  { key: 'dm', label: '10 cm', sub: '1 dp', decimals: 1 },
];

export default function OctreeExportDialog({ datasetName, availableExtras = [], filters, sourceCrs, verticalCrs, onCancel, onExport, octreeDir, onRealigned }: Props) {
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;
  // "Native" is exact against the dataset's own grid. A dataset imported
  // before the grid was aligned to its source file sits up to half a
  // millimetre off the file, every point the same way — the whole cloud
  // came back from an export shifted against the original. This moves
  // the dataset's offset onto the file's grid, one metadata field, no
  // point touched, and says how far everything moved.
  const [alignMsg, setAlignMsg] = useState<string | null>(null);
  const [aligning, setAligning] = useState(false);
  const alignToSource = async () => {
    if (!desktop?.openFileDialog || !desktop.octreeRealignToSource || !octreeDir) return;
    setAligning(true);
    try {
      const picked = await desktop.openFileDialog({ filters: [{ name: 'Source LAS / LAZ', extensions: ['las', 'laz'] }] });
      if (!picked) return;
      const r = await desktop.octreeRealignToSource(octreeDir, picked.path);
      if (r.alreadyAligned) {
        setAlignMsg('Already on the source file\u2019s grid \u2014 nothing moved.');
      } else {
        const mm = r.shiftMm.map(v => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`);
        setAlignMsg(`Moved onto the source grid: X ${mm[0]} mm, Y ${mm[1]} mm, Z ${mm[2]} mm. The export below now matches the file exactly.`);
        onRealigned?.();
      }
    } catch (e) {
      setAlignMsg(`Could not align: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAligning(false);
    }
  };
  const [format, setFormat] = useState<'las' | 'laz'>('las');
  // LAS 1.2 stays the default: it is what every older tool reads, and
  // silently changing an existing workflow's output format would be its
  // own surprise. 1.4 is offered, with what it costs stated.
  const [las14, setLas14] = useState(false);
  const [precision, setPrecision] = useState('native');
  const [includeTreeId, setIncludeTreeId] = useState(true);
  const [includeSemantic, setIncludeSemantic] = useState(true);
  const [keepClassification, setKeepClassification] = useState(true);
  const [keepIntensity, setKeepIntensity] = useState(true);
  const [normalize, setNormalize] = useState(false);
  const [cellSize, setCellSize] = useState(0.5);

  // --- Output coordinate system --------------------------------------
  //
  // `targetMode` drives the <select>: '' = same as source (the default —
  // no transformation), 'other' = raw proj4 string, 'search' = the full-
  // registry search/code box, else a curated EPSG code (as a string, so
  // '' can mean "nothing picked yet" without colliding with EPSG 0).
  const [targetMode, setTargetMode] = useState('');
  const [crsOptions, setCrsOptions] = useState<CrsListEntry[]>([]);
  const [otherProj, setOtherProj] = useState('');
  const [otherLabel, setOtherLabel] = useState('');
  // Full-registry search box state. `query` drives both a live crsSearch
  // (name-fragment match) AND, when it parses as a bare number, a
  // crsLookup for that exact code — a user who already knows their EPSG
  // code gets an immediate, unambiguous single result instead of having
  // to scan a name-search list for it.
  const [lookupQuery, setLookupQuery] = useState('');
  const [lookupResults, setLookupResults] = useState<EpsgLookupEntry[]>([]);
  const [lookupExact, setLookupExact] = useState<EpsgLookupEntry | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupPicked, setLookupPicked] = useState<EpsgLookupEntry | null>(null);

  useEffect(() => {
    if (!desktop?.crsList) return;
    let cancelled = false;
    desktop.crsList().then(rows => { if (!cancelled) setCrsOptions(rows); }).catch(() => { /* picker just stays empty */ });
    return () => { cancelled = true; };
  }, [desktop]);

  // Debounced search-as-you-type — a local IPC round trip is cheap, but
  // there's no reason to fire one on every keystroke of a fast typist.
  useEffect(() => {
    if (targetMode !== 'search') return;
    const q = lookupQuery.trim();
    if (!q) { setLookupResults([]); setLookupExact(null); setLookupError(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      desktop?.crsSearch?.(q, 20)
        .then(rows => { if (!cancelled) setLookupResults(rows); })
        .catch(() => { if (!cancelled) setLookupResults([]); });
      const numeric = /^\d+$/.test(q) ? parseInt(q, 10) : null;
      if (numeric === null) {
        setLookupExact(null);
        setLookupError(null);
      } else {
        desktop?.crsLookup?.(numeric)
          .then(e => { if (!cancelled) { setLookupExact(e); setLookupError(null); } })
          .catch(e => { if (!cancelled) { setLookupExact(null); setLookupError(e instanceof Error ? e.message : String(e)); } });
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [lookupQuery, targetMode, desktop]);

  // Resolve whatever the row's currently showing into the wire-ready
  // spec `cloud_export_octree_las` needs, or null when nothing usable is
  // picked yet (including: no source CRS at all, so the row is disabled
  // and this must stay null regardless of leftover local state).
  const resolvedTargetCrs = useMemo<{ spec: string; label: string } | null>(() => {
    if (!sourceCrs || !targetMode) return null;
    if (targetMode === 'other') {
      const proj = otherProj.trim();
      return proj ? { spec: proj, label: otherLabel.trim() || 'Custom (proj4)' } : null;
    }
    if (targetMode === 'search') {
      return lookupPicked ? { spec: `epsg:${lookupPicked.code}`, label: `${lookupPicked.name} (EPSG:${lookupPicked.code})` } : null;
    }
    const epsg = parseInt(targetMode, 10);
    const found = crsOptions.find(o => o.epsg === epsg);
    return found ? { spec: `epsg:${epsg}`, label: `${found.label} (EPSG:${epsg})` } : null;
  }, [sourceCrs, targetMode, otherProj, otherLabel, lookupPicked, crsOptions]);
  // A mode is chosen but hasn't resolved to a concrete spec yet (still
  // typing a proj4 string, or hasn't clicked a search result) — the
  // export button stays disabled rather than silently falling back to
  // "no transformation" when the user's clear intent was to reproject.
  const targetCrsPending = targetMode !== '' && resolvedTargetCrs === null;
  // "Export what the filters show" — off by default so export keeps its
  // long-standing "everything non-deleted" behaviour unless asked
  // otherwise. The active-constraints list recomputes from the live
  // `filters` prop so it can never drift from what would actually be sent.
  const [applyFilters, setApplyFilters] = useState(false);
  const activeFilterDescriptions = useMemo(() => describeActiveFilters(filters), [filters]);
  // The two deadwood id channels are reserved extras; surface them as their
  // own checkboxes (written as i32 under their reserved names) rather than
  // generic f32 numeric extras. Default on so a labelled cloud round-trips.
  const hasStandingDeadwood = availableExtras.some(e => e.name.toLowerCase() === 'standing_deadwood');
  const hasLayingDeadwood = availableExtras.some(e => e.name.toLowerCase() === 'laying_deadwood');
  const [includeStandingDeadwood, setIncludeStandingDeadwood] = useState(true);
  const [includeLayingDeadwood, setIncludeLayingDeadwood] = useState(true);
  // Generic numeric extras = everything except the deadwood channels.
  const numericExtras = availableExtras.filter(e => !isDeadwoodExtra(e.name));
  // Default every available numeric extra to "on" so a height-above-ground
  // column, once computed, rides along by default — that's the common case
  // ("I want my LAZ to carry the hag I just made"). The user can untick
  // any of them per-export.
  const [extraOn, setExtraOn] = useState<Record<string, boolean>>(() => {
    const m: Record<string, boolean> = {};
    for (const e of availableExtras) if (!isDeadwoodExtra(e.name)) m[e.name] = true;
    return m;
  });

  // Geoid models available in the geodetic data folder. Loaded once when
  // the dialog opens; an empty list is a legitimate answer (PointCloudLabeler ships
  // no grids) and is reported as such rather than as a failure.
  const [geoidModels, setGeoidModels] = useState<string[]>([]);
  const [geoid, setGeoid] = useState<string>('');
  useEffect(() => {
    const desktop = (window as unknown as { desktop?: { geoidStatus?: () => Promise<GeoidStatus> } }).desktop;
    if (!desktop?.geoidStatus) return;
    let cancelled = false;
    desktop.geoidStatus()
      .then(st => {
        // Only offer grids that actually parsed. Offering one that failed
        // would turn a clear "this file could not be read" in the
        // Geodetic data row into a failed export minutes later.
        if (!cancelled) setGeoidModels(st.files.filter(f => f.checked && f.ok).map(f => f.file));
      })
      .catch(() => { /* geoid_status never throws; nothing to recover from */ });
    return () => { cancelled = true; };
  }, []);

  // Why the height conversion may not be offered. Each reason names the
  // thing to go fix — "unavailable" with no explanation is what sends
  // someone looking in the wrong place.
  const geoidBlockedReason =
    !verticalCrs ? "the dataset's height reference is not recorded — set it in Layers → Height. PointCloudLabeler will not convert heights whose datum it has not been told."
    : verticalCrs.datum === 'orthometric' ? 'these heights are already orthometric — nothing to convert.'
    : geoidModels.length === 0 ? 'no geoid grids found — add a .gtx file under Layers → Geodetic data.'
    : null;
  const canPickGeoid = geoidBlockedReason === null;
  // A stale selection must not outlive the reason it was allowed.
  useEffect(() => { if (!canPickGeoid && geoid) setGeoid(''); }, [canPickGeoid, geoid]);

  // normalize + geoid is the same class of contradiction as normalize +
  // target CRS, and the Rust side rejects it identically: normalised Z is
  // a height above ground, so there is no ellipsoidal height for the
  // undulation to come off.
  const geoidNormalizeConflict = normalize && geoid !== '';

  // normalize + a resolved target CRS is a contradiction the Rust side
  // also rejects (normalised Z has no coordinate in any CRS) — caught
  // here too so the user hits it before the save-file dialog, not after.
  const crsNormalizeConflict = normalize && resolvedTargetCrs !== null;
  const canSubmit = !targetCrsPending && !crsNormalizeConflict && !geoidNormalizeConflict;

  const submit = () => {
    if (!canSubmit) return;
    const dp = PRECISION.find(p => p.key === precision)?.decimals;
    onExport({
      format, normalize, cellSize,
      includeTreeId, includeSemantic,
      includeStandingDeadwood: hasStandingDeadwood && includeStandingDeadwood,
      includeLayingDeadwood: hasLayingDeadwood && includeLayingDeadwood,
      keepClassification, keepIntensity,
      decimals: dp,
      extrasToExport: numericExtras.filter(e => extraOn[e.name]).map(e => e.name),
      filter: applyFilters ? buildExportFilter(filters) : undefined,
      targetCrs: resolvedTargetCrs ?? undefined,
      geoid: canPickGeoid && geoid ? geoid : undefined,
      las14,
    });
  };

  // Esc cancels; ⌘/Ctrl+Enter exports.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, precision, includeTreeId, includeSemantic, includeStandingDeadwood, includeLayingDeadwood, keepClassification, keepIntensity, normalize, cellSize, extraOn, applyFilters, filters, canSubmit, resolvedTargetCrs]);

  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center pointer-events-auto"
      style={{ background: 'rgba(6,10,8,0.62)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
      role="dialog"
      aria-label="Export options"
    >
      <div className="panel rounded-xl overflow-hidden" style={{ width: 560, maxWidth: '94vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="rounded-md flex items-center justify-center" style={{ width: 30, height: 30, background: 'color-mix(in oklch, var(--accent) 18%, transparent)', border: '1px solid color-mix(in oklch, var(--accent) 45%, transparent)' }}>
            <ExportIcon />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text)' }}>Export cloud</div>
            <div className="mono text-[10.5px] truncate" style={{ color: 'var(--text-mute)' }}>{datasetName} · all edits + merges applied</div>
          </div>
          <button className="btn btn-ghost !h-7 !w-7 !p-0 justify-center" onClick={onCancel} title="Cancel (Esc)">✕</button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto">
          <Field label="Format">
            <div className="flex gap-1 p-0.5 rounded-md" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)' }}>
              {([
                { v: 'las', label: 'LAS', sub: 'uncompressed' },
                { v: 'laz', label: 'LAZ', sub: 'compressed' },
              ] as const).map(o => {
                const active = format === o.v;
                return (
                  <button
                    key={o.v}
                    onClick={() => setFormat(o.v)}
                    className="flex-1 flex flex-col items-center rounded py-1.5 transition-all"
                    style={{
                      background: active ? 'color-mix(in oklch, var(--accent) 20%, transparent)' : 'transparent',
                      color: active ? 'var(--accent)' : 'var(--text-dim)',
                    }}
                  >
                    <span className="mono text-[12px]">{o.label}</span>
                    <span className="mono text-[9px]" style={{ color: 'var(--text-mute)' }}>{o.sub}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex gap-1 p-0.5 rounded-md mt-1.5" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)' }}>
              {([
                { v: false, label: 'LAS 1.2', sub: 'widest compatibility' },
                { v: true, label: 'LAS 1.4', sub: 'full classification' },
              ] as const).map(o => {
                const active = las14 === o.v;
                return (
                  <button
                    key={String(o.v)}
                    onClick={() => setLas14(o.v)}
                    className="flex-1 flex flex-col items-center rounded py-1.5 transition-all"
                    style={{
                      background: active ? 'color-mix(in oklch, var(--accent) 20%, transparent)' : 'transparent',
                      color: active ? 'var(--accent)' : 'var(--text-dim)',
                    }}
                  >
                    <span className="mono text-[12px]">{o.label}</span>
                    <span className="mono text-[9px]" style={{ color: 'var(--text-mute)' }}>{o.sub}</span>
                  </button>
                );
              })}
            </div>
            <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              {las14
                ? 'Point format 6: classification keeps its full 0–255 range and returns go to 15. PointCloudLabeler stores no per-point GPS time, so that field — part of this record format — is written as zero.'
                : 'Point format 0: classification is five bits, so a code above 31 (the ASPRS user-definable range) cannot be written and becomes 0. Choose LAS 1.4 to keep it.'}
            </div>
          </Field>

          <Field label="Attributes">
            <div className="grid grid-cols-2 gap-1.5">
              <Check label="tree_id" sub="instance segmentation" checked={includeTreeId} onChange={setIncludeTreeId} />
              <Check label="semantic" sub="stem / branch" checked={includeSemantic} onChange={setIncludeSemantic} />
              <Check label="classification" sub="ASPRS / ground" checked={keepClassification} onChange={setKeepClassification} />
              <Check label="intensity" sub="return strength" checked={keepIntensity} onChange={setKeepIntensity} />
              {hasStandingDeadwood && (
                <Check label="standing_deadwood" sub="standing dead trees" checked={includeStandingDeadwood} onChange={setIncludeStandingDeadwood} />
              )}
              {hasLayingDeadwood && (
                <Check label="laying_deadwood" sub="fallen dead trees" checked={includeLayingDeadwood} onChange={setIncludeLayingDeadwood} />
              )}
            </div>
            <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              X / Y / Z and return number are always written. tree_id, semantic and the deadwood id channels ride in Extra-Bytes; unchecked fields are written as zero.
            </div>
          </Field>

          {numericExtras.length > 0 && (
            <Field label="Numeric extras">
              <div className="grid grid-cols-2 gap-1.5">
                {numericExtras.map(e => (
                  <Check
                    key={e.name}
                    label={e.name}
                    sub={`${formatRange(e.min)} … ${formatRange(e.max)}`}
                    checked={!!extraOn[e.name]}
                    onChange={(b) => setExtraOn(m => ({ ...m, [e.name]: b }))}
                  />
                ))}
              </div>
              <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
                Each ticked column is written as one f32 in the file's Extra-Bytes (4 B / point), under its original name — so a re-import or any reader that honours the Extra-Bytes VLR picks it up. A computed <span style={{ color: 'var(--text-dim)' }}>height_above_ground</span> rides along here so the LAZ keeps the absolute Z while still carrying the normalised height.
              </div>
            </Field>
          )}

          <Field label="Coordinate precision">
            <div className="grid grid-cols-4 gap-1.5">
              {PRECISION.map(p => {
                const active = precision === p.key;
                return (
                  <button
                    key={p.key}
                    onClick={() => setPrecision(p.key)}
                    className="rounded-md py-1.5 flex flex-col items-center transition-all"
                    style={{
                      border: `1px solid ${active ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : 'var(--line)'}`,
                      background: active ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'transparent',
                    }}
                  >
                    <span className="mono text-[11.5px]" style={{ color: active ? 'var(--text)' : 'var(--text-dim)' }}>{p.label}</span>
                    <span className="mono text-[9px]" style={{ color: 'var(--text-mute)' }}>{p.sub}</span>
                  </button>
                );
              })}
            </div>
            {octreeDir && desktop?.octreeRealignToSource && (
              <div className="mt-1.5 flex items-start gap-2">
                <span className="mono text-[9.5px] flex-1 min-w-0" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
                  Native is exact against this dataset\u2019s own grid. A dataset imported before the grid was aligned to its
                  source file can sit up to half a millimetre off the file, every point the same way. Pick the original
                  LAS/LAZ to move it back onto the file\u2019s grid \u2014 one metadata field, no point rewritten.
                </span>
                <button
                  className="btn !h-7 mono text-[10.5px] shrink-0"
                  disabled={aligning}
                  onClick={() => void alignToSource()}
                  title="Choose the LAS/LAZ this dataset was imported from"
                >{aligning ? 'Aligning\u2026' : 'Align to source LAS\u2026'}</button>
              </div>
            )}
            {alignMsg && (
              <div className="mono text-[9.5px] mt-1" style={{ color: alignMsg.startsWith('Could not') ? '#e07a6a' : '#e6c068', lineHeight: 1.45 }}>{alignMsg}</div>
            )}
          </Field>

          <Field label="Vertical">
            <label
              className="flex items-center gap-2 select-none"
              style={{ cursor: resolvedTargetCrs ? 'not-allowed' : 'pointer', opacity: resolvedTargetCrs ? 0.5 : 1 }}
            >
              <Checkbox checked={normalize} onChange={resolvedTargetCrs ? () => {} : setNormalize} />
              <span className="mono text-[11.5px]" style={{ color: 'var(--text)' }}>Normalise Z to height above ground</span>
            </label>
            {normalize && (
              <div className="flex items-center gap-2 mt-2 pl-6">
                <span className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>DTM cell</span>
                <input
                  type="number" min={0.1} step={0.1} value={cellSize}
                  onChange={(e) => { const v = parseFloat(e.target.value); setCellSize(Number.isFinite(v) && v > 0 ? v : 0.5); }}
                  className="px-2 py-1 mono text-[11.5px] rounded-md outline-none"
                  style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)', width: 72 }}
                />
                <span className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>m · bare-earth grid</span>
              </div>
            )}
            <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              {resolvedTargetCrs
                ? "Disabled while an output coordinate system is chosen below — normalised Z is a height above ground, not a coordinate in any CRS, so the two can't combine."
                : normalize
                  ? 'Z becomes height above the bare-earth DTM (Z-offset 0). X / Y stay loss-less.'
                  : 'Z stays at its absolute elevation.'}
            </div>
          </Field>

          <Field label="Height reference">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>Dataset:</span>
              <span
                className="mono text-[10.5px]"
                style={{ color: verticalCrs ? 'var(--accent)' : '#e6c068' }}
              >
                {verticalCrs
                  ? (verticalCrs.label ? `${verticalCrs.datum} (${verticalCrs.label})` : verticalCrs.datum)
                  : 'not recorded'}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              <select
                className="px-2 py-1 mono text-[11.5px] rounded-md outline-none"
                style={{
                  background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)',
                  color: canPickGeoid ? 'var(--text)' : 'var(--text-mute)', minWidth: 220,
                }}
                value={geoid}
                disabled={!canPickGeoid || normalize}
                onChange={(e) => setGeoid(e.target.value)}
              >
                <option value="">Keep ellipsoidal (no conversion)</option>
                {geoidModels.map(m => (
                  <option key={m} value={m}>Convert to orthometric · {m}</option>
                ))}
              </select>
            </div>
            <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              {normalize
                ? "Disabled while Normalise Z is on — normalised Z is a height above ground, so there is no ellipsoidal height for the undulation to come off."
                : geoidBlockedReason
                  ? `Unavailable: ${geoidBlockedReason}`
                  : geoid
                    ? 'Z is written as height above the geoid (H = h − N), applied after any reprojection above.'
                    : 'Z is written exactly as stored — height above the ellipsoid.'}
            </div>
          </Field>

          <Field label="Output coordinate system">
            <CrsTargetRow
              sourceCrs={sourceCrs}
              disabledByNormalize={normalize}
              options={crsOptions}
              mode={targetMode}
              onModeChange={setTargetMode}
              otherProj={otherProj}
              onOtherProjChange={setOtherProj}
              otherLabel={otherLabel}
              onOtherLabelChange={setOtherLabel}
              lookupQuery={lookupQuery}
              onLookupQueryChange={setLookupQuery}
              lookupResults={lookupResults}
              lookupExact={lookupExact}
              lookupError={lookupError}
              lookupPicked={lookupPicked}
              onPick={setLookupPicked}
              resolved={resolvedTargetCrs}
            />
          </Field>

          <Field label="View filters">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <Checkbox checked={applyFilters} onChange={setApplyFilters} />
              <span className="mono text-[11.5px]" style={{ color: 'var(--text)' }}>Apply current view filters</span>
            </label>
            {applyFilters && (
              <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.6 }}>
                {activeFilterDescriptions.length > 0 ? (
                  <div>Will apply: <span style={{ color: 'var(--text-dim)' }}>{activeFilterDescriptions.join(' · ')}</span></div>
                ) : (
                  <div>No Filters-panel constraint is active right now, so this export won't drop any points.</div>
                )}
                <div className="mt-1">
                  Not applied: isolate neighbourhood (show unassigned nearby, show other trees nearby, margin, height band) and the scan-inspection viewpoint (Hidden Point Removal) — these answer “what can I see from here”, which no file can encode. The cross-section slab IS applied.
                </div>
              </div>
            )}
          </Field>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3.5" style={{ borderTop: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
            <span className="kbd">⌘</span><span className="kbd">↵</span> export · <span className="kbd">Esc</span> cancel
          </span>
          <div className="flex gap-1.5">
            <button className="btn !px-3" onClick={onCancel}>Cancel</button>
            <button
              className="btn btn-primary !px-3"
              onClick={submit}
              disabled={!canSubmit}
              title={
                crsNormalizeConflict
                  ? "Normalise Z and an output coordinate system can't both be set"
                  : targetCrsPending
                    ? 'Finish choosing an output coordinate system, or switch it back to "Same as source"'
                    : 'Choose a destination and write the file'
              }
            >
              Choose file & export
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatRange(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1000 || (a > 0 && a < 0.01)) return n.toExponential(1);
  if (a >= 100) return n.toFixed(1);
  if (a >= 1) return n.toFixed(2);
  return n.toFixed(3);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="chip mb-1.5" style={{ width: 'fit-content' }}>{label}</div>
      {children}
    </div>
  );
}

/** The "Output coordinate system" row: shows the dataset's recorded
 *  SOURCE crs (or a disabling warning when it has none — see the module
 *  header's "never guess a source CRS" rule, mirrored here so the UI
 *  can't offer a control that would have to guess), a mode selector
 *  (same as source / curated shortlist / full-registry search / raw
 *  proj4), and — once something's actually chosen — a plain statement
 *  of what reprojecting will and won't affect. Styled to match
 *  LayersPanel's CrsRow (the Layers panel's own "record the source CRS"
 *  control), since this is the same kind of picker doing an adjacent
 *  job: LayersPanel records what the data already IS, this row picks
 *  what a COPY of it should become on the way out. */
function CrsTargetRow({
  sourceCrs, disabledByNormalize, options, mode, onModeChange,
  otherProj, onOtherProjChange, otherLabel, onOtherLabelChange,
  lookupQuery, onLookupQueryChange, lookupResults, lookupExact, lookupError,
  lookupPicked, onPick, resolved,
}: {
  sourceCrs?: OctreeCrs;
  disabledByNormalize: boolean;
  options: CrsListEntry[];
  mode: string;
  onModeChange: (v: string) => void;
  otherProj: string;
  onOtherProjChange: (v: string) => void;
  otherLabel: string;
  onOtherLabelChange: (v: string) => void;
  lookupQuery: string;
  onLookupQueryChange: (v: string) => void;
  lookupResults: EpsgLookupEntry[];
  lookupExact: EpsgLookupEntry | null;
  lookupError: string | null;
  lookupPicked: EpsgLookupEntry | null;
  onPick: (e: EpsgLookupEntry) => void;
  resolved: { spec: string; label: string } | null;
}) {
  const disabled = !sourceCrs || disabledByNormalize;
  const inputStyle: React.CSSProperties = { background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' };

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>Source</span>
        <span
          className="mono text-[10px] truncate"
          style={{ color: sourceCrs ? 'var(--accent)' : '#e6c068', maxWidth: 340 }}
          title={sourceCrs?.label ?? 'not set'}
        >
          {sourceCrs ? sourceCrs.label : 'not set — see the warning below'}
        </span>
      </div>

      <select
        className="bg-transparent mono text-[11px] px-1.5 py-1 w-full"
        style={{ ...inputStyle, borderRadius: 4, opacity: disabled ? 0.5 : 1 }}
        value={mode}
        onChange={(e) => onModeChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">Same as source (no transformation)</option>
        {options.map(o => (
          <option key={o.epsg} value={String(o.epsg)}>{o.label} (EPSG:{o.epsg})</option>
        ))}
        <option value="search">Search by EPSG code or name…</option>
        <option value="other">Other (proj4 string)…</option>
      </select>

      {!sourceCrs && (
        <div className="mono text-[9.5px] mt-1.5 px-1 py-1 rounded-sm" style={{ color: '#e6c068', background: 'rgba(230,192,104,0.08)', lineHeight: 1.5 }}>
          This dataset has no recorded coordinate system, so it can&apos;t be reprojected — set one first in the Layers panel&apos;s Coordinate system row, then reopen this dialog.
        </div>
      )}
      {sourceCrs && disabledByNormalize && (
        <div className="mono text-[9.5px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Disabled while Z normalisation is on (above) — turn that off to reproject instead.
        </div>
      )}

      {!disabled && mode === 'search' && (
        <div className="mt-2 flex flex-col gap-1">
          <input
            type="text"
            placeholder="e.g. 3067, TM35, Switzerland…"
            value={lookupQuery}
            onChange={(e) => { onLookupQueryChange(e.target.value); }}
            className="mono text-[10.5px] px-2 py-1 rounded-md outline-none"
            style={inputStyle}
            autoFocus
          />
          {lookupError && (
            <div className="mono text-[9.5px] px-1" style={{ color: '#e0506b' }}>{lookupError}</div>
          )}
          {(lookupExact || lookupResults.length > 0) && (
            <div className="rounded-md overflow-hidden max-h-[140px] overflow-y-auto scroll-thin" style={{ border: '1px solid var(--line)' }}>
              {lookupExact && (
                <CrsResultRow entry={lookupExact} picked={lookupPicked?.code === lookupExact.code} onClick={() => onPick(lookupExact)} exact />
              )}
              {lookupResults.filter(r => r.code !== lookupExact?.code).map(r => (
                <CrsResultRow key={r.code} entry={r} picked={lookupPicked?.code === r.code} onClick={() => onPick(r)} />
              ))}
            </div>
          )}
          {lookupQuery.trim() && !lookupError && !lookupExact && lookupResults.length === 0 && (
            <div className="mono text-[9.5px] px-1" style={{ color: 'var(--text-mute)' }}>No matches.</div>
          )}
        </div>
      )}

      {!disabled && mode === 'other' && (
        <div className="mt-2 flex flex-col gap-1">
          <input
            type="text"
            placeholder="+proj=... +ellps=... +units=m +no_defs"
            value={otherProj}
            onChange={(e) => onOtherProjChange(e.target.value)}
            className="mono text-[10.5px] px-2 py-1 rounded-md outline-none"
            style={inputStyle}
          />
          <input
            type="text"
            placeholder="Label (e.g. a local grid's name)"
            value={otherLabel}
            onChange={(e) => onOtherLabelChange(e.target.value)}
            className="mono text-[10.5px] px-2 py-1 rounded-md outline-none"
            style={inputStyle}
          />
        </div>
      )}

      <div className="mono text-[10px] mt-1.5" style={{ color: resolved ? '#e6c068' : 'var(--text-mute)', lineHeight: 1.5 }}>
        {resolved && sourceCrs
          ? `Every point will be reprojected from ${sourceCrs.label} to ${resolved.label} while writing this file. Only the exported file is affected — the saved dataset itself stays in ${sourceCrs.label} untouched.`
          : 'Leave this as "Same as source" to export the dataset\'s own coordinates unchanged (the default, loss-less path).'}
      </div>
    </div>
  );
}

function CrsResultRow({ entry, picked, onClick, exact }: { entry: EpsgLookupEntry; picked: boolean; onClick: () => void; exact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center justify-between gap-2 px-2 py-1 text-left"
      style={{
        borderBottom: '1px solid var(--line)',
        background: picked ? 'color-mix(in oklch, var(--accent) 14%, transparent)' : exact ? 'var(--wash-1)' : 'transparent',
      }}
    >
      <span className="mono text-[10.5px] truncate" style={{ color: picked ? 'var(--accent)' : 'var(--text-dim)' }}>{entry.name}</span>
      <span className="mono text-[9.5px] shrink-0" style={{ color: 'var(--text-mute)' }}>EPSG:{entry.code}</span>
    </button>
  );
}

function Check({ label, sub, checked, onChange }: {
  label: string; sub: string; checked: boolean; onChange: (b: boolean) => void;
}) {
  return (
    <label
      className="flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer select-none"
      style={{
        border: `1px solid ${checked ? 'color-mix(in oklch, var(--accent) 40%, transparent)' : 'var(--line)'}`,
        background: checked ? 'color-mix(in oklch, var(--accent) 8%, transparent)' : 'transparent',
      }}
    >
      <Checkbox checked={checked} onChange={onChange} />
      <span className="min-w-0">
        <span className="mono text-[11px] block truncate" style={{ color: checked ? 'var(--text)' : 'var(--text-dim)' }}>{label}</span>
        <span className="mono text-[9px] block" style={{ color: 'var(--text-mute)' }}>{sub}</span>
      </span>
    </label>
  );
}

function Checkbox({ checked, onChange }: { checked: boolean; onChange: (b: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); onChange(!checked); }}
      className="rounded-sm flex items-center justify-center transition-all shrink-0"
      style={{
        width: 14, height: 14,
        background: checked ? 'var(--accent)' : 'rgba(0,0,0,0.3)',
        border: `1px solid ${checked ? 'var(--accent)' : 'var(--line-strong)'}`,
      }}
      aria-pressed={checked}
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="#06140d" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5L6.5 12L13 4" />
        </svg>
      )}
    </button>
  );
}

function ExportIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15V3" />
      <path d="M7 8l5-5 5 5" />
      <path d="M5 20h14" />
    </svg>
  );
}
