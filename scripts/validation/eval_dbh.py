"""DBH against the field inventory.

    python -I eval_dbh.py --gpkg ramerenwald_inv2_2023.gpkg \
        --tile FP05 <octree_dir> <reference.las> [--metrics metrics.json] [--qsm qsm.json] \
        [--tile FP07 ...] [--out dbh]

Field DBH: the mean of the two caliper diameters (`bhd_sn`, `bhd_we`, mm)
where measured, else the circumference / π, else `bhd_measure_direction`
(already metres; checked against the reference trees' own circles at
1.3 m: calipers bias −0.6 cm, RMSE 1.9 cm; the rounded column RMSE 3.6 cm).
Positions are `easting` / `northing` (closer to the stems than the point
geometry, which is off by metres for some rows). Trees lying down are left
out; the tile is the reference LAS's extent.

Each inventory tree is paired with the stem nearest it at 1.3 m — every
seed of the forest pass (forest/seeds.json), one to one (Hungarian), no
further than `--gate` metres. The DBH of each source for that stem:

* `seed`:    2 r of the seed (the forest pass's stem circles),
* `metrics`: `metrics.trees` of the seed's tree (`--metrics`, its JSON),
* `qsm`:     TreeQSM's `dbhCyl` of the seed's tree (`--qsm`, qsm.json),
* `qsmSlice`: the QSM record's own `dbh` (the trunk interpolated at 1.3 m),
* `arbor`:   Arbor's treemap DBH (`arbor=arbor_trees.csv`, paired to the field
  trees on its own positions), and `arbor_measured` the trees Arbor
  measured (no message; the rest are its allometry).

Reported per tile and pooled (a tree in two tiles counts once, from the
tile it stands deepest in), by species: bias (estimate − field), RMSE,
relative RMSE and r².
"""
import argparse
import json
import os
import sys

import numpy as np

SPECIES = {"Rot-Buche": "beech", "Fichte": "spruce", "Tanne": "fir", "Douglasfichte": "douglas"}
CONIFERS = {"Fichte", "Tanne", "Douglasfichte", "Wald-Föhre"}


def species_group(name):
    if name in SPECIES:
        return SPECIES[name]
    return "other conifer" if name in CONIFERS else "other broadleaf"


def field_trees(gpkg, bounds, margin=0.3):
    import geopandas as gpd
    g = gpd.read_file(gpkg, layer="view_rameren_inv2")
    x0, y0, x1, y1 = bounds
    e, n = g["easting"].astype(float), g["northing"].astype(float)
    inside = (e >= x0 + margin) & (e <= x1 - margin) & (n >= y0 + margin) & (n <= y1 - margin)
    lying = g["field_remark"].fillna("").str.contains("Liegend")
    g = g[inside & ~lying].copy()
    cal = (g["bhd_sn"].astype(float) + g["bhd_we"].astype(float)) / 2000.0
    circ = g["circumference"].astype(float) / np.pi / 1000.0
    g["dbh"] = cal.where(cal.notna(), circ.where(circ.notna(), g["bhd_measure_direction"].astype(float)))
    g["dbh_source"] = np.where(cal.notna(), "caliper", np.where(circ.notna(), "circumference", "column"))
    g["group"] = g["baumart"].map(species_group)
    g["edge"] = np.minimum.reduce([e[g.index] - x0, x1 - e[g.index], n[g.index] - y0, y1 - n[g.index]])
    return g[g["dbh"].notna()]


def stems(octree_dir):
    meta = json.load(open(os.path.join(octree_dir, "forest", "seeds.json")))
    out = []
    for s in meta["seeds"]:
        out.append(dict(seed=s["id"], tree=s["tree"], x=s["x"] + s["lean"][0] * 1.3, y=s["y"] + s["lean"][1] * 1.3,
                        seed_dbh=2 * s["r"] if s["r"] > 0 else np.nan, source=s["source"]))
    return out


def pair(field, cand, gate):
    from scipy.optimize import linear_sum_assignment
    from scipy.spatial import cKDTree
    if not len(field) or not cand:
        return []
    F = np.c_[field["easting"].astype(float), field["northing"].astype(float)]
    C = np.array([[c["x"], c["y"]] for c in cand])
    kd = cKDTree(C)
    big = 1e6
    cost = np.full((len(F), len(C)), big)
    for i, lst in enumerate(kd.query_ball_point(F, gate)):
        for j in lst:
            cost[i, j] = np.hypot(*(F[i] - C[j]))
    # only the columns anyone can reach keep the problem small
    cols = np.flatnonzero((cost < big).any(axis=0))
    if not len(cols):
        return []
    r, c = linear_sum_assignment(cost[:, cols])
    return [(i, cols[j], cost[i, cols[j]]) for i, j in zip(r, c) if cost[i, cols[j]] < big]


