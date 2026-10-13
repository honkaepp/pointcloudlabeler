import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** The ten QC checks exist twice: in the renderer (src/metrics/qcFlags.ts,
 *  what the QC panel and Tree Review run) and in Rust (src-tauri/src/ops/qc.rs,
 *  what the command line, the console and the API run). A plot must rank
 *  the same way on both, so the two are held together here: every code,
 *  every label and every threshold that one side states must be stated
 *  by the other. A change to a rule then fails this test until it is
 *  made on both sides — the drift this guards against is a panel and a
 *  pipeline quietly disagreeing about which trees to look at. */
const ts = readFileSync(new URL('../metrics/qcFlags.ts', import.meta.url), 'utf8');
const rs = readFileSync(new URL('../../src-tauri/src/ops/qc.rs', import.meta.url), 'utf8');
const stats = readFileSync(new URL('../metrics/plotStats.ts', import.meta.url), 'utf8');

const CODES = [
  'no-dbh', 'crown-large', 'crown-small', 'slenderness', 'height-high',
  'height-low', 'few-points', 'qsm-coverage', 'qsm-completeness', 'qsm-volume',
];

describe('the QC checks agree between the renderer and the headless core', () => {
  it('emit the same ten codes', () => {
    const tsUnion = ts.slice(ts.indexOf('export type FlagCode ='), ts.indexOf(';', ts.indexOf('export type FlagCode =')));
    const tsCodes = [...tsUnion.matchAll(/'([a-z-]+)'/g)].map(m => m[1]);
    expect(tsCodes).toEqual(CODES);
    // as_str() is the one place the names are spelled; label() follows it.
    const asStr = rs.slice(rs.indexOf('pub fn as_str(self)'), rs.indexOf('pub fn label(self)'));
    const rsNames = [...asStr.matchAll(/FlagCode::\w+ => "([a-z-]+)",/g)].map(m => m[1]);
    expect(rsNames).toEqual(CODES);
  });

  it('label them with the same words', () => {
    const tsLabels = Object.fromEntries(
      [...ts.matchAll(/^\s+'([a-z-]+)': '([^']+)',$/gm)].map(m => [m[1], m[2]]));
    const rsLabels: Record<string, string> = {};
    const labelFn = rs.slice(rs.indexOf('pub fn label(self)'), rs.indexOf('#[derive', rs.indexOf('pub fn label(self)')));
    const asStr = rs.slice(rs.indexOf('pub fn as_str(self)'), rs.indexOf('pub fn label(self)'));
    const rsNameOf = Object.fromEntries([...asStr.matchAll(/FlagCode::(\w+) => "([a-z-]+)",/g)].map(m => [m[1], m[2]]));
    for (const m of labelFn.matchAll(/FlagCode::(\w+) => "([^"]+)",/g)) rsLabels[rsNameOf[m[1]]] = m[2];
    expect(rsLabels).toEqual(tsLabels);
  });

  /** Each entry is one threshold as each side spells it: the same number
   *  read from the same rule. */
  const THRESHOLDS: [string, RegExp, RegExp][] = [
    ['robust sigma 1.4826 × MAD', /1\.4826 \* m/, /1\.4826 \* m/],
    ['outlier: more than 3σ above the median', /z > 3,/, /out: z > 3\.0,/],
    ['no spread: three times the median', /v > med \* 3/, /v > med \* 3\.0/],
    ['fragment: crown under 0.15 × median', /crownArea < cMed \* 0\.15/, /t\.crown_area < c_med \* 0\.15/],
    ['fragment: points under 0.10 × median', /count < nMed \* 0\.10/, /\(t\.count as f64\) < n_med \* 0\.10/],
    ['slenderness window 0.3–4.0 cm/m', /ratio < 0\.3 \|\| ratio > 4\.0/, /\(0\.3\.\.=4\.0\)\.contains\(&ratio\)/],
    ['tall outlier: z above 4', /if \(z > 4\.0\) \{/, /if z > 4\.0 \{/],
    ['short outlier: z below −3 and under 3 m', /z < -3\.0 && t\.height < 3\.0/, /z < -3\.0 && t\.height < 3\.0/],
    ['few points: under 0.05 × median', /count < nMed \* 0\.05/, /\(t\.count as f64\) < n_med \* 0\.05/],
    ['QSM coverage under 0.50', /q\.confidence < 0\.50/, /q\.confidence < 0\.50/],
    ['QSM completeness under 0.50', /q\.completeness < 0\.50/, /q\.completeness < 0\.50/],
    ['QSM volume z above 4', /const z = \(q\.stemVolume - vMed\) \/ vSig;\s+if \(z > 4\.0\)/, /let z = \(q\.stem_volume - v_med\) \/ v_sig;\s+if z > 4\.0/],
  ];

  for (const [what, tsRe, rsRe] of THRESHOLDS) {
    it(`agree on ${what}`, () => {
      expect(ts, `renderer: ${what}`).toMatch(tsRe);
      expect(rs, `headless core: ${what}`).toMatch(rsRe);
    });
  }

  it('rank severities the same way', () => {
    expect(ts).toMatch(/SEV_RANK: Record<Severity, number> = \{ critical: 3, warning: 2, info: 1 \}/);
    expect(rs).toMatch(/Info = 1,\s+Warning = 2,\s+Critical = 3,/);
  });

  it('merge a RANSAC stem fit the same way', () => {
    expect(stats).toMatch(/Number\.isFinite\(f\.dbh\) && f\.dbh > 0/);
    expect(stats).toMatch(/basalArea: Math\.PI \* \(f\.dbh \* 0\.5\) \*\* 2/);
    expect(rs).toMatch(/f\.dbh\.is_finite\(\) && f\.dbh > 0\.0/);
    expect(rs).toMatch(/std::f64::consts::PI \* \(f\.dbh \* 0\.5\) \* \(f\.dbh \* 0\.5\)/);
  });
});
