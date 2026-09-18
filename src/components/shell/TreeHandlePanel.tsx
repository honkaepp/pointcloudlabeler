// Click-to-measure-tree — one-click forester workflow.
//
// The forester clicks "Pick a stem", then clicks any point on a stem in
// the viewport. The backend's `octree_click_to_measure_tree` streams the
// cloud once, collects every point inside a 1.5 m horizontal cylinder
// around the click, then runs DBH (Kåsa fit at ground + 1.30 m), total
// height, base elevation, crown radius + base, lean angle + bearing,
// and a centreline walk — returning one "tree handle" report per click.
//
// On a successful click the panel ALSO writes the centreline polyline
// into the shared shell state so the viewport draws it as a 3D line
// overlay — the forester can immediately see the trunk axis the
// measurements were taken along.

import { useCallback, useEffect, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import { csvNum, csvBlob } from '../../io/csv';
import { saveCsvFile } from '../../io/saveDownload';

interface CenterlineSample {
  hag: number; centerX: number; centerY: number; z: number;
  radius: number; rmse: number; coverage: number;
}
interface TreeHandle {
  baseZ: number; height: number;
  dbh: number; dbhCoverage: number; dbhRmse: number;
  stemX: number; stemY: number;
  crownRadius: number; crownBase: number;
  leanDeg: number; leanBearingDeg: number;
  pointCount: number;
  centerline: CenterlineSample[];
}
interface Desktop {
  octreeClickToMeasureTree?: (
    octreeDir: string,
    clickX: number, clickY: number, clickZ: number,
    opts?: { cylinderRadius?: number; slabHalfHeight?: number; sliceHeight?: number; dtmCell?: number },
  ) => Promise<TreeHandle>;
}

interface SavedHandle extends TreeHandle {
  id: number;
  clickX: number; clickY: number; clickZ: number;
  label: string;
}

export default function TreeHandlePanel() {
  const { octree, setWorldPicker, analysisLayers, addAnalysisLayer, setAnalysisLayerVisible, removeAnalysisLayer } = useOctreeShell();
  // Every handle's fitted centreline, as ONE layer in the Layers panel:
  // hidden, shown, saved with the dataset or removed there, and kept in
  // step with the handle list here.
  const CLICK_LAYER = 'centerlines-click';
  const clickLayer = analysisLayers.find(l => l.id === CLICK_LAYER);
  // The lean bearing is only a compass heading when +Y is really north,
  // i.e. when the dataset is in a recorded (projected) CRS. See
  // compassLabel for what it says otherwise.
  const georeferenced = !!octree?.meta.crs;
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  // Cylinder radius (m × 100 — slider works in cm for finger-grained
  // control). 1.50 m default covers ~80 cm DBH stems with a decent
  // crown sampling band.
  const [cylRadiusCm, setCylRadiusCm] = useState(150);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handles, setHandles] = useState<SavedHandle[]>([]);

  /** The layer follows the handle list: every handle with a fitted
   *  centreline is a polyline; none left, and the layer goes. */
  const syncLayer = useCallback((list: SavedHandle[]) => {
    const trees = list
      .filter(h => h.centerline.length >= 2)
      .map(h => ({ treeId: h.id, nodes: h.centerline.map(s => ({ x: s.centerX, y: s.centerY, z: s.z, radius: s.radius })) }));
    if (trees.length === 0) { void removeAnalysisLayer(CLICK_LAYER); return; }
    addAnalysisLayer({
      id: CLICK_LAYER, kind: 'centerlines',
      label: `Click-to-measure · ${trees.length} tree${trees.length === 1 ? '' : 's'}`,
      source: 'Click-to-measure-tree · fitted stem centrelines',
      payload: { kind: 'centerlines', overlay: { trees } },
    });
  }, [addAnalysisLayer, removeAnalysisLayer]);

  const measureAt = useCallback(async (x: number, y: number, z: number) => {
    if (!desktop?.octreeClickToMeasureTree || !octree?.dir) return;
    setBusy(true); setError(null);
    try {
      const h = await desktop.octreeClickToMeasureTree(octree.dir, x, y, z, {
        cylinderRadius: cylRadiusCm * 0.01,
      });
      const next: SavedHandle = {
        ...h, id: Date.now(), clickX: x, clickY: y, clickZ: z,
        label: `Tree ${handles.length + 1}`,
      };
      const list = [next, ...handles];
      setHandles(list);
      syncLayer(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [desktop, octree?.dir, cylRadiusCm, handles, syncLayer]);

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

  const removeOne = useCallback((id: number) => {
    const list = handles.filter(h => h.id !== id);
    setHandles(list);
    syncLayer(list);
  }, [handles, syncLayer]);

  /** The polylines off or back on; the handles and their numbers stay. */
  const toggleOverlay = useCallback(() => {
    if (!clickLayer) return;
    void setAnalysisLayerVisible(CLICK_LAYER, !clickLayer.visible);
  }, [clickLayer, setAnalysisLayerVisible]);

  const exportCsv = useCallback(() => {
    if (handles.length === 0) return;
    // The bearing column is only a compass heading when the dataset is
    // in a recorded CRS; otherwise it is an angle in the cloud's local
    // frame. The column name says which, so a CSV read months later
    // cannot be mistaken for a north-referenced one.
    const bearingCol = georeferenced ? 'lean_bearing_deg_from_north' : 'lean_bearing_deg_local_frame';
    const rows = [`idx,label,x,y,base_z,height_m,dbh_cm,dbh_coverage,dbh_rmse_mm,crown_radius_m,crown_base_m,lean_deg,${bearingCol},centerline_nodes`];
    handles.forEach((h, i) => {
      rows.push([
        i + 1,
        h.label,
        csvNum(h.stemX, 3),
        csvNum(h.stemY, 3),
        csvNum(h.baseZ, 3),
        csvNum(h.height, 2),
        csvNum(h.dbh * 100, 1),
        csvNum(h.dbhCoverage, 3),
        csvNum(h.dbhRmse * 1000, 2),
        csvNum(h.crownRadius, 2),
        csvNum(h.crownBase, 2),
        csvNum(h.leanDeg, 2),
        csvNum(h.leanBearingDeg, 1),
        h.centerline.length,
      ].join(','));
    });
    void saveCsvFile(rows, 'tree-handles.csv');
  }, [handles, georeferenced]);

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 360 }}>
      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)' }}>{error}</div>
      )}

      <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[120px]" style={{ color: 'var(--text-dim)' }}>Search radius</label>
          <input type="range" min={50} max={500} step={10}
            value={cylRadiusCm} onChange={(e) => setCylRadiusCm(parseInt(e.target.value, 10))}
            className="flex-1" disabled={busy} />
          <span className="mono text-[10px] w-[44px] text-right" style={{ color: 'var(--text)' }}>{cylRadiusCm} cm</span>
        </div>
        <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
          Cylinder around the click XY for the whole pass. The DBH fit
          uses a narrower 50 cm sub-radius. Widen for very large stems
          or to capture more crown.
        </div>
      </div>

      <button
        className="btn !h-8 mono text-[11.5px] justify-center"
        disabled={!desktop?.octreeClickToMeasureTree || !octree?.dir || busy}
        onClick={picking ? cancelPick : armPicker}
        style={{
          background: picking ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : undefined,
          color: picking ? 'var(--accent)' : undefined,
          borderColor: picking ? 'var(--accent)' : undefined,
        }}
      >
        {busy ? 'Measuring…' : picking ? 'Click a stem · (click here to cancel)' : 'Pick a stem'}
      </button>

      {handles.length > 0 && (
        <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
          <div className="px-2 py-1 mono text-[10px] flex items-center justify-between"
            style={{ color: 'var(--text-dim)', background: 'var(--wash-1)', borderBottom: '1px solid var(--line)' }}>
            <span>Tree handles ({handles.length})</span>
            <div className="flex items-center gap-1">
              <button className="btn !h-5 !px-1.5 mono text-[10px]" onClick={toggleOverlay} disabled={!clickLayer}
                title={clickLayer?.visible ? 'Take the centrelines off the viewport; the handles stay' : 'Show the centrelines again'}>
                {clickLayer?.visible ? 'Hide line' : 'Show line'}</button>
              <button className="btn !h-5 !px-1.5 mono text-[10px]" onClick={exportCsv}>CSV</button>
            </div>
          </div>
          <div className="max-h-[420px] overflow-y-auto scroll-thin">
            {handles.map(h => (
              <HandleRow key={h.id} h={h} onRemove={() => removeOne(h.id)} georeferenced={georeferenced} />
            ))}
          </div>
        </div>
      )}

      {handles.length === 0 && !picking && (
        <div className="mono text-[10.5px] px-1.5 py-2" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
          Click "Pick a stem", then click any point on a rendered stem.
          One streaming pass collects the points around the click and
          reports DBH, height, base elevation, crown radius + base, lean
          angle + bearing, plus a centreline polyline drawn in the
          viewport. Requires the Terrain panel to have been run first
          (needs the DTM).
        </div>
      )}
    </div>
  );
}

