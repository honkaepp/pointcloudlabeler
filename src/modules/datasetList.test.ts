import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';

const read = (p: string) => stripComments(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));

/** Every module stays mounted behind the tabs. A module that lists the
 *  project's datasets only when the project changes therefore keeps the
 *  list it took at that moment — and for a new project that list was
 *  empty, so after an import in the Editor, Inventory and Metrics still
 *  said "No datasets in this project yet". These pins hold the fix: the
 *  module knows when it is shown, and takes the list again each time. */
describe('the dataset list of a module behind a tab', () => {
  const app = read('src/App.tsx');

  it('is taken by modules that stay mounted while hidden', () => {
    for (const id of ['inventory', 'metrics', 'figures']) {
      expect(app, `${id} is unmounted rather than hidden`).toMatch(new RegExp(`display: activeModule === '${id}' \\? 'block' : 'none'`));
    }
  });

  it('can tell when its module is shown, through the project context', () => {
    expect(read('src/context/ProjectContext.tsx')).toMatch(/activeModule: ModuleId;/);
    expect(app).toMatch(/useMemo\(\(\) => \(\{ project, setProject, activeModule \}\), \[project, activeModule\]\)/);
  });

  it.each([
    ['src/modules/InventoryModule.tsx', 'inventory'],
    ['src/modules/MetricsModule.tsx', 'metrics'],
    ['src/modules/FigureModule.tsx', 'figures'],
  ])('%s is taken again each time the module is shown', (file, id) => {
    const src = read(file);
    expect(src).toMatch(new RegExp(`const shown = activeModule === '${id}';`));
    // The listing effect waits for the module to be shown and re-runs
    // when it is shown again, not only when the project changes.
    const effect = src.match(/useEffect\(\(\) => \{\n\s*if \(!shown\) return;[\s\S]*?\}, \[project\?\.folder, shown\]\);/);
    expect(effect, 'no listing effect keyed on `shown`').not.toBeNull();
    expect(effect![0]).toMatch(/listOctrees\(project\.folder\)/);
  });

  it('does not make the Editor re-list on a tab switch: it owns the list the others read after', () => {
    // The Editor is where datasets are made; its list refreshes after
    // each convert / subset / shift and on project change, and a tab
    // switch away from it is not a reason to read the folder again.
    expect(read('src/modules/EditorModule.tsx')).not.toMatch(/activeModule/);
  });
});
