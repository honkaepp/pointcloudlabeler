// Co-registration parameters — the numbers the panel used to hold as
// literals at its call sites.
//
// Every default here is what the code shipped with, and most of them
// are RIEGL's own, read out of a RiSCAN PRO project's
// `regsettings.json` (see commands/coregister.rs for which transferred
// and which deliberately did not). Defaults are the point: a forester
// should be able to run this without touching anything. But a plot with
// 3 cm-thick undergrowth, a scanner at a different range, or a stand
// where the ground is the only usable plane is not the plot these
// numbers were chosen on, and there was no way to say so from the UI.
//
// Values are text, parsed once when a run builds its payload — see
// NumberField for why a number in state cannot be typed into.

import { useState } from 'react';
import NumberField, { parseCount, parseNum } from '../NumberField';

export const COREG_DEFAULTS = {
  // --- Sphere targets (detection) ---
  sphRMin: '0.05',
  sphRMax: '0.20',
  sphRmseRelMax: '0.10',
  sphMinClusterPoints: '30',
  sphVoxelSize: '0.20',
  // --- Sphere targets (RANSAC matching across a pair) ---
  sphRadiusTol: '0.01',
  sphInlierTol: '0.05',
  sphIterations: '500',
  // --- Plane patches (extraction) ---
  plVoxelSize: '0.50',          // RIEGL voxelExtractor.voxelSize
  plPlanarityMax: '0.015',      // ours — not RIEGL's planeThreshold
  plMinVoxelPoints: '16',       // ours — RIEGL's 5 is a full-density count
  plNormalAngleTolDeg: '10',    // ours — RIEGL splits this into two merges
  plMinPatchPoints: '200',      // ours — density again
  plMaxStdDev: '0.03',          // RIEGL planeExtractor.maxStdDev
  plMinSize: '0.125',           // RIEGL planeExtractor.minSize
  plMaxSize: '0',               // 0 = no ceiling; RIEGL's 5 m deletes a 6 m ground plane
  // --- Plane patches (matching) ---
  pmMaxPlanarity: '0.01',
  pmMinExtent: '0.125',         // RIEGL planeExtractor.minSize
  pmNormalAngleTolDeg: '2.5',   // RIEGL planeMatcher.maxAngleDifference
  pmCentroidDistTol: '0.25',    // RIEGL planeMatcher.maxDistance
  pmIterations: '500',
  pmSamplesPerPair: '4',
  // --- Multi-Station Adjustment ---
  msaMaxIters: '1000',          // RIEGL lsqFitter.maxIterations
  msaLambdaInit: '1e-4',
  msaRmseEps: '1e-6',           // RIEGL lsqFitter.tolerance
  msaPreserveRollPitch: true,   // RIEGL lsqFitterPlanes.preserveRollAndPitch
  // --- ICP ---
  icpSamplePoints: '60000',
};

export type CoregParams = typeof COREG_DEFAULTS;

/** The parsed payloads each backend command wants. Parsing happens
 *  here, once per run, so a half-typed field falls back to its default
 *  visibly at submit instead of on every keystroke. */
