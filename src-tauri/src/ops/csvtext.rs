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

//! Reading and writing CSV the way the renderer does (`src/io/csv.ts`):
//! RFC 4180 quotes, a sniffed delimiter that prefers the semicolon
//! over the comma for a Finnish export, a detected decimal comma, a
//! strict number parse that refuses a date or a unit stuck to a value,
//! the formula guard on write and its exact inverse on read, and a
//! UTF-8 byte-order mark so a spreadsheet reads the file as UTF-8.

/// A parsed file: delimiter, whether the first row was a header, the
/// headers (invented `col1…` when not), the rows, and whether the file
/// writes decimals with a comma.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedCsv {
    pub delimiter: char,
    pub has_header: bool,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub decimal_comma: bool,
}

/// Candidate delimiters in preference order: ties go to the more
/// explicit separator.
const DELIMITERS: [char; 4] = [';', '\t', ',', ' '];

pub const UTF8_BOM: char = '\u{feff}';

/// Split one line on `delimiter`, honouring RFC 4180 double quotes; a
/// space delimiter splits on runs of whitespace.
pub fn split_line(line: &str, delimiter: char) -> Vec<String> {
    if delimiter == ' ' {
        return line.split_whitespace().map(str::to_string).collect();
    }
    let chars: Vec<char> = line.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if in_quotes {
            if ch == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    cur.push('"');
                    i += 1;
                } else {
                    in_quotes = false;
                }
            } else {
                cur.push(ch);
            }
        } else if ch == '"' && cur.trim().is_empty() {
            in_quotes = true;
            cur.clear();
        } else if ch == delimiter {
            out.push(cur.trim().to_string());
            cur.clear();
        } else {
            cur.push(ch);
        }
        i += 1;
    }
    out.push(cur.trim().to_string());
    out
}

pub fn sniff_delimiter(lines: &[&str]) -> char {
    let sample: Vec<&str> = lines.iter().take(5).copied().collect();
    let (mut best, mut best_score) = (',', -1.0f64);
    for d in DELIMITERS {
        if sample.is_empty() {
            continue;
        }
        let counts: Vec<f64> = sample.iter().map(|l| split_line(l, d).len() as f64).collect();
        let mean = counts.iter().sum::<f64>() / counts.len() as f64;
        if mean < 2.0 {
            continue;
        }
        let variance = counts.iter().map(|c| (c - mean) * (c - mean)).sum::<f64>() / counts.len() as f64;
        let score = mean - variance;
        if score > best_score {
            best_score = score;
            best = d;
        }
    }
    best
}

fn is_decimal_comma_number(s: &str) -> bool {
    let s = s.trim();
    let body = s.strip_prefix(['+', '-']).unwrap_or(s);
    let Some((a, b)) = body.split_once(',') else { return false };
    !a.is_empty() && !b.is_empty() && a.chars().all(|c| c.is_ascii_digit()) && b.chars().all(|c| c.is_ascii_digit())
}

/// Whether the file uses a comma for the decimal point: only possible
/// when the comma is not the delimiter.
pub fn detect_decimal_comma(rows: &[Vec<String>], delimiter: char) -> bool {
    if delimiter == ',' {
        return false;
    }
    rows.iter().any(|r| r.iter().any(|c| is_decimal_comma_number(c)))
}

/// `^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`
fn is_plain_number(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let fs = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - fs;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let es = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == es {
            return false;
        }
    }
    i == b.len()
}

/// Strict numeric parse: NaN for anything that is not wholly a number.
pub fn parse_number(raw: Option<&str>, decimal_comma: bool) -> f64 {
    let Some(raw) = raw else { return f64::NAN };
    let mut s = raw.trim().to_string();
    if s.is_empty() {
        return f64::NAN;
    }
    if decimal_comma {
        s = s.replacen(',', ".", 1);
    }
    if !is_plain_number(&s) {
        return f64::NAN;
    }
    s.parse::<f64>().unwrap_or(f64::NAN)
}

pub fn strip_bom(text: &str) -> &str {
    text.strip_prefix(UTF8_BOM).unwrap_or(text)
}

/// Whether JavaScript's loose `parseFloat` would read a number off the
/// front of the cell: an optional sign, then a digit, a dot and a
/// digit, or "Infinity".
fn loose_parse_ok(c: &str) -> bool {
    let t = c.trim();
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    let b = body.as_bytes();
    match b.first() {
        Some(d) if d.is_ascii_digit() => true,
        Some(b'.') => b.get(1).is_some_and(|d| d.is_ascii_digit()),
        _ => body.starts_with("Infinity"),
    }
}

