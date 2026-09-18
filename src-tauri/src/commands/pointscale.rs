//! What scale an ASCII point cloud's intensity and colour columns are on.
//!
//! Neither PTX nor a generic XYZ dump states it. Writers use several
//! conventions and their domains OVERLAP — 0.5 is a valid intensity in
//! two of them, 1 is a valid colour channel in two more — so the scale
//! is a property of the FILE and cannot be recovered from a single
//! value.
//!
//! Both importers used to guess per value, branching on each one's own
//! magnitude. That is not merely imprecise, it is non-monotonic: a
//! darker return came out brighter. Deciding once from the observed
//! range and then applying one monotonic mapping is the whole point of
//! this module, and it is shared so the two importers cannot drift
//! apart on it.

/// Intensity conventions seen in ASCII point clouds.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum IntensityScale {
    /// [-1, 1] signed reflectance (Cyclone and friends).
    Signed,
    /// [0, 1] normalised.
    Unit,
    /// 0..255 byte intensity — common in ASCII dumps.
    Byte255,
    /// Cyclone's legacy 0..2047 integer reflectance.
    Legacy2047,
    /// Already 16-bit-ish.
    Raw,
}

impl IntensityScale {
    /// Pick the convention from a file's observed intensity range.
    pub fn from_range(min: f64, max: f64) -> Self {
        if !min.is_finite() || !max.is_finite() { return IntensityScale::Unit; }
        if min < 0.0 && max <= 1.0 { IntensityScale::Signed }
        else if max <= 1.0 { IntensityScale::Unit }
        else if max <= 255.0 { IntensityScale::Byte255 }
        else if max <= 2048.0 { IntensityScale::Legacy2047 }
        else { IntensityScale::Raw }
    }

    /// Monotonic within the chosen convention — that is the whole point.
    pub fn map(self, v: f64) -> u16 {
        if v.is_nan() { return 0; }
        let unit = match self {
            IntensityScale::Signed => (v + 1.0) * 0.5,
            IntensityScale::Unit => v,
            IntensityScale::Byte255 => v / 255.0,
            IntensityScale::Legacy2047 => v / 2047.0,
            IntensityScale::Raw => v / 65535.0,
        };
        (unit.clamp(0.0, 1.0) * 65535.0).round() as u16
    }
}

/// Colour conventions: a channel is either a 0..1 float or a 0..255 byte.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ColourScale {
    /// 0..1 float.
    Unit,
    /// 0..255 byte.
    Byte255,
}

impl ColourScale {
    /// A file whose channels never exceed 1 is a float file; anything
    /// above that is bytes.
    ///
    /// Guessing this per value is catastrophic rather than merely
    /// imprecise, because the two conventions collide exactly where
    /// real data lives. In an 8-bit file a channel of 1 is almost
    /// black — and the per-value test read it as a float, mapping it to
    /// FULL brightness:
    ///
    /// ```text
    ///   channel     old output
    ///        0               0
    ///        1           65535
    ///        2             514
    ///        3             771
    /// ```
    ///
    /// Every near-black pixel with a channel of exactly 1 came out
    /// saturated, so a dark forest floor imported speckled with pure
    /// red, green and blue.
    pub fn from_max(max: f64) -> Self {
        if max.is_finite() && max > 1.0 { ColourScale::Byte255 } else { ColourScale::Unit }
    }

    pub fn map(self, v: f64) -> u16 {
        if v.is_nan() { return 0; }
        let unit = match self {
            ColourScale::Unit => v,
            ColourScale::Byte255 => v / 255.0,
        };
        (unit.clamp(0.0, 1.0) * 65535.0).round() as u16
    }

