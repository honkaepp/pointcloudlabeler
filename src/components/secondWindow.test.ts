// The ⧉ button in the module tabs and View → Second Window… are
// one action (CompareWindowControls.secondWindowCommand). A tester could
// not open the second window from the button: its menu opened under the
// editor, unseen, while the menu item opened the window at once.

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { secondWindowButton, secondWindowCommand } from './CompareWindowControls';
import { getCompare, setCompare, DEFAULT_LINK } from '../state/compareWindow';
import { getNotices, resetNotices } from '../state/notices';
import { stripComments } from '../testing/sourceScan';

const code = (p: string) => stripComments(readFileSync(p, 'utf8'));

type Call = [string, ...unknown[]];
function stubBridge(fail?: string): Call[] {
  const calls: Call[] = [];
  (globalThis as unknown as { window: unknown }).window = {
    desktop: {
      compareWindowOpen: async (dir: string | null, side: boolean) => {
        if (fail) throw new Error(fail);
        calls.push(['open', dir, side]);
      },
      compareWindowArrange: async () => { calls.push(['arrange']); },
    },
  };
  return calls;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  setCompare({ role: 'main', otherOpen: false, link: DEFAULT_LINK });
  resetNotices();
});

describe('the ⧉ button and View → Second Window…', () => {
  it('the button runs the very function the menu item runs', () => {
    for (const otherOpen of [false, true]) {
      expect(secondWindowButton({ ...getCompare(), otherOpen }, true).run).toBe(secondWindowCommand);
    }
    // App.tsx: the menu case calls it and nothing else.
    const app = code('src/App.tsx');
    const at = app.indexOf("case 'menu:compare-window':");
    expect(at).toBeGreaterThan(0);
    const body = app.slice(at, app.indexOf('break;', at));
    expect(body.replace(/\s+/g, ' ').trim()).toBe("case 'menu:compare-window': void secondWindowCommand();");
    // The component: the button's click is the description's run, and the
    // window is opened bare in one place only.
    const ui = code('src/components/CompareWindowControls.tsx');
    expect(ui).toContain('const main = secondWindowButton(st, !!project);');
    expect(ui).toMatch(/title=\{main\.title\} onClick=\{\(\) => \{ setMenu\(null\); void main\.run\(\); \}\}>\{main\.label\}<\/button>/);
    expect(ui.split('openCompareWindow(null)').length - 1).toBe(1);
    expect(app).not.toContain('openCompareWindow(');
    expect(app).not.toContain('compareWindowArrange');
  });

  it('opens the second window beside the editor — or, in the second window, puts the two side by side', async () => {
    const calls = stubBridge();
    await secondWindowCommand();
    expect(calls).toEqual([['open', null, true]]);
    expect(getCompare().otherOpen).toBe(true);
    // Open already: brought forward and put back beside the editor (the
    // backend does both for the same call).
    await secondWindowCommand();
    expect(calls).toEqual([['open', null, true], ['open', null, true]]);

    setCompare({ role: 'compare' });
    await secondWindowCommand();
    expect(calls.at(-1)).toEqual(['arrange']);
  });

  it('a failure is shown, whichever of the two asked', async () => {
    stubBridge('WebView2 said no');
    await expect(secondWindowCommand()).resolves.toBeUndefined();
    expect(getNotices().map(n => [n.kind, n.title, n.text])).toEqual([
      ['err', 'The second window did not open', 'WebView2 said no'],
    ]);
    resetNotices();
    // In a browser there is no second window to open.
    delete (globalThis as unknown as { window?: unknown }).window;
    await secondWindowCommand();
    expect(getNotices()[0].text).toBe('The second window needs the desktop build.');
  });

  it('the tooltip says what a click does', () => {
    const closed = secondWindowButton({ ...getCompare(), otherOpen: false }, true);
    expect(closed.label).toBe('⧉ Second window');
    expect(closed.title).toMatch(/^Open a second window beside this one/);
    expect(closed.title).toContain('(View → Second Window…)');
    const open = secondWindowButton({ ...getCompare(), otherOpen: true, link: { camera: 'world', colors: false } }, true);
    expect(open.label).toBe('⧉ world');
    expect(open.title).toMatch(/^Bring the second window forward, beside this one \(View → Second Window…\)/);
    expect(open.title).toContain('Linked: world');
    const none = secondWindowButton(getCompare(), false);
    expect(none.disabled).toBe(true);
    expect(none.title).toBe('Open a project first');
    // The menu item's name, as the tooltips quote it.
    expect(readFileSync('src-tauri/src/menu.rs', 'utf8')).toContain('item(app, "Second Window…", "compare-window")');
  });

  it('the ▾ menu hangs on the page, not inside the module tabs', () => {
    // The tabs and the editor below them are stacked at the same level and
    // the editor comes later, so a menu inside the tabs opened under it.
    const ui = code('src/components/CompareWindowControls.tsx');
    expect(ui).toMatch(/\{menu && createPortal\(\s*<div ref=\{pop\} role="menu" className="fixed /);
    expect(ui).toMatch(/<\/div>,\s*document\.body,\s*\)\}/);
  });
});
