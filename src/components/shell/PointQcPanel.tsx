// Per-tree point QC — reflectance, outlier and wind filtering.
//
// The UI for the port of `pc_preprocess_aapo_V2.m`: three stages that
// label every point of every segmented tree, with radii and the
// corroboration demand ramping with height inside each tree. The
// backend writes the verdicts to a `point_quality` column (1 kept,
// 2 reflectance, 3 outlier, 4 wind, 0 not evaluated) so they can be
// coloured, filtered and exported like any other attribute.
//
// Defaults are the MATLAB's. The two places where a dataset can make
// them meaningless — a dB band applied to u16 intensity, and a missing
// scan-position id, which the wind stage cannot work without — are
// reported by the backend and shown here rather than left to be
// discovered from a suspiciously clean result.

import { useCallback, useEffect, useState } from 'react';
import { cancelStage, canCancel } from '../../ui/cancelStage';
import { useOctreeShell } from './OctreeShellContext';
import NumberField, { parseCount, parseNum } from '../NumberField';

interface TreeQcRow {
  treeId: number;
  nPoints: number;
  nKept: number;
  nRemovedReflectance: number;
  nRemovedOutlier: number;
  nRemovedWind: number;
  hagMin: number;
  hagMax: number;
  scans: number;
}

interface PointQcSummary {
  trees: TreeQcRow[];
  nPoints: number;
  nEvaluated: number;
  nKept: number;
  nRemovedReflectance: number;
  nRemovedOutlier: number;
  nRemovedWind: number;
  nUnevaluated: number;
  treesSkippedSmall: number;
  keptByBand: number[];
  removedOutlierByBand: number[];
  removedWindByBand: number[];
  reflectanceSource: string;
  reflectanceNote: string | null;
  scanSource: string | null;
  windNote: string | null;
  columnWritten: string | null;
}

/** The MATLAB's defaults, in its own parameter names.
 *
 *  Numbers are held as text so the fields can be typed into — see
 *  NumberField for why that is not a detail. They are parsed once, in
 *  `run`, and an unparseable field falls back to the default below. */
const DEFAULTS = {
  reflMin: '-20',
  reflMax: '5',
  reflColumn: '',
  outlierMethod: 'radius' as 'radius' | 'density',
  outlierKnn: '8',
  outlierStdMult: '3.0',
  outlierMinNeighbors: '3',
  outlierRadiusMin: '0.04',
  outlierRadiusMax: '0.12',
  windRadiusMin: '0.03',
  windRadiusMax: '0.10',
  windMinOtherScansLow: '2',
  windMinOtherScansHigh: '1',
  scanColumn: '',
  hLow: '0.60',
  hHigh: '0.75',
  nStrata: '5',
  minTreePoints: '50',
  dtmCell: '0.5',
  writeColumn: true,
};

/** The numbers as the backend wants them, parsed once. */
function payload(p: typeof DEFAULTS) {
  return {
    reflMin: parseNum(p.reflMin, -20),
    reflMax: parseNum(p.reflMax, 5),
    reflColumn: p.reflColumn,
    outlierMethod: p.outlierMethod,
    outlierKnn: parseCount(p.outlierKnn, 8),
    outlierStdMult: parseNum(p.outlierStdMult, 3.0),
    outlierMinNeighbors: parseCount(p.outlierMinNeighbors, 3),
    outlierRadiusMin: parseNum(p.outlierRadiusMin, 0.04),
    outlierRadiusMax: parseNum(p.outlierRadiusMax, 0.12),
    windRadiusMin: parseNum(p.windRadiusMin, 0.03),
    windRadiusMax: parseNum(p.windRadiusMax, 0.10),
    windMinOtherScansLow: parseNum(p.windMinOtherScansLow, 2),
    windMinOtherScansHigh: parseNum(p.windMinOtherScansHigh, 1),
    scanColumn: p.scanColumn,
    hLow: parseNum(p.hLow, 0.60),
    hHigh: parseNum(p.hHigh, 0.75),
    nStrata: parseCount(p.nStrata, 5),
    minTreePoints: parseCount(p.minTreePoints, 50),
    dtmCell: parseNum(p.dtmCell, 0.5),
    writeColumn: p.writeColumn,
  };
}

