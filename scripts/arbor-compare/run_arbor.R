# Arbor (r-lidar) on plot 1041, for comparison with PointCloudLabeler's forest pass.
# Run as: Rscript run_arbor.R <laz> <outdir> [centre_x centre_y radius fraction]
# (the scanner's position and the radius of good data; fraction 0.5 is the
# Arbor book's advice for TLS)
suppressMessages({ library(lidR); library(arbor) })
args <- commandArgs(trailingOnly = TRUE)
f <- args[1]; out <- args[2]
cx <- if (length(args) >= 3) args[3] else "399670"; cy <- if (length(args) >= 4) args[4] else "6786365"
r <- if (length(args) >= 5) args[5] else "55"; frac <- if (length(args) >= 6) args[6] else "0.5"
dir.create(out, showWarnings = FALSE)
t_all <- Sys.time(); t0 <- t_all
times <- list()
lap <- function(name) {
  t <- Sys.time(); s <- as.numeric(difftime(t, t0, units = "secs"))
  times[[name]] <<- s; cat(sprintf("%-16s %8.1f s\n", name, s)); flush.console(); t0 <<- t
}
# the book's advice for TLS: up to half the points; the scanner at the centre,
# the low-quality far zone clipped
las <- readTLS(f, select = "xyz", filter = sprintf("-keep_circle %s %s %s -keep_random_fraction %s", cx, cy, r, frac))
cat("points read:", npoints(las), "\n")
lap("read")
las <- hybrid_homogeneization(las); cat("after homogenization:", npoints(las), "\n"); lap("homogenization")
las <- segment_ground(las); lap("ground")
las <- wood_likelihood(las); lap("wood_likelihood")
las <- segment_semantic(las); lap("semantic")
see <- find_seeds(las); lap("seeds")
las <- segment_instance(las, see); lap("instance")
las <- flag_buffer(las, see, -5); lap("buffer")
las <- flag_small_trees(las, 2); lap("small_trees")
q <- qsf(las); lap("qsf")
cat("total:", round(as.numeric(difftime(Sys.time(), t_all, units = "secs")), 1), "s\n")
# what came out
writeLAS(las, file.path(out, "arbor_segmented.laz"))
qsf_write(q, file.path(out, "qsm"), format = "qsm")
tm <- qsf_treemap(q)
xy <- sf::st_coordinates(tm)
df <- sf::st_drop_geometry(tm)
df$X <- xy[, 1]; df$Y <- xy[, 2]
write.csv(df, file.path(out, "arbor_trees.csv"), row.names = FALSE)
write.csv(data.frame(stage = names(times), seconds = unlist(times)), file.path(out, "arbor_times.csv"), row.names = FALSE)
cat("trees in the QSF:", nrow(df), "\n")
print(head(df))
