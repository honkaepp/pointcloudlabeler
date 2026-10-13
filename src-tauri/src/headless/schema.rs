// PointCloudLabeler — Tree segmentation, editing and label transfer for close-range forest point clouds
// Copyright (C) 2026 Eppu Honkanen
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

//! Reading an operation's JSON Schema as a list of parameters — what the
//! command line turns into flags and the console into a form. One
//! reader, so the two agree on what a parameter is called, whether it
//! is required, what type it has and what its default is.

use serde_json::Value;

/// The kind of value a parameter takes, as far as a text surface needs
/// to know.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    String,
    Number,
    Integer,
    Boolean,
    /// An array, an object or a reference to one: typed as JSON text.
    Json,
}

#[derive(Clone, Debug)]
pub struct Param {
    /// The wire name (camelCase), as the catalogue takes it.
    pub name: String,
    pub kind: Kind,
    pub required: bool,
    /// Whether null is an accepted value (an `Option`).
    pub nullable: bool,
    pub description: String,
    pub default: Option<Value>,
    /// The allowed values, when the schema lists them.
    pub choices: Vec<String>,
}

/// Flatten `schema`'s top-level `properties` into parameters. Nested
/// objects are not expanded: they are one parameter typed as JSON.
pub fn params_of(schema: &Value) -> Vec<Param> {
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut out = Vec::new();
    let Some(props) = schema.get("properties").and_then(Value::as_object) else {
        return out;
    };
    for (name, prop) in props {
        let (kind, nullable) = kind_of(prop, schema);
        let choices = choices_of(prop, schema);
        out.push(Param {
            name: name.clone(),
            kind,
            required: required.contains(&name.as_str()),
            nullable,
            description: prop.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
            default: prop.get("default").cloned(),
            choices,
        });
    }
    // Required first, then as declared.
    out.sort_by_key(|p| !p.required);
    out
}

/// Follow a local `$ref` (`#/$defs/Name`, `#/definitions/Name`) to the
/// schema it names; anything else is returned as it is.
fn resolve<'a>(prop: &'a Value, root: &'a Value) -> &'a Value {
    let Some(r) = prop.get("$ref").and_then(Value::as_str) else {
        return prop;
    };
    let mut cur = root;
    for seg in r.trim_start_matches('#').split('/').filter(|s| !s.is_empty()) {
        match cur.get(seg) {
            Some(v) => cur = v,
            None => return prop,
        }
    }
    cur
}

/// The string values a schema admits: an `enum` of strings, or a
/// `oneOf` of string constants (schemars' spelling of a documented
/// enum). Through a `$ref`, and through `anyOf [X, null]`.
fn choices_of(prop: &Value, root: &Value) -> Vec<String> {
    let prop = resolve(prop, root);
    if let Some(a) = prop.get("enum").and_then(Value::as_array) {
        return a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
    }
    if let Some(one) = prop.get("oneOf").and_then(Value::as_array) {
        let consts: Vec<String> = one.iter().filter_map(|v| v.get("const").and_then(Value::as_str).map(str::to_string)).collect();
        if consts.len() == one.len() {
            return consts;
        }
    }
    if let Some(any) = prop.get("anyOf").and_then(Value::as_array) {
        let non_null: Vec<&Value> = any.iter().filter(|v| v.get("type").and_then(Value::as_str) != Some("null")).collect();
        if non_null.len() == 1 {
            return choices_of(non_null[0], root);
        }
    }
    Vec::new()
}

