// Filters panel — non-destructive visibility controls. A point passes
// iff it survives every active filter (logical AND). Hidden points are
// rendered at zero size in the shader, so clearing a filter brings
// them back instantly — no reload, no edit, no patches.bin entry.

import { useState, useEffect } from 'react';
import { useOctreeShell, countActiveFilters, type FilterConfig } from './OctreeShellContext';
import DualRangeSlider from './DualRangeSlider';
import { confirmDialog } from '../../ui/dialogs';

// Sentinel for an open-ended upper bound: an empty "max" means "and up".
// Tree ids never realistically approach this, so it reads as ∞.
const RANGE_MAX = 1_000_000_000;

// Intensity is stored as u16, so — unlike tree ids — it has a real,
// meaningful upper bound instead of an arbitrary sentinel: an empty "max"
// field means "up to the column's own ceiling".
const INTENSITY_MAX = 65535;

// ASPRS classification codes worth toggling in forestry data. Matches
// the labels used by the classification colour ramp. Exported so the
// viewport's colour legend can key its classification swatches off the
// exact same list instead of a second hand-copied one that could drift.
export const CLASS_OPTIONS: { code: number; label: string; swatch: string }[] = [
  { code: 2, label: 'Ground',     swatch: '#785a3c' },
  { code: 3, label: 'Low veg',    swatch: '#50a050' },
  { code: 4, label: 'Med veg',    swatch: '#3cb43c' },
  { code: 5, label: 'High veg',   swatch: '#28c828' },
  { code: 6, label: 'Building',   swatch: '#dc5050' },
  { code: 7, label: 'Noise',      swatch: '#dcdc3c' },
  { code: 9, label: 'Water',      swatch: '#5078dc' },
  { code: 0, label: 'Unassigned', swatch: '#8c8c8c' },
];

// Semantic codes: leaf–wood / QSM labelling. The swatches are the EXACT
// rgb the 'semantic' colour mode paints (see colorNode in OctreeView), so
// a chip reads as "this colour in the viewport" rather than merely
// something similar. Unlabelled has no fixed colour — it follows the
// user-pickable unlabeled colour, so it's filled in at render time.
// Exported for the viewport's colour legend (see the classification
// export above — same reasoning).
export const SEMANTIC_OPTIONS: { code: number; label: string; swatch: string | null }[] = [
  { code: 0, label: 'Unlabelled', swatch: null },
  { code: 1, label: 'Stem',       swatch: 'rgb(175,110,60)' },
  { code: 2, label: 'Branch',     swatch: 'rgb(70,180,90)' },
];

// LAS return numbers 0..7 (0 = unset/unknown — plenty of terrestrial
// TLS/MLS scans never populate it). No colour swatch: unlike class /
// semantic, return number has no palette elsewhere in the app for a
// chip to echo.
const RETURN_OPTIONS: { code: number; label: string }[] = [
  { code: 0, label: 'unset' },
  { code: 1, label: '1' },
  { code: 2, label: '2' },
  { code: 3, label: '3' },
  { code: 4, label: '4' },
  { code: 5, label: '5' },
  { code: 6, label: '6' },
  { code: 7, label: '7' },
];

// Full code domains for the solo / invert helpers below — deliberately
// NOT the handful of codes each group's chip grid renders. Classification
// is a raw ASPRS byte (0..255): the grid above only lists the 8 codes
// worth a swatch, so soloing "Ground" over just those 8 would leave an
// unlisted code (e.g. 12) silently visible — a lie. Semantic and return
// number happen to have a small domain that matches their real range.
const CLASS_DOMAIN_MAX = 255;
const SEMANTIC_DOMAIN_MAX = 2;
const RETURN_DOMAIN_MAX = 7;

/** Alt/Option-click a hide-chip = solo it. Hides every OTHER code across
 *  the group's FULL domain [0, domainMax] (see the constants above), not
 *  just the options the chip grid happens to render. Shared by all three
 *  hide-chip groups instead of repeating the domain loop three times. */
function soloCodes(domainMax: number, code: number): number[] {
  const out: number[] = [];
  for (let c = 0; c <= domainMax; c++) if (c !== code) out.push(c);
  return out;
}