def stats(est, ref):
    m = np.isfinite(est) & np.isfinite(ref)
    e, r = est[m], ref[m]
    if len(e) < 2:
        return dict(n=int(len(e)))
    d = e - r
    rmse = float(np.sqrt(np.mean(d ** 2)))
    return dict(n=int(len(e)), bias_cm=round(float(d.mean()) * 100, 2), bias_pct=round(float(d.mean() / r.mean()) * 100, 1),
                rmse_cm=round(rmse * 100, 2), rrmse_pct=round(rmse / float(r.mean()) * 100, 1),
                r2=round(float(np.corrcoef(e, r)[0, 1] ** 2), 3), mae_cm=round(float(np.median(np.abs(d))) * 100, 2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gpkg", required=True)
    ap.add_argument("--tile", nargs="+", action="append", required=True,
                    help="NAME OCTREE_DIR LAS [metrics=FILE] [qsm=FILE] [arbor=FILE]")
    ap.add_argument("--gate", type=float, default=1.0)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    import laspy
    rows = []
    detection = {}
    for spec in a.tile:
        name, octree, las = spec[:3]
        extra = dict(s.split("=", 1) for s in spec[3:])
        with laspy.open(las) as f:
            h = f.header
            bounds = (h.mins[0], h.mins[1], h.maxs[0], h.maxs[1])
        field = field_trees(a.gpkg, bounds).reset_index(drop=True)
        cand = stems(octree)
        met = {}
        if "metrics" in extra:
            for m in json.load(open(extra["metrics"])):
                met[m["treeId"]] = m.get("dbh", np.nan)
        qsm, qsl = {}, {}
        if "qsm" in extra:
            q = json.load(open(extra["qsm"]))
            for t in q.get("trees", []):
                tq = t.get("treeqsm") or {}
                qsm[t["treeId"]] = tq.get("dbhCyl", np.nan) if tq else np.nan
                qsl[t["treeId"]] = t.get("dbh", np.nan)
        pairs = pair(field, cand, a.gate)
        # Arbor's trees, paired on their own, when given
        arb = {}
        if "arbor" in extra:
            import pandas as pd
            at = pd.read_csv(extra["arbor"])
            ac = [dict(x=float(r.X), y=float(r.Y), dbh=float(r.DBH), measured=pd.isna(r.Message)) for r in at.itertuples()]
            for i, j, d in pair(field, ac, a.gate):
                arb[i] = (ac[j]["dbh"], ac[j]["measured"])
            detection[name + " arbor"] = f"{len(arb)}/{len(field)}"
        hit = set()
        for i, j, d in pairs:
            f, c = field.iloc[i], cand[j]
            hit.add(i)
            v = lambda x: np.nan if x is None else float(x)
            rows.append(dict(tile=name, ba_nr=int(f["ba_nr"]), species=f["baumart"], group=f["group"], field=float(f["dbh"]),
                             field_source=f["dbh_source"], edge=float(f["edge"]), dist=round(float(d), 3), tree=c["tree"], seed=c["seed"],
                             seed_source=c["source"], seed_dbh=c["seed_dbh"], metrics=v(met.get(c["tree"])), qsm=v(qsm.get(c["tree"])),
                             qsmSlice=v(qsl.get(c["tree"])),
                             arbor=arb[i][0] if i in arb else np.nan,
                             arbor_measured=arb[i][0] if i in arb and arb[i][1] else np.nan))
        dclass = lambda d: "<10" if d < 0.10 else ("10-20" if d < 0.20 else ("20-40" if d < 0.40 else ">=40"))
        det = {}
        for i in range(len(field)):
            k = dclass(field["dbh"].iloc[i]); det.setdefault(k, [0, 0]); det[k][1] += 1
            if i in hit: det[k][0] += 1
        detection[name] = {k: f"{v[0]}/{v[1]}" for k, v in sorted(det.items())}
    import pandas as pd
    df = pd.DataFrame(rows)
    pooled = df.sort_values("edge", ascending=False).drop_duplicates("ba_nr")
    sources = [s for s in ["seed_dbh", "metrics", "qsm", "qsmSlice", "arbor", "arbor_measured"] if s in df and df[s].notna().any()]
    report = dict(detection=detection, tiles={}, pooled={}, species={})
    for name, g in df.groupby("tile"):
        report["tiles"][name] = {s: stats(g[s].to_numpy(float), g["field"].to_numpy(float)) for s in sources}
    report["pooled"] = {s: stats(pooled[s].to_numpy(float), pooled["field"].to_numpy(float)) for s in sources}
    for grp, g in pooled.groupby("group"):
        report["species"][grp] = {s: stats(g[s].to_numpy(float), g["field"].to_numpy(float)) for s in sources}
    print(json.dumps(report, indent=1, ensure_ascii=False))
    if a.out:
        df.to_csv(a.out + "_pairs.csv", index=False)
        json.dump(report, open(a.out + ".json", "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
