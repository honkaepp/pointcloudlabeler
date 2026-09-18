import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describeHits, scanSources } from '../testing/sourceScan';
import { describe, it, expect } from 'vitest';
import {
  csvField, splitLine, sniffDelimiter, detectDecimalComma, parseNumber, parseCsv, csvNum,
  csvBlob, csvText, stripBom, needsFormulaGuard, csvUnguard,
} from './csv';

/** The export side of this panel quotes on write. The read side did
 *  not unquote, so any field carrying the delimiter shredded its row —
 *  and every column after it shifted by one, silently. */
describe('splitLine', () => {
  it('keeps a quoted field containing the delimiter in one piece', () => {
    expect(splitLine('1,"Smith, J",24.7', ','))
      .toEqual(['1', 'Smith, J', '24.7']);
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(splitLine('1,"say ""hi""",2', ',')).toEqual(['1', 'say "hi"', '2']);
  });

  it('leaves an unquoted field alone', () => {
    expect(splitLine('1,2,3', ',')).toEqual(['1', '2', '3']);
    expect(splitLine('a;b;c', ';')).toEqual(['a', 'b', 'c']);
  });

  it('trims surrounding whitespace', () => {
    expect(splitLine(' 1 , 2 ', ',')).toEqual(['1', '2']);
  });

  it('keeps empty cells so column positions survive', () => {
    expect(splitLine('1,,3', ',')).toEqual(['1', '', '3']);
    expect(splitLine('1,2,', ',')).toEqual(['1', '2', '']);
  });

  it('collapses runs of whitespace when space is the delimiter', () => {
    expect(splitLine('  1   2  3 ', ' ')).toEqual(['1', '2', '3']);
  });

  it('does not treat a quote inside a bare word as an opening quote', () => {
    expect(splitLine("1,6'' pine,3", ',')).toEqual(['1', "6'' pine", '3']);
    expect(splitLine('1,ab"cd,3', ',')).toEqual(['1', 'ab"cd', '3']);
  });
});

/** A headerless Finnish export splits into the same number of cells on
 *  a semicolon or on a comma. The old tie-break took the comma, which
 *  cuts every value in half at its decimal point. */
describe('sniffDelimiter', () => {
  it('prefers the semicolon when both split a Finnish export the same way', () => {
    expect(sniffDelimiter([
      '1;100,5;200,3;24,7;18,4',
      '2;103,2;205,1;31,2;21,6',
      '3;99,8;210,0;28,1;19,9',
    ])).toBe(';');
  });

  it('still finds the semicolon when there is a header', () => {
    expect(sniffDelimiter(['id;x;y;dbh;h', '1;100,5;200,3;24,7;18,4'])).toBe(';');
  });

  it('finds a plain comma CSV', () => {
    expect(sniffDelimiter(['id,x,y,dbh', '1,100.5,200.3,24.7'])).toBe(',');
  });

  it('finds a tab-separated file', () => {
    expect(sniffDelimiter(['id\tx\ty', '1\t100.5\t200.3'])).toBe('\t');
  });

  it('finds a whitespace-separated dump', () => {
    expect(sniffDelimiter(['1 100.5 200.3', '2 103.2 205.1'])).toBe(' ');
  });

  it('is not fooled by a comma inside a quoted field', () => {
    expect(sniffDelimiter([
      'id;x;y;species',
      '1;100.5;200.3;"Pine, Scots"',
      '2;103.2;205.1;"Spruce, Norway"',
    ])).toBe(';');
  });
});

describe('detectDecimalComma', () => {
  it('spots it in a semicolon file', () => {
    expect(detectDecimalComma([['1', '100,5', '24,7']], ';')).toBe(true);
  });

  it('cannot apply when the comma is the delimiter', () => {
    expect(detectDecimalComma([['1', '100', '5']], ',')).toBe(false);
  });

  it('says no for plain decimal points', () => {
    expect(detectDecimalComma([['1', '100.5', '24.7']], ';')).toBe(false);
  });

  it('is not triggered by a comma inside text', () => {
    expect(detectDecimalComma([['1', '100.5', 'Pine, Scots']], ';')).toBe(false);
  });
});

