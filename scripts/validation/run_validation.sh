#!/usr/bin/env bash
# The whole validation against the MLS reference plots, end to end (Git Bash
# on Windows or any POSIX shell). Results are written into $WORK; nothing
# goes into the repository.
#
#   DATA=C:/path/to/validation_data \
#   WORK=C:/path/to/scratch \
#   EXE=src-tauri/target/release/pointcloudlabeler.exe \
#   bash scripts/validation/run_validation.sh [arbor]
#
# 1. imports the three tiles (FP05, FP07, FP08) as MLS datasets and
#    classifies the ground,
# 2. runs the forest pass, metrics.trees and TreeQSM on each,
# 3. evaluates the trees (eval_forest.py), DBH against the field inventory
#    (eval_dbh.py) and the QSM volumes (eval_qsm.py),
# 4. with `arbor`: runs Arbor on each tile (run_arbor_tile.R) and evaluates
#    it on the same points (eval_arbor.py) and DBH.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${DATA:?set DATA to the folder of the reference LAS files and the inventory}"
WORK="${WORK:?set WORK to a scratch folder}"
EXE="${EXE:-$HERE/../../src-tauri/target/release/pointcloudlabeler.exe}"
RSCRIPT="${RSCRIPT:-C:/Program Files/R/R-4.5.0/bin/Rscript.exe}"
TILES="${TILES:-FP05 FP07 FP08}"
las() { echo "$DATA/2023-03-29_$1_MLS_GT_LV95_kohdistettu.las"; }
mkdir -p "$WORK"
cd "$WORK"
[ -f proj/project.json ] || "$EXE" project create --folder "$WORK/proj" --name validation --epsg 2056 > /dev/null
for t in $TILES; do
  d="proj/octrees/$t"
  if [ ! -d "$d" ]; then
    "$EXE" dataset import --src-path "$(las $t)" --project-folder "$WORK/proj" --name "$t" --scanner-type mls > "import_$t.json"
    "$EXE" ground classify --octree-dir "$d" > "ground_$t.json"
  fi
  s=$(date +%s)
  "$EXE" segment forest --octree-dir "$d" > "forest_$t.json"
  echo "$t forest pass $(( $(date +%s) - s )) s"
  "$EXE" metrics trees --octree-dir "$d" > "metrics_$t.json"
  s=$(date +%s)
  "$EXE" metrics qsm --octree-dir "$d" --branch-method treeqsm --enable-branches true > "qsm_$t.json"
  echo "$t TreeQSM $(( $(date +%s) - s )) s"
  python -I "$HERE/eval_forest.py" "$d" "$(las $t)" --cache cache --out "trees_$t" > /dev/null
  if [ "${1:-}" = arbor ]; then
    "$RSCRIPT" "$HERE/run_arbor_tile.R" "$(las $t)" "arbor/$t" > "arbor_$t.log" 2>&1
    python -I "$HERE/eval_arbor.py" "arbor/$t/arbor_segmented.laz" "$(las $t)" --cache cache --out "arbor_trees_$t" > /dev/null
  fi
done
args=()
for t in $TILES; do
  a=("$t" "proj/octrees/$t" "$(las $t)" "metrics=metrics_$t.json" "qsm=proj/octrees/$t/qsm.json")
  [ "${1:-}" = arbor ] && a+=("arbor=arbor/$t/arbor_trees.csv")
  args+=(--tile "${a[@]}")
done
python -I "$HERE/eval_dbh.py" --gpkg "$DATA/ramerenwald_inv2_2023.gpkg" "${args[@]}" --out dbh > /dev/null
qargs=()
for t in $TILES; do qargs+=(--tile "$t" "proj/octrees/$t" "$(las $t)"); done
python -I "$HERE/eval_qsm.py" --pairs dbh_pairs.csv "${qargs[@]}" --cache cache --out qsm > /dev/null
python -I - <<'EOF'
import json, glob
for f in sorted(glob.glob("trees_*.json")) + sorted(glob.glob("arbor_trees_*.json")):
    s = json.load(open(f))["summary"]
    print(f"{f[:-5]:18s} F1 {s['f1']:.3f} (P {s['precision']:.3f} R {s['recall']:.3f}), big trees F1 {s['big']['f1']:.3f}, "
          f"IoU median {s['iou_pct_10_25_50_75_90'][2]:.3f}, point accuracy {s['point_accuracy']:.3f}")
d = json.load(open("dbh.json"))
for k, v in d["pooled"].items():
    print(f"DBH {k:15s} n {v['n']} bias {v.get('bias_cm')} cm RMSE {v.get('rmse_cm')} cm r2 {v.get('r2')}")
print("QSM", json.load(open("qsm.json"))["all"])
EOF
