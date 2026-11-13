import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  windowRole, initialDataset, sceneToWorldPoint, worldToScenePoint, poseToWorld, followPose, posesClose,
  dirKey, blocksWrite, getCompare, setCompare, DEFAULT_LINK, type ScenePose, type Vec3,
} from './compareWindow';
import { sceneToWorld } from '../io/sceneAxes';

const read = (p: string) => readFileSync(p, 'utf8');

describe('which window a page is', () => {
  it('the second window is told so in its address, with the dataset to open', () => {
    expect(windowRole('')).toBe('main');
    expect(windowRole('?window=main')).toBe('main');
    expect(windowRole('?window=compare')).toBe('compare');
    expect(initialDataset('?window=compare')).toBeNull();
    expect(initialDataset('?window=compare&dataset=')).toBeNull();
    // What compare_window.rs writes (its url_encode) reads back whole.
    expect(initialDataset('?window=compare&dataset=C%3A%5CPlots%5CEvo%201001%5Coctrees%5Cp%261'))
      .toBe('C:\\Plots\\Evo 1001\\octrees\\p&1');
    expect(initialDataset('?window=compare&dataset=puu-%C3%A4.1~_')).toBe('puu-ä.1~_');
  });
});

describe('the camera link', () => {
  const offA: Vec3 = [384000, 6950000, 120];
  const offB: Vec3 = [384100.5, 6949990.25, 95];

  it('scene and world are each other\'s inverse, and agree with sceneAxes', () => {
    const p: Vec3 = [1.5, -2.25, 30.125];
    expect(sceneToWorldPoint(p, offA)).toEqual(sceneToWorld(p, offA));
    const back = worldToScenePoint(sceneToWorldPoint(p, offA), offA);
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(p[i], 9);
  });

  it('"world": the other window looks at the same place from the same place', () => {
    const a: ScenePose = { position: [10, 25, -5], target: [0, 2, 3] };
    const world = poseToWorld(a, offA);
    const b = followPose('world', world, { position: [0, 0, 0], target: [0, 0, 0] }, offB)!;
    const wb = poseToWorld(b, offB);
    for (let i = 0; i < 3; i++) {
      expect(wb.position[i]).toBeCloseTo(world.position[i], 6);
      expect(wb.target[i]).toBeCloseTo(world.target[i], 6);
    }
  });

  it('"orbit": the same direction and distance, about the window\'s own target', () => {
    const a: ScenePose = { position: [10, 25, -5], target: [0, 2, 3] };
    const own: ScenePose = { position: [99, 99, 99], target: [-4, 1, 7] };
    const b = followPose('orbit', poseToWorld(a, offA), own, offB)!;
    expect(b.target).toEqual(own.target);
    // Target → camera is the same vector in the scene of each.
    for (let i = 0; i < 3; i++) expect(b.position[i] - b.target[i]).toBeCloseTo(a.position[i] - a.target[i], 9);
    expect(followPose('off', poseToWorld(a, offA), own, offB)).toBeNull();
  });

  it('a pose taken from the other window is not a move to send back', () => {
    const p: ScenePose = { position: [1, 2, 3], target: [4, 5, 6] };
    expect(posesClose(p, { position: [1, 2, 3 + 1e-8], target: [4, 5, 6] })).toBe(true);
    expect(posesClose(p, { position: [1, 2, 3.01], target: [4, 5, 6] })).toBe(false);
    expect(posesClose(p, { position: [1, 2, 3], target: [4, 5.01, 6] })).toBe(false);
  });
});

