// Starting work: the welcome screen leads with the data, a new
// project asks only what it uses, and the project's coordinate system is
// what processing writes by default.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('the welcome screen', () => {
  const welcome = read('./WelcomeScreen.tsx');
  it('opens data first — a file or a folder — and names what can be opened', () => {
    expect(welcome).toContain("onClick={() => void pickData('file')}");
    expect(welcome).toContain("onClick={() => void pickData('folder')}");
    expect(welcome).toContain('OPENABLE_SUMMARY.map');
    expect(welcome).toContain('New empty project');
  });
  it('does not offer a recent project that is not there', () => {
    expect(welcome).toContain('disabled={busy || !r.exists}');
  });
});

describe('a new project', () => {
  const dialog = read('./NewProjectDialog.tsx');
  it('asks only what is used: the default cloud format nothing read is gone', () => {
    expect(dialog).not.toContain('defaultCloudFormat');
    expect(dialog).not.toContain('Default cloud format');
  });
  it('comes prefilled, remembers where projects go and which coordinate system', () => {
    expect(dialog).toContain("useState(() => plainPath(initialParent ?? remembered(LAST_PARENT_KEY)))");
    expect(dialog).toContain('remember(LAST_PARENT_KEY, parentFolder);');
    expect(dialog).toContain('remember(LAST_CRS_KEY,');
    expect(dialog).toContain('<option value="none">Not set — each dataset keeps its own</option>');
    // the same key the data door reads for a project made for data
    expect(read('./DataDoor.tsx')).toContain("const LAST_PARENT_KEY = 'pointcloudlabeler-last-project-parent';");
    expect(dialog).toContain("const LAST_PARENT_KEY = 'pointcloudlabeler-last-project-parent';");
  });
  it('Enter creates it; shortcuts are shown for this platform', () => {
    expect(dialog).toContain("if (e.key !== 'Enter' || !canCreate) return;");
    expect(dialog).toContain("formatChord('mod+Enter')");
    expect(dialog).not.toMatch(/<span className="kbd">⌘<\/span>/);
  });
});

describe('the editor with no dataset open', () => {
  const landing = read('./shell/LandingView.tsx');
  it('opens data, a folder too, and has no dead buttons', () => {
    expect(landing).toContain('Open data…');
    expect(landing).toContain("pickData('folder')");
    expect(landing).not.toContain("style={{ display: 'none' }}");
    expect(landing).toContain("formatChord('mod+k')");
  });
});
