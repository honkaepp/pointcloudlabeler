// Stem taper — click-to-measure diameter profile (3DFin-style), stem
// volume, and a live log-bucking (apteeraus) table.
//
// The forester clicks "Pick a stem", then clicks a point on a stem in the
// viewport. The backend's `stemTaper` command streams the cloud once,
// fits a circle every `sectionHeight` from `stumpHeight` upward inside a
// horizontal cylinder around the click, and returns the diameter profile
// (stump toward crown) plus a truncated-cone stem volume and a DBH
// interpolated from the profile. Read-only — it measures, it never edits
// the cloud.
//
// The bucking table is computed ENTIRELY in this panel from the returned
// sections, so the forester can retune assortment specs (top diameter,
// log length) without a re-run against the point cloud.
//
// On a successful measurement the panel also writes the profile as a 3D
// centreline overlay into the shared shell state, the same way the
// Click-to-measure-tree panel draws its trunk axis.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useOctreeShell,
  DEFAULT_STEM_TAPER_PARAMS,
  type StemTaperParams,
  type StemTaperResult,
  type TaperSection,
} from './OctreeShellContext';
import { csvNum, csvBlob } from '../../io/csv';
import { saveCsvFile } from '../../io/saveDownload';

interface Assortment {
  name: string;
  minTopDiaCm: number;
  logLenM: number;
}

// Priority order, best first — a sawlog is tried before pulpwood at
// every cut.
const ASSORTMENTS: Assortment[] = [
  { name: 'Sawlog',   minTopDiaCm: 16, logLenM: 3.7 },
  { name: 'Pulpwood', minTopDiaCm: 7,  logLenM: 3.0 },
];

