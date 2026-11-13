// The pieces the Branches and Stems panels share, so a diameter is read,
// a length drafted and a saved reading listed the same way on a branch
// and on a stem: the section reader (the view looking along the part,
// the jaws' direction, moving the section, the readings), the length
// draft with its save buttons, and the list of saved measurements.

import type { ReactNode } from 'react';
import { minWidthAngle, readSection, type Section, type SectionReading, type Vec3 } from '../../metrics/branchMeasure';
import {
  DIAMETER_ROLE_LABEL, type BranchRecord, type DiameterMeasurement, type DiameterRole, type LengthMeasurement,
} from '../../persistence/branchStore';
import BranchSectionView from './BranchSectionView';
import { JAW1_COLOR, JAW2_COLOR } from './branchOverlay';

export const nowIso = () => new Date().toISOString();
export const mm = (m: number, dp = 1) => `${(m * 1000).toFixed(dp)} mm`;

export const ERR_STYLE = { color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)' };
export const BOX_STYLE = { border: '1px solid var(--line)', background: 'var(--wash-1)' };
export const ACTIVE_BTN = { color: 'var(--accent)', borderColor: 'var(--accent)' };

export interface SectionRead {
  section: Section;
  /** Direction of the first reading (radians from the section's u). */
  theta: number;
  /** Jaws moved by hand, per reading: [lo, hi]. Null = closed on the
   *  points (trimmed). */
  manual: Array<[number, number] | null>;
  /** Stems: the height above ground the section was cut at. */
  heightAboveGround?: number | null;
  groundZ?: number | null;
}

export interface LengthDraft {
  method: LengthMeasurement['method'];
  nodes: Vec3[];
  length: number;
  /** Path only: cells the path could not reach (a gap in the scan). */
  unreached?: number;
}

export function useReading(read: SectionRead | null, mode: 'cross' | 'single', trim: number): SectionReading | null {
  // Cheap (a sort per reading over a few hundred points); recomputed per
  // render rather than memoised so a dragged jaw is never a frame behind.
  return read ? readSection(read.section.pts, read.theta, mode, trim, read.manual) : null;
}

/** A diameter measurement from what is on screen. */
export function diameterFrom(
  read: SectionRead, reading: SectionReading, role: DiameterRole, mode: 'cross' | 'single', trim: number, id: string,
): DiameterMeasurement {
  const s = read.section;
  return {
    id, role, mode,
    center: s.center, axis: s.axis, theta: read.theta,
    halfThickness: s.halfThickness, maxRadius: s.maxRadius, trim,
    d1: reading.widths[0], d2: reading.widths[1] ?? null, diameter: reading.diameter,
    manual: reading.manual,
    circleDiameter: reading.circle ? reading.circle.r * 2 : null,
    coverage: reading.coverage, pointCount: s.count,
    heightAboveGround: read.heightAboveGround ?? null,
    groundZ: read.groundZ ?? null,
    createdAt: nowIso(),
  };
}

export function Slider({ label, value, min, max, step, unit, onChange, disabled }: {
  label: string; value: number; min: number; max: number; step: number; unit: string;
  onChange: (v: number) => void; disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="mono text-[10px] w-[118px]" style={{ color: 'var(--text-dim)' }}>{label}</label>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))} className="flex-1" />
      <span className="mono text-[10px] w-[52px] text-right" style={{ color: 'var(--text)' }}>{value} {unit}</span>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: {
  value: T; options: Array<{ v: T; label: string; title?: string }>; onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
      {options.map(o => (
        <button key={o.v} title={o.title}
          className="mono text-[10px] px-2 py-0.5"
          style={{
            background: value === o.v ? 'color-mix(in oklch, var(--accent) 22%, transparent)' : 'transparent',
            color: value === o.v ? 'var(--accent)' : 'var(--text-dim)',
          }}
          onClick={() => onChange(o.v)}
        >{o.label}</button>
      ))}
    </div>
  );
}

export function ModeSeg({ mode, setMode }: { mode: 'cross' | 'single'; setMode: (m: 'cross' | 'single') => void }) {
  return (
    <Seg value={mode} onChange={setMode} options={[
      { v: 'cross', label: 'cross', title: 'Two readings at right angles and their mean' },
      { v: 'single', label: 'single', title: 'One reading' },
    ]} />
  );
}

/** The section on screen: the view with draggable jaws, the jaws'
 *  direction, moving the section along the part, and the readings.
 *  `children` are the save buttons. */
