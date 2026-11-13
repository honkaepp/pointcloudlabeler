"""PointCloudLabeler's trees against the hand-checked reference through TreeQSM: which
QSM branches of a PointCloudLabeler tree belong to another reference tree, and where
the reference's own QSM of that tree attaches them.

    # 1. the forest pass's working set and labels
    FOREST_DUMP=DUMP pointcloudlabeler segment forest --octree-dir OCTREE
    # 2. the reference's tree for every working-set node (DUMP/ref.i32)
    python -I eval_qsm_branches.py nodes DUMP OCTREE REFERENCE_LAS [--cache DIR]
    # 3. TreeQSM on every tree, both labellings (src-tauri/examples/qsm_research.rs)
    qsm_research DUMP DUMP/label.u32 u32 OUT_tp
    qsm_research DUMP DUMP/ref.i32 i32 OUT_ref
    # 4. compare
    python -I eval_qsm_branches.py compare --tile NAME DUMP OUT_tp OUT_ref \
        [labels=PATH] [ref=PATH] [--tile ...] [--fieldtrees PREFIX_trees.csv] [--out FILE.json]

* Points: every working-set node weighs the points it stands for.
* A PointCloudLabeler tree's owner is the reference tree with most of its points.
* A QSM branch is a segment and everything growing out of it. A wrong branch
  is one whose points are mostly one other reference tree's, hanging on a
  segment that is not part of a wrong branch itself.
* The reference's QSM of that other tree says where the branch really
  attaches: of the reference segments holding its points, the one with most
  of them among those whose parent segment holds none. Reported: how far
  that junction is from where PointCloudLabeler hung the branch, where it lies along
  the branch (0 at PointCloudLabeler's junction, 1 at the branch's far end), and
  whose PointCloudLabeler tree holds the segment it attaches to.
* `--fieldtrees` (eval_fieldtrees.py's `_trees.csv`) counts only PointCloudLabeler
  trees owned by a field tree's reference tree.
"""
import argparse
import json
import os
import sys

import numpy as np
import pandas as pd

sys.dont_write_bytecode = True  # no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tpdata  # noqa: E402


def node_ref(dump, octree, las, cache):
    """The most common reference tree id among the points of every working-set
    node (ground points left out), written to DUMP/ref.i32."""
    meta = json.load(open(os.path.join(dump, "meta.json")))
    n, v = meta["n"], meta["voxel"]
    off = np.array(meta["offset"])
    p = np.fromfile(os.path.join(dump, "p.f32"), np.float32).reshape(n, 3)
    j = tpdata.joined(octree, las, cache)
    keep = j["cls"] != 2
    k = [np.floor((j[a][keep] - off[i]) / v).astype(np.int64) for i, a in enumerate("xyz")]
    nk = np.floor(p.astype(np.float64) / v).astype(np.int64)
    lo = np.minimum(np.array([x.min() for x in k]), nk.min(axis=0)) - 1
    enc = lambda a, b, c: ((a - lo[0]) << 42) | ((b - lo[1]) << 21) | (c - lo[2])
    pk = enc(*k)
    g = j["gt"][keep].astype(np.int64)
    o = np.lexsort((g, pk)); pk, g = pk[o], g[o]
    brk = np.r_[True, (pk[1:] != pk[:-1]) | (g[1:] != g[:-1])]
    st = np.flatnonzero(brk); c = np.diff(np.r_[st, len(pk)])
    vk, vg = pk[st], g[st]
    o = np.lexsort((-c, vk)); vk, vg = vk[o], vg[o]
    first = np.r_[True, vk[1:] != vk[:-1]]
    vk, vg = vk[first], vg[first]
    q = enc(nk[:, 0], nk[:, 1], nk[:, 2])
    i = np.minimum(np.searchsorted(vk, q), len(vk) - 1)
    ref = np.where(vk[i] == q, vg[i], 0).astype(np.int32)
    ref.tofile(os.path.join(dump, "ref.i32"))
    print(f"{dump}: {n} nodes, {np.mean(ref > 0):.3f} on a reference tree")


def load_qsm(prefix):
    seg = np.fromfile(prefix + "_seg.u32", np.uint32).astype(np.int64)
    S = pd.DataFrame(json.load(open(prefix + "_segs.json")))
    S = S[S.ncyl > 0].set_index("id")
    par = S.parent.where(S.parent.notna(), 0).astype(np.int64)
    S["par"] = par.where(par.isin(S.index), 0)
    return seg, S


def down(S, mark):
    """`mark` spread from each marked segment to everything growing out of it."""
    up = S.index.get_indexer(S.par.values)  # the parent's row, -1 for none
    m = np.asarray(mark, bool).copy()
    for _ in range(500):
        nm = m | ((up >= 0) & m[np.maximum(up, 0)])
        if (nm == m).all():
            break
        m = nm
    return pd.Series(m, index=S.index)


