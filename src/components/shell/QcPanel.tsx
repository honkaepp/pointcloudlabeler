// QC (Quality Control) panel — automatic flagging of suspect trees.
//
// Runs robust statistical anomaly detection over the per-tree metrics
// (median + MAD thresholds, less sensitive to a few bad trees than mean
// + sd) plus a few QSM-derived checks, and surfaces a sorted list of
// "where to look": each row is one flagged tree with the check that
// fired, a reason, a severity colour, and a click that isolates the tree
// in the viewport so the forester can fix it on the spot.
//
// WHAT IS AND IS NOT CACHED. The QSM (`octree_read_qsm`) and the tree
// summary are read from disk and reload whenever the dataset changes.
// The METRICS are not: `octree_tree_metrics` is a full pass over the
// cloud with no sidecar, so it runs only when asked, and its result
// lives in this panel's own state for as long as the panel is mounted.
// That is why the panel opens empty, why the button says "Compute", and
// why the staleness check below exists at all.
//
// The panel is read-only — it doesn't write patches itself. It
// pairs with Tree Review's merge / split / lasso-assign tools: QC
// tells you WHICH trees to fix, Tree Review is HOW you fix them.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import { type TreeMetric, type QsmResult, type TreeQsm, type TreeSummaryEntry } from '../../persistence/octreeReader';
import { useProject } from '../../context/ProjectContext';
import {
  computeQcFlags, SEV_COLOR, SEV_RANK, FLAG_LABEL,
  type Severity, type Flag, type FlagCode,
} from '../../metrics/qcFlags';
import { loadTreeMetrics } from '../../metrics/loadMetrics';
import { useCachedTreeMetrics } from '../../metrics/useCachedTreeMetrics';
import { isolateGeomFor } from './treeNeighbourhood';
import { csvField, csvBlob } from '../../io/csv';
import { DEFAULT_METRIC_PARAMS } from '../../metrics/params';
import { saveCsvFile } from '../../io/saveDownload';

interface Desktop {
  octreeTreeMetrics?: (dir: string, params: { crownCell: number; bhLow: number; bhHigh: number; dtmCell: number }) => Promise<TreeMetric[]>;
  octreeReadQsm?: (dir: string) => Promise<QsmResult | null>;
  // The FULL summary entry, not just the bbox: the fly-to needs the
  // density centre and σ to frame a badly segmented tree on its trunk
  // rather than on the middle of its stray points — and a badly
  // segmented tree is precisely what this panel points at.
  octreeTreeSummary?: (dir: string) => Promise<TreeSummaryEntry[]>;
}

/** How tall the flag list may grow before it scrolls. A viewport
 *  fraction, not a fixed 440 px: the panel is resizable and floats
 *  anywhere, and a fixed cap left half a tall screen empty below a
 *  scrollbar. */
const LIST_MAX_H = '52vh';

