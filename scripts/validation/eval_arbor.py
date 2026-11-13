"""Arbor's segmentation of a tile against the reference trees, on the same
points and with the same measures as PointCloudLabeler's (eval_forest.evaluate).

    python -I eval_arbor.py <arbor_segmented.laz> <reference.las> [--cache DIR] [--out PREFIX] [--radius 0.1]

Arbor homogenizes the cloud first (barycentres of 2 cm voxels and
reinjected points), so its points are not the reference's: every
reference point takes the treeID of the nearest Arbor point within
`--radius` (none farther away). Arbor's flagged trees (buffer, small)
keep their ids, as PointCloudLabeler's flagged trees do.
"""
import argparse
import json
import os
import sys

import numpy as np

sys.dont_write_bytecode = True  # no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tpdata  # noqa: E402
import eval_forest  # noqa: E402


def arbor_labels(arbor_laz, ref, radius):
    import laspy
    from scipy.spatial import cKDTree
    a = laspy.read(arbor_laz)
    tid = np.asarray(a["treeID"]).astype(np.int64)
    tid[~np.isfinite(tid.astype(float)) | (tid < 0)] = 0
    org = np.array([ref["x"].min(), ref["y"].min(), 0.0])
    P = np.c_[np.asarray(a.x) - org[0], np.asarray(a.y) - org[1], np.asarray(a.z)]
    kd = cKDTree(P, leafsize=32, balanced_tree=False, compact_nodes=False)
    Q = np.c_[ref["x"] - org[0], ref["y"] - org[1], ref["z"]]
    out = np.zeros(len(Q), np.int64)
    step = 5_000_000
    for s in range(0, len(Q), step):
        d, i = kd.query(Q[s:s + step], k=1, distance_upper_bound=radius, workers=-1)
        ok = np.isfinite(d)
        out[s:s + step][ok] = tid[i[ok]]
    return out, a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("arbor"); ap.add_argument("las")
    ap.add_argument("--cache", default="cache"); ap.add_argument("--out", default=None)
    ap.add_argument("--radius", type=float, default=0.1)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    ref = tpdata.las_reference(a.las, a.cache)
    pred, _ = arbor_labels(a.arbor, ref, a.radius)
    s, rows = eval_forest.evaluate(ref["gt"], pred, ref["z"])
    print(json.dumps(s, indent=1))
    if a.out:
        json.dump(dict(summary=s, trees=rows), open(a.out + ".json", "w"), indent=1)
        np.save(a.out + "_pred.npy", pred.astype(np.int32))


if __name__ == "__main__":
    main()
