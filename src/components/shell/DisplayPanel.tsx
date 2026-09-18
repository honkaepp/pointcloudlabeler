// Display panel — colour mode, Eye-Dome Lighting, render budget. Colour
// modes are shown as a labelled grid of swatched chips rather than a
// native <select> so the active mode reads at a glance and matches the
// viewport's palette. Point size is intentionally absent: points render
// at a fixed 1 px, so there's nothing to tune.

import { useCallback, useEffect, useState } from 'react';
import { useOctreeShell, type ColorMode, type ColorRamp } from './OctreeShellContext';
import { isDeadwoodExtra } from '../../persistence/octreeReader';
import { HEIGHT_COLOR_FRAMES, HEIGHT_MODES } from './heightMode';
import { THEMES, writeTheme } from '../../ui/theme';
import { useTheme } from '../../ui/useTheme';

interface Desktop {
  octreeIntensityRange?: (octreeDir: string) => Promise<[number, number]>;
  onOctreeProgress?: (cb: (e: { stage: string; pct: number }) => void) => Promise<() => void> | (() => void);
}

const RAMPS: { id: ColorRamp; label: string; css: string }[] = [
  { id: 'forest',    label: 'Forest',    css: 'linear-gradient(90deg,#284637,#3c825a,#96c85a,#ebe178)' },
  { id: 'viridis',   label: 'Viridis',   css: 'linear-gradient(90deg,#440154,#3b528b,#21918c,#5ec962,#fde725)' },
  { id: 'plasma',    label: 'Plasma',    css: 'linear-gradient(90deg,#0d0887,#55049e,#9c179e,#cd4071,#ed7953,#fdbc47,#f0f921)' },
  { id: 'magma',     label: 'Magma',     css: 'linear-gradient(90deg,#000004,#3c0f70,#a52c80,#f0605c,#fdc78d,#fcfdbf)' },
  { id: 'inferno',   label: 'Inferno',   css: 'linear-gradient(90deg,#000004,#57106e,#bc3754,#ed7930,#fcffa4)' },
  { id: 'cividis',   label: 'Cividis',   css: 'linear-gradient(90deg,#00204c,#283d6d,#585a6d,#887c71,#c0a169,#fdea69)' },
  { id: 'turbo',     label: 'Turbo',     css: 'linear-gradient(90deg,#30123b,#2682e6,#1edcaa,#a0eb32,#fa961e,#b41e0a)' },
  { id: 'ocean',     label: 'Ocean',     css: 'linear-gradient(90deg,#08163c,#164686,#3886a8,#89c4d1,#dce8ef)' },
  { id: 'spectral',  label: 'Spectral',  css: 'linear-gradient(90deg,#9e0142,#f46d43,#fee08b,#abdda4,#3288bd)' },
  { id: 'rdylgn',    label: 'RdYlGn',    css: 'linear-gradient(90deg,#a50026,#f46d43,#fee08b,#66bd63,#006837)' },
  { id: 'grayscale', label: 'Grayscale', css: 'linear-gradient(90deg,#141414,#f5f5f5)' },
];

const COLOR_MODES: { id: ColorMode; label: string; sw: string }[] = [
  { id: 'height', label: 'Height', sw: 'linear-gradient(90deg,#2b3a6b,#3fae7a,#e9d24a)' },
  { id: 'x', label: 'X (east)', sw: 'linear-gradient(90deg,#3b528b,#5ec962,#fde725)' },
  { id: 'y', label: 'Y (north)', sw: 'linear-gradient(90deg,#3b528b,#5ec962,#fde725)' },
  { id: 'intensity', label: 'Intensity', sw: 'linear-gradient(90deg,#222,#fff)' },
  { id: 'classification', label: 'Class', sw: 'linear-gradient(90deg,#8a5a2b,#46b45a,#3b82f6)' },
  { id: 'tree_id', label: 'Tree id', sw: 'conic-gradient(#e0506b,#7ee0a8,#5a9cf0,#e0b84a,#e0506b)' },
  { id: 'semantic', label: 'Semantic', sw: 'linear-gradient(90deg,#af6e3c,#46b45a)' },
  { id: 'standing_deadwood', label: 'Standing dead', sw: 'linear-gradient(90deg,#e08a3c,#d6453a)' },
  { id: 'laying_deadwood', label: 'Laying dead', sw: 'linear-gradient(90deg,#3aa6d6,#3a63d6)' },
  { id: 'flat', label: 'Flat', sw: '#b4b4b4' },
];

