// Cloud registration — two clouds of one plot, put on each other.
//
// A TLS plot and the HeliALS epoch flown over it are georeferenced by
// different people with different instruments, and the two can stand
// metres apart — tens, when a plot centre came from a handheld GNSS
// under canopy. Every tool here that pairs two clouds (Tree Skeleton
// Transfer, Tree growth, M3C2, the ALS ↔ TLS join) assumes they sit on
// each other, and none of them can tell a misregistration from a real
// difference: the transfer labels nothing right, growth reads as
// blowdown, M3C2 paints the whole plot as change.
//
// This panel measures the horizontal offset and fixes it.
//
//   MEASURE — src-tauri skelalign.rs. The REFERENCE cloud's tree
//   skeletons (built in Tree Skeleton Transfer, step 1) are voted onto
//   the TARGET's vertical structures and canopy tops: a shift over tens
//   of metres and a small rotation, refined tree by tree. THE
//   REFERENCE IS TAKEN TO BE RIGHT — a TLS plot's registration is the
//   tighter of the two — so the measurement is stored beside the
//   target (skeleton_alignment.json) as the transform from the
//   skeletons onto the target's trees.
//
//   CHECK — the reference's skeletons drawn over the target through
//   the transform, in the viewport or in the Compare view, where the
//   eye sees at once whether they stand on the stems.
//
//   APPLY — the target is moved by the inverse: a georeference shift
//   (octree_shift_georeference) that changes the offset the points are
//   quantised against, and nothing else. No point is rewritten, so it
//   is lossless and instant, and the opposite shift undoes it. An
//   offset cannot rotate, so the rotation is reported at the plot's
//   edge and stays in the stored alignment, which the transfer and the
//   Compare take the skeletons through.
//
// Registering is its own job, so it is its own panel: the transfer
// panel labels, this one moves clouds, and neither has to explain the
// other's controls.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOctreeShell, type SkeletonAlignment, type AlignmentParam } from './OctreeShellContext';
import { onOctreeProgress } from '../../persistence/octreeStore';
import { cancelStage, canCancel } from '../../ui/cancelStage';
import { confirmDialog } from '../../ui/dialogs';
import { sameDir, findDir } from '../../persistence/datasetDirs';
import type { SkeletonPlanar } from '../../persistence/skeletonPlanar';
import { guessFrame, suggestFrames } from './heightFrames';
import NumberField, { parseNum } from '../NumberField';
import {
  ALIGN_STAGE, alignStageLabel, confidenceVerdict, degrees, describeShift, halfExtent,
  isWorthMoving, rotationAtEdge, shiftOntoReference,
} from './registration';

interface SkeletonInfo {
  pointCount: number; treeCount: number; skeletonSpacing: number;
  bytes: number; modifiedAt: number; path: string;
}
interface ShiftResult { dx: number; dy: number; offset: [number, number, number]; total: [number, number] }

interface Desktop {
  octreeSkeletonInfo?: (octreeDir: string) => Promise<SkeletonInfo | null>;
  octreeReadSkeletons?: (octreeDir: string) => Promise<SkeletonPlanar | null>;
  octreeSkeletonAlign?: (
    baselineDir: string, targetDir: string,
    opts?: { dtmCell?: number; searchRadius?: number; allowRotation?: boolean },
  ) => Promise<SkeletonAlignment>;
  octreeSkeletonAlignmentRead?: (targetDir: string) => Promise<SkeletonAlignment | null>;
  octreeSkeletonAlignmentClear?: (targetDir: string) => Promise<boolean>;
  octreeShiftGeoreference?: (octreeDir: string, dx: number, dy: number, note?: string) => Promise<ShiftResult>;
  octreeStageRunning?: (stage: string) => Promise<boolean>;
}

type Busy = 'measure' | 'shift' | 'view' | 'clear' | null;

function param(a: SkeletonAlignment): AlignmentParam {
  return { dx: a.dx, dy: a.dy, theta: a.theta, cx: a.cx, cy: a.cy };
}