export function coregPayload(p: CoregParams) {
  return {
    sphereDetect: {
      rMin: parseNum(p.sphRMin, 0.05),
      rMax: parseNum(p.sphRMax, 0.20),
      rmseRelMax: parseNum(p.sphRmseRelMax, 0.10),
      minClusterPoints: parseCount(p.sphMinClusterPoints, 30),
      voxelSize: parseNum(p.sphVoxelSize, 0.20),
    },
    sphereMatch: {
      radiusTol: parseNum(p.sphRadiusTol, 0.01),
      inlierTol: parseNum(p.sphInlierTol, 0.05),
      iterations: parseCount(p.sphIterations, 500),
    },
    planeExtract: {
      voxelSize: parseNum(p.plVoxelSize, 0.50),
      planarityMax: parseNum(p.plPlanarityMax, 0.015),
      minVoxelPoints: parseCount(p.plMinVoxelPoints, 16),
      normalAngleTolDeg: parseNum(p.plNormalAngleTolDeg, 10),
      minPatchPoints: parseCount(p.plMinPatchPoints, 200),
      maxStdDev: parseNum(p.plMaxStdDev, 0.03),
      minSize: parseNum(p.plMinSize, 0.125),
      // 0 is a real value here (no ceiling), so the floor is 0.
      maxSize: Math.max(0, parseNum(p.plMaxSize, 0)),
    },
    planeMatch: {
      maxPlanarity: parseNum(p.pmMaxPlanarity, 0.01),
      minExtent: parseNum(p.pmMinExtent, 0.125),
      normalAngleTolDeg: parseNum(p.pmNormalAngleTolDeg, 2.5),
      centroidDistTol: parseNum(p.pmCentroidDistTol, 0.25),
      iterations: parseCount(p.pmIterations, 500),
      samplesPerPair: parseCount(p.pmSamplesPerPair, 4),
    },
    msa: {
      maxIters: parseCount(p.msaMaxIters, 1000),
      lambdaInit: parseNum(p.msaLambdaInit, 1e-4),
      rmseEps: parseNum(p.msaRmseEps, 1e-6),
      preserveRollPitch: p.msaPreserveRollPitch,
    },
    icpSamplePoints: parseCount(p.icpSamplePoints, 60000),
  };
}

interface Props {
  p: CoregParams;
  setP: (p: CoregParams) => void;
}