/** `parseFloat` reads as far as it can and keeps what it got. */
describe('parseNumber', () => {
  it('reads a decimal comma when the file uses one', () => {
    expect(parseNumber('24,7', true)).toBeCloseTo(24.7, 12);
    expect(parseNumber('24,7', false)).toBeNaN();
  });

  it('reads plain decimals either way', () => {
    expect(parseNumber('24.7', true)).toBeCloseTo(24.7, 12);
    expect(parseNumber('24.7', false)).toBeCloseTo(24.7, 12);
  });

  it('rejects a date instead of reading the year as a measurement', () => {
    expect(parseNumber('2024-05-01', false)).toBeNaN();
  });

  it('rejects a value with a unit stuck to it rather than guessing', () => {
    expect(parseNumber('24.7cm', false)).toBeNaN();
    expect(parseNumber('n/a', false)).toBeNaN();
  });

  it('is NaN for blank and missing cells', () => {
    expect(parseNumber('', false)).toBeNaN();
    expect(parseNumber('   ', false)).toBeNaN();
    expect(parseNumber(undefined, false)).toBeNaN();
  });

  it('takes signs, exponents and bare fractions', () => {
    expect(parseNumber('-3.5', false)).toBeCloseTo(-3.5, 12);
    expect(parseNumber('+3.5', false)).toBeCloseTo(3.5, 12);
    expect(parseNumber('1e3', false)).toBeCloseTo(1000, 12);
    expect(parseNumber('.5', false)).toBeCloseTo(0.5, 12);
  });
});

describe('parseCsv', () => {
  it('reads a Finnish export end to end', () => {
    const p = parseCsv('id;x;y;dbh;h\n1;100,5;200,3;24,7;18,4\n2;103,2;205,1;31,2;21,6')!;
    expect(p.delimiter).toBe(';');
    expect(p.decimalComma).toBe(true);
    expect(p.hasHeader).toBe(true);
    expect(p.headers).toEqual(['id', 'x', 'y', 'dbh', 'h']);
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0]).toEqual(['1', '100,5', '200,3', '24,7', '18,4']);
  });

  it('reads a plain comma CSV unchanged', () => {
    const p = parseCsv('id,x,y\n1,100.5,200.3')!;
    expect(p.delimiter).toBe(',');
    expect(p.decimalComma).toBe(false);
    expect(p.rows[0]).toEqual(['1', '100.5', '200.3']);
  });

  it('invents column names when there is no header', () => {
    const p = parseCsv('1,100.5,200.3\n2,103.2,205.1')!;
    expect(p.hasHeader).toBe(false);
    expect(p.headers).toEqual(['col1', 'col2', 'col3']);
    expect(p.rows).toHaveLength(2);
  });

  /** A decimal-comma value must not be mistaken for a header cell. */
  it('does not call a numeric first row a header', () => {
    expect(parseCsv('1;100,5;200,3\n2;103,2;205,1')!.hasHeader).toBe(false);
  });

  it('tolerates CRLF and blank lines', () => {
    const p = parseCsv('id,x,y\r\n1,1,2\r\n\r\n2,3,4\r\n')!;
    expect(p.rows).toHaveLength(2);
    expect(p.rows[1]).toEqual(['2', '3', '4']);
  });

  it('is null for an empty file', () => {
    expect(parseCsv('')).toBeNull();
    expect(parseCsv('\n\n  \n')).toBeNull();
  });
});

/** The property that broke. The validation panel quoted free text on
 *  write and never unquoted on read, so a field CSV it had exported
 *  itself could not be loaded back without shredding any row carrying a
 *  comma. The two live in one file now, and this holds them to it. */