export default function RegistrationPanel() {
  const {
    octree, octreeList, api, dirty, skeletonOverlay, setSkeletonOverlay, compare, setCompare,
    togglePanel, refreshDatasets, reloadActiveOctree,
  } = useOctreeShell();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  const [referenceDir, setReferenceDir] = useState('');
  // Until the user picks one, the reference follows the default — the
  // first cloud with skeletons, which arrives a moment after the list.
  const [refChosen, setRefChosen] = useState(false);
  const [targetDir, setTargetDir] = useState('');
  const [radiusText, setRadiusText] = useState('30');
  const [rotate, setRotate] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [pct, setPct] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [orphanRun, setOrphanRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [alignment, setAlignment] = useState<SkeletonAlignment | null>(null);
  const [through, setThrough] = useState(true);
  const [handEast, setHandEast] = useState('0');
  const [handNorth, setHandNorth] = useState('0');

  // Which clouds have skeletons: the reference has to, and the default
  // reference is the first one that does.
  const [info, setInfo] = useState<Record<string, SkeletonInfo | null>>({});
  const refreshInfo = useCallback(async () => {
    if (!desktop?.octreeSkeletonInfo) return;
    const out: Record<string, SkeletonInfo | null> = {};
    for (const e of octreeList) {
      try { out[e.dir] = await desktop.octreeSkeletonInfo(e.dir); } catch { out[e.dir] = null; }
    }
    setInfo(out);
  }, [desktop, octreeList]);
  useEffect(() => { void refreshInfo(); }, [refreshInfo]);

  useEffect(() => {
    if (octreeList.length === 0) return;
    if (refChosen && referenceDir && findDir(octreeList, referenceDir)) return;
    const withSkeletons = octreeList.find((e) => info[e.dir]);
    const next = (withSkeletons ?? findDir(octreeList, octree?.dir) ?? octreeList[0]).dir;
    if (!sameDir(next, referenceDir)) setReferenceDir(next);
  }, [octreeList, info, referenceDir, refChosen, octree]);
  const chooseReference = useCallback((dir: string) => { setRefChosen(true); setReferenceDir(dir); }, []);
  const targetCandidates = octreeList.filter((e) => !sameDir(e.dir, referenceDir));
  useEffect(() => {
    const ok = targetDir && targetCandidates.some((e) => sameDir(e.dir, targetDir));
    if (ok) return;
    setTargetDir((findDir(targetCandidates, octree?.dir) ?? targetCandidates[0])?.dir ?? '');
  }, [octree?.dir, targetDir, targetCandidates]);

  const referenceEntry = findDir(octreeList, referenceDir);
  const targetEntry = findDir(octreeList, targetDir);
  const referenceName = referenceEntry?.name ?? referenceDir;
  const targetName = targetEntry?.name ?? targetDir;
  const targetIsOpen = sameDir(targetDir, octree?.dir);
  const referenceInfo = referenceDir ? info[referenceDir] : null;
  const frames = suggestFrames(
    referenceEntry ? guessFrame(referenceEntry.bboxMin[2], referenceEntry.bboxMax[2]) : 'unknown',
    targetEntry ? guessFrame(targetEntry.bboxMin[2], targetEntry.bboxMax[2]) : 'unknown',
  );

  // The stored measurement beside the target, whoever made it.
  const readAlignment = useCallback(async (dir: string) => {
    if (!desktop?.octreeSkeletonAlignmentRead || !dir) { setAlignment(null); return; }
    try { setAlignment(await desktop.octreeSkeletonAlignmentRead(dir)); } catch { setAlignment(null); }
  }, [desktop]);
  useEffect(() => { setError(null); setNote(null); void readAlignment(targetDir); }, [targetDir, readAlignment]);

  // Progress on the run's own channel, and its Stop.
  useEffect(() => {
    if (busy !== 'measure') return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    onOctreeProgress((stage, p) => { if (stage === ALIGN_STAGE) setPct(p); })
      .then((u) => { if (cancelled) u(); else unsub = u; });
    return () => { cancelled = true; unsub?.(); };
  }, [busy]);
  const stop = useCallback(() => { setStopping(true); cancelStage(ALIGN_STAGE); }, []);
  // A run this panel did not start — the page was reloaded under one —
  // is shown with the same Stop it would have had.
  useEffect(() => {
    if (!desktop?.octreeStageRunning || busy) return;
    let alive = true;
    const ask = desktop.octreeStageRunning;
    const poll = async () => {
      try { const r = await ask(ALIGN_STAGE); if (alive) setOrphanRun(r); } catch { /* not in this build */ }
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
    if (!desktop?.octreeSkeletonAlign || !referenceDir || !targetDir || sameDir(referenceDir, targetDir)) return;
    setBusy('measure'); setError(null); setNote(null); setPct(0); setStopping(false);
    try {
      // The target's ground classification is read from disk.
      await saveOpenIfNeeded();
      const radius = Math.min(300, Math.max(2, parseNum(radiusText, 30)));
      const a = await desktop.octreeSkeletonAlign(referenceDir, targetDir, {
        searchRadius: radius, allowRotation: rotate, dtmCell: 0.5,
      });
      setAlignment(a);
      setThrough(true);
      const v = confidenceVerdict(a.confidence);
      setNote(`Measured: the skeletons of ${referenceName} reach ${targetName}’s trees after ${describeShift(a.dx, a.dy)}`
        + (Math.abs(a.theta) > 1e-6 ? ` and ${degrees(a.theta).toFixed(2)}°` : '')
        + ` — ${a.matchedTrees} of ${a.treeCount} stems matched, ${v.label}.`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (m.startsWith('Stopped')) setNote(m); else setError(m);
    } finally {
      setBusy(null); setStopping(false); setPct(0);
    }
  }, [desktop, referenceDir, targetDir, radiusText, rotate, saveOpenIfNeeded, referenceName, targetName]);

  // ---- Apply -------------------------------------------------------
  const shift = useCallback(async (dx: number, dy: number, why: string) => {
    if (!desktop?.octreeShiftGeoreference || !targetDir) return;
    if (!isWorthMoving(dx, dy)) { setNote('Nothing to move: the shift is under a millimetre.'); return; }
    setBusy('shift'); setError(null); setNote(null);
    try {
      // The open cloud's edits go to disk before its metadata changes
      // under it, and it is reopened afterwards in its new place.
      if (targetIsOpen) await saveOpenIfNeeded();
      const r = await desktop.octreeShiftGeoreference(targetDir, dx, dy, why);
      // Skeletons on screen were placed in the old frame.
      if (skeletonOverlay) setSkeletonOverlay(null);
      await refreshDatasets?.();
      if (targetIsOpen) await reloadActiveOctree?.();
      await readAlignment(targetDir);
      setNote(`Moved ${targetName} by ${describeShift(dx, dy)}; ${describeShift(r.total[0], r.total[1])} in total since import. `
        + 'No point was rewritten — the georeference offset moved and the points followed. The opposite shift undoes it.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [desktop, targetDir, targetIsOpen, saveOpenIfNeeded, skeletonOverlay, setSkeletonOverlay, refreshDatasets, reloadActiveOctree, readAlignment, targetName]);

  const moved: [number, number] = alignment?.targetShifted ?? [0, 0];
  const hasMoved = isWorthMoving(moved[0], moved[1]);
  const remaining = alignment ? shiftOntoReference(alignment) : null;
  const applyShift = useCallback(() => {
    if (!remaining) return;
    void shift(remaining[0], remaining[1], `onto the skeletons of ${referenceName}`);
  }, [remaining, shift, referenceName]);
  const undoShift = useCallback(() => {
    void shift(-moved[0], -moved[1], 'undo the move onto the reference');
  }, [moved, shift]);
  const moveByHand = useCallback(() => {
    void shift(parseNum(handEast, 0), parseNum(handNorth, 0), 'by hand');
  }, [handEast, handNorth, shift]);

  const forget = useCallback(async () => {
    if (!desktop?.octreeSkeletonAlignmentClear || !targetDir) return;
    if (hasMoved && !await confirmDialog(
      `${targetName} stays where it was moved to — only the measurement is forgotten. Undo the move first if you want it back where it was.\n\nForget the measurement?`,
    )) return;
    setBusy('clear'); setError(null);
    try {
      await desktop.octreeSkeletonAlignmentClear(targetDir);
      setAlignment(null);
      setNote('Forgot the measurement. The skeletons on screen, if any, still stand where the alignment put them until they are shown again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [desktop, targetDir, hasMoved, targetName]);

  // ---- Check -------------------------------------------------------
  const overlayIsReference = !!skeletonOverlay && sameDir(skeletonOverlay.sourceDir, referenceDir);
  const loadSkeletons = useCallback(async (viaAlignment: boolean): Promise<boolean> => {
    if (!desktop?.octreeReadSkeletons || !referenceDir) return false;
    setBusy('view'); setError(null);
    try {
      const p = await desktop.octreeReadSkeletons(referenceDir);
      if (!p) {
        setError(`${referenceName} has no skeletons.bin — build them in Tree Skeleton Transfer, step 1.`);
        return false;
      }
      setSkeletonOverlay({
        origin: p.origin, xyz: p.xyz, treeId: p.treeId, order: p.order, radiusMm: p.radiusMm,
        colorMode: 'tree', sourceDir: referenceDir,
        alignment: viaAlignment && alignment ? param(alignment) : null,
      });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  }, [desktop, referenceDir, referenceName, alignment, setSkeletonOverlay]);

  // The checkbox moves what is already on screen, without reloading it.
  const setThroughLive = useCallback((on: boolean) => {
    setThrough(on);
    if (skeletonOverlay && overlayIsReference) {
      setSkeletonOverlay({ ...skeletonOverlay, alignment: on && alignment ? param(alignment) : null });
    }
  }, [skeletonOverlay, overlayIsReference, alignment, setSkeletonOverlay]);

  const openCompare = useCallback(async () => {
    if (!referenceDir || !targetDir || sameDir(referenceDir, targetDir)) return;
    setError(null);
    try { await saveOpenIfNeeded(); }
    catch (e) { setError(`Could not save the open cloud before comparing: ${e instanceof Error ? e.message : String(e)}`); return; }
    const ok = await loadSkeletons(through);
    setCompare({
      sourceDir: referenceDir, targetDir, colorMode: 'tree_id',
      showSkeleton: ok, skeletonColor: 'tree', hideUnlabeled: false,
      alignHeights: frames.mismatch,
      alignment: through && alignment ? param(alignment) : null,
    });
  }, [referenceDir, targetDir, saveOpenIfNeeded, loadSkeletons, through, setCompare, frames.mismatch, alignment]);

  // ---- Derived display ---------------------------------------------
  const edge = useMemo(() => {
    if (!alignment || !targetEntry) return 0;
    return rotationAtEdge(alignment.theta, halfExtent(targetEntry.bboxMin, targetEntry.bboxMax));
  }, [alignment, targetEntry]);
  const verdict = alignment ? confidenceVerdict(alignment.confidence) : null;
  const measuredFrom = alignment ? (findDir(octreeList, alignment.baselineDir)?.name ?? alignment.baselineDir.split(/[\\/]/).pop() ?? alignment.baselineDir) : '';
  const measuredFromOther = !!alignment && !sameDir(alignment.baselineDir, referenceDir);
  const canMeasure = !!desktop?.octreeSkeletonAlign && !!referenceDir && !!targetDir && !sameDir(referenceDir, targetDir) && !busy && !orphanRun;
  const canShift = !!desktop?.octreeShiftGeoreference && !!targetDir && !busy;
  const openName = octree ? (findDir(octreeList, octree.dir)?.name ?? 'the open cloud') : null;

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
            {e.name}{sameDir(e.dir, octree?.dir) ? ' · open' : ''}{info[e.dir] ? ` · ${info[e.dir]!.treeCount} skeletons` : ''}
          </option>
        ))}
      </select>
    )
  );

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
        Two clouds of one plot that do not sit on each other. The reference&rsquo;s tree skeletons are matched
        to the target&rsquo;s stems and crowns; the target is then moved onto the reference by a lossless
        georeference shift. The reference is taken to be right.
      </div>

      {/* -------- 1. The two clouds -------- */}
      <Section title="1. Reference and target" sub="skeletons → the cloud to move">
        <label className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Reference — the cloud with skeletons, taken to be right</label>
        {select(referenceDir, chooseReference, octreeList, 'No dataset in the project yet — import one (Layers → Import).')}
        {referenceDir && !referenceInfo && (
          <div className="flex items-center gap-1.5 mono text-[9.5px] px-2 py-1.5 rounded-md" style={{ color: 'var(--text)', background: 'rgba(230,192,104,0.08)', border: '1px solid rgba(230,192,104,0.35)', lineHeight: 1.5 }}>
            <span className="flex-1">
              <b style={{ color: '#e6c068' }}>{referenceName} has no skeletons.</b> The measurement works from them — build them in Tree Skeleton Transfer, step 1, with this cloud as the baseline.
            </span>
            <button className="btn !h-6 mono text-[10px]" onClick={() => togglePanel('tst')}>Open TST</button>
          </div>
        )}
        {referenceInfo && (
          <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
            {referenceInfo.treeCount} skeletons · {referenceInfo.pointCount.toLocaleString()} points · spacing {(referenceInfo.skeletonSpacing * 1000).toFixed(0)} mm
          </div>
        )}
        <label className="mono text-[10px] mt-1" style={{ color: 'var(--text-dim)' }}>Target — the cloud that is off, and moves</label>
        {select(targetDir, setTargetDir, targetCandidates, 'No other cloud in the project. The target is the other epoch or sensor over the same plot — import it and it appears here.')}
        {targetDir && (
          <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
            The target needs a ground classification (class 2) — its trees are read as height above ground. Terrain panel, if it has none.
            {frames.mismatch && ' The two clouds are not in the same height frame; the Compare aligns heights for the check, and the shift is horizontal only.'}
          </div>
        )}
      </Section>

      {/* -------- 2. Measure -------- */}
      <Section title="2. Measure" sub="the offset from the skeletons to the target's trees">
        <div className="flex items-end gap-2">
          <NumberField label="Search radius (m)" value={radiusText} onChange={setRadiusText} width={120}
            title="How far from where they stand the skeletons may have to move to reach the target's trees. 30 m covers a plot centre from a handheld GNSS; 2–300." />
          <label className="mono text-[10px] flex items-center gap-1.5 pb-1.5" style={{ color: 'var(--text-dim)' }}
            title="Also look for a rotation of up to ±3°, in quarter-degree steps, and refine it. Off: translation only.">
            <input type="checkbox" checked={rotate} disabled={!!busy} onChange={(e) => setRotate(e.target.checked)} />
            allow a small rotation
          </label>
        </div>
        <div className="flex gap-1.5">
          <button className="btn !h-7 mono text-[11px] justify-center flex-1" disabled={!canMeasure} onClick={measure}
            title="Read the reference's skeletons and the target's cloud, vote for the shift, refine tree by tree; store the result beside the target. Nothing moves yet.">
            {busy === 'measure' ? `Measuring… ${Math.round(pct * 100)} %` : alignment ? 'Measure again' : 'Measure'}
          </button>
          {(busy === 'measure' || orphanRun) && (
            <button className="btn !h-7 mono text-[11px]" onClick={stop} disabled={!canCancel() || stopping}
              title="Stop the run — the measurement is written only at the end, so a stopped run changes nothing">
              {stopping ? 'Stopping…' : 'Cancel'}
            </button>
          )}
        </div>
        {busy === 'measure' && (
          <>
            <ProgressBar pct={pct} />
            <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{alignStageLabel(pct)}</div>
          </>
        )}
        {orphanRun && !busy && (
          <div className="mono text-[9.5px]" style={{ color: '#e6c068' }}>A registration started before this panel opened is still running.</div>
        )}
      </Section>

      {/* -------- Result -------- */}
      {alignment && remaining && (
        <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="mono text-[10px]" style={{ color: 'var(--text)' }}>
            Measured from <span style={{ color: 'var(--accent)' }}>{measuredFrom}</span> onto <span style={{ color: 'var(--accent)' }}>{targetName}</span>
          </div>
          {measuredFromOther && (
            <div className="mono text-[9.5px]" style={{ color: '#e6c068', lineHeight: 1.5 }}>
              This measurement was made from {measuredFrom}, not from the reference selected above. Measure again to replace it.
            </div>
          )}
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
            <span>Target is off by</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{describeShift(alignment.dx, alignment.dy)}</span>
            <span>Rotation</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{degrees(alignment.theta).toFixed(2)}°{edge > 0.005 ? ` · ${(edge * 100).toFixed(0)} cm at the plot's edge` : ''}</span>
            <span>Stems matched after the fit</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{alignment.matchedTrees} / {alignment.treeCount}</span>
            <span>RMSE of the matched stems</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{alignment.rmse >= 0 ? `${(alignment.rmse * 100).toFixed(0)} cm` : '—'}</span>
            <span>Confidence</span><span style={{ color: verdict?.color, textAlign: 'right' }}>{Number.isFinite(alignment.confidence) && alignment.confidence < 99 ? `${alignment.confidence.toFixed(2)} × ` : ''}{verdict?.label}</span>
            <span>Coarse vote → fine fit</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{Math.hypot(alignment.coarse.dx - alignment.dx, alignment.coarse.dy - alignment.dy).toFixed(2)} m apart</span>
          </div>
          {hasMoved && (
            <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              {targetName} has been moved by {describeShift(moved[0], moved[1])} since this was measured; what is shown above is what remains.
            </div>
          )}
        </div>
      )}

      {/* -------- 3. Check -------- */}
      <Section title="3. Check" sub="the skeletons over the target — do they stand on the stems?">
        <label className="mono text-[10px] flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}
          title="Draw the reference's skeletons where the measurement puts them over the target. Off: where they were built — over the target that shows the offset itself.">
          <input type="checkbox" checked={through} disabled={!alignment || !!busy} onChange={(e) => setThroughLive(e.target.checked)} />
          through the alignment{!alignment && ' (measure first)'}
        </label>
        <div className="flex gap-1.5">
          <button className="btn !h-7 mono text-[11px] justify-center flex-1"
            disabled={!desktop?.octreeReadSkeletons || !referenceDir || !octree || !!busy || !!compare}
            onClick={() => void loadSkeletons(through)}
            title={targetIsOpen
              ? `Show ${referenceName}'s skeletons over ${openName}, the target — through the alignment they should sit on its stems.`
              : `Show ${referenceName}'s skeletons over ${openName ?? 'the open cloud'}. Through the alignment they sit on the TARGET's trees; over any other cloud they are off by the shift.`}>
            {busy === 'view' ? 'Loading…' : `Show skeletons on ${targetIsOpen ? 'the target' : 'the open cloud'}`}
          </button>
          <button className="btn !h-7 mono text-[11px] justify-center" disabled={!skeletonOverlay || !!busy} onClick={() => setSkeletonOverlay(null)}
            title="Take the skeletons off. They are also a row in Layers.">Hide</button>
        </div>
        <button className="btn !h-7 mono text-[11px] justify-center"
          disabled={!referenceDir || !targetDir || sameDir(referenceDir, targetDir) || !!busy}
          onClick={() => (compare ? setCompare(null) : void openCompare())}
          title="Reference and target side by side under one camera. The target pane's camera goes through the alignment, so both panes look at the same tree, and the skeletons are drawn over the target through it.">
          {compare ? 'Close Compare' : 'Compare side by side'}
        </button>
      </Section>

      {/* -------- 4. Apply -------- */}
      <Section title="4. Apply" sub="move the target onto the reference">
        <button className="btn !h-7 mono text-[11px] justify-center"
          disabled={!canShift || !remaining || !isWorthMoving(remaining[0], remaining[1])}
          onClick={applyShift}
          title="Shift the target's georeference by the inverse of the measured offset: metadata.offset, the bounds and the tiles move, no point is rewritten. Recorded under metadata.georeferenceShifts; the opposite shift undoes it.">
          {busy === 'shift' ? 'Moving…' : remaining && isWorthMoving(remaining[0], remaining[1])
            ? `Move ${targetName} by ${describeShift(remaining[0], remaining[1])}`
            : alignment ? 'Nothing left to move' : 'Move the target onto the reference — measure first'}
        </button>
        {alignment && Math.abs(alignment.theta) > 1e-4 && (
          <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
            The rotation of {degrees(alignment.theta).toFixed(2)}° is not applied — a georeference shift is a translation.
            Over this plot it amounts to {(edge * 100).toFixed(0)} cm at the edge. It stays in the stored measurement,
            which Tree Skeleton Transfer and the Compare take the skeletons through.
          </div>
        )}
        <div className="flex gap-1.5">
          <button className="btn !h-7 mono text-[11px] justify-center flex-1" disabled={!canShift || !hasMoved} onClick={undoShift}
            title="Shift the target back by what this measurement moved it.">
            {hasMoved ? `Undo the move (${describeShift(-moved[0], -moved[1])})` : 'Undo the move'}
          </button>
          <button className="btn !h-7 mono text-[11px] justify-center" disabled={!alignment || !desktop?.octreeSkeletonAlignmentClear || !!busy} onClick={() => void forget()}
            title="Delete skeleton_alignment.json beside the target. The target stays where it is.">
            Forget
          </button>
        </div>
        <div className="flex items-end gap-1.5 mt-1">
          <NumberField label="By hand: east (m)" value={handEast} onChange={setHandEast} width={104}
            title="A shift you know — from a GNSS log, a survey, another tool. Positive east." />
          <NumberField label="north (m)" value={handNorth} onChange={setHandNorth} width={88} title="Positive north." />
          <button className="btn !h-7 mono text-[11px] justify-center flex-1" disabled={!canShift || !isWorthMoving(parseNum(handEast, 0), parseNum(handNorth, 0))} onClick={moveByHand}
            title="Shift the target's georeference by exactly this. Lossless; the opposite shift undoes it. A stored measurement is kept current.">
            Move by hand
          </button>
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

      <div className="mono text-[9.5px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
        Horizontal only: the reference&rsquo;s stems and crowns fix east and north, and a small rotation. Heights are matched by each cloud&rsquo;s own ground surface where the tools need them.
      </div>
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
