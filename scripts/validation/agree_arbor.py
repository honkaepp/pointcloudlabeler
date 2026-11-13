"""Where there is no reference (plot 1041, TLS): PointCloudLabeler's trees against
Arbor's on the same points, with the measures of eval_forest — agreement,
not accuracy, to see that a change does not make PointCloudLabeler worse there.

    python -I agree_arbor.py <octree_dir> <arbor_segmented.laz> --centre X Y --radius R [--out PREFIX]

Every dataset point inside the disc takes the treeID and height above
ground of the nearest Arbor point within 0.1 m (Arbor read half the
points, so most have one a few centimetres away); points without one are
left out. Arbor's trees (≥ 1000 points) play the reference.
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("octree"); ap.add_argument("arbor")
    ap.add_argument("--centre", nargs=2, type=float, required=True)
    ap.add_argument("--radius", type=float, default=30.0)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    import laspy
    from scipy.spatial import cKDTree
    rec, scale, off, _ = tpdata.read_octree(a.octree)
    cx, cy = a.centre
    x = rec["x"] * scale[0] + off[0]; y = rec["y"] * scale[1] + off[1]; z = rec["z"] * scale[2] + off[2]
    keep = ((x - cx) ** 2 + (y - cy) ** 2 <= a.radius ** 2) & (rec["cls"] != 2)
    x, y, z, pred = x[keep], y[keep], z[keep], rec["tree"][keep].astype(np.int64)
    al = laspy.read(a.arbor)
    ax, ay, az = np.asarray(al.x), np.asarray(al.y), np.asarray(al.z)
    m = (ax - cx) ** 2 + (ay - cy) ** 2 <= (a.radius + 1) ** 2
    tid = np.asarray(al["treeID"])[m]; tid = np.where(np.isfinite(tid.astype(float)), tid, 0).astype(np.int64)
    hag = np.asarray(al["hag"])[m]
    kd = cKDTree(np.c_[ax[m] - cx, ay[m] - cy, az[m]])
    d, i = kd.query(np.c_[x - cx, y - cy, z], k=1, distance_upper_bound=0.1, workers=-1)
    ok = np.isfinite(d)
    ref = np.where(ok, tid[np.minimum(i, len(tid) - 1)], 0)
    h = np.where(ok, hag[np.minimum(i, len(hag) - 1)], 0.0)
    s, rows = eval_forest.evaluate(ref[ok], pred[ok], h[ok])
    s["points"] = int(ok.sum())
    print(json.dumps(s, indent=1))
    if a.out:
        json.dump(dict(summary=s, trees=rows), open(a.out + ".json", "w"), indent=1)


if __name__ == "__main__":
    main()