describe('csvField and splitLine are inverses', () => {
  const NASTY = [
    'plain', '', '42', '24.7',
    'Smith, J', 'a;b', 'a\tb',
    'say "hi"', '"leading quote', 'trailing quote"',
    'Pine, "Scots"', "6'' pine", '  padded  ',
    'ä ö å – ✓',
    // Cells a spreadsheet would evaluate. These are guarded on write,
    // so the inverse is csvUnguard ∘ splitLine — which is the whole
    // point of the guard being reversible.
    '=1+1', '=cmd|\' /C calc\'!A0', '@SUM(A1)', '-1+1', '+1+1',
    // And cells that merely look like they might be.
    '-42', '+42', '-3.5e2', "'99 inventory",
  ];

  for (const delim of [',', ';', '\t']) {
    it(`round-trips every field through ${JSON.stringify(delim)}`, () => {
      const row = NASTY.map(csvField).join(delim);
      // Padding is trimmed on read by design — cells are trimmed so a
      // hand-spaced CSV lines up. Compare against the trimmed source.
      expect(splitLine(row, delim).map(csvUnguard)).toEqual(NASTY.map(f => f.trim()));
    });
  }

  it('quotes only the fields that need it', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField(42)).toBe('42');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('a"b')).toBe('"a""b"');
  });

  it('round-trips a whole exported table', () => {
    const rows = [
      ['tree_id', 'severity', 'reason'],
      ['4', 'warning', 'crown area 12.3 m2 is 3.1 sigma above median, check split'],
      ['9', 'critical', 'no ground beneath stem; height reads 0'],
    ];
    const text = rows.map(r => r.map(csvField).join(',')).join('\n');
    const back = parseCsv(text)!;
    expect(back.delimiter).toBe(',');
    expect([back.headers, ...back.rows]).toEqual(rows);
  });
});

describe('csvNum', () => {
  it('formats a number to the requested decimals', () => {
    expect(csvNum(1.23456, 2)).toBe('1.23');
    expect(csvNum(1.23456, 4)).toBe('1.2346');
    expect(csvNum(42, 0)).toBe('42');
    expect(csvNum(-0.5, 1)).toBe('-0.5');
  });

  /** The rule the whole module exists for. "NaN" in a CSV makes the
   *  column non-numeric in a spreadsheet — every average over it
   *  silently changes meaning — and a permissive parser reads it as
   *  zero, so a tree of height zero is a tree that vanished. An empty
   *  cell says the measurement was not made, and every tool that reads
   *  CSV already understands it. */
  it('never writes the string NaN', () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(csvNum(v, 2), String(v)).toBe('');
    }
  });

  it('treats a missing value as a missing measurement', () => {
    expect(csvNum(null, 2)).toBe('');
    expect(csvNum(undefined, 2)).toBe('');
  });

  it('writes a real zero, which is not a missing measurement', () => {
    expect(csvNum(0, 2)).toBe('0.00');
    expect(csvNum(-0, 2)).toBe('0.00');
  });

  /** toFixed throws a RangeError outside 0..100. An export that throws
   *  half way leaves the user a truncated CSV that opens perfectly. */
  it('does not throw on a nonsense decimal count', () => {
    for (const dp of [-1, 101, 1e9, NaN, Infinity]) {
      expect(() => csvNum(1.5, dp), `dp ${dp}`).not.toThrow();
    }
    expect(csvNum(1.5, -1)).toBe('2');
    expect(csvNum(1.5, NaN)).toBe('2');
  });

  it('keeps large survey coordinates intact', () => {
    expect(csvNum(500123.4567, 3)).toBe('500123.457');
    expect(csvNum(6800234.5, 3)).toBe('6800234.500');
  });

  /** What it produces has to survive the reader beside it, or the file
   *  PointCloudLabeler writes is not one PointCloudLabeler can read back. */
  it('round-trips through the parser', () => {
    const cells = [csvNum(1.5, 2), csvNum(NaN, 2), csvNum(-3.25, 3)];
    const line = cells.map(csvField).join(',');
    expect(splitLine(line, ',')).toEqual(['1.50', '', '-3.250']);
  });
});

/** Every CSV exporter obeys one rule about unmeasurable values.
 *
 *  It used to be a private helper in one panel, with a comment stating
 *  the rule, and the guard was applied wherever its author happened to
 *  think of it: ThinningPanel guarded two of six fields in the same row,
 *  TreeGrowthPanel guarded the DBH delta and not the height delta beside
 *  it, and the panel that DEFINED the helper called .toFixed() directly
 *  in its main row type. Six private copies of the rule existed.
 *
 *  Nothing about a wrong cell looks wrong: the file opens, the column is
 *  there, and only the numbers are text. */
