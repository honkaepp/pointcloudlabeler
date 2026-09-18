// CSV, both directions.
//
// The reader and the writer live together because their being inverses
// of each other is the property that broke: the validation panel quoted
// free text on write and never unquoted on read, so a field CSV it had
// exported itself could not be loaded back without shredding any row
// with a comma in it. `csvField` and `splitLine` are now one pair, and a
// round-trip test holds them to it.

/** Does this text cell read as a FORMULA to a spreadsheet?
 *
 *  Excel, LibreOffice and Sheets evaluate a cell that begins with `=`,
 *  `+`, `-`, `@`, a tab or a carriage return. RFC 4180 quoting does not
 *  stop it: the parser strips the quotes before the cell is interpreted,
 *  so `"=1+1"` is still a formula. Text carrying `=cmd|' /C calc'!A0`
 *  is the classic weaponised form.
 *
 *  This matters here because a text cell in a PointCloudLabeler export can come
 *  from a file PointCloudLabeler did not write: ValidationPanel exports the
 *  `field_id` of every tree straight from the field-measurement CSV the
 *  user imported, and those are exchanged between institutions and
 *  downloaded from databases. Import one, export the comparison, mail
 *  the comparison to a co-author, and the formula runs on their machine.
 *
 *  `+` and `-` are qualified rather than blanket-refused: `-42` and
 *  `+42` are how a spreadsheet writes a signed NUMBER, and marking
 *  those would alter real values — a plot id of `-3` is a plot id. They
 *  are only formula leads when what follows them is not simply a
 *  number, which is exactly when `-1+1` or `-cmd` would evaluate. */
export function needsFormulaGuard(s: string): boolean {
  if (s === '') return false;
  if (/^[=@\t\r]/.test(s)) return true;
  if (!/^[+-]/.test(s)) return false;
  // A signed plain number is a number. Anything else after the sign is
  // an expression waiting to be evaluated.
  return !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s);
}

/** The marker that defuses one. A leading apostrophe is what every
 *  spreadsheet reads as "the rest of this cell is text", and it is the
 *  only such marker they agree on. */
const FORMULA_GUARD = "'";

/** RFC 4180 field quoting, plus a guard on anything a spreadsheet would
 *  evaluate. Wrap in double quotes and double any quote inside, but only
 *  when the field actually needs it — a file of bare numbers should stay
 *  readable. */