export function SectionReader({ read, setRead, reading, mode, trim, onNudge, along, children }: {
  read: SectionRead;
  setRead: (r: SectionRead) => void;
  reading: SectionReading;
  mode: 'cross' | 'single';
  trim: number;
  onNudge: (mm: number) => void;
  /** "the branch" / "the stem". */
  along: string;
  children?: ReactNode;
}) {
  const deg = Math.round(((read.theta * 180) / Math.PI) % 180);
  const onJawDrag = (pair: number, which: 'lo' | 'hi', t: number) => {
    const cur = read.manual[pair] ?? [reading.jaws[pair].lo, reading.jaws[pair].hi];
    const next: [number, number] = which === 'lo' ? [Math.min(t, cur[1]), cur[1]] : [cur[0], Math.max(t, cur[0])];
    const manual = read.manual.slice();
    while (manual.length <= pair) manual.push(null);
    manual[pair] = next;
    setRead({ ...read, manual });
  };
  return (
    <div className="flex flex-col gap-1.5 items-center">
      <BranchSectionView pts={read.section.pts} jaws={reading.jaws} circle={reading.circle} onJawDrag={onJawDrag} />
      <div className="flex items-center gap-1.5 w-full">
        <label className="mono text-[10px] w-[60px]" style={{ color: 'var(--text-dim)' }}>Direction</label>
        <input type="range" min={0} max={179} step={1} className="flex-1" value={deg}
          onChange={(e) => setRead({ ...read, theta: (parseFloat(e.target.value) * Math.PI) / 180, manual: [null, null] })} />
        <span className="mono text-[10px] w-[34px] text-right">{deg}°</span>
        <button className="btn !h-5 !px-1.5 mono text-[9.5px]" title="Turn the jaws to where the section is narrowest"
          onClick={() => setRead({ ...read, theta: minWidthAngle(read.section.pts, trim), manual: [null, null] })}>narrowest</button>
      </div>
      <div className="flex items-center gap-1 w-full">
        <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Move along {along}</span>
        <span className="flex-1" />
        {[-10, -2, 2, 10].map(d => (
          <button key={d} className="btn !h-5 !px-1.5 mono text-[9.5px]" onClick={() => onNudge(d)}>{d > 0 ? `+${d}` : d} mm</button>
        ))}
        {reading.manual && (
          <button className="btn !h-5 !px-1.5 mono text-[9.5px]" title="Close the jaws on the points again"
            onClick={() => setRead({ ...read, manual: [null, null] })}>snap jaws</button>
        )}
      </div>
      <div className="mono text-[11px] w-full flex flex-wrap gap-x-3" style={{ color: 'var(--text)' }}>
        {read.heightAboveGround != null && <span style={{ color: 'var(--text-dim)' }}>at {read.heightAboveGround.toFixed(2)} m</span>}
        <span style={{ color: JAW1_COLOR }}>d1 {mm(reading.widths[0])}</span>
        {mode === 'cross' && <span style={{ color: JAW2_COLOR }}>d2 {mm(reading.widths[1])}</span>}
        <span style={{ color: 'var(--accent)' }}>Ø {mm(reading.diameter)}</span>
        {reading.manual && <span style={{ color: '#e6c068' }}>jaws set by hand</span>}
      </div>
      <div className="mono text-[9.5px] w-full" style={{ color: 'var(--text-mute)' }}>
        circle fit {reading.circle ? mm(reading.circle.r * 2) : '—'} · coverage {reading.coverage == null ? '—' : `${Math.round(reading.coverage * 100)} %`} · {read.section.count} section points
        {reading.coverage != null && reading.coverage < 0.5 && ' · seen from one side: a reading across the seen side is sound, the one along it is not'}
      </div>
      <div className="flex gap-1 w-full flex-wrap">{children}</div>
    </div>
  );
}

const METHOD_LABEL: Record<LengthMeasurement['method'], string> = {
  manual: 'Clicked', path: 'Along the points', chord: 'Straight', height: 'Height above ground',
};

