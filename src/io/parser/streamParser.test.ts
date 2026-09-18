import { describe, it, expect } from 'vitest';
import type { HeaderInfo } from './headerDetect';
import { TxtStreamParser, unpackExtras, type ParsedCloudData } from './streamParser';
import { detectColumns, splitCells } from './headerDetect';

/** The one definition the header detector and the row parser share. */
describe('splitCells', () => {
  it('space collapses runs — an aligned ASCII dump', () => {
    expect(splitCells('  1.0   2.0   3.0  ', ' ')).toEqual(['1.0', '2.0', '3.0']);
  });

  it('tab and comma keep an empty cell', () => {
    expect(splitCells('1\t2\t\t4', '\t')).toEqual(['1', '2', '', '4']);
    expect(splitCells('1,2,,4', ',')).toEqual(['1', '2', '', '4']);
  });

  it('keeps a leading and a trailing empty cell', () => {
    expect(splitCells('\t1\t', '\t')).toEqual(['', '1', '']);
    expect(splitCells(',1,', ',')).toEqual(['', '1', '']);
  });

  it('a single cell is one cell', () => {
    expect(splitCells('1', '\t')).toEqual(['1']);
    expect(splitCells('', ',')).toEqual(['']);
  });
});

const SEG = 1 << 20;

function hi(over: Partial<HeaderInfo> = {}): HeaderInfo {
  return {
    header: ['x', 'y', 'z', 'tree_id'],
    sep: ' ', ix: 0, iy: 1, iz: 2, iId: 3,
    extraIdx: [], extraNames: [],
    hadHeader: false, headerBytes: 0,
    ...over,
  };
}

const enc = new TextEncoder();

/** Feed `text` to a parser in the given byte-sized pieces. The default
 *  is one piece — sized in BYTES, not chars, or a multibyte character
 *  would leave the tail of the file unfed. */
function parse(text: string, info: HeaderInfo, chunks: number[] = [Infinity]): ParsedCloudData {
  const p = new TxtStreamParser(info);
  const bytes = enc.encode(text);
  let off = 0;
  for (let i = 0; i < chunks.length; i++) {
    const end = Math.min(off + chunks[i], bytes.length);
    p.processChunk(bytes.subarray(off, end), i === chunks.length - 1 && end >= bytes.length);
    off = end;
  }
  return p.finish();
}