fn kind_of(prop: &Value, root: &Value) -> (Kind, bool) {
    let prop = resolve(prop, root);
    // A documented enum (`oneOf` of string constants) is a string with
    // choices, not JSON: `--edge halfcount` must not need quoting.
    if prop.get("type").is_none() && prop.get("anyOf").is_none() {
        let choices = choices_of(prop, root);
        if !choices.is_empty() {
            return (Kind::String, false);
        }
    }
    // `type` may be a string or a list including "null" (an Option).
    let mut nullable = false;
    let mut types: Vec<&str> = Vec::new();
    match prop.get("type") {
        Some(Value::String(s)) => types.push(s.as_str()),
        Some(Value::Array(a)) => {
            for t in a {
                if let Some(s) = t.as_str() {
                    if s == "null" { nullable = true } else { types.push(s) }
                }
            }
        }
        _ => {}
    }
    if types.is_empty() {
        // anyOf [X, null] is schemars' other spelling of an Option.
        if let Some(any) = prop.get("anyOf").and_then(Value::as_array) {
            let non_null: Vec<&Value> = any.iter().filter(|v| v.get("type").and_then(Value::as_str) != Some("null")).collect();
            if non_null.len() < any.len() {
                nullable = true;
            }
            if non_null.len() == 1 {
                let (k, _) = kind_of(non_null[0], root);
                return (k, nullable);
            }
        }
        return (Kind::Json, nullable);
    }
    let kind = match types[0] {
        "string" => Kind::String,
        "number" => Kind::Number,
        "integer" => Kind::Integer,
        "boolean" => Kind::Boolean,
        _ => Kind::Json,
    };
    (kind, nullable)
}

/// Turn a value typed on a command line into the JSON the parameter
/// takes. "null" is null for a nullable parameter; JSON parameters are
/// parsed as JSON, or, when that fails and a list of strings is wanted,
/// split on commas.
pub fn parse_value(p: &Param, text: &str) -> Result<Value, String> {
    let t = text.trim();
    if p.nullable && (t == "null" || t.is_empty()) {
        return Ok(Value::Null);
    }
    match p.kind {
        Kind::String => Ok(Value::String(text.to_string())),
        Kind::Number => t.parse::<f64>().map(|f| serde_json::json!(f)).map_err(|_| format!("--{} wants a number, got '{text}'", flag_name(&p.name))),
        Kind::Integer => t.parse::<i64>().map(|i| serde_json::json!(i)).map_err(|_| format!("--{} wants a whole number, got '{text}'", flag_name(&p.name))),
        Kind::Boolean => match t {
            "true" | "yes" | "on" | "1" => Ok(Value::Bool(true)),
            "false" | "no" | "off" | "0" => Ok(Value::Bool(false)),
            _ => Err(format!("--{} wants true or false, got '{text}'", flag_name(&p.name))),
        },
        Kind::Json => match serde_json::from_str::<Value>(t) {
            Ok(v) => Ok(v),
            Err(e) => {
                if !t.starts_with('{') && !t.starts_with('[') {
                    Ok(Value::Array(t.split(',').map(|s| Value::String(s.trim().to_string())).collect()))
                } else {
                    Err(format!("--{} is not valid JSON: {e}", flag_name(&p.name)))
                }
            }
        },
    }
}