/** True when a group is already soloed on exactly `code` (every other
 *  domain code hidden). Alt-clicking that same chip again should clear
 *  the group back to "show everything" rather than re-solo it. */
function isSoloed(domainMax: number, hidden: number[], code: number): boolean {
  return hidden.length === domainMax && !hidden.includes(code);
}

/** `invert` link: flip the hidden set within the group's full domain, so
 *  codes outside the chip grid get inverted too (same reasoning as
 *  soloCodes above). */
function invertCodes(domainMax: number, hidden: number[]): number[] {
  const set = new Set(hidden);
  const out: number[] = [];
  for (let c = 0; c <= domainMax; c++) if (!set.has(c)) out.push(c);
  return out;
}

/** A saved filter preset: a name plus the subset of FilterConfig worth
 *  reusing across datasets (see presetFilters below for exactly which
 *  fields, and why the rest are excluded). */
interface FilterPreset {
  name: string;
  filters: Partial<FilterConfig>;
}

const PRESETS_KEY = 'pointcloudlabeler-filter-presets';

/** The subset of FilterConfig a preset captures — the general visibility
 *  filters only. Deliberately EXCLUDES isolateTreeId / isolateBox /
 *  isolateAnchor / isolateShowUnassigned / isolateShowOthers /
 *  isolateMargin / isolateZRange / planeSlab / viewpointHpr: the isolate
 *  fields name a SPECIFIC tree id (plus its cached neighbourhood box/
 *  anchor), which may not even exist in whatever dataset the preset is
 *  later applied to — restoring them would isolate the wrong tree, or
 *  silently isolate nothing. planeSlab and viewpointHpr are a different
 *  panel's own transient tool state (Slab, Scan-inspection), not
 *  something the user thinks of as part of "the filters". */
function presetFilters(f: FilterConfig): Partial<FilterConfig> {
  return {
    hideUnassigned: f.hideUnassigned,
    treeIdRange: f.treeIdRange,
    hiddenClasses: f.hiddenClasses,
    hiddenSemantic: f.hiddenSemantic,
    hiddenReturns: f.hiddenReturns,
    hideStandingDeadwood: f.hideStandingDeadwood,
    hideLayingDeadwood: f.hideLayingDeadwood,
    onlyDeadwood: f.onlyDeadwood,
    xRange: f.xRange,
    yRange: f.yRange,
    zRange: f.zRange,
    intensityRange: f.intensityRange,
    extraRange: f.extraRange,
  };
}

/** Read the saved presets once at mount. A corrupt / hand-edited value
 *  degrades to an empty list rather than throwing (localStorage content
 *  is untrusted input). */
function loadPresets(): FilterPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as FilterPreset[] : [];
  } catch {
    return [];
  }
}