/** Modes whose colours come from a continuous ramp (so the Ramp picker
 *  is meaningful). The categorical / flat modes ignore the ramp. The
 *  `extra:<name>` modes are always ramp-driven. */
function isRampMode(m: ColorMode): boolean {
  if (m === 'height' || m === 'intensity' || m === 'x' || m === 'y') return true;
  return typeof m === 'string' && m.startsWith('extra:');
}

export default function DisplayPanel() {
  const { display, setDisplay, octree, reloadActiveOctree } = useOctreeShell();
  const theme = useTheme();
  const budgetM = (display.pointBudget / 1_000_000).toFixed(1);
  // The two reserved deadwood id channels are edited / coloured via the
  // dedicated Deadwood mode (Tools panel), not as generic ramp extras, so
  // keep them out of this list.
  const extras = (octree?.meta.extras ?? []).filter(e => !isDeadwoodExtra(e.name));
  const hasDeadwood = (octree?.meta.extras ?? []).some(e => isDeadwoodExtra(e.name));

  const desktop = (window as unknown as { desktop?: Desktop }).desktop;
  // On-demand backfill for a dataset whose metadata.intensityRange is
  // missing (imported before Step 1 recorded it, or never backfilled).
  // This is an O(points) scan of the whole file, so it only ever runs
  // from the explicit button below — never on dataset open, never just
  // from switching into the Intensity colour mode.
  const [computingRange, setComputingRange] = useState(false);
  const [rangePct, setRangePct] = useState(0);
  const [rangeError, setRangeError] = useState<string | null>(null);

  useEffect(() => {
    if (!computingRange || !desktop?.onOctreeProgress) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    Promise.resolve(desktop.onOctreeProgress((e) => {
      if (e.stage === 'intensity_range') setRangePct(e.pct);
    })).then((u) => { if (cancelled) u?.(); else unlisten = u; });
    return () => { cancelled = true; unlisten?.(); };
  }, [computingRange, desktop]);

  const computeIntensityRange = useCallback(async () => {
    if (!octree || !desktop?.octreeIntensityRange) return;
    setComputingRange(true); setRangePct(0); setRangeError(null);
    try {
      await desktop.octreeIntensityRange(octree.dir);
      // Re-open the active dataset so octree.meta picks up the freshly
      // written intensityRange — same reload other metadata-mutating
      // panels (Ground, Segment) use after a native command edits
      // metadata.json out from under the already-open viewer.
      await reloadActiveOctree?.();
    } catch (e) {
      setRangeError(e instanceof Error ? e.message : String(e));
    } finally {
      setComputingRange(false); setRangePct(0);
    }
  }, [octree, desktop, reloadActiveOctree]);

  return (
    <div className="flex flex-col gap-3" style={{ width: 230 }}>
      <div>
        <div className="chip mb-1.5">Colour by</div>
        <div className="grid grid-cols-2 gap-1.5">
          {COLOR_MODES.filter(m => (m.id !== 'standing_deadwood' && m.id !== 'laying_deadwood') || hasDeadwood).map(m => {
            const active = display.colorMode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => setDisplay({ colorMode: m.id })}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 mono text-[11px] transition-all"
                style={{
                  border: `1px solid ${active ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : 'var(--line)'}`,
                  background: active ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'transparent',
                  color: active ? 'var(--accent)' : 'var(--text-dim)',
                }}
              >
                <span style={{ width: 14, height: 10, borderRadius: 2, background: m.sw, boxShadow: '0 0 0 1px rgba(255,255,255,0.12)' }} />
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Intensity range backfill — only shown while Intensity is active
          AND the dataset has no recorded metadata.intensityRange (legacy
          imports predate Step 1's automatic recording). Without it,
          colorNode falls back to scaling each tile to its own observed
          min/max, which bands the colours at tile boundaries — this note
          + button is the escape hatch, never triggered automatically. */}
      {display.colorMode === 'intensity' && !octree?.meta.intensityRange && (
        <div className="rounded-md px-2 py-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
            No cloud-wide intensity range recorded yet — each tile is being scaled to its own observed min/max, which can band the colours at tile edges.
          </div>
          <button
            className="btn !h-7 w-full justify-center mono text-[11px] mt-1.5"
            disabled={!octree || !desktop?.octreeIntensityRange || computingRange}
            onClick={computeIntensityRange}
            title="Scan the whole cloud once for its true intensity range, so every tile ramps consistently"
          >
            {computingRange ? `Computing… ${Math.round(rangePct * 100)}%` : 'Compute intensity range'}
          </button>
          {computingRange && (
            <div className="w-full rounded-full overflow-hidden mt-1.5" style={{ height: 4, background: 'var(--wash-3)' }}>
              <div style={{ width: `${Math.round(rangePct * 100)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
            </div>
          )}
          {rangeError && (
            <div className="mono text-[9.5px] mt-1" style={{ color: 'var(--danger, #e0506b)', lineHeight: 1.4 }}>
              {rangeError}
            </div>
          )}
        </div>
      )}

      {/* Extras — every numeric extra-byte column the user opted to carry
          into the octree at import time. Surfaced as its own block so the
          built-in modes above stay scannable; the active extra still wins
          the accent border so it's clear which one is driving the
          viewport. The min/max strip beneath each row reads from
          metadata.extras (the converter's observed range). */}
      {extras.length > 0 && (
        <div>
          <div className="chip mb-1.5">Extras</div>
          <div className="flex flex-col gap-1">
            {extras.map(e => {
              const id = `extra:${e.name}` as ColorMode;
              const active = display.colorMode === id;
              const override = display.extraRangeOverrides?.[e.name];
              const hasOverride = !!override && Number.isFinite(override.lo) && Number.isFinite(override.hi) && override.hi > override.lo;
              const shownLo = hasOverride ? override!.lo : e.min;
              const shownHi = hasOverride ? override!.hi : e.max;
              return (
                <div key={e.name} className="flex flex-col">
                  <button
                    onClick={() => setDisplay({ colorMode: id })}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-all"
                    style={{
                      border: `1px solid ${active ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : 'var(--line)'}`,
                      background: active ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'transparent',
                    }}
                    title={`${e.name} · ramp ${formatNum(shownLo)} … ${formatNum(shownHi)}${hasOverride ? ' (custom range)' : ''}`}
                  >
                    <span style={{ width: 14, height: 10, borderRadius: 2, background: 'linear-gradient(90deg,#3b528b,#5ec962,#fde725)', boxShadow: '0 0 0 1px rgba(255,255,255,0.12)' }} />
                    <span className="min-w-0 flex-1 text-left">
                      <span className="mono text-[11px] block truncate" style={{ color: active ? 'var(--accent)' : 'var(--text-dim)' }}>{e.name}{hasOverride && <span className="ml-1" style={{ color: 'var(--accent)' }} title="Custom range applied">·</span>}</span>
                      <span className="mono text-[9px] block" style={{ color: 'var(--text-mute)' }}>{formatNum(shownLo)} … {formatNum(shownHi)}{!hasOverride && ' (observed)'}</span>
                    </span>
                  </button>

                  {/* Editable ramp range — visible while THIS extra is the
                      active colour mode, so the controls only appear where
                      they affect what you see. Squeezes the ramp into the
                      typed [min, max] (outliers above/below clamp to the
                      endpoints), which is what you want when the cloud-wide
                      observed range is dominated by a handful of spikes. */}
                  {active && (
                    <div className="flex items-center gap-1 mt-1 mb-1 pl-1">
                      <RangeNum
                        value={shownLo}
                        onChange={(v) => setDisplay({ extraRangeOverrides: { ...(display.extraRangeOverrides ?? {}), [e.name]: { lo: v, hi: shownHi } } })}
                        title={`Ramp min for ${e.name} (observed ${formatNum(e.min)})`}
                      />
                      <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>…</span>
                      <RangeNum
                        value={shownHi}
                        onChange={(v) => setDisplay({ extraRangeOverrides: { ...(display.extraRangeOverrides ?? {}), [e.name]: { lo: shownLo, hi: v } } })}
                        title={`Ramp max for ${e.name} (observed ${formatNum(e.max)})`}
                      />
                      <button
                        type="button"
                        className="mono text-[9.5px] px-1.5 py-0.5 rounded-sm"
                        style={{
                          color: hasOverride ? 'var(--accent)' : 'var(--text-mute)',
                          border: '1px solid var(--line)',
                          cursor: hasOverride ? 'pointer' : 'default',
                          opacity: hasOverride ? 1 : 0.5,
                        }}
                        disabled={!hasOverride}
                        onClick={() => {
                          const next = { ...(display.extraRangeOverrides ?? {}) };
                          delete next[e.name];
                          setDisplay({ extraRangeOverrides: next });
                        }}
                        title={`Reset to the observed range ${formatNum(e.min)} … ${formatNum(e.max)}`}
                      >
                        reset
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Colour ramp — only meaningful for the scalar modes. */}
      {isRampMode(display.colorMode) && (
        <div>
          <div className="chip mb-1.5">Ramp</div>
          <div className="flex flex-col gap-1 max-h-[280px] overflow-y-auto scroll-thin pr-0.5">
            {RAMPS.map(r => {
              const active = display.ramp === r.id;
              return (
                <button
                  key={r.id}
                  onClick={() => setDisplay({ ramp: r.id })}
                  className="flex items-center gap-2 rounded-md px-2 py-1 mono text-[10.5px] transition-all"
                  style={{
                    border: `1px solid ${active ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : 'var(--line)'}`,
                    background: active ? 'color-mix(in oklch, var(--accent) 10%, transparent)' : 'transparent',
                    color: active ? 'var(--text)' : 'var(--text-dim)',
                  }}
                >
                  <span style={{ flex: 1, height: 12, borderRadius: 2, background: r.css, boxShadow: '0 0 0 1px rgba(255,255,255,0.1)' }} />
                  <span style={{ width: 64, textAlign: 'left' }}>{r.label}</span>
                </button>
              );
            })}
            {/* Custom — a user-defined low → high gradient. Selecting it
                colours by these two pickers; editing a colour while it's
                active repaints live. */}
            {(() => {
              const active = display.ramp === 'custom';
              const [lo, hi] = display.customRamp;
              return (
                <div
                  className="flex items-center gap-2 rounded-md px-2 py-1"
                  style={{
                    border: `1px solid ${active ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : 'var(--line)'}`,
                    background: active ? 'color-mix(in oklch, var(--accent) 10%, transparent)' : 'transparent',
                  }}
                >
                  <button
                    onClick={() => setDisplay({ ramp: 'custom' })}
                    className="shrink-0"
                    style={{ flex: 1, height: 12, borderRadius: 2, background: `linear-gradient(90deg, ${lo}, ${hi})`, boxShadow: '0 0 0 1px rgba(255,255,255,0.1)' }}
                    title="Use a custom two-colour ramp"
                  />
                  <div className="flex items-center gap-1" style={{ width: 64 }}>
                    <ColorDot value={lo} onChange={(v) => setDisplay({ ramp: 'custom', customRamp: [v, hi] })} />
                    <ColorDot value={hi} onChange={(v) => setDisplay({ ramp: 'custom', customRamp: [lo, v] })} />
                    <span className="mono text-[9.5px]" style={{ color: active ? 'var(--text)' : 'var(--text-dim)' }}>Custom</span>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Unlabelled-point colour — meaningful in the categorical edit modes
          (tree_id ≤ 0, semantic = 0, deadwood = (0, 0)). One picker drives
          all three so the unlabelled baseline reads consistently. */}
      {(display.colorMode === 'tree_id' || display.colorMode === 'semantic' || display.colorMode === 'standing_deadwood' || display.colorMode === 'laying_deadwood') && (
        <div>
          <div className="chip mb-1.5">Unlabelled colour</div>
          <label className="flex items-center gap-2 cursor-pointer">
            <span
              className="rounded-sm relative overflow-hidden"
              style={{ width: 22, height: 14, background: display.unlabeledColor, boxShadow: '0 0 0 1px rgba(255,255,255,0.2)' }}
            >
              <input
                type="color"
                value={display.unlabeledColor}
                onChange={(e) => setDisplay({ unlabeledColor: e.target.value })}
                className="absolute inset-0 opacity-0 cursor-pointer"
                style={{ width: '100%', height: '100%' }}
                title="Colour for points with no tree_id / semantic / deadwood label"
              />
            </span>
            <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>{display.unlabeledColor}</span>
            <button
              type="button"
              className="mono text-[9.5px] ml-auto"
              style={{ color: 'var(--text-mute)' }}
              onClick={() => setDisplay({ unlabeledColor: '#787878' })}
              title="Reset to default grey"
            >reset</button>
          </label>
          <div className="mono text-[9.5px] mt-1" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
            Used for points with no label in the active edit mode.
          </div>
        </div>
      )}

      <div>
        <label className="flex items-center justify-between cursor-pointer">
          <span className="mono text-[11.5px]" style={{ color: 'var(--text)' }}>Colour legend</span>
          <Toggle on={display.showLegend} onChange={(v) => setDisplay({ showLegend: v })} />
        </label>
        <div className="mono text-[9.5px] mt-1" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
          Scale readout for the active colour mode, bottom-left of the viewport.
        </div>
      </div>

      {/* APPEARANCE. Dark is the default and what a fresh install gets;
          white is the same white a figure is rendered on, in the whole
          application and in the viewport, for print, a projector or a
          screenshot dropped into a document. */}
      <div>
        <div className="flex justify-between mono text-[10px] mb-1" style={{ color: 'var(--text-mute)' }}>
          <span className="chip" style={{ margin: 0 }}>Appearance</span>
          <span style={{ color: 'var(--text-dim)' }}>whole application</span>
        </div>
        <div className="grid grid-cols-2 gap-1">
          {THEMES.map(t => {
            const active = theme === t.id;
            return (
              <button
                key={t.id}
                onClick={() => writeTheme(t.id)}
                title={t.hint}
                className="rounded-md px-2 py-1 mono text-[10.5px] transition-all"
                style={{
                  border: `1px solid ${active ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : 'var(--line)'}`,
                  background: active ? 'color-mix(in oklch, var(--accent) 10%, transparent)' : 'transparent',
                  color: active ? 'var(--text)' : 'var(--text-dim)',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <div className="mono text-[9.5px] mt-1" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
          White turns the panels and the viewport&rsquo;s background white, the same white the Figures module renders on. Dark is the default &mdash; a point cloud reads best against it.
        </div>
      </div>

      {/* THE ONE SWITCH FOR HEIGHTS. Every view — the editor's viewport,
          its overlays and raster surfaces, the Compare panes — draws
          heights the way this says: as the files store them, or as height
          above the classified ground under each point, so a plot on a
          slope stands on a flat floor and an ALS epoch in elevation reads
          like the normalised TLS plot beside it. A display choice only:
          coordinates, edits and exports stay in the stored frame. */}
      <div>
        <div className="flex justify-between mono text-[10px] mb-1" style={{ color: 'var(--text-mute)' }}>
          <span className="chip" style={{ margin: 0 }}>Heights</span>
          <span style={{ color: 'var(--text-dim)' }}>every view</span>
        </div>
        <div className="grid grid-cols-2 gap-1">
          {HEIGHT_MODES.map(m => {
            const active = (display.heightMode ?? 'stored') === m.id;
            return (
              <button
                key={m.id}
                onClick={() => setDisplay({ heightMode: m.id })}
                title={m.hint}
                className="rounded-md px-2 py-1 mono text-[10.5px] transition-all"
                style={{
                  border: `1px solid ${active ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : 'var(--line)'}`,
                  background: active ? 'color-mix(in oklch, var(--accent) 10%, transparent)' : 'transparent',
                  color: active ? 'var(--text)' : 'var(--text-dim)',
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        <div className="mono text-[9.5px] mt-1" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
          Above ground draws every point at its height over the classified ground under it, in the editor and in Compare alike; the coordinates stay as stored. A cloud with no ground classification is shown as stored, and the viewport says so.
        </div>
        {display.colorMode === 'height' && (
          <div className="mt-2">
            <div className="flex justify-between mono text-[10px] mb-1" style={{ color: 'var(--text-mute)' }}>
              <span>height colour runs over</span>
            </div>
            <div className="grid grid-cols-2 gap-1">
              {HEIGHT_COLOR_FRAMES.map(m => {
                const active = (display.heightColorAboveGround ?? false) === m.above;
                return (
                  <button
                    key={m.label}
                    onClick={() => setDisplay({ heightColorAboveGround: m.above })}
                    title={m.hint}
                    className="rounded-md px-2 py-1 mono text-[10.5px] transition-all"
                    style={{
                      border: `1px solid ${active ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : 'var(--line)'}`,
                      background: active ? 'color-mix(in oklch, var(--accent) 10%, transparent)' : 'transparent',
                      color: active ? 'var(--text)' : 'var(--text-dim)',
                    }}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div>
        <label className="flex items-center justify-between cursor-pointer">
          <span className="mono text-[11.5px]" style={{ color: 'var(--text)' }}>Eye-Dome lighting</span>
          <Toggle on={display.edlEnabled} onChange={(v) => setDisplay({ edlEnabled: v })} />
        </label>
        {display.edlEnabled && (
          <div className="mt-2">
            <div className="flex justify-between mono text-[10px] mb-1" style={{ color: 'var(--text-mute)' }}>
              <span>strength</span><span>{display.edlStrength.toFixed(2)}</span>
            </div>
            <input
              type="range" min={0.1} max={3} step={0.05} value={display.edlStrength}
              onChange={(e) => setDisplay({ edlStrength: parseFloat(e.target.value) })}
              className="w-full"
            />
          </div>
        )}
      </div>

      <div>
        <div className="flex justify-between mono text-[10px] mb-1" style={{ color: 'var(--text-mute)' }}>
          <span className="chip" style={{ margin: 0 }}>Point size</span>
          <span style={{ color: 'var(--text-dim)' }}>
            {display.pointSize <= 1 ? '1 px (default)' : `${display.pointSize} px`}
          </span>
        </div>
        <input
          type="range" min={1} max={8} step={1} value={display.pointSize}
          onChange={(e) => setDisplay({ pointSize: parseInt(e.target.value, 10) })}
          className="w-full"
          title="On-screen size of each point in pixels (1 = the crisp-dot default)"
        />
      </div>

      <div>
        <div className="flex justify-between mono text-[10px] mb-1" style={{ color: 'var(--text-mute)' }}>
          <span className="chip" style={{ margin: 0 }}>Point budget</span><span style={{ color: 'var(--text-dim)' }}>{budgetM} M</span>
        </div>
        <input
          type="range" min={1_000_000} max={100_000_000} step={1_000_000} value={display.pointBudget}
          onChange={(e) => setDisplay({ pointBudget: parseInt(e.target.value, 10) })}
          className="w-full"
          title="Hard render-set cap. Raise it to fill the GPU; lower it to keep memory bounded on a small machine. Sub-millions are unlimited if you've got the VRAM."
        />
        <div className="mono text-[9.5px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
          Cap on the visible point set. Push it up to use as much VRAM as your card has.
        </div>
      </div>
    </div>
  );
}

function ColorDot({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="relative cursor-pointer shrink-0" style={{ width: 13, height: 13 }} title="Pick colour">
      <span className="block rounded-full" style={{ width: 13, height: 13, background: value, boxShadow: '0 0 0 1px rgba(255,255,255,0.25)' }} />
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 opacity-0 cursor-pointer"
        style={{ width: '100%', height: '100%' }}
      />
    </label>
  );
}

/** Tiny number input for the extra-range min/max squeeze. Keeps a local
 *  draft string so typing "-1." mid-edit doesn't snap back; commits on
 *  blur / Enter (or when the parsed value differs and is finite). */
function RangeNum({ value, onChange, title }: { value: number; onChange: (v: number) => void; title?: string }) {
  const [draft, setDraft] = useState<string>(() => Number.isFinite(value) ? String(value) : '');
  // Sync the draft back to the parent value when it changes externally
  // (e.g. reset button), but not while the user is mid-edit.
  useEffect(() => {
    setDraft(prev => {
      const parsed = parseFloat(prev);
      if (Number.isFinite(parsed) && parsed === value) return prev;
      return Number.isFinite(value) ? String(value) : '';
    });
  }, [value]);
  const commit = () => {
    const v = parseFloat(draft);
    if (Number.isFinite(v) && v !== value) onChange(v);
    else setDraft(Number.isFinite(value) ? String(value) : '');
  };
  return (
    <input
      type="number"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
      className="mono text-[10px] py-0.5 px-1.5 rounded-sm text-right outline-none"
      style={{
        width: 64,
        background: 'rgba(0,0,0,0.3)',
        border: '1px solid var(--line)',
        color: 'var(--text)',
      }}
      title={title}
    />
  );
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1000 || a < 0.01 && a !== 0) return n.toExponential(2);
  if (a >= 100) return n.toFixed(1);
  if (a >= 1) return n.toFixed(2);
  return n.toFixed(3);
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="rounded-full transition-all relative"
      style={{
        width: 32, height: 18,
        background: on ? 'var(--accent)' : 'rgba(255,255,255,0.1)',
        border: '1px solid var(--line-strong)',
      }}
    >
      <span
        className="absolute rounded-full transition-all"
        style={{
          width: 12, height: 12, top: 2, left: on ? 16 : 2,
          background: on ? '#06140d' : 'var(--text-dim)',
        }}
      />
    </button>
  );
}
