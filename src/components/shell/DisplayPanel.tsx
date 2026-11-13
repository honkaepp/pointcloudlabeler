// Display panel — how the cloud is drawn. Looks first (a whole display for
// one job in one click, looks.ts), then folding sections: colour (mode,
// ramp and its stretch, legend), lighting & shading, points (size),
// heights, performance (the point budget), appearance. Which sections
// are open is kept between sessions; folded, a section says its state in
// its header. Colour modes are shown as a labelled grid of swatched chips
// rather than a native <select> so the active mode reads at a glance and
// matches the viewport's palette.

import { useCallback, useEffect, useState } from 'react';
import { useOctreeShell, type ColorMode, type ColorRamp } from './OctreeShellContext';
import { isDeadwoodExtra } from '../../persistence/octreeReader';
import { HEIGHT_COLOR_FRAMES, HEIGHT_MODES } from './heightMode';
import { THEMES, writeTheme } from '../../ui/theme';
import { useTheme } from '../../ui/useTheme';
import RangeEditor, { isStretchable, useRampStretch } from './RangeEditor';
import TreeMetricPicker from './TreeMetricPicker';
import { treeMetricDef, type TreeMetricKey } from '../../three/treeMetricColors';
import {
  BUILT_IN_LOOKS, applyLook, deleteUserLook, isLookActive, loadUserLooks, lookAvailable, lookFromDisplay, saveUserLook, type Look,
} from './looks';

const SECTIONS_KEY = 'pointcloudlabeler-display-sections';
/** Open at first: the looks, the colour, the lighting and the points. */
const SECTIONS_OPEN: Record<string, boolean> = {
  looks: true, colour: true, lighting: true, points: true, heights: false, performance: false, appearance: false,
};

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
  // Each tree by a measurement of it (TreeMetricPicker)
  { id: 'tree_metric', label: 'Tree metrics', sw: 'linear-gradient(90deg,#3b528b,#21918c,#e0b84a,#e0506b)' },
  { id: 'semantic', label: 'Semantic', sw: 'linear-gradient(90deg,#af6e3c,#e1a55f,#46b45a)' },
  { id: 'return_number', label: 'Return number', sw: 'linear-gradient(90deg,#3b528b,#5ec962,#fde725)' },
  { id: 'number_of_returns', label: 'Returns per pulse', sw: 'linear-gradient(90deg,#3b528b,#5ec962,#fde725)' },
  { id: 'standing_deadwood', label: 'Standing dead', sw: 'linear-gradient(90deg,#e08a3c,#d6453a)' },
  { id: 'laying_deadwood', label: 'Laying dead', sw: 'linear-gradient(90deg,#3aa6d6,#3a63d6)' },
  { id: 'flat', label: 'Flat', sw: '#b4b4b4' },
];

/** Modes whose colours come from a continuous ramp (so the Ramp picker
 *  is meaningful). The categorical / flat modes ignore the ramp. The
 *  `extra:<name>` modes are always ramp-driven; a tree metric when it is a
 *  measurement. */
