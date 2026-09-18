// Virtual caliper — click a stem at any height, get its diameter.
//
// The forester clicks "Pick stem point", then clicks the rendered
// stem in the viewport. The viewport's world-picker hook captures
// the click's world XYZ; the panel calls the backend's
// `octree_virtual_caliper`, which streams the cloud, collects every
// point inside a horizontal slab at the clicked Z plus a horizontal
// cylinder around the clicked XY, fits a Kåsa circle to the XY
// projection, and returns diameter + RMSE + the same 12-sector
// angular-coverage confidence the QSM uses.
//
// Compared to the auto-DBH (octree_tree_metrics): on-demand, at any
// height the forester wants, no tree segmentation required, with an
// immediate confidence figure on every reading.

import { useCallback, useEffect, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import { csvNum, csvBlob } from '../../io/csv';
import { saveCsvFile } from '../../io/saveDownload';

interface Desktop {
  octreeVirtualCaliper?: (
    octreeDir: string,
    clickX: number, clickY: number, clickZ: number,
    slabHalfHeight?: number, searchRadius?: number,
  ) => Promise<CaliperMeasurement>;
}

interface CaliperMeasurement {
  centerX: number;
  centerY: number;
  z: number;
  radius: number;
  rmse: number;
  coverage: number;
  /** Points the circle fit actually used. */
  pointCount: number;
  /** Points dropped as strays before it — a twig, a leaf or a
   *  neighbouring stem that fell inside the search cylinder. Worth
   *  seeing: a high count next to a plausible diameter means the click
   *  caught more than the stem. */
  rejectedCount: number;
  slabZMin: number;
  slabZMax: number;
}

interface Measurement extends CaliperMeasurement {
  id: number;
  /** Original click point so the user can re-fit at a different
   *  slab / radius without re-clicking. */
  clickX: number;
  clickY: number;
  clickZ: number;
  note?: string;
}

export default function CaliperPanel() {
  const { octree, setWorldPicker } = useOctreeShell();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  const [slabHalfCm, setSlabHalfCm] = useState(5);   // slab half-height (cm)
  const [searchCm, setSearchCm] = useState(50);      // horizontal radius (cm)
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [busy, setBusy] = useState(false);

  // Take a measurement at the given world XYZ — wired both to the
  // viewport's pick callback and to the "redo this reading" button on
  // each row.
  const measureAt = useCallback(async (x: number, y: number, z: number) => {
    if (!desktop?.octreeVirtualCaliper || !octree?.dir) return;
    setBusy(true); setError(null);
    try {
      const m = await desktop.octreeVirtualCaliper(
        octree.dir, x, y, z,
        slabHalfCm * 0.01, searchCm * 0.01,
      );
      setMeasurements(prev => [
        { ...m, id: Date.now(), clickX: x, clickY: y, clickZ: z },
        ...prev,
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [desktop, octree?.dir, slabHalfCm, searchCm]);

  // Arm the picker — the viewport routes the next click here. After
  // one pick the callback clears itself; this matches the "single
  // shot" UX the forester expects.
  const armPicker = useCallback(() => {
    setError(null);
    setPicking(true);
    setWorldPicker(() => (hit: [number, number, number]) => {
      setWorldPicker(null);
      setPicking(false);
      void measureAt(hit[0], hit[1], hit[2]);
    });
  }, [measureAt, setWorldPicker]);

  // Cleanup the picker on unmount or if the user cancels.
  useEffect(() => {
    return () => { setWorldPicker(null); };
  }, [setWorldPicker]);
  const cancelPick = useCallback(() => {
    setWorldPicker(null);
    setPicking(false);
  }, [setWorldPicker]);

  const removeOne = useCallback((id: number) => {
    setMeasurements(prev => prev.filter(m => m.id !== id));
  }, []);
  const reFit = useCallback((m: Measurement) => {
    void measureAt(m.clickX, m.clickY, m.clickZ);
    setMeasurements(prev => prev.filter(x => x.id !== m.id));
  }, [measureAt]);

  // CSV export — column names mirror the auto-DBH CSV (DBH in cm,
  // height in m above the reading's slab — keep it simple).
  const exportCsv = useCallback(() => {
    if (measurements.length === 0) return;
    const rows = ['idx,z_m,diameter_cm,radius_m,rmse_mm,coverage,n_points,n_rejected,center_x,center_y'];
    measurements.forEach((m, i) => {
      rows.push([
        i + 1,
        csvNum(m.z, 3),
        csvNum(m.radius * 200, 2),
        csvNum(m.radius, 4),
        csvNum(m.rmse * 1000, 2),
        csvNum(m.coverage, 3),
        m.pointCount, m.rejectedCount,
        csvNum(m.centerX, 3),
        csvNum(m.centerY, 3),
      ].join(','));
    });
    void saveCsvFile(rows, 'caliper-measurements.csv');
  }, [measurements]);

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 360 }}>
      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)' }}>{error}</div>
      )}

      {/* Tuning sliders */}
      <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[120px]" style={{ color: 'var(--text-dim)' }}>Slab half-height</label>
          <input type="range" min={1} max={50} step={1}
            value={slabHalfCm} onChange={(e) => setSlabHalfCm(parseInt(e.target.value, 10))}
            className="flex-1" disabled={busy} />
          <span className="mono text-[10px] w-[44px] text-right" style={{ color: 'var(--text)' }}>{slabHalfCm} cm</span>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[120px]" style={{ color: 'var(--text-dim)' }}>Search radius</label>
          <input type="range" min={5} max={250} step={5}
            value={searchCm} onChange={(e) => setSearchCm(parseInt(e.target.value, 10))}
            className="flex-1" disabled={busy} />
          <span className="mono text-[10px] w-[44px] text-right" style={{ color: 'var(--text)' }}>{searchCm} cm</span>
        </div>
        <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
          Slab samples a {slabHalfCm * 2} cm thick band at the clicked Z. Radius covers stems up to ~{(searchCm * 2 - 5).toFixed(0)} cm diameter with margin.
        </div>
      </div>

      {/* Pick button */}
      <button
        className="btn !h-8 mono text-[11.5px] justify-center"
        disabled={!desktop?.octreeVirtualCaliper || !octree?.dir || busy}
        onClick={picking ? cancelPick : armPicker}
        style={{
          background: picking ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : undefined,
          color: picking ? 'var(--accent)' : undefined,
          borderColor: picking ? 'var(--accent)' : undefined,
        }}
      >
        {busy ? 'Fitting…' : picking ? 'Click a stem in the viewport · (click here to cancel)' : 'Pick stem point'}
      </button>

      {/* Measurements list */}
      {measurements.length > 0 && (
        <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
          <div className="px-2 py-1 mono text-[10px] flex items-center justify-between"
            style={{ color: 'var(--text-dim)', background: 'var(--wash-1)', borderBottom: '1px solid var(--line)' }}>
            <span>Measurements ({measurements.length})</span>
            <button className="btn !h-5 !px-1.5 mono text-[10px]" onClick={exportCsv}>CSV</button>
          </div>
          <div className="max-h-[320px] overflow-y-auto scroll-thin">
            {measurements.map((m) => (
              <MeasurementRow key={m.id} m={m} onRemove={() => removeOne(m.id)} onReFit={() => reFit(m)} />
            ))}
          </div>
        </div>
      )}

      {measurements.length === 0 && !picking && (
        <div className="mono text-[10.5px] px-1.5 py-2" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
          Click "Pick stem point", then click anywhere on a rendered stem. The caliper collects points in a horizontal slab at the click's Z, fits a Kåsa circle to the XY projection, and reports the diameter with a 12-sector angular-coverage confidence (1.0 = stem seen all around, 0.5 = one side only).
        </div>
      )}
    </div>
  );
}

