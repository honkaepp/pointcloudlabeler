// Fine registration — two datasets of one plot, put on each other to
// the millimetre, with the figure that says how sure the millimetre is.
//
// The Cloud registration panel measures a horizontal shift from tree
// skeletons and applies it losslessly; it cannot rotate, and it needs
// skeletons. This panel registers two DATASETS in six degrees of
// freedom from their surfaces (src-tauri commands/register.rs): a
// pyramid of decimations, symmetric point-to-plane ICP with a robust
// kernel, and at the solution the covariance — the standard error of
// every parameter — and the observability of the fit, so a flat field
// that fixed height and tilt and nothing else says so instead of
// returning the horizontal shift it chose.
//
//   MEASURE — reports; nothing moves. The start is the two as they
//   stand, a manual offset, the stored skeleton alignment, or an
//   automatic coarse search by stems and crowns.
//
//   APPLY — the moving dataset written as a NEW dataset through the
//   transform, every label and column kept, the move recorded in its
//   metadata. The source is never touched: removing the copy undoes it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import { onOctreeProgress } from '../../persistence/octreeStore';
import { cancelStage, canCancel } from '../../ui/cancelStage';
import { sameDir, findDir } from '../../persistence/datasetDirs';
import NumberField, { parseNum, parseCount } from '../NumberField';
import {
  FINE_REG_DEFAULTS, REGISTER_STAGE, TRANSFORM_STAGE, coarseVerdict, constraintVerdict, copyOutDir,
  defaultCopyName, describeTranslation, histogramBars, isWorthApplying, lengthText, plusMinus, quotedStdErr,
  registerStageLabel, rotationAtPlotEdge,
  type FineRegistrationReport, type RegisterDof, type RegisterInitMode, type RegisterKernel, type RegisterMethod,
} from './fineRegistration';

interface Desktop {
  octreeRegister?: (
    referenceDir: string, movingDir: string,
    init: { mode: RegisterInitMode; dx?: number; dy?: number; dz?: number; yawDeg?: number; searchRadius?: number; yawRangeDeg?: number; dtmCell?: number; featureVoxel?: number },
    params: {
      method: RegisterMethod; kernel: RegisterKernel; dof: RegisterDof; voxel: number; levels: number; maxCorrDist: number;
      maxIters: number; normalK: number; maxNormalAngleDeg: number; kernelFloor: number; maxPoints: number; jackknifeBlock: number;
    },
  ) => Promise<FineRegistrationReport>;
  octreeTransformDataset?: (
    octreeDir: string, outDir: string, name: string, matrix: number[], record?: Record<string, unknown>,
  ) => Promise<{ outDir: string; pointCount: number; tileCount: number; durationMs: number }>;
  octreeStageRunning?: (stage: string) => Promise<boolean>;
}

type Busy = 'measure' | 'apply' | null;

