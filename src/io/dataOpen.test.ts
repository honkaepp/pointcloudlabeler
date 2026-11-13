// The data door: what a file is (the same on both sides), where
// it goes, and that a drop, the menu and the buttons all reach it.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';
import {
  CLOUD_EXTENSIONS, OPEN_DATA_FILTERS, kindOfName, parentDir, plainPath, planOpen, projectNameFor,
  type DataEntry, type DataKind,
} from './dataOpen';
import { NOTICE_MS, dismissNotice, getNotices, pushNotice, resetNotices, updateNotice } from '../state/notices';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const RUST = stripComments(read('../../src-tauri/src/commands/dataopen.rs'));

const e = (name: string, kind: DataKind, extra: Partial<DataEntry> = {}): DataEntry =>
  ({ path: `C:/data/${name}`, name, isDir: false, size: 1, kind, contents: [], ...extra });

describe('what a file is', () => {
  it('is decided the same way on both sides', () => {
    const arms = [...RUST.matchAll(/^\s*((?:"\w+"\s*\|?\s*)+)=>\s*"(\w+)",/gm)];
    expect(arms.length).toBeGreaterThanOrEqual(3);
    for (const [, exts, kind] of arms) {
      for (const ext of [...exts.matchAll(/"(\w+)"/g)].map((m) => m[1])) {
        expect(kindOfName(`x.${ext}`), ext).toBe(kind);
      }
    }
    expect(kindOfName('x.docx')).toBe('unknown');
    expect(kindOfName('README')).toBe('unknown');
  });
  it('the open dialog offers every kind, and the clouds the editor reads', () => {
    const all = OPEN_DATA_FILTERS[0].extensions;
    for (const ext of [...CLOUD_EXTENSIONS, 'zip', 'ptx']) expect(all).toContain(ext);
    const pointFile = read('./pointFile.ts');
    for (const ext of ['txt', 'xyz', 'csv', 'asc', 'pts', 'tsv', 'dat']) {
      expect(pointFile).toContain(`'${ext}'`);
      expect(CLOUD_EXTENSIONS).toContain(ext);
    }
  });
});

describe('where it goes', () => {
  it('a project is opened before anything else', () => {
    const p = planOpen([e('a.laz', 'cloud'), e('plot', 'project', { isDir: true })]);
    expect(p).toMatchObject({ action: 'openProject', folder: 'C:/data/plot', ignored: ['a.laz'] });
  });
  it('one PTX at a time, after the clouds', () => {
    expect(planOpen([e('a.ptx', 'ptx'), e('b.ptx', 'ptx')])).toMatchObject({ action: 'ptx', ignored: ['b.ptx'] });
    expect(planOpen([e('a.ptx', 'ptx'), e('c.laz', 'cloud')])).toMatchObject({ action: 'importClouds', ignored: ['a.ptx'] });
  });
  it('clouds all come in, one after another', () => {
    const p = planOpen([e('a.laz', 'cloud'), e('b.las', 'cloud'), e('notes.docx', 'unknown')]);
    expect(p.action).toBe('importClouds');
    if (p.action === 'importClouds') expect(p.entries.map((x) => x.name)).toEqual(['a.laz', 'b.las']);
    expect(p.ignored).toEqual(['notes.docx']);
  });
  it('a folder counts as what it holds', () => {
    const tiles = e('tiles', 'folder', { isDir: true, contents: [e('t1.laz', 'cloud'), e('t2.laz', 'cloud')] });
    expect(planOpen([tiles])).toMatchObject({ action: 'importClouds' });
    expect(planOpen([e('empty', 'folder', { isDir: true })])).toEqual({ action: 'nothing', ignored: ['empty'] });
  });
  it('an archive is unpacked with all its clouds', () => {
    const clouds = e('tiles.zip', 'archive', { contents: [{ ...e('a.laz', 'cloud'), path: 'a.laz' }, { ...e('b.laz', 'cloud'), path: 'b/b.laz' }] });
    expect(planOpen([clouds])).toMatchObject({ action: 'extract', only: ['a.laz', 'b/b.laz'] });
    expect(planOpen([e('docs.zip', 'archive')]).action).toBe('nothing');
  });
  it('nothing that opens is said so', () => {
    expect(planOpen([e('a.docx', 'unknown')])).toEqual({ action: 'nothing', ignored: ['a.docx'] });
  });
});

