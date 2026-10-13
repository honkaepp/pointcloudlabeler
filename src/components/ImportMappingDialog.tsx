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
import { standardLasFields, unsupportedLasFields } from '../io/parseLasStream';
import {
  POINT_FILE_KIND_LABELS, POINT_FILE_ROLES, type PointFileKind, type PointFileMapping, type PointFileProbe,
} from '../io/pointFile';

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
    /** For the pointFile route only — which column of the text, PLY or
     *  E57 file fills which field, and which others ride along. */
    fileMapping?: PointFileMapping,
  ) => void;
  onCancel: () => void;
  /** 'full' (default) shows scanner type + vertical axis + column
   *  mapping for the in-memory parser. 'scannerOnly' is used by the
   *  octree route, where X/Y/Z/intensity/class/return are read straight
   *  from the LAS geometry by the Rust converter — only the scanner
   *  type + the pre-segmented extras are real user choices. 'pointFile'
   *  is a text, PLY or E57 file: every field of the record is a column
   *  pick, started from the probe's guess. */
  mode?: 'full' | 'scannerOnly' | 'pointFile';
  /** The pointFile route's file: what the Rust probe found in it. */
  pointFile?: { kind: PointFileKind; probe: PointFileProbe };
}

// Standard LAS fields the octree stores natively — kept as a safety net
// so a file that happens to declare an Extra-Bytes dimension named "x" /
// "intensity" / etc. doesn't get offered as a numeric extra alongside the
// geometry the converter already reads. `detectLasColumns` no longer
// injects these names (the dropdowns show only the file's real EB dims),
// so this filter is normally a no-op.
const STANDARD_FIELDS = new Set(['x', 'y', 'z', 'tree_id', 'intensity', 'classification', 'return_number']);

/** The standard LAS fields the base record does not keep — GPS time,
 *  the colour, the scan position, the scan angle, the flags — are
 *  offered as columns for every LAS file whose point format carries
 *  them (see standardLasFields), under their reserved names, and the
 *  importer reads them from the record itself (octree.rs's StdField).
 *  GPS time is stored as an f64 column, so a pulse's time comes back
 *  exactly; the rest fit an f32. The import dialog used to say these
 *  were dropped; now they are columns like any other, colourable and
 *  exported back into the record. */
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