    pub fn map_rgb(self, r: f64, g: f64, b: f64) -> (u16, u16, u16) {
        (self.map(r), self.map(g), self.map(b))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The property the per-value guess did not have: whatever
    /// convention a file uses, a brighter value must come out brighter.
    #[test]
    fn every_intensity_scale_is_monotonic() {
        for (scale, samples) in [
            (IntensityScale::Signed, vec![-1.0, -0.9, -0.5, -0.1, 0.0, 0.1, 0.5, 1.0]),
            (IntensityScale::Unit, vec![0.0, 0.1, 0.5, 0.9, 1.0]),
            (IntensityScale::Byte255, vec![0.0, 1.0, 2.0, 128.0, 255.0]),
            (IntensityScale::Legacy2047, vec![0.0, 1.0, 1023.0, 2047.0]),
            (IntensityScale::Raw, vec![0.0, 1.0, 32768.0, 65535.0]),
        ] {
            let mut prev = 0u16;
            for (k, v) in samples.iter().enumerate() {
                let out = scale.map(*v);
                if k > 0 { assert!(out >= prev, "{scale:?}: {v} → {out}, below {prev}"); }
                prev = out;
            }
        }
    }

    #[test]
    fn every_intensity_scale_spans_the_output() {
        assert_eq!(IntensityScale::Signed.map(-1.0), 0);
        assert_eq!(IntensityScale::Signed.map(1.0), 65535);
        assert_eq!(IntensityScale::Signed.map(0.0), 32768);
        assert_eq!(IntensityScale::Unit.map(1.0), 65535);
        assert_eq!(IntensityScale::Byte255.map(255.0), 65535);
        assert_eq!(IntensityScale::Legacy2047.map(2047.0), 65535);
        assert_eq!(IntensityScale::Raw.map(65535.0), 65535);
        // Out of range clamps rather than wrapping.
        assert_eq!(IntensityScale::Unit.map(-5.0), 0);
        assert_eq!(IntensityScale::Byte255.map(1e9), 65535);
        assert_eq!(IntensityScale::Unit.map(f64::NAN), 0);
    }

    #[test]
    fn the_intensity_convention_comes_from_the_range() {
        assert_eq!(IntensityScale::from_range(-1.0, 1.0), IntensityScale::Signed);
        assert_eq!(IntensityScale::from_range(0.0, 1.0), IntensityScale::Unit);
        assert_eq!(IntensityScale::from_range(0.0, 255.0), IntensityScale::Byte255);
        assert_eq!(IntensityScale::from_range(0.0, 2047.0), IntensityScale::Legacy2047);
        assert_eq!(IntensityScale::from_range(0.0, 60000.0), IntensityScale::Raw);
        // Nothing observed: pick something safe rather than propagate
        // infinities into the mapping.
        assert_eq!(IntensityScale::from_range(f64::INFINITY, f64::NEG_INFINITY), IntensityScale::Unit);
    }

    /// The colour case, which is the worse of the two: the conventions
    /// collide exactly where real data lives.
    #[test]
    fn a_dark_byte_channel_stays_dark() {
        let s = ColourScale::from_max(255.0);
        assert_eq!(s, ColourScale::Byte255);
        // 0, 1, 2, 3 must stay near black and stay in order. The
        // per-value guess sent 1 to 65535.
        let outs: Vec<u16> = [0.0, 1.0, 2.0, 3.0].iter().map(|v| s.map(*v)).collect();
        for w in outs.windows(2) { assert!(w[1] > w[0], "not increasing: {outs:?}"); }
        assert!(outs[1] < 1000, "channel 1 came out at {}", outs[1]);
        assert_eq!(s.map(255.0), 65535);
    }

    #[test]
    fn a_float_channel_file_uses_the_float_mapping() {
        let s = ColourScale::from_max(1.0);
        assert_eq!(s, ColourScale::Unit);
        assert_eq!(s.map(0.0), 0);
        assert_eq!(s.map(1.0), 65535);
        assert_eq!(s.map(0.5), 32768);
        // A file that never reaches 1 is still a float file.
        assert_eq!(ColourScale::from_max(0.8), ColourScale::Unit);
    }

    #[test]
    fn colour_is_monotonic_and_clamps() {
        for s in [ColourScale::Unit, ColourScale::Byte255] {
            let mut prev = 0u16;
            for v in [0.0f64, 0.25, 0.5, 0.75, 1.0, 2.0, 255.0] {
                let out = s.map(v);
                assert!(out >= prev, "{s:?}: {v} → {out}, below {prev}");
                prev = out;
            }
            assert_eq!(s.map(-1.0), 0);
            assert_eq!(s.map(f64::NAN), 0);
        }
        assert_eq!(ColourScale::Byte255.map_rgb(255.0, 0.0, 128.0), (65535, 0, 32896));
    }
}