describe('a project made for the data', () => {
  it('is named after it', () => {
    expect(projectNameFor(e('tiles 2026', 'folder', { isDir: true }))).toBe('tiles 2026');
    expect(projectNameFor({ ...e('project.ptx', 'ptx'), path: 'C:/scans/Plot 1041/project.ptx' })).toBe('Plot 1041');
    expect(projectNameFor(e('plot 1001.laz', 'cloud'))).toBe('plot 1001');
    expect(parentDir('C:\\data\\plot.laz')).toBe('C:\\data');
  });
  it('is not placed under a verbatim path, which a "/" join breaks', () => {
    expect(plainPath('\\\\?\\C:\\data\\Plot - 2026-10-20T07_58_18Z\\output')).toBe('C:\\data\\Plot - 2026-10-20T07_58_18Z\\output');
    expect(plainPath('\\\\?\\UNC\\server\\share\\plots')).toBe('\\\\server\\share\\plots');
    expect(plainPath('C:\\data')).toBe('C:\\data');
    expect(plainPath('C:/data')).toBe('C:/data');
    expect(plainPath('')).toBe('');
    expect(read('../components/NewProjectDialog.tsx')).toContain('plainPath(initialParent ?? remembered(LAST_PARENT_KEY))');
    expect(read('../components/DataDoor.tsx')).toContain("plainPath(localStorage.getItem(LAST_PARENT_KEY) ?? '')");
  });
});

describe('the door is reachable from everywhere', () => {
  it('a drop is granted and classified by the Rust side, then routed', () => {
    const lib = stripComments(read('../../src-tauri/src/lib.rs'));
    expect(lib).toContain('.on_webview_event(commands::dataopen::on_webview_event)');
    expect(lib).toMatch(/commands::dataopen::data_classify,/);
    expect(lib).toMatch(/commands::dataopen::data_extract,/);
    expect(RUST).toContain('state.grants.grant_dir(p);');
    expect(RUST).toContain('state.grants.grant_file(p);');
    const bridge = read('../persistence/desktopBridge.ts');
    expect(bridge).toContain("ctx.listen<unknown>('data-drop'");
    expect(bridge, 'the old drop forwarding, which nothing handled').not.toContain("cb('menu:open-file'");
  });
  it('App mounts the door with and without a project; the menu and the editor open it', () => {
    const app = read('../App.tsx');
    expect(app).toContain('<DataDoor project={project} onProject={setProject} onModule={setActiveModule} />');
    // and in the second window (commands/compare_window.rs).
    expect(app.match(/\{door\}/g)?.length).toBe(3);
    expect(read('../../src-tauri/src/menu.rs')).toContain('MenuItemBuilder::new("Open Data…").id("open-data")');
    expect(read('../components/DataDoor.tsx')).toContain("action === 'menu:open-data'");
    expect(read('../modules/EditorModule.tsx')).toContain("onImport={() => void pickData('file')}");
  });
  it('the editor imports several clouds one after another, our own LAZ without asking', () => {
    const editor = read('../modules/EditorModule.tsx');
    expect(editor).toContain('importQueue.current.push(f); void drainImports();');
    expect(editor).toContain("void runConvert(p, p.scannerType ?? 'other', undefined, p.columns, true, undefined, !dirty);");
    expect(editor).toContain('{pendingImport && !pendingImport.auto && (');
    expect(editor).toContain('initialScanner={pendingImport.scannerType}');
  });
});

describe('notices', () => {
  afterEach(() => { resetNotices(); vi.useRealTimers(); });
  it('go away by themselves unless they are errors or still running', () => {
    vi.useFakeTimers();
    const a = pushNotice({ kind: 'info', title: 'a' });
    const b = pushNotice({ kind: 'err', title: 'b' });
    const c = pushNotice({ kind: 'info', title: 'c', progress: 10 });
    vi.advanceTimersByTime(NOTICE_MS + 1);
    expect(getNotices().map((n) => n.id)).toEqual([b, c]);
    updateNotice(c, { progress: undefined, kind: 'ok' });
    vi.advanceTimersByTime(NOTICE_MS + 1);
    expect(getNotices().map((n) => n.id)).toEqual([b]);
    dismissNotice(b);
    expect(getNotices()).toEqual([]);
    expect(a).toBeLessThan(b);
  });
});
