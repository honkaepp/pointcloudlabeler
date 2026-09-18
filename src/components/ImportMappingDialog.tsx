// Import dialog shown before a cloud lands. Combines the scanner-type
// pick with a per-column role mapping so the user can declare which
// source column fills each PointCloudLabeler variable — X / Y / Z / tree_id /
// semantic / classification — for both TXT and LAS/LAZ files. LAS X/Y/Z
// always come from the file's geometric coordinates, so those rows are
// locked for LAS imports; everything else is a free choice.
//
// Styling matches the editor shell (glass backdrop, chip section labels,
// accent-lit inputs, segmented pickers, keyboard hints in the footer) so
// the import flow feels like part of the same product as everything else.

import { useEffect, useMemo, useState } from 'react';
import { SCANNER_TYPES, SCANNER_TYPE_LABELS, type ScannerType } from '../state/multiCloud';
import { ROLE_INFO, type ColumnMapping, type ColumnRole } from '../io/columnMapping';
import { isDeadwoodExtra } from '../persistence/octreeReader';
import { unsupportedLasFields } from '../io/parseLasStream';

interface Props {
  fileName: string;
  isLas: boolean;
  columns: string[];
  /** LAS point data record format, or null when unknown / not a LAS. */
  pointFormat?: number | null;
  suggested: ColumnMapping;
  onConfirm: (
    scannerType: ScannerType,
    mapping: ColumnMapping,
    verticalAxis: 'Z' | 'H',
    /** For the scannerOnly (octree) route only — the LAS extra-byte
     *  dimension names the converter should read as tree_id / semantic.
     *  Either may be empty, meaning "import as unassigned". */
    preSegmented?: {
      treeIdExtra: string; semanticExtra: string;
      /** Optional source columns to seed the standing / laying deadwood
       *  id channels. Empty ⇒ the channel still exists but starts empty
       *  (the editor labels it). */
      standingDeadwoodExtra: string; layingDeadwoodExtra: string;
    },
    /** For the scannerOnly route only — extra LAS Extra-Bytes columns to
     *  carry into the octree as numeric (f32) extras so the viewer can
     *  colour by them afterwards. Always excludes any column already
     *  consumed as tree_id / semantic to avoid duplicate storage. */
    extraNames?: string[],
    /** For the scannerOnly route only — when false the two reserved
     *  deadwood id channels are NOT created (8 bytes/point saved). They
     *  can still be enabled later in-app. Defaults to true so the import
     *  matches the legacy behaviour unless the user explicitly opts out. */
    includeDeadwood?: boolean,
  ) => void;
  onCancel: () => void;
  /** 'full' (default) shows scanner type + vertical axis + column
   *  mapping for the in-memory parser. 'scannerOnly' is used by the
   *  octree route, where X/Y/Z/intensity/class/return are read straight
   *  from the LAS geometry by the Rust converter — only the scanner
   *  type + the pre-segmented extras are real user choices. */
  mode?: 'full' | 'scannerOnly';
}

// Standard LAS fields the octree stores natively — kept as a safety net
// so a file that happens to declare an Extra-Bytes dimension named "x" /
// "intensity" / etc. doesn't get offered as a numeric extra alongside the
// geometry the converter already reads. `detectLasColumns` no longer
// injects these names (the dropdowns show only the file's real EB dims),
// so this filter is normally a no-op.
const STANDARD_FIELDS = new Set(['x', 'y', 'z', 'tree_id', 'intensity', 'classification', 'return_number']);

/** The one standard LAS field worth carrying as a column.
 *
 *  `point_source_id` says which sensor pass produced a point — the scan
 *  position in a merged TLS cloud, the flight line in ALS. The octree
 *  has no native slot for it, `detectLasColumns` never reports it
 *  (it is not an Extra-Bytes dimension), and without it the point-QC
 *  tool's wind stage cannot run at all: it works by asking whether a
 *  point's neighbours were seen from OTHER scan positions. So it is
 *  offered here for every LAS file rather than only when a file happens
 *  to declare a dimension by that name. The importer resolves it from
 *  the standard record (octree.rs's POINT_SOURCE_ID_NAME). */
const PSID_COLUMN = 'point_source_id';

