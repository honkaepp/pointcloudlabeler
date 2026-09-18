import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extensionOf, filtersFor, saveCsvFileWith, saveTextFileWith, saveBytesFileWith, type SaveBridge } from './saveDownload';
import { UTF8_BOM } from './csv';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

/** THE EXPORT BUTTONS DID NOTHING. Fourteen of them built a Blob, made
 *  an object URL and clicked a synthetic `<a download>` — how a web page
 *  saves a file, and this is not a web page. WebView2 does not handle a
 *  download navigation: no dialog, no file, no error. The QC panel's CSV
 *  button was the one reported; every other export was equally dead.
 *  A save goes through the native dialog and the Rust writer now. */
describe('saving a file a panel exports', () => {
  function fake() {
    const calls = { dialog: [] as string[], written: [] as [string, string][], bytes: [] as [string, number][] };
    const bridge: SaveBridge = {
      saveCsvDialog: (n) => { calls.dialog.push(`csv:${n}`); return Promise.resolve(`C:/out/${n}`); },
      saveExportDialog: (n, f) => { calls.dialog.push(`${f[0].extensions.join('|')}:${n}`); return Promise.resolve(`C:/out/${n}`); },
      writeFile: (p, c) => { calls.written.push([p, c]); return Promise.resolve(true); },
      writeFileBytes: (p, b) => { calls.bytes.push([p, b.length]); return Promise.resolve(true); },
    };
    return { bridge, calls };
  }

  it('writes the CSV the dialog names, with the BOM Excel needs', async () => {
    const { bridge, calls } = fake();
    const path = await saveCsvFileWith(bridge, ['tree_id,check', '36,crown-small'], 'qc-flags.csv');
    expect(path).toBe('C:/out/qc-flags.csv');
    expect(calls.dialog).toEqual(['csv:qc-flags.csv']);
    expect(calls.written).toEqual([['C:/out/qc-flags.csv', `${UTF8_BOM}tree_id,check\n36,crown-small`]]);
  });

  it('writes nothing when the user cancels', async () => {
    const { bridge, calls } = fake();
    bridge.saveCsvDialog = () => Promise.resolve(null);
    expect(await saveCsvFileWith(bridge, ['a'], 'x.csv')).toBeNull();
    expect(calls.written).toEqual([]);
  });

  it('offers the dropdown the file name asks for, and saves bytes too', async () => {
    const { bridge, calls } = fake();
    expect(extensionOf('rescan-positions.gpx')).toBe('gpx');
    expect(extensionOf('noextension')).toBe('');
    expect(extensionOf('.hidden')).toBe('');
    expect(filtersFor('a.gpx')).toEqual([{ name: 'GPX track / waypoints', extensions: ['gpx'] }]);
    expect(filtersFor('a.dat')).toEqual([{ name: 'DAT file', extensions: ['dat'] }]);
    expect(filtersFor('plain')).toEqual([{ name: 'All files', extensions: ['*'] }]);
    await saveTextFileWith(bridge, '<html>', 'plot-report.html');
    expect(calls.dialog).toEqual(['html:plot-report.html']);
    expect(calls.written[0][0]).toBe('C:/out/plot-report.html');
    await saveBytesFileWith(bridge, new Uint8Array([1, 2, 3]), 'panorama.png');
    expect(calls.bytes).toEqual([['C:/out/panorama.png', 3]]);
  });

  it('keeps the browser download for a build with no bridge, and nothing else', () => {
    const src = read('src/io/saveDownload.ts');
    expect(src, 'the object-URL path is gone, so a browser build cannot save at all')
      .toMatch(/function downloadBlob\(/);
    expect(src, 'a download is attempted with a bridge present')
      .toMatch(/if \(d\?\.writeFile\) \{[\s\S]{0,300}?\}\s*downloadBlob\(/);
  });

  it('no panel clicks a synthetic download any more', () => {
    const dirs = ['src/components/shell', 'src/components/preprocessing', 'src/modules', 'src/components'];
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const f of readdirSync(new URL(`../../${dir}/`, import.meta.url))) {
        if (!f.endsWith('.tsx')) continue;
        const rel = join(dir, f);
        if (/a\.download\s*=/.test(read(rel))) offenders.push(rel);
      }
    }
    expect(offenders, 'a panel still saves through a download the desktop build ignores').toEqual([]);
  });
});