export function csvField(v: string | number): string {
  const raw = String(v);
  const s = needsFormulaGuard(raw) ? FORMULA_GUARD + raw : raw;
  return /[",\n\r;\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Undo `csvField`'s formula guard, and nothing else.
 *
 *  The guard has to be reversible because PointCloudLabeler reads its own
 *  exports back — that is the property the file header is about. So this
 *  strips a leading apostrophe only when what follows it is something
 *  the guard would have marked, which makes the two exact inverses
 *  rather than a pair that nearly agrees. A cell that merely starts with
 *  an apostrophe — `'99 inventory` — is left alone. */
export function csvUnguard(s: string): string {
  return s.startsWith(FORMULA_GUARD) && needsFormulaGuard(s.slice(1))
    ? s.slice(1)
    : s;
}

/** A number as a CSV cell: fixed decimals, or an EMPTY cell when there
 *  is no number to write.
 *
 *  Never the string "NaN". A spreadsheet reads that as text, so the
 *  column stops being numeric and every average over it silently
 *  changes meaning; a script reading the file with a permissive parser
 *  reads it as zero, and a tree of height zero is a tree that vanished.
 *  An empty cell is the honest answer — the measurement was not made —
 *  and every tool that reads CSV already understands it.
 *
 *  This existed as a private `num()` helper in one panel, whose comment
 *  said exactly the above, and nowhere else. Across PointCloudLabeler's CSV
 *  exporters the guard was applied where its author happened to think of
 *  it: one row wrote its height guarded and its basal area raw, another
 *  guarded the DBH delta and not the height delta beside it, and the
 *  panel that defined the helper called `.toFixed()` directly in its
 *  main row type. */
export function csvNum(v: number | null | undefined, decimals: number): string {
  // The null check is redundant and the teeth check says so:
  // Number.isFinite does NOT coerce, so it is already false for null and
  // undefined (unlike the global isFinite, which reads null as 0). It
  // stays because "no value" and "not a number" are different things to
  // the caller, and the next person to reach for the global should not
  // have to rediscover the difference.
  if (v == null || !Number.isFinite(v)) return '';
  // Guard the formatter itself: toFixed throws a RangeError outside
  // 0..100, which would abort an export mid-file and leave the user a
  // truncated CSV that opens.
  const dp = Math.min(100, Math.max(0, Math.trunc(decimals) || 0));
  return v.toFixed(dp);
}

/** Split one line on `delimiter`, honouring RFC 4180 double quotes.
 *
 *  The naive `String.split` this replaces shredded any row with a quoted
 *  field containing the delimiter — `1,"Smith, J",24.7` became four
 *  cells instead of three, and every column after it shifted by one, so
 *  the DBH column silently became the species column. */
export function splitLine(line: string, delimiter: string): string[] {
  if (delimiter === ' ') return line.trim().split(/\s+/);
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"' && cur.trim() === '') {
      inQuotes = true;
      cur = '';
    } else if (ch === delimiter) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export interface ParsedCsv {
  delimiter: string;
  hasHeader: boolean;
  headers: string[];
  rows: string[][];
  /** True when the file writes decimals with a comma (24,7 = 24.7).
   *  Detected, not assumed — see `detectDecimalComma`. */
  decimalComma: boolean;
}

/** Candidate delimiters, in preference order. Ties go to the more
 *  explicit separator: a file that splits consistently on semicolons or
 *  tabs is delimited by them, and the commas in it are decimal points or
 *  text. A headerless Finnish export — `1;100,5;200,3;24,7;18,4` —
 *  splits into five cells on either a semicolon or a comma, and taking
 *  the comma cuts every value in half at its decimal point. */
const DELIMITERS = [';', '\t', ',', ' '];

export function sniffDelimiter(lines: string[]): string {
  const sample = lines.slice(0, 5);
  let best = ',', bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = sample.map(l => splitLine(l, d).length);
    if (counts.length === 0) continue;
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    if (mean < 2) continue;
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    const score = mean - variance;
    // Strictly greater, so the first candidate to reach a score keeps it.
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** Whether the file uses a comma for the decimal point.
 *
 *  Only possible when the comma is not the delimiter. `parseFloat` stops
 *  at the comma, so "24,7" read as 24 — every calipered diameter and
 *  hypsometer height in a Finnish, German, French or Nordic export
 *  silently lost its decimals. */
export function detectDecimalComma(rows: string[][], delimiter: string): boolean {
  if (delimiter === ',') return false;
  const re = /^[+-]?\d+,\d+$/;
  for (const r of rows) for (const c of r) if (re.test(c.trim())) return true;
  return false;
}

/** Strict numeric parse. NaN for anything that is not wholly a number.
 *
 *  `parseFloat` reads as far as it can and keeps what it got, so a date
 *  cell mapped to a height column came back as the year — a plausible
 *  number, in the right units, wrong by two thousand. */
export function parseNumber(raw: string | undefined, decimalComma: boolean): number {
  if (raw == null) return NaN;
  let s = raw.trim();
  if (s === '') return NaN;
  if (decimalComma) s = s.replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
  return parseFloat(s);
}

/** The UTF-8 byte-order mark, U+FEFF.
 *
 *  Excel writes one at the front of every file saved as "CSV UTF-8",
 *  and it is the ONLY thing that makes Excel read a UTF-8 CSV back as
 *  UTF-8 rather than as the machine's ANSI codepage — Windows-1252 in
 *  western Europe, 1251 in Russia, 932 in Japan. Without it, "m²"
 *  arrives as "mÂ²" and a Cyrillic or Greek plot name arrives as
 *  nothing readable at all. So PointCloudLabeler writes one too (see `csvBlob`).
 *
 *  It is not data. Left in place it becomes part of the first cell:
 *  a header of "﻿tree_id" matches no column mapping, and in a
 *  headerless file the first value parses as NaN — so the first tree in
 *  a field CSV exported from Excel silently lost its id. */
export const UTF8_BOM = '﻿';

export function stripBom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text;
}

/** A CSV ready to hand to the browser for download: UTF-8, BOM first,
 *  and a MIME type that says which encoding it is.
 *
 *  Every exporter built its own `new Blob([rows.join('\n')], { type:
 *  'text/csv' })`, eleven times, and none of them said UTF-8 anywhere.
 *  The files are full of characters that are not ASCII — m², m³, °, ±,
 *  the currency symbol, and whatever alphabet a species or plot name is
 *  written in — so outside a UTF-8 locale every one of them opened in
 *  Excel as mojibake. */
export function csvBlob(lines: string[]): Blob {
  return new Blob([csvText(lines)], { type: 'text/csv;charset=utf-8' });
}

/** The same file as text, for the exports that go through a save dialog
 *  and the native writer rather than through a browser download. Same
 *  BOM, same reason — the destination is the same spreadsheet. */
export function csvText(lines: string[]): string {
  return UTF8_BOM + lines.join('\n');
}

export function parseCsv(text: string): ParsedCsv | null {
  const lines = stripBom(text).split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return null;
  const delimiter = sniffDelimiter(lines);
  const first = splitLine(lines[0], delimiter);
  // Header iff any cell is non-numeric. Checked with the loose parse on
  // purpose: a header cell like "dbh_cm" is not a number under either
  // rule, and a decimal-comma value must not be mistaken for one.
  const hasHeader = first.some(c => c !== '' && Number.isNaN(parseFloat(c.replace(',', '.'))));
  const headers = hasHeader ? first : first.map((_, i) => `col${i + 1}`);
  const rows = (hasHeader ? lines.slice(1) : lines).map(l => splitLine(l, delimiter));
  return { delimiter, hasHeader, headers, rows, decimalComma: detectDecimalComma(rows, delimiter) };
}
