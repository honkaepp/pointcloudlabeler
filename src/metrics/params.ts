/** The one definition of how a tree's metrics are measured.
 *
 *  Every panel that shows a DBH, height, crown area or basal area asks
 *  the same Rust command (`octree_tree_metrics`) for it, and that command
 *  streams the cloud fresh each time — there is no cache. So the numbers
 *  a panel shows are decided entirely by the parameters it happens to
 *  pass, and two panels passing different ones will disagree about the
 *  same tree while both looking authoritative.
 *
 *  That is exactly what had happened: three call sites used a 1.0–1.6 m
 *  breast-height band and seven used 1.2–1.4 m, with nothing on screen
 *  disclosing either. The worst case was the Validation panel, which
 *  reports "PointCloudLabeler's DBH is biased 0.4 cm against the calipers, RMSE
 *  1.2 cm" — computed from a DBH the user had never seen, because the
 *  Metrics module they were reading had measured it over a different
 *  band. A validation figure that describes a different computation
 *  than the one being validated is worse than no validation figure.
 *
 *  The band is 1.2–1.4 m: DBH is defined at 1.3 m, and ±10 cm is the
 *  conventional sampling window. The wider 1.0–1.6 m band catches more
 *  points on a sparse stem, but it also reaches far enough down the
 *  taper to inflate the fitted diameter on a butt-swelled tree.
 *
 *  The Metrics module still lets a user retune this per run — that is
 *  its job. What it must not do is start from a different number than
 *  everything else. */
export interface MetricParams {
  /** Crown-footprint raster cell size (m). */
  crownCell: number;
  /** Bottom of the breast-height band the DBH circle is fitted over (m above ground). */
  bhLow: number;
  /** Top of that band (m above ground). */
  bhHigh: number;
  /** DTM cell size (m) used to get height above ground. */
  dtmCell: number;
}

export const DEFAULT_METRIC_PARAMS: MetricParams = {
  crownCell: 0.25,
  bhLow: 1.2,
  bhHigh: 1.4,
  dtmCell: 0.5,
};

/** One-line description of the band a set of metrics was measured over,
 *  for panels to show beside the numbers. A DBH is not a fact about a
 *  tree on its own — it is a fact about a tree AND the band it was
 *  measured across — so a panel that shows the number without the band
 *  is showing half of it. */
export function describeMetricParams(p: MetricParams): string {
  return `DBH fitted over ${p.bhLow.toFixed(2)}–${p.bhHigh.toFixed(2)} m · crown cell ${p.crownCell} m · DTM cell ${p.dtmCell} m`;
}