/// The renderer's `parseCsv`: None for an empty file. The first row is
/// a header iff any cell is non-numeric under a loose parse with the
/// decimal comma normalised.
pub fn parse_csv(text: &str) -> Option<ParsedCsv> {
    let lines: Vec<&str> = strip_bom(text).split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return None;
    }
    let delimiter = sniff_delimiter(&lines);
    let first = split_line(lines[0], delimiter);
    let has_header = first.iter().any(|c| !c.is_empty() && !loose_parse_ok(&c.replacen(',', ".", 1)));
    let headers = if has_header { first.clone() } else { (1..=first.len()).map(|i| format!("col{i}")).collect() };
    let body = if has_header { &lines[1..] } else { &lines[..] };
    let rows: Vec<Vec<String>> = body.iter().map(|l| split_line(l, delimiter)).collect();
    let decimal_comma = detect_decimal_comma(&rows, delimiter);
    Some(ParsedCsv { delimiter, has_header, headers, rows, decimal_comma })
}

const FORMULA_GUARD: char = '\'';

/// A text cell a spreadsheet would evaluate as a formula.
pub fn needs_formula_guard(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let first = s.chars().next().unwrap();
    if matches!(first, '=' | '@' | '\t' | '\r') {
        return true;
    }
    if !matches!(first, '+' | '-') {
        return false;
    }
    !is_plain_number(s)
}

