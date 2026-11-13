// Renaming a project: one name for the project and its folder,
// a folder renamed in Explorer giving the project its new name, and the
// per-project storage of this machine following it (projectName.ts,
// src-tauri/src/commands/project_rename.rs).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';
import {
  PROJECT_NAME_MAX, folderName, migrateStoredPaths, projectNameProblem, rebasePath, sameFolder, siblingFolder,
  type KeyStore,
} from './projectName';
import { adoptProject, type ProjectState } from './projectStore';

const read = (p: string) => stripComments(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));

/** A storage over a Map, in insertion order like the browser's. */
function memoryStore(init: Record<string, string> = {}): KeyStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(init));
  return {
    map,
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

describe('a project name', () => {
  it('is one Windows takes as a folder name — the same rules as the backend', () => {
    for (const ok of ['Plot 1041', 'Evo 2024 – kuusikko', 'FP08_MLS_2023', 'a.b', 'Ääni']) {
      expect(projectNameProblem(ok), ok).toBeNull();
    }
    for (const bad of ['', '   ', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'plot.', '.', '..', 'CON', 'nul.txt', 'com1', 'a\tb']) {
      expect(projectNameProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    expect(projectNameProblem('x'.repeat(PROJECT_NAME_MAX + 1))).not.toBeNull();
    expect(projectNameProblem('x'.repeat(PROJECT_NAME_MAX))).toBeNull();
    expect(projectNameProblem('a/b')).toContain('cannot contain “/”');
    const rust = read('src-tauri/src/commands/project_rename.rs');
    expect(rust).toContain(`pub const NAME_MAX: usize = ${PROJECT_NAME_MAX};`);
    expect(rust).toContain('r#"<>:"/\\|?*"#');
  });

  it('names the folder beside the one it has', () => {
    expect(siblingFolder('C:\\Plots\\Evo', 'Evo 2024')).toBe('C:\\Plots\\Evo 2024');
    expect(siblingFolder('/data/plots/evo/', ' x ')).toBe('/data/plots/x');
    expect(folderName('C:\\Plots\\Evo\\')).toBe('Evo');
  });
});

describe('a path inside a renamed project', () => {
  const from = 'C:\\Plots\\Evo';
  const to = 'C:\\Plots\\Evo 2024';
  it('moves with the folder and keeps its spelling', () => {
    expect(rebasePath('C:\\Plots\\Evo\\octrees\\a', from, to)).toBe('C:\\Plots\\Evo 2024\\octrees\\a');
    expect(rebasePath('C:/Plots/Evo/octrees/a', from, to)).toBe('C:/Plots/Evo 2024/octrees/a');
    expect(rebasePath('\\\\?\\C:\\Plots\\Evo\\imports\\x.e57', from, to)).toBe('\\\\?\\C:\\Plots\\Evo 2024\\imports\\x.e57');
    expect(rebasePath('C:\\Plots\\Evo', from, to)).toBe('C:\\Plots\\Evo 2024');
    expect(rebasePath('c:\\plots\\EVO\\x', from, to)).toBe('C:\\Plots\\Evo 2024\\x');
    // a key some code built from a lower-cased path stays lower case
    expect(rebasePath('c:/plots/evo/octrees/a', from, to)).toBe('c:/plots/evo 2024/octrees/a');
  });
  it('is not a folder that only starts the same, or another drive', () => {
    expect(rebasePath('C:\\Plots\\Evo2\\x', from, to)).toBeNull();
    expect(rebasePath('D:\\Plots\\Evo\\x', from, to)).toBeNull();
    expect(rebasePath('not a path', from, to)).toBeNull();
    expect(sameFolder('C:\\Plots\\Evo\\', 'c:/plots/evo')).toBe(true);
    expect(sameFolder('C:\\Plots\\Evo', 'C:\\Plots\\Evo\\x')).toBe(false);
  });
});

describe('this machine’s storage of a renamed project', () => {
  const from = 'C:\\Plots\\Evo';
  const to = 'C:\\Plots\\Evo 2024';
  // what fileLayerActions.ts and viewToolsStore.ts write
  const layersKey = (folder: string) => `pointcloudlabeler-file-layers:${folder.replace(/\\/g, '/').toLowerCase()}`;
  const before = () => memoryStore({
    [layersKey(from)]: JSON.stringify([{ path: 'C:\\Plots\\Evo\\survey\\dtm.ply', kind: 'mesh', visible: true }]),
    'pointcloudlabeler-views:C:\\Plots\\Evo\\octrees\\plot': JSON.stringify([{ name: 'View 1', position: [0, 0, 1], target: [0, 0, 0], projection: 'ortho' }]),
    'pointcloudlabeler-views:C:\\Plots\\Evo2\\octrees\\plot': '[]',
    'pointcloudlabeler-export-panel': JSON.stringify({ export: { outDir: 'C:\\Plots\\Evo\\exports' }, tab: 'points' }),
    'tree-seg-theme': 'dark',
  });

  it('moves the keys and values that name a path inside it, and nothing else', () => {
    const s = before();
    expect(migrateStoredPaths(from, to, {}, s)).toBe(3);
    expect(JSON.parse(s.map.get(layersKey(to))!)).toEqual([{ path: 'C:\\Plots\\Evo 2024\\survey\\dtm.ply', kind: 'mesh', visible: true }]);
    expect(s.map.has(layersKey(from))).toBe(false);
    expect(s.map.has('pointcloudlabeler-views:C:\\Plots\\Evo 2024\\octrees\\plot')).toBe(true);
    expect(s.map.has('pointcloudlabeler-views:C:\\Plots\\Evo\\octrees\\plot')).toBe(false);
    expect(s.map.get('pointcloudlabeler-views:C:\\Plots\\Evo2\\octrees\\plot')).toBe('[]');
    expect(JSON.parse(s.map.get('pointcloudlabeler-export-panel')!).export.outDir).toBe('C:\\Plots\\Evo 2024\\exports');
    expect(s.map.get('tree-seg-theme')).toBe('dark');
    // the second time, nothing is left to move
    const after = new Map(s.map);
    expect(migrateStoredPaths(from, to, {}, s)).toBe(0);
    expect(s.map).toEqual(after);
  });

  it('copies the keys of a copied project, never over what the copy has, and leaves settings alone', () => {
    const s = before();
    s.map.set('pointcloudlabeler-views:C:\\Plots\\Evo 2024\\octrees\\plot', '[{"name":"mine","position":[1,1,1],"target":[0,0,0]}]');
    migrateStoredPaths(from, to, { kept: true }, s);
    expect(s.map.has(layersKey(from)) && s.map.has(layersKey(to))).toBe(true);
    expect(s.map.get('pointcloudlabeler-views:C:\\Plots\\Evo 2024\\octrees\\plot')).toContain('"mine"');
    expect(JSON.parse(s.map.get('pointcloudlabeler-export-panel')!).export.outDir).toBe('C:\\Plots\\Evo\\exports');
  });

  it('is moved whenever a project arrives from a new place', () => {
    const p: ProjectState = {
      folder: to,
      meta: { version: 1, name: 'Evo 2024', createdAt: 1, updatedAt: 1, coordinateSystem: { epsg: null, name: 'unknown' }, defaultCloudFormat: 'txt', notes: '' },
      relocated: { from, kept: false, paths: 0 },
    };
    expect(adoptProject(p)).toBe(p);
    expect(adoptProject(null)).toBeNull();
  });
});

describe('Rename Project… is wired', () => {
  it('in the backend: a command, an operation, the open and the recent list', () => {
    const lib = read('src-tauri/src/lib.rs');
    expect(lib).toContain('commands::project_rename::project_rename,');
    const project = read('src-tauri/src/commands/project.rs');
    expect(project).toContain('crate::commands::project_rename::adopt_folder(folder, &mut meta)');
    expect(project).toContain('crate::commands::project_rename::forget_recent(&r.from);');
    expect(project).toContain('crate::commands::project_rename::find_renamed(&path)');
    expect(project).toContain('name: crate::commands::project_rename::shown_name(&meta, &path)');
    expect(read('src-tauri/src/ops/project.rs')).toContain('op!("project.rename", Project, mutates: true');
    expect(read('src-tauri/src/state.rs')).toContain('#[serde(rename = "lastFolder", default, skip_serializing_if = "Option::is_none")]');
    expect(read('src/persistence/desktopBridge.ts')).toContain("projectRename: (folder: string, name: string) => ctx.invoke('project_rename', { folder, name })");
  });

  it('in the menu, the module strip and the welcome screen, all to one dialog', () => {
    expect(read('src-tauri/src/menu.rs')).toContain('MenuItemBuilder::new("Rename Project…")');
    expect(read('src/components/shell/menuActions.ts')).toMatch(/APP_MENU_IDS[^\n]*'project-rename'/);
    const app = read('src/App.tsx');
    expect(app).toContain("case 'menu:project-rename':");
    expect(app).toContain('onRenameProject={() => startRename(project.folder, project.meta.name)}');
    expect(app).toContain('onRename={(r) => startRename(r.folder, r.name)}');
    expect(app.match(/\{renameDialog\}/g)?.length).toBe(2);
    expect(read('src/components/ModuleTabs.tsx')).toContain('onClick={onRenameProject}');
    const welcome = read('src/components/WelcomeScreen.tsx');
    expect(welcome).toContain('onRename(r);');
    expect(welcome).toContain('void locate();');
  });

  it('closes the open project for the rename, refuses over unsaved edits and running jobs, and reopens the cloud', () => {
    const app = read('src/App.tsx');
    expect(app).toContain("const problem = projectNameProblem(name) ?? (r.open ? renameBlocker() : null);");
    const at = app.indexOf('const runRename');
    const flow = app.slice(at, app.indexOf('}, []);', at));
    const order = ['await checkRename(r.folder, name);', 'await closeProject();', 'out = await renameProject(r.folder, name);', 'rememberReopen(', 'setProject(await openProject(out.folder));'];
    let last = -1;
    for (const step of order) {
      const i = flow.indexOf(step);
      expect(i, step).toBeGreaterThan(last);
      last = i;
    }
    expect(flow).toContain('if (reopen) rememberReopen(reopen);\n          setProject(await openProject(r.folder));');
    expect(app).toContain('setProject(adoptProject((payload as ProjectState | null) ?? null));');
    expect(read('src/modules/EditorModule.tsx')).toContain('setEditorSession({ dir: viewingOctree?.dir ?? null, dirty });');
  });

  it('a new project takes the same name rules', () => {
    const dialog = read('src/components/NewProjectDialog.tsx');
    expect(dialog).toContain('const nameProblem = name.trim() ? projectNameProblem(name) : null;');
    expect(dialog).not.toContain(".replace(/[\\\\/:*?\"<>|]+/g, '_')");
  });
});