// Best-guess pre-fill: only ever match a column the file ACTUALLY has
// (never invents a name). A column literally named one of these maps to
// the matching role so the common "my file has a tree_id column" case
// works without hunting — the user can still change or clear it.
function detectRole(columns: string[], names: string[]): string {
  const lc = columns.map(c => c.toLowerCase());
  for (const n of names) {
    const i = lc.indexOf(n);
    if (i >= 0) return columns[i];
  }
  return '';
}

export default function ImportMappingDialog({ fileName, isLas, columns, suggested, onConfirm, onCancel, mode = 'full', pointFormat = null}: Props) {
  // Standard LAS fields this file has that the octree cannot carry.
  const dropped = unsupportedLasFields(pointFormat);

  const scannerOnly = mode === 'scannerOnly';
  // Pre-fill role columns from EXACT-name matches in the file's real
  // columns (never a phantom). tree_id / semantic / class are the common
  // spellings; deadwood channels match their reserved names. If any match,
  // the "pre-segmented" box starts ticked so the picks take effect — that
  // was the trap: a file genuinely carrying tree_id / class would import
  // as all-unassigned if the box was left off or the column un-picked.
  const guessTree = scannerOnly ? detectRole(columns, ['tree_id', 'treeid', 'instance', 'instance_pred', 'instance_id']) : '';
  const guessSem = scannerOnly ? detectRole(columns, ['semantic', 'semantic_class', 'semantic_pred', 'class', 'classification', 'label']) : '';
  const guessStanding = scannerOnly ? detectRole(columns, ['standing_deadwood']) : '';
  const guessLaying = scannerOnly ? detectRole(columns, ['laying_deadwood']) : '';
  const anyGuess = !!(guessTree || guessSem || guessStanding || guessLaying);

  const [preSegmented, setPreSegmented] = useState(anyGuess);
  const [treeIdExtra, setTreeIdExtra] = useState<string>(guessTree);
  const [semanticExtra, setSemanticExtra] = useState<string>(guessSem);
  // Deadwood channels start enabled by default so the editor's Deadwood
  // tool is immediately available; users can opt out on big TLS clouds
  // they don't plan to label deadwood on (8 bytes/point + a measurable
  // import speedup on multi-GB files). Either way the channels can be
  // added later from the Segment panel.
  const [includeDeadwoodCols, setIncludeDeadwoodCols] = useState(true);
  // Optional source columns for the two deadwood id channels. The channels
  // are always created on import (so the editor can label deadwood even
  // when the file has none); these just seed them when the file already
  // carries deadwood ids.
  const [standingDeadwoodExtra, setStandingDeadwoodExtra] = useState<string>(guessStanding);
  const [layingDeadwoodExtra, setLayingDeadwoodExtra] = useState<string>(guessLaying);
  // Extra LAS Extra-Bytes columns to carry into the octree as numeric
  // (f32) extras, so the Display panel can colour by them afterwards
  // (amplitude / reflectance / pulse_width / …). Excluded from the
  // payload when they coincide with the tree_id or semantic role since
  // those are already stored as their own fields.
  const [includeExtras, setIncludeExtras] = useState<Record<string, boolean>>({});
  const [scannerType, setScannerType] = useState<ScannerType>('other');
  const [mapping, setMapping] = useState<ColumnMapping>(suggested);
  // Coordinate-space vertical: Z (absolute) or H (above ground). Default Z
  // when an absolute elevation is available (always for LAS); otherwise H.
  const [verticalAxis, setVerticalAxis] = useState<'Z' | 'H'>(
    (isLas || suggested.z) ? 'Z' : 'H',
  );

  // Candidates for the pre-segmented tree_id / semantic pickers. The user
  // gets the full column list (detected by detectLasColumns — every
  // standard LAS field + every LAS Extra-Bytes dim, all lowercased) and
  // decides which one carries what. We only de-duplicate.
  const extraColumnOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of columns) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
    }
    return out;
  }, [columns]);

  // Columns that are real Extra-Bytes dimensions worth carrying as numeric
  // f32 extras — i.e. everything EXCEPT the standard LAS fields the octree
  // already stores natively (X/Y/Z, intensity, classification, return,
  // and tree_id which has its own slot). So species / reflectance /
  // amplitude / pulse_width / … surface here, ready to colour by.
  const extraCarryOptions = useMemo(() => {
    const dims = extraColumnOptions.filter(
      c => !STANDARD_FIELDS.has(c.toLowerCase()) && !isDeadwoodExtra(c) && c.toLowerCase() !== PSID_COLUMN,
    );
    // Offered first, and only for LAS: a text file has no such field.
    return isLas ? [PSID_COLUMN, ...dims] : dims;
  }, [extraColumnOptions, isLas]);
  // Default: carry every detected extra so a richly-attributed cloud
  // arrives with all its columns visible in the Display panel — the user
  // unticks any they don't want rather than hunting for each.
  useEffect(() => {
    setIncludeExtras(() => {
      const m: Record<string, boolean> = {};
      for (const c of extraCarryOptions) m[c] = true;
      return m;
    });
  }, [extraCarryOptions]);

  // Which roles are editable here. LAS coordinates are fixed by the file's
  // scale/offset, so X/Y/Z aren't user-mappable for LAS (H still is — it can
  // be a precomputed extra dimension or left to be computed in-app).
  const roles = useMemo(
    () => ROLE_INFO.filter(r => !(isLas && (r.role === 'x' || r.role === 'y' || r.role === 'z'))),
    [isLas],
  );

  const setRole = (role: ColumnRole, value: string) =>
    setMapping(m => ({ ...m, [role]: value || null }));

  // Validation. TXT needs X/Y assigned + distinct and at least one vertical;
  // choosing the Z axis needs an absolute Z source (LAS always has one).
  const xyMissing = !isLas && (!mapping.x || !mapping.y);
  const xyDup = !isLas && !!mapping.x && mapping.x === mapping.y;
  const vertMissing = !isLas && !mapping.z && !mapping.h;
  const axisZNoSource = verticalAxis === 'Z' && !isLas && !mapping.z;
  // The scanner-only (octree) route has nothing to validate — the
  // converter reads every geometric field itself.
  const canConfirm = scannerOnly || (!xyMissing && !xyDup && !vertMissing && !axisZNoSource);

  // The tree_id / semantic role columns are stored as their own fixed
  // fields, so don't duplicate them into the f32 extras payload even if
  // the user ticked them in the extras list.
  const claimedAsRole = new Set<string>();
  if (scannerOnly && preSegmented && treeIdExtra) claimedAsRole.add(treeIdExtra);
  if (scannerOnly && preSegmented && semanticExtra) claimedAsRole.add(semanticExtra);
  if (scannerOnly && preSegmented && standingDeadwoodExtra) claimedAsRole.add(standingDeadwoodExtra);
  if (scannerOnly && preSegmented && layingDeadwoodExtra) claimedAsRole.add(layingDeadwoodExtra);
  const effectiveExtras = scannerOnly
    ? extraCarryOptions.filter(c => includeExtras[c] && !claimedAsRole.has(c))
    : [];

  const confirm = () => onConfirm(
    scannerType, mapping, verticalAxis,
    scannerOnly
      ? {
          treeIdExtra: preSegmented ? treeIdExtra : '',
          semanticExtra: preSegmented ? semanticExtra : '',
          standingDeadwoodExtra: preSegmented && includeDeadwoodCols ? standingDeadwoodExtra : '',
          layingDeadwoodExtra: preSegmented && includeDeadwoodCols ? layingDeadwoodExtra : '',
        }
      : undefined,
    scannerOnly ? effectiveExtras : undefined,
    scannerOnly ? includeDeadwoodCols : undefined,
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canConfirm) { e.preventDefault(); confirm(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scannerType, mapping, verticalAxis, canConfirm, scannerOnly, preSegmented, treeIdExtra, semanticExtra, standingDeadwoodExtra, layingDeadwoodExtra, includeExtras, includeDeadwoodCols]);

  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center pointer-events-auto"
      style={{ background: 'rgba(6,10,8,0.62)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
      role="dialog"
      aria-label="Import options"
    >
      <div className="panel rounded-xl overflow-hidden" style={{ width: 600, maxWidth: '94vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="rounded-md flex items-center justify-center" style={{ width: 30, height: 30, background: 'color-mix(in oklch, var(--accent) 18%, transparent)', border: '1px solid color-mix(in oklch, var(--accent) 45%, transparent)' }}>
            <ImportIcon />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text)' }}>Import cloud</div>
            <div className="mono text-[10.5px] truncate" style={{ color: 'var(--text-mute)' }}>
              {fileName} · {isLas ? 'LAS / LAZ' : 'TXT / XYZ / CSV'} · {columns.length} source column{columns.length === 1 ? '' : 's'}
            </div>
          </div>
          <button className="btn btn-ghost !h-7 !w-7 !p-0 justify-center" onClick={onCancel} title="Cancel (Esc)">✕</button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto">
          <Field label="Scanner type">
            <select
              value={scannerType}
              onChange={e => setScannerType(e.target.value as ScannerType)}
              className="w-full px-2.5 py-2 mono text-[12px] rounded-md outline-none"
              style={inputStyle}
              onFocus={focusOn}
              onBlur={focusOff}
            >
              {SCANNER_TYPES.map(t => (
                <option key={t} value={t}>{SCANNER_TYPE_LABELS[t].label}</option>
              ))}
            </select>
            <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)' }}>
              {SCANNER_TYPE_LABELS[scannerType].sub}
            </div>
          </Field>

          {scannerOnly && (
            <Field label="Pre-segmented columns" optional>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <Checkbox checked={preSegmented} onChange={setPreSegmented} />
                <span className="mono text-[11.5px]" style={{ color: 'var(--text)' }}>
                  This file already carries tree_id / semantic / deadwood in extra columns
                </span>
              </label>
              {preSegmented && (
                <div className="rounded-md mt-2 p-2.5 flex flex-col gap-2" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.18)' }}>
                  {extraColumnOptions.length === 0 ? (
                    <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
                      No columns detected in this file — leave unchecked and segment in-app.
                    </div>
                  ) : (<>
                    {anyGuess && (
                      <div className="mono text-[10px] px-2 py-1.5 rounded" style={{ color: 'var(--accent)', background: 'color-mix(in oklch, var(--accent) 10%, transparent)', border: '1px solid color-mix(in oklch, var(--accent) 35%, transparent)', lineHeight: 1.45 }}>
                        Matched columns by name — change any below if it's wrong.
                      </div>
                    )}
                    <ColumnPick label="tree_id" hint="Instance id per point (0 = unassigned)." value={treeIdExtra} options={extraColumnOptions} onChange={setTreeIdExtra} />
                    <ColumnPick label="semantic" hint="Per-point stem / branch label (1 = stem, 2 = branch)." value={semanticExtra} options={extraColumnOptions} onChange={setSemanticExtra} />
                    <ColumnPick label="standing deadwood" hint="Standing dead-tree instance id per point (0 = none)." value={standingDeadwoodExtra} options={extraColumnOptions} onChange={setStandingDeadwoodExtra} />
                    <ColumnPick label="laying deadwood" hint="Fallen / lying dead-tree instance id per point (0 = none)." value={layingDeadwoodExtra} options={extraColumnOptions} onChange={setLayingDeadwoodExtra} />
                    <div className="mono text-[10px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
                      Leave any as <span style={{ color: 'var(--text-dim)' }}>— none —</span> if the file doesn't have it. All stay editable after import — the two deadwood channels are always created so you can label them in the editor regardless.
                    </div>
                  </>)}
                </div>
              )}
              <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
                Converting to an out-of-core LOD octree. X / Y / Z, intensity, classification and return number come straight from the LAS geometry.
              </div>
              {/* Naming what is read does not tell anyone what is lost.
                  A colourised MLS delivery arriving grey, discovered
                  after the import, is the case this exists for. */}
              {dropped.length > 0 && (
                <div
                  className="mono text-[10px] mt-1.5 px-1.5 py-1 rounded-sm"
                  style={{ color: '#e0b84a', background: 'rgba(224,184,74,0.08)', lineHeight: 1.5 }}
                >
                  This file's point format ({pointFormat}) also carries {dropped.join(', ')}.
                  PointCloudLabeler's octree does not store {dropped.length > 1 ? 'these' : 'this'}, so
                  {dropped.length > 1 ? ' they' : ' it'} will not be imported and will not
                  come back on export. The source file is untouched.
                </div>
              )}
            </Field>
          )}

          {scannerOnly && (
            <Field label="Deadwood labelling" optional>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <Checkbox checked={includeDeadwoodCols} onChange={setIncludeDeadwoodCols} />
                <span className="mono text-[11.5px]" style={{ color: 'var(--text)' }}>
                  Create standing &amp; laying deadwood columns
                </span>
              </label>
              <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
                Adds two integer-id columns (8 bytes/point) so you can label
                deadwood in the editor. Turn off on big clouds you don't plan
                to label deadwood on — you can <b>add the columns later</b> from
                the Segment panel if you change your mind.
              </div>
            </Field>
          )}

          {scannerOnly && (
            <Field label="Extra columns" optional>
              <div className="mono text-[10px] mb-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
                Extra LAS columns carried into the octree as numeric values — e.g. species, amplitude, reflectance, pulse width. All are kept by default; untick any you don't need. Each adds 4 bytes per point and appears in the Display panel's <b>Colour by</b> menu under its own name.
                {isLas && (
                  <> <b>point_source_id</b> is the scan position (or flight line) each point came from — the Point QC tool's wind filter needs it, and nothing else in the octree records it.</>
                )}
              </div>
              {extraCarryOptions.length === 0 ? (
                <div className="mono text-[10.5px] px-2 py-1.5 rounded-md" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.18)', color: 'var(--text-mute)' }}>
                  No extra columns in this file.
                </div>
              ) : (
                <div className="rounded-md p-2 flex flex-col gap-1" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.18)' }}>
                  {/* Bulk toggle helps when a file carries many extras. */}
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
                      {effectiveExtras.length} of {extraCarryOptions.length} selected
                    </span>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        className="mono text-[10px] px-1.5 py-0.5 rounded-sm"
                        style={{ color: 'var(--text-dim)', border: '1px solid var(--line)' }}
                        onClick={() => {
                          const all: Record<string, boolean> = {};
                          for (const c of extraCarryOptions) all[c] = true;
                          setIncludeExtras(all);
                        }}
                      >all</button>
                      <button
                        type="button"
                        className="mono text-[10px] px-1.5 py-0.5 rounded-sm"
                        style={{ color: 'var(--text-dim)', border: '1px solid var(--line)' }}
                        onClick={() => setIncludeExtras({})}
                      >none</button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1 max-h-[180px] overflow-y-auto scroll-thin">
                    {extraCarryOptions.map(c => {
                      const claimed = claimedAsRole.has(c);
                      const on = !!includeExtras[c] && !claimed;
                      return (
                        <label
                          key={c}
                          className="flex items-center gap-1.5 mono text-[10.5px] cursor-pointer px-1.5 py-1 rounded-sm"
                          style={{
                            opacity: claimed ? 0.45 : 1,
                            cursor: claimed ? 'not-allowed' : 'pointer',
                            background: on ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'transparent',
                          }}
                          title={claimed ? `'${c}' is already imported as a role column above` : `Include '${c}' as a numeric extra in the octree`}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={claimed}
                            onChange={() => setIncludeExtras(m => ({ ...m, [c]: !m[c] }))}
                          />
                          <span className="truncate" style={{ color: on ? 'var(--text)' : 'var(--text-dim)' }}>{c}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </Field>
          )}

          {!scannerOnly && (<>
            <Field label="Vertical axis">
              <div className="grid grid-cols-2 gap-1.5">
                {(['Z', 'H'] as const).map(ax => {
                  const active = verticalAxis === ax;
                  const label = ax === 'Z' ? 'Z — absolute (ASL)' : 'H — above ground';
                  const sub = ax === 'Z'
                    ? 'Stay at elevation above sea level.'
                    : 'Re-base to height above ground.';
                  return (
                    <button
                      key={ax}
                      onClick={() => setVerticalAxis(ax)}
                      className="rounded-md text-left px-3 py-2 transition-all"
                      style={{
                        border: `1px solid ${active ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : 'var(--line)'}`,
                        background: active ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'transparent',
                      }}
                    >
                      <div className="text-[12px]" style={{ color: active ? 'var(--text)' : 'var(--text-dim)' }}>{label}</div>
                      <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{sub}</div>
                    </button>
                  );
                })}
              </div>
              <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)' }}>
                {verticalAxis === 'H'
                  ? (mapping.h
                    ? 'Using the mapped H column as the vertical.'
                    : 'No H column — height above ground is computed at import from classification if present, else the PMF ground classifier.')
                  : 'Using the absolute elevation as the vertical.'}
              </div>
            </Field>

            <Field label="Column mapping">
              <div className="rounded-md p-2.5 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.18)' }}>
                {isLas && (
                  <div className="mono text-[10px] pb-1" style={{ color: 'var(--text-mute)' }}>
                    X / Y / Z come from the LAS geometry and aren't remappable.
                  </div>
                )}
                {roles.map(r => {
                  const value = mapping[r.role] ?? '';
                  const isDup = xyDup && (r.role === 'x' || r.role === 'y')
                    && value !== '' && mapping.x === mapping.y;
                  const missing = (r.required && !value)
                    || (r.role === 'z' && axisZNoSource);
                  return (
                    <div key={r.role} className="flex items-center gap-2">
                      <span className="mono text-[11px]" style={{ width: 116, color: 'var(--text)' }}>
                        {r.label}{r.required && <span style={{ color: 'var(--danger)' }}> *</span>}
                      </span>
                      <select
                        value={value}
                        onChange={e => setRole(r.role, e.target.value)}
                        className="flex-1 min-w-0 px-2 py-1.5 mono text-[11.5px] rounded-md outline-none"
                        style={{
                          background: 'rgba(0,0,0,0.3)',
                          border: `1px solid ${missing || isDup ? 'var(--danger, #e0506b)' : 'var(--line)'}`,
                          color: value ? 'var(--text)' : 'var(--text-mute)',
                        }}
                        onFocus={focusOn}
                        onBlur={focusOff}
                        title={r.hint}
                      >
                        {!r.required && <option value="">— none —</option>}
                        {columns.map(c => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
              <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
                Pick the source column for each role; leave <span style={{ color: 'var(--text-dim)' }}>— none —</span> if the file doesn't have it. Unmapped columns are kept as extras under their original names.
              </div>
              {xyDup && (
                <div className="mono text-[10.5px] mt-1.5 px-2 py-1.5 rounded-md" style={{ color: 'var(--danger, #e0506b)', background: 'rgba(224,80,107,0.10)', border: '1px solid color-mix(in oklch, var(--danger, #e0506b) 50%, transparent)' }}>
                  X and Y must be different columns.
                </div>
              )}
              {axisZNoSource && (
                <div className="mono text-[10.5px] mt-1.5 px-2 py-1.5 rounded-md" style={{ color: 'var(--danger, #e0506b)', background: 'rgba(224,80,107,0.10)', border: '1px solid color-mix(in oklch, var(--danger, #e0506b) 50%, transparent)' }}>
                  Z axis selected but no absolute-elevation column mapped — map Z, or switch the axis to H.
                </div>
              )}
            </Field>
          </>)}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3.5" style={{ borderTop: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
            <span className="kbd">⌘</span><span className="kbd">↵</span> import · <span className="kbd">Esc</span> cancel
          </span>
          <div className="flex gap-1.5">
            <button className="btn !px-3" onClick={onCancel}>Cancel</button>
            <button
              className="btn btn-primary !px-3"
              onClick={confirm}
              disabled={!canConfirm}
              title={canConfirm ? 'Import with these settings' : 'Assign X, Y and a vertical (Z or H) first'}
            >Import</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.3)',
  border: '1px solid var(--line)',
  color: 'var(--text)',
};
const focusOn = (e: React.FocusEvent<HTMLElement>) => {
  e.currentTarget.style.borderColor = 'color-mix(in oklch, var(--accent) 55%, transparent)';
};
const focusOff = (e: React.FocusEvent<HTMLElement>) => {
  e.currentTarget.style.borderColor = 'var(--line)';
};

function Field({ label, optional, children }: { label: string; optional?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="chip" style={{ margin: 0 }}>{label}</span>
        {optional && <span className="mono text-[9px]" style={{ color: 'var(--text-mute)' }}>optional</span>}
      </div>
      {children}
    </div>
  );
}

function ColumnPick({ label, hint, value, options, onChange }: {
  label: string; hint: string;
  value: string; options: string[]; onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="mono text-[11px]" style={{ width: 112, color: 'var(--text)' }}>{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="flex-1 min-w-0 px-2 py-1.5 mono text-[11.5px] rounded-md outline-none"
        style={{
          background: 'rgba(0,0,0,0.3)',
          border: '1px solid var(--line)',
          color: value ? 'var(--text)' : 'var(--text-mute)',
        }}
        onFocus={focusOn}
        onBlur={focusOff}
        title={hint}
      >
        <option value="">— none —</option>
        {options.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
    </div>
  );
}

function Checkbox({ checked, onChange }: { checked: boolean; onChange: (b: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="rounded-sm flex items-center justify-center transition-all shrink-0"
      style={{
        width: 14, height: 14,
        background: checked ? 'var(--accent)' : 'rgba(0,0,0,0.3)',
        border: `1px solid ${checked ? 'var(--accent)' : 'var(--line-strong)'}`,
      }}
      aria-pressed={checked}
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="#06140d" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5L6.5 12L13 4" />
        </svg>
      )}
    </button>
  );
}

function ImportIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}
