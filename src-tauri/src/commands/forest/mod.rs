//! The structure of a forest from its point cloud, automatically:
//! which points are wood and which are leaves, where the stems stand, and
//! which tree every point belongs to.
//!
//! The pipeline, on a working set of voxel centroids (`WorkSet`):
//!
//! 1. **Local shape** (`wood`): eigenvalues of each point's neighbourhood at
//!    two scales; wood is structured (linear or planar) at both, foliage is
//!    scattered. Optionally blended with the scanner's reflectance, where
//!    bark returns more than leaves.
//! 2. **The flow skeleton** (`graph`, `wood`): one shortest-path tree from
//!    the ground over a k-nearest-neighbour graph whose steps cost more the
//!    longer they are and the further they turn from upward. What a node
//!    *carries* — the volume of everything whose path to the ground passes
//!    through it — is large along stems and branches and small in foliage.
//!    It is the subtree sum of the path tree, one pass in reverse settling
//!    order, not a walk down every path.
//! 3. **Wood / leaf** (`wood`): hysteresis — strong evidence (a large carried
//!    volume or a very structured shape) seeds wood, weaker shape evidence
//!    joins it where connected; small isolated pieces fall back to leaf.
//! 4. **Stems** (`stems`): circles fitted in thin slices above the ground,
//!    judged by how much of the circle the points cover and how many fit
//!    it, chained up the stem into seeds with an axis, a lean and a radius.
//!    Stems without a circle (saplings, occluded stems) seed from the
//!    flow skeleton near the ground — where what they carry says a stem
//!    stands (more for a scan that went round every stem, MLS). Stems
//!    whose wood joins a bigger stem's low down (a fork, a sprout, a low
//!    limb read as a stem) grow one tree with it (`instance::attach_forks`).
//! 5. **Trees** (`instance`): every seed claims its own stem points; wood is
//!    then grown out from the stems over wood only, and foliage takes the
//!    tree of the wood it is nearest to through the foliage, counting a
//!    share of how far that wood is from its stem. The wood of each tree
//!    splits into its stem (the main axis, followed up by what it carries)
//!    and its branches.
//! 6. **Merges and flags** (`merge`, `flags`): one stem split into two trees
//!    shows up as stem circles whose points carry both ids — merged when
//!    several heights agree, suggested to the user when only one or two do;
//!    low growth whose flow reaches the ground away from its tree's stems
//!    (a shrub round the foot of the tree, `instance::drop_rooted_elsewhere`)
//!    is let go; trees standing at the edge of the data, understory and
//!    stems without a fit are flagged, never deleted.
//! 7. **Breast height** (`octree::forest`): every stem is measured again at
//!    1.2–1.4 m from the full points (`stems::refine_at_breast_height`) —
//!    the working set's voxels are as wide as a small stem.
//!
//! The settings were tuned against hand-segmented MLS plots and checked on
//! a single-position TLS plot (scripts/validation); `pipeline::apply_tune` takes trial settings
//! from the file `FOREST_TUNE` names, for re-running that tuning.
//!
//! Seeds can come from the user (`instance::label_trees` takes any seeds),
//! so the trees can be re-cut after the stems are corrected by hand without
//! redoing steps 1–3.
//!
//! Everything here is pure computation on in-memory points (testable on
//! synthetic stands); `octree::forest` reads and writes the dataset.

pub mod eigen;
pub mod flags;
pub mod graph;
pub mod instance;
pub mod merge;
pub mod pipeline;
pub mod stems;
pub mod ties;
pub mod wood;

/// The working set: one point per occupied voxel.
#[derive(Clone, Default)]
pub struct WorkSet {
    /// Voxel centroids, metres, x east, y north, z up, relative to the
    /// dataset offset.
    pub p: Vec<[f32; 3]>,
    /// Height above the ground under each.
    pub hag: Vec<f32>,
    /// Points that fell into each voxel.
    pub n: Vec<u32>,
    /// Mean reflectance (or intensity) of the voxel, when the dataset has it.
    pub refl: Option<Vec<f32>>,
    /// The voxel edge, metres.
    pub voxel: f32,
}

impl WorkSet {
    pub fn len(&self) -> usize { self.p.len() }
    pub fn is_empty(&self) -> bool { self.p.is_empty() }
}

/// The semantic codes the editor reads (3 is the patches' "cleared").
pub const STEM: u8 = 1;
pub const BRANCH: u8 = 2;
pub const LEAF: u8 = 4;

/// A deterministic generator for the tests — no rand dependency.
#[cfg(test)]
pub(crate) fn lcg(seed: &mut u64) -> f32 {
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    ((*seed >> 33) as f32) / (1u64 << 31) as f32
}