export default function PointQcPanel() {
  const { octree, reloadActiveOctree } = useOctreeShell();
  const [p, setP] = useState(DEFAULTS);
  const [treeIdText, setTreeIdText] = useState('');
  const [running, setRunning] = useState(false);
  const [pct, setPct] = useState(0);
  const [summary, setSummary] = useState<PointQcSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The desktop bridge — where every backend command lives. This read
  // the shell's viewer `api` instead, which has no octreePointQc, so
  // `run` returned at its first line and the button did nothing.
  const desktop = (window as unknown as { desktop?: {
    octreePointQc?: (dir: string, params: Record<string, unknown>) => Promise<PointQcSummary>;
    octreeRemoveExtra?: (dir: string, name: string) => Promise<number>;
    onOctreeProgress?: (cb: (e: { stage: string; pct: number }) => void) => Promise<() => void> | (() => void);
  } }).desktop;
  // The column this writes is the one output that outlives the panel —
  // so it can be taken out again, here, rather than living in the
  // dataset for ever because nothing offered to remove it.
  const hasColumn = !!octree?.meta.extras?.some((e) => e.name.toLowerCase() === 'point_quality');
  const [removing, setRemoving] = useState(false);
  const removeColumn = useCallback(async () => {
    if (!octree?.dir || !desktop?.octreeRemoveExtra) return;
    setRemoving(true); setError(null);
    try {
      await desktop.octreeRemoveExtra(octree.dir, 'point_quality');
      setSummary(null);
      await reloadActiveOctree?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(false);
    }
  }, [octree?.dir, desktop, reloadActiveOctree]);

  useEffect(() => {
    if (!desktop?.onOctreeProgress) return;
    let off: (() => void) | undefined;
    void Promise.resolve(desktop.onOctreeProgress((e) => {
      if (e.stage === 'pointqc') setPct(e.pct);
    })).then((f) => { off = f; });
    return () => { off?.(); };
  }, [desktop]);

  const run = useCallback(async () => {
    if (!octree?.dir || !desktop?.octreePointQc) return;
    setRunning(true); setError(null); setPct(0);
    try {
      const treeIds = treeIdText
        .split(/[\s,;]+/)
        .map((t) => parseInt(t, 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      const res = await desktop.octreePointQc(octree.dir, { ...payload(p), treeIds });
      setSummary(res);
      // The column is a new attribute — reload so the viewer and the
      // colour modes can see it.
      if (res.columnWritten) await reloadActiveOctree?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false); setPct(0);
    }
  }, [octree?.dir, desktop, p, treeIdText, reloadActiveOctree]);

  const pctOf = (n: number) =>
    summary && summary.nEvaluated > 0 ? ((n / summary.nEvaluated) * 100).toFixed(1) : '0.0';

  return (
    <div className="flex flex-col gap-2.5 mono text-[11px]" style={{ color: 'var(--text-dim)' }}>
      <div style={{ lineHeight: 1.55, color: 'var(--text-mute)' }}>
        Labels every segmented tree's points in three stages — reflectance band, sparse-neighbourhood
        outliers, and wind points a single scan position saw — with radii that widen with height
        inside each tree. Writes <span style={{ color: 'var(--text-dim)' }}>point_quality</span>:
        1 kept · 2 reflectance · 3 outlier · 4 wind.
      </div>

      <Group label="Reflectance">
        <Row>
          <NumberField label="min" value={p.reflMin} onChange={(v) => setP({ ...p, reflMin: v })} />
          <NumberField label="max" value={p.reflMax} onChange={(v) => setP({ ...p, reflMax: v })} />
        </Row>
        <Field
          label="column (blank = intensity)"
          value={p.reflColumn}
          onChange={(v) => setP({ ...p, reflColumn: v })}
          wide
        />
      </Group>

      <Group label="Outlier">
        <Row>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={p.outlierMethod === 'radius'}
              onChange={() => setP({ ...p, outlierMethod: 'radius' })}
              style={{ accentColor: 'var(--accent)' }}
            />
            radius
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={p.outlierMethod === 'density'}
              onChange={() => setP({ ...p, outlierMethod: 'density' })}
              style={{ accentColor: 'var(--accent)' }}
            />
            density (kNN)
          </label>
        </Row>
        {p.outlierMethod === 'radius' ? (
          <Row>
            <NumberField label="r low (m)" value={p.outlierRadiusMin} onChange={(v) => setP({ ...p, outlierRadiusMin: v })} />
            <NumberField label="r high (m)" value={p.outlierRadiusMax} onChange={(v) => setP({ ...p, outlierRadiusMax: v })} />
            <NumberField label="min neighbours" value={p.outlierMinNeighbors} onChange={(v) => setP({ ...p, outlierMinNeighbors: v })} />
          </Row>
        ) : (
          <Row>
            <NumberField label="k" value={p.outlierKnn} onChange={(v) => setP({ ...p, outlierKnn: v })} />
            <NumberField label="std ×" value={p.outlierStdMult} onChange={(v) => setP({ ...p, outlierStdMult: v })} />
          </Row>
        )}
      </Group>

      <Group label="Wind">
        <Row>
          <NumberField label="r low (m)" value={p.windRadiusMin} onChange={(v) => setP({ ...p, windRadiusMin: v })} />
          <NumberField label="r high (m)" value={p.windRadiusMax} onChange={(v) => setP({ ...p, windRadiusMax: v })} />
        </Row>
        <Row>
          <NumberField label="other scans low" value={p.windMinOtherScansLow} onChange={(v) => setP({ ...p, windMinOtherScansLow: v })} />
          <NumberField label="other scans high" value={p.windMinOtherScansHigh} onChange={(v) => setP({ ...p, windMinOtherScansHigh: v })} />
        </Row>
        <Field
          label="scan-id column (blank = auto-detect)"
          value={p.scanColumn}
          onChange={(v) => setP({ ...p, scanColumn: v })}
          wide
        />
      </Group>

      <Group label="Height ramp + scope">
        <Row>
          <NumberField label="h low" value={p.hLow} onChange={(v) => setP({ ...p, hLow: v })} />
          <NumberField label="h high" value={p.hHigh} onChange={(v) => setP({ ...p, hHigh: v })} />
          <NumberField label="strata" value={p.nStrata} onChange={(v) => setP({ ...p, nStrata: v })} />
        </Row>
        <Row>
          <NumberField label="min points / tree" value={p.minTreePoints} onChange={(v) => setP({ ...p, minTreePoints: v })} />
          <NumberField label="DTM cell (m)" value={p.dtmCell} onChange={(v) => setP({ ...p, dtmCell: v })} />
        </Row>
        <Field
          label="tree ids (blank = all)"
          value={treeIdText}
          onChange={setTreeIdText}
          wide
        />
        <label className="flex items-center gap-1.5 mt-1" title="Off = report only, the dataset is not touched">
          <input
            type="checkbox"
            checked={p.writeColumn}
            onChange={(e) => setP({ ...p, writeColumn: e.target.checked })}
            style={{ accentColor: 'var(--accent)' }}
          />
          write the point_quality column
        </label>
      </Group>

      <div className="flex gap-1.5">
        <button
          className="btn btn-primary !h-8 flex-1 mono text-[11.5px] justify-center"
          onClick={() => void run()}
          disabled={running || !octree?.dir || !desktop?.octreePointQc}
          title={!desktop?.octreePointQc ? 'This build has no point QC command' : !octree?.dir ? 'Open a dataset first' : undefined}
        >
          {running ? `Running… ${Math.round(pct * 100)}%` : 'Run point QC'}
        </button>
        {running && (
          <button className="btn !h-8 mono text-[11px]" onClick={() => cancelStage('pointqc')} disabled={!canCancel()}
            title="Stop the run — the column is written only at the end, so a stopped run changes nothing">Cancel</button>
        )}
        <button
          className="btn !h-8 mono text-[11px]"
          onClick={() => { setP(DEFAULTS); setTreeIdText(''); }}
          disabled={running}
          title="Back to the MATLAB's own defaults"
        >
          Reset
        </button>
      </div>
      {hasColumn && (
        <button
          className="btn !h-7 mono text-[10.5px] justify-center"
          onClick={() => void removeColumn()}
          disabled={running || removing || !desktop?.octreeRemoveExtra}
          title="Take the point_quality column out of the dataset again — a rewrite of the point records; the labels are gone for good"
        >
          {removing ? 'Removing the column…' : 'Remove the point_quality column'}
        </button>
      )}

      {error && (
        <div className="rounded-sm px-2 py-1.5" style={{ color: '#ffb4be', border: '1px solid color-mix(in oklch, var(--danger, #e0506b) 45%, transparent)', lineHeight: 1.5 }}>
          {error}
        </div>
      )}

      {summary && (
        <div className="flex flex-col gap-1.5">
          <div className="rounded-sm px-2 py-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)', lineHeight: 1.6 }}>
            <div style={{ color: 'var(--text)' }}>
              {summary.trees.length} tree{summary.trees.length === 1 ? '' : 's'} · {summary.nEvaluated.toLocaleString()} points evaluated
            </div>
            <Stat label="kept" n={summary.nKept} pct={pctOf(summary.nKept)} />
            <Stat label="reflectance" n={summary.nRemovedReflectance} pct={pctOf(summary.nRemovedReflectance)} />
            <Stat label="outlier" n={summary.nRemovedOutlier} pct={pctOf(summary.nRemovedOutlier)} />
            <Stat label="wind" n={summary.nRemovedWind} pct={pctOf(summary.nRemovedWind)} />
            {summary.nUnevaluated > 0 && (
              <div style={{ color: 'var(--text-mute)' }}>
                {summary.nUnevaluated.toLocaleString()} not evaluated (no tree id, deleted, or a tree under the size floor)
              </div>
            )}
            {summary.treesSkippedSmall > 0 && (
              <div style={{ color: 'var(--text-mute)' }}>{summary.treesSkippedSmall} tree(s) below the size floor</div>
            )}
            <div style={{ color: 'var(--text-mute)' }}>reflectance from {summary.reflectanceSource}</div>
            {summary.scanSource && <div style={{ color: 'var(--text-mute)' }}>scan id from {summary.scanSource}</div>}
          </div>

          {(summary.reflectanceNote || summary.windNote) && (
            <div className="rounded-sm px-2 py-1.5" style={{ color: 'var(--text-dim)', border: '1px solid var(--line)', lineHeight: 1.55 }}>
              {summary.reflectanceNote && <div>{summary.reflectanceNote}</div>}
              {summary.windNote && <div style={{ marginTop: summary.reflectanceNote ? 6 : 0 }}>{summary.windNote}</div>}
            </div>
          )}

          <BandChart
            kept={summary.keptByBand}
            outlier={summary.removedOutlierByBand}
            wind={summary.removedWindByBand}
          />
        </div>
      )}
    </div>
  );
}

/** Where in the tree each stage acted — the MATLAB's per-decile
 *  diagnostic, which is how you see that the ramp is doing its job:
 *  outliers concentrated in the crown deciles mean the crown radius is
 *  still too tight. */
function BandChart({ kept, outlier, wind }: { kept: number[]; outlier: number[]; wind: number[] }) {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    band: 9 - i,
    kept: kept[9 - i] ?? 0,
    outlier: outlier[9 - i] ?? 0,
    wind: wind[9 - i] ?? 0,
  }));
  const max = Math.max(1, ...rows.map((r) => r.kept + r.outlier + r.wind));
  return (
    <div className="rounded-sm px-2 py-1.5" style={{ border: '1px solid var(--line)' }}>
      <div style={{ color: 'var(--text-mute)', marginBottom: 4 }}>By height decile (top first)</div>
      {rows.map((r) => {
        const total = r.kept + r.outlier + r.wind;
        return (
          <div key={r.band} className="flex items-center gap-1.5" style={{ height: 12 }}>
            <span style={{ width: 26, color: 'var(--text-mute)', fontSize: 9 }}>
              {(r.band * 10)}–{(r.band + 1) * 10}%
            </span>
            <div className="flex-1 flex" style={{ height: 7, background: 'rgba(0,0,0,0.25)' }}>
              <div style={{ width: `${(r.kept / max) * 100}%`, background: 'var(--accent)' }} />
              <div style={{ width: `${(r.outlier / max) * 100}%`, background: '#e0a050' }} />
              <div style={{ width: `${(r.wind / max) * 100}%`, background: '#e0506b' }} />
            </div>
            <span style={{ width: 52, textAlign: 'right', color: 'var(--text-mute)', fontSize: 9 }}>
              {total.toLocaleString()}
            </span>
          </div>
        );
      })}
      <div className="flex gap-3 mt-1" style={{ fontSize: 9, color: 'var(--text-mute)' }}>
        <Legend colour="var(--accent)" label="kept" />
        <Legend colour="#e0a050" label="outlier" />
        <Legend colour="#e0506b" label="wind" />
      </div>
    </div>
  );
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span style={{ width: 7, height: 7, background: colour, display: 'inline-block' }} />
      {label}
    </span>
  );
}

function Stat({ label, n, pct }: { label: string; n: number; pct: string }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span style={{ color: 'var(--text)' }}>{n.toLocaleString()} · {pct}%</span>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="chip" style={{ margin: 0, alignSelf: 'flex-start' }}>{label}</span>
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-1.5 items-end">{children}</div>;
}

function Field({ label, value, onChange, wide }: {
  label: string; value: string; onChange: (v: string) => void; wide?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-0.5 ${wide ? 'w-full' : 'flex-1 min-w-0'}`}>
      <span style={{ fontSize: 9, color: 'var(--text-mute)' }}>{label}</span>
      <input
        className="px-1.5 py-1 rounded-sm outline-none mono text-[11px] w-full"
        style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </label>
  );
}