function HandleRow({ h, onRemove, georeferenced }: { h: SavedHandle; onRemove: () => void; georeferenced: boolean }) {
  const dbhCm = h.dbh * 100;
  const dbhCovColor =
    h.dbhCoverage >= 0.83 ? '#67d391' :
    h.dbhCoverage >= 0.5  ? '#e6c068' : '#e0817b';
  const leanColor = h.leanDeg >= 10 ? '#e0817b' : h.leanDeg >= 5 ? '#e6c068' : 'var(--text-dim)';
  const bearingLabel = compassLabel(h.leanBearingDeg, georeferenced);
  return (
    <div className="flex flex-col gap-0.5 px-2 py-1.5"
      style={{ borderBottom: '1px solid var(--line)', borderLeft: `3px solid ${dbhCovColor}` }}>
      <div className="flex items-center gap-2 mono text-[11px]">
        <span style={{ color: 'var(--text)', minWidth: 64 }}>{h.label}</span>
        <span style={{ color: 'var(--accent)' }}>Ø {dbhCm > 0 ? `${dbhCm.toFixed(1)} cm` : '—'}</span>
        <span style={{ color: 'var(--text-dim)' }}>·</span>
        <span style={{ color: 'var(--text)' }}>{h.height.toFixed(1)} m</span>
        <span className="flex-1" />
        <button className="btn !h-5 !px-1.5 mono text-[9.5px]" onClick={onRemove} title="Remove">✕</button>
      </div>
      <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
        crown r {h.crownRadius.toFixed(2)} m
        <span style={{ color: 'var(--text-dim)' }}> · </span>
        crown base {h.crownBase.toFixed(1)} m
        <span style={{ color: 'var(--text-dim)' }}> · </span>
        lean <span style={{ color: leanColor }}>{h.leanDeg.toFixed(1)}°</span>
        {h.leanDeg >= 0.1 && (
          <>
            <span style={{ color: 'var(--text-dim)' }}> → </span>
            <span style={{ color: 'var(--text-dim)' }}>{bearingLabel}</span>
          </>
        )}
      </div>
      <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
        base z {h.baseZ.toFixed(2)} m
        <span style={{ color: 'var(--text-dim)' }}> · </span>
        DBH coverage <span style={{ color: dbhCovColor }}>{(h.dbhCoverage * 100).toFixed(0)} %</span>
        <span style={{ color: 'var(--text-dim)' }}> · </span>
        n = {h.pointCount.toLocaleString()}
        <span style={{ color: 'var(--text-dim)' }}> · </span>
        chain {h.centerline.length}
      </div>
    </div>
  );
}

/** Lean direction, as a compass point ONLY when that is meaningful.
 *
 *  The bearing is computed from the cloud's own +Y axis. That is true
 *  north for data in a projected CRS (UTM, TM35FIN, SWEREF …), and
 *  arbitrary for a raw TLS scan that has not been registered — a normal
 *  state mid-workflow. Printing "NE 47°" for an unregistered scan is a
 *  fabricated heading that would send a field crew in a made-up
 *  direction if believed. RescanPanel already gates GPX export on an
 *  explicit CRS for the same reason; this had no such gate.
 *
 *  Without a recorded CRS it is labelled as what it actually is: an
 *  angle in the cloud's local frame. */
function compassLabel(bearingDeg: number, georeferenced: boolean): string {
  const deg = ((bearingDeg % 360) + 360) % 360;
  if (!georeferenced) return `${deg.toFixed(0)}° local`;
  // 16-point compass — bearing 0 = north, 90 = east. ±11.25° per slice.
  const labels = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const idx = Math.round(deg / 22.5) % 16;
  return `${labels[idx]} ${deg.toFixed(0)}°`;
}
