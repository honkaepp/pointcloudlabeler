"""Train the forest pass's near-tie owner model (src-tauri/src/commands/forest/tie_model.json) on
hand-segmented MLS plots.

    python -I train_tie_model.py OUT.json CACHE_DIR OCTREE=REFERENCE_LAS [OCTREE=REFERENCE_LAS ...]

Each octree must hold a forest run made with the owner model off (FOREST_TUNE {"instance.tie_move": 0}):
forest/near_ties.json lists every near-tie branch with its features, forest/near_ties.bin its voxels.

A branch's truth comes from the reference: it is the other tree's when more of its points (those still
its tree's, at least 20) are the other tree's reference tree than its own tree's — a PointCloudLabeler tree's
reference tree being the most common reference id of its points.

The model is scikit-learn's HistGradientBoosting (300 trees of 15 leaves), each branch weighted by the
square root of its points. It is written as `ties::TieModel` reads it, each node an array [leaf, value,
feature, threshold, left, right, missing_left], and checked against scikit-learn.
"""
import json
import os
import sys

import numpy as np

sys.dont_write_bytecode = True  # no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tpdata  # noqa: E402

FEATURES = ["ratio", "dA_R", "dB_R", "d_ratio", "h_rel_A", "h_rel_B", "hA", "hB", "dbhA", "dbhB", "cos_axis_radA",
            "cos_axis_radB", "start_to_A", "tie_to_B", "start_to_B", "tie_to_A", "dens_A", "dens_B", "dens_ratio",
            "zmin", "zmax", "logn"]


def branches(octree, las, cache):
    """(id, features, the other tree's points, the tree's own, points) of every branch."""
    nt = json.load(open(os.path.join(octree, "forest", "near_ties.json")))
    if any(b.get("auto") for b in nt["branches"]):
        raise SystemExit(f"{octree}: the owner model moved branches in this run; run with tie_move 0")
    meta = json.load(open(os.path.join(octree, "metadata.json")))
    off = np.array(meta["offset"], float); v = nt["voxel"]
    keys = np.fromfile(os.path.join(octree, "forest", "near_ties.bin"), np.int32).reshape(-1, 3).astype(np.int64)
    ids = np.repeat([b["id"] for b in nt["branches"]], [b["count"] for b in nt["branches"]])
    enc = lambda a: ((a[:, 0] + 2**20) << 42) | ((a[:, 1] + 2**20) << 21) | (a[:, 2] + 2**20)
    kk = enc(keys); o = np.argsort(kk); kk, ids = kk[o], ids[o]
    j = tpdata.joined(octree, las, cache)
    xyz = np.c_[j["x"], j["y"], j["z"]]
    pk = enc(np.floor((xyz - off) / v).astype(np.int64))
    i = np.minimum(np.searchsorted(kk, pk), len(kk) - 1)
    of = np.where(kk[i] == pk, ids[i], 0)
    gt = j["gt"].astype(np.int64); pred = j["pred"].astype(np.int64)
    # each tree's reference tree
    m = (pred > 0) & (gt > 0)
    G = int(gt.max()) + 1
    u, c = np.unique(pred[m] * G + gt[m], return_counts=True)
    own = {}
    for uu, cc in zip(u.tolist(), c.tolist()):
        p, g = divmod(uu, G)
        if p not in own or cc > own[p][1]: own[p] = (g, cc)
    sel = np.flatnonzero(of > 0); sel = sel[np.argsort(of[sel], kind="stable")]
    bu, st = np.unique(of[sel], return_index=True); en = np.r_[st[1:], len(sel)]
    by = {b["id"]: b for b in nt["branches"]}
    rows = []
    for b, a, e in zip(bu.tolist(), st, en):
        br = by[b]
        if not br.get("features"): continue
        idx = sel[a:e]; idx = idx[pred[idx] == br["tree"]]
        if len(idx) < 20: continue
        fix = int(np.sum(gt[idx] == own.get(br["other"], (-1, 0))[0]))
        brk = int(np.sum(gt[idx] == own.get(br["tree"], (-1, 0))[0]))
        rows.append((b, br["features"], fix, brk, len(idx)))
    return rows


def main():
    from sklearn.ensemble import HistGradientBoostingClassifier
    out, cache = sys.argv[1], sys.argv[2]
    rows = []
    for arg in sys.argv[3:]:
        octree, las = arg.split("=", 1)
        r = branches(octree, las, cache)
        print(f"{octree}: {len(r)} branches, the other tree's {sum(x[2] > x[3] for x in r)}", flush=True)
        rows += r
    X = np.array([r[1] for r in rows], float)
    y = np.array([r[2] > r[3] for r in rows], int)
    w = np.sqrt([r[4] for r in rows])
    # early stopping off: scikit-learn turns it on by itself past 10 000 branches and holds a random
    # tenth out, so the model's size would depend on how many branches the plots give
    clf = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=20,
                                         l2_regularization=1.0, early_stopping=False, random_state=0)
    clf.fit(X, y, sample_weight=w)
    num = lambda x, exact: "0" if x == 0 else (repr(float(x)) if exact else format(x, ".12g"))
    trees = []
    for it in clf._predictors:
        nodes = []
        for n in it[0].nodes:
            if n["is_leaf"]:
                nodes.append(f'[true,{num(n["value"], False)},0,0,0,0,false]')
            else:
                nodes.append(f'[false,0,{int(n["feature_idx"])},{num(n["num_threshold"], True)},{int(n["left"])},'
                             f'{int(n["right"])},{"true" if n["missing_go_to_left"] else "false"}]')
        trees.append("[" + ",".join(nodes) + "]")
    text = ('{"features":' + json.dumps(FEATURES) + ',"baseline":' + repr(float(np.ravel(clf._baseline_prediction)[0]))
            + ',"trees":[\n' + ",\n".join(trees) + "\n]}\n")
    open(out, "w", newline="\n").write(text)  # the repository's line ends, on Windows too
    # the written model gives scikit-learn's p
    m = json.loads(text)

    def p(x):
        s = m["baseline"]
        for t in m["trees"]:
            k = 0
            while not t[k][0]:
                n = t[k]; v = x[n[2]]
                k = (n[4] if n[6] else n[5]) if np.isnan(v) else (n[4] if v <= n[3] else n[5])
            s += t[k][1]
        return 1 / (1 + np.exp(-s))
    mine = np.array([p(x) for x in X[:1000]]); theirs = clf.predict_proba(X[:1000])[:, 1]
    print(f"{out}: {len(trees)} trees from {len(rows)} branches; max |p - scikit-learn| {np.abs(mine - theirs).max():.1e}")


if __name__ == "__main__":
    main()