function MeasurementRow({ m, onRemove, onReFit }: { m: Measurement; onRemove: () => void; onReFit: () => void }) {
  const diaCm = m.radius * 200;
  const rmseMm = m.rmse * 1000;
  const coverageColor =
    m.coverage >= 0.83 ? '#67d391' :
    m.coverage >= 0.5  ? '#e6c068' : '#e0817b';
  return (
    <div className="flex flex-col gap-0.5 px-2 py-1.5"
      style={{ borderBottom: '1px solid var(--line)', borderLeft: `3px solid ${coverageColor}` }}>
      <div className="flex items-center gap-2 mono text-[11px]">
        <span style={{ color: 'var(--text)', minWidth: 64 }}>
          z = {m.z.toFixed(2)} m
        </span>
        <span style={{ color: 'var(--accent)' }}>
          Ø {diaCm.toFixed(1)} cm
        </span>
        <span className="flex-1" />
        <button className="btn !h-5 !px-1.5 mono text-[9.5px]" onClick={onReFit} title="Re-fit with the current slider values">↻</button>
        <button className="btn !h-5 !px-1.5 mono text-[9.5px]" onClick={onRemove} title="Remove">✕</button>
      </div>
      <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
        RMSE {rmseMm.toFixed(1)} mm
        <span style={{ color: 'var(--text-dim)' }}> · </span>
        coverage <span style={{ color: coverageColor }}>{(m.coverage * 100).toFixed(0)} %</span>
        <span style={{ color: 'var(--text-dim)' }}> · </span>
        n = {m.pointCount.toLocaleString()}
      </div>
    </div>
  );
}