export default function StemTaperPanel() {
  const { octree, api, setWorldPicker, analysisLayers, addAnalysisLayer, setAnalysisLayerVisible, removeAnalysisLayer, setTaperMeasurements } = useOctreeShell();
  // The fitted profile is a layer in the Layers panel — hidden, shown,
  // saved with the dataset or removed there as well as here.
  const TAPER_LAYER = 'centerlines-taper';
  const taperLayer = analysisLayers.find(l => l.id === TAPER_LAYER);
  const canRun = !!api && !!octree;

  // Slider params in cm for finger control; converted to metres on run.
  const [sectionCm, setSectionCm] = useState(30);
  const [cylinderRadiusCm, setCylinderRadiusCm] = useState(100);
  const [stumpCm, setStumpCm] = useState(10);

  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StemTaperResult | null>(null);

  const measureAt = useCallback(async (x: number, y: number, z: number) => {
    if (!api || !octree) return;
    setBusy(true); setError(null);
    try {
      const params: StemTaperParams = {
        ...DEFAULT_STEM_TAPER_PARAMS,
        cylinderRadius: cylinderRadiusCm / 100,
        sectionHeight: sectionCm / 100,
        stumpHeight: stumpCm / 100,
      };
      const r = await api.stemTaper(x, y, z, params);
      setResult(r);
      // Draw the fitted profile as a centreline overlay so the forester
      // sees the trunk axis + radii the sections were taken along.
      if (r.sections.length >= 2) {
        addAnalysisLayer({
          id: TAPER_LAYER, kind: 'centerlines',
          label: `Stem taper @ (${x.toFixed(1)}, ${y.toFixed(1)})`,
          source: `Stem taper · sections ${sectionCm} cm · stump ${stumpCm} cm · radius ${cylinderRadiusCm} cm`,
          payload: { kind: 'centerlines', overlay: { trees: [{
            treeId: 1,
            nodes: r.sections.map(s => ({ x: s.centerX, y: s.centerY, z: s.z, radius: s.diameter / 2 })),
          }] } },
        });
      }
      // Hand the measurement to the Report panel as a single-entry list —
      // this panel only tracks one stem at a time; a future multi-stem
      // workflow can grow this into a real list without changing the
      // hand-off shape. Reuses the same bucketize() the table below calls,
      // so the report can never disagree with what the panel shows.
      const bk = bucketize(r.sections);
      setTaperMeasurements([{
        label: `Stem @ (${x.toFixed(1)}, ${y.toFixed(1)})`,
        dbhCm: r.dbh * 100,
        heightM: r.height,
        stemVolumeM3: r.stemVolume,
        sawlogM3: bk.find(b => b.name === 'Sawlog')?.volume ?? 0,
        pulpwoodM3: bk.find(b => b.name === 'Pulpwood')?.volume ?? 0,
      }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, octree, cylinderRadiusCm, sectionCm, stumpCm, addAnalysisLayer, setTaperMeasurements]);

  const armPicker = useCallback(() => {
    setError(null);
    setPicking(true);
    setWorldPicker(() => (hit: [number, number, number]) => {
      setWorldPicker(null);
      setPicking(false);
      void measureAt(hit[0], hit[1], hit[2]);
    });
  }, [measureAt, setWorldPicker]);

  useEffect(() => {
    return () => { setWorldPicker(null); };
  }, [setWorldPicker]);

  const cancelPick = useCallback(() => {
    setWorldPicker(null);
    setPicking(false);
  }, [setWorldPicker]);

  /** The profile off the viewport or back on; the numbers stay. */
  const hideOverlay = useCallback(() => {
    if (!taperLayer) return;
    void setAnalysisLayerVisible(TAPER_LAYER, !taperLayer.visible);
  }, [taperLayer, setAnalysisLayerVisible]);

  /** Everything this panel produced, gone: the result, the overlay it
   *  drew, and the entry it handed the Report panel. A measurement that
   *  cannot be taken back is not a tool, it is a mark. */
  const clearAll = useCallback(() => {
    setResult(null);
    setError(null);
    void removeAnalysisLayer(TAPER_LAYER);
    setTaperMeasurements(null);
  }, [removeAnalysisLayer, setTaperMeasurements]);

  const bucking = useMemo(() => bucketize(result?.sections ?? []), [result]);
  const totalMerchVolume = bucking.reduce((sum, b) => sum + b.volume, 0);
  const wasteVolume = result ? result.stemVolume - totalMerchVolume : 0;

  // --- CSV export ---
  // One row per fitted section; DBH / height / stem volume are
  // repeated as leading columns (rather than a separate header
  // block) so the file stays one flat table any CSV reader can load
  // without custom multi-block parsing.
  const exportCsv = useCallback(() => {
    if (!result || result.sections.length === 0) return;
    const dbhCm = result.dbh > 0 ? csvNum(result.dbh * 100, 2) : '';
    const heightM = csvNum(result.height, 2);
    const stemVolumeM3 = csvNum(result.stemVolume, 4);
    const lines = ['dbh_cm,height_m,stem_volume_m3,hag_m,z_m,diameter_cm,rmse_mm,coverage,n_points'];
    for (const s of result.sections) {
      lines.push([
        dbhCm, heightM, stemVolumeM3,
        csvNum(s.hag, 3),
        csvNum(s.z, 3),
        csvNum(s.diameter * 100, 2),
        csvNum(s.rmse * 1000, 2),
        csvNum(s.coverage, 3),
        s.n,
      ].join(','));
    }
    void saveCsvFile(lines, 'stem-taper.csv');
  }, [result]);

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 380 }}>
      {!canRun && (
        <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Stem taper needs the desktop build and an open dataset.
        </div>
      )}

      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)' }}>{error}</div>
      )}

      <Section title="Section params" sub="search radius · spacing · stump">
        <SliderRow label="Search radius"   unit="cm" value={cylinderRadiusCm} min={40}  max={500} step={10} setValue={setCylinderRadiusCm} disabled={busy} />
        <SliderRow label="Section spacing" unit="cm" value={sectionCm}        min={10}  max={100} step={5}  setValue={setSectionCm}        disabled={busy} />
        <SliderRow label="Stump height"    unit="cm" value={stumpCm}          min={0}   max={100} step={5}  setValue={setStumpCm}          disabled={busy} />
      </Section>

      <button
        className="btn !h-8 mono text-[11.5px] justify-center"
        disabled={!canRun || busy}
        onClick={picking ? cancelPick : armPicker}
        style={{
          background: picking ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : undefined,
          color: picking ? 'var(--accent)' : undefined,
          borderColor: picking ? 'var(--accent)' : undefined,
        }}
      >
        {busy ? 'Measuring…' : picking ? 'Click a stem · (click here to cancel)' : 'Pick a stem'}
      </button>

      {result && (
        <div className="flex items-center gap-1.5">
          <button className="btn !h-6 mono text-[10px] justify-center flex-1" onClick={hideOverlay} disabled={!taperLayer}
            title={taperLayer?.visible ? 'Take the fitted profile off the viewport; the numbers stay' : 'Show the fitted profile again'}>
            {taperLayer?.visible ? 'Hide overlay' : 'Show overlay'}</button>
          <button className="btn !h-6 mono text-[10px] justify-center flex-1" onClick={clearAll} title="Drop the measurement, its overlay and its entry in the Report">Clear</button>
          <button className="btn !h-6 !px-2 mono text-[10px]" onClick={exportCsv} disabled={result.sections.length === 0}>Export CSV</button>
        </div>
      )}

      {result && !busy && (
        <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
            <span>DBH</span><span style={{ color: 'var(--accent)', textAlign: 'right' }}>{result.dbh > 0 ? `${(result.dbh * 100).toFixed(1)} cm` : '—'}</span>
            <span>Height</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{result.height.toFixed(1)} m</span>
            <span>Stem volume</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{result.stemVolume.toFixed(3)} m³ ({(result.stemVolume * 1000).toFixed(0)} L)</span>
            <span>Sections</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{result.sections.length}</span>
            <span>Points</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>n = {result.pointCount.toLocaleString()}</span>
          </div>

          <TaperChart sections={result.sections} height={result.height} />

          <BuckingTable bucking={bucking} totalVolume={totalMerchVolume} wasteVolume={wasteVolume} />
        </div>
      )}

      {!result && !picking && (
        <div className="mono text-[10.5px] px-1.5 py-2" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
          Click "Pick a stem", then click a point on a rendered stem.
          Reports the diameter profile, stem volume, and a log-bucking
          table. Requires the Terrain panel to have been run first
          (needs the DTM).
        </div>
      )}
    </div>
  );
}