function isRampMode(m: ColorMode, treeMetric?: TreeMetricKey): boolean {
  if (m === 'tree_metric') return treeMetricDef(treeMetric).kind === 'ramp';
  if (m === 'height' || m === 'intensity' || m === 'x' || m === 'y' || m === 'return_number' || m === 'number_of_returns') return true;
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
  // Which sections are open, kept between sessions
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    try { return { ...SECTIONS_OPEN, ...(JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '{}') as Record<string, boolean>) }; } catch { return { ...SECTIONS_OPEN }; }
  });
  const sectionOpen = (id: string) => openSections[id] !== false;
  const toggleSection = (id: string) => setOpenSections((o) => {
    const next = { ...o, [id]: !(o[id] !== false) };
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
    return next;
  });
  const activeLook = [...BUILT_IN_LOOKS, ...loadUserLooks()].find(l => isLookActive(l, display));
  const modeLabel = COLOR_MODES.find(m => m.id === display.colorMode)?.label
    ?? (typeof display.colorMode === 'string' ? display.colorMode.replace(/^extra:/, '') : '');
  const colourSummary = display.colorMode === 'tree_metric' ? `Trees by ${treeMetricDef(display.treeMetric).label}` : isRampMode(display.colorMode) ? `${modeLabel} · ${RAMPS.find(r => r.id === display.ramp)?.label ?? 'custom'}` : modeLabel;
  const lightSummary = [display.edlEnabled ? `EDL ${display.edlStrength.toFixed(1)}` : 'no EDL', (display.shade ?? 0) > 0 ? `shade ${(display.shade ?? 0).toFixed(1)}` : ''].filter(Boolean).join(' · ');
  const pointSummary = `${display.pointSize} px`;
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
    <div className="flex flex-col gap-1" style={{ width: 230 }}>
      {/* A look is the whole display for one job in one click */}
      <Section id="looks" title="Looks" summary={activeLook?.name ?? 'custom'} hint="Whole displays for one job: canopy heights, intensity, tree review, stems, terrain, measuring — and your own"
        open={sectionOpen('looks')} onToggle={() => toggleSection('looks')}>
        <LooksRow hasDeadwood={hasDeadwood} />
      </Section>

      <Section id="colour" title="Colour" summary={colourSummary} hint="What the points are coloured by, the ramp and where it runs, the legend"
        open={sectionOpen('colour')} onToggle={() => toggleSection('colour')}>
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

        {display.colorMode === 'tree_metric' && <TreeMetricPicker />}

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

                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Where the ramp's colours run — a histogram to stretch */}
        {isStretchable(display.colorMode, display.treeMetric) && (
          <div>
            <div className="chip mb-1.5">Range</div>
            <RampStretch />
          </div>
        )}

        {/* Colour ramp — only meaningful for the scalar modes. */}
        {isRampMode(display.colorMode, display.treeMetric) && (
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
        {(display.colorMode === 'tree_id' || display.colorMode === 'tree_metric' || display.colorMode === 'semantic' || display.colorMode === 'standing_deadwood' || display.colorMode === 'laying_deadwood') && (
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
      </Section>

      <Section id="lighting" title="Lighting & shading" summary={lightSummary} hint="Eye-dome lighting for depth, intensity shading for texture"
        open={sectionOpen('lighting')} onToggle={() => toggleSection('lighting')}>
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

        {/* Intensity shading over any colour mode */}
        <div>
          <label className="flex items-center justify-between cursor-pointer" title="The return strength over the colour: weak returns darker, strong ones brighter, so stems, branches and surfaces read in any colour mode — tree ids, classes, heights, RGB">
            <span className="mono text-[11.5px]" style={{ color: 'var(--text)' }}>Shade by intensity</span>
            <Toggle on={(display.shade ?? 0) > 0} onChange={(v) => setDisplay({ shade: v ? 0.6 : 0 })} />
          </label>
          {(display.shade ?? 0) > 0 && (
            <div className="mt-2">
              <div className="flex justify-between mono text-[10px] mb-1" style={{ color: 'var(--text-mute)' }}>
                <span>strength</span><span>{(display.shade ?? 0).toFixed(2)}</span>
              </div>
              <input type="range" min={0.1} max={1} step={0.05} value={display.shade ?? 0.6}
                onChange={(e) => setDisplay({ shade: parseFloat(e.target.value) })} className="w-full" />
              <div className="mono text-[9.5px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
                Reads the intensity range: stretch it under Colour by → Intensity.
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section id="points" title="Points" summary={pointSummary} hint="Point size"
        open={sectionOpen('points')} onToggle={() => toggleSection('points')}>
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
      </Section>

      <Section id="heights" title="Heights" summary={(display.heightMode ?? 'stored') === 'above_ground' ? 'above ground' : 'as stored'} hint="Heights as stored, or above the ground, in every view"
        open={sectionOpen('heights')} onToggle={() => toggleSection('heights')}>
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
      </Section>

      <Section id="performance" title="Performance" summary={`${budgetM} M`} hint="The point budget"
        open={sectionOpen('performance')} onToggle={() => toggleSection('performance')}>
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
      </Section>

      <Section id="appearance" title="Appearance" summary={THEMES.find(t => t.id === theme)?.label ?? theme} hint="Dark or white, the whole application"
        open={sectionOpen('appearance')} onToggle={() => toggleSection('appearance')}>
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
      </Section>
    </div>
  );
}

/** A folding section of the panel; folded, its header still
 *  says what it is set to. */
function Section({ id, title, summary, hint, open, onToggle, children }: {
  id: string; title: string; summary?: string; hint: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div data-section={id} style={{ borderTop: '1px solid var(--line)' }}>
      <button type="button" onClick={onToggle} title={`${hint} — click to ${open ? 'fold' : 'unfold'}`}
        className="w-full flex items-center gap-1.5 mono py-1.5"
        style={{ background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ fontSize: 8, width: 8, color: 'var(--text-mute)' }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontSize: 10, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text)' }}>{title}</span>
        {summary && <span className="ml-auto truncate" style={{ fontSize: 9.5, color: 'var(--text-mute)', maxWidth: 120 }}>{summary}</span>}
      </button>
      {open && <div className="flex flex-col gap-3 pb-3 pt-0.5">{children}</div>}
    </div>
  );
}

/** The looks — built-in for the jobs a plot needs, and the
 *  user's own (the display as it is now, saved by name). */
function LooksRow({ hasDeadwood: dead }: { hasDeadwood: boolean }) {
  const { display, setDisplay, api } = useOctreeShell();
  const [mine, setMine] = useState<Look[]>(() => loadUserLooks());
  const [naming, setNaming] = useState<string | null>(null);
  const looks = [...BUILT_IN_LOOKS.filter(l => lookAvailable(l, { deadwood: dead })), ...mine];
  const save = () => {
    const name = (naming ?? '').trim();
    if (name) setMine(saveUserLook(lookFromDisplay(name, display)));
    setNaming(null);
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {looks.map(l => {
          const active = isLookActive(l, display);
          return (
            <span key={l.id} className="inline-flex items-center rounded-md"
              style={{
                border: `1px solid ${active ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : 'var(--line)'}`,
                background: active ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'transparent',
              }}>
              <button type="button" data-look={l.id} title={l.hint}
                onClick={() => applyLook(l, display, setDisplay, api ? () => api.colorHistogram(64) : undefined)}
                className="mono text-[10.5px] px-1.5 py-1"
                style={{ color: active ? 'var(--accent)' : 'var(--text-dim)', background: 'none', border: 'none', cursor: 'pointer' }}>
                {l.name}
              </button>
              {!l.builtIn && (
                <button type="button" title={`Forget the look ${l.name}`} onClick={() => setMine(deleteUserLook(l.name))}
                  className="mono text-[10px] pr-1.5" style={{ color: 'var(--text-mute)', background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
              )}
            </span>
          );
        })}
      </div>
      {naming === null ? (
        <button type="button" className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          onClick={() => setNaming('')} title="Keep the display as it is now — colour, ramp and its range, shading, lighting, points, heights, projection — as a look of your own, on this machine">
          + Save the display as a look…
        </button>
      ) : (
        <div className="flex items-center gap-1 mt-1.5">
          <input autoFocus value={naming} placeholder="Name of the look" onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setNaming(null); }}
            className="mono text-[10.5px] py-1 px-1.5 rounded-md outline-none flex-1 min-w-0" spellCheck={false}
            style={{ background: 'var(--wash-1)', border: '1px solid var(--line)', color: 'var(--text)' }} />
          <button type="button" className="btn !h-6 mono text-[10px]" disabled={!naming.trim()} onClick={save}>Save</button>
        </div>
      )}
    </div>
  );
}

/** The active ramp's range over a histogram of the loaded points. */
function RampStretch() {
  const r = useRampStretch();
  return (
    <RangeEditor current={r.current} overridden={r.overridden} histogram={r.hist} onRefresh={r.refresh} onChange={r.setRange}
      unit={r.unit} integer={r.integer} />
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
