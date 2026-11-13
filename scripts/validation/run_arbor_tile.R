# Arbor (r-lidar) on one MLS tile, for the validation against the reference trees.
# Run as: Rscript run_arbor_tile.R <tile.las> <outdir> [homogenization_res]
# Arbor's MLS chain as its book gives it: homogenization (2 cm), ground,
# wood likelihood, wood / leaf, seeds, instances (with its own
# over-segmentation merge), flags and QSMs. No trajectory comes with the
# tiles, so range filtering is not used. Every stage is timed.
suppressMessages({ library(lidR); library(arbor) })
args <- commandArgs(trailingOnly = TRUE)
f <- args[1]; out <- args[2]
res <- if (length(args) >= 3) as.numeric(args[3]) else 0.02
dir.create(out, showWarnings = FALSE, recursive = TRUE)
t_all <- Sys.time(); t0 <- t_all
times <- list()
lap <- function(name) {
  t <- Sys.time(); s <- as.numeric(difftime(t, t0, units = "secs"))
  times[[name]] <<- s; cat(sprintf("%-16s %8.1f s\n", name, s)); flush.console(); t0 <<- t
}
las <- readLAS(f, select = "xyz")
cat("points read:", npoints(las), "\n")
lap("read")
las <- hybrid_homogeneization(las, res); cat("after homogenization:", npoints(las), "\n"); lap("homogenization")
las <- segment_ground(las); lap("ground")
las <- wood_likelihood(las); lap("wood_likelihood")
las <- segment_semantic(las); lap("semantic")
see <- find_seeds(las); lap("seeds")
las <- segment_instance(las, see); lap("instance")
las <- flag_buffer(las, see, -5); lap("buffer")
las <- flag_small_trees(las, 2); lap("small_trees")
q <- qsf(las); lap("qsf")
total <- as.numeric(difftime(Sys.time(), t_all, units = "secs"))
cat("total:", round(total, 1), "s\n")
writeLAS(las, file.path(out, "arbor_segmented.laz"))
qsf_write(q, file.path(out, "qsm"), format = "qsm")
tm <- qsf_treemap(q)
xy <- sf::st_coordinates(tm)
df <- sf::st_drop_geometry(tm)
df$X <- xy[, 1]; df$Y <- xy[, 2]
write.csv(df, file.path(out, "arbor_trees.csv"), row.names = FALSE)
write.csv(data.frame(stage = c(names(times), "total"), seconds = c(unlist(times), total)),
          file.path(out, "arbor_times.csv"), row.names = FALSE)
cat("trees in the QSF:", nrow(df), "\n")
