// Looks: a whole way of seeing the cloud in one click. A look is
// the display settings that belong together for one job — what to colour by,
// the ramp and its stretch, the shading, the lighting, the points, the
// heights and the projection — not the filters (those stay what the user
// set, in the Filters panel). Built-in looks for the work a forest plot
// needs, and the user's own, kept on this machine.

import type { ColorHistogram, DisplayConfig } from './OctreeShellContext';
import { autoRange } from './RangeEditor';
import type { ViewPaletteCommand } from './viewToolsStore';

export interface Look {
  id: string;
  name: string;
  hint: string;
  display: Partial<DisplayConfig>;
  /** What the dataset must carry for the look to apply. */
  needs?: 'deadwood';
  /** Stretch the ramp over the loaded points' 2–98 % when applied. */
  autoStretch?: boolean;
  builtIn?: boolean;
}

/** The display settings a look sets (and a saved look keeps). */
export const LOOK_KEYS: Array<keyof DisplayConfig> = [
  'colorMode', 'ramp', 'customRamp', 'rampRanges', 'extraRangeOverrides', 'shade', 'edlEnabled', 'edlStrength',
  'pointSize', 'heightMode', 'heightColorAboveGround', 'projection',
  'unlabeledColor', 'treeMetric', 'treeRanges',
];

export const BUILT_IN_LOOKS: Look[] = [
  {
    id: 'canopy', name: 'Canopy height', builtIn: true,
    hint: 'Height above the ground, viridis, eye-dome lighting, lightly shaded by intensity',
    display: { colorMode: 'height', heightColorAboveGround: true, ramp: 'viridis', shade: 0.35, edlEnabled: true, edlStrength: 1, projection: 'perspective' },
  },
  {
    id: 'intensity', name: 'Intensity', builtIn: true, autoStretch: true,
    hint: 'The return strength in grey, stretched over its 2–98 %: bark, foliage, the ground and targets apart',
    display: { colorMode: 'intensity', ramp: 'grayscale', shade: 0, edlEnabled: true, edlStrength: 0.6 },
  },
  {
    id: 'trees', name: 'Tree review', builtIn: true,
    hint: 'A colour per tree, unlabelled grey, shaded by intensity so stems and branches read inside the colours',
    display: { colorMode: 'tree_id', shade: 0.6, edlEnabled: true, edlStrength: 1 },
  },
  {
    id: 'stand', name: 'Stand map (DBH)', builtIn: true,
    hint: 'Every tree coloured by its DBH — the thick and the thin at a glance; measure the trees once (Display → Tree metrics)',
    display: { colorMode: 'tree_metric', treeMetric: 'dbh', ramp: 'viridis', shade: 0.5, edlEnabled: true, edlStrength: 1 },
  },
  {
    id: 'wood', name: 'Stems & wood', builtIn: true,
    hint: 'Stem, branch and leaf labels, shaded — for checking a wood / leaf separation',
    display: { colorMode: 'semantic', shade: 0.6, edlEnabled: true, edlStrength: 1 },
  },
  {
    id: 'classes', name: 'Terrain & classes', builtIn: true,
    hint: 'ASPRS classes (ground, vegetation, noise…) shaded by intensity, strong eye-dome lighting for the ground surface',
    display: { colorMode: 'classification', shade: 0.5, edlEnabled: true, edlStrength: 1.4 },
  },
  {
    id: 'deadwood', name: 'Deadwood', builtIn: true, needs: 'deadwood',
    hint: 'Standing deadwood instances over the grey cloud, shaded',
    display: { colorMode: 'standing_deadwood', shade: 0.5, edlEnabled: true, edlStrength: 1 },
  },

  {
    id: 'measure', name: 'Measuring (parallel)', builtIn: true,
    hint: 'A parallel projection at true scale, heights above ground in turbo, eye-dome lighting — for sections and profiles',
    display: { colorMode: 'height', heightColorAboveGround: true, ramp: 'turbo', shade: 0.3, edlEnabled: true, edlStrength: 1, projection: 'ortho' },
  },
];

const USER_KEY = 'pointcloudlabeler-looks';

export function loadUserLooks(): Look[] {
  try {
    const v = JSON.parse(localStorage.getItem(USER_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((l): l is Look => !!l && typeof (l as Look).name === 'string' && typeof (l as Look).display === 'object') : [];
  } catch { return []; }
}

function storeUserLooks(looks: Look[]): void {
  try { localStorage.setItem(USER_KEY, JSON.stringify(looks)); } catch { /* storage unavailable */ }
}

/** The display as a look named `name` (only the look keys). */
export function lookFromDisplay(name: string, d: DisplayConfig): Look {
  const display: Partial<DisplayConfig> = {};
  for (const k of LOOK_KEYS) {
    if (d[k] !== undefined) (display as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(d[k]));
  }
  return { id: `user:${name}`, name, hint: 'Saved look', display };
}

/** Save (or replace by name) a look of the user's; returns the list. */
export function saveUserLook(look: Look): Look[] {
  const list = [...loadUserLooks().filter((l) => l.name !== look.name), look];
  storeUserLooks(list);
  return list;
}

export function deleteUserLook(name: string): Look[] {
  const list = loadUserLooks().filter((l) => l.name !== name);
  storeUserLooks(list);
  return list;
}

/** Whether the dataset can show a look. */
export function lookAvailable(look: Look, has: { deadwood: boolean }): boolean {
  return look.needs === 'deadwood' ? has.deadwood : true;
}

/** What an optional setting is when the display has none. */
const ABSENT: Partial<DisplayConfig> = { projection: 'perspective', shade: 0 };

/** Whether the display is a look now (every setting it sets as it sets it). */
export function isLookActive(look: Look, d: DisplayConfig): boolean {
  const at = (k: keyof DisplayConfig) => d[k] ?? ABSENT[k] ?? null;
  return Object.entries(look.display).every(([k, v]) => JSON.stringify(at(k as keyof DisplayConfig)) === JSON.stringify(v ?? null));
}

/** Put a look on: its settings, and with `autoStretch` the ramp over the
 *  loaded points' 2–98 % once the new mode has its histogram. */
export function applyLook(
  look: Look, display: DisplayConfig, setDisplay: (p: Partial<DisplayConfig>) => void,
  histogram?: () => ColorHistogram | null,
): void {
  setDisplay(look.display);
  if (!look.autoStretch || !histogram) return;
  setTimeout(() => {
    const h = histogram();
    const key = h?.key as keyof NonNullable<DisplayConfig['rampRanges']> | undefined;
    if (h && key) setDisplay({ rampRanges: { ...(look.display.rampRanges ?? display.rampRanges ?? {}), [key]: autoRange(h, key === 'intensity') } });
  }, 250);
}

/** The looks in the command palette ("Look: Canopy height"). */
export function looksPaletteCommands(
  display: DisplayConfig, setDisplay: (p: Partial<DisplayConfig>) => void,
  histogram: (() => ColorHistogram | null) | undefined, has: { deadwood: boolean },
): ViewPaletteCommand[] {
  return [...BUILT_IN_LOOKS.filter((l) => lookAvailable(l, has)), ...loadUserLooks()].map((l) => ({
    id: `look.${l.id}`, group: 'Looks', title: `Look: ${l.name}`, keywords: `display preset ${l.hint}`,
    run: () => applyLook(l, display, setDisplay, histogram),
  }));
}