export default function FiltersPanel() {
  const { filters, setFilters, tools, octree, display, stats } = useOctreeShell();
  const nActive = countActiveFilters(filters);
  const isolate = filters.isolateTreeId;
  const range = filters.treeIdRange;
  const isolateActive = isolate !== null;
  const intensityRange = filters.intensityRange;

  // Live "how many of the LOADED points currently pass" readout — see
  // ViewerStats.filterPassPoints/filterTotalPoints. Loaded-set only (the
  // whole cloud is rarely resident at once), which is exactly why the
  // line below must say "loaded" rather than reading as a whole-file count.
  const matchPct = stats.filterTotalPoints > 0
    ? ((stats.filterPassPoints / stats.filterTotalPoints) * 100).toFixed(1)
    : '0';

  // Saved filter presets — localStorage, mirrored to settings.json (see
  // PERSISTED_KEYS in settingsStore.ts) so they survive a WebView2 profile
  // reset. Loaded once on mount; every change below goes through
  // setPresets, and the effect writes the whole list back.
  const [presets, setPresets] = useState<FilterPreset[]>(loadPresets);
  const [selectedPreset, setSelectedPreset] = useState('');
  useEffect(() => {
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(presets)); } catch { /* ignore */ }
  }, [presets]);

  // World-coordinate bounds for the X/Y/Z range filters' placeholders.
  const bbMin = octree?.meta.boundingBox.min;
  const bbMax = octree?.meta.boundingBox.max;

  // Extra-column range filter — options come straight from the converter's
  // observed min/max (metadata.extras); empty on v1/v2 datasets or a v3
  // import without extras, in which case the whole Section is hidden below.
  const extras = octree?.meta.extras ?? [];
  const extraRange = filters.extraRange;
  const activeExtra = extras.find(e => e.name === extraRange?.name) ?? null;

  const clearAll = () => setFilters({
    hideUnassigned: false,
    isolateTreeId: null,
    isolateBox: null,
    isolateAnchor: null,
    isolateShowUnassigned: false,
    treeIdRange: null,
    hiddenClasses: [],
    hiddenSemantic: [],
    hiddenReturns: [],
    hideStandingDeadwood: false,
    hideLayingDeadwood: false,
    onlyDeadwood: false,
    xRange: null,
    yRange: null,
    zRange: null,
    intensityRange: null,
    extraRange: null,
  });

  const toggleClass = (code: number) => {
    const has = filters.hiddenClasses.includes(code);
    setFilters({
      hiddenClasses: has
        ? filters.hiddenClasses.filter(c => c !== code)
        : [...filters.hiddenClasses, code].sort((a, b) => a - b),
    });
  };

  const toggleSemantic = (code: number) => {
    const has = filters.hiddenSemantic.includes(code);
    setFilters({
      hiddenSemantic: has
        ? filters.hiddenSemantic.filter(c => c !== code)
        : [...filters.hiddenSemantic, code].sort((a, b) => a - b),
    });
  };

  const toggleReturn = (code: number) => {
    const has = filters.hiddenReturns.includes(code);
    setFilters({
      hiddenReturns: has
        ? filters.hiddenReturns.filter(c => c !== code)
        : [...filters.hiddenReturns, code].sort((a, b) => a - b),
    });
  };

  return (
    <div className="flex flex-col gap-3" style={{ width: 240 }}>
      {/* Header: active count + clear-all */}
      <div className="flex items-center justify-between">
        <span className="chip" style={{ margin: 0 }}>
          {nActive > 0 ? `${nActive} active` : 'No filters'}
        </span>
        <button
          className="btn btn-ghost !h-6 !px-2 mono text-[10.5px]"
          disabled={nActive === 0}
          onClick={clearAll}
          title="Show every point again"
        >
          Clear
        </button>
      </div>

      {/* Loaded-set match count — NOT a whole-cloud figure, since a big
          dataset never has every point resident at once. "loaded pts" is
          load-bearing wording so this never reads as the true file-wide
          match count. */}
      {nActive > 0 && stats.filterTotalPoints > 0 && (
        <Hint>
          {stats.filterPassPoints.toLocaleString()} / {stats.filterTotalPoints.toLocaleString()} loaded pts shown ({matchPct} %)
        </Hint>
      )}

      <Section label="Tree id">
        <label className="flex items-center justify-between cursor-pointer">
          <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>Hide unassigned (id ≤ 0)</span>
          <Toggle
            on={filters.hideUnassigned}
            onChange={(v) => setFilters({ hideUnassigned: v })}
          />
        </label>

        <div className="mt-2">
          <div className="flex items-center justify-between mono text-[10.5px] mb-1.5" style={{ color: 'var(--text-mute)' }}>
            <span>Isolate one tree</span>
            {isolateActive && (
              <button
                onClick={() => setFilters({ isolateTreeId: null, isolateBox: null, isolateAnchor: null })}
                className="mono text-[10px]"
                style={{ color: 'var(--accent)' }}
              >off</button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              value={isolate ?? ''}
              placeholder="—"
              onChange={(e) => {
                const t = e.target.value.trim();
                // A typed isolate has NO neighbourhood box — always clear
                // any box left behind by a Tree Review / QC isolate, or
                // the stale box (a) scopes unassigned to the WRONG tree
                // and (b) forces full-detail streaming somewhere else.
                if (t === '') setFilters({ isolateTreeId: null, isolateBox: null, isolateAnchor: null });
                else setFilters({ isolateTreeId: Math.max(0, parseInt(t, 10) || 0), isolateBox: null, isolateAnchor: null });
              }}
              className="flex-1 mono text-[12px] py-1 px-2 rounded-md"
              style={{
                background: 'rgba(0,0,0,0.3)',
                border: `1px solid ${isolateActive ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : 'var(--line)'}`,
                color: 'var(--text)',
                outline: 'none',
              }}
            />
            <button
              className="btn btn-ghost !h-7 !px-2 mono text-[10.5px]"
              disabled={tools.activeTreeId <= 0}
              onClick={() => setFilters({ isolateTreeId: tools.activeTreeId, isolateBox: null, isolateAnchor: null })}
              title="Isolate the currently active tree"
            >
              ← active
            </button>
          </div>
        </div>

        <div className="mt-2">
          <div className="flex items-center justify-between mono text-[10.5px] mb-1.5" style={{ color: 'var(--text-mute)' }}>
            <span>Id range</span>
            {range !== null && (
              <button
                onClick={() => setFilters({ treeIdRange: null })}
                className="mono text-[10px]"
                style={{ color: 'var(--accent)' }}
              >off</button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <NumInput
              value={range ? range[0] : ''}
              placeholder="min"
              onChange={(v) => {
                // Empty min → 0 (open low). Clearing both bounds turns the
                // filter off. Empty max defaults to open-high so "5+" works.
                const max = range ? range[1] : RANGE_MAX;
                if (v === null && (range === null || range[1] >= RANGE_MAX)) { setFilters({ treeIdRange: null }); return; }
                setFilters({ treeIdRange: [v ?? 0, max] });
              }}
            />
            <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>…</span>
            <NumInput
              value={range && range[1] < RANGE_MAX ? range[1] : ''}
              placeholder="max"
              onChange={(v) => {
                const min = range ? range[0] : 0;
                if (v === null && (range === null || range[0] <= 0)) { setFilters({ treeIdRange: null }); return; }
                setFilters({ treeIdRange: [min, v ?? RANGE_MAX] });
              }}
            />
          </div>
        </div>
      </Section>

      <Section
        label="Classification"
        right={
          <button
            onClick={() => setFilters({ hiddenClasses: invertCodes(CLASS_DOMAIN_MAX, filters.hiddenClasses) })}
            className="mono text-[10px]"
            style={{ color: 'var(--accent)' }}
            title="Invert hidden ⇄ visible classes"
          >invert</button>
        }
      >
        <div className="grid grid-cols-2 gap-1">
          {CLASS_OPTIONS.map(opt => {
            const hidden = filters.hiddenClasses.includes(opt.code);
            return (
              <button
                key={opt.code}
                onClick={(e) => {
                  // Alt/Option-click solos this code (see soloCodes — hides
                  // every OTHER code across the full 0..255 domain, not
                  // just the chips above); alt-clicking the already-soloed
                  // chip clears the group back to "show everything". A
                  // plain click just toggles this one code as before.
                  if (e.altKey) {
                    setFilters({
                      hiddenClasses: isSoloed(CLASS_DOMAIN_MAX, filters.hiddenClasses, opt.code)
                        ? []
                        : soloCodes(CLASS_DOMAIN_MAX, opt.code),
                    });
                  } else {
                    toggleClass(opt.code);
                  }
                }}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md mono text-[10.5px] transition-all"
                style={{
                  border: `1px solid ${hidden ? 'color-mix(in oklch, var(--danger, #e0506b) 60%, transparent)' : 'var(--line)'}`,
                  background: hidden ? 'rgba(224,80,107,0.10)' : 'transparent',
                  color: hidden ? 'var(--text-mute)' : 'var(--text-dim)',
                  textDecoration: hidden ? 'line-through' : 'none',
                }}
                title={hidden ? `Class ${opt.code} hidden — click to show` : `Hide class ${opt.code} (⌥-click to solo)`}
              >
                <span style={{
                  width: 10, height: 10, borderRadius: 2, background: opt.swatch,
                  boxShadow: '0 0 0 1px rgba(255,255,255,0.12)',
                  opacity: hidden ? 0.4 : 1,
                }} />
                <span className="truncate">{opt.label}</span>
              </button>
            );
          })}
        </div>
        <Hint>Click a class to hide it; click again to show. ⌥-click a chip to solo it (hides every other class, including unlisted ASPRS codes); ⌥-click again to clear. invert flips hidden ⇄ visible.</Hint>
      </Section>

      <Section
        label="Semantic"
        right={
          <button
            onClick={() => setFilters({ hiddenSemantic: invertCodes(SEMANTIC_DOMAIN_MAX, filters.hiddenSemantic) })}
            className="mono text-[10px]"
            style={{ color: 'var(--accent)' }}
            title="Invert hidden ⇄ visible semantic codes"
          >invert</button>
        }
      >
        <div className="grid grid-cols-2 gap-1">
          {SEMANTIC_OPTIONS.map(opt => {
            const hidden = filters.hiddenSemantic.includes(opt.code);
            return (
              <button
                key={opt.code}
                onClick={(e) => {
                  // See the Classification chips above: alt-click solos,
                  // alt-click again on the soloed chip clears.
                  if (e.altKey) {
                    setFilters({
                      hiddenSemantic: isSoloed(SEMANTIC_DOMAIN_MAX, filters.hiddenSemantic, opt.code)
                        ? []
                        : soloCodes(SEMANTIC_DOMAIN_MAX, opt.code),
                    });
                  } else {
                    toggleSemantic(opt.code);
                  }
                }}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md mono text-[10.5px] transition-all"
                style={{
                  border: `1px solid ${hidden ? 'color-mix(in oklch, var(--danger, #e0506b) 60%, transparent)' : 'var(--line)'}`,
                  background: hidden ? 'rgba(224,80,107,0.10)' : 'transparent',
                  color: hidden ? 'var(--text-mute)' : 'var(--text-dim)',
                  textDecoration: hidden ? 'line-through' : 'none',
                }}
                title={hidden ? `${opt.label} hidden — click to show` : `Hide ${opt.label} (⌥-click to solo)`}
              >
                <span style={{
                  width: 10, height: 10, borderRadius: 2,
                  background: opt.swatch ?? display.unlabeledColor,
                  boxShadow: '0 0 0 1px rgba(255,255,255,0.12)',
                  opacity: hidden ? 0.4 : 1,
                }} />
                <span className="truncate">{opt.label}</span>
              </button>
            );
          })}
        </div>
        <Hint>Semantic codes come from QSM segmentation, leaf–wood separation, or manual labelling. Hiding Unlabelled is the quick way to see only classified wood. ⌥-click a chip to solo it; ⌥-click again to clear. invert flips hidden ⇄ visible.</Hint>
      </Section>

      <Section label="Deadwood">
        <label className="flex items-center justify-between cursor-pointer">
          <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>Hide standing dead</span>
          <Toggle
            on={filters.hideStandingDeadwood}
            onChange={(v) => setFilters({ hideStandingDeadwood: v })}
          />
        </label>
        <div className="mt-2">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>Hide laying dead</span>
            <Toggle
              on={filters.hideLayingDeadwood}
              onChange={(v) => setFilters({ hideLayingDeadwood: v })}
            />
          </label>
        </div>
        <div className="mt-2">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>Only deadwood</span>
            <Toggle
              on={filters.onlyDeadwood}
              onChange={(v) => setFilters({ onlyDeadwood: v })}
            />
          </label>
        </div>
        <Hint>"Only deadwood" shows just the points labelled in either channel; it does nothing on a dataset without deadwood columns.</Hint>
      </Section>

      <Section label="Intensity">
        <div className="flex items-center justify-between mono text-[10.5px] mb-1.5" style={{ color: 'var(--text-mute)' }}>
          <span>Range</span>
          {intensityRange !== null && (
            <button
              onClick={() => setFilters({ intensityRange: null })}
              className="mono text-[10px]"
              style={{ color: 'var(--accent)' }}
            >off</button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <NumInput
            value={intensityRange ? intensityRange[0] : ''}
            placeholder="min"
            onChange={(v) => {
              // Empty min → 0 (open low). Clearing both bounds turns the
              // filter off, matching the Id-range field above.
              const max = intensityRange ? intensityRange[1] : INTENSITY_MAX;
              if (v === null && (intensityRange === null || intensityRange[1] >= INTENSITY_MAX)) { setFilters({ intensityRange: null }); return; }
              setFilters({ intensityRange: [v ?? 0, max] });
            }}
          />
          <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>…</span>
          <NumInput
            value={intensityRange && intensityRange[1] < INTENSITY_MAX ? intensityRange[1] : ''}
            placeholder="max"
            onChange={(v) => {
              const min = intensityRange ? intensityRange[0] : 0;
              if (v === null && (intensityRange === null || intensityRange[0] <= 0)) { setFilters({ intensityRange: null }); return; }
              setFilters({ intensityRange: [min, v ?? INTENSITY_MAX] });
            }}
          />
        </div>
        <Hint>Raw stored 16-bit intensity — the useful range depends on the sensor.</Hint>
      </Section>

      <Section
        label="Returns"
        right={
          <button
            onClick={() => setFilters({ hiddenReturns: invertCodes(RETURN_DOMAIN_MAX, filters.hiddenReturns) })}
            className="mono text-[10px]"
            style={{ color: 'var(--accent)' }}
            title="Invert hidden ⇄ visible returns"
          >invert</button>
        }
      >
        <div className="grid grid-cols-4 gap-1">
          {RETURN_OPTIONS.map(opt => {
            const hidden = filters.hiddenReturns.includes(opt.code);
            return (
              <button
                key={opt.code}
                onClick={(e) => {
                  // See the Classification chips above: alt-click solos,
                  // alt-click again on the soloed chip clears.
                  if (e.altKey) {
                    setFilters({
                      hiddenReturns: isSoloed(RETURN_DOMAIN_MAX, filters.hiddenReturns, opt.code)
                        ? []
                        : soloCodes(RETURN_DOMAIN_MAX, opt.code),
                    });
                  } else {
                    toggleReturn(opt.code);
                  }
                }}
                className="flex items-center justify-center px-1.5 py-1 rounded-md mono text-[10.5px] transition-all"
                style={{
                  border: `1px solid ${hidden ? 'color-mix(in oklch, var(--danger, #e0506b) 60%, transparent)' : 'var(--line)'}`,
                  background: hidden ? 'rgba(224,80,107,0.10)' : 'transparent',
                  color: hidden ? 'var(--text-mute)' : 'var(--text-dim)',
                  textDecoration: hidden ? 'line-through' : 'none',
                }}
                title={hidden ? `Return ${opt.label} hidden — click to show` : `Hide return ${opt.label} (⌥-click to solo)`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <Hint>LAS return number. Hiding returns 2–7 leaves only first returns (canopy top); hiding 1 leaves only the later returns (under-canopy). Many terrestrial (TLS/MLS) datasets write 0 for every point. ⌥-click a chip to solo it; ⌥-click again to clear. invert flips hidden ⇄ visible.</Hint>
      </Section>

      {/* Only shown when the dataset actually carries extra columns
          (v3 octree imported with LAS Extra-Bytes) — an empty Section
          would just be dead chrome on every v1/v2 dataset. */}
      {extras.length > 0 && (
        <Section label="Extra column">
          <select
            value={extraRange?.name ?? ''}
            onChange={(e) => {
              const name = e.target.value;
              if (!name) { setFilters({ extraRange: null }); return; }
              const ext = extras.find(x => x.name === name);
              if (ext) setFilters({ extraRange: { name, lo: ext.min, hi: ext.max } });
            }}
            className="w-full mono text-[11px] rounded-md px-1.5 py-1"
            style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
          >
            <option value="">— none —</option>
            {extras.map(e => (
              <option key={e.name} value={e.name}>{e.name}</option>
            ))}
          </select>
          {activeExtra && extraRange && (
            <div className="mt-2">
              <div className="flex items-center justify-between mono text-[10.5px] mb-1.5" style={{ color: 'var(--text-mute)' }}>
                <span>Range</span>
                <button
                  onClick={() => setFilters({ extraRange: null })}
                  className="mono text-[10px]"
                  style={{ color: 'var(--accent)' }}
                >off</button>
              </div>
              {activeExtra.max > activeExtra.min && (
                <div className="mb-1.5">
                  <DualRangeSlider
                    min={activeExtra.min}
                    max={activeExtra.max}
                    value={[extraRange.lo, extraRange.hi]}
                    onChange={([lo, hi]) => setFilters({ extraRange: { name: activeExtra.name, lo, hi } })}
                  />
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <NumInput
                  value={extraRange.lo}
                  placeholder="min"
                  onChange={(v) => setFilters({ extraRange: { name: activeExtra.name, lo: v ?? activeExtra.min, hi: extraRange.hi } })}
                />
                <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>…</span>
                <NumInput
                  value={extraRange.hi}
                  placeholder="max"
                  onChange={(v) => setFilters({ extraRange: { name: activeExtra.name, lo: extraRange.lo, hi: v ?? activeExtra.max } })}
                />
              </div>
            </div>
          )}
          <Hint>
            One numeric extra column at a time. Use height_above_ground (built by Terrain → Normalize) for "show me the 0–2 m understorey" — the Z filter above is absolute elevation, which is useless on a slope.
          </Hint>
        </Section>
      )}

      {/* Spatial extent — clip the view to an X / Y / Z box in world
          (source-CRS) units. Empty fields are open-ended on that side, so
          "Z 2 … —" keeps everything 2 m and up. Placeholders show the
          dataset's own bounds so the user knows the range to work in. */}
      <Section label="Extent">
        <AxisRange
          label="X (east)"
          range={filters.xRange}
          lo={bbMin?.[0]} hi={bbMax?.[0]}
          onChange={(r) => setFilters({ xRange: r })}
        />
        <div className="mt-2">
          <AxisRange
            label="Y (north)"
            range={filters.yRange}
            lo={bbMin?.[1]} hi={bbMax?.[1]}
            onChange={(r) => setFilters({ yRange: r })}
          />
        </div>
        <div className="mt-2">
          <AxisRange
            label="Z (elev)"
            range={filters.zRange}
            lo={bbMin?.[2]} hi={bbMax?.[2]}
            onChange={(r) => setFilters({ zRange: r })}
          />
        </div>
      </Section>

      <Hint>
        Filters never delete points — clear any time to bring everything back. Hidden points are also excluded from selection.
      </Hint>

      <Section label="Presets">
        <select
          value={selectedPreset}
          onChange={(e) => {
            const name = e.target.value;
            setSelectedPreset(name);
            if (!name) return;
            const preset = presets.find(p => p.name === name);
            if (preset) setFilters(preset.filters);
          }}
          className="w-full mono text-[11px] rounded-md px-1.5 py-1"
          style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
        >
          <option value="">— presets —</option>
          {presets.map(p => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
        <div className="flex items-center gap-1.5 mt-1.5">
          <button
            className="btn btn-ghost !h-6 !px-2 mono text-[10.5px]"
            onClick={async () => {
              const typed = window.prompt('Save current filters as preset:', selectedPreset || '');
              const name = typed?.trim();
              if (!name) return;
              const exists = presets.some(p => p.name === name);
              if (exists && !await confirmDialog(`A preset named "${name}" already exists — overwrite it?`)) return;
              const saved: FilterPreset = { name, filters: presetFilters(filters) };
              setPresets(prev => (exists ? prev.map(p => (p.name === name ? saved : p)) : [...prev, saved]));
              setSelectedPreset(name);
            }}
            title="Save the current filters as a named preset"
          >
            save
          </button>
          <button
            className="btn btn-ghost !h-6 !px-2 mono text-[10.5px]"
            disabled={!selectedPreset}
            onClick={async () => {
              if (!selectedPreset) return;
              if (!await confirmDialog(`Delete preset "${selectedPreset}"?`)) return;
              setPresets(prev => prev.filter(p => p.name !== selectedPreset));
              setSelectedPreset('');
            }}
            title="Delete the selected preset"
          >
            delete
          </button>
        </div>
        <Hint>Presets store the general filters only — hidden classes / semantic / returns, deadwood, id / intensity / extra-column / X-Y-Z ranges. They do NOT capture the isolated tree or the Slab / viewpoint tools, which are scoped to one dataset and session.</Hint>
      </Section>
    </div>
  );
}

/** A world-coordinate min … max range filter for one spatial axis.
 *  Either bound may be left empty (open-ended on that side); clearing
 *  both turns the axis filter off. Placeholders quote the dataset's own
 *  bounds so the numbers are easy to set. */
function AxisRange({ label, range, lo, hi, onChange }: {
  label: string;
  range: [number, number] | null;
  lo: number | undefined;
  hi: number | undefined;
  onChange: (r: [number, number] | null) => void;
}) {
  const NEG = -1e30, POS = 1e30;
  const active = range !== null;
  const minVal = range && range[0] > NEG ? range[0] : '';
  const maxVal = range && range[1] < POS ? range[1] : '';
  const fmt = (n: number | undefined) => (n === undefined ? '' : (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2)));
  // The slider needs finite bounds. When the dataset bbox is known we show
  // it; dragging snaps the open ends to the bounds. Releasing both ends
  // back to the full extent clears the filter (so the slider can turn
  // itself off, matching the "off" link).
  const hasBounds = lo !== undefined && hi !== undefined && (hi as number) > (lo as number);
  const sliderLo = range && range[0] > NEG ? range[0] : (lo ?? 0);
  const sliderHi = range && range[1] < POS ? range[1] : (hi ?? 1);
  const onSlider = (v: [number, number]) => {
    const bl = lo as number, bh = hi as number;
    // Snap-to-edge → open-ended; both at the edges → filter off.
    const atLo = v[0] <= bl + (bh - bl) * 1e-4;
    const atHi = v[1] >= bh - (bh - bl) * 1e-4;
    if (atLo && atHi) { onChange(null); return; }
    onChange([atLo ? NEG : v[0], atHi ? POS : v[1]]);
  };
  return (
    <div>
      <div className="flex items-center justify-between mono text-[10.5px] mb-1.5" style={{ color: 'var(--text-mute)' }}>
        <span>{label}</span>
        {active && (
          <button onClick={() => onChange(null)} className="mono text-[10px]" style={{ color: 'var(--accent)' }}>off</button>
        )}
      </div>
      {hasBounds && (
        <div className="mb-1.5">
          <DualRangeSlider
            min={lo as number}
            max={hi as number}
            value={[sliderLo, sliderHi]}
            onChange={onSlider}
          />
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <ExtentInput
          value={minVal}
          placeholder={fmt(lo) || 'min'}
          active={active}
          onChange={(v) => {
            const max = range ? range[1] : POS;
            if (v === null && (range === null || range[1] >= POS)) { onChange(null); return; }
            onChange([v ?? NEG, max]);
          }}
        />
        <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>…</span>
        <ExtentInput
          value={maxVal}
          placeholder={fmt(hi) || 'max'}
          active={active}
          onChange={(v) => {
            const min = range ? range[0] : NEG;
            if (v === null && (range === null || range[0] <= NEG)) { onChange(null); return; }
            onChange([min, v ?? POS]);
          }}
        />
      </div>
    </div>
  );
}

function ExtentInput({ value, placeholder, active, onChange }: {
  value: number | '';
  placeholder: string;
  active: boolean;
  onChange: (n: number | null) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      placeholder={placeholder}
      onChange={(e) => {
        const t = e.target.value.trim();
        if (t === '') onChange(null);
        else { const v = parseFloat(t); onChange(Number.isFinite(v) ? v : null); }
      }}
      className="flex-1 min-w-0 mono text-[12px] py-1 px-2 rounded-md"
      style={{
        background: 'rgba(0,0,0,0.3)',
        border: `1px solid ${active ? 'color-mix(in oklch, var(--accent) 45%, transparent)' : 'var(--line)'}`,
        color: 'var(--text)',
        outline: 'none',
      }}
    />
  );
}

function Section({ label, right, children }: { label: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="chip">{label}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="mono text-[9.5px] mt-1" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

function NumInput({ value, placeholder, onChange }: {
  value: number | '';
  placeholder: string;
  onChange: (n: number | null) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      placeholder={placeholder}
      onChange={(e) => {
        const t = e.target.value.trim();
        if (t === '') onChange(null);
        else onChange(parseInt(t, 10) || 0);
      }}
      className="flex-1 min-w-0 mono text-[12px] py-1 px-2 rounded-md"
      style={{
        background: 'rgba(0,0,0,0.3)',
        border: '1px solid var(--line)',
        color: 'var(--text)',
        outline: 'none',
      }}
    />
  );
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
