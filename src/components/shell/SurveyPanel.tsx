// The Survey panel: measuring and analysis tools for an open dataset.
//
//   Measure   a polyline or an area clicked in the viewer: 3D and plan
//             length, plan area, heights; saved as GeoJSON / DXF / CSV
//   Contours  contour lines of the ground model (GeoJSON, DXF), shown in
//             the viewer
//   Volume    a surface above and below a reference inside the area (cut
//             and fill, a pile on uneven ground)
//   Change    voxels that appeared or are gone against another acquisition,
//             with a voxel_change column on the points
//   Ortho     a top or side ortho image (PNG, world file, GeoTIFF)
//   Profile   a section along the line, drawn here and written as CSV, SVG
//             and DXF
//   Mesh      a 2.5D height field or a closed 3D surface (PLY, OBJ, STL, DXF),
//             shown in the view with any OBJ / STL / PLY file opened here
//   Export    the points as DXF
//
// The state and the arithmetic live in surveyStore.ts; the backend is
// src-tauri/src/commands/octree/survey.rs.

import { Fragment, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import NumberField from '../NumberField';
import { useOctreeShell } from './OctreeShellContext';
import { Btn, Check, Choice, Labeled, LinkBtn, Note, PathLine, Section, Warn } from './panelUi';
import {
  addMesh, addPoint, addTrajectory, bindDataset, changeParams, clearPoints, contourParams, dxfParams, fmtArea, fmtLength, fmtVolume, getSurveyState,
  measure, meshParams, orthoParams, profileParams, removeMesh, runSurveyJob, setSurveyState, stopSurveyJob, surveyDesktop,
  surveyPanelMounted, undoPoint, updateMesh, useSurveyStore, volumeParams,
  type ContourResult, type DxfPointsResult, type GeometryResult, type MeshResult, type OrthoResult, type ProfileResult,
  type SurveyState, type SurveyTab, type Vec3, type VolumeResult, type VoxelChangeResult, removeTrajectory, updateTrajectory,
} from './surveyStore';

const TABS: Array<[SurveyTab, string, string]> = [
  ['measure', 'Measure', 'A polyline or an area clicked in the view: lengths, area, heights'],
  ['contours', 'Contours', 'Contour lines of the ground model'],
  ['volume', 'Volume', 'Cut and fill inside the area'],
  ['change', 'Change', 'Voxels that appeared or are gone against another acquisition'],
  ['ortho', 'Ortho', 'A top or side ortho image'],
  ['profile', 'Profile', 'A section along the line'],
  ['mesh', 'Mesh', 'A triangle mesh (2.5D or 3D), or a mesh file shown in the view'],
  ['export', 'Export', 'Points as DXF'],
];

export default function SurveyPanel() {
  const s = useSurveyStore();
  const { octree, octreeList, setWorldPicker, reloadActiveOctree } = useOctreeShell();
  const dir = octree?.dir ?? null;
  useEffect(() => surveyPanelMounted(), []);
  useEffect(() => { bindDataset(dir); }, [dir]);

  // Picking: every click in the view adds a vertex until paused. The viewer
  // pauses the orbit while a picker is set. The picker is state: handed in
  // as an updater, or React would call it with the previous one.
  const pick = useCallback((hit: [number, number, number]) => addPoint(hit as Vec3), []);
  useEffect(() => {
    setWorldPicker(s.picking ? () => pick : null);
    return () => setWorldPicker(null);
  }, [s.picking, pick, setWorldPicker]);

  const desktop = surveyDesktop();
  const extras = (octree?.meta.extras ?? []).map((e) => e.name);
  const others = (octreeList ?? []).filter((o) => o.dir !== dir);

  return (
    <div className="flex flex-col gap-2 p-1" style={{ minWidth: 0 }}>
      <div className="flex gap-1 flex-wrap">
        {TABS.map(([id, label, title]) => (
          <button key={id} title={title} onClick={() => setSurveyState({ tab: id })}
            className="mono text-[10.5px] rounded-md px-2 py-1 flex-1"
            style={{
              border: '1px solid var(--line)',
              background: s.tab === id ? 'color-mix(in oklch, var(--accent) 16%, transparent)' : 'var(--wash-1)',
              color: s.tab === id ? 'var(--accent)' : 'var(--text-dim)',
            }}>
            {label}
          </button>
        ))}
      </div>

      {!desktop?.surveyContours && <Warn>The survey tools need the desktop build (they run in the Rust backend).</Warn>}
      {!dir && <Note>Open a dataset first.</Note>}

      {dir && (
        <>
          <LineBox s={s} />
          {s.tab === 'measure' && <MeasureTab s={s} dir={dir} />}
          {s.tab === 'contours' && <ContoursTab s={s} dir={dir} />}
          {s.tab === 'volume' && <VolumeTab s={s} dir={dir} />}
          {s.tab === 'change' && <ChangeTab s={s} dir={dir} others={others} reload={reloadActiveOctree} />}
          {s.tab === 'ortho' && <OrthoTab s={s} dir={dir} extras={extras} />}
          {s.tab === 'profile' && <ProfileTab s={s} dir={dir} />}
          {s.tab === 'mesh' && <MeshTab s={s} dir={dir} />}
          {s.tab === 'export' && <ExportTab s={s} dir={dir} />}
        </>
      )}

      {s.job && (
        <div className="flex items-center gap-2 mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
          <div className="flex-1 h-1.5 rounded" style={{ background: 'var(--wash-2, rgba(255,255,255,0.08))' }}>
            <div className="h-1.5 rounded" style={{ width: `${Math.round(s.job.pct * 100)}%`, background: 'var(--accent)' }} />
          </div>
          <span>{Math.round(s.job.pct * 100)} %</span>
          <LinkBtn onClick={stopSurveyJob}>stop</LinkBtn>
        </div>
      )}
      {s.error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md flex gap-2" style={{ color: '#f08a7e', background: 'rgba(240,138,126,0.08)', border: '1px solid rgba(240,138,126,0.35)', lineHeight: 1.5 }}>
          <span className="flex-1" style={{ whiteSpace: 'pre-wrap' }}>{s.error}</span>
          <LinkBtn onClick={() => setSurveyState({ error: null })}>✕</LinkBtn>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the line every tool shares

function LineBox({ s }: { s: SurveyState }) {
  const n = s.points.length;
  const wantsArea = s.tab === 'volume' || s.tab === 'ortho' || s.tab === 'mesh' || s.tab === 'export';
  return (
    <Section title={s.closed ? 'Area' : 'Line'} sub={n === 0 ? 'click points in the view' : `${n} point${n === 1 ? '' : 's'}`}>
      <div className="flex gap-1.5 flex-wrap items-center">
        <Btn primary={!s.picking} onClick={() => setSurveyState({ picking: !s.picking })}
          title="While picking, each click in the view adds a point on the cloud (the view cannot be turned): pause to move around.">
          {s.picking ? 'Pause picking' : n === 0 ? 'Pick points' : 'Add points'}
        </Btn>
        <Btn onClick={undoPoint} disabled={n === 0}>Undo</Btn>
        <Btn onClick={clearPoints} disabled={n === 0}>Clear</Btn>
        <Check checked={s.closed} onChange={(v) => setSurveyState({ closed: v })}
          title="An area: the last point joins the first. Volume and Ortho use it as their area.">
          Area (closed)
        </Check>
      </div>
      {wantsArea && !s.closed && <Note>Tick “Area (closed)” to limit the {s.tab === 'volume' ? 'volume' : s.tab === 'ortho' ? 'image' : s.tab === 'mesh' ? 'mesh' : 'export'} to the area.</Note>}
      {s.tab === 'profile' && n < 2 && <Note>The section follows the line: pick its start and end (and any bends).</Note>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// MEASURE

function MeasureTab({ s, dir }: { s: SurveyState; dir: string }) {
  const m = useMemo(() => measure(s.points, s.closed), [s.points, s.closed]);
  const n = s.points.length;
  const save = async () => {
    const d = surveyDesktop();
    if (!d?.surveySaveGeometry) return;
    const r = await runSurveyJob('measure', async () => await d.surveySaveGeometry!({ octreeDir: dir, name: s.name, points: s.points, closed: s.closed }) as GeometryResult);
    if (r) setSurveyState({ geometry: r });
  };
  const slope = m.length2d > 0 ? Math.atan2(m.rise, m.length2d) * 180 / Math.PI : 0;
  return (
    <Section title="Measures" sub={s.closed ? 'area' : 'polyline'}>
      {n < 2 ? <Note>Two points make a distance, three or more closed an area.</Note> : (
        <Grid rows={[
          [s.closed ? 'Perimeter (3D)' : 'Length (3D)', fmtLength(m.length3d)],
          [s.closed ? 'Perimeter (plan)' : 'Length (plan)', fmtLength(m.length2d)],
          ...(s.closed ? [['Area (plan)', fmtArea(m.area2d)] as [string, string]] : []),
          ['Height range', fmtLength(m.heightRange)],
          ...(!s.closed ? [['Rise, first → last', `${m.rise >= 0 ? '+' : ''}${m.rise.toFixed(3)} m (${slope.toFixed(1)}°)`] as [string, string]] : []),
        ]} />
      )}
      {n > 0 && (
        <div className="scroll-thin rounded-md" style={{ maxHeight: 110, overflow: 'auto', border: '1px solid var(--line)' }}>
          <table className="w-full mono text-[9px]" style={{ color: 'var(--text-dim)' }}>
            <tbody>
              {s.points.map((p, i) => (
                <tr key={i}><td className="px-1" style={{ color: 'var(--text-mute)' }}>{i + 1}</td>
                  <td className="px-1 text-right">{p[0].toFixed(3)}</td><td className="px-1 text-right">{p[1].toFixed(3)}</td><td className="px-1 text-right">{p[2].toFixed(3)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <NameRow s={s} />
      <Btn onClick={() => void save()} disabled={n < 2 || !!s.job} title="survey/<name>.geojson (with the measures), .dxf and .csv in the dataset folder">
        Save line (GeoJSON, DXF, CSV)
      </Btn>
      {s.geometry && <Files files={s.geometry.files} />}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// CONTOURS

function ContoursTab({ s, dir }: { s: SurveyState; dir: string }) {
  const c = s.contour;
  const set = (patch: Partial<SurveyState['contour']>) => setSurveyState({ contour: { ...c, ...patch } });
  const run = async () => {
    const d = surveyDesktop();
    if (!d?.surveyContours) return;
    const r = await runSurveyJob('contours', async () => await d.surveyContours!(contourParams(getSurveyState(), dir)) as ContourResult);
    if (r) setSurveyState({ contours: r, showContours: true });
  };
  const r = s.contours;
  return (
    <Section title="Contour lines" sub="of the ground model (class 2), into terrain/">
      <div className="flex gap-1.5 flex-wrap items-end">
        <NumberField label="interval (m)" value={c.interval} width={80} onChange={(t) => set({ interval: t })} />
        <NumberField label="index every" value={c.indexEvery} width={72} title="Every n-th line is an index (bold) line" onChange={(t) => set({ indexEvery: t })} />
        <NumberField label="DTM cell (m)" value={c.cellSize} width={80} onChange={(t) => set({ cellSize: t })} />
        <NumberField label="smoothing" value={c.smooth} width={66} title="3×3 mean passes over the DTM before contouring" onChange={(t) => set({ smooth: t })} />
        <NumberField label="shortest (m)" value={c.minLength} width={76} title="Shorter lines (small bumps and pits) are left out" onChange={(t) => set({ minLength: t })} />
      </div>
      <Check checked={c.useArea} onChange={(x) => set({ useArea: x })} disabled={!(s.closed && s.points.length >= 3)}
        title="Only inside the drawn area — the ground model beyond the plot is extrapolated">Only the area</Check>
      <Btn primary onClick={() => void run()} disabled={!!s.job}>Draw contour lines</Btn>
      {r && (
        <>
          <Grid rows={[
            ['Lines', `${r.lines.length} (${r.levels} levels)`],
            ['Ground heights', `${r.minZ.toFixed(2)} … ${r.maxZ.toFixed(2)} m`],
            ['Total length', fmtLength(r.lengthM)],
          ]} />
          <Check checked={s.showContours} onChange={(v) => setSurveyState({ showContours: v })}>Show in the view</Check>
          <Files files={r.files} />
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// VOLUME

function VolumeTab({ s, dir }: { s: SurveyState; dir: string }) {
  const v = s.volume;
  const set = (patch: Partial<SurveyState['volume']>) => setSurveyState({ volume: { ...v, ...patch } });
  const run = async () => {
    const d = surveyDesktop();
    if (!d?.surveyVolume) return;
    const r = await runSurveyJob('volume', async () => await d.surveyVolume!(volumeParams(getSurveyState(), dir)) as VolumeResult);
    if (r) setSurveyState({ volumeResult: r });
  };
  const r = s.volumeResult;
  return (
    <Section title="Volume" sub="the surface against a reference, per cell">
      <div className="flex gap-1.5 flex-wrap items-end">
        <Labeled label="Surface" title="top: the highest point of a cell (a pile, a canopy). lowest: the lowest point. ground: the lowest ground point. mean: the mean height.">
          <Choice value={v.surface} onChange={(x) => set({ surface: x })}
            options={[['top', 'top (highest point)'], ['lowest', 'lowest point'], ['ground', 'ground (class 2)'], ['mean', 'mean height']]} />
        </Labeled>
        <Labeled label="Reference" title="rim: a plane fitted to the surface along the area's edge (a pile on uneven ground). plane: a level plane. lowest: a level plane at the lowest cell. dtm: the ground model.">
          <Choice value={v.reference} onChange={(x) => set({ reference: x })}
            options={[['rim', 'plane along the edge'], ['plane', 'level plane at…'], ['lowest', 'level at the lowest cell'], ['dtm', 'ground model (DTM)']]} />
        </Labeled>
        {v.reference === 'plane' && <NumberField label="plane z (m)" value={v.planeZ} width={90} onChange={(t) => set({ planeZ: t })} />}
        <NumberField label="cell (m)" value={v.cellSize} width={66} onChange={(t) => set({ cellSize: t })} />
        <NumberField label="classes" value={v.classes} width={80} placeholder="all" title="Only these classes make the surface, e.g. 1, 2 (empty = all)" onChange={(t) => set({ classes: t })} />
      </div>
      <div className="flex gap-3 flex-wrap">
        <Check checked={v.fillGaps} onChange={(x) => set({ fillGaps: x })} title="Empty cells inside the area take the mean of their neighbours (shadowed sides of a pile)">Fill gaps</Check>
        <Check checked={v.wholeDataset} onChange={(x) => set({ wholeDataset: x })}>Whole dataset (no area)</Check>
      </div>
      <NameRow s={s} />
      <Btn primary onClick={() => void run()} disabled={!!s.job || (!v.wholeDataset && !(s.closed && s.points.length >= 3))}
        title={!v.wholeDataset && !(s.closed && s.points.length >= 3) ? 'Draw an area first (three points or more, Area ticked)' : 'Compute the volume'}>
        Compute volume
      </Btn>
      {r && (
        <>
          <Grid rows={[
            ['Above the reference (fill)', fmtVolume(r.aboveM3)],
            ['Below the reference (cut)', fmtVolume(r.belowM3)],
            ['Net (fill − cut)', fmtVolume(r.netM3)],
            ['Area', `${fmtArea(r.areaM2)}, ${Math.round(100 * r.coveredM2 / Math.max(r.areaM2, 1e-9))} % measured`],
            ['Highest / deepest', `${r.maxAbove.toFixed(3)} m / ${r.maxBelow.toFixed(3)} m`],
          ]} />
          <Note>Reference: {r.reference}</Note>
          <Files files={r.files} />
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// CHANGE

function ChangeTab({ s, dir, others, reload }: {
  s: SurveyState; dir: string; others: Array<{ dir: string; name: string }>; reload?: () => void | Promise<void>;
}) {
  const c = s.change;
  const set = (patch: Partial<SurveyState['change']>) => setSurveyState({ change: { ...c, ...patch } });
  const run = async () => {
    const d = surveyDesktop();
    if (!d?.surveyVoxelChange) return;
    const r = await runSurveyJob('change', async () => await d.surveyVoxelChange!(changeParams(getSurveyState(), dir)) as VoxelChangeResult);
    if (r) {
      setSurveyState({ changeResult: r, showGone: true });
      // the column is new data on the points: the viewer reads it on reopening
      if (r.columnWritten) await reload?.();
    }
  };
  const r = s.changeResult;
  return (
    <Section title="Voxel change" sub="this dataset against another acquisition">
      {others.length === 0 ? <Note>The project has no other dataset to compare with.</Note> : (
        <Labeled label="Compare with" title="Another acquisition of the same place, in the same coordinates (register it first if needed)">
          <Choice value={c.referenceDir} onChange={(x) => set({ referenceDir: x })}
            options={[['', '— choose —'], ...others.map((o) => [o.dir, o.name] as [string, string])]} />
        </Labeled>
      )}
      <div className="flex gap-1.5 flex-wrap items-end">
        <NumberField label="voxel (m)" value={c.voxelSize} width={72} onChange={(t) => set({ voxelSize: t })} />
        <NumberField label="points per voxel" value={c.minPoints} width={96} title="A voxel with fewer points counts as empty" onChange={(t) => set({ minPoints: t })} />
      </div>
      <div className="flex gap-3 flex-wrap">
        <Check checked={c.neighbours} onChange={(x) => set({ neighbours: x })} title="Unchanged when the other acquisition has a point in the voxel or one of its 26 neighbours — absorbs registration noise">Tolerate a voxel of offset</Check>
        <Check checked={c.writeColumn} onChange={(x) => set({ writeColumn: x })} title="voxel_change on every point: 1 = in a new voxel, 0 = unchanged (colour by it in Display)">Write voxel_change column</Check>
      </div>
      <Btn primary onClick={() => void run()} disabled={!!s.job || !c.referenceDir}>Compare</Btn>
      {r && (
        <>
          <Grid rows={[
            ['New (only here)', `${r.appeared.toLocaleString('en-US')} voxels · ${fmtVolume(r.appearedM3)}`],
            ['Gone (only there)', `${r.disappeared.toLocaleString('en-US')} voxels · ${fmtVolume(r.disappearedM3)}`],
            ['Unchanged', `${r.unchanged.toLocaleString('en-US')} voxels`],
            ['Points in new voxels', `${r.pointsNew.toLocaleString('en-US')} of ${r.points.toLocaleString('en-US')}`],
          ]} />
          <Check checked={s.showGone} onChange={(v) => setSurveyState({ showGone: v })}>Show the gone voxels (red)</Check>
          {r.columnWritten && <Note>Colour the cloud by <b>{r.columnWritten}</b> in Display → Extras to see what is new.</Note>}
          <Files files={r.files} />
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// ORTHO

function OrthoTab({ s, dir, extras }: { s: SurveyState; dir: string; extras: string[] }) {
  const o = s.ortho;
  const set = (patch: Partial<SurveyState['ortho']>) => setSurveyState({ ortho: { ...o, ...patch } });
  const hasRgb = ['red', 'green', 'blue'].every((c) => extras.some((e) => e.toLowerCase() === c));
  const colours: Array<[string, string]> = [
    ...(hasRgb ? [['rgb', 'RGB colour'] as [string, string]] : []),
    ['height', 'height'], ['intensity', 'intensity'], ['class', 'class'],
    ...extras.filter((e) => !['red', 'green', 'blue'].includes(e.toLowerCase())).map((e) => [e, e] as [string, string]),
  ];
  const run = async () => {
    const d = surveyDesktop();
    if (!d?.surveyOrtho) return;
    const r = await runSurveyJob('ortho', async () => await d.surveyOrtho!(orthoParams(getSurveyState(), dir)) as OrthoResult);
    if (r) setSurveyState({ orthoResult: r });
  };
  const r = s.orthoResult;
  return (
    <Section title="Ortho image" sub={o.view === 'top' ? 'top view: PNG + world file, RGBA GeoTIFF' : 'side view: PNG + its plane (JSON)'}>
      <div className="flex gap-1.5 flex-wrap items-end">
        <Labeled label="View">
          <Choice value={o.view} onChange={(x) => set({ view: x })} options={[['top', 'top (plan)'], ['side', 'side (elevation)']]} />
        </Labeled>
        {o.view === 'side' && <NumberField label="looking toward (°)" value={o.bearingDeg} width={100} title="Bearing of the view, clockwise from grid north (0 = looking north)" onChange={(t) => set({ bearingDeg: t })} />}
        <NumberField label="pixel (m)" value={o.pixelSize} width={70} onChange={(t) => set({ pixelSize: t })} />
        <Labeled label="Colour">
          <Choice value={o.color} onChange={(x) => set({ color: x })} options={colours} />
        </Labeled>
      </div>
      {o.view === 'side' && (
        <div className="flex gap-1.5 flex-wrap items-end">
          <NumberField label="from (m)" value={o.depthNear} width={70} placeholder="all" title="Only points this far in front of (−) or behind the plane through the area's centre" onChange={(t) => set({ depthNear: t })} />
          <NumberField label="to (m)" value={o.depthFar} width={70} placeholder="all" onChange={(t) => set({ depthFar: t })} />
        </div>
      )}
      <div className="flex gap-3 flex-wrap">
        <Check checked={o.shade} onChange={(x) => set({ shade: x })} title="Light the nearest surface from the upper left: relief and edges read better">Relief shading</Check>
        <Check checked={o.useArea} onChange={(x) => set({ useArea: x })} disabled={!(s.closed && s.points.length >= 3)}>Only the area</Check>
      </div>
      <NameRow s={s} />
      <Btn primary onClick={() => void run()} disabled={!!s.job}>Make the image</Btn>
      {r && (
        <>
          <Grid rows={[
            ['Size', `${r.width} × ${r.height} px at ${(r.pixelSize * 100).toFixed(1)} cm`],
            ['Pixels with a point', `${r.filledPct.toFixed(1)} %`],
          ]} />
          <Files files={r.files} />
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// PROFILE

function ProfileTab({ s, dir }: { s: SurveyState; dir: string }) {
  const run = async () => {
    const d = surveyDesktop();
    if (!d?.surveyProfile) return;
    const r = await runSurveyJob('profile', async () => await d.surveyProfile!(profileParams(getSurveyState(), dir)) as ProfileResult);
    if (r) setSurveyState({ profileResult: r });
  };
  const r = s.profileResult;
  return (
    <Section title="Section profile" sub="the points of a corridor along the line">
      <div className="flex gap-1.5 flex-wrap items-end">
        <NumberField label="corridor width (m)" value={s.profile.width} width={110} title="Points this close to the line (half to each side) are in the section"
          onChange={(t) => setSurveyState({ profile: { ...s.profile, width: t } })} />
        <Labeled label="Vertical scale">
          <Choice value={String(s.profile.exaggeration)} onChange={(x) => setSurveyState({ profile: { ...s.profile, exaggeration: Number(x) } })}
            options={[['1', '1 : 1'], ['2', '2 ×'], ['5', '5 ×'], ['10', '10 ×']]} />
        </Labeled>
      </div>
      <NameRow s={s} />
      <Btn primary onClick={() => void run()} disabled={!!s.job || s.points.length < 2}>Cut the section</Btn>
      {r && (
        <>
          <ProfilePlot r={r} exaggeration={s.profile.exaggeration} />
          <Grid rows={[
            ['Length', fmtLength(r.lengthM)],
            ['Points', r.points.toLocaleString('en-US')],
            ['Heights', `${r.zMin.toFixed(2)} … ${r.zMax.toFixed(2)} m`],
          ]} />
          <Files files={r.files} />
        </>
      )}
    </Section>
  );
}

const CLASS_COLORS: Record<number, string> = { 2: '#a07850', 3: '#96c86e', 4: '#50aa46', 5: '#1e7828', 6: '#d2463c', 9: '#4682dc' };

/** The section drawn to scale (the vertical one exaggerated as chosen):
 *  points by class, the ground line brown. */
export function ProfilePlot({ r, exaggeration }: { r: ProfileResult; exaggeration: number }) {
  const W = 480, M = 26;
  const span = Math.max(r.zMax - r.zMin, 0.5);
  const sx = (W - 2 * M) / Math.max(r.lengthM, 1e-6);
  const H = Math.min(320, Math.max(90, span * sx * exaggeration + 2 * M));
  const sz = (H - 2 * M) / span;
  const x = (st: number) => M + st * sx;
  const y = (z: number) => H - M - (z - r.zMin) * sz;
  const n = r.preview.station.length;
  const step = Math.max(1, Math.ceil(n / 20_000));
  const dots: ReactNode[] = [];
  for (let i = 0; i < n; i += step) {
    dots.push(<rect key={i} x={x(r.preview.station[i])} y={y(r.preview.z[i])} width={1.4} height={1.4} fill={CLASS_COLORS[r.preview.class[i]] ?? '#9aa0a6'} />);
  }
  const ground = r.ground.map((g) => `${x(g[0]).toFixed(1)},${y(g[1]).toFixed(1)}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ background: 'rgba(0,0,0,0.25)', borderRadius: 6, border: '1px solid var(--line)' }}>
      <text x={M} y={14} fill="var(--text-mute)" fontSize={9} fontFamily="monospace">
        {r.lengthM.toFixed(1)} m · {r.zMin.toFixed(1)}–{r.zMax.toFixed(1)} m{exaggeration !== 1 ? ` · vertical ${exaggeration}×` : ''}
      </text>
      {dots}
      {r.ground.length > 1 && <polyline points={ground} fill="none" stroke="#c08a50" strokeWidth={1.2} />}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// MESH

function MeshTab({ s, dir }: { s: SurveyState; dir: string }) {
  const m = s.mesh;
  const set = (patch: Partial<SurveyState['mesh']>) => setSurveyState({ mesh: { ...m, ...patch } });
  const hasArea = s.closed && s.points.length >= 3;
  const run = async () => {
    const d = surveyDesktop();
    if (!d?.surveyMesh) return;
    const r = await runSurveyJob('mesh', async () => await d.surveyMesh!(meshParams(getSurveyState(), dir)) as MeshResult);
    if (r) {
      setSurveyState({ meshResult: r });
      addMesh(r.ply);
    }
  };
  const open = async () => {
    const f = await surveyDesktop()?.openFileDialog?.({ filters: [{ name: 'Mesh', extensions: ['ply', 'obj', 'stl'] }] });
    if (f?.path) addMesh(f.path);
  };
  const openTrajectory = async () => {
    const f = await surveyDesktop()?.openFileDialog?.({ filters: [{ name: 'Trajectory', extensions: ['txt', 'csv'] }] });
    if (f?.path) addTrajectory(f.path);
  };
  const r = s.meshResult;
  return (
    <>
      <Section title="Triangle mesh" sub={m.method === '2.5d' ? 'a height field: one height per cell' : 'a closed surface around the points'}>
        <div className="flex gap-1.5 flex-wrap items-end">
          <Labeled label="Method" title="2.5D: terrain, a pile, a roof — one height per grid cell. 3D: any shape (a stump, a rock, a stem section) — a closed surface around the voxels the points occupy, up to about one voxel outside them.">
            <Choice value={m.method} onChange={(x) => set({ method: x })} options={[['2.5d', '2.5D (height field)'], ['3d', '3D (closed surface)']]} />
          </Labeled>
          <NumberField label={m.method === '3d' ? 'voxel (m)' : 'cell (m)'} value={m.cellSize} width={70} onChange={(t) => set({ cellSize: t })} />
          {m.method === '2.5d' ? (
            <Labeled label="Height of a cell">
              <Choice value={m.surface} onChange={(x) => set({ surface: x })}
                options={[['top', 'highest point'], ['lowest', 'lowest point'], ['ground', 'ground (class 2)'], ['mean', 'mean']]} />
            </Labeled>
          ) : (
            <NumberField label="points per voxel" value={m.minPoints} width={96} title="Voxels with fewer points are left out (noise)" onChange={(t) => set({ minPoints: t })} />
          )}
        </div>
        <div className="flex gap-1.5 flex-wrap items-end">
          <NumberField label="classes" value={m.classes} width={72} placeholder="all" title="e.g. 2 for the ground (empty = all)" onChange={(t) => set({ classes: t })} />
          <NumberField label="z from (m)" value={m.zLow} width={76} placeholder="all" onChange={(t) => set({ zLow: t })} />
          <NumberField label="z to (m)" value={m.zHigh} width={76} placeholder="all" title="A height window: a stem section, a layer" onChange={(t) => set({ zHigh: t })} />
          <NumberField label="smoothing" value={m.smooth} width={70} title="Taubin smoothing iterations: smooths without shrinking; an open mesh's edge stays put" onChange={(t) => set({ smooth: t })} />
          <NumberField label="decimate (m)" value={m.decimate} width={84} title="Vertices closer than this merge (vertex clustering); 0 = keep all" onChange={(t) => set({ decimate: t })} />
        </div>
        <div className="flex gap-3 flex-wrap">
          <Check checked={m.useArea && hasArea} onChange={(x) => set({ useArea: x })} disabled={!hasArea}>Only the area</Check>
          {m.method === '2.5d' && <Check checked={m.fillGaps} onChange={(x) => set({ fillGaps: x })}>Fill gaps</Check>}
        </div>
        <div className="flex gap-3 flex-wrap items-center mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
          <span>Files: PLY</span>
          <Check checked={m.obj} onChange={(x) => set({ obj: x })}>OBJ</Check>
          <Check checked={m.stl} onChange={(x) => set({ stl: x })} title="32-bit floats: relative to the origin written in the header">STL</Check>
          <Check checked={m.dxf} onChange={(x) => set({ dxf: x })} title="3DFACE entities (large for big meshes)">DXF</Check>
        </div>
        <NameRow s={s} />
        <Btn primary onClick={() => void run()} disabled={!!s.job}>Make the mesh</Btn>
        {r && (
          <>
            <Grid rows={[
              ['Triangles', `${r.triangles.toLocaleString('en-US')} (${r.vertices.toLocaleString('en-US')} vertices)`],
              ['Surface area', fmtArea(r.areaM2)],
              ...(r.volumeM3 !== null ? [['Enclosed volume', fmtVolume(r.volumeM3)] as [string, string]] : []),
              ['Heights', `${r.min[2].toFixed(2)} … ${r.max[2].toFixed(2)} m`],
            ]} />
            <Files files={r.files} />
          </>
        )}
      </Section>
      <Section title="Meshes in the view" sub={s.meshes.length ? `${s.meshes.length}` : 'none'}>
        {s.meshes.map((x) => (
          <div key={x.path} className="flex items-center gap-1.5 mono text-[10px]" style={{ color: 'var(--text-dim)' }} title={x.path}>
            <input type="checkbox" checked={x.visible} onChange={(e) => updateMesh(x.path, { visible: e.target.checked })} />
            <input type="color" value={x.color} onChange={(e) => updateMesh(x.path, { color: e.target.value })} style={{ width: 22, height: 16, padding: 0, border: 'none', background: 'none' }} />
            <span className="truncate flex-1">{x.name}</span>
            <input type="range" min={0.2} max={1} step={0.05} value={x.opacity} title="Opacity" onChange={(e) => updateMesh(x.path, { opacity: Number(e.target.value) })} style={{ width: 70 }} />
            <LinkBtn onClick={() => removeMesh(x.path)}>✕</LinkBtn>
          </div>
        ))}
        <Btn onClick={() => void open()}>Show a mesh file (OBJ, STL, PLY)…</Btn>
        <Note>Meshes from other programs show where their coordinates are: in this dataset's coordinate system.</Note>
      </Section>
      <Section title="Trajectories in the view" sub={s.trajectories.length ? `${s.trajectories.length}` : 'none'}>
        {s.trajectories.map((x) => (
          <div key={x.path} className="flex items-center gap-1.5 mono text-[10px]" style={{ color: 'var(--text-dim)' }} title={x.path}>
            <input type="checkbox" checked={x.visible} onChange={(e) => updateTrajectory(x.path, { visible: e.target.checked })} />
            <input type="color" value={x.color} onChange={(e) => updateTrajectory(x.path, { color: e.target.value })} style={{ width: 22, height: 16, padding: 0, border: 'none', background: 'none' }} />
            <span className="truncate flex-1">{x.name}</span>
            <LinkBtn onClick={() => removeTrajectory(x.path)}>✕</LinkBtn>
          </div>
        ))}
        <Btn onClick={() => void openTrajectory()}>Show a trajectory (.txt)…</Btn>
        <Note>The path a mobile scanner walked (a time x y z text file). Start and end are marked.</Note>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// EXPORT

function ExportTab({ s, dir }: { s: SurveyState; dir: string }) {
  const d = s.dxf;
  const set = (patch: Partial<SurveyState['dxf']>) => setSurveyState({ dxf: { ...d, ...patch } });
  const hasArea = s.closed && s.points.length >= 3;
  const run = async () => {
    const x = surveyDesktop();
    if (!x?.surveyDxfPoints) return;
    const r = await runSurveyJob('export', async () => await x.surveyDxfPoints!(dxfParams(getSurveyState(), dir)) as DxfPointsResult);
    if (r) setSurveyState({ dxfResult: r });
  };
  const r = s.dxfResult;
  return (
    <Section title="Points as DXF" sub="POINT entities, a layer per class (CLASS_n)">
      <div className="flex gap-1.5 flex-wrap items-end">
        <NumberField label="classes" value={d.classes} width={72} placeholder="all" onChange={(t) => set({ classes: t })} />
        <NumberField label="z from (m)" value={d.zLow} width={76} placeholder="all" onChange={(t) => set({ zLow: t })} />
        <NumberField label="z to (m)" value={d.zHigh} width={76} placeholder="all" onChange={(t) => set({ zHigh: t })} />
        <NumberField label="every n-th" value={d.every} width={70} title="Keep every n-th point: CAD programs slow down past a few million" onChange={(t) => set({ every: t })} />
        <NumberField label="at most" value={d.maxPoints} width={90} onChange={(t) => set({ maxPoints: t })} />
      </div>
      <Check checked={d.useArea && hasArea} onChange={(x) => set({ useArea: x })} disabled={!hasArea}>Only the area</Check>
      <NameRow s={s} />
      <Btn primary onClick={() => void run()} disabled={!!s.job}>Write DXF</Btn>
      {r && (
        <>
          <Grid rows={[
            ['Points', r.points.toLocaleString('en-US')],
            ['Layers', r.classes.map(([c, n]) => `CLASS_${c}: ${n.toLocaleString('en-US')}`).join(' · ')],
          ]} />
          <Files files={r.files} />
        </>
      )}
      <Note>LAS, LAZ, text, PLY and E57 are in File → Export….</Note>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// bits

function NameRow({ s }: { s: SurveyState }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="mono" style={{ fontSize: 9, color: 'var(--text-mute)' }}>File name (in the dataset's survey/ folder)</span>
      <input className="mono text-[11px] py-1 px-1.5 rounded-md outline-none w-full" spellCheck={false}
        style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
        value={s.name} onChange={(e) => setSurveyState({ name: e.target.value })} />
    </label>
  );
}

function Grid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
      {rows.map(([k, v]) => (
        <Fragment key={k}><span>{k}</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{v}</span></Fragment>
      ))}
    </div>
  );
}

function Files({ files }: { files: string[] }) {
  return <div className="flex flex-col gap-0.5">{files.map((f) => <PathLine key={f} path={f} />)}</div>;
}

/** The activity bar's icon: a section line over a slope. */
export function SurveyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 18c3-1 5-6 9-6s6 3 9 2" />
      <path d="M3 21h18" />
      <path d="M6 4l12 8" strokeDasharray="2 2" />
      <circle cx="6" cy="4" r="1.4" />
      <circle cx="18" cy="12" r="1.4" />
    </svg>
  );
}
