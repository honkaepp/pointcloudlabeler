// Scan inspection — TLS scanner-position QC panel.
//
// One backend pass produces both:
//   • A spherical-panorama RGBA image rendered from a viewpoint
//     (canvas display) — RiSCAN PRO's "Single Projection" view.
//   • A per-bin depth map (closest range per angular bin) — feeds the
//     viewport's per-point Hidden Point Removal (HPR) filter, hiding
//     points the viewpoint can't physically see.
//
// The forester picks a viewpoint by clicking "Pick viewpoint" then
// clicking any point in the 3D viewport (reuses the worldPicker hook
// that powers Virtual Caliper). The panel shows the panorama for that
// viewpoint and (when HPR is toggled on) writes filters.viewpointHpr
// so the 3D view also collapses to the "from-here-only" perspective.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import { saveBytesFile } from '../../io/saveDownload';

interface Desktop {
  octreeScanInspection?: (
    octreeDir: string,
    viewpointX: number, viewpointY: number, viewpointZ: number,
    opts: { azBins?: number; elBins?: number; colorMode?: string },
  ) => Promise<{
    azBins: number; elBins: number; viewpoint: number[];
    depth: number[]; rgba: number[];
    pointCount: number;
    rangeMin: number; rangeMax: number; colorMin: number; colorMax: number;
  }>;
}

type ColorMode = 'range' | 'intensity' | 'classification' | 'tree_id' | 'semantic';