// ---------------- taper chart ----------------

function TaperChart({ sections, height }: { sections: TaperSection[]; height: number }) {
  if (sections.length < 2) {
    return (
      <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>Not enough sections.</div>
    );
  }

  const W = 200, H = 220;
  const maxHag = Math.max(height, sections[sections.length - 1].hag, 0.01);
  const maxDia = Math.max(...sections.map(s => s.diameter), 0.001);
  const cx = W / 2;
  // Max diameter maps to ~⅓ of the chart width, centred, leaving margin
  // either side so the silhouette reads as a trunk, not a wall.
  const pxPerMeterDia = (W / 3) / maxDia;

  const yFor = (hag: number) => H - (hag / maxHag) * H;
  const xFor = (diameter: number, sign: 1 | -1) => cx + sign * (diameter / 2) * pxPerMeterDia;

  const leftPts = sections.map(s => `${xFor(s.diameter, -1).toFixed(1)},${yFor(s.hag).toFixed(1)}`);
  const rightPts = sections.map(s => `${xFor(s.diameter, 1).toFixed(1)},${yFor(s.hag).toFixed(1)}`);
  const silhouette = `${leftPts.join(' ')} ${[...rightPts].reverse().join(' ')}`;

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <polygon points={silhouette} fill="color-mix(in oklch, var(--accent) 16%, transparent)" stroke="none" />
      <polyline points={leftPts.join(' ')} fill="none" stroke="var(--accent)" strokeWidth={1} />
      <polyline points={rightPts.join(' ')} fill="none" stroke="var(--accent)" strokeWidth={1} />
      <line x1={cx} y1={0} x2={cx} y2={H} stroke="var(--line)" strokeWidth={0.6} strokeDasharray="2 2" />
      <text x={3} y={10} fill="var(--text-mute)" fontSize={8} fontFamily="monospace">{maxHag.toFixed(1)} m</text>
      <text x={3} y={H - 4} fill="var(--text-mute)" fontSize={8} fontFamily="monospace">Ø {(maxDia * 100).toFixed(0)} cm</text>
    </svg>
  );
}

// ---------------- bucking (apteeraus) table ----------------

interface BuckingResult {
  name: string;
  count: number;
  volume: number;
}

