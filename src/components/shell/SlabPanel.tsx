// Cross-section slab — a movable plane the forester can drag through
// the cloud at any orientation. Horizontal default (DBH-band scrubbing)
// extends to:
//
//   • North-south vertical (normal = +east) — drag east-west, see a
//     stand cross-section showing the canopy layer at this longitude.
//   • East-west vertical (normal = +north) — drag north-south, mirror.
//   • Free direction (normal = compass bearing × tilt) — for stem
//     profiles along an inclined stem, the angle-of-view sweep over a
//     wind-bent crown, or a cut perpendicular to a hillside.
//
// Backed by `filters.planeSlab` so it stacks cleanly with isolate /
// XY clips / hide-unassigned, leaves the user's separate Z-range
// filter untouched, and never depends on a shader recompile.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';

type Orientation = 'horizontal' | 'northSouth' | 'eastWest' | 'custom';

export default function SlabPanel() {
  const { octree, filters, setFilters, api } = useOctreeShell();

  const datasetBbox = octree?.meta.boundingBox;
  const xMin = datasetBbox?.min[0] ?? 0;
  const xMax = datasetBbox?.max[0] ?? 1;
  const yMin = datasetBbox?.min[1] ?? 0;
  const yMax = datasetBbox?.max[1] ?? 1;
  const zMin = datasetBbox?.min[2] ?? 0;
  const zMax = datasetBbox?.max[2] ?? 1;

  const [active, setActive] = useState(false);
  /** Orientation of the slab's normal. Horizontal slabs scrub Z; the
   *  two vertical orientations scrub Y / X; "custom" lets the user
   *  type a compass bearing + tilt. */
  const [orientation, setOrientation] = useState<Orientation>('horizontal');
  /** Position of the slab along its NORMAL (in metres). The meaning
   *  depends on orientation:
   *    horizontal  → Z elevation
   *    northSouth  → X (east) world coord
   *    eastWest    → Y (north) world coord
   *    custom      → distance along the chosen normal from the
   *                  dataset's XY centre at Z = (zMin + zMax) / 2 */
  const [pos, setPos] = useState((zMin + zMax) * 0.5);
  const [halfHeightCm, setHalfHeightCm] = useState(5);
  const [draping, setDraping] = useState<'absolute' | 'aboveGround'>('absolute');
  const [groundOffset, setGroundOffset] = useState<number | null>(null);
  /** Compass bearing of the slab normal (deg, 0 = north, 90 = east).
   *  Only used when orientation === 'custom'. */
  const [customBearing, setCustomBearing] = useState(0);
  /** Tilt of the slab normal above horizontal (deg, 0 = horizontal,
   *  90 = straight up). Only used when orientation === 'custom'. */
  const [customTilt, setCustomTilt] = useState(0);

  // Re-anchor when the dataset changes.
  useEffect(() => {
    setOrientation('horizontal');
    setPos((zMin + zMax) * 0.5);
    setGroundOffset(null);
  }, [octree?.dir, zMin, zMax]);

  // The normal vector in WORLD coords + a sensible centre point. Both
  // are derived from orientation so the slab updates live when the
  // user toggles between presets.
  const { normal, centre } = useMemo<{ normal: [number, number, number]; centre: [number, number, number] }>(() => {
    const cx = (xMin + xMax) * 0.5;
    const cy = (yMin + yMax) * 0.5;
    const cz = (zMin + zMax) * 0.5;
    if (orientation === 'horizontal') {
      return { normal: [0, 0, 1], centre: [cx, cy, 0] };
    }
    if (orientation === 'northSouth') {
      // Slab plane runs north-south; its normal points east (+X).
      return { normal: [1, 0, 0], centre: [0, cy, cz] };
    }
    if (orientation === 'eastWest') {
      // Slab plane runs east-west; its normal points north (+Y).
      return { normal: [0, 1, 0], centre: [cx, 0, cz] };
    }
    // Custom — bearing + tilt define the normal.
    const az = (customBearing * Math.PI) / 180;
    const tl = (customTilt * Math.PI) / 180;
    // Compass bearing 0 = +Y (north), 90 = +X (east). Combined with
    // tilt above horizontal:
    //   nz = sin(tilt),  horizontal magnitude = cos(tilt)
    //   nx = sin(az) · cos(tilt),  ny = cos(az) · cos(tilt)
    const nz = Math.sin(tl);
    const nh = Math.cos(tl);
    const nx = Math.sin(az) * nh;
    const ny = Math.cos(az) * nh;
    return { normal: [nx, ny, nz], centre: [cx, cy, cz] };
  }, [orientation, xMin, xMax, yMin, yMax, zMin, zMax, customBearing, customTilt]);

  // World-coord anchor: the slab centre point translated along the
  // normal by `pos` (interpreted in the orientation-specific axis).
  const anchor = useMemo<[number, number, number]>(() => {
    const offsetGround = draping === 'aboveGround' && groundOffset !== null ? groundOffset : 0;
    if (orientation === 'horizontal') {
      return [centre[0], centre[1], pos + offsetGround];
    }
    if (orientation === 'northSouth') {
      return [pos + offsetGround, centre[1], centre[2]];
    }
    if (orientation === 'eastWest') {
      return [centre[0], pos + offsetGround, centre[2]];
    }
    // Custom: walk `pos` along the normal from the centre.
    return [
      centre[0] + normal[0] * pos,
      centre[1] + normal[1] * pos,
      centre[2] + normal[2] * pos,
    ];
  }, [orientation, centre, pos, normal, draping, groundOffset]);

  // Roundtrip to the Filters state. Only the panel writes planeSlab;
  // closing the panel restores it to whatever it was before.
  const [savedSlab] = useState(filters.planeSlab);
  useEffect(() => {
    if (!active) {
      // Only clear our slab if it's still the one we wrote (so a
      // third-party panel that adopted planeSlab while we were inactive
      // won't be stomped).
      if (filters.planeSlab && Math.abs(filters.planeSlab.halfHeight - halfHeightCm * 0.01) < 1e-9) {
        setFilters({ planeSlab: null });
      }
      return;
    }
    setFilters({
      planeSlab: {
        anchor,
        normal,
        halfHeight: halfHeightCm * 0.01,
      },
    });
  }, [active, anchor, normal, halfHeightCm, filters.planeSlab, setFilters]);

  // Cleanup on unmount — restore whatever planeSlab was there when
  // the panel was first opened.
  useEffect(() => {
    return () => { setFilters({ planeSlab: savedSlab }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sampleGround = useCallback(() => {
    if (!datasetBbox) return;
    setGroundOffset(datasetBbox.min[2]);
    setDraping('aboveGround');
  }, [datasetBbox]);

  const frameSlab = useCallback(() => {
    if (!api || !datasetBbox) return;
    const half = halfHeightCm * 0.01;
    if (orientation === 'horizontal') {
      api.frameBox(
        [datasetBbox.min[0], datasetBbox.min[1], anchor[2] - half],
        [datasetBbox.max[0], datasetBbox.max[1], anchor[2] + half],
      );
    } else if (orientation === 'northSouth') {
      api.frameBox(
        [anchor[0] - half, datasetBbox.min[1], datasetBbox.min[2]],
        [anchor[0] + half, datasetBbox.max[1], datasetBbox.max[2]],
      );
    } else if (orientation === 'eastWest') {
      api.frameBox(
        [datasetBbox.min[0], anchor[1] - half, datasetBbox.min[2]],
        [datasetBbox.max[0], anchor[1] + half, datasetBbox.max[2]],
      );
    } else {
      // Custom: frame the dataset bbox, the user navigates from there.
      api.frameBox(datasetBbox.min, datasetBbox.max);
    }
  }, [api, datasetBbox, halfHeightCm, orientation, anchor]);

  // Forestry presets (always horizontal — DBH-band is the workhorse).
  const presets = useMemo(() => [
    { label: 'DBH band (1.30 m ± 5 cm)', set: () => {
      if (groundOffset === null) sampleGround();
      setOrientation('horizontal');
      setDraping('aboveGround'); setPos(1.30); setHalfHeightCm(5); setActive(true);
    } },
    { label: 'Stump (0 m ± 30 cm)', set: () => {
      if (groundOffset === null) sampleGround();
      setOrientation('horizontal');
      setDraping('aboveGround'); setPos(0); setHalfHeightCm(30); setActive(true);
    } },
    { label: 'Mid-canopy (10 m ± 20 cm)', set: () => {
      if (groundOffset === null) sampleGround();
      setOrientation('horizontal');
      setDraping('aboveGround'); setPos(10); setHalfHeightCm(20); setActive(true);
    } },
    { label: 'N–S vertical (mid-plot)', set: () => {
      setOrientation('northSouth'); setDraping('absolute');
      setPos((xMin + xMax) * 0.5); setHalfHeightCm(15); setActive(true);
    } },
    { label: 'E–W vertical (mid-plot)', set: () => {
      setOrientation('eastWest'); setDraping('absolute');
      setPos((yMin + yMax) * 0.5); setHalfHeightCm(15); setActive(true);
    } },
  ], [groundOffset, sampleGround, xMin, xMax, yMin, yMax]);

  // Slider bounds depend on which axis is being scrubbed.
  const sliderBounds = useMemo<{ min: number; max: number; unit: string; label: string }>(() => {
    if (orientation === 'horizontal') {
      const offsetGround = draping === 'aboveGround' && groundOffset !== null ? groundOffset : 0;
      if (draping === 'aboveGround' && groundOffset !== null) {
        return { min: 0, max: zMax - groundOffset, unit: 'm', label: 'Height above gnd' };
      }
      return { min: zMin - offsetGround, max: zMax - offsetGround, unit: 'm', label: 'Z (world)' };
    }
    if (orientation === 'northSouth') return { min: xMin, max: xMax, unit: 'm', label: 'X (east)' };
    if (orientation === 'eastWest')   return { min: yMin, max: yMax, unit: 'm', label: 'Y (north)' };
    // Custom: ± half of the plot's diagonal.
    const diag = Math.hypot(xMax - xMin, yMax - yMin);
    return { min: -diag * 0.5, max: diag * 0.5, unit: 'm', label: 'Distance' };
  }, [orientation, draping, groundOffset, xMin, xMax, yMin, yMax, zMin, zMax]);

  return (
    // No minimum width: the panel that hosts this is 400 px wide, and a
    // 400 px minimum plus the padding overflowed it — the frame button
    // at the right edge was cut in half and the body no longer sat on
    // the panel's own background.
    <div className="flex flex-col gap-2 px-2.5 py-2.5">
      {/* On/off */}
      <div className="flex items-center gap-1.5">
        <button
          className="btn !h-8 mono text-[11.5px] flex-1 justify-center"
          onClick={() => setActive(a => !a)}
          style={{
            background: active ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : undefined,
            color: active ? 'var(--accent)' : undefined,
            borderColor: active ? 'var(--accent)' : undefined,
          }}
        >
          {active ? 'Slab on — cross-section live' : 'Show cross-section slab'}
        </button>
        <button className="btn !h-8 !px-2 mono text-[11px]"
          onClick={frameSlab} disabled={!active || !api}
          title="Fly the camera so the slab fills the viewport">↗</button>
      </div>

      {/* Orientation */}
      <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <div className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Orientation</div>
        <div className="flex items-center gap-1 flex-wrap">
          <ChipBtn label="Horizontal"  active={orientation === 'horizontal'}  onClick={() => setOrientation('horizontal')} />
          <ChipBtn label="N–S vertical" active={orientation === 'northSouth'} onClick={() => setOrientation('northSouth')} />
          <ChipBtn label="E–W vertical" active={orientation === 'eastWest'}   onClick={() => setOrientation('eastWest')} />
          <ChipBtn label="Custom"       active={orientation === 'custom'}     onClick={() => setOrientation('custom')} />
        </div>
        <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
          {orientation === 'horizontal' && 'Horizontal slab — scrub Z to see canopy layers, DBH bands, stump cuts.'}
          {orientation === 'northSouth' && 'N–S vertical slab — scrub east-west to see canopy structure cross-section.'}
          {orientation === 'eastWest' && 'E–W vertical slab — scrub north-south to see canopy structure cross-section.'}
          {orientation === 'custom' && 'Custom — bearing + tilt define the slab normal. Slab plane is perpendicular to the normal.'}
        </div>
      </div>

      {/* Anchor mode (horizontal only — vertical slabs are always absolute) */}
      {orientation === 'horizontal' && (
        <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Anchor mode</div>
          <div className="flex items-center gap-1">
            <ChipBtn label="Absolute Z"  active={draping === 'absolute'}    onClick={() => setDraping('absolute')} />
            <ChipBtn label="Above ground" active={draping === 'aboveGround'} onClick={() => { if (groundOffset === null) sampleGround(); setDraping('aboveGround'); }} />
          </div>
          <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
            {draping === 'absolute'
              ? `Slab Z is read in absolute world elevation. Dataset Z range: ${zMin.toFixed(2)} – ${zMax.toFixed(2)} m.`
              : groundOffset !== null
                ? `Slab Z is height above ground (anchor ${groundOffset.toFixed(2)} m = dataset min). 1.30 m here = DBH band.`
                : 'Sampling the dataset for a ground anchor…'
            }
          </div>
        </div>
      )}

      {/* Custom-orientation bearing + tilt */}
      {orientation === 'custom' && (
        <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="flex items-center gap-1.5">
            <label className="mono text-[10px] w-[110px]" style={{ color: 'var(--text-dim)' }}>Bearing (° from N)</label>
            <input type="range" min={0} max={360} step={5}
              value={customBearing} onChange={(e) => setCustomBearing(parseFloat(e.target.value))}
              className="flex-1" />
            <span className="mono text-[10px] w-[44px] text-right" style={{ color: 'var(--text)' }}>{customBearing}°</span>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="mono text-[10px] w-[110px]" style={{ color: 'var(--text-dim)' }}>Tilt (° from horiz)</label>
            <input type="range" min={-90} max={90} step={5}
              value={customTilt} onChange={(e) => setCustomTilt(parseFloat(e.target.value))}
              className="flex-1" />
            <span className="mono text-[10px] w-[44px] text-right" style={{ color: 'var(--text)' }}>{customTilt}°</span>
          </div>
          <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
            Normal: ({normal[0].toFixed(2)}, {normal[1].toFixed(2)}, {normal[2].toFixed(2)})
          </div>
        </div>
      )}

      {/* Position + half-height */}
      <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[110px]" style={{ color: 'var(--text-dim)' }}>{sliderBounds.label}</label>
          <input type="range"
            min={sliderBounds.min} max={sliderBounds.max} step={0.05}
            value={pos} onChange={(e) => setPos(parseFloat(e.target.value))}
            className="flex-1" />
          <span className="mono text-[10px] w-[60px] text-right" style={{ color: 'var(--text)' }}>{pos.toFixed(2)} {sliderBounds.unit}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[110px]" style={{ color: 'var(--text-dim)' }}>Half-height</label>
          <input type="range"
            min={1} max={200} step={1}
            value={halfHeightCm} onChange={(e) => setHalfHeightCm(parseInt(e.target.value, 10))}
            className="flex-1" />
          <span className="mono text-[10px] w-[60px] text-right" style={{ color: 'var(--text)' }}>{halfHeightCm} cm</span>
        </div>
        <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
          Slab thickness: {(halfHeightCm * 2).toFixed(0)} cm
        </div>
      </div>

      {/* Presets */}
      <div className="rounded-md p-2 flex flex-col gap-1" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <div className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Presets</div>
        {presets.map(p => (
          <button key={p.label} className="btn !h-6 mono text-[10.5px] justify-start" onClick={p.set}>
            {p.label}
          </button>
        ))}
      </div>

      <div className="mono text-[9.5px] px-1.5 py-1" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        The slab is a plane filter — every point within ± half-height of the plane stays visible, the rest is hidden. Stacks with isolate / XY clips / hide-unassigned. Drag the slider to scrub. Horizontal for DBH bands + canopy layers; vertical for stand cross-sections; custom for stem profiles along inclined trunks.
      </div>
    </div>
  );
}

function ChipBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="mono text-[10px] px-2 py-0.5 rounded-sm whitespace-nowrap"
      style={{
        color: active ? 'var(--accent)' : 'var(--text-dim)',
        background: active ? 'color-mix(in oklch, var(--accent) 14%, transparent)' : 'transparent',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
        cursor: 'pointer',
      }}>
      {label}
    </button>
  );
}
