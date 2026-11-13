// Tree Review's "pull apart": draw chosen neighbouring trees a
// few metres aside from the isolated tree, so interleaved crowns open up
// for correcting. A display only (three/treeShift.ts): the points keep
// their real coordinates, every editing tool works on the moved picture and
// saves to the real points, and nothing measured or exported moves.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { TreeSummaryEntry } from '../../persistence/octreeReader';
import { treeIdColor } from '../../three/palette';
import { dragPicker, rayPlane, type PickPlane } from '../../three/planePick';
import {
  dragDelta, dragPlane, getTreeShift, moveBy, setTreeShift, shiftAway, shiftBearing, subscribeTreeShift,
  type ShiftEN,
} from '../../three/treeShift';

type V3 = [number, number, number];

/** Which way a tree moves when picked or when the distance changes. */
export type ShiftDirection = 'away' | 'N' | 'E' | 'S' | 'W';
const BEARINGS: Record<Exclude<ShiftDirection, 'away'>, number> = { N: 0, E: 90, S: 180, W: 270 };
const DIRECTION_TITLES: Record<ShiftDirection, string> = {
  away: 'Each moved tree goes straight away from the isolated tree (centre to centre)',
  N: 'Every moved tree goes north', E: 'Every moved tree goes east',
  S: 'Every moved tree goes south', W: 'Every moved tree goes west',
};
/** The longest move a drag may make, metres — a ray grazing the drag
 *  plane would otherwise throw a tree out of the plot. */
const DRAG_MAX_M = 50;

/** A tree's centre, east/north/up: its density centre, else its box's. */
export function treeCentre(t: TreeSummaryEntry): V3 {
  if (t.centroid) return [t.centroid[0], t.centroid[1], (t.bboxMin[2] + t.bboxMax[2]) * 0.5];
  return [(t.bboxMin[0] + t.bboxMax[0]) * 0.5, (t.bboxMin[1] + t.bboxMax[1]) * 0.5, (t.bboxMin[2] + t.bboxMax[2]) * 0.5];
}

/** The offset the rule gives tree `id`: `distance` metres in `direction`
 *  (away: from the anchor's centre through the tree's). */
export function ruleOffset(
  direction: ShiftDirection, distance: number, anchor: V3, tree: V3 | null,
): ShiftEN {
  if (direction === 'away') return shiftAway([anchor[0], anchor[1]], tree ? [tree[0], tree[1]] : [anchor[0] + 1, anchor[1]], distance);
  return shiftBearing(BEARINGS[direction], distance);
}

/** How an offset reads: "1.4 m E, 1.4 m N". */
export function describeOffset(o: ShiftEN): string {
  const part = (v: number, pos: string, neg: string) => (Math.abs(v) < 0.005 ? null : `${Math.abs(v).toFixed(2)} m ${v > 0 ? pos : neg}`);
  return [part(o[0], 'E', 'W'), part(o[1], 'N', 'S')].filter(Boolean).join(', ') || 'in place';
}