export default function ImportMappingDialog({ fileName, isLas, columns, suggested, onConfirm, onCancel, mode = 'full', pointFormat = null, pointFile }: Props) {
  // Standard LAS fields this file has that the octree cannot carry.
  const dropped = unsupportedLasFields(pointFormat);

  const scannerOnly = mode === 'scannerOnly';
  const isPointFile = mode === 'pointFile' && !!pointFile;
  // The text / PLY / E57 mapping, from the probe's guess. Every
  // optional field present (null) so the selects are controlled.
  const [fileMapping, setFileMapping] = useState<PointFileMapping>(() => {
    const m: PointFileMapping = { x: null, y: null, z: null, extras: [], ...(pointFile?.probe.suggested ?? {}) };
    for (const r of POINT_FILE_ROLES) if (m[r.key] === undefined) m[r.key] = null;
    return m;
  });
  const setFileRole = (key: keyof PointFileMapping, value: string) =>
    setFileMapping(m => ({ ...m, [key]: value || null }));
  const toggleFileExtra = (c: string) =>
    setFileMapping(m => ({ ...m, extras: m.extras.includes(c) ? m.extras.filter(e => e !== c) : [...m.extras, c] }));
  const fileXyzOk = !!fileMapping.x && !!fileMapping.y && !!fileMapping.z
    && new Set([fileMapping.x, fileMapping.y, fileMapping.z]).size === 3;
  // Columns a file role claims — shown dimmed in the extras list, still
  // tickable: the intensity scaled into the record AND exact beside it.
  const fileClaimed = useMemo(() => {
    const s = new Set<string>();
    for (const r of POINT_FILE_ROLES) { const v = fileMapping[r.key]; if (v) s.add(v); }
    return s;
  }, [fileMapping]);
  const fileExtraOptions = useMemo(
    () => (pointFile ? pointFile.probe.columns.filter(c => c !== fileMapping.x && c !== fileMapping.y && c !== fileMapping.z) : []),
    [pointFile, fileMapping.x, fileMapping.y, fileMapping.z],
  );
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

  // The standard fields this file's point format carries, offered first
  // and only for LAS: a text file has no such field.
  const standardFields = useMemo(() => (isLas ? standardLasFields(pointFormat) : []), [isLas, pointFormat]);
  const standardNames = useMemo(() => new Set(standardFields.map(f => f.name)), [standardFields]);
  // Columns that are real Extra-Bytes dimensions worth carrying as numeric
  // extras — i.e. everything EXCEPT the fields the octree already stores
  // natively (X/Y/Z, intensity, classification, return, and tree_id
  // which has its own slot) and the standard fields offered above. So
  // species / reflectance / amplitude / pulse_width / … surface here,
  // ready to colour by.
  const extraCarryOptions = useMemo(() => {
    const dims = extraColumnOptions.filter(
      c => !STANDARD_FIELDS.has(c.toLowerCase()) && !isDeadwoodExtra(c) && c.toLowerCase() !== PSID_COLUMN && !standardNames.has(c.toLowerCase()),
    );
    return [...standardFields.map(f => f.name), ...dims];
  }, [extraColumnOptions, standardFields, standardNames]);
  // Default: carry every detected Extra Bytes column so a richly-
  // attributed cloud arrives with all its columns visible in the Display
  // panel — the user unticks any they don't want rather than hunting
  // for each — and the standard fields that are data (time, colour, the
  // scan position); the flags and the scan angle start unticked.
  useEffect(() => {
    setIncludeExtras(() => {
      const m: Record<string, boolean> = {};
      for (const c of extraCarryOptions) m[c] = true;
      for (const f of standardFields) m[f.name] = f.on;
      return m;
    });
  }, [extraCarryOptions, standardFields]);
  const standardLabel = (name: string) => standardFields.find(f => f.name === name)?.label;

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
  // converter reads every geometric field itself. A point file needs
  // three distinct position columns.
  const canConfirm = isPointFile
    ? fileXyzOk
    : scannerOnly || (!xyMissing && !xyDup && !vertMissing && !axisZNoSource);

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

  const confirm = () => isPointFile
    ? onConfirm(scannerType, mapping, 'Z', undefined, undefined, includeDeadwoodCols, {
        ...fileMapping,
        extras: fileMapping.extras.filter(c => c !== fileMapping.x && c !== fileMapping.y && c !== fileMapping.z),
      })
    : onConfirm(
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
  }, [scannerType, mapping, verticalAxis, canConfirm, scannerOnly, preSegmented, treeIdExtra, semanticExtra, standingDeadwoodExtra, layingDeadwoodExtra, includeExtras, includeDeadwoodCols, fileMapping, isPointFile]);

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
              {fileName} · {isLas ? 'LAS / LAZ' : pointFile ? POINT_FILE_KIND_LABELS[pointFile.kind] : 'TXT / XYZ / CSV'} · {columns.length} source column{columns.length === 1 ? '' : 's'}{pointFile ? ` · ~${pointFile.probe.approxPointCount.toLocaleString()} points` : ''}
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
                Converting to an out-of-core LOD octree. X / Y / Z, intensity, classification, return number and number of returns come straight from the LAS geometry; every other field of the record is a column above, ticked or not.
              </div>
              {/* Naming what is read does not tell anyone what is lost.
                  Only the waveform packets are left out now. */}
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

          {isPointFile && pointFile && (<>
            <Field label="Position">
              <div className="rounded-md p-2.5 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.18)' }}>
                {(['x', 'y', 'z'] as const).map(k => (
                  <ColumnPick
                    key={k}
                    label={k.toUpperCase()}
                    hint={`The ${k.toUpperCase()} coordinate, in metres.`}
                    value={fileMapping[k] ?? ''}
                    options={pointFile.probe.columns}
                    onChange={v => setFileRole(k, v)}
                    required
                  />
                ))}
              </div>
              {!fileXyzOk && (
                <div className="mono text-[10.5px] mt-1.5 px-2 py-1.5 rounded-md" style={{ color: 'var(--danger, #e0506b)', background: 'rgba(224,80,107,0.10)', border: '1px solid color-mix(in oklch, var(--danger, #e0506b) 50%, transparent)' }}>
                  X, Y and Z must be three different columns.
                </div>
              )}
              <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
                {pointFile.kind === 'text'
                  ? `${pointFile.probe.hasHeader ? 'Column names from the header line' : 'No header line — columns are numbered'}, ${pointFile.probe.delimiter ?? 'space'}-separated. Coordinates keep the file's own decimals (to six).`
                  : pointFile.kind === 'ply'
                    ? 'The scalar properties of the vertex element, read as doubles whatever their type.'
                    : `${pointFile.probe.scans.length} scan position${pointFile.probe.scans.length === 1 ? '' : 's'} (${pointFile.probe.scans.join(', ')}) — each scan's pose applied, all in one dataset; the "scan" column is the scan's index, 1 upwards, the point source id by default.`}
              </div>
            </Field>

            <Field label="Fields" optional>
              <div className="rounded-md p-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.18)' }}>
                {POINT_FILE_ROLES.map(r => (
                  <ColumnPick
                    key={r.key}
                    label={r.label}
                    hint={r.hint}
                    value={fileMapping[r.key] ?? ''}
                    options={pointFile.probe.columns}
                    onChange={v => setFileRole(r.key, v)}
                  />
                ))}
              </div>
              <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
                Matched by column name; change any that is wrong, leave <span style={{ color: 'var(--text-dim)' }}>— none —</span> for what the file does not have. Intensity and colour are scaled into the record's 16 bits by the file's own range; GPS time is kept exact. A cloud with no tree_id column imports unsegmented.
              </div>
            </Field>

            <Field label="Extra columns" optional>
              <div className="mono text-[10px] mb-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
                Every ticked column is carried into the dataset as a 64-bit value under its own name — exact — to colour by, filter on and export again. A column used as a field above can be ticked too (the amplitude scaled as intensity, and exact beside it). A reflectance column stays here, where Point QC finds it by name.
              </div>
              {fileExtraOptions.length === 0 ? (
                <div className="mono text-[10.5px] px-2 py-1.5 rounded-md" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.18)', color: 'var(--text-mute)' }}>
                  No columns besides the position.
                </div>
              ) : (
                <div className="rounded-md p-2 flex flex-col gap-1" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.18)' }}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
                      {fileMapping.extras.filter(c => fileExtraOptions.includes(c)).length} of {fileExtraOptions.length} selected
                    </span>
                    <div className="flex gap-1">
                      <button type="button" className="mono text-[10px] px-1.5 py-0.5 rounded-sm" style={{ color: 'var(--text-dim)', border: '1px solid var(--line)' }}
                        onClick={() => setFileMapping(m => ({ ...m, extras: [...fileExtraOptions] }))}>all</button>
                      <button type="button" className="mono text-[10px] px-1.5 py-0.5 rounded-sm" style={{ color: 'var(--text-dim)', border: '1px solid var(--line)' }}
                        onClick={() => setFileMapping(m => ({ ...m, extras: [] }))}>none</button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1 max-h-[180px] overflow-y-auto scroll-thin">
                    {fileExtraOptions.map(c => {
                      const on = fileMapping.extras.includes(c);
                      const claimed = fileClaimed.has(c);
                      return (
                        <label
                          key={c}
                          className="flex items-center gap-1.5 mono text-[10.5px] cursor-pointer px-1.5 py-1 rounded-sm"
                          style={{ opacity: claimed && !on ? 0.6 : 1, background: on ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'transparent' }}
                          title={claimed ? `'${c}' also fills a field above; ticked, it is kept exact as well` : `Carry '${c}' as a numeric column`}
                        >
                          <input type="checkbox" checked={on} onChange={() => toggleFileExtra(c)} />
                          <span className="truncate" style={{ color: on ? 'var(--text)' : 'var(--text-dim)' }}>{c}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </Field>

            {pointFile.probe.preview.length > 0 && (
              <Field label="First rows">
                <div className="rounded-md overflow-x-auto scroll-thin" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.18)', maxHeight: 160 }}>
                  <table className="mono text-[10px]" style={{ borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
                    <thead>
                      <tr>
                        {pointFile.probe.columns.map(c => (
                          <th key={c} className="px-2 py-1 text-left" style={{ color: 'var(--text-dim)', borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, background: 'var(--wash-1)' }}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pointFile.probe.preview.map((row, i) => (
                        <tr key={i}>
                          {row.map((v, j) => <td key={j} className="px-2 py-0.5" style={{ color: 'var(--text-mute)' }}>{v}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Field>
            )}
          </>)}

          {(scannerOnly || isPointFile) && (
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
                Columns carried into the octree as numeric values: the file's Extra Bytes — species, amplitude, reflectance, pulse width — and, for LAS, the standard fields of the record the base record does not keep: GPS time (8 bytes a point, exact), colour, near-infrared, the scan position, the scan angle, user data and the flags. Each appears in the Display panel's <b>Colour by</b> menu under its own name, filters, and is written back where it came from on export. Each costs 4 bytes a point (GPS time 8); untick what you don't need.
                {isLas && (
                  <> <b>point_source_id</b> is the scan position (or flight line) each point came from — the Point QC tool's wind filter needs it.</>
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
                          <span className="truncate" style={{ color: on ? 'var(--text)' : 'var(--text-dim)' }}>{c}{standardLabel(c) ? <span style={{ color: 'var(--text-mute)' }}> · {standardLabel(c)}</span> : null}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </Field>
          )}

          {mode === 'full' && (<>
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
              title={canConfirm ? 'Import with these settings' : isPointFile ? 'Pick three different columns for X, Y and Z first' : 'Assign X, Y and a vertical (Z or H) first'}
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

function ColumnPick({ label, hint, value, options, onChange, required }: {
  label: string; hint: string;
  value: string; options: string[]; onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="mono text-[11px]" style={{ width: 112, color: 'var(--text)' }}>{label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}</span>
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
        <option value="">{required ? '— pick —' : '— none —'}</option>
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
