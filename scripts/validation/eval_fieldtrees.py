"""The trees that count: every field-measured tree (the inventory, DBH from
about 7 cm) and its 3D point IoU against the hand-checked reference tree it
stands in, for PointCloudLabeler and, when given, Arbor — tree by tree.

    python -I eval_fieldtrees.py --gpkg INVENTORY.gpkg \
        --tile NAME OCTREE_DIR REFERENCE_LAS [arbor=arbor_pred.npy] [--tile ...] [--out PREFIX]

* A field tree's reference tree is the most common reference id among the
  reference points 1.0–1.6 m above ground within DBH / 2 + 0.15 m of its
  position (past the stem's surface).
  Field trees standing on no reference tree are counted apart. Two field
  trees on one reference tree (a fork the inventory lists twice) count it
  once.
* A reference tree's IoU is the best IoU of any predicted tree with it
  (|g ∩ p| / |g ∪ p| over all points of the tile, unlabelled ones included).
* `arbor=` is eval_arbor.py's `<out>_pred.npy` (Arbor's ids on the
  reference points, in the reference's order).
* Pooled: a tree in two tiles counts once, from the tile it stands deepest in.
"""
import argparse
import json
import os
import sys

import numpy as np

sys.dont_write_bytecode = True  # no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tpdata  # noqa: E402
from eval_dbh import field_trees  # noqa: E402


def best_iou(gt, pred, ids):
    """For each reference id in `ids`: (best IoU, the predicted id giving it)."""
    gt = gt.astype(np.int64); pred = pred.astype(np.int64); pred[pred < 0] = 0
    want = np.zeros(int(gt.max()) + 1, bool); want[list(ids)] = True
    gsize = np.bincount(gt, minlength=len(want))
    psize = np.bincount(pred)
    m = want[gt] & (pred != 0)
    M = int(pred.max()) + 1
    k, c = np.unique(gt[m] * M + pred[m], return_counts=True)
    out = {g: (0.0, 0) for g in ids}
    for kk, cc in zip(k.tolist(), c.tolist()):
        g, p = kk // M, kk % M
        iou = cc / (gsize[g] + psize[p] - cc)
        if iou > out[g][0]:
            out[g] = (iou, p)
    return out


def summary(v):
    v = np.asarray(v, float)
    if not len(v):
        return {}
    return dict(n=int(len(v)), mean=round(float(v.mean()), 4), median=round(float(np.median(v)), 4),
                p10=round(float(np.percentile(v, 10)), 4), ge_0_95=round(float((v >= 0.95).mean()), 3),
                ge_0_9=round(float((v >= 0.9).mean()), 3), ge_0_8=round(float((v >= 0.8).mean()), 3),
                ge_0_5=round(float((v >= 0.5).mean()), 3))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gpkg", required=True)
    ap.add_argument("--tile", nargs="+", action="append", required=True, help="NAME OCTREE_DIR LAS [arbor=PRED.npy]")
    ap.add_argument("--cache", default="cache"); ap.add_argument("--out", default=None)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    import laspy
    from scipy.spatial import cKDTree
    rows = []
    for spec in a.tile:
        name, octree, las = spec[:3]
        extra = dict(s.split("=", 1) for s in spec[3:])
        with laspy.open(las) as f:
            h = f.header
            bounds = (h.mins[0], h.mins[1], h.maxs[0], h.maxs[1])
        field = field_trees(a.gpkg, bounds).reset_index(drop=True)
        j = tpdata.joined(octree, las, a.cache)
        gt, z, x, y = j["gt"], j["z"], j["x"], j["y"]
        band = (z > 1.0) & (z < 1.6) & (gt != 0)
        kd = cKDTree(np.c_[x[band], y[band]]); gb = gt[band]
        on = []
        for e, n, d in zip(field["easting"].astype(float), field["northing"].astype(float), field["dbh"].astype(float)):
            # round the stem's centre out to past its surface
            idx = kd.query_ball_point([e, n], 0.5 * d + 0.15)
            if idx:
                ids, c = np.unique(gb[idx], return_counts=True); on.append(int(ids[np.argmax(c)]))
            else:
                on.append(0)
        ref = sorted({g for g in on if g})
        tp = best_iou(gt, j["pred"], ref)
        ar = best_iou(gt, np.load(extra["arbor"]), ref) if "arbor" in extra else {}
        gh = {}
        order = np.argsort(gt, kind="stable"); u, st = np.unique(gt[order], return_index=True)
        zmax = dict(zip(u.tolist(), np.maximum.reduceat(z[order], st).tolist()))
        seen = set()
        for i, g in enumerate(on):
            f = field.iloc[i]
            r = dict(tile=name, ba_nr=int(f["ba_nr"]), species=f["baumart"], group=f["group"], dbh=float(f["dbh"]),
                     edge=float(f["edge"]), ref=g, first=g not in seen)
            if g:
                # id 0 is the reference's unlabelled points, not a tree: no height
                r.update(ref_height=round(zmax[g], 2), pcl=round(tp[g][0], 4), pcl_tree=tp[g][1])
                if ar:
                    r.update(arbor=round(ar[g][0], 4), arbor_tree=ar[g][1])
            seen.add(g)
            rows.append(r)
    import pandas as pd
    df = pd.DataFrame(rows)
    on_ref = df[df.ref != 0]
    report = dict(field_trees=int(len(df)), on_no_reference_tree=int((df.ref == 0).sum()), tiles={})
    for name, g in on_ref[on_ref["first"]].groupby("tile"):
        report["tiles"][name] = {s: summary(g[s]) for s in ["pcl", "arbor"] if s in g}
    pooled = on_ref[on_ref["first"]].sort_values("edge", ascending=False).drop_duplicates("ba_nr")
    pooled = pooled.drop_duplicates(["tile", "ref"])
    report["pooled"] = {s: summary(pooled[s]) for s in ["pcl", "arbor"] if s in pooled}
    if "arbor" in pooled:
        d = pooled.pcl - pooled.arbor
        report["head_to_head"] = dict(pcl_better=int((d > 0.005).sum()), arbor_better=int((d < -0.005).sum()),
                                      tie=int((d.abs() <= 0.005).sum()))
    print(json.dumps(report, indent=1, ensure_ascii=False))
    if a.out:
        df.to_csv(a.out + "_trees.csv", index=False)
        json.dump(report, open(a.out + ".json", "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
