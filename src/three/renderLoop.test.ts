import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** The render loop that filled the renderer's heap.
 *
 *  EditorShell passed the viewer `onExportLas={() => onExportLas(filters)}`,
 *  a new function every render. The viewer's export callback depended on
 *  it, its API object on that, and the rebuilt API went up through
 *  onApiReady → setApi → setApiState → the shell rendered → a new
 *  function → the viewer rendered → a rebuilt API. Measured in headless
 *  Chromium with the shell mounted on an empty dataset: 96 commits a
 *  second idle, 195 during a build; two heap snapshots two minutes apart
 *  held 5 989 more copies of every API closure. The renderer's heap hit
 *  its 4 GB limit in under an hour on the user's machine and the process
 *  was killed for memory — three times, on two machines, each blamed on
 *  the build that happened to be running. After the fix: 12 and 7. */
const SHELL = readFileSync(new URL('../components/shell/EditorShell.tsx', import.meta.url), 'utf8');
const VIEW = readFileSync(new URL('./OctreeView.tsx', import.meta.url), 'utf8');

function viewerMount(): string {
  const start = SHELL.indexOf('<OctreeView');
  expect(start).toBeGreaterThan(-1);
  return SHELL.slice(start, SHELL.indexOf('/>', start));
}

describe('the shell does not hand the viewer a new callback every render', () => {
  it('passes no inline function as a prop to <OctreeView>', () => {
    const inline = viewerMount().match(/\w+=\{\s*(?:async\s*)?\(?[\w\s,]*\)?\s*=>/g) ?? [];
    expect(inline, 'each of these is a new identity per shell render').toEqual([]);
  });

  it('exports with the live filters through a stable handler', () => {
    expect(viewerMount()).toContain('onExportLas={exportWithLiveFilters}');
    expect(SHELL).toMatch(/const exportWithLiveFilters = useCallback\(\(\) => onExportLas\(filtersRef\.current\), \[onExportLas\]\);/);
  });
});

describe('the viewer does not rebuild its API on a prop identity', () => {
  it('reads onExportLas through a ref, so doExport depends only on onSave', () => {
    const start = VIEW.indexOf('const doExport = useCallback(');
    const block = VIEW.slice(start, VIEW.indexOf('\n  }, [', start) + 40);
    expect(block).toContain('onExportLasRef.current');
    expect(block).toMatch(/\n  }, \[onSave\]\);/);
    expect(VIEW).toContain('const onExportLasRef = useRef(onExportLas);');
  });
});

/** The other thing memory.log showed: a streamer mounted after the
 *  release streamed the cloud in anyway, because the release had been
 *  two calls on a null api. */
describe('a streamer that mounts during a heavy stage starts paused', () => {
  it('reads the released flag at mount', () => {
    expect(VIEW).toContain('const streamPausedRef = useRef(releasedRef.current);');
    expect(VIEW).toMatch(/<NodeStreamer[\s\S]*?releasedRef=\{releasedRef\}/);
    expect(VIEW).toContain('releasedRef.current = true;');
    expect(VIEW).toContain('releasedRef.current = false;');
  });
});
