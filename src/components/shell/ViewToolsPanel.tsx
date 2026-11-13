// Views & video: the X-ray view and animations of the open
// dataset (a fly-through along camera keyframes, a slab moved through the
// cloud, datasets of the same place one after another), each optionally
// recorded as a video of the viewer. State and timing: viewToolsStore.ts;
// the viewer side: three/ViewTools.tsx.

import { useEffect, useRef, useState } from 'react';
import NumberField from '../NumberField';
import { useOctreeShell } from './OctreeShellContext';
import { Btn, Check, Choice, Labeled, LinkBtn, Note, Section, Warn } from './panelUi';
import {
  bindViewDataset, deleteView, lapseIndex, nextViewName, poseAt, renameView, saveView, setViewTools, slabAt, startRecording, useViewTools,
  viewToolsPanelMounted, viewer,
  type AnimationKind, type Recording, type SavedView, type ViewToolsState,
} from './viewToolsStore';

interface Desktop {
  saveExportDialog?: (name: string, filters: { name: string; extensions: string[] }[], title?: string) => Promise<string | null>;
  writeFileBytes?: (path: string, bytes: Uint8Array) => Promise<boolean>;
}

const desktop = () => (window as unknown as { desktop?: Desktop }).desktop;

export default function ViewToolsPanel() {
  const v = useViewTools();
  const shell = useOctreeShell();
  const { octree, display, setDisplay } = shell;
  useEffect(() => viewToolsPanelMounted(), []);
  useEffect(() => { bindViewDataset(octree?.dir ?? null); }, [octree?.dir]);
  const stopRef = useRef(false);
  const busy = v.playing !== null;

  const setXray = (on: boolean) => {
    if (on && display.edlEnabled) setDisplay({ edlEnabled: false });
    setViewTools({ xray: on, note: on && display.edlEnabled ? 'Eye-dome lighting is off while X-ray is on (it needs the depth X-ray does not write).' : null });
  };

  /** Runs one animation for `seconds`, calling `frame(u)` with u 0 … 1, and
   *  records it when asked. `done` puts the view back. */
  const animate = async (kind: AnimationKind, seconds: number, frame: (u: number) => void, done: () => void) => {
    const h = viewer();
    if (!h) { setViewTools({ error: 'The viewer is not ready.' }); return; }
    let rec: Recording | null = null;
    try {
      if (v.record) rec = startRecording(h.canvas);
    } catch (e) {
      setViewTools({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    stopRef.current = false;
    setViewTools({ playing: kind, progress: 0, error: null, note: null });
    const t0 = performance.now();
    const ms = Math.max(0.5, seconds) * 1000;
    await new Promise<void>((resolve) => {
      let lastShown = -1;
      const step = (now: number) => {
        const raw = (now - t0) / ms;
        const u = getLoop(kind) ? raw % 1 : Math.min(1, raw);
        frame(u);
        const shown = Math.round(u * 100);
        if (shown !== lastShown) { lastShown = shown; setViewTools({ progress: u }); }
        if (stopRef.current || (!getLoop(kind) && raw >= 1)) { resolve(); return; }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    done();
    setViewTools({ playing: null, progress: 0 });
    if (rec) await saveVideo(rec, `${kind}`);
  };

  const getLoop = (kind: AnimationKind) => kind === 'fly' && v.loop && !v.record;

  const saveVideo = async (rec: Recording, stem: string) => {
    const blob = await rec.stop();
    const d = desktop();
    if (!d?.saveExportDialog || !d.writeFileBytes) { setViewTools({ error: 'Saving a video needs the desktop build.' }); return; }
    const path = await d.saveExportDialog(`${stem}.${rec.ext}`, [{ name: rec.ext === 'mp4' ? 'MP4 video' : 'WebM video', extensions: [rec.ext] }], 'Save the video');
    if (!path) { setViewTools({ note: 'The recording was not saved.' }); return; }
    await d.writeFileBytes(path, new Uint8Array(await blob.arrayBuffer()));
    setViewTools({ note: `Saved ${path} (${(blob.size / 1e6).toFixed(1)} MB).` });
  };

  if (!octree) return <div className="p-1"><Note>Open a dataset first.</Note></div>;

  return (
    <div className="flex flex-col gap-2 p-1" style={{ minWidth: 0 }}>
      <Section title="X-ray" sub="the cloud added up without depth: dense structure shows through">
        <div className="flex gap-3 items-center flex-wrap">
          <Check checked={v.xray} onChange={setXray} title="Every point adds a little light; stems, walls and the ground's edge stand out through the canopy">X-ray view</Check>
          <label className="flex items-center gap-1.5 mono text-[10px]" style={{ color: 'var(--text-dim)' }} title="How much one point adds">
            strength
            <input type="range" min={0.01} max={0.5} step={0.01} value={v.xrayStrength} disabled={!v.xray}
              onChange={(e) => setViewTools({ xrayStrength: Number(e.target.value) })} style={{ width: 120 }} />
            <span style={{ width: 28 }}>{v.xrayStrength.toFixed(2)}</span>
          </label>
        </div>
        <Note>A dark background works best. Fewer, larger points (Display → point size) read like a radiograph.</Note>
      </Section>

      <SavedViews v={v} projection={display.projection ?? 'perspective'} onProjection={(p) => setDisplay({ projection: p })} busy={busy} />
      <FlyThrough v={v} busy={busy} animate={animate} stop={() => { stopRef.current = true; }} />
      <SliceThrough v={v} busy={busy} animate={animate} stop={() => { stopRef.current = true; }} />
      <TimeLapse v={v} busy={busy} animate={animate} stop={() => { stopRef.current = true; }} />

      <div className="flex items-center gap-2">
        <Check checked={v.record} onChange={(x) => setViewTools({ record: x })} disabled={busy}
          title="Record the viewer while an animation plays, then save it (MP4 where the web view can encode it, else WebM)">
          Record a video of the next animation
        </Check>
      </div>
      {busy && (
        <div className="flex items-center gap-2 mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
          <div className="flex-1 h-1.5 rounded" style={{ background: 'var(--wash-2, rgba(255,255,255,0.08))' }}>
            <div className="h-1.5 rounded" style={{ width: `${Math.round(v.progress * 100)}%`, background: 'var(--accent)' }} />
          </div>
          <span>{v.record ? '● rec' : `${Math.round(v.progress * 100)} %`}</span>
          <LinkBtn onClick={() => { stopRef.current = true; }}>stop</LinkBtn>
        </div>
      )}
      {v.note && <Note>{v.note}</Note>}
      {v.error && <Warn>{v.error}</Warn>}
    </div>
  );
}

type Animate = (kind: AnimationKind, seconds: number, frame: (u: number) => void, done: () => void) => Promise<void>;

/** Named camera positions of this dataset, with their projection. */
function SavedViews({ v, projection, onProjection, busy }: {
  v: ViewToolsState; projection: 'perspective' | 'ortho'; onProjection: (p: 'perspective' | 'ortho') => void; busy: boolean;
}) {
  const [name, setName] = useState('');
  const go = (view: SavedView) => {
    onProjection(view.projection);
    viewer()?.setPose(view);
  };
  return (
    <Section title="Saved views" sub={v.savedViews.length ? `${v.savedViews.length}` : 'the camera, kept for this dataset'}>
      {v.savedViews.map((s) => (
        <div key={s.name} className="flex items-center gap-1.5 mono text-[10.5px]">
          <button className="flex-1 min-w-0 text-left truncate" disabled={busy} onClick={() => go(s)}
            onDoubleClick={() => { const to = window.prompt('Rename the view', s.name); if (to) renameView(s.name, to); }}
            title={`Go to this view (${s.projection === 'ortho' ? 'parallel' : 'perspective'}). Double-click to rename.`}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)' }}>
            {s.projection === 'ortho' ? '▭ ' : '◇ '}{s.name}
          </button>
          <LinkBtn onClick={() => saveView(s.name, projection)}>update</LinkBtn>
          <LinkBtn onClick={() => deleteView(s.name)}>✕</LinkBtn>
        </div>
      ))}
      <div className="flex gap-1.5 items-center">
        <input className="mono text-[10.5px] py-1 px-1.5 rounded-md outline-none flex-1 min-w-0" spellCheck={false}
          style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
          placeholder={nextViewName(v.savedViews)} value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { saveView(name, projection); setName(''); } }} />
        <Btn onClick={() => { saveView(name, projection); setName(''); }} disabled={busy}>Save view</Btn>
      </div>
    </Section>
  );
}

function FlyThrough({ v, busy, animate, stop }: { v: ViewToolsState; busy: boolean; animate: Animate; stop: () => void }) {
  const add = () => {
    const h = viewer();
    if (h) setViewTools((s) => ({ keyframes: [...s.keyframes, h.getPose()] }));
  };
  const play = () => {
    const keys = v.keyframes;
    const start = viewer()?.getPose();
    void animate('fly', Number(v.flySeconds) || 10, (u) => {
      const p = poseAt(keys, u);
      if (p) viewer()?.setPose(p);
    }, () => { if (start && v.loop) viewer()?.setPose(start); });
  };
  return (
    <Section title="Fly-through" sub={`${v.keyframes.length} keyframe${v.keyframes.length === 1 ? '' : 's'}`}>
      <Note>Move the view, then “Add view”; the camera flies through the views in order along a smooth curve.</Note>
      <div className="flex gap-1.5 flex-wrap items-center">
        <Btn onClick={add} disabled={busy}>Add view</Btn>
        <Btn onClick={() => setViewTools((s) => ({ keyframes: s.keyframes.slice(0, -1) }))} disabled={busy || v.keyframes.length === 0}>Remove last</Btn>
        <Btn onClick={() => setViewTools({ keyframes: [] })} disabled={busy || v.keyframes.length === 0}>Clear</Btn>
      </div>
      {v.keyframes.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {v.keyframes.map((k, i) => (
            <button key={i} className="mono text-[9.5px] rounded px-1.5 py-0.5" disabled={busy}
              style={{ border: '1px solid var(--line)', background: 'var(--wash-1)', color: 'var(--text-dim)' }}
              title={`Go to view ${i + 1}`} onClick={() => viewer()?.setPose(k)}>{i + 1}</button>
          ))}
        </div>
      )}
      <div className="flex gap-1.5 flex-wrap items-end">
        <NumberField label="seconds" value={v.flySeconds} width={70} onChange={(t) => setViewTools({ flySeconds: t })} />
        <Check checked={v.loop} onChange={(x) => setViewTools({ loop: x })} disabled={busy} title="Play round and round until stopped (not while recording)">Loop</Check>
        {v.playing === 'fly'
          ? <Btn onClick={stop}>Stop</Btn>
          : <Btn primary onClick={play} disabled={busy || v.keyframes.length < 2}>Play</Btn>}
      </div>
    </Section>
  );
}

function SliceThrough({ v, busy, animate, stop }: { v: ViewToolsState; busy: boolean; animate: Animate; stop: () => void }) {
  const { octree, filters, setFilters } = useOctreeShell();
  const s = v.slice;
  const set = (patch: Partial<ViewToolsState['slice']>) => setViewTools({ slice: { ...s, ...patch } });
  const play = () => {
    const bb = octree?.meta.boundingBox;
    if (!bb) return;
    const saved = filters.planeSlab;
    const min = bb.min as [number, number, number], max = bb.max as [number, number, number];
    void animate('slice', Number(s.seconds) || 10, (u) => {
      setFilters({ planeSlab: slabAt(s.axis, Number(s.bearingDeg) || 0, Number(s.thickness) || 0.5, min, max, u) });
    }, () => setFilters({ planeSlab: saved }));
  };
  return (
    <Section title="Slice through" sub="a slab moved across the cloud">
      <div className="flex gap-1.5 flex-wrap items-end">
        <Labeled label="Direction">
          <Choice value={s.axis} disabled={busy} onChange={(x) => set({ axis: x })}
            options={[['height', 'upward (horizontal slices)'], ['east', 'eastward'], ['north', 'northward'], ['bearing', 'toward a bearing…']]} />
        </Labeled>
        {s.axis === 'bearing' && <NumberField label="bearing (°)" value={s.bearingDeg} width={76} onChange={(t) => set({ bearingDeg: t })} />}
        <NumberField label="thickness (m)" value={s.thickness} width={86} onChange={(t) => set({ thickness: t })} />
        <NumberField label="seconds" value={s.seconds} width={70} onChange={(t) => set({ seconds: t })} />
        {v.playing === 'slice'
          ? <Btn onClick={stop}>Stop</Btn>
          : <Btn primary onClick={play} disabled={busy}>Play</Btn>}
      </div>
      <Note>Uses the Filters' plane slab; what was there comes back when the slice ends.</Note>
    </Section>
  );
}

function TimeLapse({ v, busy, animate, stop }: { v: ViewToolsState; busy: boolean; animate: Animate; stop: () => void }) {
  const { octree, octreeList, secondaryClouds, addSecondary, removeSecondary, toggleSecondary, cloudVisible, setCloudVisible } = useOctreeShell();
  const t = v.timelapse;
  const chosen = t.dirs.filter((d) => octreeList.some((o) => o.dir === d));
  // the overlays as of the last render: the animation reads them each frame
  const latestSecondaries = useRef(secondaryClouds);
  latestSecondaries.current = secondaryClouds;
  const play = async () => {
    if (!octree || chosen.length < 2) return;
    // every chosen dataset as an overlay (the open one is itself)
    const before = new Set(secondaryClouds.map((c) => c.id));
    for (const d of chosen) {
      if (d !== octree.dir && !secondaryClouds.some((c) => c.octree.dir === d)) {
        await addSecondary(d, octreeList.find((o) => o.dir === d)?.name ?? d);
      }
    }
    const primaryWas = cloudVisible;
    let shown = -1;
    void animate('timelapse', (Number(t.secondsEach) || 3) * chosen.length, (u) => {
      const k = lapseIndex(chosen.length, u);
      if (k === shown) return;
      shown = k;
      const dir = chosen[k];
      setCloudVisible(dir === octree.dir);
      const overlays = latestSecondaries.current;
      for (const c of overlays) {
        const want = c.octree.dir === dir;
        if (c.visible !== want) toggleSecondary(c.id);
      }
      setViewTools({ note: `${k + 1} / ${chosen.length}: ${octreeList.find((o) => o.dir === dir)?.name ?? dir}` });
    }, () => {
      setCloudVisible(primaryWas);
      for (const c of latestSecondaries.current) if (!before.has(c.id)) removeSecondary(c.id);
    });
  };
  return (
    <Section title="Time lapse" sub="datasets of the same place, one after another">
      {octreeList.length < 2 ? <Note>The project has one dataset; a time lapse needs two or more acquisitions.</Note> : (
        <div className="flex flex-col gap-0.5">
          {octreeList.map((o) => (
            <Check key={o.dir} checked={t.dirs.includes(o.dir)} disabled={busy}
              onChange={(x) => setViewTools({ timelapse: { ...t, dirs: x ? [...t.dirs, o.dir] : t.dirs.filter((d) => d !== o.dir) } })}>
              {o.name}{o.dir === octree?.dir ? ' (open)' : ''}
            </Check>
          ))}
        </div>
      )}
      <div className="flex gap-1.5 flex-wrap items-end">
        <NumberField label="seconds each" value={t.secondsEach} width={86} onChange={(x) => setViewTools({ timelapse: { ...t, secondsEach: x } })} />
        {v.playing === 'timelapse'
          ? <Btn onClick={stop}>Stop</Btn>
          : <Btn primary onClick={() => void play()} disabled={busy || chosen.length < 2}>Play</Btn>}
      </div>
      <Note>In the order ticked; the datasets must share the coordinate system (register them first if needed).</Note>
    </Section>
  );
}

/** The activity bar's icon: a film frame with a play mark. */
export function ViewToolsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9h2M3 15h2M19 9h2M19 15h2" />
      <path d="M10 9.5v5l4.5-2.5z" />
    </svg>
  );
}