describe('TxtStreamParser', () => {
  it('parses rows, subtracting the first point as the origin', () => {
    const d = parse('100.5 200.25 30.125 7\n101.5 201.25 31.125 8\n', hi());
    expect(d.count).toBe(2);
    expect(d.origin).toEqual({ x: 100.5, y: 200.25, z: 30.125 });
    // Origin-relative, and mapped survey → scene: (east, north, up)
    // becomes (east, up, −north). The negation is what makes it a
    // rotation rather than a mirror — see io/sceneAxes.
    expect([...d.positions.slice(0, 3)]).toEqual([0, 0, -0]);
    expect([...d.positions.slice(3, 6)]).toEqual([1, 1, -1]);
    expect([...d.treeIds]).toEqual([7, 8]);
  });

  it('parses the last line without a trailing newline', () => {
    const d = parse('1 2 3 1\n4 5 6 2', hi());
    expect(d.count).toBe(2);
    expect(d.treeIds[1]).toBe(2);
  });

  /** The parser sees the file in arbitrary byte-sized pieces. Where the
   *  pieces fall must not change what is read. */
  describe('chunk boundaries', () => {
    const text = '100.5 200.25 30.125 7\n101.5 201.25 31.125 8\n102.5 202.25 32.125 9\n';

    it('mid-number, mid-line, every few bytes — same result', () => {
      const whole = parse(text, hi());
      for (const size of [1, 3, 7, 10, 23]) {
        const n = Math.ceil(enc.encode(text).length / size);
        const pieces = parse(text, hi(), new Array(n).fill(size));
        expect(pieces.count, `chunk size ${size}`).toBe(whole.count);
        expect([...pieces.positions], `chunk size ${size}`).toEqual([...whole.positions]);
        expect([...pieces.treeIds], `chunk size ${size}`).toEqual([...whole.treeIds]);
      }
    });

    it('CRLF split across two chunks drops no row', () => {
      const crlf = '1 2 3 1\r\n4 5 6 2\r\n';
      // Split exactly between the \r and the \n of the first line.
      const at = crlf.indexOf('\r') + 1;
      const d = parse(crlf, hi(), [at, crlf.length - at]);
      expect(d.count).toBe(2);
      expect([...d.treeIds]).toEqual([1, 2]);
    });

    it('a multi-byte UTF-8 character split across chunks survives', () => {
      const info = hi({ header: ['x', 'y', 'z', 'tree_id', 'species'], extraIdx: [4], extraNames: ['species'] });
      const text = '1 2 3 1 mänty\n4 5 6 2 kuusi\n';
      const bytes = enc.encode(text);
      // 'ä' is two bytes; find its first byte and split inside it.
      const at = text.indexOf('ä') + 1;   // byte offset of ä's second byte ('m' is 1 byte)
      const d = new TxtStreamParser(info);
      d.processChunk(bytes.subarray(0, at), false);
      d.processChunk(bytes.subarray(at), true);
      const out = d.finish();
      expect(out.count).toBe(2);
      expect((out.extraCols.species as string[])[0]).toBe('mänty');
    });
  });

  describe('cell rules per delimiter', () => {
    /** The defect: /\t+/ collapsed adjacent tabs, so in
     *  `1\t2\t3\t\tpine` the empty tree_id cell vanished and `pine`
     *  slid left into its place — parseInt('pine') || 0 = 0, species
     *  read '' — a silent per-row column shift, on exactly the rows
     *  with missing data. */
    it('tab: an empty cell stays a cell, columns stay aligned', () => {
      const info = hi({
        header: ['x', 'y', 'z', 'tree_id', 'species'], sep: '\t',
        extraIdx: [4], extraNames: ['species'],
      });
      const d = parse('1\t2\t3\t7\tpine\n1\t2\t4\t\tspruce\n', info);
      expect(d.count).toBe(2);
      expect([...d.treeIds]).toEqual([7, 0]);          // empty id = unassigned
      expect(d.extraCols.species as string[]).toEqual(['pine', 'spruce']);
    });

    it('tab: an empty coordinate skips the row instead of shifting it', () => {
      const info = hi({ sep: '\t' });
      const d = parse('1\t2\t3\t7\n5\t\t6\t8\n2\t2\t2\t9\n', info);
      expect(d.count).toBe(2);
      expect([...d.treeIds]).toEqual([7, 9]);
    });

    it('comma: same rule', () => {
      const info = hi({
        header: ['x', 'y', 'z', 'tree_id', 'species'], sep: ',',
        extraIdx: [4], extraNames: ['species'],
      });
      const d = parse('1,2,3,7,pine\n1,2,4,,spruce\n', info);
      expect([...d.treeIds]).toEqual([7, 0]);
      expect(d.extraCols.species as string[]).toEqual(['pine', 'spruce']);
    });

    it('space: runs of spaces collapse — aligned ASCII dumps', () => {
      const d = parse('  1.0   2.0   3.0   7\n  4.0   5.0   6.0   8\n', hi());
      expect(d.count).toBe(2);
      expect([...d.treeIds]).toEqual([7, 8]);
    });
  });

  it('skips a row whose coordinates do not parse', () => {
    const d = parse('1 2 3 1\nnot a row at all\n4 5 6 2\n', hi());
    expect(d.count).toBe(2);
  });

  it('tolerates missing trailing extras, keeping the coordinates', () => {
    const info = hi({ header: ['x', 'y', 'z', 'tree_id', 'species'], extraIdx: [4], extraNames: ['species'] });
    const d = parse('1 2 3 7 pine\n4 5 6 8\n', info);
    expect(d.count).toBe(2);
    expect(d.extraCols.species as string[]).toEqual(['pine', '']);
  });

  it('a missing tree_id column reads every id as unassigned', () => {
    const d = parse('1 2 3\n4 5 6\n', hi({ header: ['x', 'y', 'z'], iId: -1 }));
    expect([...d.treeIds]).toEqual([0, 0]);
  });

  describe('coordinate precision probe', () => {
    it('takes the mode of the first rows, not the max', () => {
      // 99 rows at 2 decimals, one outlier at 7 — the outlier must not
      // pad every exported coordinate with five trailing zeros.
      const rows = Array.from({ length: 99 }, (_, i) => `${i}.25 2.25 3.25 1`);
      rows.push('1.2500001 2.2500001 3.2500001 1');
      expect(parse(rows.join('\n') + '\n', hi()).coordDecimals).toBe(2);
    });

    it('falls back to 3 (1 mm) for integer coordinates', () => {
      expect(parse('1 2 3 1\n4 5 6 2\n', hi()).coordDecimals).toBe(3);
    });

    it('reads mixed rows by their per-row max', () => {
      const rows = Array.from({ length: 10 }, () => '1.123 2.1 3 1');
      expect(parse(rows.join('\n') + '\n', hi()).coordDecimals).toBe(3);
    });
  });

  /** The parser buffers into 1 M-row segments and stitches them back in
   *  finish(). The stitch is only visibly wrong at the boundary. */
  it('stitches rows across the segment boundary', () => {
    const n = SEG + 3;
    const lines = new Array<string>(n);
    for (let i = 0; i < n; i++) lines[i] = `${i} 0 0 ${i}`;
    const d = parse(lines.join('\n') + '\n', hi());
    expect(d.count).toBe(n);
    // First, the two rows either side of the boundary, and the last.
    expect(d.treeIds[0]).toBe(0);
    expect(d.treeIds[SEG - 1]).toBe(SEG - 1);
    expect(d.treeIds[SEG]).toBe(SEG);
    expect(d.treeIds[n - 1]).toBe(n - 1);
    expect(d.positions[(SEG - 1) * 3]).toBe(SEG - 1);
    expect(d.positions[SEG * 3]).toBe(SEG);
  });

  /** finishPacked() is the worker-transfer twin of finish(). Two
   *  encodings of the same parse, and nothing compared them. */
  it('finishPacked carries exactly what finish() carries', () => {
    const info = hi({
      header: ['x', 'y', 'z', 'tree_id', 'species', 'note'], sep: ',',
      extraIdx: [4, 5], extraNames: ['species', 'note'],
    });
    const text = '1,2,3,7,mänty,ok\n4,5,6,8,,\n7,8,9,9,kuusi,fine\n';
    const a = parse(text, info);

    const p = new TxtStreamParser(info);
    p.processChunk(enc.encode(text), true);
    const { result } = p.finishPacked();

    expect(result.count).toBe(a.count);
    expect([...result.positions]).toEqual([...a.positions]);
    expect([...result.treeIds]).toEqual([...a.treeIds]);
    expect(result.origin).toEqual(a.origin);
    expect(result.coordDecimals).toBe(a.coordDecimals);
    const unpacked = unpackExtras(result.packedExtras, result.count);
    expect(unpacked.species).toEqual(a.extraCols.species);
    expect(unpacked.note).toEqual(a.extraCols.note);
  });

  it('an empty file parses to an empty cloud', () => {
    const d = parse('', hi());
    expect(d.count).toBe(0);
    expect(d.origin).toEqual({ x: 0, y: 0, z: 0 });
    expect(d.positions.length).toBe(0);
  });
});