describe('a dataset held by the other window is read-only here', () => {
  const ro = new Set([dirKey('C:\\Plots\\P1\\octrees\\plot1\\')]);

  it('one spelling per folder', () => {
    expect(dirKey('C:\\Plots\\P1\\')).toBe('c:/plots/p1');
    expect(dirKey('\\\\?\\C:\\Plots\\P1')).toBe('c:/plots/p1');
    expect(dirKey('c:/plots/p1/')).toBe('c:/plots/p1');
  });

  it('writes into it are refused; reads, and writes elsewhere, are not', () => {
    expect(blocksWrite('octree_write_branches', { octreeDir: 'c:/plots/p1/octrees/plot1', json: '{}' }, undefined, ro)).toBe(true);
    expect(blocksWrite('octree_write_patches_begin', { octreeDir: 'C:\\Plots\\P1\\octrees\\plot1' }, undefined, ro)).toBe(true);
    expect(blocksWrite('octree_bake_patches', { octreeDir: 'C:\\Plots\\P1\\octrees\\plot1' }, undefined, ro)).toBe(true);
    expect(blocksWrite('octree_segment_forest', { octreeDir: 'C:\\Plots\\P1\\octrees\\plot1', params: {} }, undefined, ro)).toBe(true);
    expect(blocksWrite('octree_forest_save_seeds', { octreeDir: 'C:\\Plots\\P1\\octrees\\plot1', seeds: {} }, undefined, ro)).toBe(true);
    // A file written inside it — a saved layer — likewise, whether the
    // path is an argument or the header a byte write carries.
    expect(blocksWrite('file_write', { path: 'C:\\Plots\\P1\\octrees\\plot1\\layers\\a.json', content: '' }, undefined, ro)).toBe(true);
    expect(blocksWrite('file_write_bytes', new Uint8Array(4), { 'x-path': encodeURIComponent('C:\\Plots\\P1\\octrees\\plot1\\x.bin') }, ro)).toBe(true);
    // Reading it is fine.
    expect(blocksWrite('octree_read_branches', { octreeDir: 'C:\\Plots\\P1\\octrees\\plot1' }, undefined, ro)).toBe(false);
    expect(blocksWrite('octree_read_node', { dir: 'C:\\Plots\\P1\\octrees\\plot1' }, undefined, ro)).toBe(false);
    // Another dataset — even one whose name starts the same — is not held.
    expect(blocksWrite('octree_write_branches', { octreeDir: 'C:\\Plots\\P1\\octrees\\plot10' }, undefined, ro)).toBe(false);
    expect(blocksWrite('file_write', { path: 'C:\\Exports\\branches.csv', content: '' }, undefined, ro)).toBe(false);
    // Nothing held, nothing refused.
    expect(blocksWrite('octree_write_branches', { octreeDir: 'C:\\Plots\\P1\\octrees\\plot1' }, undefined, new Set())).toBe(false);
  });
});

describe('the link settings', () => {
  it('are kept for the next start, the same for both windows', () => {
    // The pages share one browser store; here, a stand-in for it.
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem'> }).localStorage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => { store.set(k, v); },
    };
    expect(getCompare().link).toEqual(DEFAULT_LINK);
    setCompare({ link: { camera: 'world', colors: false } });
    expect(getCompare().link).toEqual({ camera: 'world', colors: false });
    expect(JSON.parse(localStorage.getItem('pointcloudlabeler-compare-link') ?? 'null')).toEqual({ camera: 'world', colors: false });
    setCompare({ link: DEFAULT_LINK });
  });
});

describe('the second window is wired in everywhere it has to be', () => {
  it('Rust opens it, may call commands from it, and keeps the windows apart', () => {
    const lib = read('src-tauri/src/lib.rs');
    for (const c of ['compare_window_open', 'compare_window_arrange', 'compare_window_is_open', 'compare_window_close', 'window_claim_dataset', 'window_release_dataset']) {
      expect(lib).toContain(`commands::compare_window::${c},`);
    }
    expect(lib).toContain('.manage(commands::compare_window::DatasetClaims::default())');
    expect(lib).toContain('commands::compare_window::watch_main(&main);');
    const caps = JSON.parse(read('src-tauri/capabilities/default.json'));
    expect(caps.windows).toEqual(['main', 'compare']);
    const rs = read('src-tauri/src/commands/compare_window.rs');
    expect(rs).toContain('pub const COMPARE_LABEL: &str = "compare";');
    // The second webview must start with the editor's WebView2 arguments.
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
    expect(rs).toContain(`const BROWSER_ARGS: &str = "${conf.app.windows[0].additionalBrowserArgs}";`);
    // A menu click and a drop are each one window's.
    expect(read('src-tauri/src/menu.rs')).toContain('.in_window(focused_window(app))');
    expect(read('src-tauri/src/commands/dataopen.rs')).toContain('DataDrop { window: webview.label().to_string(), entries }');
  });

  it('the pages: the menu item, the strip, the link and the read-only guard', () => {
    expect(read('src-tauri/src/menu.rs')).toContain('item(app, "Second Window…", "compare-window")');
    expect(read('src/components/shell/menuActions.ts')).toMatch(/APP_MENU_IDS[^\n]*'compare-window'/);
    const app = read('src/App.tsx');
    expect(app).toContain("case 'menu:compare-window':");
    expect(app).toContain('useCompareChannel();');
    expect(read('src/components/ModuleTabs.tsx')).toContain('<CompareWindowControls />');
    const shell = read('src/components/shell/EditorShell.tsx');
    expect(shell).toContain('{octree && <CompareSync />}');
    expect(shell).toContain('const editMode = editModeWanted && !readOnly;');
    const editor = read('src/modules/EditorModule.tsx');
    expect(editor).toContain('d.windowClaimDataset(openDir)');
    expect(editor).toContain('readOnly={readOnly}');
    const bridge = read('src/persistence/desktopBridge.ts');
    expect(bridge).toContain('blocksWrite(cmd, args, headersOf(options), readOnlyKeys)');
    expect(bridge).toContain("ctx.invoke<void>('compare_window_open', { dataset, sideBySide })");
  });
});
