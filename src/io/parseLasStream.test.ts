import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

// parseLasStream imports the wasm through Vite's `?url` query, which
// resolves to a web path. Under vitest the node build of laz-perf tries
// to OPEN that path on disk, so point it at the real file instead.
vi.mock('laz-perf/lib/web/laz-perf.wasm?url', () => ({
  default: join(process.cwd(), 'node_modules/laz-perf/lib/web/laz-perf.wasm'),
}));
import { readFileSync } from 'node:fs';
import { unsupportedLasFields, parseLasStream } from './parseLasStream';
import { buildLas, fileLikeOf, type LasPoint } from './lasFixture';

/** Which standard LAS fields the octree cannot carry, per point format.
 *
 *  This is disclosure, not capability: PointCloudLabeler stores XYZ, intensity,
 *  classification and return number, and nothing else. Naming what IS
 *  read never told anyone their colourised MLS delivery would arrive
 *  grey — and they only found out after the import. */
describe('unsupportedLasFields', () => {
  it('names colour for every format that carries it', () => {
    for (const fmt of [2, 3, 5, 7, 8, 10]) {
      expect(unsupportedLasFields(fmt), `format ${fmt} has RGB`).toContain('colour (RGB)');
    }
    for (const fmt of [0, 1, 4, 6, 9]) {
      expect(unsupportedLasFields(fmt), `format ${fmt} has no RGB`).not.toContain('colour (RGB)');
    }
  });

  it('names GPS time for every format that carries it', () => {
    for (const fmt of [1, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(unsupportedLasFields(fmt), `format ${fmt} has GPS time`).toContain('GPS time');
    }
    // Format 0 and 2 are the only ones without it.
    expect(unsupportedLasFields(0)).not.toContain('GPS time');
    expect(unsupportedLasFields(2)).not.toContain('GPS time');
  });

  it('names near-infrared and waveform only where they exist', () => {
    expect(unsupportedLasFields(8)).toContain('near-infrared');
    expect(unsupportedLasFields(3)).not.toContain('near-infrared');
    expect(unsupportedLasFields(4)).toContain('waveform data');
    expect(unsupportedLasFields(6)).not.toContain('waveform data');
  });

  /** Every format has these; they are simply never stored. */
  it('always names the fields no format survives', () => {
    for (const fmt of [0, 1, 2, 3, 6, 7]) {
      const f = unsupportedLasFields(fmt);
      expect(f).toContain('scan angle');
      expect(f).toContain('user data');
      expect(f).toContain('point source ID');
    }
  });

  /** An unreadable header must produce silence, not a guess about what
   *  the file contains. */
  it('says nothing when the format is unknown', () => {
    expect(unsupportedLasFields(null)).toEqual([]);
  });
});

/** The warning is only useful if it reaches the screen, and it depends
 *  on a chain: sniffer → EditorModule state → PendingImport → dialog
 *  prop → render. A break anywhere leaves the dialog defaulting to
 *  "nothing dropped" and saying nothing at all — which is exactly the
 *  silent loss being fixed, restored by a missing line.
 *
 *  That is not hypothetical: the prop was left unwired on the first
 *  attempt at this, and tsc was silent because the dialog gives it a
 *  default. */
describe('the dropped-field warning actually reaches the dialog', () => {
  const editorModule = readFileSync('src/modules/EditorModule.tsx', 'utf8');
  const dialog = readFileSync('src/components/ImportMappingDialog.tsx', 'utf8');

  it('the import sniffs the point format', () => {
    expect(editorModule).toContain('detectLasSource');
    expect(editorModule, 'the sniffed format must be stored').toMatch(/pointFormat\s*=\s*info\.pointFormat/);
  });

  it('the format is carried on the pending import and passed to the dialog', () => {
    expect(editorModule, 'PendingImport must carry it').toMatch(/pointFormat,/);
    expect(editorModule, 'and the dialog must receive it').toContain('pointFormat={pendingImport.pointFormat}');
  });

  it('the dialog computes and renders the dropped list', () => {
    expect(dialog).toContain('unsupportedLasFields');
    expect(dialog, 'a computed list that is never rendered warns nobody').toMatch(/dropped\.length > 0/);
  });
});

/** The LAS point decoder, exercised against a real LAS 1.2 file built in
 *  memory (see lasFixture). This is the only way to pin the ARGUMENT
 *  ORDER of its scene-axis mapping: writeScenePosition takes (east,
 *  north, up), and handing it (east, up, north) compiles, runs, and
 *  silently produces a cloud with height and northing exchanged.
 *
 *  Everything else here already had tests reading the LAS header; the
 *  points themselves had none. */
describe('parseLasStream point decoding', () => {
  const SCALE: [number, number, number] = [0.001, 0.001, 0.001];
  const OFFSET: [number, number, number] = [500000, 6700000, 100];

  async function parse(points: LasPoint[], opts?: { scale?: [number, number, number]; offset?: [number, number, number] }) {
    return parseLasStream(fileLikeOf(buildLas(points, { scale: SCALE, offset: OFFSET, ...opts })));
  }

  it('dequantises with the header scale and offset', async () => {
    const c = await parse([
      { xi: 0, yi: 0, zi: 0 },
      { xi: 1000, yi: 2000, zi: 3000 },
    ]);
    expect(c.count).toBe(2);
    // Positions are relative to the first point.
    expect(c.positions[0]).toBeCloseTo(0, 5);
    expect(c.positions[3]).toBeCloseTo(1, 5);    // +1 m east
  });

  /** Survey (east, north, up) → scene (east, up, −north). The negation
   *  is what makes it a rotation rather than a mirror — io/sceneAxes. */
  it('maps survey axes to scene axes, negating north', async () => {
    const c = await parse([
      { xi: 0, yi: 0, zi: 0 },          // origin
      { xi: 1000, yi: 0, zi: 0 },       // 1 m east
      { xi: 0, yi: 1000, zi: 0 },       // 1 m north
      { xi: 0, yi: 0, zi: 1000 },       // 1 m up
    ]);
    const expected = [
      0, 0, 0,
      1, 0, 0,     // east  → +X
      0, 0, -1,    // north → −Z
      0, 1, 0,     // up    → +Y
    ];
    for (let k = 0; k < expected.length; k++) {
      expect(c.positions[k], `component ${k}`).toBeCloseTo(expected[k], 5);
    }
  });

  it('carries intensity, classification and return number', async () => {
    const c = await parse([
      { xi: 0, yi: 0, zi: 0, intensity: 4711, classification: 2, returnNumber: 1 },
      { xi: 0, yi: 0, zi: 0, intensity: 65535, classification: 5, returnNumber: 3 },
    ]);
    const intensity = c.extraCols.intensity as Uint16Array;
    const cls = c.extraCols.classification as Uint8Array;
    const ret = c.extraCols.return_number as Uint8Array;
    expect([...intensity]).toEqual([4711, 65535]);
    expect([...cls]).toEqual([2, 5]);
    expect([...ret]).toEqual([1, 3]);
  });

  it('takes the origin from the first point', async () => {
    const c = await parse([{ xi: 5000, yi: 7000, zi: 9000 }]);
    expect(c.origin.x).toBeCloseTo(5000 * SCALE[0] + OFFSET[0], 6);
    expect(c.origin.y).toBeCloseTo(7000 * SCALE[1] + OFFSET[1], 6);
    expect(c.origin.z).toBeCloseTo(9000 * SCALE[2] + OFFSET[2], 6);
  });

  it('honours a non-uniform scale', async () => {
    const c = await parse(
      [{ xi: 0, yi: 0, zi: 0 }, { xi: 100, yi: 100, zi: 100 }],
      { scale: [0.01, 0.001, 0.0001] },
    );
    expect(c.positions[3]).toBeCloseTo(1, 5);      // east  100 × 0.01
    expect(c.positions[4]).toBeCloseTo(0.01, 5);   // up    100 × 0.0001
    expect(c.positions[5]).toBeCloseTo(-0.1, 5);   // north 100 × 0.001, negated
  });

  it('rejects a file without the LASF magic', async () => {
    const bad = buildLas([{ xi: 0, yi: 0, zi: 0 }]);
    bad[0] = 0x58;
    await expect(parseLasStream(fileLikeOf(bad))).rejects.toThrow();
  });
});