/// `octreeDir` → `octree-dir`; `las14` → `las14`.
pub fn flag_name(camel: &str) -> String {
    let mut out = String::with_capacity(camel.len() + 4);
    for (i, c) in camel.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                out.push('-');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// `realign-to-source` → `realignToSource`.
pub fn camel_name(kebab: &str) -> String {
    let mut out = String::with_capacity(kebab.len());
    let mut up = false;
    for c in kebab.chars() {
        if c == '-' || c == '_' {
            up = true;
        } else if up {
            out.push(c.to_ascii_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// The MCP tool name of an operation: `dataset.realignToSource` →
/// `dataset_realign_to_source`. The hosts that forward tools to a model
/// allow only `[A-Za-z0-9_-]`, and one style throughout reads better
/// than a dot swapped for an underscore in a camelCase name.
pub fn tool_name(op: &str) -> String {
    let mut out = String::with_capacity(op.len() + 4);
    for c in op.chars() {
        if c == '.' {
            out.push('_');
        } else if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// A default as a help line prints it.
pub fn default_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops;

    #[test]
    fn names_round_trip_between_wire_and_flag_spellings() {
        assert_eq!(flag_name("octreeDir"), "octree-dir");
        assert_eq!(flag_name("hliLatitudeDeg"), "hli-latitude-deg");
        assert_eq!(flag_name("las14"), "las14");
        assert_eq!(camel_name("realign-to-source"), "realignToSource");
        assert_eq!(camel_name("chm"), "chm");
        for name in ["octreeDir", "crownRadiusPerM", "k1", "dsmLayers"] {
            assert_eq!(camel_name(&flag_name(name)), name);
        }
        assert_eq!(tool_name("segment.chm"), "segment_chm");
        assert_eq!(tool_name("dataset.realignToSource"), "dataset_realign_to_source");
        assert_eq!(tool_name("review.setSpecies"), "review_set_species");
    }

    #[test]
    fn the_ground_schema_reads_as_parameters_with_defaults_and_one_required() {
        let op = ops::find("ground.classify").unwrap();
        let params = params_of(&op.params_schema());
        let dir = params.iter().find(|p| p.name == "octreeDir").expect("octreeDir");
        assert!(dir.required && dir.kind == Kind::String && !dir.nullable);
        assert_eq!(params[0].name, "octreeDir", "required parameters come first");
        let cell = params.iter().find(|p| p.name == "cellSize").unwrap();
        assert_eq!(cell.kind, Kind::Number);
        assert_eq!(cell.default, Some(serde_json::json!(0.5)));
        assert!(!cell.required);
        let method = params.iter().find(|p| p.name == "method").unwrap();
        assert!(method.description.contains("pmf"));
    }

    #[test]
    fn options_arrays_objects_and_enums_are_recognised() {
        let p = params_of(&ops::find("dataset.import").unwrap().params_schema());
        let name = p.iter().find(|p| p.name == "name").unwrap();
        assert!(name.nullable && name.kind == Kind::String);
        let extras = p.iter().find(|p| p.name == "extraNames").unwrap();
        assert_eq!(extras.kind, Kind::Json);
        assert_eq!(parse_value(extras, "a,b").unwrap(), serde_json::json!(["a", "b"]));
        assert_eq!(parse_value(extras, "[\"a\"]").unwrap(), serde_json::json!(["a"]));
        let depth = p.iter().find(|p| p.name == "maxDepth").unwrap();
        assert_eq!(depth.kind, Kind::Integer);
        assert_eq!(parse_value(depth, "12").unwrap(), serde_json::json!(12));
        assert!(parse_value(depth, "deep").unwrap_err().contains("whole number"));
        let p = params_of(&ops::find("export.las").unwrap().params_schema());
        let filter = p.iter().find(|p| p.name == "filter").unwrap();
        assert_eq!(filter.kind, Kind::Json);
        assert!(filter.nullable);
        assert_eq!(parse_value(filter, "null").unwrap(), Value::Null);
        let p = params_of(&ops::find("review.set").unwrap().params_schema());
        let verdicts = p.iter().find(|p| p.name == "verdicts").unwrap();
        assert_eq!(verdicts.kind, Kind::Json);
        assert!(parse_value(verdicts, "{bad").unwrap_err().contains("not valid JSON"));
        let flag = Param { name: "x".into(), kind: Kind::Boolean, required: false, nullable: false, description: String::new(), default: None, choices: vec![] };
        assert_eq!(parse_value(&flag, "yes").unwrap(), Value::Bool(true));
        assert!(parse_value(&flag, "maybe").is_err());
    }

    /// An enum behind a `$ref` is a string with choices on every surface,
    /// so `--edge halfcount` works unquoted; an optional one is nullable;
    /// a tagged union stays JSON.
    #[test]
    fn referenced_enums_are_strings_with_choices() {
        let p = params_of(&ops::find("metrics.plot").unwrap().params_schema());
        let edge = p.iter().find(|p| p.name == "edge").unwrap();
        assert_eq!(edge.kind, Kind::String);
        assert!(!edge.nullable);
        assert_eq!(edge.choices, vec!["none", "halfcount", "crownArea"]);
        assert_eq!(parse_value(edge, "halfcount").unwrap(), Value::String("halfcount".into()));
        let fit = p.iter().find(|p| p.name == "fit").unwrap();
        assert_eq!(fit.kind, Kind::String);
        assert!(fit.nullable);
        assert_eq!(fit.choices, vec!["rectangular", "circular"]);
        assert_eq!(parse_value(fit, "null").unwrap(), Value::Null);
        let boundary = p.iter().find(|p| p.name == "boundary").unwrap();
        assert_eq!(boundary.kind, Kind::Json);
        assert!(boundary.nullable);
        assert_eq!(
            parse_value(boundary, r#"{"kind":"circular","center":[0,0],"radius":5}"#).unwrap()["radius"],
            serde_json::json!(5)
        );
    }
}