export default function ScanInspectionPanel() {
  const { octree, setWorldPicker, setFilters, filters } = useOctreeShell();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [viewpoint, setViewpoint] = useState<[number, number, number] | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    azBins: number; elBins: number;
    depth: Float32Array; rgba: Uint8ClampedArray;
    pointCount: number;
    rangeMin: number; rangeMax: number;
    colorMin: number; colorMax: number;
  } | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>('range');
  const [resolution, setResolution] = useState<'medium' | 'high'>('medium');
  const [hprActive, setHprActive] = useState(false);
  const [hprTolerance, setHprTolerance] = useState(0.05); // m

  // Save the previous HPR filter so closing the panel restores it.
  const [savedHpr] = useState(filters.viewpointHpr);
  useEffect(() => {
    return () => { setFilters({ viewpointHpr: savedHpr }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Arm the world picker so the user's next click sets the viewpoint.
  const armPicker = useCallback(() => {
    setError(null);
    setPicking(true);
    setWorldPicker(() => (hit: [number, number, number]) => {
      setWorldPicker(null);
      setPicking(false);
      setViewpoint(hit);
    });
  }, [setWorldPicker]);
  const cancelPick = useCallback(() => {
    setWorldPicker(null);
    setPicking(false);
  }, [setWorldPicker]);
  useEffect(() => {
    return () => { setWorldPicker(null); };
  }, [setWorldPicker]);

  // Run the backend pass.
  const compute = useCallback(async () => {
    if (!desktop?.octreeScanInspection || !octree?.dir || !viewpoint) return;
    setBusy(true); setError(null);
    try {
      const dims = resolution === 'high' ? { az: 2048, el: 1024 } : { az: 1024, el: 512 };
      const res = await desktop.octreeScanInspection(
        octree.dir, viewpoint[0], viewpoint[1], viewpoint[2],
        { azBins: dims.az, elBins: dims.el, colorMode },
      );
      setResult({
        azBins: res.azBins, elBins: res.elBins,
        depth: new Float32Array(res.depth),
        rgba: new Uint8ClampedArray(res.rgba),
        pointCount: res.pointCount,
        rangeMin: res.rangeMin, rangeMax: res.rangeMax,
        colorMin: res.colorMin, colorMax: res.colorMax,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [desktop, octree?.dir, viewpoint, resolution, colorMode]);

  // Auto-recompute when viewpoint / color mode / resolution changes.
  useEffect(() => {
    if (viewpoint) void compute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewpoint, colorMode, resolution]);

  // Draw the panorama to canvas whenever the result changes.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !result) return;
    c.width = result.azBins;
    c.height = result.elBins;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    // Image origin = top-left; our depth/rgba arrays put elevation
    // index 0 at NADIR (-π/2). Flip vertically when blitting so the
    // SKY ends up at the top — matches every panorama convention.
    const tmp = ctx.createImageData(result.azBins, result.elBins);
    for (let er = 0; er < result.elBins; er++) {
      const sourceRow = result.elBins - 1 - er;
      const sBase = sourceRow * result.azBins * 4;
      const dBase = er * result.azBins * 4;
      tmp.data.set(result.rgba.subarray(sBase, sBase + result.azBins * 4), dBase);
    }
    ctx.putImageData(tmp, 0, 0);
  }, [result]);

  // Toggle HPR — writes filters.viewpointHpr or clears it.
  useEffect(() => {
    if (!hprActive || !result || !viewpoint) {
      // Clear ours if we wrote it.
      if (filters.viewpointHpr) setFilters({ viewpointHpr: null });
      return;
    }
    setFilters({
      viewpointHpr: {
        viewpoint,
        azBins: result.azBins,
        elBins: result.elBins,
        depth: result.depth,
        tolerance: hprTolerance,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hprActive, result, viewpoint, hprTolerance, setFilters]);

  // Save exactly what's already drawn to the canvas — no recompute, so the
  // file always matches what the forester is looking at when they click.
  const savePng = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !result) return;
    c.toBlob((blob) => {
      if (!blob) return;
      void blob.arrayBuffer().then((buf) => saveBytesFile(
        new Uint8Array(buf), `panorama-${colorMode}-${c.width}x${c.height}.png`, 'image/png'));
    }, 'image/png');
  }, [result, colorMode]);

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 480 }}>
      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)' }}>{error}</div>
      )}

      {/* Viewpoint picker */}
      <div className="flex items-center gap-1.5">
        <button
          className="btn !h-8 mono text-[11.5px] flex-1 justify-center"
          onClick={picking ? cancelPick : armPicker}
          disabled={!octree?.dir || busy}
          style={{
            background: picking ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : undefined,
            color: picking ? 'var(--accent)' : undefined,
            borderColor: picking ? 'var(--accent)' : undefined,
          }}
        >
          {picking ? 'Click anywhere in the cloud · (click here to cancel)' : 'Pick viewpoint'}
        </button>
      </div>
      {viewpoint && (
        <div className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
          Viewpoint: ({viewpoint[0].toFixed(2)}, {viewpoint[1].toFixed(2)}, {viewpoint[2].toFixed(2)})
        </div>
      )}

      {viewpoint && (
        <>
          {/* Mode + resolution chips */}
          <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
            <div className="flex items-center gap-1 flex-wrap">
              <span className="mono text-[10px]" style={{ color: 'var(--text-dim)', minWidth: 64 }}>Colour</span>
              <ChipBtn label="Range"        active={colorMode === 'range'}          onClick={() => setColorMode('range')} />
              <ChipBtn label="Intensity"    active={colorMode === 'intensity'}      onClick={() => setColorMode('intensity')} />
              <ChipBtn label="Class"        active={colorMode === 'classification'} onClick={() => setColorMode('classification')} />
              <ChipBtn label="Tree id"      active={colorMode === 'tree_id'}        onClick={() => setColorMode('tree_id')} />
              <ChipBtn label="Semantic"     active={colorMode === 'semantic'}       onClick={() => setColorMode('semantic')} />
            </div>
            <div className="flex items-center gap-1">
              <span className="mono text-[10px]" style={{ color: 'var(--text-dim)', minWidth: 64 }}>Res</span>
              <ChipBtn label="1024 × 512"   active={resolution === 'medium'} onClick={() => setResolution('medium')} />
              <ChipBtn label="2048 × 1024"  active={resolution === 'high'}   onClick={() => setResolution('high')} />
              {busy && <span className="mono text-[9.5px]" style={{ color: 'var(--accent)' }}>computing…</span>}
              <button className="btn !h-5 !px-1.5 mono text-[10px] ml-auto" onClick={savePng} disabled={!result} title="Save the panorama exactly as shown, as PNG">Save PNG</button>
            </div>
          </div>

          {/* Panorama canvas */}
          <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)', background: '#0a0c10' }}>
            <canvas
              ref={canvasRef}
              style={{ display: 'block', width: '100%', maxHeight: 280, objectFit: 'contain' }}
            />
          </div>

          {/* Stats */}
          {result && (
            <div className="mono text-[10px] flex items-center flex-wrap gap-x-3 gap-y-1" style={{ color: 'var(--text-dim)' }}>
              <span>{result.pointCount.toLocaleString()} pts contributed</span>
              <span style={{ color: 'var(--text-mute)' }}>·</span>
              <span>range {result.rangeMin.toFixed(2)} – {result.rangeMax.toFixed(2)} m</span>
              {colorMode !== 'range' && (
                <>
                  <span style={{ color: 'var(--text-mute)' }}>·</span>
                  <span>{colorMode} {result.colorMin.toFixed(2)} – {result.colorMax.toFixed(2)}</span>
                </>
              )}
            </div>
          )}

          {/* HPR toggle */}
          <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
            <div className="flex items-center gap-1.5">
              <button
                className="btn !h-7 mono text-[11px] flex-1 justify-center"
                onClick={() => setHprActive(a => !a)}
                disabled={!result}
                style={{
                  background: hprActive ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : undefined,
                  color: hprActive ? 'var(--accent)' : undefined,
                  borderColor: hprActive ? 'var(--accent)' : undefined,
                }}
              >
                {hprActive ? 'HPR on — viewport shows only visible-from-viewpoint' : 'Enable Hidden Point Removal'}
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="mono text-[10px] w-[110px]" style={{ color: 'var(--text-dim)' }}>Tolerance</label>
              <input type="range" min={0.01} max={0.50} step={0.01}
                value={hprTolerance}
                onChange={(e) => setHprTolerance(parseFloat(e.target.value))}
                disabled={!hprActive}
                className="flex-1" />
              <span className="mono text-[10px] w-[52px] text-right" style={{ color: 'var(--text)' }}>{(hprTolerance * 100).toFixed(0)} cm</span>
            </div>
            <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
              Z-buffer occlusion: per-point range vs. closest range per angular bin. Tolerance keeps several points-per-bin visible (anti-aliasing), tighten for stricter occlusion.
            </div>
          </div>
        </>
      )}

      {!viewpoint && (
        <div className="mono text-[10.5px] px-1.5 py-2" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
          Click "Pick viewpoint" then click anywhere in the 3D viewport — usually a scanner position, but any point works. The panel renders a spherical-panorama image from that viewpoint, and optionally hides points the viewpoint can't physically see (Hidden Point Removal). Use it as TLS scan QC ("what did this scan actually capture?") or as a 3D-to-2D reference view.
        </div>
      )}
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
