// Co-registration panel — align scan positions across all imported
// Preprocessing projects (Riegl / E57 / PTX) into a shared frame.
//
// Workflow:
//  1. Pick a "source" scan (the one being moved) and a "target" scan
//     (the trusted reference).
//  2. Enter tie-point pairs: for each pair, the same physical point's
//     coordinates in the source scan's current world frame and in the
//     target scan's world frame (post-pose).
//  3. Click Solve → Kabsch closed-form fit gives a new pose for the
//     source scan + per-tie residuals + RMSE so the user can spot a
//     bad correspondence and remove it.
//  4. Click Apply → the new pose is written into the source scan's
//     manifest (Riegl / E57 / PTX importer's preprocessing folder).
//     The original importer files on disk stay untouched — only our
//     cached pose changes.

import { Fragment as Fragment_, useCallback, useEffect, useMemo, useState } from 'react';
import { EDITION, coregisterSources } from '../../build/edition';
import { useProject } from '../../context/ProjectContext';
import { csvText, stripBom } from '../../io/csv';
import CoregisterParams, { COREG_DEFAULTS, coregPayload, type CoregParams } from './CoregisterParams';
import { confirmDialog } from '../../ui/dialogs';

export interface UnifiedScan {
  importer: 'riegl' | 'e57' | 'ptx';
  projectId: string;
  projectName: string;
  scanId: string;
  scanName: string;
  pose: number[];
  worldTranslation: [number, number, number];
}

interface Props {
  onStatus: (s: { kind: 'ok' | 'err' | 'info'; msg: string } | null) => void;
}

type TieRow = {
  sx: string; sy: string; sz: string;
  tx: string; ty: string; tz: string;
};

const emptyTie = (): TieRow => ({ sx: '', sy: '', sz: '', tx: '', ty: '', tz: '' });