export default function TreeShiftSection({
  dir, anchor, candidates, trees, setWorldPicker,
}: {
  dir: string;
  /** The isolated tree. */
  anchor: TreeSummaryEntry;
  /** The neighbours on screen, nearest first. */
  candidates: { id: number; dist: number; count: number }[];
  trees: TreeSummaryEntry[] | null;
  setWorldPicker: (cb: ((hit: [number, number, number]) => void) | null) => void;
}) {
  const spec = useSyncExternalStore(subscribeTreeShift, getTreeShift);
  const anchorId = anchor.treeId;
  const offsets: ReadonlyMap<number, ShiftEN> = useMemo(
    () => (spec && spec.dir === dir && spec.anchor === anchorId ? spec.offsets : new Map()),
    [spec, dir, anchorId],
  );
  const [distance, setDistance] = useState(2);
  const [distanceText, setDistanceText] = useState('2');
  const [direction, setDirection] = useState<ShiftDirection>('away');
  const [dragOn, setDragOn] = useState(false);

  const byId = useMemo(() => new Map((trees ?? []).map((t) => [t.treeId, t])), [trees]);
  const anchorCentre = useMemo(() => treeCentre(anchor), [anchor]);
  const centreOf = useCallback((id: number): V3 | null => {
    const t = byId.get(id);
    return t ? treeCentre(t) : null;
  }, [byId]);

  const commit = useCallback((next: ReadonlyMap<number, ShiftEN>) => {
    setTreeShift(next.size > 0 ? { dir, anchor: anchorId, offsets: next } : null);
  }, [dir, anchorId]);

  // A shift made around another tree, or in another dataset, is not this
  // one's: drop it (the viewer would not draw it anyway). Leaving the
  // section — the panel closed, the neighbours hidden — puts every tree
  // back, so no tree stays drawn aside with nothing on screen to say so.
  useEffect(() => {
    const s = getTreeShift();
    if (s && (s.dir !== dir || s.anchor !== anchorId)) setTreeShift(null);
    setDragOn(false);
  }, [dir, anchorId]);
  useEffect(() => () => { setTreeShift(null); }, []);

  const moved = useMemo(() => { const ids = [...offsets.keys()]; return ids.sort((a, b) => a - b); }, [offsets]);
  // The chips: the neighbours on screen, and any moved tree no longer
  // among them (hidden or out of the margin), so it can be put back.
  const chips = useMemo(() => {
    const out = candidates.map((c) => c.id);
    for (const id of moved) if (!out.includes(id)) out.push(id);
    return out;
  }, [candidates, moved]);

  const toggle = (id: number) => {
    const next = new Map(offsets);
    if (next.has(id)) next.delete(id);
    else next.set(id, ruleOffset(direction, distance, anchorCentre, centreOf(id)));
    commit(next);
  };
  const moveAll = () => {
    const next = new Map(offsets);
    for (const c of candidates) if (!next.has(c.id)) next.set(c.id, ruleOffset(direction, distance, anchorCentre, centreOf(c.id)));
    commit(next);
  };
  /** Every moved tree again by the rule — a new distance or direction. */
  const reapply = (dirn: ShiftDirection, dist: number) => {
    if (offsets.size === 0) return;
    const next = new Map<number, ShiftEN>();
    for (const id of offsets.keys()) next.set(id, ruleOffset(dirn, dist, anchorCentre, centreOf(id)));
    commit(next);
  };
  const reset = () => { setDragOn(false); setTreeShift(null); };

  // ---- dragging in the view. The picker is made once per drag mode and
  // reads everything else through refs: a new picker mid-drag would end
  // the drag (the viewport re-arms on every picker change).
  const live = useRef({ offsets, commit, moved, centreOf, anchorCentre });
  live.current = { offsets, commit, moved, centreOf, anchorCentre };
  useEffect(() => {
    if (!dragOn) return;
    let grab: { plane: PickPlane; start: V3; base: ReadonlyMap<number, ShiftEN> } | null = null;
    const picker = dragPicker({
      start: (ray) => {
        const l = live.current;
        if (l.moved.length === 0) return false;
        // Through the moved trees' drawn centre, at the isolated tree's
        // mid height: in a side view the trees follow the pointer along
        // the screen, from above they follow it over the ground.
        let x = 0, y = 0;
        for (const id of l.moved) {
          const c = l.centreOf(id) ?? l.anchorCentre;
          const o = l.offsets.get(id) ?? [0, 0];
          x += c[0] + o[0]; y += c[1] + o[1];
        }
        const at: V3 = [x / l.moved.length, y / l.moved.length, l.anchorCentre[2]];
        const plane = dragPlane(ray, at);
        const hit = rayPlane(ray.a, ray.b, plane);
        if (!hit) return false;
        grab = { plane, start: hit, base: new Map(l.offsets) };
        return true;
      },
      move: (ray) => {
        if (!grab) return;
        const hit = rayPlane(ray.a, ray.b, grab.plane);
        if (!hit) return;
        let d = dragDelta(grab.start, hit);
        const len = Math.hypot(d[0], d[1]);
        if (len > DRAG_MAX_M) d = [(d[0] / len) * DRAG_MAX_M, (d[1] / len) * DRAG_MAX_M];
        live.current.commit(moveBy(grab.base, grab.base.keys(), d));
      },
      end: () => { grab = null; },
    });
    // Through an updater: the shell's setter is React's own, which would
    // CALL a function handed to it as the next state.
    setWorldPicker(() => picker);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDragOn(false); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      setWorldPicker(null);
    };
  }, [dragOn, setWorldPicker]);
  // Nothing left to drag: the mode ends.
  useEffect(() => { if (moved.length === 0) setDragOn(false); }, [moved.length]);

  const onDistance = (text: string) => {
    setDistanceText(text);
    const v = parseFloat(text.replace(',', '.'));
    if (!Number.isFinite(v) || v < 0 || v > 100) return;
    setDistance(v);
    reapply(direction, v);
  };
  const onDirection = (d: ShiftDirection) => {
    setDirection(d);
    reapply(d, distance);
  };

  return (
    <div className="flex flex-col gap-1 pl-1 pt-1" style={{ borderTop: '1px dashed var(--line)' }}>
      <div className="flex items-center justify-between">
        <span
          className="mono text-[10.5px]"
          style={{ color: 'var(--text)' }}
          title="Draw the chosen neighbours aside from the isolated tree, so interleaved branches come apart. Only the picture moves: the points keep their real coordinates."
        >
          Pull apart <span style={{ color: 'var(--text-mute)' }}>· view only</span>
        </span>
        <div className="flex items-center gap-1">
          <button
            className="mono text-[9.5px] px-1 rounded"
            style={{ color: 'var(--text-dim)' }}
            disabled={candidates.length === 0}
            onClick={moveAll}
            title="Move every neighbour on screen aside"
          >all</button>
          <button
            className="mono text-[9.5px] px-1 rounded"
            style={{ color: moved.length > 0 ? 'var(--accent)' : 'var(--text-mute)' }}
            disabled={moved.length === 0}
            onClick={reset}
            title="Put every tree back where it is (Esc ends dragging only)"
          >reset</button>
        </div>
      </div>
      {chips.length === 0 ? (
        <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
          Show a neighbour above first — the trees that can move are the ones on screen.
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {chips.map((id) => {
            const o = offsets.get(id);
            const on = !!o;
            const [r, g, b] = treeIdColor(id);
            return (
              <button
                key={id}
                className="mono text-[9.5px] px-1 py-0.5 rounded inline-flex items-center gap-1"
                style={{
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                  background: on ? 'var(--wash-3)' : 'transparent',
                  color: on ? 'var(--text)' : 'var(--text-mute)',
                }}
                onClick={() => toggle(id)}
                title={on ? `Tree ${id} is drawn ${describeOffset(o!)} of its place — click to put it back` : `Draw tree ${id} aside`}
              >
                <span className="inline-block rounded-full shrink-0" style={{ width: 6, height: 6, background: `rgb(${r},${g},${b})`, opacity: on ? 1 : 0.5 }} />
                {id}
                {on && <span className="tnum" style={{ color: 'var(--text-mute)' }}>⇢{Math.hypot(o![0], o![1]).toFixed(1)}m</span>}
              </button>
            );
          })}
        </div>
      )}
      <div className="flex items-center gap-1 flex-wrap">
        <input
          className="mono text-[10.5px] py-0.5 px-1 rounded-md tnum"
          style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)', outline: 'none', width: 44 }}
          inputMode="decimal"
          value={distanceText}
          onChange={(e) => onDistance(e.target.value)}
          onBlur={() => setDistanceText(String(distance))}
          title="How far the moved trees are drawn from their place, metres"
          aria-label="Pull-apart distance in metres"
        />
        <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>m</span>
        {(['away', 'N', 'E', 'S', 'W'] as ShiftDirection[]).map((d) => (
          <button
            key={d}
            className="mono text-[9.5px] px-1 rounded"
            style={{
              color: direction === d ? 'var(--accent)' : 'var(--text-dim)',
              border: `1px solid ${direction === d ? 'var(--line-strong)' : 'transparent'}`,
            }}
            onClick={() => onDirection(d)}
            title={DIRECTION_TITLES[d]}
          >{d}</button>
        ))}
        <button
          className="btn !h-6 !px-1.5 mono text-[10px] ml-auto"
          style={dragOn ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
          disabled={moved.length === 0}
          onClick={() => setDragOn((v) => !v)}
          title={dragOn
            ? 'Dragging: left-drag in the view moves the pulled-apart trees (orbit and lasso paused). Click again or press Esc to stop.'
            : 'Move the pulled-apart trees by dragging in the view. From above they follow the pointer over the ground; from the side, along the screen.'}
        >{dragOn ? '✥ dragging…' : '✥ drag'}</button>
      </div>
      {moved.length > 0 && (
        <div className="mono text-[9px]" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
          Only the picture moves — the points keep their real coordinates. Lasso, set id, split and trim work on what you
          see and save to the real points; a point whose id changes is drawn where its new tree is.
        </div>
      )}
    </div>
  );
}