function BuckingTable({ bucking, totalVolume, wasteVolume }: {
  bucking: BuckingResult[]; totalVolume: number; wasteVolume: number;
}) {
  return (
    <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
      <div className="px-2 py-1 mono text-[10px]" style={{ color: 'var(--text-dim)', background: 'var(--wash-1)', borderBottom: '1px solid var(--line)' }}>
        Bucking (apteeraus)
      </div>
      {bucking.map(b => (
        <div key={b.name} className="flex items-center justify-between px-2 py-1 mono text-[10px]"
          style={{ borderBottom: '1px solid var(--line)', color: 'var(--text)' }}>
          <span>{b.name}</span>
          <span style={{ color: 'var(--text-mute)' }}>
            {b.count} log{b.count === 1 ? '' : 's'}
            <span style={{ color: 'var(--text-dim)' }}> · </span>
            <span style={{ color: 'var(--accent)' }}>{b.volume.toFixed(3)} m³</span>
          </span>
        </div>
      ))}
      <div className="flex items-center justify-between px-2 py-1 mono text-[10px]"
        style={{ borderBottom: wasteVolume > 0 ? '1px solid var(--line)' : undefined, color: 'var(--text)' }}>
        <span>Total merchantable</span>
        <span style={{ color: 'var(--accent)' }}>{totalVolume.toFixed(3)} m³</span>
      </div>
      {wasteVolume > 0 && (
        <div className="flex items-center justify-between px-2 py-1 mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
          <span>Top / waste</span>
          <span>{wasteVolume.toFixed(3)} m³</span>
        </div>
      )}
    </div>
  );
}

// Linear-interpolate diameter (m) at a height above ground from the
// sorted section profile; clamps to the first/last section outside the
// measured range. Mirrors the backend's own interpolation so DBH and
// bucking cuts read consistently with the reported result.
function diaAt(sections: TaperSection[], hag: number): number {
  if (sections.length === 0) return 0;
  const first = sections[0];
  const last = sections[sections.length - 1];
  if (hag <= first.hag) return first.diameter;
  if (hag >= last.hag) return last.diameter;
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i];
    const b = sections[i + 1];
    if (hag >= a.hag && hag <= b.hag) {
      const span = b.hag - a.hag;
      const t = span > 0 ? (hag - a.hag) / span : 0;
      return a.diameter + t * (b.diameter - a.diameter);
    }
  }
  return last.diameter;
}

// Truncated-cone (frustum) volume between two diameters over a length.
function frustum(dLo: number, dHi: number, len: number): number {
  const rLo = dLo / 2, rHi = dHi / 2;
  return (Math.PI / 3) * len * (rLo * rLo + rLo * rHi + rHi * rHi);
}

// Greedy buck from the stump upward: at each cut, try the assortments in
// priority order and take the first whose log both fits under the
// measured top and clears its minimum top diameter. Stops the moment
// nothing fits at the current cut — the rest is top / waste.
function bucketize(sections: TaperSection[]): BuckingResult[] {
  const tallies: BuckingResult[] = ASSORTMENTS.map(a => ({ name: a.name, count: 0, volume: 0 }));
  if (sections.length < 2) return tallies;

  let cut = sections[0].hag;
  const top = sections[sections.length - 1].hag;
  outer: while (true) {
    for (let i = 0; i < ASSORTMENTS.length; i++) {
      const a = ASSORTMENTS[i];
      const logTopHag = cut + a.logLenM;
      if (logTopHag <= top && diaAt(sections, logTopHag) * 100 >= a.minTopDiaCm) {
        const vol = frustum(diaAt(sections, cut), diaAt(sections, logTopHag), a.logLenM);
        tallies[i].count += 1;
        tallies[i].volume += vol;
        cut = logTopHag;
        continue outer;
      }
    }
    break;
  }
  return tallies;
}

// ---------------- building blocks ----------------

function Section({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
      <div className="flex items-baseline gap-2">
        <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>{title}</span>
        <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{sub}</span>
      </div>
      {children}
    </div>
  );
}

function SliderRow({
  label, unit, value, min, max, step, setValue, disabled,
}: {
  label: string; unit: string; value: number; min: number; max: number; step: number;
  setValue: (n: number) => void; disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="mono text-[10px] w-[112px]" style={{ color: 'var(--text-dim)' }}>{label}</label>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => setValue(parseInt(e.target.value, 10))} className="flex-1" disabled={disabled} />
      <span className="mono text-[10px] w-[52px] text-right" style={{ color: 'var(--text)' }}>{value} {unit}</span>
    </div>
  );
}