/** A length on screen, with its save buttons. */
export function LengthDraftView({ draft, primaryLabel, onSave }: {
  draft: LengthDraft; primaryLabel: string; onSave: (primary: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="mono text-[11px]" style={{ color: 'var(--text)' }}>
        {METHOD_LABEL[draft.method]}: <span style={{ color: 'var(--accent)' }}>{draft.length.toFixed(3)} m</span>
        <span style={{ color: 'var(--text-mute)' }}> · {draft.nodes.length} point(s)</span>
        {draft.unreached ? <span style={{ color: '#e6c068' }}> · a gap in the scan left part of it out — the length may be short</span> : null}
      </div>
      <div className="flex gap-1">
        <button className="btn !h-6 mono text-[10.5px] flex-1 justify-center" disabled={draft.nodes.length < 2} onClick={() => onSave(true)}>{primaryLabel}</button>
        <button className="btn !h-6 mono text-[10.5px]" disabled={draft.nodes.length < 2} onClick={() => onSave(false)}>Save as other</button>
      </div>
    </div>
  );
}

/** The readings saved on a part. Diameters of a stem are listed by
 *  height, so the list reads as its taper. */
export function SavedMeasurements({ part, roles, onShowDiameter, onShowLength, onPromote, onRemove, lengthRoleLabel }: {
  part: BranchRecord;
  /** The roles a saved diameter can be given here, beyond 'other'. */
  roles: DiameterRole[];
  onShowDiameter: (d: DiameterMeasurement) => void;
  onShowLength: (l: LengthMeasurement) => void;
  onPromote: (id: string, role?: DiameterRole) => void;
  onRemove: (id: string) => void;
  lengthRoleLabel: string;
}) {
  if (part.diameters.length === 0 && part.lengths.length === 0) return null;
  const diameters = part.kind === 'stem'
    ? [...part.diameters].sort((a, b) => (a.heightAboveGround ?? 0) - (b.heightAboveGround ?? 0))
    : part.diameters;
  return (
    <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
      <div className="px-2 py-1 mono text-[10px]" style={{ color: 'var(--text-dim)', borderBottom: '1px solid var(--line)' }}>Saved on {part.name}</div>
      <div className="max-h-[220px] overflow-y-auto scroll-thin">
        {diameters.map(d => (
          <div key={d.id} className="flex items-center gap-1.5 px-2 py-1 mono text-[10px]" style={{ borderBottom: '1px solid var(--line)' }}>
            <span style={{ color: d.role !== 'other' ? 'var(--accent)' : 'var(--text-dim)', minWidth: 34 }}>{DIAMETER_ROLE_LABEL[d.role]}</span>
            {d.heightAboveGround != null && <span style={{ color: 'var(--text-dim)', minWidth: 46 }}>{d.heightAboveGround.toFixed(2)} m</span>}
            <span style={{ color: 'var(--text)' }}>{mm(d.diameter)}</span>
            <span style={{ color: 'var(--text-mute)' }}>{d.mode === 'cross' ? `${mm(d.d1)} × ${mm(d.d2 ?? 0)}` : 'single'}{d.manual ? ' · by hand' : ''}</span>
            <span className="flex-1" />
            <button className="btn !h-5 !px-1.5 mono text-[9.5px]" onClick={() => onShowDiameter(d)}>show</button>
            {roles.filter(r => r !== d.role).map(r => (
              <button key={r} className="btn !h-5 !px-1.5 mono text-[9.5px]" title={`Make this the ${DIAMETER_ROLE_LABEL[r]} reading`}
                onClick={() => onPromote(d.id, r)}>{DIAMETER_ROLE_LABEL[r].toLowerCase()}</button>
            ))}
            <button className="btn !h-5 !px-1.5 mono text-[9.5px]" onClick={() => onRemove(d.id)}>✕</button>
          </div>
        ))}
        {part.lengths.map(l => (
          <div key={l.id} className="flex items-center gap-1.5 px-2 py-1 mono text-[10px]" style={{ borderBottom: '1px solid var(--line)' }}>
            <span style={{ color: l.primary ? 'var(--accent)' : 'var(--text-dim)', minWidth: 34 }}>{l.primary ? lengthRoleLabel : 'L'}</span>
            <span style={{ color: 'var(--text)' }}>{l.length.toFixed(3)} m</span>
            <span style={{ color: 'var(--text-mute)' }}>{METHOD_LABEL[l.method].toLowerCase()}</span>
            <span className="flex-1" />
            <button className="btn !h-5 !px-1.5 mono text-[9.5px]" onClick={() => onShowLength(l)}>show</button>
            {!l.primary && <button className="btn !h-5 !px-1.5 mono text-[9.5px]" onClick={() => onPromote(l.id)}>make {lengthRoleLabel.toLowerCase()}</button>}
            <button className="btn !h-5 !px-1.5 mono text-[9.5px]" onClick={() => onRemove(l.id)}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}