export default function FineRegistrationPanel() {
  const { octree, octreeList, api, dirty, refreshDatasets, setRegistrationError } = useOctreeShell();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  const [referenceDir, setReferenceDir] = useState('');
  const [movingDir, setMovingDir] = useState('');
  const [init, setInit] = useState<RegisterInitMode>(FINE_REG_DEFAULTS.init);
  const [dx, setDx] = useState('0');
  const [dy, setDy] = useState('0');
  const [dz, setDz] = useState('0');
  const [yaw, setYaw] = useState('0');
  const [searchRadius, setSearchRadius] = useState(String(FINE_REG_DEFAULTS.searchRadius));
  const [yawRange, setYawRange] = useState(String(FINE_REG_DEFAULTS.yawRangeDeg));
  const [featureVoxel, setFeatureVoxel] = useState(String(FINE_REG_DEFAULTS.featureVoxel));
  const [method, setMethod] = useState<RegisterMethod>(FINE_REG_DEFAULTS.method);
  const [kernel, setKernel] = useState<RegisterKernel>(FINE_REG_DEFAULTS.kernel);
  const [dof, setDof] = useState<RegisterDof>(FINE_REG_DEFAULTS.dof);
  const [voxelCm, setVoxelCm] = useState(String(FINE_REG_DEFAULTS.voxelCm));
  const [levels, setLevels] = useState(String(FINE_REG_DEFAULTS.levels));
  const [maxCorr, setMaxCorr] = useState(String(FINE_REG_DEFAULTS.maxCorrDist));
  const [maxIters, setMaxIters] = useState(String(FINE_REG_DEFAULTS.maxIters));
  const [normalK, setNormalK] = useState(String(FINE_REG_DEFAULTS.normalK));
  const [maxAngle, setMaxAngle] = useState(String(FINE_REG_DEFAULTS.maxNormalAngleDeg));
  const [floorMm, setFloorMm] = useState(String(FINE_REG_DEFAULTS.kernelFloorMm));
  const [maxPoints, setMaxPoints] = useState(String(FINE_REG_DEFAULTS.maxPoints));
  const [advanced, setAdvanced] = useState(false);
  const [copyName, setCopyName] = useState('');

  const [busy, setBusy] = useState<Busy>(null);
  const [pct, setPct] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [orphanRun, setOrphanRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [result, setResult] = useState<FineRegistrationReport | null>(null);

  // The moving cloud defaults to the open one — it is the one being
  // worked on — and the reference to the first other dataset.
  useEffect(() => {
    if (octreeList.length === 0) return;
    if (!movingDir || !findDir(octreeList, movingDir)) {
      setMovingDir((findDir(octreeList, octree?.dir) ?? octreeList[0]).dir);
    }
  }, [octreeList, octree?.dir, movingDir]);
  const referenceCandidates = octreeList.filter((e) => !sameDir(e.dir, movingDir));
  useEffect(() => {
    if (referenceDir && referenceCandidates.some((e) => sameDir(e.dir, referenceDir))) return;
    setReferenceDir(referenceCandidates[0]?.dir ?? '');
  }, [referenceDir, referenceCandidates]);

  const referenceEntry = findDir(octreeList, referenceDir);
  const movingEntry = findDir(octreeList, movingDir);
  const referenceName = referenceEntry?.name ?? referenceDir;
  const movingName = movingEntry?.name ?? movingDir;
  const movingIsOpen = sameDir(movingDir, octree?.dir);

  // Progress on the run's own channel, and its Stop.
  useEffect(() => {
    if (!busy) return;
    const stage = busy === 'measure' ? REGISTER_STAGE : TRANSFORM_STAGE;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    onOctreeProgress((s, p) => { if (s === stage) setPct(p); })
      .then((u) => { if (cancelled) u(); else unsub = u; });
    return () => { cancelled = true; unsub?.(); };
  }, [busy]);
  const stop = useCallback(() => {
    setStopping(true);
    cancelStage(busy === 'apply' ? TRANSFORM_STAGE : REGISTER_STAGE);
  }, [busy]);
  // A run this panel did not start — the page was reloaded under one.
  useEffect(() => {
    if (!desktop?.octreeStageRunning || busy) return;
    let alive = true;
    const ask = desktop.octreeStageRunning;
    const poll = async () => {
      try { const r = await ask(REGISTER_STAGE); if (alive) setOrphanRun(r); } catch { /* not in this build */ }
    };
    void poll();
    const t = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [desktop, busy]);

  const saveOpenIfNeeded = useCallback(async () => {
    if (dirty && api) await api.save();
  }, [dirty, api]);

  // ---- Measure -----------------------------------------------------
  const measure = useCallback(async () => {
    if (!desktop?.octreeRegister || !referenceDir || !movingDir || sameDir(referenceDir, movingDir)) return;
    setBusy('measure'); setError(null); setNote(null); setPct(0); setStopping(false); setResult(null);
    try {
      // The clouds are read from disk: the open one's edits go there first.
      await saveOpenIfNeeded();
      const r = await desktop.octreeRegister(referenceDir, movingDir, {
        mode: init,
        dx: parseNum(dx, 0), dy: parseNum(dy, 0), dz: parseNum(dz, 0), yawDeg: parseNum(yaw, 0),
        searchRadius: Math.min(500, Math.max(1, parseNum(searchRadius, FINE_REG_DEFAULTS.searchRadius))),
        yawRangeDeg: Math.min(180, Math.max(0, parseNum(yawRange, FINE_REG_DEFAULTS.yawRangeDeg))),
        dtmCell: FINE_REG_DEFAULTS.dtmCell,
        featureVoxel: Math.max(0.02, parseNum(featureVoxel, FINE_REG_DEFAULTS.featureVoxel)),
      }, {
        method, kernel, dof,
        voxel: Math.max(0.005, parseNum(voxelCm, FINE_REG_DEFAULTS.voxelCm)) / 100,
        levels: Math.min(8, parseCount(levels, FINE_REG_DEFAULTS.levels)),
        maxCorrDist: Math.max(0.01, parseNum(maxCorr, FINE_REG_DEFAULTS.maxCorrDist)),
        maxIters: parseCount(maxIters, FINE_REG_DEFAULTS.maxIters),
        normalK: parseCount(normalK, FINE_REG_DEFAULTS.normalK, 4),
        maxNormalAngleDeg: Math.min(180, Math.max(1, parseNum(maxAngle, FINE_REG_DEFAULTS.maxNormalAngleDeg))),
        kernelFloor: Math.max(0, parseNum(floorMm, FINE_REG_DEFAULTS.kernelFloorMm)) / 1000,
        maxPoints: parseCount(maxPoints, FINE_REG_DEFAULTS.maxPoints, 1000),
        jackknifeBlock: FINE_REG_DEFAULTS.jackknifeBlock,
      });
      setResult(r);
      // The M3C2 panel can take this as its registration error.
      setRegistrationError({ metres: r.report.positionStdErr, movingName: r.movingName, referenceName: r.referenceName });
      if (!copyName.trim()) setCopyName(defaultCopyName(r.movingName));
      const v = constraintVerdict(r.report.condition, r.report.weakest);
      setNote(`Measured in ${r.seconds.toFixed(1)} s over ${r.movingPoints.toLocaleString()} moving and ${r.referencePoints.toLocaleString()} reference cells: `
        + `${movingName} is off by ${describeTranslation(r.report.translation)}; ${v.label}. Nothing has moved.`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (m.startsWith('Stopped')) setNote(m); else setError(m);
    } finally {
      setBusy(null); setStopping(false); setPct(0);
    }
  }, [desktop, referenceDir, movingDir, init, dx, dy, dz, yaw, searchRadius, yawRange, featureVoxel, method, kernel, dof, voxelCm, levels,
    maxCorr, maxIters, normalK, maxAngle, floorMm, maxPoints, saveOpenIfNeeded, copyName, movingName, setRegistrationError]);

  // ---- Apply -------------------------------------------------------
  const apply = useCallback(async () => {
    if (!desktop?.octreeTransformDataset || !result || !movingDir) return;
    const name = (copyName.trim() || defaultCopyName(result.movingName));
    setBusy('apply'); setError(null); setNote(null); setPct(0); setStopping(false);
    try {
      if (movingIsOpen) await saveOpenIfNeeded();
      const out = await desktop.octreeTransformDataset(movingDir, copyOutDir(movingDir, name), name, result.matrix, {
        referenceDir: result.referenceDir,
        referenceName: result.referenceName,
        initMode: result.initMode,
        rmse: result.report.rmse,
        sigma: result.report.sigma,
        inliers: result.report.inliers,
        translation: result.report.translation,
        translationStdErr: result.report.translationStdErr,
        rotationDeg: result.report.rotationDeg,
        rotationStdErrDeg: result.report.rotationStdErrDeg,
        wellConstrained: result.report.wellConstrained,
      });
      await refreshDatasets?.();
      setNote(`Wrote ${name}: ${out.pointCount.toLocaleString()} points moved onto ${result.referenceName}, every label kept, the move recorded in its metadata. `
        + `${result.movingName} itself is untouched — remove it, or keep it, in Layers.`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (m.startsWith('Stopped')) setNote(m); else setError(m);
    } finally {
      setBusy(null); setStopping(false); setPct(0);
    }
  }, [desktop, result, movingDir, copyName, movingIsOpen, saveOpenIfNeeded, refreshDatasets]);

  /** Everything this panel produced, gone: the measurement and its
   *  note. It never wrote into a cloud; a copy it wrote is a dataset in
   *  Layers, removed there. */
  const clearAll = useCallback(() => {
    setResult(null); setError(null); setNote(null);
    setRegistrationError(null);
  }, [setRegistrationError]);

  // ---- Derived display ---------------------------------------------
  const edge = useMemo(() => {
    if (!result || !movingEntry) return 0;
    return rotationAtPlotEdge(result.report.rotationDeg, movingEntry.bboxMin, movingEntry.bboxMax);
  }, [result, movingEntry]);
  const verdict = result ? constraintVerdict(result.report.condition, result.report.weakest) : null;
  const worth = !!result && !!movingEntry && isWorthApplying(result, movingEntry.bboxMin, movingEntry.bboxMax);
  const canMeasure = !!desktop?.octreeRegister && !!referenceDir && !!movingDir && !sameDir(referenceDir, movingDir) && !busy && !orphanRun;
  const canApply = !!desktop?.octreeTransformDataset && !!result && !busy && worth;
  const bars = result ? histogramBars(result.report.histBins) : [];

  const select = (value: string, onChange: (v: string) => void, entries: typeof octreeList, empty: string) => (
    entries.length === 0 ? (
      <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e6c068', background: 'rgba(230,192,104,0.08)', border: '1px solid rgba(230,192,104,0.35)', lineHeight: 1.5 }}>
        {empty}
      </div>
    ) : (
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={!!busy}
        className="mono text-[11px] rounded-md px-1.5 py-1"
        style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
        {entries.map((e) => (
          <option key={e.dir} value={e.dir}>
            {e.name}{sameDir(e.dir, octree?.dir) ? ' · open' : ''} · {e.pointCount.toLocaleString()} pts
          </option>
        ))}
      </select>
    )
  );
  const choice = <T extends string>(value: T, onChange: (v: T) => void, options: Array<[T, string, string]>) => (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} disabled={!!busy}
      className="mono text-[10.5px] rounded-md px-1.5 py-1"
      style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
      {options.map(([v, label, title]) => <option key={v} value={v} title={title}>{label}</option>)}
    </select>
  );

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
        Two datasets of one plot — two epochs, two sensors — put on each other in six degrees of freedom from
        their surfaces: symmetric point-to-plane ICP over a pyramid of decimations, a robust kernel, and at the
        solution the standard error of every parameter and what the geometry did not constrain. The reference
        is taken to be right; the moving cloud is written, moved, as a new dataset.
      </div>

      {/* -------- 1. The two clouds -------- */}
      <Section title="1. Reference and moving" sub="the cloud that stays → the cloud that moves">
        <label className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Moving — the cloud that is off, and moves</label>
        {select(movingDir, setMovingDir, octreeList, 'No dataset in the project yet — import one (Layers → Import).')}
        <label className="mono text-[10px] mt-1" style={{ color: 'var(--text-dim)' }}>Reference — taken to be right</label>
        {select(referenceDir, setReferenceDir, referenceCandidates, 'No other cloud in the project. The reference is the other epoch or sensor over the same plot — import it and it appears here.')}
      </Section>

      {/* -------- 2. Start -------- */}
      <Section title="2. Start" sub="where the fit begins — within the correspondence reach, or searched for">
        {choice<RegisterInitMode>(init, setInit, [
          ['current', 'As they stand', 'The clouds already sit within the correspondence reach of each other — two georeferenced epochs, a plot after the Cloud registration shift.'],
          ['auto', 'Automatic coarse search by stems and crowns', 'The moving cloud’s stems and crown tops voted onto the reference’s over the search radius and a fan of yaw, refined stem to stem, the height from the two grounds. Both clouds need a ground classification.'],
          ['skeleton', 'The stored skeleton alignment', 'The Cloud registration panel’s measurement beside the moving cloud, against this reference, inverted.'],
          ['manual', 'A manual offset', 'An offset you know — from a GNSS log, a survey, another tool — about the moving cloud’s centre.'],
          ['features', 'Global search by surface features', 'FPFH histograms on both clouds whole, paired; transforms tried from triples of pairs that agree with each other on their distances, the pairs agreeing with the most others first; the hypothesis chosen by how much of the cloud lands on the reference: any heading, any offset. No ground classification needed. A start only.'],
        ])}
        {init === 'features' && (
          <div className="flex items-end gap-1.5">
            <NumberField label="Feature cell (m)" value={featureVoxel} onChange={setFeatureVoxel} width={120}
              title="The decimation the features are computed on; the histograms gather neighbours within five cells. 0.3 m for a plot; 0.15 for thin stems, larger for a long walk." />
          </div>
        )}
        {init === 'auto' && (
          <div className="flex items-end gap-1.5">
            <NumberField label="Search radius (m)" value={searchRadius} onChange={setSearchRadius} width={120}
              title="How far the moving cloud may have to move. 30 m covers a plot centre from a handheld GNSS; 1–500." />
            <NumberField label="Yaw ± (°)" value={yawRange} onChange={setYawRange} width={88}
              title="The fan of headings tried, in quarter-degree steps to ±10°, degree steps beyond; 180 for a heading unknown." />
          </div>
        )}
        {init === 'manual' && (
          <div className="flex items-end gap-1.5">
            <NumberField label="East (m)" value={dx} onChange={setDx} width={80} title="Positive east." />
            <NumberField label="North (m)" value={dy} onChange={setDy} width={80} title="Positive north." />
            <NumberField label="Up (m)" value={dz} onChange={setDz} width={72} title="Positive up." />
            <NumberField label="Yaw (°)" value={yaw} onChange={setYaw} width={72} title="Counter-clockwise from above, about the moving cloud's centre." />
          </div>
        )}
      </Section>

      {/* -------- 3. Measure -------- */}
      <Section title="3. Measure" sub="the transform, its error bars, and what the geometry constrained">
        <div className="flex items-end gap-1.5 flex-wrap">
          <label className="flex flex-col gap-0.5" title="The objective. Symmetric (Rusinkiewicz 2019) uses both clouds' normals and converges from further; point-to-plane is the classic; point-to-point needs no surfaces.">
            <span className="mono" style={{ fontSize: 9, color: 'var(--text-mute)' }}>Objective</span>
            {choice<RegisterMethod>(method, setMethod, [['symmetric', 'symmetric', ''], ['pointToPlane', 'point-to-plane', ''], ['gicp', 'plane-to-plane (GICP)', ''], ['pointToPoint', 'point-to-point', '']])}
          </label>
          <label className="flex flex-col gap-0.5" title="Full: rotation and translation. Levelled: translation and yaw only — a levelled instrument stays level. Translation: no rotation.">
            <span className="mono" style={{ fontSize: 9, color: 'var(--text-mute)' }}>Freedom</span>
            {choice<RegisterDof>(dof, setDof, [['full', '6 — full', ''], ['levelled', '4 — levelled (xyz + yaw)', ''], ['translation', '3 — translation', '']])}
          </label>
          <NumberField label="Finest cell (cm)" value={voxelCm} onChange={setVoxelCm} width={100}
            title="The finest decimation; the coarser levels are 2×, 4×, 8× it. 5 cm is fast and sub-millimetre on a plot; 2 cm for the last tenth." />
          <NumberField label="Reach (m)" value={maxCorr} onChange={setMaxCorr} width={80}
            title="How far a correspondence may reach at the coarsest level; halved per level. Larger than the start is off by." />
        </div>
        <button className="mono text-[9.5px] text-left" style={{ color: 'var(--text-mute)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
          onClick={() => setAdvanced((a) => !a)}>{advanced ? '▾' : '▸'} more settings</button>
        {advanced && (
          <div className="flex items-end gap-1.5 flex-wrap">
            <label className="flex flex-col gap-0.5" title="The robust weight. Welsch and Cauchy are smooth; Tukey cuts hard; none weighs every pair the same.">
              <span className="mono" style={{ fontSize: 9, color: 'var(--text-mute)' }}>Kernel</span>
              {choice<RegisterKernel>(kernel, setKernel, [['welsch', 'Welsch', ''], ['cauchy', 'Cauchy', ''], ['tukey', 'Tukey', ''], ['none', 'none', '']])}
            </label>
            <NumberField label="Levels" value={levels} onChange={setLevels} width={60} title="Pyramid levels, 1–8." />
            <NumberField label="Iterations / level" value={maxIters} onChange={setMaxIters} width={100} title="At most, per level." />
            <NumberField label="Normal k" value={normalK} onChange={setNormalK} width={72} title="Neighbours for the normals." />
            <NumberField label="Normal angle (°)" value={maxAngle} onChange={setMaxAngle} width={100} title="Pairs whose normals disagree by more are dropped." />
            <NumberField label="Noise floor (mm)" value={floorMm} onChange={setFloorMm} width={100} title="The robust scale never shrinks below this: the instruments' noise." />
            <NumberField label="Points / level" value={maxPoints} onChange={setMaxPoints} width={100} title="At most, per cloud; more are thinned." />
          </div>
        )}
        <div className="flex gap-1.5">
          <button className="btn !h-7 mono text-[11px] justify-center flex-1" disabled={!canMeasure} onClick={measure}
            title="Read both clouds over their overlap, fit coarse to fine, report the transform with its standard errors. Nothing moves.">
            {busy === 'measure' ? `Measuring… ${Math.round(pct * 100)} %` : result ? 'Measure again' : 'Measure'}
          </button>
          {(busy || orphanRun) && (
            <button className="btn !h-7 mono text-[11px]" onClick={stop} disabled={!canCancel() || stopping}
              title="Stop the run. A stopped measurement changes nothing; a stopped copy is removed.">
              {stopping ? 'Stopping…' : 'Cancel'}
            </button>
          )}
        </div>
        {busy === 'measure' && (
          <>
            <ProgressBar pct={pct} />
            <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{registerStageLabel(pct, init)}</div>
          </>
        )}
        {orphanRun && !busy && (
          <div className="mono text-[9.5px]" style={{ color: '#e6c068' }}>A registration started before this panel opened is still running.</div>
        )}
      </Section>

      {/* -------- Result -------- */}
      {result && verdict && (
        <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="mono text-[10px]" style={{ color: 'var(--text)' }}>
            <span style={{ color: 'var(--accent)' }}>{result.movingName}</span> onto <span style={{ color: 'var(--accent)' }}>{result.referenceName}</span>
            {' · '}{result.report.converged ? 'converged' : 'did not converge'} in {result.report.iterations} iterations over {result.report.levels.length} levels
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
            <span>Move at the cloud's centre</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{describeTranslation(result.report.translation)}</span>
            <span>east</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{plusMinus(result.report.translation[0], quotedStdErr(result.report.translationStdErr[0], result.report.translationStdErrBlocks[0]), 'm')}</span>
            <span>north</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{plusMinus(result.report.translation[1], quotedStdErr(result.report.translationStdErr[1], result.report.translationStdErrBlocks[1]), 'm')}</span>
            <span>up</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{plusMinus(result.report.translation[2], quotedStdErr(result.report.translationStdErr[2], result.report.translationStdErrBlocks[2]), 'm')}</span>
            <span>Roll · pitch · yaw</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{plusMinus(result.report.rotationDeg[0], quotedStdErr(result.report.rotationStdErrDeg[0], result.report.rotationStdErrDegBlocks[0]), 'deg')} · {plusMinus(result.report.rotationDeg[1], quotedStdErr(result.report.rotationStdErrDeg[1], result.report.rotationStdErrDegBlocks[1]), 'deg')} · {plusMinus(result.report.rotationDeg[2], quotedStdErr(result.report.rotationStdErrDeg[2], result.report.rotationStdErrDegBlocks[2]), 'deg')}</span>
            <span>Error bars</span><span style={{ color: 'var(--text)', textAlign: 'right' }} title="The larger of the independent-residual standard error and the spatial block jackknife's, which counts what neighbouring pairs share once.">{Number.isFinite(result.report.translationStdErrBlocks[0]) ? `jackknife over ${result.report.jackknifeBlocks} blocks` : 'independent residuals (too few blocks for a jackknife)'}</span>
            <span>A moved point's uncertainty</span><span style={{ color: 'var(--text)', textAlign: 'right' }} title="At the cloud's RMS radius: the error bars combined. M3C2's registration error.">{lengthText(result.report.positionStdErr)}</span>
            <span>Rotation at the plot's edge</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{lengthText(edge)}</span>
            <span>Residual RMS · median · robust σ</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{lengthText(result.report.rmse)} · {lengthText(result.report.medianAbs)} · {lengthText(result.report.sigma)}</span>
            <span>Inliers · overlap</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{result.report.inliers.toLocaleString()} ({(result.report.inlierFraction * 100).toFixed(1)} %) · {(result.report.overlapFraction * 100).toFixed(1) } %</span>
            <span>Constraint</span><span style={{ color: verdict.color, textAlign: 'right' }}>{Number.isFinite(result.report.condition) ? `κ ${result.report.condition < 1000 ? result.report.condition.toFixed(0) : result.report.condition.toExponential(1)} · ` : ''}{verdict.label}</span>
            {result.global && (
              <>
                <span>Feature search</span>
                <span style={{ color: 'var(--text)', textAlign: 'right' }}>
                  {(result.global.overlap * 100).toFixed(0)} % of the cloud on the reference · {result.global.inliers} of {result.global.correspondences} pairs · {result.global.iterations.toLocaleString()} draws
                </span>
              </>
            )}
            {result.coarse && (
              <>
                <span>Coarse search</span>
                <span style={{ color: 'var(--text)', textAlign: 'right' }}>
                  {result.coarse.dx >= 0 ? '+' : '−'}{Math.abs(result.coarse.dx).toFixed(2)} m, {result.coarse.dy >= 0 ? '+' : '−'}{Math.abs(result.coarse.dy).toFixed(2)} m, {result.coarse.yawDeg.toFixed(2)}° · {result.coarse.matchedTrees} stems matched · {coarseVerdict(result.coarse.confidence)}
                </span>
              </>
            )}
          </div>
          {!verdict.ok && (
            <div className="mono text-[9.5px]" style={{ color: verdict.color, lineHeight: 1.5 }}>
              The fit converged, but the clouds' geometry does not fix {result.report.weakest}: that part of the transform is
              where the solver left it, not where the plot is. A flat field without stems does this. Check it by eye before applying.
            </div>
          )}
          <div className="flex items-end gap-px" style={{ height: 36 }} title={`Signed plane residuals of the final pairs, ${(result.report.histWidth * 1000).toFixed(2)} mm per bar over ±${(-result.report.histMin * 1000).toFixed(0)} mm; the marked bar holds zero.`}>
            {bars.map((b, i) => (
              <div key={i} style={{ flex: 1, height: `${Math.max(2, b.h * 100)}%`, background: b.centre ? 'var(--accent)' : 'var(--text-mute)', opacity: b.centre ? 1 : 0.55 }} />
            ))}
          </div>
          <details>
            <summary className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', cursor: 'pointer' }}>levels</summary>
            <table className="mono text-[9.5px] mt-1" style={{ color: 'var(--text-mute)', borderCollapse: 'collapse' }}>
              <thead><tr>{['cell', 'reach', 'ref', 'moving', 'iters', 'RMS', 'inliers'].map((h) => <th key={h} style={{ textAlign: 'right', paddingRight: 8, fontWeight: 400 }}>{h}</th>)}</tr></thead>
              <tbody>
                {result.report.levels.map((l, i) => (
                  <tr key={i} style={{ color: 'var(--text)' }}>
                    <td style={{ textAlign: 'right', paddingRight: 8 }}>{(l.voxel * 100).toFixed(0)} cm</td>
                    <td style={{ textAlign: 'right', paddingRight: 8 }}>{l.corrDist.toFixed(2)} m</td>
                    <td style={{ textAlign: 'right', paddingRight: 8 }}>{l.referencePoints.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', paddingRight: 8 }}>{l.movingPoints.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', paddingRight: 8 }}>{l.iterations}{l.converged ? '' : ' ·'}</td>
                    <td style={{ textAlign: 'right', paddingRight: 8 }}>{lengthText(l.rmse)}</td>
                    <td style={{ textAlign: 'right', paddingRight: 8 }}>{l.inliers.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}

      {/* -------- 4. Apply -------- */}
      <Section title="4. Apply" sub="write the moving cloud, moved, as a new dataset">
        <NumberField label="Name of the moved copy" value={copyName} onChange={setCopyName}
          placeholder={result ? defaultCopyName(result.movingName) : 'measure first'}
          title="A new dataset beside the source under the project's octrees directory. The source is never touched." />
        <div className="flex gap-1.5">
          <button className="btn !h-7 mono text-[11px] justify-center flex-1" disabled={!canApply} onClick={() => void apply()}
            title="Every point through the transform onto a fresh millimetre grid; deleted points gone, tree ids, labels and deadwood overrides baked in, every extra column kept, the CRS carried, species and review copied; the transform and the fit's figures recorded under `registration` in the copy's metadata.">
            {busy === 'apply' ? `Writing… ${Math.round(pct * 100)} %` : result ? (worth ? `Write ${movingName} moved onto ${result.referenceName}` : 'Nothing to move — under half a millimetre') : 'Write the moved copy — measure first'}
          </button>
          <button className="btn !h-7 mono text-[11px] justify-center" disabled={!result || !!busy} onClick={clearAll} title="Drop the measurement.">Clear</button>
        </div>
        {busy === 'apply' && <ProgressBar pct={pct} />}
        <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          The copy is a rewrite: each coordinate lands on a new millimetre grid, which is the only loss. The source stays — removing the copy in Layers undoes the move.
        </div>
      </Section>

      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0817b', background: 'rgba(224,129,123,0.08)', border: '1px solid rgba(224,129,123,0.35)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      )}
      {note && !error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: 'var(--text)', background: 'var(--wash-1)', border: '1px solid var(--line)', lineHeight: 1.5 }}>
          {note}
        </div>
      )}
    </div>
  );
}

// ---------------- building blocks ----------------

function Section({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
      <div className="flex items-baseline gap-2">
        <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>{title}</span>
        <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{sub}</span>
      </div>
      {children}
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height: 3, background: 'var(--wash-3)' }}>
      <div style={{ width: `${(Math.max(0, Math.min(1, pct)) * 100).toFixed(1)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.15s' }} />
    </div>
  );
}
