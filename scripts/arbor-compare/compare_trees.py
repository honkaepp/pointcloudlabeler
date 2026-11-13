"""PointCloudLabeler's forest pass and QSM against Arbor on plot 1041: which trees
both find, and how their DBH, height and volume agree."""
import csv, json, math, sys, os
import numpy as np
from scipy.spatial import cKDTree
sys.stdout.reconfigure(encoding="utf-8")

# python compare_trees.py <dataset dir> <arbor out dir> <ours_metrics.json> <out dir> [cx cy r]
# ours_metrics.json: `pointcloudlabeler metrics trees --octree-dir <dataset> --compact`
D, A, MJ, OUT = sys.argv[1:5]
CX = float(sys.argv[5]) if len(sys.argv) > 5 else 399670.0
CY = float(sys.argv[6]) if len(sys.argv) > 6 else 6786365.0
R_CORE = float(sys.argv[7]) if len(sys.argv) > 7 else 30.0  # both sides see this disc well
MATCH = 0.75              # metres between stem bases

arbor = []
with open(os.path.join(A, 'arbor_trees.csv')) as f:
    for r in csv.DictReader(f):
        arbor.append({'id': int(r['ID']), 'x': float(r['X']), 'y': float(r['Y']),
                      'dbh': float(r['DBH']) if r['DBH'] not in ('NA', '') else math.nan,
                      'h': float(r['H']) if r['H'] not in ('NA', '') else math.nan,
                      'v': float(r['V']) if r['V'] not in ('NA', '') else math.nan,
                      'msg': r['Message']})
trees = json.load(open(os.path.join(D, 'forest', 'trees.json')))['trees']
metrics = {m['treeId']: m for m in json.load(open(MJ))}
qsm = {t['treeId']: t for t in json.load(open(os.path.join(D, 'qsm.json')))['trees']}
ours = []
for t in trees:
    m = metrics.get(t['tree'], {})
    q = qsm.get(t['tree'])
    tq = (q or {}).get('treeqsm') or {}
    ours.append({'id': t['tree'], 'x': t['x'], 'y': t['y'], 'h': t['height'], 'flags': t['flags'],
                 'dbh': m.get('dbh') if m.get('dbh') is not None else math.nan,
                 'dbh_qsm': tq.get('dbhCyl', math.nan) if tq else math.nan,
                 'v': (tq.get('totalVolume', math.nan) / 1000.0) if tq else math.nan})

def core(t): return math.hypot(t['x'] - CX, t['y'] - CY) <= R_CORE
def tall(t): return t['h'] >= 2.0

A2 = [t for t in arbor if core(t) and tall(t)]
O2 = [t for t in ours if core(t) and tall(t)]
# greedy one-to-one nearest within MATCH
kd = cKDTree(np.array([[t['x'], t['y']] for t in O2]))
pairs = []
for i, a in enumerate(A2):
    for d, j in zip(*kd.query([a['x'], a['y']], k=4, distance_upper_bound=MATCH)):
        if math.isfinite(d):
            pairs.append((d, i, j))
pairs.sort()
ua, uo, matched = set(), set(), []
for d, i, j in pairs:
    if i in ua or j in uo: continue
    ua.add(i); uo.add(j); matched.append((A2[i], O2[j], d))

def stats(name, a, b, unit, scale=1.0):
    a = np.array(a) * scale; b = np.array(b) * scale
    ok = np.isfinite(a) & np.isfinite(b)
    a, b = a[ok], b[ok]
    if len(a) < 3: return f'{name}: too few pairs'
    diff = b - a
    r = np.corrcoef(a, b)[0, 1]
    return (f'{name}: n={len(a)}  Arbor mean {a.mean():.2f} {unit}, ours {b.mean():.2f} {unit}  '
            f'bias (ours − Arbor) {diff.mean():+.2f} {unit} ({100*diff.mean()/a.mean():+.1f} %)  '
            f'RMSD {math.sqrt((diff**2).mean()):.2f} {unit} ({100*math.sqrt((diff**2).mean())/a.mean():.1f} %)  r² {r*r:.3f}  '
            f'median |Δ| {np.median(np.abs(diff)):.2f} {unit}')

print(f'Core disc: {R_CORE:.0f} m around the scanner, trees ≥ 2 m, stem bases matched within {MATCH} m')
print(f'  Arbor {len(A2)} trees, PointCloudLabeler {len(O2)} trees, matched {len(matched)} '
      f'({100*len(matched)/len(A2):.0f} % of Arbor\'s, {100*len(matched)/len(O2):.0f} % of ours)')
print(f'  only Arbor {len(A2)-len(matched)}, only PointCloudLabeler {len(O2)-len(matched)}')
dists = [m[2] for m in matched]
print(f'  base offset of matched stems: median {np.median(dists)*100:.1f} cm, 90 % {np.percentile(dists, 90)*100:.1f} cm')
# what the unmatched are
oa = [A2[i] for i in range(len(A2)) if i not in ua]
oo = [O2[j] for j in range(len(O2)) if j not in uo]
print(f'  unmatched Arbor: height median {np.median([t["h"] for t in oa]):.1f} m, DBH median {np.nanmedian([t["dbh"] for t in oa])*100:.1f} cm')
print(f'  unmatched ours:  height median {np.median([t["h"] for t in oo]):.1f} m, DBH median {np.nanmedian([t["dbh"] for t in oo])*100:.1f} cm, '
      f'no stem fit {sum("noStemFit" in t["flags"] for t in oo)}')