export default function QcPanel() {
  const { octree, api, setFilters, setTools } = useOctreeShell();
  const { project } = useProject();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  const [metrics, setMetrics] = useState<TreeMetric[] | null>(null);
  const [qsm, setQsm] = useState<Map<number, TreeQsm> | null>(null);
  const [summary, setSummary] = useState<Map<number, TreeSummaryEntry> | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter chips — let the user focus on one severity at a time.
  const [showCritical, setShowCritical] = useState(true);
  const [showWarning, setShowWarning] = useState(true);
  const [showInfo, setShowInfo] = useState(false);
  // …and on one CHECK at a time. Severity says how bad, not what is
  // wrong, and "show me every tree with no DBH fit" is the question a
  // forester actually works from. Empty = every check.
  const [hiddenCodes, setHiddenCodes] = useState<Set<FlagCode>>(new Set());
  // Severity-first (worst at the top) or tree-first (a tree's flags
  // adjacent). Sorting by severity scatters one tree's three problems
  // across the list, which is the wrong order when you are fixing that
  // tree rather than triaging the plot.
  const [byTree, setByTree] = useState(false);

  // METRICS BELONG TO A DATASET. `refresh` reloads the summary and the
  // QSM when the dataset changes but has never touched `metrics`, so
  // switching clouds left the previous plot's trees on screen — flagged,
  // numbered, and clickable — under the new cloud's name. Nothing said
  // so, and the fly-to would isolate an id that means something else now.
  //
  // Cleared on a dataset change, then SEEDED from the shared cache: if
  // another panel has already measured this cloud, the flags are here
  // the moment the panel opens. The seed never starts a pass of its own
  // — `octree_tree_metrics` is a full sweep and is not something to
  // begin because a window was opened — and it is fingerprint-checked,
  // so what it shows describes the cloud as it is now.
  const [metricsAt, setMetricsAt] = useState<number | null>(null);
  const cachedMetrics = useCachedTreeMetrics(desktop, octree?.dir, DEFAULT_METRIC_PARAMS, metricsAt);
  useEffect(() => { setMetrics(null); setMetricsAt(null); }, [octree?.dir]);
  useEffect(() => {
    if (cachedMetrics) { setMetrics(cachedMetrics.rows); setMetricsAt(cachedMetrics.at); }
  }, [cachedMetrics]);

  // Refresh whenever the active dataset changes. Loads the cached
  // metrics + QSM, doesn't recompute either (we don't want a heavy
  // recompute when the user just opens the QC panel).
  const refresh = useCallback(async () => {
    if (!project?.folder || !octree?.dir) { setMetrics(null); setQsm(null); setSummary(null); return; }
    setLoading(true); setError(null);
    try {
      // Tree summary for "fly to" — same call Tree Review uses, and now
      // kept whole so the framing can use the same density centre.
      if (desktop?.octreeTreeSummary) {
        const list = await desktop.octreeTreeSummary(octree.dir);
        setSummary(new Map(list.map(r => [r.treeId, r])));
      }
      // QSM cache (may be empty — that's fine).
      if (desktop?.octreeReadQsm) {
        const res = await desktop.octreeReadQsm(octree.dir);
        if (res) setQsm(new Map(res.trees.map(t => [t.treeId, t])));
        else setQsm(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [project?.folder, octree?.dir, desktop]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Run the per-tree metrics if not already cached. This is the
  // headline action of the panel — without metrics there's nothing
  // to flag.
  const runMetrics = useCallback(async () => {
    if (!desktop?.octreeTreeMetrics || !octree?.dir) return;
    setRunning(true); setError(null);
    try {
      await api?.save(); // flush any in-flight edits so the tally is current
      // force: the button says "Re-run metrics", and the cache would
      // otherwise hand back the rows it already has whenever nothing on
      // disk had moved — a button that does nothing.
      const res = await loadTreeMetrics(desktop, octree.dir, DEFAULT_METRIC_PARAMS, { force: true });
      setMetrics(res);
      setMetricsAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [desktop, octree?.dir, api]);

  // The flagging engine lives in the shared metrics/qcFlags module so
  // Tree Review's list badges use the exact same logic.
  const bboxes = useMemo(() => {
    if (!summary) return null;
    const m = new Map<number, { min: [number, number, number]; max: [number, number, number] }>();
    for (const r of summary.values()) m.set(r.treeId, { min: r.bboxMin, max: r.bboxMax });
    return m;
  }, [summary]);

  const flags = useMemo<Flag[]>(() => computeQcFlags(metrics, qsm, bboxes), [metrics, qsm, bboxes]);

  const filtered = useMemo(() => {
    const keep = flags.filter(f =>
      !hiddenCodes.has(f.code) && (
        (f.severity === 'critical' && showCritical) ||
        (f.severity === 'warning' && showWarning) ||
        (f.severity === 'info' && showInfo)
      ));
    if (!byTree) return keep;
    // `flags` already arrives severity-desc then id; re-sorting by id
    // first keeps a tree's own flags in severity order beneath it.
    return [...keep].sort((a, b) => a.treeId - b.treeId
      || SEV_RANK[b.severity] - SEV_RANK[a.severity]);
  }, [flags, showCritical, showWarning, showInfo, hiddenCodes, byTree]);

  const counts = useMemo(() => ({
    critical: flags.filter(f => f.severity === 'critical').length,
    warning: flags.filter(f => f.severity === 'warning').length,
    info: flags.filter(f => f.severity === 'info').length,
  }), [flags]);

  /** Per-check tallies, in the order the checks appear in the list, so
   *  the chip row does not reshuffle as the plot changes. */
  const byCode = useMemo(() => {
    const m = new Map<FlagCode, number>();
    for (const f of flags) m.set(f.code, (m.get(f.code) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [flags]);

  // WHETHER THE METRICS STILL DESCRIBE THIS CLOUD. Metrics are computed
  // on demand and held in this panel; a merge, a split or a re-run of
  // segmentation in the meantime renumbers the trees underneath them.
  // The flags then point at ids that have moved or gone, and nothing on
  // screen said so — the list looked exactly as authoritative as a fresh
  // one.
  //
  // Comparing the two id sets catches it, with one honest limit: the
  // summary is only re-read on ↻ or a dataset change, so straight after
  // an edit BOTH are stale together and agree. What this does catch is
  // the case that misleads hardest — a refreshed summary beside metrics
  // from before the edit — and ↻ is the one click that turns the first
  // case into the second.
  const stale = useMemo(() => {
    if (!metrics || !summary) return null;
    const live = new Set([...summary.keys()].filter(id => id > 0));
    let missing = 0;   // in the metrics, gone from the cloud
    let added = 0;     // in the cloud, never measured
    for (const m of metrics) if (m.treeId > 0 && !live.has(m.treeId)) missing++;
    const measured = new Set(metrics.map(m => m.treeId));
    for (const id of live) if (!measured.has(id)) added++;
    return (missing || added) ? { missing, added } : null;
  }, [metrics, summary]);

  // How many DISTINCT trees are flagged. "48 flags" over 12 trees is a
  // very different worklist from 48 flags over 48, and the panel only
  // ever said the first number.
  const flaggedTrees = useMemo(() => new Set(flags.map(f => f.treeId)).size, [flags]);

  // Fly-to: isolate the tree so the forester sees just that tree.
  //
  // Framed on the DENSITY CENTRE, exactly as Tree Review does — the raw
  // bbox is centred between the trunk and whatever strays got attached
  // to it, and a tree with strays attached is the common reason a tree
  // is in this list at all. Isolating on the bbox centre put the camera
  // on empty air beside the tree it was pointing at.
  const flyTo = useCallback((f: Flag) => {
    const entry = summary?.get(f.treeId);
    const g = entry ? isolateGeomFor(entry)
            : f.bbox ? { box: f.bbox, anchor: null }
            : null;
    if (!g) return;
    setFilters({
      isolateTreeId: f.treeId, isolateBox: g.box, isolateAnchor: g.anchor,
      // A neighbour pick belongs to whichever tree Tree Review last
      // isolated; carried into this one it would hide every neighbour.
      isolateOtherIds: null,
    });
    setTools({ activeTreeId: Math.max(0, f.treeId) });
    api?.frameBox(g.box[0], g.box[1]);
  }, [api, setFilters, setTools, summary]);

  // Exports every flag, independent of the severity chips above — the
  // chips are a scanning aid, not a scope decision, so the worklist
  // stays complete even when info-level flags are toggled off screen.
  const exportCsv = useCallback(() => {
    if (flags.length === 0) return;
    // `check` before the prose: the code is what a spreadsheet can
    // group and count on, and the reason is written for a human.
    const lines = ['tree_id,check,severity,reason,hint'];
    for (const f of flags) {
      lines.push([
        csvField(f.treeId), csvField(f.code), csvField(f.severity),
        csvField(f.reason), csvField(f.hint),
      ].join(','));
    }
    void saveCsvFile(lines, 'qc-flags.csv');
  }, [flags]);

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5">
      {/* Refresh + recompute */}
      <div className="flex items-center gap-1.5">
        <button
          className="btn !h-7 !px-2 mono text-[11px] flex-1"
          disabled={!desktop?.octreeTreeMetrics || running}
          onClick={() => void runMetrics()}
          title="Recompute per-tree metrics (height, DBH, basal area, crown). Needed before QC can flag anything."
        >
          {running ? 'Computing metrics…' : metrics ? 'Re-run metrics' : 'Compute metrics'}
        </button>
        <button
          className="btn !h-7 !px-2 mono text-[11px]"
          disabled={loading}
          onClick={() => void refresh()}
          title="Re-read the tree summary and the QSM from disk. Does NOT recompute the metrics — but it is what makes the staleness check above able to notice that they are out of date."
        >
          {loading ? '…' : '↻'}
        </button>
      </div>

      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: 'var(--danger, #e0506b)', background: 'rgba(224,80,107,0.10)', border: '1px solid color-mix(in oklch, var(--danger, #e0506b) 45%, transparent)', lineHeight: 1.5 }}>
          {error}
        </div>
      )}

      {!metrics && !running && (
        <div className="mono text-[10.5px] px-1.5 py-2" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Run "Compute metrics" to scan for anomalies — a full measuring pass over the cloud, so it is not started automatically. It reads per-tree height, DBH, crown size and the cached QSM (if any), then flags the trees that look suspect: missing DBH fits, under- and over-segmented crowns, implausible slenderness, height outliers, sparse trees, and low QSM coverage.
        </div>
      )}

      {metrics && (
        <>
          {/* Summary + severity chips */}
          <div className="flex items-center gap-1 flex-wrap">
            <span className="mono text-[10.5px]" style={{ color: 'var(--text-dim)' }} title={metricsAt ? `Metrics measured ${new Date(metricsAt).toLocaleTimeString()}` : undefined}>
              {flags.length === 0
                ? `${metrics.length} trees, no flags`
                : `${filtered.length}/${flags.length} flag${flags.length === 1 ? '' : 's'} on ${flaggedTrees} of ${metrics.length} trees`}
            </span>
            <span className="flex-1" />
            <SeverityChip label={`${counts.critical} critical`} sev="critical" active={showCritical} onClick={() => setShowCritical(s => !s)} disabled={counts.critical === 0} />
            <SeverityChip label={`${counts.warning} warn`} sev="warning" active={showWarning} onClick={() => setShowWarning(s => !s)} disabled={counts.warning === 0} />
            <SeverityChip label={`${counts.info} info`} sev="info" active={showInfo} onClick={() => setShowInfo(s => !s)} disabled={counts.info === 0} />
          </div>

          {stale && (
            <div
              className="mono text-[9.5px] px-2 py-1.5 rounded-md"
              style={{ color: '#e6c068', background: 'rgba(230,192,104,0.10)', border: '1px solid rgba(230,192,104,0.35)', lineHeight: 1.45 }}
            >
              These metrics no longer match the cloud
              {stale.missing > 0 && <> — {stale.missing} measured tree{stale.missing === 1 ? '' : 's'} no longer exist{stale.missing === 1 ? 's' : ''}</>}
              {stale.missing > 0 && stale.added > 0 && ','}
              {stale.added > 0 && <> {stale.missing > 0 ? 'and' : '—'} {stale.added} tree{stale.added === 1 ? '' : 's'} ha{stale.added === 1 ? 's' : 've'} never been measured</>}
              . A merge, split or re-segmentation renumbers trees; re-run the metrics before trusting the ids below.
            </div>
          )}

          {/* Per-CHECK chips. Severity says how bad; this says what is
              wrong, which is what a fixing session is organised around. */}
          {byCode.length > 1 && (
            <div className="flex items-center gap-1 flex-wrap">
              {byCode.map(([code, n]) => {
                const on = !hiddenCodes.has(code);
                return (
                  <button
                    key={code}
                    onClick={() => setHiddenCodes(prev => {
                      const next = new Set(prev);
                      if (next.has(code)) next.delete(code); else next.add(code);
                      return next;
                    })}
                    className="mono text-[9.5px] px-1.5 py-0.5 rounded-sm"
                    style={{
                      color: on ? 'var(--text-dim)' : 'var(--text-mute)',
                      background: on ? 'var(--wash-2)' : 'transparent',
                      border: `1px solid ${on ? 'var(--line-strong)' : 'var(--line)'}`,
                    }}
                    title={on ? `Hide the "${FLAG_LABEL[code]}" check` : `Show the "${FLAG_LABEL[code]}" check`}
                  >
                    {FLAG_LABEL[code]} <span className="tnum" style={{ color: 'var(--text-mute)' }}>{n}</span>
                  </button>
                );
              })}
              {hiddenCodes.size > 0 && (
                <button
                  className="mono text-[9.5px] px-1"
                  style={{ color: 'var(--accent)' }}
                  onClick={() => setHiddenCodes(new Set())}
                >all checks</button>
              )}
            </div>
          )}

          <div className="flex items-center gap-1">
            <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>sort</span>
            <SortToggle label="severity" active={!byTree} onClick={() => setByTree(false)} title="Worst first — triage the plot" />
            <SortToggle label="tree" active={byTree} onClick={() => setByTree(true)} title="A tree's own flags together — fix one tree at a time" />
            <span className="flex-1" />
            <button className="btn !h-5 !px-1.5 mono text-[10px]" onClick={exportCsv} disabled={flags.length === 0} title="Export ALL flags — every severity and every check, regardless of the chips above">CSV</button>
          </div>

          {/* Flag list */}
          {filtered.length === 0 ? (
            <div className="mono text-[10.5px] px-1.5 py-2" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              {flags.length === 0
                ? 'No anomalies detected. Every tree passed the checks.'
                : `All ${flags.length} flags are hidden by the chips above. Click one to bring its flags back.`}
            </div>
          ) : (
            <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
              <div className="overflow-y-auto scroll-thin" style={{ maxHeight: LIST_MAX_H }}>
                {filtered.map((f, i) => (
                  <FlagRow
                    key={`${f.treeId}-${f.code}-${i}`}
                    flag={f}
                    onFlyTo={() => flyTo(f)}
                    canFly={!!summary?.get(f.treeId) || !!f.bbox}
                    // In tree order, only the first row of a run repeats
                    // the id — a column of "tree 12" four times reads as
                    // four trees.
                    sameTreeAsPrev={byTree && i > 0 && filtered[i - 1].treeId === f.treeId}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SeverityChip({ label, sev, active, onClick, disabled }: {
  label: string; sev: Severity; active: boolean; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="mono text-[9.5px] px-1.5 py-0.5 rounded-sm"
      style={{
        color: active && !disabled ? SEV_COLOR[sev] : 'var(--text-mute)',
        background: active && !disabled ? `color-mix(in oklch, ${SEV_COLOR[sev]} 12%, transparent)` : 'transparent',
        border: `1px solid ${active && !disabled ? SEV_COLOR[sev] : 'var(--line)'}`,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
      title={active ? `Hide ${sev} flags` : `Show ${sev} flags`}
    >
      {label}
    </button>
  );
}

function SortToggle({ label, active, onClick, title }: {
  label: string; active: boolean; onClick: () => void; title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="mono text-[9.5px] px-1.5 py-0.5 rounded-sm"
      style={{
        color: active ? 'var(--text)' : 'var(--text-mute)',
        background: active ? 'var(--wash-2)' : 'transparent',
        border: `1px solid ${active ? 'var(--line-strong)' : 'var(--line)'}`,
      }}
    >{label}</button>
  );
}

function FlagRow({ flag, onFlyTo, canFly, sameTreeAsPrev }: {
  flag: Flag; onFlyTo: () => void; canFly: boolean; sameTreeAsPrev: boolean;
}) {
  return (
    <button
      onClick={onFlyTo}
      // A flag whose tree cannot be located cannot be flown to — the
      // position comes from a separate tree-summary fetch that can lag
      // or be absent. The row used to look and hover exactly like a
      // working one and simply do nothing on click, with only a tooltip
      // to explain. Disabled and dimmed, it reads as inert before it is
      // clicked.
      disabled={!canFly}
      className="w-full text-left px-2.5 py-1.5 flex items-start gap-2 transition-all enabled:hover:bg-white/[0.025] disabled:cursor-default"
      style={{
        borderBottom: '1px solid var(--line)',
        borderLeft: `3px solid ${SEV_COLOR[flag.severity]}`,
        opacity: canFly ? 1 : 0.55,
      }}
      title={canFly ? 'Click to isolate this tree in the viewport' : 'No position available — open Tree Review and step to this id manually'}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          {sameTreeAsPrev ? (
            <span className="mono text-[11px]" style={{ color: 'var(--text-mute)' }}>↳</span>
          ) : (
            <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>tree {flag.treeId}</span>
          )}
          <span
            className="mono text-[9px] px-1 rounded-sm"
            style={{
              color: SEV_COLOR[flag.severity],
              border: `1px solid color-mix(in oklch, ${SEV_COLOR[flag.severity]} 45%, transparent)`,
            }}
          >{FLAG_LABEL[flag.code]}</span>
          <span className="mono text-[9px] uppercase" style={{ color: SEV_COLOR[flag.severity], letterSpacing: '0.04em' }}>{flag.severity}</span>
        </div>
        <div className="mono text-[10px]" style={{ color: 'var(--text-dim)', lineHeight: 1.45 }}>
          {flag.reason}
        </div>
        <div className="mono text-[9.5px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
          → {flag.hint}
        </div>
      </div>
      {canFly && (
        <span className="mono text-[10px] shrink-0 mt-0.5" style={{ color: 'var(--text-mute)' }}>↗</span>
      )}
    </button>
  );
}