export default function CoregisterPanel({ onStatus }: Props) {
  const { project } = useProject();
  const [scans, setScans] = useState<UnifiedScan[]>([]);
  const [loading, setLoading] = useState(false);
  const [sourceKey, setSourceKey] = useState<string>('');
  const [targetKey, setTargetKey] = useState<string>('');
  const [ties, setTies] = useState<TieRow[]>([emptyTie(), emptyTie(), emptyTie()]);
  const [solveBusy, setSolveBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [solution, setSolution] = useState<{ pose: number[]; rmse: number; residuals: number[] } | null>(null);

  // ICP fine-refinement state.
  const [icpMaxIters, setIcpMaxIters] = useState('30');
  const [icpMaxDist, setIcpMaxDist] = useState('0.5');
  // Standard ICP variants. point-to-point is Besl & McKay 1992 (the
  // existing path, default for backward-compat). point-to-plane is
  // Chen & Medioni 1991 — what RiSCAN PRO's MSA refine + Cyclone
  // REGISTER 360's "Visual Alignment ICP" use; converges ~3× faster
  // and fits tighter on locally-planar surfaces (stems, walls,
  // floors, water).
  const [icpMethod, setIcpMethod] = useState<'pointToPoint' | 'pointToPlane'>('pointToPoint');
  const [icpBusy, setIcpBusy] = useState(false);
  const [autoMatchBusy, setAutoMatchBusy] = useState(false);
  // Multi-Station Adjustment over the project's full scan list.
  const [msaBusy, setMsaBusy] = useState(false);
  // Every threshold these stages use. They were literals at the call
  // sites below — good defaults, and unreachable from the UI, which is
  // no use on a plot the defaults were not chosen on. See
  // CoregisterParams for what each one is and which are RIEGL's.
  const [cp, setCp] = useState<CoregParams>(COREG_DEFAULTS);
  const [msaResult, setMsaResult] = useState<{
    perScan: Array<{ key: string; label: string; nSpheres: number; deltaT: number; deltaR: number; pose: number[] }>;
    totalPairs: number;
    rmseInitial: number;
    rmseFinal: number;
    rmseHistory: number[];
    iterations: number;
    converged: boolean;
  } | null>(null);
  const [msaApplyBusy, setMsaApplyBusy] = useState(false);
  const [icpPct, setIcpPct] = useState(0);
  const [icpApplyBusy, setIcpApplyBusy] = useState(false);
  const [icpResult, setIcpResult] = useState<{
    pose: number[]; rmse: number; rmseHistory: number[];
    correspondences: number; sourcePoints: number; targetPoints: number; converged: boolean;
  } | null>(null);

  const refresh = useCallback(async () => {
    if (!project?.folder) { setScans([]); return; }
    setLoading(true);
    try {
      const api = (window as unknown as Record<string, unknown>).desktop as {
        coregisterListScans?: (projectFolder: string) => Promise<UnifiedScan[]>;
      } | undefined;
      const list = api?.coregisterListScans ? await api.coregisterListScans(project.folder) : [];
      setScans(list);
    } catch (e) {
      console.warn('coregister_list_scans failed', e);
      setScans([]);
    } finally {
      setLoading(false);
    }
  }, [project?.folder]);
  useEffect(() => { void refresh(); }, [refresh]);

  const keyFor = (s: UnifiedScan) => `${s.importer}|${s.projectId}|${s.scanId}`;
  const source = useMemo(() => scans.find(s => keyFor(s) === sourceKey) ?? null, [scans, sourceKey]);
  const target = useMemo(() => scans.find(s => keyFor(s) === targetKey) ?? null, [scans, targetKey]);

  const updateTie = (i: number, patch: Partial<TieRow>) => {
    setTies(prev => prev.map((r, j) => j === i ? { ...r, ...patch } : r));
    setSolution(null);
  };
  const addTieRow = () => { setTies(prev => [...prev, emptyTie()]); setSolution(null); };
  const removeTieRow = (i: number) => {
    setTies(prev => prev.length > 3 ? prev.filter((_, j) => j !== i) : prev);
    setSolution(null);
  };

  /** Parsed tie points, INDEX-ALIGNED with `ties`: an incomplete row
   *  yields null rather than being skipped.
   *
   *  Skipping broke the residual column. The solve receives only the
   *  valid rows, so its residuals array is indexed by position among
   *  THOSE — while the table indexed it by position in the full row
   *  list. One blank row (say, "+ Add row" clicked before Solve, which
   *  is allowed since Solve only needs three valid rows) and every row
   *  after the gap showed a different tie point's residual than the one
   *  beside it. The aggregate RMSE and the pose were unaffected; the
   *  column whose entire purpose is "find the bad correspondence and
   *  remove it" pointed at the wrong one. */
  const parsedRows = useMemo(() => ties.map(t => {
    const sx = parseFloat(t.sx); const sy = parseFloat(t.sy); const sz = parseFloat(t.sz);
    const tx = parseFloat(t.tx); const ty = parseFloat(t.ty); const tz = parseFloat(t.tz);
    if (![sx, sy, sz, tx, ty, tz].every(Number.isFinite)) return null;
    return { source: [sx, sy, sz] as [number, number, number], target: [tx, ty, tz] as [number, number, number] };
  }), [ties]);

  const parsedTies = useMemo(
    () => parsedRows.filter((r): r is NonNullable<typeof r> => r !== null),
    [parsedRows],
  );

  /** Row index → index into the solve's residual array, or null for a
   *  row that was not sent. */
  const residualIndex = useMemo(() => {
    let k = 0;
    return parsedRows.map(r => (r === null ? null : k++));
  }, [parsedRows]);

  const canSolve = !solveBusy && parsedTies.length >= 3 && !!source && !!target && source.scanId !== target.scanId;
  const canApply = !applyBusy && !!solution && !!source;
  /** A fit this poor is more likely a mis-typed or mis-clicked tie point
   *  than a real 20 cm survey error, and Apply overwrites the manifest
   *  pose with no undo — re-importing the project is the only way back.
   *  Not blocked, because a legitimately coarse alignment is a real step
   *  in a workflow; confirmed, so it cannot happen on a stray click. */
  const poorFit = !!solution && solution.rmse > 0.2;

  const doSolve = async () => {
    setSolveBusy(true); setSolution(null);
    try {
      const api = (window as unknown as Record<string, unknown>).desktop as {
        coregisterSolve?: (ties: { source: [number, number, number]; target: [number, number, number] }[]) =>
          Promise<{ pose: number[]; rmse: number; residuals: number[] }>;
      } | undefined;
      if (!api?.coregisterSolve) throw new Error('coregister_solve unavailable');
      const res = await api.coregisterSolve(parsedTies);
      setSolution(res);
      onStatus({ kind: 'ok', msg: `Solved — RMSE ${res.rmse.toFixed(3)} m across ${parsedTies.length} tie points.` });
    } catch (e) {
      onStatus({ kind: 'err', msg: `Solve failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSolveBusy(false);
    }
  };

  const doApply = async () => {
    if (!source || !solution || !project?.folder) return;
    if (poorFit && !await confirmDialog(
      `The fit RMSE is ${(solution.rmse * 1000).toFixed(0)} mm. Applying overwrites this scan's pose `
      + 'and cannot be undone — the only way back is re-importing the project.\n\nApply anyway?',
    )) return;
    setApplyBusy(true);
    try {
      const api = (window as unknown as Record<string, unknown>).desktop as {
        coregisterApplyDelta?: (args: { projectFolder: string; importer: string; projectId: string; scanId: string; delta: number[] }) => Promise<void>;
      } | undefined;
      if (!api?.coregisterApplyDelta) throw new Error('coregister_apply_delta unavailable');
      // Tie points are in WORLD coordinates, so the scan's current pose
      // is already baked into them and Kabsch returns a CORRECTION, not
      // an absolute pose. Writing it straight in replaced the real pose
      // with the correction — confirming a good alignment yields R ≈ I,
      // which replaced a genuine pose with the identity, silently, after
      // a perfect RMSE. coregister_apply_delta composes it onto what the
      // scan already has; ICP and MSA return absolute poses and keep
      // using coregister_apply.
      await api.coregisterApplyDelta({
        projectFolder: project.folder,
        importer: source.importer,
        projectId: source.projectId,
        scanId: source.scanId,
        delta: solution.pose,
      });
      onStatus({ kind: 'ok', msg: `Applied new pose to "${source.scanName}" (${source.importer}). Re-export the cropped LAS / LAZ to use it.` });
      setSolution(null);
      await refresh();
    } catch (e) {
      onStatus({ kind: 'err', msg: `Apply failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setApplyBusy(false);
    }
  };

  // --- ICP fine-refinement ---
  const icpReadable = (s: UnifiedScan | null) => !!s && (s.importer === 'e57' || s.importer === 'ptx');
  const canIcp = !icpBusy && !!source && !!target && source.scanId !== target.scanId
    && icpReadable(source) && icpReadable(target);

  const subscribeIcpProgress = (): (() => void) | null => {
    const t = (window as unknown as { __TAURI__?: { event?: { listen?: (name: string, cb: (e: { payload: { pct: number } }) => void) => Promise<() => void> } } }).__TAURI__;
    const listen = t?.event?.listen;
    if (!listen) return null;
    let off: (() => void) | null = null;
    listen('icp-progress', (e) => {
      const pct = e?.payload?.pct;
      if (typeof pct === 'number') setIcpPct(pct);
    }).then((unlisten) => { off = unlisten; }).catch(() => { /* no-op */ });
    return () => { if (off) off(); };
  };

  // Multi-Station Adjustment across ALL scans in the project. Pipeline:
  //   1. Detect sphere targets in every scan (parallel).
  //   2. For every pair (i, j), i < j, run sphere RANSAC to find
  //      matched centres.
  //   3. Each matched pair becomes ONE MSA correspondence (sphere
  //      centres are uniquely identifiable points, so a single 3D
  //      match is enough — no need to sample point clouds).
  //   4. Read each scan's current manifest pose.
  //   5. Call coregister_msa to refine ALL poses jointly.
  //   6. Display per-scan delta + final RMSE; user clicks Apply to
  //      write the refined poses back to manifests.
  const doMsa = async () => {
    if (!project?.folder || scans.length < 2) return;
    const api = (window as unknown as Record<string, unknown>).desktop as {
      coregisterDetectSpheres?: (a: unknown) => Promise<Array<{
        center: number[]; radius: number; rmse: number; nPoints: number;
      }>>;
      coregisterExtractPlanes?: (a: unknown) => Promise<Array<{
        centroid: number[]; normal: number[]; rmse: number;
        extent: number; areaEstimate: number; planarity: number; nPoints: number;
      }>>;
      coregisterMatchSpheres?: (a: unknown) => Promise<{
        pairs: Array<{
          sourceIdx: number; targetIdx: number;
          sourceCenter: number[]; targetCenter: number[]; radiusMean: number;
        }>;
        rmse: number; candidates: number;
      }>;
      coregisterMatchPlanes?: (a: unknown) => Promise<{
        pairs: Array<{ sourceIdx: number; targetIdx: number; normalDot: number; centroidDistance: number }>;
        correspondences: Array<{ i: number; j: number; pILocal: number[]; pJLocal: number[] }>;
        rmse: number;
      }>;
      coregisterMsa?: (a: unknown) => Promise<{
        poses: number[][]; rmseHistory: number[];
        converged: boolean; finalRmse: number; correspondences: number;
      }>;
      coregisterListScans?: (a: string) => Promise<UnifiedScan[]>;
    } | undefined;
    if (!api?.coregisterDetectSpheres || !api?.coregisterMatchSpheres || !api?.coregisterMsa) {
      onStatus({ kind: 'err', msg: 'MSA backend missing.' }); return;
    }
    setMsaBusy(true);
    setMsaResult(null);
    onStatus({ kind: 'info', msg: `Detecting sphere targets in ${scans.length} scans…` });
    try {
      const cpv = coregPayload(cp);
      const detectParams = cpv.sphereDetect;
      // Skip Riegl scans — the build that ships reads no RDB 2 points
      // (see src-tauri riegl_rdbx.rs), so a manifest-only project has
      // nothing to detect spheres in.
      const usable = scans.filter(s => s.importer !== 'riegl');
      if (usable.length < 2) {
        onStatus({ kind: 'err', msg: 'MSA needs at least 2 E57 / PTX scans whose points this build can read.' });
        setMsaBusy(false);
        return;
      }
      // RIEGL's own numbers where the quantity is a length or an
      // angle (from a RiSCAN PRO project's regsettings.json); the
      // point-count thresholds stay ours because this runs on a 200 k
      // subsample and RIEGL's run on the full scan. The reasoning is
      // in commands/coregister.rs, above PlaneExtractParams.
      const planeParams = cpv.planeExtract;
      const [perScanSpheres, perScanPlanes] = await Promise.all([
        Promise.all(usable.map(s => api.coregisterDetectSpheres!({
          projectFolder: project.folder,
          scan: { importer: s.importer, projectId: s.projectId, scanId: s.scanId },
          params: detectParams,
        }))),
        // Best-effort plane extraction — if the endpoint isn't wired
        // (older host bundle) we just get [] arrays and the plane
        // contribution drops out cleanly.
        Promise.all(usable.map(s => (api.coregisterExtractPlanes
          ? api.coregisterExtractPlanes({
              projectFolder: project.folder,
              scan: { importer: s.importer, projectId: s.projectId, scanId: s.scanId },
              params: planeParams,
            }).catch(() => [])
          : Promise.resolve([] as Array<{
              centroid: number[]; normal: number[]; rmse: number;
              extent: number; areaEstimate: number; planarity: number; nPoints: number;
            }>)))),
      ]);
      // Pairwise feature matching — sphere RANSAC first, then plane
      // RANSAC. The plane matcher emits multiple correspondences per
      // pair (sampled on the tangent rectangle), so they add a lot
      // of constraint per matched plane.
      let totalPairs = 0;
      let totalSphereCorr = 0;
      let totalPlaneCorr = 0;
      const correspondences: Array<{ i: number; j: number; pILocal: number[]; pJLocal: number[] }> = [];
      for (let i = 0; i < usable.length; i++) {
        for (let j = i + 1; j < usable.length; j++) {
          const sa = perScanSpheres[i];
          const sb = perScanSpheres[j];
          if (sa.length >= 3 && sb.length >= 3) {
            const m = await api.coregisterMatchSpheres!({
              source: sa, target: sb,
              params: cpv.sphereMatch,
            });
            for (const p of m.pairs) {
              // Sphere centres are in WORLD coords (current manifest
              // pose applied). Since we feed identity initial poses
              // to MSA, the world coords ARE the "local" coords from
              // MSA's point of view — see the comment block below.
              correspondences.push({
                i, j, pILocal: p.sourceCenter, pJLocal: p.targetCenter,
              });
            }
            totalSphereCorr += m.pairs.length;
          }
          // Plane matching — generates multiple correspondences per
          // matched plane (sampled on the tangent rectangle).
          const pa = perScanPlanes[i];
          const pb = perScanPlanes[j];
          if (api.coregisterMatchPlanes && pa.length >= 3 && pb.length >= 3) {
            try {
              const m = await api.coregisterMatchPlanes({
                source: pa, target: pb,
                params: cpv.planeMatch,
              });
              for (const c of m.correspondences) {
                // Backend tags correspondences with i=0/j=1; re-tag
                // them to the actual scan indices in this scan loop.
                correspondences.push({
                  i, j, pILocal: c.pILocal, pJLocal: c.pJLocal,
                });
              }
              totalPlaneCorr += m.correspondences.length;
            } catch {
              // Plane endpoint failure is non-fatal — sphere matches
              // alone may suffice for the MSA.
            }
          }
          if (sa.length >= 3 && sb.length >= 3) totalPairs++;
        }
      }
      onStatus({ kind: 'info', msg: `Found ${totalSphereCorr} sphere + ${totalPlaneCorr} plane correspondences across ${totalPairs} scan pairs.` });
      if (correspondences.length < 3) {
        onStatus({ kind: 'err', msg: `Only ${correspondences.length} matched sphere correspondences across ${totalPairs} pairs. Need ≥ 3 — place more targets.` });
        setMsaBusy(false);
        return;
      }
      onStatus({ kind: 'info', msg: `Solving MSA over ${usable.length} scans, ${correspondences.length} sphere correspondences…` });
      // Use identity as the initial pose for ALL scans since sphere
      // centres are in world (= current-manifest-pose-applied)
      // coordinates. The MSA delta is the EXTRA refinement on top of
      // the current poses; we compose this delta onto the manifest
      // poses below.
      const initialPoses: number[][] = usable.map(() => [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ]);
      const result = await api.coregisterMsa!({
        poses: initialPoses,
        correspondences,
        params: cpv.msa,
      });
      // Per-scan delta: translation L2 + rotation angle (radians) of
      // the delta pose vs. identity.
      const perScan = usable.map((s, k) => {
        const M = result.poses[k];
        const t = Math.sqrt(M[3] ** 2 + M[7] ** 2 + M[11] ** 2);
        // Rotation angle: acos((pointcloudlabeler(R) − 1) / 2).
        const tr = M[0] + M[5] + M[10];
        const cosA = Math.min(1, Math.max(-1, (tr - 1) * 0.5));
        const ang = Math.acos(cosA);
        return {
          key: `${s.importer}|${s.projectId}|${s.scanId}`,
          label: `[${s.importer}] ${s.projectName} · ${s.scanName}`,
          nSpheres: perScanSpheres[k].length,
          deltaT: t,
          deltaR: ang,
          pose: M,
        };
      });
      const initialRmse = result.rmseHistory[0] ?? Infinity;
      setMsaResult({
        perScan,
        totalPairs,
        rmseInitial: initialRmse,
        rmseFinal: result.finalRmse,
        rmseHistory: result.rmseHistory,
        iterations: result.rmseHistory.length,
        converged: result.converged,
      });
      onStatus({ kind: 'ok', msg: `MSA converged on ${usable.length} scans · RMSE ${(result.finalRmse * 1000).toFixed(2)} mm. Apply to write refined poses to manifests.` });
    } catch (e) {
      onStatus({ kind: 'err', msg: `MSA failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setMsaBusy(false);
    }
  };

  const doMsaApply = async () => {
    if (!project?.folder || !msaResult) return;
    const api = (window as unknown as Record<string, unknown>).desktop as {
      coregisterApply?: (a: unknown) => Promise<void>;
    } | undefined;
    if (!api?.coregisterApply) return;
    setMsaApplyBusy(true);
    try {
      // Compose each scan's MSA delta onto its CURRENT manifest pose.
      // Since we passed identity as the initial pose to MSA, the
      // returned pose IS the delta; multiply onto the manifest pose
      // recorded in the scan list.
      for (const ps of msaResult.perScan) {
        // Written as "is it measurably a change", not "is it below the
        // threshold": every ordered comparison against NaN is false, so
        // the negated form would let a NaN delta through as a real
        // change — and a non-finite pose reaching the manifest is what
        // discards a scan's registration (see validate_pose). The Rust
        // side refuses it too; this stops the caller before it asks.
        if (!(ps.deltaT >= 1e-6) && !(ps.deltaR >= 1e-6)) continue; // no change
        if (!Number.isFinite(ps.deltaT) || !Number.isFinite(ps.deltaR)) {
          onStatus({ kind: 'err', msg: `${ps.label}: the MSA solution is not a usable pose — skipped, its manifest is untouched.` });
          continue;
        }
        const found = scans.find(s => `${s.importer}|${s.projectId}|${s.scanId}` === ps.key);
        if (!found) continue;
        // Build delta × manifest pose (row-major 4×4 multiply).
        const delta = ps.pose;
        const cur = found.pose;
        const next = new Array(16).fill(0);
        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 4; c++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += delta[r * 4 + k] * cur[k * 4 + c];
            next[r * 4 + c] = s;
          }
        }
        await api.coregisterApply({
          projectFolder: project.folder,
          importer: found.importer,
          projectId: found.projectId,
          scanId: found.scanId,
          pose: next,
        });
      }
      onStatus({ kind: 'ok', msg: 'MSA poses applied to all manifests. Re-export to use them.' });
      setMsaResult(null);
      // Refresh like doApply and doIcpApply: this composes its delta
      // onto the pose held in `scans`, so without re-reading, a second
      // MSA round would compose onto the pre-first-correction pose and
      // silently discard the first.
      await refresh();
    } catch (e) {
      onStatus({ kind: 'err', msg: `MSA apply failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setMsaApplyBusy(false);
    }
  };

  // Auto-detect retroreflective sphere targets in BOTH scans + match
  // them via RANSAC; push the matched centres into the tie-point list
  // so the existing Kabsch / ICP path uses them. Replaces the
  // hand-clicking step the user would otherwise do.
  const doAutoMatch = async () => {
    if (!source || !target || !project?.folder) return;
    const api = (window as unknown as Record<string, unknown>).desktop as {
      coregisterDetectSpheres?: (a: unknown) => Promise<Array<{
        center: number[]; radius: number; rmse: number; nPoints: number;
      }>>;
      coregisterMatchSpheres?: (a: unknown) => Promise<{
        pairs: Array<{
          sourceIdx: number; targetIdx: number;
          sourceCenter: number[]; targetCenter: number[]; radiusMean: number;
        }>;
        rmse: number; candidates: number;
      }>;
    } | undefined;
    if (!api?.coregisterDetectSpheres || !api?.coregisterMatchSpheres) {
      onStatus({ kind: 'err', msg: 'Auto-match backend missing.' }); return;
    }
    setAutoMatchBusy(true);
    onStatus({ kind: 'info', msg: 'Detecting sphere targets in both scans…' });
    try {
      const cpv = coregPayload(cp);
      const detectParams = cpv.sphereDetect;
      const [src, tgt] = await Promise.all([
        api.coregisterDetectSpheres({
          projectFolder: project.folder,
          scan: { importer: source.importer, projectId: source.projectId, scanId: source.scanId },
          params: detectParams,
        }),
        api.coregisterDetectSpheres({
          projectFolder: project.folder,
          scan: { importer: target.importer, projectId: target.projectId, scanId: target.scanId },
          params: detectParams,
        }),
      ]);
      if (src.length === 0 || tgt.length === 0) {
        onStatus({ kind: 'err', msg: `No sphere targets detected (source ${src.length}, target ${tgt.length}). Place retroreflective spheres in the scene or fall back to manual tie points.` });
        setAutoMatchBusy(false);
        return;
      }
      onStatus({ kind: 'info', msg: `Found ${src.length} / ${tgt.length} spheres — matching…` });
      const match = await api.coregisterMatchSpheres({
        source: src, target: tgt,
        params: cpv.sphereMatch,
      });
      if (match.pairs.length < 3) {
        onStatus({ kind: 'err', msg: `RANSAC found only ${match.pairs.length} inliers (need ≥ 3). Move the spheres farther apart or scan more positions.` });
        setAutoMatchBusy(false);
        return;
      }
      // Replace the tie-point list with the matched centres. Round
      // to 4 decimals so the UI shows tidy numbers.
      const newTies: TieRow[] = match.pairs.map(p => ({
        sx: p.sourceCenter[0].toFixed(4), sy: p.sourceCenter[1].toFixed(4), sz: p.sourceCenter[2].toFixed(4),
        tx: p.targetCenter[0].toFixed(4), ty: p.targetCenter[1].toFixed(4), tz: p.targetCenter[2].toFixed(4),
      }));
      // Pad to ≥ 3 rows just in case.
      while (newTies.length < 3) newTies.push(emptyTie());
      setTies(newTies);
      setSolution(null);
      onStatus({ kind: 'ok', msg: `Auto-matched ${match.pairs.length} sphere pairs (RMSE ${(match.rmse * 1000).toFixed(2)} mm). Click Solve to refine + Apply.` });
    } catch (e) {
      onStatus({ kind: 'err', msg: `Auto-match failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setAutoMatchBusy(false);
    }
  };

  const doIcp = async () => {
    if (!source || !target || !project?.folder) return;
    setIcpBusy(true); setIcpPct(0); setIcpResult(null);
    const unsubscribe = subscribeIcpProgress();
    onStatus({ kind: 'info', msg: 'Running ICP fine-refinement…' });
    try {
      const api = (window as unknown as Record<string, unknown>).desktop as {
        coregisterIcp?: (args: {
          projectFolder: string;
          source: { importer: string; projectId: string; scanId: string };
          target: { importer: string; projectId: string; scanId: string };
          params: {
            maxIters: number; maxCorrDist: number; samplePoints: number;
            method?: 'pointToPoint' | 'pointToPlane';
            normalK?: number;
          };
        }) => Promise<typeof icpResult>;
      } | undefined;
      if (!api?.coregisterIcp) throw new Error('coregister_icp unavailable');
      const maxIters = Math.max(1, Math.min(200, parseInt(icpMaxIters, 10) || 30));
      const maxCorrDist = Math.max(0.001, parseFloat(icpMaxDist) || 0.5);
      const res = await api.coregisterIcp({
        projectFolder: project.folder,
        source: { importer: source.importer, projectId: source.projectId, scanId: source.scanId },
        target: { importer: target.importer, projectId: target.projectId, scanId: target.scanId },
        params: {
          maxIters, maxCorrDist, samplePoints: coregPayload(cp).icpSamplePoints,
          method: icpMethod,
          normalK: icpMethod === 'pointToPlane' ? 12 : undefined,
        },
      });
      setIcpResult(res);
      if (res) {
        onStatus({ kind: 'ok', msg: `ICP ${res.converged ? 'converged' : 'stopped'} — RMSE ${res.rmse.toFixed(4)} m over ${res.rmseHistory.length} iters, ${res.correspondences.toLocaleString()} correspondences.` });
      }
    } catch (e) {
      onStatus({ kind: 'err', msg: `ICP failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (unsubscribe) unsubscribe();
      setIcpBusy(false); setIcpPct(0);
    }
  };

  const doIcpApply = async () => {
    if (!source || !icpResult || !project?.folder) return;
    setIcpApplyBusy(true);
    try {
      const api = (window as unknown as Record<string, unknown>).desktop as {
        coregisterApply?: (args: { projectFolder: string; importer: string; projectId: string; scanId: string; pose: number[] }) => Promise<void>;
      } | undefined;
      if (!api?.coregisterApply) throw new Error('coregister_apply unavailable');
      await api.coregisterApply({
        projectFolder: project.folder,
        importer: source.importer,
        projectId: source.projectId,
        scanId: source.scanId,
        pose: icpResult.pose,
      });
      onStatus({ kind: 'ok', msg: `Applied ICP-refined pose to "${source.scanName}". Re-export to use it.` });
      setIcpResult(null);
      await refresh();
    } catch (e) {
      onStatus({ kind: 'err', msg: `Apply failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setIcpApplyBusy(false);
    }
  };

  // --- tie-point CSV save / load ---
  const saveTiesCsv = async () => {
    const api = (window as unknown as Record<string, unknown>).desktop as {
      saveCsvDialog?: (name: string) => Promise<string | null>;
      writeFile?: (path: string, content: string) => Promise<void>;
    } | undefined;
    if (!api?.saveCsvDialog || !api?.writeFile) {
      onStatus({ kind: 'err', msg: 'CSV save needs the desktop build.' }); return;
    }
    const path = await api.saveCsvDialog('tie_points.csv');
    if (!path) return;
    const lines = ['source_x,source_y,source_z,target_x,target_y,target_z'];
    for (const t of ties) lines.push([t.sx, t.sy, t.sz, t.tx, t.ty, t.tz].join(','));
    try {
      await api.writeFile(path, csvText([...lines, '']));
      onStatus({ kind: 'ok', msg: `Saved ${ties.length} tie-point rows → ${path}` });
    } catch (e) {
      onStatus({ kind: 'err', msg: `Save failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const loadTiesCsv = async () => {
    const api = (window as unknown as Record<string, unknown>).desktop as {
      openFileDialog?: (opts: { filters: { name: string; extensions: string[] }[] }) => Promise<{ path: string } | null>;
      readFile?: (path: string) => Promise<ArrayBuffer>;
    } | undefined;
    if (!api?.openFileDialog || !api?.readFile) {
      onStatus({ kind: 'err', msg: 'CSV load needs the desktop build.' }); return;
    }
    const picked = await api.openFileDialog({ filters: [{ name: 'CSV / text', extensions: ['csv', 'txt'] }] });
    if (!picked?.path) return;
    try {
      const buf = await api.readFile(picked.path);
      // stripBom: a file saved by Excel as "CSV UTF-8" starts with
      // U+FEFF, and a headerless one would lose its first row here —
      // parseFloat sees "\ufeff123" and returns NaN, which this loop
      // reads as a header line to skip.
      const text = stripBom(new TextDecoder().decode(buf));
      const rows: TieRow[] = [];
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        // Skip a header line (any non-numeric first cell).
        const cells = line.split(/[,;\t ]+/);
        if (cells.length < 6) continue;
        if (!Number.isFinite(parseFloat(cells[0]))) continue;
        rows.push({ sx: cells[0], sy: cells[1], sz: cells[2], tx: cells[3], ty: cells[4], tz: cells[5] });
      }
      if (rows.length < 1) { onStatus({ kind: 'err', msg: 'No valid tie-point rows found in the file.' }); return; }
      while (rows.length < 3) rows.push(emptyTie());
      setTies(rows);
      setSolution(null);
      onStatus({ kind: 'ok', msg: `Loaded ${rows.length} tie-point rows from ${picked.path}` });
    } catch (e) {
      onStatus({ kind: 'err', msg: `Load failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  return (
    <div className="rounded-md" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
      <div className="flex items-center px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px]" style={{ color: 'var(--text)' }}>Co-registration</div>
          <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
            Align scan positions across {coregisterSources(EDITION)} into a shared frame. Pick source + target, enter ≥ 3 tie points, solve via Kabsch.
          </div>
        </div>
        <button className="btn !h-7 !px-2 mono text-[10.5px]" onClick={() => void refresh()} disabled={loading} title="Re-scan importer manifests">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {scans.length === 0 ? (
        <div className="p-6 text-center mono text-[11px]" style={{ color: 'var(--text-mute)' }}>
          No scan positions found. Import {coregisterSources(EDITION) === 'E57 / PTX' ? 'an E57 or PTX' : 'a Riegl / E57 / PTX'} file first.
        </div>
      ) : (
        <div className="p-4 flex flex-col gap-4">
          {/* Source / target pickers */}
          <div className="grid grid-cols-2 gap-3">
            <ScanPicker
              label="Source (move this)"
              scans={scans}
              value={sourceKey}
              onChange={(v) => { setSourceKey(v); setSolution(null); }}
              keyFor={keyFor}
            />
            <ScanPicker
              label="Target (anchor)"
              scans={scans}
              value={targetKey}
              onChange={(v) => { setTargetKey(v); setSolution(null); }}
              keyFor={keyFor}
            />
          </div>

          {/* Tie points */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="chip" style={{ margin: 0 }}>Tie points</span>
              <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
                world coords (post-pose) · need ≥ 3 rows · {parsedTies.length} valid
              </span>
              <div className="flex-1" />
              <button className="mono text-[10px] px-2 py-0.5 rounded-sm" style={{ color: 'var(--text-dim)', border: '1px solid var(--line)' }} onClick={() => void loadTiesCsv()} title="Load tie points from a CSV (source_x,…,target_z)">Load CSV</button>
              <button className="mono text-[10px] px-2 py-0.5 rounded-sm" style={{ color: 'var(--text-dim)', border: '1px solid var(--line)' }} onClick={() => void saveTiesCsv()} title="Save the current tie points to a CSV">Save CSV</button>
            </div>
            <div className="rounded-md overflow-auto scroll-thin mono text-[10.5px]" style={{ border: '1px solid var(--line)', maxHeight: 280 }}>
              <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: 640 }}>
                <thead style={{ background: 'var(--wash-1)', position: 'sticky', top: 0 }}>
                  <tr>
                    <th style={thStyle}>#</th>
                    <th colSpan={3} style={{ ...thStyle, textAlign: 'center', borderRight: '1px solid var(--line)' }}>Source world XYZ</th>
                    <th colSpan={3} style={{ ...thStyle, textAlign: 'center' }}>Target world XYZ</th>
                    <th style={thStyle}>Residual</th>
                    <th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {ties.map((t, i) => (
                    <tr key={i}>
                      <td style={tdLabelStyle}>{i + 1}</td>
                      <td style={tdStyle}><TieInput value={t.sx} onChange={(v) => updateTie(i, { sx: v })} /></td>
                      <td style={tdStyle}><TieInput value={t.sy} onChange={(v) => updateTie(i, { sy: v })} /></td>
                      <td style={{ ...tdStyle, borderRight: '1px solid var(--line)' }}><TieInput value={t.sz} onChange={(v) => updateTie(i, { sz: v })} /></td>
                      <td style={tdStyle}><TieInput value={t.tx} onChange={(v) => updateTie(i, { tx: v })} /></td>
                      <td style={tdStyle}><TieInput value={t.ty} onChange={(v) => updateTie(i, { ty: v })} /></td>
                      <td style={tdStyle}><TieInput value={t.tz} onChange={(v) => updateTie(i, { tz: v })} /></td>
                      <td style={{ ...tdLabelStyle, color: residualColor(residualIndex[i] === null ? undefined : solution?.residuals[residualIndex[i]!]) }}>
                        {solution && residualIndex[i] !== null && solution.residuals[residualIndex[i]!] != null
                          ? `${solution.residuals[residualIndex[i]!].toFixed(3)} m`
                          : '—'}
                      </td>
                      <td style={tdLabelStyle}>
                        <button
                          className="btn btn-ghost !h-5 !w-5 !p-0 justify-center"
                          onClick={() => removeTieRow(i)}
                          disabled={ties.length <= 3}
                          title={ties.length <= 3 ? 'At least 3 ties required' : 'Remove tie point'}
                        >✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-1.5 flex justify-between items-center gap-1.5">
              <button
                className="btn !h-7 !px-2 mono text-[10.5px]"
                onClick={addTieRow}
                title="Add another tie point row"
              >+ Add row</button>
              <button
                className="btn !h-7 !px-2 mono text-[10.5px]"
                onClick={() => void doAutoMatch()}
                disabled={!source || !target || source?.scanId === target?.scanId || autoMatchBusy}
                title="Auto-detect retroreflective sphere targets in both scans + match them via RANSAC. Fills the tie-point list with the matched centres. Requires sphere targets in the scene (RIEGL 7.5 cm or 14.5 cm radius)."
                style={{
                  background: autoMatchBusy ? 'var(--wash-2)' : undefined,
                  borderColor: autoMatchBusy ? 'var(--accent)' : undefined,
                  color: autoMatchBusy ? 'var(--accent)' : undefined,
                }}
              >
                {autoMatchBusy ? 'Detecting + matching…' : '🎯 Auto-match spheres'}
              </button>
              <span className="flex-1" />
              {solution && (
                <span className="mono text-[10.5px]" style={{ color: solution.rmse < 0.05 ? 'var(--accent)' : solution.rmse < 0.2 ? 'var(--text)' : '#ffb4be' }}>
                  RMSE: {solution.rmse.toFixed(3)} m
                </span>
              )}
            </div>
          </div>

          {/* Solve + Apply */}
          <div className="flex gap-2">
            <button
              className="btn flex-1 !h-9 mono text-[12px] justify-center"
              disabled={!canSolve}
              onClick={() => void doSolve()}
              title={canSolve ? 'Compute the rigid transform that aligns the tie points (Kabsch)' : 'Pick source + target scans and fill ≥ 3 tie points'}
            >
              {solveBusy ? 'Solving…' : 'Solve'}
            </button>
            <button
              className="btn btn-primary flex-1 !h-9 mono text-[12px] justify-center"
              disabled={!canApply}
              onClick={() => void doApply()}
              title={canApply ? `Write the new pose to ${source?.scanName}'s manifest` : 'Solve first'}
            >
              {applyBusy ? 'Applying…' : 'Apply pose to source'}
            </button>
          </div>

          {solution && (
            <div className="rounded-md p-3 mono text-[10.5px]" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.25)' }}>
              <div style={{ color: 'var(--text-mute)', marginBottom: 6 }}>New pose (row-major 4×4):</div>
              <table style={{ borderCollapse: 'collapse' }}>
                <tbody>
                  {[0, 1, 2, 3].map(r => (
                    <tr key={r}>
                      {[0, 1, 2, 3].map(c => (
                        <td key={c} style={{ padding: '2px 8px', color: 'var(--text-dim)', textAlign: 'right' }}>
                          {solution.pose[r * 4 + c]?.toFixed(4) ?? '0.0000'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ICP fine-refinement */}
          <div className="rounded-md p-3" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
            <div className="flex items-center gap-2 mb-2">
              <span className="chip" style={{ margin: 0 }}>ICP fine-refinement</span>
              <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
                reads real points · {icpMethod === 'pointToPlane' ? 'point-to-plane (Chen & Medioni 1991) · planar surface ICP' : 'point-to-point (Besl & McKay 1992)'} · refines from current poses
              </span>
            </div>
            <div className="flex items-center gap-1 mb-2">
              <span className="mono text-[10px]" style={{ color: 'var(--text-dim)', minWidth: 56 }}>Method</span>
              <button
                onClick={() => setIcpMethod('pointToPoint')}
                className="mono text-[10px] px-2 py-0.5 rounded-sm"
                style={{
                  color: icpMethod === 'pointToPoint' ? 'var(--accent)' : 'var(--text-dim)',
                  background: icpMethod === 'pointToPoint' ? 'color-mix(in oklch, var(--accent) 14%, transparent)' : 'transparent',
                  border: `1px solid ${icpMethod === 'pointToPoint' ? 'var(--accent)' : 'var(--line)'}`,
                  cursor: 'pointer',
                }}
                title="Besl & McKay 1992 — minimises Σ ‖R·p + t − q‖². Classic ICP, robust on dense blob-like overlaps."
              >Point-to-point</button>
              <button
                onClick={() => setIcpMethod('pointToPlane')}
                className="mono text-[10px] px-2 py-0.5 rounded-sm"
                style={{
                  color: icpMethod === 'pointToPlane' ? 'var(--accent)' : 'var(--text-dim)',
                  background: icpMethod === 'pointToPlane' ? 'color-mix(in oklch, var(--accent) 14%, transparent)' : 'transparent',
                  border: `1px solid ${icpMethod === 'pointToPlane' ? 'var(--accent)' : 'var(--line)'}`,
                  cursor: 'pointer',
                }}
                title="Chen & Medioni 1991 — minimises Σ ((R·p + t − q)·n_q)². RiSCAN PRO + Cyclone REGISTER 360 use this; ~3× faster convergence + tight fits on planar / cylindrical surfaces (stems, walls, floors, water)."
              >Point-to-plane</button>
              {icpMethod === 'pointToPlane' && (
                <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
                  · normals via 12-NN PCA
                </span>
              )}
            </div>
            {!icpReadable(source) && source ? (
              <div className="mono text-[10px] mb-2" style={{ color: '#ffd9a0' }}>
                {source.importer === 'riegl'
                  ? 'ICP cannot read this scan\'s points: RIEGL RDB 2 is read only through rdblib. Export it from RiSCAN PRO as E57 first, or use the manual solve.'
                  : `ICP can't read importer "${source.importer}".`}
              </div>
            ) : null}
            <div className="flex items-end gap-3 mb-2">
              <label className="flex flex-col">
                <span className="mono text-[9px] mb-0.5" style={{ color: 'var(--text-mute)' }}>Max iters</span>
                <input
                  className="mono text-[11px] py-1 px-1.5 rounded-md outline-none"
                  style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)', width: 70 }}
                  value={icpMaxIters}
                  onChange={(e) => setIcpMaxIters(e.target.value)}
                />
              </label>
              <label className="flex flex-col">
                <span className="mono text-[9px] mb-0.5" style={{ color: 'var(--text-mute)' }}>Max corr. dist (m)</span>
                <input
                  className="mono text-[11px] py-1 px-1.5 rounded-md outline-none"
                  style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)', width: 90 }}
                  value={icpMaxDist}
                  onChange={(e) => setIcpMaxDist(e.target.value)}
                />
              </label>
              <button
                className="btn flex-1 !h-8 mono text-[11.5px] justify-center"
                disabled={!canIcp}
                onClick={() => void doIcp()}
                title={canIcp ? 'Iteratively refine the source pose against the target point cloud' : 'Pick two readable (E57 / PTX) scans first'}
              >
                {icpBusy ? `Running… ${icpPct > 0 ? `${Math.round(icpPct * 100)}%` : ''}` : 'Run ICP'}
              </button>
            </div>

            {icpResult && (
              <div className="rounded-md p-2.5 mt-1" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.25)' }}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="mono text-[10.5px]" style={{ color: icpResult.rmse < 0.05 ? 'var(--accent)' : icpResult.rmse < 0.2 ? 'var(--text)' : '#ffb4be' }}>
                    RMSE {icpResult.rmse.toFixed(4)} m · {icpResult.converged ? 'converged' : 'stopped at max iters'}
                  </span>
                  <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
                    {icpResult.correspondences.toLocaleString()} pairs · {icpResult.sourcePoints.toLocaleString()}↔{icpResult.targetPoints.toLocaleString()} pts
                  </span>
                </div>
                <RmseSparkline history={icpResult.rmseHistory} />
                <button
                  className="btn btn-primary w-full !h-8 mono text-[11.5px] justify-center mt-2"
                  disabled={icpApplyBusy}
                  onClick={() => void doIcpApply()}
                  title={`Write the ICP-refined pose to ${source?.scanName}'s manifest`}
                >
                  {icpApplyBusy ? 'Applying…' : 'Apply ICP pose to source'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Multi-Station Adjustment — refines ALL scan poses jointly. */}
      <div className="mt-3" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        <div className="flex items-baseline gap-2">
          <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>3 · Multi-Station Adjustment</span>
          <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
            sphere targets + RANSAC + LM bundle · global pose-graph fit · RiSCAN PRO MSA equivalent
          </span>
        </div>
        <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Detects retroreflective sphere targets in every scan, RANSAC-matches them across all pairs, builds correspondences, runs Levenberg-Marquardt over the 6(N−1)-DoF state. The output is a globally consistent pose refinement applied on top of each scan's current manifest pose. Requires 3+ matched spheres total.
        </div>
        <label className="flex items-center gap-2 mt-2 mono text-[10px] cursor-pointer"
               style={{ color: 'var(--text-dim)' }}
               title="RIEGL's preserveRollAndPitch. The scanner's inclination sensors measure roll and pitch to ~0.01°, better than a plane or sphere fit recovers them — so the adjustment solves yaw and translation only and leaves the levelling alone. Turn it off for a full 6-DoF fit (e.g. a scan whose levelling is not trustworthy).">
          <input
            type="checkbox"
            checked={cp.msaPreserveRollPitch}
            onChange={(e) => setCp({ ...cp, msaPreserveRollPitch: e.target.checked })}
            style={{ accentColor: 'var(--accent)' }}
          />
          Preserve roll + pitch (solve yaw + translation only)
        </label>
        <div className="flex gap-2 mt-2">
          <button
            className="btn flex-1 !h-9 mono text-[12px] justify-center"
            onClick={() => void doMsa()}
            disabled={msaBusy || scans.length < 2}
          >
            {msaBusy ? 'Running MSA…' : `Run MSA over ${scans.filter(s => s.importer !== 'riegl').length} scans`}
          </button>
          {msaResult && (
            <button
              className="btn flex-1 !h-9 mono text-[12px] justify-center"
              onClick={() => void doMsaApply()}
              disabled={msaApplyBusy}
              style={{
                background: 'color-mix(in oklch, var(--accent) 18%, transparent)',
                borderColor: 'var(--accent)',
                color: 'var(--accent)',
              }}
            >
              {msaApplyBusy ? 'Applying…' : `Apply to ${msaResult.perScan.length} scans`}
            </button>
          )}
        </div>
        {msaResult && (
          <div className="mt-2 rounded-md p-2" style={{ background: 'var(--wash-1)', border: '1px solid var(--line)' }}>
            <div className="flex items-baseline gap-2 mono text-[10.5px]">
              <span style={{ color: 'var(--text-dim)' }}>{msaResult.converged ? 'converged' : 'stopped at max iters'}</span>
              <span style={{ color: 'var(--text-mute)' }}>·</span>
              <span style={{ color: 'var(--text)' }}>RMSE {(msaResult.rmseInitial * 1000).toFixed(1)} → <b>{(msaResult.rmseFinal * 1000).toFixed(2)}</b> mm</span>
              <span style={{ color: 'var(--text-mute)' }}>·</span>
              <span style={{ color: 'var(--text-mute)' }}>{msaResult.iterations} iters · {msaResult.totalPairs} pairs</span>
            </div>
            <RmseSparkline history={msaResult.rmseHistory} />
            <div className="mt-1.5 mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 gap-y-0.5">
                <div>Scan</div><div style={{ textAlign: 'right' }}>spheres</div><div style={{ textAlign: 'right' }}>Δ trans (mm)</div><div style={{ textAlign: 'right' }}>Δ rot (mrad)</div>
                {msaResult.perScan.map(ps => (
                  <Fragment_ key={ps.key}>
                    <div className="truncate" style={{ color: 'var(--text)' }}>{ps.label}</div>
                    <div style={{ textAlign: 'right' }}>{ps.nSpheres}</div>
                    <div style={{ textAlign: 'right', color: ps.deltaT < 0.005 ? 'var(--text-mute)' : 'var(--text)' }}>{(ps.deltaT * 1000).toFixed(2)}</div>
                    <div style={{ textAlign: 'right', color: ps.deltaR < 0.0005 ? 'var(--text-mute)' : 'var(--text)' }}>{(ps.deltaR * 1000).toFixed(2)}</div>
                  </Fragment_>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Every threshold the three stages above use. Collapsed by
          default — the defaults are meant to be usable untouched — but
          reachable, which they were not when they lived as literals in
          this file. */}
      <CoregisterParams p={cp} setP={setCp} />
    </div>
  );
}

function RmseSparkline({ history }: { history: number[] }) {
  if (history.length < 2) {
    return <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{history.length} iteration</div>;
  }
  const w = 280; const h = 40; const pad = 2;
  const max = Math.max(...history); const min = Math.min(...history);
  const span = max - min || 1;
  const pts = history.map((v, i) => {
    const x = pad + (i / (history.length - 1)) * (w - 2 * pad);
    const y = pad + (1 - (v - min) / span) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <div>
      <svg width={w} height={h} style={{ display: 'block', maxWidth: '100%' }}>
        <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      </svg>
      <div className="flex justify-between mono text-[9px]" style={{ color: 'var(--text-mute)' }}>
        <span>iter 1: {history[0].toFixed(3)} m</span>
        <span>iter {history.length}: {history[history.length - 1].toFixed(4)} m</span>
      </div>
    </div>
  );
}

function ScanPicker({ label, scans, value, onChange, keyFor }: {
  label: string;
  scans: UnifiedScan[];
  value: string;
  onChange: (v: string) => void;
  keyFor: (s: UnifiedScan) => string;
}) {
  const selected = scans.find(s => keyFor(s) === value);
  return (
    <div>
      <span className="chip mb-1.5">{label}</span>
      <select
        className="w-full mono text-[11.5px] py-1.5 px-2 rounded-md outline-none"
        style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">— pick scan —</option>
        {scans.map(s => (
          <option key={keyFor(s)} value={keyFor(s)}>
            [{s.importer}] {s.projectName} · {s.scanName}
          </option>
        ))}
      </select>
      {selected && (
        <div className="mono text-[9.5px] mt-1" style={{ color: 'var(--text-mute)' }}>
          Pose translation: ({selected.worldTranslation.map(v => v.toFixed(2)).join(', ')})
        </div>
      )}
    </div>
  );
}

function TieInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      className="mono text-[10.5px] py-0.5 px-1.5 outline-none"
      style={{ background: 'transparent', border: 'none', color: 'var(--text)', width: 90 }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="0.000"
      spellCheck={false}
    />
  );
}

const thStyle: React.CSSProperties = {
  padding: '4px 6px',
  color: 'var(--text-mute)',
  borderBottom: '1px solid var(--line)',
  textAlign: 'left',
  fontWeight: 'normal',
};
const tdStyle: React.CSSProperties = {
  borderBottom: '1px solid var(--line)',
  padding: 0,
};
const tdLabelStyle: React.CSSProperties = {
  padding: '4px 6px',
  color: 'var(--text-dim)',
  borderBottom: '1px solid var(--line)',
};

function residualColor(r: number | undefined): string {
  if (r == null) return 'var(--text-mute)';
  if (r < 0.05) return 'var(--accent)';
  if (r < 0.2) return 'var(--text)';
  return '#ffb4be';
}
