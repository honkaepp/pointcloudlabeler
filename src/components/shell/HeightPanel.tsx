// The Height panel: click two points in the cloud (a tree's
// root and its top), read the height between them, the straight and the
// horizontal distance, and see a height scale standing on the lower point,
// ticked every few metres with rings as helper lines (three/HeightOverlay.tsx).
// The arithmetic and the state are in heightStore.ts.

import { useCallback, useEffect, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import { Btn, Check, Labeled, LinkBtn, Note, Section } from './panelUi';
import { saveCsvFile } from '../../io/saveDownload';
import {
  HEIGHT_COLORS, STEPS, heightCsv, heightDataset, heightReading, keepReading, pickBoth, placePoint, ringRadius, scaleStep, scaleTicks,
  setHeightState, tickLabel, useHeightStore, type HeightReading, type Vec3,
} from './heightStore';

export default function HeightPanel() {
  const s = useHeightStore();
  const { octree, setWorldPicker } = useOctreeShell();
  const dir = octree?.dir ?? null;
  useEffect(() => { heightDataset(dir); }, [dir]);
  useEffect(() => {
    setHeightState({ open: true });
    return () => setHeightState({ open: false, picking: null });
  }, []);

  // While picking, each click in the view sets the end asked for; the
  // picker is state, so it goes in as an updater.
  const pick = useCallback((hit: [number, number, number]) => placePoint(hit as Vec3), []);
  useEffect(() => {
    setWorldPicker(s.picking ? () => pick : null);
    return () => setWorldPicker(null);
  }, [s.picking, pick, setWorldPicker]);
  useEffect(() => {
    if (!s.picking) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHeightState({ picking: null }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.picking]);

  const r = s.a && s.b ? heightReading(s.a, s.b) : null;
  const [note, setNote] = useState('');
  const asking = s.picking === 'a' ? (s.b ? 'the first point again' : 'the first point (the root, say)')
    : s.picking === 'b' ? (s.a && !s.b ? 'the second point (the top)' : 'the second point again') : null;

  return (
    <div className="flex flex-col gap-2 p-1" style={{ minWidth: 0 }}>
      {!dir && <Note>Open a dataset first.</Note>}

      <Section title="Points" sub={asking ? `click ${asking} in the view` : r ? 'two points' : s.a || s.b ? 'one point' : 'none yet'}>
        <div className="flex gap-1.5 flex-wrap items-center">
          <Btn primary={!s.picking} disabled={!dir} onClick={() => (s.picking ? setHeightState({ picking: null }) : pickBoth())}
            title="Click two points in the view: the root and the top of a tree, a branch and the ground. The view cannot be turned while picking; Esc stops.">
            {s.picking ? 'Stop picking' : r ? 'Pick two new points' : 'Pick two points'}
          </Btn>
          <Btn disabled={!dir || !s.a} onClick={() => setHeightState({ picking: 'a' })} title="Click the first point again, keep the second">First again</Btn>
          <Btn disabled={!dir || !s.b} onClick={() => setHeightState({ picking: 'b' })} title="Click the second point again, keep the first">Second again</Btn>
          <Btn disabled={!s.a && !s.b} onClick={() => setHeightState({ a: null, b: null, picking: null })}>Clear</Btn>
        </div>
        {r ? <Readout r={r} step={scaleStep(r.height, s.step)} /> : (
          <Note>
            The scale stands on the lower of the two points, whichever is clicked first, and reaches the next full step above the higher
            one: a 27.4 m tree reads on 0–30 m with lines every 5 m.
          </Note>
        )}
      </Section>

      <Section title="Scale" sub={r ? `0–${tickLabel(scaleTicks(r.height, scaleStep(r.height, s.step)).slice(-1)[0], scaleStep(r.height, s.step))}` : 'ticks and helper rings'}>
        <div className="flex gap-1.5 flex-wrap items-end">
          <Labeled label="Step" title="The distance between the scale's lines. Auto: at most eight steps to the top.">
            <select value={String(s.step)} onChange={(e) => setHeightState({ step: Number(e.target.value) })}
              className="mono text-[10.5px] rounded-md px-1.5 py-1"
              style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
              <option value="0">Auto{r ? ` (${scaleStep(r.height)} m)` : ''}</option>
              {STEPS.filter((v) => v >= 0.5 && v <= 20).map((v) => <option key={v} value={String(v)}>{v} m</option>)}
            </select>
          </Labeled>
          <Labeled label={`Ring radius${s.radius > 0 ? '' : r ? ` · auto ${ringRadius(scaleTicks(r.height, scaleStep(r.height, s.step)).slice(-1)[0]).toFixed(1)} m` : ' · auto'}`}
            title="The rings drawn around the scale at each line. 0 = auto, a twentieth of the scale.">
            <div className="flex items-center gap-1.5">
              <input type="range" min={0} max={5} step={0.1} value={s.radius} onChange={(e) => setHeightState({ radius: Number(e.target.value) })} />
              <span className="mono text-[10px]" style={{ color: 'var(--text)', minWidth: 36 }}>{s.radius > 0 ? `${s.radius.toFixed(1)} m` : 'auto'}</span>
            </div>
          </Labeled>
        </div>
        <div className="flex gap-3 flex-wrap">
          <Check checked={s.rings} onChange={(v) => setHeightState({ rings: v })} title="Rings around the scale at each line: helper lines that read from any side">Helper rings</Check>
          <Check checked={s.labels} onChange={(v) => setHeightState({ labels: v })}>Labels</Check>
        </div>
      </Section>

      <Section title="Kept" sub={s.kept.length ? `${s.kept.length} reading${s.kept.length === 1 ? '' : 's'}` : 'readings to save as CSV'}>
        <div className="flex gap-1.5 items-end">
          <label className="flex flex-col gap-0.5 flex-1 min-w-0">
            <span className="mono" style={{ fontSize: 9, color: 'var(--text-mute)' }}>Note</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="tree 12, crown base…"
              className="mono text-[11px] py-1 px-1.5 rounded-md outline-none w-full"
              style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }} />
          </label>
          <Btn disabled={!r} onClick={() => { keepReading(note.trim()); setNote(''); }}>Keep</Btn>
          <Btn disabled={s.kept.length === 0} onClick={() => void saveCsvFile(heightCsv(s.kept), 'heights.csv')}>CSV</Btn>
        </div>
        {s.kept.length > 0 && (
          <div className="flex flex-col max-h-[220px] overflow-y-auto scroll-thin">
            {s.kept.map((k, i) => (
              <div key={k.id} className="flex items-center gap-2 mono text-[10.5px] py-0.5" style={{ borderBottom: '1px solid var(--line)' }}>
                <span style={{ color: 'var(--text-mute)', minWidth: 18 }}>{s.kept.length - i}</span>
                <span style={{ color: HEIGHT_COLORS.top, minWidth: 64 }}>{k.height.toFixed(2)} m</span>
                <span style={{ color: 'var(--text-dim)' }}>{k.distance.toFixed(2)} m · ↔ {k.horizontal.toFixed(2)}</span>
                <span className="flex-1 truncate" style={{ color: 'var(--text-mute)' }} title={k.note}>{k.note}</span>
                <LinkBtn onClick={() => setHeightState((st) => ({ kept: st.kept.filter((x) => x.id !== k.id) }))}>✕</LinkBtn>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

/** The numbers, and the scale drawn small beside them. */
function Readout({ r, step }: { r: HeightReading; step: number }) {
  return (
    <div className="flex gap-3 items-stretch">
      <div className="flex flex-col gap-0.5 flex-1">
        <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: HEIGHT_COLORS.top, lineHeight: 1.2 }}>{r.height.toFixed(2)} m</div>
        <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>height between the points</div>
        <Row label="Straight line" value={`${r.distance.toFixed(2)} m`} />
        <Row label="Horizontal" value={`${r.horizontal.toFixed(2)} m`} />
        <Row label="Angle from level" value={`${r.slopeDeg.toFixed(1)}°`} />
        <Row label="Lower z" value={r.low[2].toFixed(2)} />
        <Row label="Higher z" value={r.high[2].toFixed(2)} />
      </div>
      <ScaleBar height={r.height} step={step} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between mono text-[10.5px]">
      <span style={{ color: 'var(--text-dim)' }}>{label}</span>
      <span style={{ color: 'var(--text)' }}>{value}</span>
    </div>
  );
}

/** The scale as the view draws it: lines every step, the top marked. */
export function ScaleBar({ height, step }: { height: number; step: number }) {
  const ticks = scaleTicks(height, step);
  const top = ticks[ticks.length - 1] || 1;
  const H = 150, pad = 8, x = 44;
  const y = (v: number) => pad + (1 - v / top) * (H - 2 * pad);
  const minor = step / 5;
  const minors: number[] = [];
  for (let k = 1; k * minor < top - 1e-9 && minors.length < 200; k++) if (k % 5 !== 0) minors.push(k * minor);
  return (
    <svg width={96} height={H} aria-label="height scale" style={{ flexShrink: 0 }}>
      <line x1={x} y1={y(0)} x2={x} y2={y(top)} stroke={HEIGHT_COLORS.scale} strokeWidth={2} />
      {minors.map((v) => <line key={`m${v}`} x1={x - 3} x2={x + 3} y1={y(v)} y2={y(v)} stroke={HEIGHT_COLORS.minor} />)}
      {ticks.map((v) => (
        <g key={v}>
          <line x1={x - 7} x2={x + 7} y1={y(v)} y2={y(v)} stroke={HEIGHT_COLORS.tick} strokeWidth={1.5} />
          <text x={x - 10} y={y(v) + 3} textAnchor="end" fontSize={9} fill={HEIGHT_COLORS.tick} className="mono">{tickLabel(v, step)}</text>
        </g>
      ))}
      <line x1={x - 2} x2={x + 22} y1={y(height)} y2={y(height)} stroke={HEIGHT_COLORS.top} strokeWidth={2} />
      <circle cx={x} cy={y(height)} r={3} fill={HEIGHT_COLORS.top} />
      <circle cx={x} cy={y(0)} r={3} fill={HEIGHT_COLORS.point} />
    </svg>
  );
}