/** A CSV is a file somebody opens in Excel, and PointCloudLabeler's CSVs are full
 *  of characters that are not ASCII: m², m³, °, ±, the currency symbol,
 *  and whatever alphabet a species, plot or project name is written in.
 *
 *  Excel reads a .csv without a byte-order mark using the machine's
 *  ANSI codepage — Windows-1252 in western Europe, 1251 in Russia, 932
 *  in Japan — so every one of those arrived as mojibake outside a UTF-8
 *  locale. Eleven exporters each built their own
 *  `new Blob([rows.join('\n')], { type: 'text/csv' })` and not one of
 *  them said UTF-8 anywhere.
 *
 *  The same mark comes back the other way: a file saved by Excel as
 *  "CSV UTF-8" begins with U+FEFF, which is not whitespace and survives
 *  every trim, so it stayed glued to the first cell of the first line. */
describe('the byte-order mark, both directions', () => {
  const BOM = String.fromCharCode(0xfeff);

  it('writes one, so Excel reads the file as UTF-8', () => {
    const text = csvText(['tree_id,crown_area_m2', '1,12.3']);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1)).toBe('tree_id,crown_area_m2\n1,12.3');
    // …and the blob says so in its type as well, for anything that
    // reads the MIME rather than sniffing the bytes.
    expect(csvBlob(['a,b']).type).toBe('text/csv;charset=utf-8');
  });

  it('strips one on read, and leaves a file without one alone', () => {
    expect(stripBom(`${BOM}tree_id,dbh`)).toBe('tree_id,dbh');
    expect(stripBom('tree_id,dbh')).toBe('tree_id,dbh');
    expect(stripBom('')).toBe('');
    // Only the FIRST one, and only at the front — a U+FEFF anywhere
    // else is content, not an encoding marker.
    expect(stripBom(`${BOM}${BOM}x`)).toBe(`${BOM}x`);
    expect(stripBom(`x${BOM}y`)).toBe(`x${BOM}y`);
  });

  it('reads back a header a spreadsheet wrote', () => {
    // What Excel's "CSV UTF-8" actually produces.
    const p = parseCsv(`${BOM}tree_id;dbh_cm\n1;24,7\n2;31,2`);
    expect(p).not.toBeNull();
    // Without the strip this is "﻿tree_id", which matches no
    // column mapping — the id column simply is not found.
    expect(p!.headers[0]).toBe('tree_id');
    expect(p!.hasHeader).toBe(true);
    expect(p!.decimalComma).toBe(true);
    expect(p!.rows).toEqual([['1', '24,7'], ['2', '31,2']]);
  });

  it('does not mistake a headerless file for one with a header', () => {
    // The costly case. U+FEFF is a format character, not whitespace, so
    // parseFloat("﻿1") is NaN — the first row of data was read as
    // column names and the first tree vanished from the import.
    const p = parseCsv(`${BOM}1;24,7\n2;31,2`);
    expect(p!.hasHeader).toBe(false);
    expect(p!.rows).toHaveLength(2);
    expect(p!.rows[0]).toEqual(['1', '24,7']);
    // And it really is a number now.
    expect(parseNumber(p!.rows[0][0], p!.decimalComma)).toBe(1);
  });

  it('round-trips its own export', () => {
    const written = csvText(['tree_id,note', `1,${csvField('Männikkö, itäosa')}`]);
    const p = parseCsv(written)!;
    expect(p.headers).toEqual(['tree_id', 'note']);
    expect(p.rows[0]).toEqual(['1', 'Männikkö, itäosa']);
  });
});