def subtree_composition(S, comp):
    """Points per (segment, reference tree) of every segment's whole subtree."""
    depth = pd.Series(0, index=S.index)
    for _ in range(500):
        nd = S.par.map(depth).fillna(-1).astype(np.int64) + 1
        nd[S.par == 0] = 0
        if (nd == depth).all():
            break
        depth = nd
    cur = comp.copy()
    cur["depth"] = cur.seg.map(depth)
    for L in range(int(depth.max()), 0, -1):
        lvl = cur[cur.depth == L].copy()
        if lvl.empty:
            continue
        lvl["seg"] = lvl.seg.map(S.par)
        cur = pd.concat([cur, lvl]).groupby(["seg", "ref"], as_index=False).w.sum()
        cur["depth"] = cur.seg.map(depth)
    return cur


def compare(name, dump, tp_prefix, ref_prefix, labels, refpath, refs):
    meta = json.load(open(os.path.join(dump, "meta.json")))
    n = meta["n"]
    p = np.fromfile(os.path.join(dump, "p.f32"), np.float32).reshape(n, 3).astype(np.float64)
    w = np.fromfile(os.path.join(dump, "n.u32"), np.uint32).astype(np.float64)
    ref = np.fromfile(refpath, np.int32).astype(np.int64)
    tp = np.fromfile(labels, np.uint32).astype(np.int64)
    seg, S = load_qsm(tp_prefix)
    rseg, G = load_qsm(ref_prefix)

    df = pd.DataFrame({"tree": tp, "ref": ref, "w": w, "seg": seg})
    tw = df[df.tree > 0].groupby(["tree", "ref"]).w.sum().reset_index()
    own = tw[tw["ref"] > 0].sort_values("w", ascending=False).drop_duplicates("tree").set_index("tree")["ref"]
    S["owner"] = S.tree.map(own).fillna(0).astype(np.int64)
    counted = S.owner.isin(refs) if refs is not None else S.owner > 0

    comp = df[df.seg > 0].groupby(["seg", "ref"]).w.sum().reset_index()
    sub = subtree_composition(S, comp).merge(S[["owner"]], left_on="seg", right_index=True)
    S["sub_w"] = sub.groupby("seg").w.sum().reindex(S.index).fillna(0)
    fo = sub[(sub["ref"] != sub.owner) & (sub["ref"] != 0)].sort_values("w", ascending=False).drop_duplicates("seg").set_index("seg")
    S["foreign_ref"] = fo["ref"].reindex(S.index).fillna(0).astype(np.int64)
    S["foreign_w"] = fo.w.reindex(S.index).fillna(0)
    S["foreign"] = S.foreign_w > 0.5 * S.sub_w
    S["wrong_root"] = S.foreign & (S.par > 0) & (S.par.map(S.foreign) != True)  # noqa: E712
    S["in_wrong"] = down(S, S.wrong_root.values)

    # the foreign points of the counted trees: in wrong branches, elsewhere in segments, in no segment
    sc = comp.merge(S[["owner", "in_wrong"]], left_on="seg", right_index=True)
    sc = sc[sc.owner.isin(refs)] if refs is not None else sc[sc.owner > 0]
    foreign = (sc["ref"] != sc.owner) & (sc["ref"] != 0)
    tree_pts = df[df.tree > 0].merge(own.rename("owner"), left_on="tree", right_index=True)
    tree_pts = tree_pts[tree_pts.owner.isin(refs)] if refs is not None else tree_pts
    total = tree_pts.w.sum()
    out = dict(segments=int(counted.sum()), tree_points=float(total),
               foreign_in_segments=float(sc[foreign].w.sum() / total),
               foreign_outside_segments=float(tree_pts[(tree_pts.seg == 0) & (tree_pts["ref"] != tree_pts.owner) & (tree_pts["ref"] != 0)].w.sum() / total),
               foreign_in_wrong_branches=float(sc[foreign & sc.in_wrong].w.sum() / max(sc[foreign].w.sum(), 1)),
               own_in_wrong_branches=float(sc[(sc["ref"] == sc.owner) & sc.in_wrong].w.sum() / total),
               wrong_branches=int((S.wrong_root & counted).sum()))

    # each wrong branch through the reference's QSM of the tree it belongs to
    root = pd.Series(np.where(S.wrong_root & counted, S.index, 0), index=S.index)
    for _ in range(500):
        nr = root.where(root > 0, S.par.map(root).fillna(0).astype(np.int64))
        if (nr == root).all():
            break
        root = nr
    node_root = np.zeros(n, np.int64)
    m = seg > 0
    node_root[m] = root.reindex(seg[m]).fillna(0).astype(np.int64).values
    o = np.argsort(node_root, kind="stable")
    u, st = np.unique(node_root[o], return_index=True)
    en = np.r_[st[1:], n]
    rows = []
    for r_id, a, b in zip(u, st, en):
        if r_id == 0:
            continue
        idx = o[a:b]
        row = S.loc[r_id]
        B = int(row.foreign_ref)
        mine = idx[ref[idx] == B]
        if len(mine) < 5:
            continue
        gs, gc = np.unique(rseg[mine], return_counts=True)
        cnt = {s: c for s, c in zip(gs.tolist(), gc.tolist()) if s > 0}
        js = [s for s in cnt if s in G.index and G.par[s] > 0 and G.par[s] not in cnt]
        J_A = np.array(row.base)
        pts = p[mine]
        far = pts[np.argmax(np.linalg.norm(pts - J_A, axis=1))]
        ext = float(np.linalg.norm(far - J_A))
        r = dict(root=int(r_id), tree=int(row.tree), owner=int(row.owner), belongs_to=B, points=float(w[mine].sum()), extent=ext)
        if js:
            s = max(js, key=lambda x: cnt[x])
            J_B = np.array(G.loc[s].base)
            pn = np.flatnonzero(rseg == G.par[s])
            holder = int(np.bincount(tp[pn], weights=w[pn]).argmax()) if len(pn) else -1
            dA = float(np.linalg.norm(J_B - J_A))
            r.update(junction_to_pcl_junction=dA, junction_to_far_end=float(np.linalg.norm(J_B - far)),
                     along=dA / max(ext, 1e-6), holder=holder)
        rows.append(r)
    d = pd.DataFrame(rows)
    W = d.points.sum()
    j = d[d.get("holder", pd.Series(dtype=float)).notna()] if "holder" in d else d.iloc[:0]

    def wq(col, qs):
        x = j.sort_values(col)
        return np.round(np.interp(qs, np.cumsum(x.points) / x.points.sum(), x[col]), 2).tolist() if len(x) else []
    out.update(wrong_branch_points=float(W),
               with_reference_junction=float(j.points.sum() / max(W, 1)),
               junction_within_0_3_m=float(j[j.junction_to_pcl_junction < 0.3].points.sum() / max(W, 1)) if len(j) else 0.0,
               junction_nearer_far_end=float(j[j.junction_to_far_end < j.junction_to_pcl_junction].points.sum() / max(W, 1)) if len(j) else 0.0,
               attaches_in_same_pcl_tree=float(j[j.holder == j.tree].points.sum() / max(W, 1)) if len(j) else 0.0,
               attaches_in_other_pcl_tree=float(j[(j.holder != j.tree) & (j.holder > 0)].points.sum() / max(W, 1)) if len(j) else 0.0,
               along_q10_25_50_75_90=wq("along", [.1, .25, .5, .75, .9]),
               extent_q50_90=wq("extent", [.5, .9]))
    print(f"{name}: points of other reference trees in the trees' QSM segments {out['foreign_in_segments']:.3f} "
          f"(+{out['foreign_outside_segments']:.3f} outside any segment); in whole wrong branches {out['foreign_in_wrong_branches']:.2f} of them, "
          f"taking {out['own_in_wrong_branches']:.4f} own points along ({out['wrong_branches']} branches)")
    print(f"   reference junction within 0.3 m of PointCloudLabeler's {out['junction_within_0_3_m']:.2f}, nearer the far end {out['junction_nearer_far_end']:.2f}; "
          f"along the branch q10..q90 {out['along_q10_25_50_75_90']}; on a segment of another PointCloudLabeler tree {out['attaches_in_other_pcl_tree']:.2f}, "
          f"of the same {out['attaches_in_same_pcl_tree']:.2f}")
    return out, d


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "nodes":
        ap = argparse.ArgumentParser()
        ap.add_argument("cmd"); ap.add_argument("dump"); ap.add_argument("octree"); ap.add_argument("las")
        ap.add_argument("--cache", default="cache")
        a = ap.parse_args()
        node_ref(a.dump, a.octree, a.las, a.cache)
        return
    args = sys.argv[2:]
    tiles, fieldtrees, out = [], None, None
    i = 0
    while i < len(args):
        if args[i] == "--tile":
            name, dump, tpp, refp = args[i + 1:i + 5]
            opts = {"labels": os.path.join(dump, "label.u32"), "ref": os.path.join(dump, "ref.i32")}
            i += 5
            while i < len(args) and "=" in args[i] and not args[i].startswith("--"):
                k, v = args[i].split("=", 1); opts[k] = v; i += 1
            tiles.append((name, dump, tpp, refp, opts))
        elif args[i] == "--fieldtrees":
            fieldtrees = pd.read_csv(args[i + 1]); i += 2
        elif args[i] == "--out":
            out = args[i + 1]; i += 2
        else:
            sys.exit(__doc__)
    report = {}
    for name, dump, tpp, refp, opts in tiles:
        refs = None
        if fieldtrees is not None:
            f = fieldtrees[(fieldtrees.tile == name) & (fieldtrees["ref"] != 0)]
            refs = set(f["ref"].astype(int))
        r, rows = compare(name, dump, tpp, refp, opts["labels"], opts["ref"], refs)
        report[name] = r
        if out:
            rows.to_csv(f"{os.path.splitext(out)[0]}_{name}_branches.csv", index=False)
    if out:
        json.dump(report, open(out, "w"), indent=1)


if __name__ == "__main__":
    main()
