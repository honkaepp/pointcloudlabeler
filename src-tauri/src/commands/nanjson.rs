//! Reading back the JSON sidecars PointCloudLabeler writes, NaN included.
//!
//! The analysis passes say "could not be measured" with NaN: a stem whose
//! RANSAC found no circle has a NaN diameter, a QSM tree with no slice at
//! breast height has a NaN DBH, an empty set of point distances has a NaN
//! mean. JSON has no NaN, so serde_json writes it as `null` — and then
//! refuses to read `null` back as an f64. A pass therefore wrote a file
//! that nothing could open again as soon as ONE tree failed to fit, which
//! on a real plot is always. `metrics trees` stopped with
//! "decode fits: invalid type: null, expected f64", and the desktop app,
//! which treats an unreadable stems.json as "no fit run", quietly dropped
//! the refined diameters of every tree that HAD fitted.
//!
//! Writing something other than null would need a format of our own and
//! would still leave every existing file unreadable. Reading is where it
//! is fixed: a `null` where the type asks for a float is NaN, which is
//! what was written. Nothing else changes — a null for an `Option` is
//! still None, and a null for an integer, a string or a struct is still
//! the error it was.

use serde::de::{self, DeserializeOwned, DeserializeSeed, IntoDeserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Number, Value};

/// `serde_json::from_value`, except that `null` reads as NaN wherever the
/// type asks for an f64 or f32.
pub fn from_value<T: DeserializeOwned>(v: Value) -> Result<T, serde_json::Error> {
    T::deserialize(NanTolerant(v))
}

/// `serde_json::from_slice` with the same rule.
pub fn from_slice<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, serde_json::Error> {
    from_value(serde_json::from_slice::<Value>(bytes)?)
}

struct NanTolerant(Value);

fn visit_number<'de, V: Visitor<'de>>(n: Number, visitor: V) -> Result<V::Value, serde_json::Error> {
    if let Some(u) = n.as_u64() {
        visitor.visit_u64(u)
    } else if let Some(i) = n.as_i64() {
        visitor.visit_i64(i)
    } else {
        visitor.visit_f64(n.as_f64().unwrap_or(f64::NAN))
    }
}

impl<'de> de::Deserializer<'de> for NanTolerant {
    type Error = serde_json::Error;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        match self.0 {
            Value::Null => visitor.visit_unit(),
            Value::Bool(b) => visitor.visit_bool(b),
            Value::Number(n) => visit_number(n, visitor),
            Value::String(s) => visitor.visit_string(s),
            Value::Array(a) => {
                let len = a.len();
                let mut seq = Seq(a.into_iter());
                let out = visitor.visit_seq(&mut seq)?;
                if seq.0.len() == 0 {
                    Ok(out)
                } else {
                    Err(de::Error::invalid_length(len, &"fewer elements in array"))
                }
            }
            Value::Object(m) => visitor.visit_map(Obj { it: m.into_iter(), value: None }),
        }
    }

    fn deserialize_f64<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        if self.0.is_null() { visitor.visit_f64(f64::NAN) } else { self.deserialize_any(visitor) }
    }

    fn deserialize_f32<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        if self.0.is_null() { visitor.visit_f32(f32::NAN) } else { self.deserialize_any(visitor) }
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        if self.0.is_null() { visitor.visit_none() } else { visitor.visit_some(self) }
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(
        self, _name: &'static str, visitor: V,
    ) -> Result<V::Value, Self::Error> {
        visitor.visit_newtype_struct(self)
    }

    // Enums keep serde_json's own reading; none of the sidecars carries a
    // float inside an enum variant.
    fn deserialize_enum<V: Visitor<'de>>(
        self, name: &'static str, variants: &'static [&'static str], visitor: V,
    ) -> Result<V::Value, Self::Error> {
        de::Deserializer::deserialize_enum(self.0, name, variants, visitor)
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 char str string
        bytes byte_buf unit unit_struct seq tuple tuple_struct map struct
        identifier ignored_any
    }
}

struct Seq(std::vec::IntoIter<Value>);

impl<'de> SeqAccess<'de> for Seq {
    type Error = serde_json::Error;
    fn next_element_seed<T: DeserializeSeed<'de>>(&mut self, seed: T) -> Result<Option<T::Value>, Self::Error> {
        match self.0.next() {
            Some(v) => seed.deserialize(NanTolerant(v)).map(Some),
            None => Ok(None),
        }
    }
    fn size_hint(&self) -> Option<usize> { Some(self.0.len()) }
}

struct Obj {
    it: serde_json::map::IntoIter,
    value: Option<Value>,
}