big = [(a, o) for a, o, _ in matched if np.isfinite(a['dbh']) and a['dbh'] >= 0.10]
print(stats('DBH (metrics), all matched', [a['dbh'] for a, o, _ in matched], [o['dbh'] for a, o, _ in matched], 'cm', 100))
print(stats('DBH (metrics), Arbor DBH ≥ 10 cm', [a['dbh'] for a, o in big], [o['dbh'] for a, o in big], 'cm', 100))
print(stats('DBH (TreeQSM), Arbor DBH ≥ 10 cm', [a['dbh'] for a, o in big], [o['dbh_qsm'] for a, o in big], 'cm', 100))
print(stats('Height', [a['h'] for a, o, _ in matched], [o['h'] for a, o, _ in matched], 'm'))
vv = [(a, o) for a, o, _ in matched if np.isfinite(o['v']) and np.isfinite(a['v']) and a['h'] >= 5]
print(stats('Total volume (TreeQSM vs Arbor QSM), trees ≥ 5 m', [a['v'] for a, o in vv], [o['v'] for a, o in vv], 'm³'))
# plot totals in the core
print(f'  core totals: Arbor V {np.nansum([t["v"] for t in A2]):.1f} m³ over {len(A2)} trees; '
      f'PointCloudLabeler TreeQSM V {np.nansum([t["v"] for t in O2]):.1f} m³ over {sum(np.isfinite(t["v"]) for t in O2)} trees with a QSM')
# Arbor's own log in the core
msgs = [a['msg'] for a in A2 if a['msg'] and a['msg'] != 'NA']
print(f'  Arbor trees with a log message in the core: {len(msgs)}')
json.dump({'matched': [(a['id'], o['id']) for a, o, _ in matched]}, open(os.path.join(OUT, 'pairs.json'), 'w'))

# --- the trees Arbor itself measured (its log empty), and the volumes
print()
arbor = list(csv.DictReader(open(os.path.join(A, 'arbor_trees.csv'))))
import collections
msg = collections.Counter((r['Message'] if r['Message'] not in ('', 'NA') else '(measured, no message)') for r in arbor)
print('Arbor, all', len(arbor), 'trees, first log message:')
for k, v in msg.most_common(): print(f'  {v:5d}  {k}')
core = [r for r in arbor if math.hypot(float(r['X']) - CX, float(r['Y']) - CY) <= 30 and float(r['H']) >= 2]
mc = collections.Counter((r['Message'] if r['Message'] not in ('', 'NA') else '(measured)') for r in core)
print('core 30 m, ≥ 2 m:', len(core), dict(mc))
big = [r for r in core if float(r['H']) >= 10]
print('core trees ≥ 10 m tall:', len(big), 'of which measured by Arbor:', sum(r['Message'] in ('', 'NA') for r in big))

# ours: how many trees ≥ 10 m in the core have a fitted stem
seeds = json.load(open(os.path.join(D, 'forest', 'seeds.json')))['seeds']
trees = {t['tree']: t for t in json.load(open(os.path.join(D, 'forest', 'trees.json')))['trees']}
fit = {s['tree'] for s in seeds if s['circles'] > 0}
ob = [t for t in trees.values() if math.hypot(t['x'] - CX, t['y'] - CY) <= 30 and t['height'] >= 10]
print('PointCloudLabeler core trees ≥ 10 m:', len(ob), 'with a fitted stem:', sum(t['tree'] in fit for t in ob))

pairs = [(a['id'], o['id']) for a, o, _ in matched]
amap = {int(r['ID']): r for r in arbor}
seed_r = {}
for s in seeds: seed_r[s['tree']] = max(seed_r.get(s['tree'], 0), s['r'])
qsm = {t['treeId']: t for t in json.load(open(os.path.join(D, 'qsm.json')))['trees']}
rows = []
for a_id, o_id in pairs:
    a = amap[a_id]
    if a['Message'] not in ('', 'NA'): continue
    q = qsm.get(o_id) or {}
    tq = q.get('treeqsm') or {}
    rows.append([float(a['DBH']) * 100, 2 * seed_r.get(o_id, 0) * 100, (tq.get('dbhCyl') or math.nan) * 100,
                 float(a['H']), trees[o_id]['height'], float(a['V']) if a['V'] not in ('NA', '') else math.nan,
                 (tq.get('totalVolume', math.nan) / 1000.0) if tq else math.nan,
                 (tq.get('trunkVolume', math.nan) / 1000.0) if tq else math.nan])
arr = np.array(rows, dtype=float)
print(f'\nmatched pairs that Arbor measured: {len(arr)}')
def st(name, a, b, unit):
    ok = np.isfinite(a) & np.isfinite(b) & (b > 0)
    a, b = a[ok], b[ok]; d = b - a
    print(f'  {name:28s} n={ok.sum():3d}  Arbor {a.mean():6.2f}  ours {b.mean():6.2f} {unit}  bias {d.mean():+6.2f} ({100*d.mean()/a.mean():+5.1f} %)  RMSD {math.sqrt((d**2).mean()):6.2f} ({100*math.sqrt((d**2).mean())/a.mean():4.1f} %)  r² {np.corrcoef(a,b)[0,1]**2:.3f}')
st('DBH: forest-pass stem 2r', arr[:, 0], arr[:, 1], 'cm')
st('DBH: TreeQSM dbhCyl', arr[:, 0], arr[:, 2], 'cm')
st('height', arr[:, 3], arr[:, 4], 'm')
st('volume: TreeQSM total', arr[:, 5], arr[:, 6], 'm³')
st('volume: TreeQSM trunk', arr[:, 5], arr[:, 7], 'm³')
same = np.abs(arr[:, 4] - arr[:, 3]) < 2
print(f'  heights within 2 m: {same.sum()} of {len(arr)}')
st('DBH stem 2r, heights agree', arr[same, 0], arr[same, 1], 'cm')
st('volume total, heights agree', arr[same, 5], arr[same, 6], 'm³')
