# Point-level agreement of PointCloudLabeler's forest pass and Arbor on plot 1041, in
# 10 cm voxels of the 30 m core: wood / leaf, and which tree.
suppressMessages({ library(lidR); library(data.table) })
# Run as: Rscript compare_points.R <ours.laz> <arbor_segmented.laz> <outdir> [centre_x centre_y radius]
# (ours.laz: PointCloudLabeler's export with tree_id and semantic)
args <- commandArgs(trailingOnly = TRUE)
ours <- args[1]; arb <- args[2]; dir <- args[3]
CX <- if (length(args) >= 4) as.numeric(args[4]) else 399670
CY <- if (length(args) >= 5) as.numeric(args[5]) else 6786365
R <- if (length(args) >= 6) as.numeric(args[6]) else 30
V <- 0.1
a <- readLAS(arb)
cat("Arbor attributes:", paste(names(a@data), collapse = " "), "\n")
o <- readLAS(ours, select = "xyzc0", filter = sprintf("-keep_circle %f %f %f", CX, CY, R))
cat("ours attributes:", paste(names(o@data), collapse = " "), "\n")
ad <- a@data[(X - CX)^2 + (Y - CY)^2 <= R^2]
od <- o@data
key <- function(d) paste(floor(d$X / V), floor(d$Y / V), floor(d$Z / V))
ad[, k := key(ad)]
od[, k := key(od)]
tree_col <- intersect(c("treeID", "treeid", "TreeID"), names(ad))[1]
ad[, at := get(tree_col)]
ad[is.na(at), at := 0L]
if ("UserData" %in% names(ad)) ad[UserData != 0, at := 0L]
ad[, awood := foliage == 0]
od[, ot := tree_id]
od[, osem := semantic_class]
# per voxel: the most common tree on each side, and the wood share
mode_int <- function(x) { x <- x[x > 0]; if (!length(x)) 0L else as.integer(names(which.max(table(x)))) }
av <- ad[Classification != 2 | is.na(Classification), .(at = mode_int(at), aw = mean(awood, na.rm = TRUE), an = .N), by = k]
ov <- od[Classification != 2, .(ot = mode_int(ot), ow = mean(osem %in% c(1, 2)), ol = mean(osem == 4), on = .N), by = k]
j <- merge(av, ov, by = "k")
cat(sprintf("voxels: Arbor %d, ours %d, both %d\n", nrow(av), nrow(ov), nrow(j)))
# wood / leaf where both labelled
wl <- j[!is.na(aw) & (ow + ol) > 0]
wl[, A := aw >= 0.5][, O := ow >= ol]
tab <- table(Arbor = ifelse(wl$A, "wood", "leaf"), PointCloudLabeler = ifelse(wl$O, "wood", "leaf"))
print(tab)
agree <- sum(diag(tab)) / sum(tab)
pe <- sum(rowSums(tab) * colSums(tab)) / sum(tab)^2
cat(sprintf("wood/leaf agreement %.1f %%, Cohen's kappa %.3f; wood share Arbor %.1f %%, ours %.1f %%\n",
            100 * agree, (agree - pe) / (1 - pe), 100 * mean(wl$A), 100 * mean(wl$O)))
# trees where both assign one
t2 <- j[at > 0 & ot > 0]
cat(sprintf("voxels with a tree on both sides: %d (of %d shared voxels)\n", nrow(t2), nrow(j)))
ct <- t2[, .N, by = .(at, ot)]
sa <- t2[, .(na = .N), by = at]; so <- t2[, .(no = .N), by = ot]
ct <- merge(merge(ct, sa, by = "at"), so, by = "ot")
setorder(ct, -N)
# one-to-one, greedily by overlap
usedA <- c(); usedO <- c(); keep <- logical(nrow(ct))
for (i in seq_len(nrow(ct))) {
  if (!(ct$at[i] %in% usedA) && !(ct$ot[i] %in% usedO)) { keep[i] <- TRUE; usedA <- c(usedA, ct$at[i]); usedO <- c(usedO, ct$ot[i]) }
}
m <- ct[keep]
m[, iou := N / (na + no - N)]
cat(sprintf("voxels in one-to-one matched trees: %.1f %%\n", 100 * sum(m$N) / nrow(t2)))
big <- m[na >= 500]
cat(sprintf("Arbor trees with ≥ 500 voxels: %d; IoU with their PointCloudLabeler tree: mean %.3f, median %.3f; ≥ 0.8: %d, ≥ 0.5: %d\n",
            nrow(big), mean(big$iou), median(big$iou), sum(big$iou >= 0.8), sum(big$iou >= 0.5)))
fwrite(m, file.path(dir, "voxel_pairs.csv"))