describe('detectColumns', () => {
  function fileOf(text: string) {
    const bytes = enc.encode(text);
    return {
      size: bytes.length,
      slice: (s: number, e: number) => ({
        arrayBuffer: async () => bytes.slice(s, e).buffer as ArrayBuffer,
      }),
    };
  }

  it('reads a named header and finds the roles', async () => {
    const h = await detectColumns(fileOf('X,Y,Z,tree_id,intensity\n1,2,3,4,5\n'));
    expect(h.sep).toBe(',');
    expect(h.hadHeader ?? true).toBe(true);
    expect([h.ix, h.iy, h.iz, h.iId]).toEqual([0, 1, 2, 3]);
    expect(h.extraNames).toEqual(['intensity']);
  });

  it('synthesizes x/y/z/tree_id for a headerless numeric file', async () => {
    const h = await detectColumns(fileOf('1.5 2.5 3.5 7\n4 5 6 8\n'));
    expect(h.header.slice(0, 4)).toEqual(['x', 'y', 'z', 'tree_id']);
    expect(h.headerBytes).toBe(0);   // nothing to skip
  });

  it('accepts h as the height/z column', async () => {
    const h = await detectColumns(fileOf('x,y,h\n1,2,3\n'));
    expect(h.iz).toBe(2);
  });

  it('accepts the id aliases the segmentation tools write', async () => {
    for (const name of ['treeid', 'instance_pred', 'instance_id', 'id']) {
      const h = await detectColumns(fileOf(`x,y,z,${name}\n1,2,3,4\n`));
      expect(h.iId, name).toBe(3);
    }
  });

  it('strips a comment prefix off the header line', async () => {
    const h = await detectColumns(fileOf('// x y z\n1 2 3\n'));
    expect([h.ix, h.iy, h.iz]).toEqual([0, 1, 2]);
  });

  it('prefers comma over tab when both appear', async () => {
    const h = await detectColumns(fileOf('x,y,z\tnote\n'));
    expect(h.sep).toBe(',');
  });

  it('headerBytes covers exactly the header line and its newline', async () => {
    const text = 'x,y,z\n1,2,3\n';
    const h = await detectColumns(fileOf(text));
    expect(h.headerBytes).toBe(enc.encode('x,y,z\n').length);
  });

  it('splits a tab header one-for-one, like the rows', async () => {
    const h = await detectColumns(fileOf('x\ty\tz\ttree_id\n1\t2\t3\t4\n'));
    expect(h.sep).toBe('\t');
    expect(h.header).toEqual(['x', 'y', 'z', 'tree_id']);
    expect([h.ix, h.iy, h.iz, h.iId]).toEqual([0, 1, 2, 3]);
  });

  /** The header and the data rows must count columns the same way.
   *  headerDetect split the header on /\t+/ and TxtStreamParser split
   *  the rows on the same, but the two disagreed the moment a file had
   *  a BLANK header cell: `x\ty\tz\t\tspecies` collapsed to four names,
   *  so `species` was recorded at index 3 — which in every data row is
   *  the blank column. The extra column then read empty for the whole
   *  file, and nothing said so. */
  it('keeps a blank header cell, so the names line up with the rows', async () => {
    const h = await detectColumns(fileOf('x\ty\tz\t\tspecies\n1\t2\t3\t\tpine\n'));
    expect(h.header).toEqual(['x', 'y', 'z', '', 'species']);
    expect(h.extraNames).toEqual(['', 'species']);
    // The index recorded for 'species' is the index it occupies in a row.
    const speciesIdx = h.extraIdx[h.extraNames.indexOf('species')];
    expect(speciesIdx).toBe(4);
    expect('1\t2\t3\t\tpine'.split(/\t/)[speciesIdx]).toBe('pine');
  });

  /** End to end: detect the header, then parse a row with the same
   *  blank cell, and the species must arrive as 'pine'. */
  it('reads the extra column the header named, blank cell and all', async () => {
    const text = 'x\ty\tz\t\tspecies\n1\t2\t3\t\tpine\n4\t5\t6\t\tspruce\n';
    const h = await detectColumns(fileOf(text));
    const p = new TxtStreamParser(h);
    const bytes = enc.encode(text);
    p.processChunk(bytes.subarray(h.headerBytes), true);
    const d = p.finish();
    expect(d.count).toBe(2);
    expect(d.extraCols.species as string[]).toEqual(['pine', 'spruce']);
  });
});