describe('CSV exporters format numbers one way', () => {
  function* walk(dir: string): Generator<string> {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) yield* walk(p);
      else if (/\.tsx?$/.test(e) && !/\.test\./.test(e)) yield p;
    }
  }

  it('uses csvNum, not a raw toFixed, in every row builder', () => {
    const offenders: string[] = [];
    for (const file of walk('src')) {
      const lines = readFileSync(file, 'utf8').split('\n');
      const joins = lines
        .map((l, i) => (/\.join\(\s*['"],['"]/.test(l) ? i : -1))
        .filter(i => i >= 0);
      for (const j of joins) {
        // A row builder is the array literal above the join. Twenty-five
        // lines covers the longest of them (MetricsModule's).
        for (let i = Math.max(0, j - 25); i <= j; i++) {
          const l = lines[i];
          if (!l.includes('.toFixed(')) continue;
          // Drawing code can sit near an exporter and is not a row.
          if (/ctx\.|fillText|strokeText|`/.test(l)) continue;
          offenders.push(`${file}:${i + 1}: ${l.trim()}`);
        }
      }
    }
    expect(offenders, `raw toFixed in a CSV row:\n${offenders.join('\n')}`).toEqual([]);
  });

  /** The defect was not one exporter getting the encoding wrong. It was
   *  eleven of them each spelling the same Blob by hand, so there was
   *  no one place where UTF-8 could be said. This is the rule that
   *  stops the twelfth. */
  it('builds every CSV through csvBlob / csvText, never a raw Blob', () => {
    // Split so this line is not its own counterexample.
    const rawCsvBlob = new RegExp(`new Blob\\(\\[[^\\]]*\\], \\{ type: ['"]text/${'csv'}`);
    // csv.ts is where the blob is BUILT, once, with the mark on it —
    // exactly one file may do this and this is it. That its own blob
    // carries the mark is asserted above, not scanned for here.
    const hits = scanSources('src', rawCsvBlob, f => f.endsWith(join('io', 'csv.ts')));
    expect(
      hits,
      `a CSV built without the byte-order mark:\n${describeHits(hits)}`,
    ).toEqual([]);
  });
});

/** RFC 4180 quoting does not stop a formula: the parser strips the
 *  quotes before the cell is interpreted, so `"=1+1"` still evaluates.
 *  This matters because ValidationPanel writes the `field_id` of every
 *  tree straight out of the field-measurement CSV the user imported,
 *  and those files are exchanged between institutions. Import one,
 *  export the comparison, send the comparison to a co-author, and it
 *  runs on their machine. */
describe('a text cell cannot smuggle a formula into a spreadsheet', () => {
  it('marks what a spreadsheet would evaluate', () => {
    for (const evil of ['=1+1', '=HYPERLINK("http://x")', '@SUM(A1)', '-1+1', '+1+1',
                        '\tstart-with-tab', '\rstart-with-cr']) {
      expect(needsFormulaGuard(evil), `${JSON.stringify(evil)} not marked`).toBe(true);
      // The guarded cell no longer STARTS with the trigger, which is
      // the only thing that makes a spreadsheet evaluate it.
      const written = csvField(evil);
      const cell = written.startsWith('"') ? written.slice(1, -1).replace(/""/g, '"') : written;
      expect(cell.startsWith("'")).toBe(true);
      expect(/^[=@\t\r]/.test(cell)).toBe(false);
    }
  });

  it('leaves a signed number alone — a plot id of -3 is a plot id', () => {
    for (const fine of ['-42', '+42', '-3.5', '+0.5', '-3.5e2', '42', '', 'plain',
                        'Pinus sylvestris', "'99 inventory"]) {
      expect(needsFormulaGuard(fine), `${JSON.stringify(fine)} wrongly marked`).toBe(false);
      expect(csvField(fine)).toBe(
        /[",\n\r;\t]/.test(fine) ? `"${fine.replace(/"/g, '""')}"` : fine);
    }
  });

  it('is exactly reversible, and reverses nothing else', () => {
    // Exact inverse on what it guards.
    for (const evil of ['=1+1', '@SUM(A1)', '-1+1', '\tx']) {
      expect(csvUnguard(csvField(evil).replace(/^"|"$/g, ''))).toBe(evil);
    }
    // A value that merely begins with an apostrophe is untouched — the
    // guard would never have produced it, so unguarding must not eat it.
    expect(csvUnguard("'99 inventory")).toBe("'99 inventory");
    expect(csvUnguard("'plain")).toBe("'plain");
    expect(csvUnguard('plain')).toBe('plain');
    expect(csvUnguard('')).toBe('');
  });

  /** The path that made this reachable, end to end: an imported field id
   *  goes out through csvField and comes back through the importer. */
  it('survives PointCloudLabeler exporting and re-importing its own file', () => {
    const imported = '=cmd|\' /C calc\'!A0';
    const line = [csvField(imported), '1.0', '2.0'].join(',');
    const [backAgain] = splitLine(line, ',').map(csvUnguard);
    expect(backAgain).toBe(imported);
  });
});