/// A value as a CSV cell: guarded against formula evaluation, quoted
/// when it carries a delimiter, a quote or a line break.
pub fn csv_field(v: &str) -> String {
    let s = if needs_formula_guard(v) { format!("{FORMULA_GUARD}{v}") } else { v.to_string() };
    if s.chars().any(|c| matches!(c, '"' | ',' | '\n' | '\r' | ';' | '\t')) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

/// Undo `csv_field`'s formula guard, and nothing else.
pub fn csv_unguard(s: &str) -> String {
    match s.strip_prefix(FORMULA_GUARD) {
        Some(rest) if needs_formula_guard(rest) => rest.to_string(),
        _ => s.to_string(),
    }
}

/// JavaScript's `toFixed`: `decimals` places, an exact tie rounded away
/// from zero (37.25 → "37.3"), where Rust's formatter would round it to
/// even ("37.2"). The two sides print the same figure.
pub fn to_fixed(v: f64, decimals: usize) -> String {
    let scale = 10f64.powi(decimals as i32);
    let scaled = v * scale;
    let rounded = if scaled.is_finite() && scaled.abs() < 1e15 { scaled.round() / scale } else { v };
    format!("{rounded:.decimals$}")
}

/// A number as a cell: fixed decimals, or an empty cell for no number.
pub fn csv_num(v: f64, decimals: usize) -> String {
    if v.is_finite() { to_fixed(v, decimals) } else { String::new() }
}

/// The file as text: BOM first, lines joined with `\n`.
pub fn csv_text(lines: &[String]) -> String {
    format!("{UTF8_BOM}{}", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn split_line_honours_quotes_trims_and_keeps_empty_cells() {
        assert_eq!(split_line("1,\"Smith, J\",24.7", ','), v(&["1", "Smith, J", "24.7"]));
        assert_eq!(split_line("1,\"say \"\"hi\"\"\",2", ','), v(&["1", "say \"hi\"", "2"]));
        assert_eq!(split_line("1,2,3", ','), v(&["1", "2", "3"]));
        assert_eq!(split_line("a;b;c", ';'), v(&["a", "b", "c"]));
        assert_eq!(split_line(" 1 , 2 ", ','), v(&["1", "2"]));
        assert_eq!(split_line("1,,3", ','), v(&["1", "", "3"]));
        assert_eq!(split_line("1,2,", ','), v(&["1", "2", ""]));
        assert_eq!(split_line("  1   2  3 ", ' '), v(&["1", "2", "3"]));
        assert_eq!(split_line("1,6'' pine,3", ','), v(&["1", "6'' pine", "3"]));
        assert_eq!(split_line("1,ab\"cd,3", ','), v(&["1", "ab\"cd", "3"]));
    }

    #[test]
    fn sniff_delimiter_prefers_the_semicolon_for_a_finnish_export() {
        assert_eq!(sniff_delimiter(&["1;100,5;200,3;24,7;18,4", "2;103,2;205,1;31,2;21,6", "3;99,8;210,0;28,1;19,9"]), ';');
        assert_eq!(sniff_delimiter(&["id;x;y;dbh;h", "1;100,5;200,3;24,7;18,4"]), ';');
        assert_eq!(sniff_delimiter(&["id,x,y,dbh", "1,100.5,200.3,24.7"]), ',');
        assert_eq!(sniff_delimiter(&["id\tx\ty", "1\t100.5\t200.3"]), '\t');
        assert_eq!(sniff_delimiter(&["1 100.5 200.3", "2 103.2 205.1"]), ' ');
        assert_eq!(sniff_delimiter(&["id;x;y;species", "1;100.5;200.3;\"Pine, Scots\"", "2;103.2;205.1;\"Spruce, Norway\""]), ';');
    }

    #[test]
    fn decimal_comma_and_strict_numbers() {
        assert!(detect_decimal_comma(&[v(&["1", "100,5", "24,7"])], ';'));
        assert!(!detect_decimal_comma(&[v(&["1", "100", "5"])], ','));
        assert!(!detect_decimal_comma(&[v(&["1", "100.5", "24.7"])], ';'));
        assert!(!detect_decimal_comma(&[v(&["1", "100.5", "Pine, Scots"])], ';'));
        assert!((parse_number(Some("24,7"), true) - 24.7).abs() < 1e-12);
        assert!(parse_number(Some("24,7"), false).is_nan());
        assert!((parse_number(Some("24.7"), true) - 24.7).abs() < 1e-12);
        assert!(parse_number(Some("2024-05-01"), false).is_nan());
        assert!(parse_number(Some("24.7cm"), false).is_nan());
        assert!(parse_number(Some("n/a"), false).is_nan());
        assert!(parse_number(Some(""), false).is_nan() && parse_number(Some("   "), false).is_nan() && parse_number(None, false).is_nan());
        assert!((parse_number(Some("-3.5"), false) + 3.5).abs() < 1e-12);
        assert!((parse_number(Some("+3.5"), false) - 3.5).abs() < 1e-12);
        assert!((parse_number(Some("1e3"), false) - 1000.0).abs() < 1e-12);
        assert!((parse_number(Some(".5"), false) - 0.5).abs() < 1e-12);
    }

    #[test]
    fn parse_csv_end_to_end() {
        let p = parse_csv("id;x;y;dbh;h\n1;100,5;200,3;24,7;18,4\n2;103,2;205,1;31,2;21,6").unwrap();
        assert_eq!((p.delimiter, p.decimal_comma, p.has_header), (';', true, true));
        assert_eq!(p.headers, v(&["id", "x", "y", "dbh", "h"]));
        assert_eq!(p.rows.len(), 2);
        assert_eq!(p.rows[0], v(&["1", "100,5", "200,3", "24,7", "18,4"]));
        let p = parse_csv("id,x,y\n1,100.5,200.3").unwrap();
        assert_eq!((p.delimiter, p.decimal_comma), (',', false));
        assert_eq!(p.rows[0], v(&["1", "100.5", "200.3"]));
        let p = parse_csv("1,100.5,200.3\n2,103.2,205.1").unwrap();
        assert!(!p.has_header);
        assert_eq!(p.headers, v(&["col1", "col2", "col3"]));
        assert_eq!(p.rows.len(), 2);
        assert!(!parse_csv("1;100,5;200,3\n2;103,2;205,1").unwrap().has_header);
        let p = parse_csv("id,x,y\r\n1,1,2\r\n\r\n2,3,4\r\n").unwrap();
        assert_eq!(p.rows.len(), 2);
        assert_eq!(p.rows[1], v(&["2", "3", "4"]));
        assert!(parse_csv("").is_none() && parse_csv("\n\n  \n").is_none());
        let p = parse_csv("\u{feff}id,x\n1,2").unwrap();
        assert_eq!(p.headers[0], "id");
    }

    #[test]
    fn the_formula_guard_round_trips_and_quoting_is_minimal() {
        for s in ["=1+1", "@cmd", "+1+1", "-SUM(A1)", "\tx"] {
            assert!(needs_formula_guard(s), "{s}");
            assert_eq!(csv_unguard(&csv_field(s).trim_matches('"').replace("\"\"", "\"")), s);
        }
        for s in ["+3.5", "-3.5", "12", "pine", "", "'99 inventory"] {
            assert!(!needs_formula_guard(s), "{s}");
            assert_eq!(csv_unguard(s), s);
        }
        assert_eq!(csv_field("Smith, J"), "\"Smith, J\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("pine"), "pine");
        assert_eq!(csv_num(1.23456, 2), "1.23");
        assert_eq!(to_fixed(37.25, 1), "37.3");
        assert_eq!(to_fixed(-37.25, 1), "-37.3");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(140000.0, 0), "140000");
        assert_eq!(to_fixed(0.5, 0), "1");
        assert_eq!(csv_num(f64::NAN, 2), "");
        assert_eq!(csv_num(0.0, 1), "0.0");
        assert!(csv_text(&v(&["a", "b"])).starts_with('\u{feff}'));
    }
}
