"""Instance segmentation against the hand-checked reference trees.

    python -I eval_forest.py <octree_dir> <reference.las> [--cache DIR] [--out PREFIX] [--min-points 1000] [--big 10]

The reference's `tree_id` is the truth for every tree it holds; very small
trees are missing from it (id 0), so a predicted tree that lies mostly in
unlabelled points is reported apart and not counted as a false positive.

* Matching: a predicted and a reference tree match when their point IoU is
  at least 0.5 (which makes the match one to one).
* Precision = TP / (TP + FP), FP = predicted trees (≥ min points) without
  a match whose points are mostly reference-tree points; recall = TP /
  reference trees; F1. Also for big trees (reference height ≥ `--big` m).
* Under-segmentation: a predicted tree that is the largest share of two or
  more reference trees (each tree's largest share). Over-segmentation: a
  reference tree with two or more predicted trees that are mostly its own,
  each holding ≥ 10 % of it.
* Point accuracy: of the reference-tree points, the share whose predicted
  tree is the one matched to their reference tree.
"""
import argparse
import json
import os
import sys

import numpy as np

sys.dont_write_bytecode = True  # no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tpdata  # noqa: E402


def evaluate(gt, pred, z, min_points=1000, big=10.0):
    gt = gt.astype(np.int64); pred = pred.astype(np.int64)
    pred[pred < 0] = 0
    gid, gsz = np.unique(gt[gt != 0], return_counts=True)
    pid, psz = np.unique(pred[pred != 0], return_counts=True)
    gsize = dict(zip(gid.tolist(), gsz.tolist())); psize = dict(zip(pid.tolist(), psz.tolist()))
    # reference height: the highest point (z is height above ground in the reference)
    order = np.argsort(gt, kind="stable"); gs = gt[order]
    u, st = np.unique(gs, return_index=True)
    zmax = np.maximum.reduceat(z[order], st)
    gheight = dict(zip(u.tolist(), zmax.tolist()))
    both = (gt != 0) | (pred != 0)
    M = int(pred.max()) + 1
    k, inter = np.unique(gt[both] * M + pred[both], return_counts=True)
    kg, kp = k // M, k % M
    ref = [g for g in gid.tolist() if gsize[g] >= min_points]
    refset = set(ref)
    # pairs
    by_g = {}; by_p = {}
    for g, p, c in zip(kg.tolist(), kp.tolist(), inter.tolist()):
        by_g.setdefault(g, []).append((p, c)); by_p.setdefault(p, []).append((g, c))
    match_g = {}; match_p = {}; iou_best = {}
    for g in ref:
        best = 0.0
        for p, c in by_g.get(g, []):
            if p == 0: continue
            iou = c / (gsize[g] + psize[p] - c)
            best = max(best, iou)
            if iou >= 0.5: match_g[g] = p; match_p[p] = g
        iou_best[g] = best
    # dominant pred of each reference tree, dominant reference tree of each pred
    dom_p = {g: max(((p, c) for p, c in by_g.get(g, []) if p != 0), key=lambda t: t[1], default=(0, 0))[0] for g in ref}
    dom_g = {}
    for p, lst in by_p.items():
        if p == 0: continue
        dom_g[p] = max(lst, key=lambda t: t[1])
    preds = [p for p in pid.tolist() if psize[p] >= min_points]
    fp = []; outside = []
    for p in preds:
        if p in match_p: continue
        g, c = dom_g[p]
        if g != 0 and g in refset: fp.append(p)
        else: outside.append(p)
    tp = len(match_g); fn = len(ref) - tp
    prec = tp / (tp + len(fp)) if tp + len(fp) else float("nan")
    rec = tp / len(ref) if ref else float("nan")
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    # big trees
    bigs = [g for g in ref if gheight[g] >= big]
    tpb = sum(1 for g in bigs if g in match_g)
    fpb = sum(1 for p in fp if gheight.get(dom_g[p][0], 0) >= big)
    precb = tpb / (tpb + fpb) if tpb + fpb else float("nan")
    recb = tpb / len(bigs) if bigs else float("nan")
    f1b = 2 * precb * recb / (precb + recb) if precb + recb else 0.0
    # under / over
    owners = {}
    for g in ref:
        p = dom_p[g]
        if p: owners.setdefault(p, []).append(g)
    merged_preds = {p: gs_ for p, gs_ in owners.items() if len(gs_) >= 2}
    merged_trees = sorted(g for gs_ in merged_preds.values() for g in gs_ if dom_g[dom_p[g]][0] != g)
    split = []
    for g in ref:
        pieces = [p for p, c in by_g.get(g, []) if p != 0 and dom_g[p][0] == g and c >= 0.1 * gsize[g]]
        if len(pieces) >= 2: split.append(g)
    # point accuracy on reference-tree points
    tot = sum(gsize[g] for g in ref)
    ok = 0; stolen = {}; mine = {}
    for g in ref:
        p0 = match_g.get(g)
        lst = by_g.get(g, [])
        own = sum(c for p, c in lst if p == p0) if p0 else 0
        ok += own
        mine[g] = own / gsize[g]
        stolen[g] = sum(c for p, c in lst if p != 0 and p != p0) / gsize[g]
    acc = ok / tot if tot else float("nan")
    accb = sum(mine[g] * gsize[g] for g in bigs) / max(1, sum(gsize[g] for g in bigs))
    ious = np.array([iou_best[g] for g in ref]); iousb = np.array([iou_best[g] for g in bigs])
    q = lambda a: [round(float(v), 3) for v in np.percentile(a, [10, 25, 50, 75, 90])] if len(a) else []
    summary = dict(
        reference_trees=len(ref), big_trees=len(bigs), predicted_trees=len(preds), tp=tp, fp=len(fp), fn=fn,
        outside_reference=len(outside), precision=prec, recall=rec, f1=f1,
        big=dict(tp=tpb, fp=fpb, fn=len(bigs) - tpb, precision=precb, recall=recb, f1=f1b),
        iou_mean=float(ious.mean()) if len(ious) else float("nan"), iou_pct_10_25_50_75_90=q(ious),
        iou_big_mean=float(iousb.mean()) if len(iousb) else float("nan"), iou_big_pct=q(iousb),
        under_segmented_preds=len(merged_preds), swallowed_trees=len(merged_trees), over_segmented_trees=len(split),
        point_accuracy=acc, point_accuracy_big=accb,
    )
    rows = [dict(gt=g, points=gsize[g], height=round(gheight[g], 2), best_iou=round(iou_best[g], 3), match=match_g.get(g, 0),
                 own=round(mine[g], 3), to_others=round(stolen[g], 3), swallowed=g in merged_trees, split=g in split) for g in ref]
    return summary, rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("octree"); ap.add_argument("las")
    ap.add_argument("--cache", default="cache"); ap.add_argument("--out", default=None)
    ap.add_argument("--min-points", type=int, default=1000); ap.add_argument("--big", type=float, default=10.0)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    j = tpdata.joined(a.octree, a.las, a.cache)
    s, rows = evaluate(j["gt"], j["pred"], j["z"], a.min_points, a.big)
    print(json.dumps(s, indent=1))
    if a.out:
        json.dump(dict(summary=s, trees=rows), open(a.out + ".json", "w"), indent=1)


if __name__ == "__main__":
    main()
