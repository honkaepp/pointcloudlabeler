"""Reading PointCloudLabeler datasets and the reference LAS files with numpy.

* `read_octree(dir)` reads a dataset's octree.bin as it is on disk (the
  forest pass, ground classification and the import write there; edits made
  in the editor live in patches.bin and are not applied — run these scripts
  on datasets the CLI produced).
* `joined(dir, las)` pairs every point of the dataset with the same point
  of the reference LAS by its coordinates on the shared 1 mm grid and
  returns the reference tree id next to PointCloudLabeler's tree id and semantic
  code. The pairing is cached beside the LAS run in `cache/`.
"""
import json
import os

import numpy as np

REC = np.dtype([("x", "<i4"), ("y", "<i4"), ("z", "<i4"), ("tree", "<i4"),
                ("intensity", "<u2"), ("cls", "u1"), ("ret", "u1"), ("sem", "u1")])


def read_octree(d):
    meta = json.load(open(os.path.join(d, "metadata.json")))
    pb = meta["pointBytes"]
    scale = np.array(meta["scale"]); off = np.array(meta["offset"])
    hier = np.fromfile(os.path.join(d, "hierarchy.bin"), dtype=np.uint8).reshape(-1, 24)
    offs = hier[:, 8:16].copy().view("<u8").ravel()
    sizes = hier[:, 16:24].copy().view("<u8").ravel()
    raw = np.fromfile(os.path.join(d, "octree.bin"), dtype=np.uint8)
    keep = sizes > 0
    parts = [raw[o:o + s] for o, s in zip(offs[keep], sizes[keep])]
    buf = np.concatenate(parts).reshape(-1, pb)
    base = np.ascontiguousarray(buf[:, :21]).view(REC).ravel()
    return base, scale, off, meta


def grid_key(ix, iy, iz):
    """One int64 per point from integer coordinates on a 1 mm grid that start
    near zero (each fits 21 bits)."""
    return (ix.astype(np.int64) << 42) | (iy.astype(np.int64) << 21) | iz.astype(np.int64)


def las_reference(las_path, cache_dir):
    """The reference LAS sorted by grid key: key, tree_id, xyz (float64)."""
    os.makedirs(cache_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(las_path))[0]
    f = os.path.join(cache_dir, stem + "_ref.npz")
    if os.path.exists(f):
        z = np.load(f)
        return {k: z[k] for k in z.files}
    import laspy
    las = laspy.read(las_path)
    h = las.header
    org = np.floor(np.array([h.mins[0], h.mins[1], h.mins[2]]) * 1000.0 - 1)
    ix = np.round(np.asarray(las.x) * 1000.0 - org[0]).astype(np.int64)
    iy = np.round(np.asarray(las.y) * 1000.0 - org[1]).astype(np.int64)
    iz = np.round(np.asarray(las.z) * 1000.0 - org[2]).astype(np.int64)
    key = grid_key(ix, iy, iz)
    o = np.argsort(key, kind="stable")
    out = dict(key=key[o], gt=np.asarray(las["tree_id"]).astype(np.int32)[o],
               x=np.asarray(las.x)[o], y=np.asarray(las.y)[o], z=np.asarray(las.z)[o], org=org)
    np.savez(f, **out)
    return out


def joined(octree_dir, las_path, cache_dir):
    """Every point: reference tree id `gt`, PointCloudLabeler's `pred` tree id, `sem`,
    `cls`, world x/y/z — in the reference's key order."""
    ref = las_reference(las_path, cache_dir)
    rec, scale, off, _ = read_octree(octree_dir)
    # the dataset's point order never changes (passes write in place), so
    # the pairing is kept by the dataset's path and its hierarchy
    st = os.stat(os.path.join(octree_dir, "hierarchy.bin"))
    tag = f"{os.path.abspath(octree_dir)}|{st.st_size}|{st.st_mtime_ns}|{len(rec)}"
    import hashlib
    pf = os.path.join(cache_dir, "perm_" + hashlib.sha1(tag.encode()).hexdigest()[:16] + ".npy")
    if os.path.exists(pf):
        o = np.load(pf)
        return dict(gt=ref["gt"], pred=rec["tree"][o], sem=rec["sem"][o], cls=rec["cls"][o],
                    x=ref["x"], y=ref["y"], z=ref["z"])
    org = ref["org"]
    ix = np.round(rec["x"] * (scale[0] * 1000.0) + (off[0] * 1000.0 - org[0])).astype(np.int64)
    iy = np.round(rec["y"] * (scale[1] * 1000.0) + (off[1] * 1000.0 - org[1])).astype(np.int64)
    iz = np.round(rec["z"] * (scale[2] * 1000.0) + (off[2] * 1000.0 - org[2])).astype(np.int64)
    key = grid_key(ix, iy, iz)
    o = np.argsort(key, kind="stable")
    key = key[o]
    if len(key) != len(ref["key"]) or not np.array_equal(key, ref["key"]):
        raise SystemExit(f"{octree_dir}: points do not pair with {las_path} ({len(key)} vs {len(ref['key'])})")
    np.save(pf, o)
    return dict(gt=ref["gt"], pred=rec["tree"][o], sem=rec["sem"][o], cls=rec["cls"][o],
                x=ref["x"], y=ref["y"], z=ref["z"])
