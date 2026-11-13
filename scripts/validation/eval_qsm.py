"""Are the QSM volumes sensible? TreeQSM's stem and branch volumes of the
field-measured trees against stem volumes from DBH and height.

    python -I eval_qsm.py --pairs dbh_pairs.csv --tile NAME OCTREE_DIR REFERENCE_LAS [--tile ...] [--cache DIR] [--out PREFIX]

`dbh_pairs.csv` is eval_dbh.py's (field tree → PointCloudLabeler tree). Each field
tree's height is that of the reference tree whose stem it stands on (the
reference ids of the points 1.0–1.6 m above ground within DBH / 2 + 0.15 m of it,
the most common one; the reference's z is height above ground).

Expected stem volume, two ways:
* Laasasenaho (1982) volume functions (stem over bark, stump to top, d cm,
  h m → dm³): the spruce function for conifers, the birch function for
  broadleaves — Finnish models, used here as an order-of-magnitude check;
* form factor 0.5: V = 0.5 · π (d / 2)² · h.
TreeQSM: the record's `stemVolume` (the trunk chain integrated) and the
branch volume of cylinders of order ≥ 1 (`branchVolume`, after the fix
that stopped counting the trunk's cylinders as branches).
Branches over stem, two ways that are not to be compared with each other:
`branch_over_stem_median`, the median of the trees' own ratios (most field
trees are small, and a small tree's ratio is several times a big one's),
and `branch_over_stem_sum`, all branches over all stems (the big trees
weigh most).
"""
import argparse
import json
import os
import sys

import numpy as np

sys.dont_write_bytecode = True  # no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tpdata  # noqa: E402


def laasasenaho(d_cm, h, conifer):
    if h <= 1.3 or d_cm <= 0:
        return float("nan")
    if conifer:   # spruce
        v = 0.022927 * d_cm ** 1.91505 * 0.99146 ** d_cm * h ** 2.82541 * (h - 1.3) ** -1.53547
    else:         # birch
        v = 0.011197 * d_cm ** 2.10253 * 0.98600 ** d_cm * h ** 3.98519 * (h - 1.3) ** -2.65900
    return v / 1000.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", required=True)
    ap.add_argument("--tile", nargs=3, action="append", required=True, metavar=("NAME", "OCTREE", "LAS"))
    ap.add_argument("--cache", default="cache"); ap.add_argument("--out", default=None)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    import pandas as pd
    from scipy.spatial import cKDTree
    pairs = pd.read_csv(a.pairs)
    rows = []
    for name, octree, las in a.tile:
        ref = tpdata.las_reference(las, a.cache)
        band = (ref["z"] > 1.0) & (ref["z"] < 1.6) & (ref["gt"] != 0)
        kd = cKDTree(np.c_[ref["x"][band], ref["y"][band]])
        gb = ref["gt"][band]
        order = np.argsort(ref["gt"], kind="stable")
        u, st = np.unique(ref["gt"][order], return_index=True)
        zmax = dict(zip(u.tolist(), np.maximum.reduceat(ref["z"][order], st).tolist()))
        q = json.load(open(os.path.join(octree, "qsm.json")))
        qsm = {t["treeId"]: t for t in q["trees"]}
        import geopandas as gpd  # noqa: F401  (positions come from the pairs file's ba_nr)
        sub = pairs[pairs.tile == name]
        pos = json.load(open(os.path.join(octree, "forest", "seeds.json")))["seeds"]
        seed_xy = {s["id"]: (s["x"] + s["lean"][0] * 1.3, s["y"] + s["lean"][1] * 1.3) for s in pos}
        for _, r in sub.iterrows():
            x, y = seed_xy.get(int(r["seed"]), (np.nan, np.nan))
            idx = kd.query_ball_point([x, y], 0.5 * float(r["field"]) + 0.15) if np.isfinite(x) else []
            if not idx:
                continue
            ids, c = np.unique(gb[idx], return_counts=True)
            g = int(ids[np.argmax(c)])
            h = zmax.get(g, np.nan)
            t = qsm.get(int(r["tree"]))
            if t is None:
                continue
            br = [b for b in t.get("branches", []) if b.get("branchOrder", 0) > 0]
            trunk_cyl = sum(b["volume"] for b in t.get("branches", []) if b.get("branchOrder", 0) == 0)
            conifer = r["group"] in ("spruce", "fir", "douglas", "other conifer")
            d = float(r["field"])
            rows.append(dict(tile=name, ba_nr=int(r["ba_nr"]), group=r["group"], conifer=conifer, dbh=d, h_ref=h, h_qsm=t["height"],
                             v_laas=laasasenaho(d * 100, h, conifer), v_ff=0.5 * np.pi * (d / 2) ** 2 * h,
                             v_stem=t["stemVolume"], v_branch=sum(b["volume"] for b in br), v_trunk_cyl=trunk_cyl,
                             v_total=t["totalVolume"], v_total_old=t["stemVolume"] + sum(b["volume"] for b in t.get("branches", []))))
    df = pd.DataFrame(rows)
    df["stem_vs_laas"] = df.v_stem / df.v_laas
    df["stem_vs_ff"] = df.v_stem / df.v_ff
    df["branch_share"] = df.v_branch / df.v_stem
    out = {}
    for grp, g in [("all", df)] + list(df.groupby("group")):
        out[grp] = dict(n=int(len(g)), stem_over_laasasenaho_median=round(float(g.stem_vs_laas.median()), 3),
                        stem_over_ff05_median=round(float(g.stem_vs_ff.median()), 3),
                        stem_sum_m3=round(float(g.v_stem.sum()), 2), laasasenaho_sum_m3=round(float(g.v_laas.sum()), 2),
                        branch_over_stem_median=round(float(g.branch_share.median()), 3),
                        branch_over_stem_sum=round(float(g.v_branch.sum() / g.v_stem.sum()), 3),
                        total_over_stem_old_sum=round(float(g.v_total_old.sum() / g.v_stem.sum()), 3))
    print(json.dumps(out, indent=1, ensure_ascii=False))
    if a.out:
        df.to_csv(a.out + "_trees.csv", index=False)
        json.dump(out, open(a.out + ".json", "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