impl<'de> MapAccess<'de> for Obj {
    type Error = serde_json::Error;
    fn next_key_seed<K: DeserializeSeed<'de>>(&mut self, seed: K) -> Result<Option<K::Value>, Self::Error> {
        match self.it.next() {
            Some((k, v)) => {
                self.value = Some(v);
                seed.deserialize(IntoDeserializer::<serde_json::Error>::into_deserializer(k)).map(Some)
            }
            None => Ok(None),
        }
    }
    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, Self::Error> {
        let v = self.value.take().ok_or_else(|| de::Error::custom("a map value was asked for before its key"))?;
        seed.deserialize(NanTolerant(v))
    }
    fn size_hint(&self) -> Option<usize> { Some(self.it.len()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use serde_json::json;

    #[derive(Serialize, Deserialize, Debug, PartialEq)]
    #[serde(rename_all = "camelCase")]
    enum Kind { Plain, Tagged { n: u32 } }

    #[derive(Serialize, Deserialize, Debug)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        tree_id: i32,
        dbh: f64,
        rmse: f32,
        count: u64,
        maybe: Option<f64>,
        #[serde(default)]
        link: Option<u32>,
        taper: Vec<(f64, f64)>,
        point: [f64; 3],
        kind: Kind,
        name: String,
    }

    fn row() -> Row {
        Row {
            tree_id: 7, dbh: f64::NAN, rmse: f32::NAN, count: 120, maybe: None, link: Some(3),
            taper: vec![(1.3, f64::NAN), (2.0, 0.25)], point: [1.0, f64::NAN, -2.5],
            kind: Kind::Tagged { n: 4 }, name: "t7".into(),
        }
    }

    /// The failure as it was: what serde_json writes, serde_json cannot read.
    #[test]
    fn serde_json_cannot_read_back_its_own_nan() {
        let v = serde_json::to_value(row()).unwrap();
        assert_eq!(v["dbh"], Value::Null, "NaN is written as null");
        let e = serde_json::from_value::<Row>(v).unwrap_err().to_string();
        assert!(e.contains("invalid type: null, expected f64"), "{e}");
    }

    /// Every float that was NaN comes back NaN; everything else exactly.
    #[test]
    fn nan_round_trips_and_nothing_else_moves() {
        let bytes = serde_json::to_vec_pretty(&row()).unwrap();
        let r: Row = from_slice(&bytes).unwrap();
        assert_eq!(r.tree_id, 7);
        assert!(r.dbh.is_nan());
        assert!(r.rmse.is_nan());
        assert_eq!(r.count, 120);
        assert_eq!(r.maybe, None, "a null Option<f64> is None, not Some(NaN)");
        assert_eq!(r.link, Some(3));
        assert_eq!(r.taper[0].0, 1.3);
        assert!(r.taper[0].1.is_nan());
        assert_eq!(r.taper[1], (2.0, 0.25));
        assert_eq!(r.point[0], 1.0);
        assert!(r.point[1].is_nan());
        assert_eq!(r.point[2], -2.5);
        assert_eq!(r.kind, Kind::Tagged { n: 4 });
        assert_eq!(r.name, "t7");
    }

    /// Whole numbers are written without a fraction; a float field reads
    /// them, an integer field reads them, and a float in an integer field
    /// is still refused.
    #[test]
    fn numbers_read_as_serde_json_reads_them() {
        let mut v = serde_json::to_value(row()).unwrap();
        v["dbh"] = json!(1);
        v["kind"] = json!("plain");
        v["link"] = Value::Null;
        let r: Row = from_value(v.clone()).unwrap();
        assert_eq!(r.dbh, 1.0);
        assert_eq!(r.kind, Kind::Plain);
        assert_eq!(r.link, None);
        v["count"] = json!(1.5);
        assert!(from_value::<Row>(v.clone()).is_err(), "1.5 was read as an integer");
        v["count"] = json!(-1);
        assert!(from_value::<Row>(v).is_err(), "-1 was read as a u64");
    }

    /// Only floats are forgiven: a null where an integer, a string or a
    /// tuple belongs is a broken file and stays an error.
    #[test]
    fn a_null_anywhere_else_is_still_an_error() {
        for key in ["count", "treeId", "name", "taper", "kind"] {
            let mut v = serde_json::to_value(row()).unwrap();
            v[key] = Value::Null;
            assert!(from_value::<Row>(v).is_err(), "null {key} was accepted");
        }
        let mut v = serde_json::to_value(row()).unwrap();
        v["point"] = json!([1.0, 2.0]);
        assert!(from_value::<Row>(v).is_err(), "a short array was accepted");
        let mut v = serde_json::to_value(row()).unwrap();
        v["taper"] = json!([[1.0, 2.0, 3.0]]);
        assert!(from_value::<Row>(v).is_err(), "a long tuple was accepted");
    }

    /// Fields the struct does not know are skipped, as before.
    #[test]
    fn unknown_fields_are_ignored() {
        let mut v = serde_json::to_value(row()).unwrap();
        v["laterField"] = json!({ "a": [null, 1, "x"] });
        assert!(from_value::<Row>(v).is_ok());
    }
}