export default function CoregisterParams({ p, setP }: Props) {
  const [open, setOpen] = useState(false);
  const set = (k: keyof CoregParams) => (v: string) => setP({ ...p, [k]: v });
  const changed = (Object.keys(COREG_DEFAULTS) as (keyof CoregParams)[])
    .filter(k => p[k] !== COREG_DEFAULTS[k]).length;

  return (
    <div className="mt-2" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
      <div className="flex items-center gap-2">
        <button
          className="mono text-[10.5px] px-1.5 py-0.5 rounded-sm"
          style={{ color: 'var(--text-dim)', border: '1px solid var(--line)' }}
          onClick={() => setOpen(!open)}
        >
          {open ? '▾' : '▸'} Parameters
        </button>
        <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
          {changed === 0 ? 'defaults (RIEGL RiSCAN PRO, where the quantity transfers)' : `${changed} changed from default`}
        </span>
        {changed > 0 && (
          <button
            className="mono text-[9.5px] px-1.5 py-0.5 rounded-sm ml-auto"
            style={{ color: 'var(--text-dim)', border: '1px solid var(--line)' }}
            onClick={() => setP({ ...COREG_DEFAULTS })}
          >
            Reset
          </button>
        )}
      </div>

      {open && (
        <div className="flex flex-col gap-2 mt-2">
          <Group label="Sphere targets — detection">
            <Row>
              <NumberField label="r min (m)" value={p.sphRMin} onChange={set('sphRMin')} title="Smallest sphere radius accepted. RIEGL's targets are 7.5 and 14.5 cm." />
              <NumberField label="r max (m)" value={p.sphRMax} onChange={set('sphRMax')} />
              <NumberField label="RMSE / r" value={p.sphRmseRelMax} onChange={set('sphRmseRelMax')} title="Max sphere-fit RMSE as a fraction of the radius." />
            </Row>
            <Row>
              <NumberField label="min cluster pts" value={p.sphMinClusterPoints} onChange={set('sphMinClusterPoints')} />
              <NumberField label="voxel (m)" value={p.sphVoxelSize} onChange={set('sphVoxelSize')} title="Candidate search cell — roughly the target diameter." />
            </Row>
          </Group>

          <Group label="Sphere targets — matching">
            <Row>
              <NumberField label="radius tol (m)" value={p.sphRadiusTol} onChange={set('sphRadiusTol')} title="Two spheres can only pair if their radii agree this closely. The default sits well inside the 7 cm gap between RIEGL's two sizes." />
              <NumberField label="inlier tol (m)" value={p.sphInlierTol} onChange={set('sphInlierTol')} />
              <NumberField label="RANSAC iters" value={p.sphIterations} onChange={set('sphIterations')} />
            </Row>
          </Group>

          <Group label="Plane patches — extraction">
            <Row>
              <NumberField label="voxel (m)" value={p.plVoxelSize} onChange={set('plVoxelSize')} title="RIEGL voxelExtractor.voxelSize = 0.50 m." />
              <NumberField label="planarity max" value={p.plPlanarityMax} onChange={set('plPlanarityMax')} title="λ_min / Σλ per voxel. Ours, NOT RIEGL's planeThreshold — a different ratio of different quantities." />
              <NumberField label="min pts / voxel" value={p.plMinVoxelPoints} onChange={set('plMinVoxelPoints')} title="Ours: RIEGL's 5 counts points at full scan density, and this runs on a 200 k subsample." />
            </Row>
            <Row>
              <NumberField label="grow angle (°)" value={p.plNormalAngleTolDeg} onChange={set('plNormalAngleTolDeg')} title="Region-growing tolerance between neighbouring voxels. Ours: RIEGL splits this into two merge stages." />
              <NumberField label="min pts / patch" value={p.plMinPatchPoints} onChange={set('plMinPatchPoints')} />
              <NumberField label="max std dev (m)" value={p.plMaxStdDev} onChange={set('plMaxStdDev')} title="RIEGL planeExtractor.maxStdDev = 0.03 m. Catches two parallel surfaces merged into one patch, which the eigenvalue ratio cannot." />
            </Row>
            <Row>
              <NumberField label="min size (m)" value={p.plMinSize} onChange={set('plMinSize')} title="RIEGL planeExtractor.minSize = 0.125 m, on the longer side of the patch." />
              <NumberField label="max size (m, 0 = none)" value={p.plMaxSize} onChange={set('plMaxSize')} title="RIEGL's 5 m bounds the pieces its extractor cuts a surface INTO; ours grows one patch per surface, so a ceiling deletes a 6 m ground plane instead of splitting it. Default off." />
            </Row>
          </Group>

          <Group label="Plane patches — matching">
            <Row>
              <NumberField label="max planarity" value={p.pmMaxPlanarity} onChange={set('pmMaxPlanarity')} />
              <NumberField label="min extent (m)" value={p.pmMinExtent} onChange={set('pmMinExtent')} title="On the patch's diagonal, unlike the extractor's min size." />
              <NumberField label="angle tol (°)" value={p.pmNormalAngleTolDeg} onChange={set('pmNormalAngleTolDeg')} title="RIEGL planeMatcher.maxAngleDifference = 2.5°." />
            </Row>
            <Row>
              <NumberField label="dist tol (m)" value={p.pmCentroidDistTol} onChange={set('pmCentroidDistTol')} title="RIEGL planeMatcher.maxDistance = 0.25 m. Tighter than the pose error a registration starts from rejects the matches it is meant to find." />
              <NumberField label="RANSAC iters" value={p.pmIterations} onChange={set('pmIterations')} />
              <NumberField label="samples / pair" value={p.pmSamplesPerPair} onChange={set('pmSamplesPerPair')} />
            </Row>
          </Group>

          <Group label="Adjustment (MSA) + ICP">
            <Row>
              <NumberField label="max iters" value={p.msaMaxIters} onChange={set('msaMaxIters')} title="RIEGL lsqFitter.maxIterations = 1000. A cap: the RMSE test normally stops it far sooner." />
              <NumberField label="λ initial" value={p.msaLambdaInit} onChange={set('msaLambdaInit')} title="Levenberg-Marquardt damping at the first step." />
              <NumberField label="RMSE ε" value={p.msaRmseEps} onChange={set('msaRmseEps')} title="RIEGL lsqFitter.tolerance = 1e-6." />
            </Row>
            <Row>
              <NumberField label="ICP sample pts" value={p.icpSamplePoints} onChange={set('icpSamplePoints')} title="Points sampled per cloud for the ICP fit. Higher is slower, not necessarily better." />
            </Row>
          </Group>
        </div>
      )}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{label}</span>
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-1.5 items-end">{children}</div>;
}
