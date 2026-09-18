import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** The pieces that turn "the window went dark after an hour" into a
 *  logged reason and a sentence on screen. Each is a small edit in a
 *  file that has other reasons to change, so each is pinned. */
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('the renderer reports its own errors', () => {
  it('main.tsx installs the window error hooks before the bridge, and a boundary around the whole tree', () => {
    const main = read('src/main.tsx');
    const install = main.indexOf('installRendererErrorLog(window');
    const bridge = main.indexOf('setupDesktopBridge()');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(bridge);
    expect(main).toMatch(/<ErrorBoundary label="PointCloudLabeler">\s*<App \/>\s*<\/ErrorBoundary>/);
  });

  it('the bridge sends them to the Rust crash log, in the shape the error boundary already used', () => {
    const bridge = read('src/persistence/desktopBridge.ts');
    // ErrorBoundary calls `logCrash(message)` with one argument; the
    // hooks add a kind. Message first keeps both callers right.
    expect(bridge).toContain("logCrash: (message: string, kind = 'error') => ctx.invoke<boolean>('crash_log', { kind, message })");
    expect(read('src/components/ErrorBoundary.tsx')).toContain('api?.logCrash?.(');
  });
});

describe('the reloaded page learns what happened to its predecessor', () => {
  it('the bridge exposes the last failure and the log location', () => {
    const bridge = read('src/persistence/desktopBridge.ts');
    expect(bridge).toContain("ctx.invoke<RendererFailure | null>('renderer_last_failure')");
    expect(bridge).toContain("ctx.invoke<string | null>('crash_log_location')");
  });

  it('App shows the notice with or without a project open', () => {
    const app = read('src/App.tsx');
    expect((app.match(/<RendererCrashNotice \/>/g) ?? []).length).toBe(2);
  });

  it('the Rust side subscribes to WebView2 ProcessFailed on the main window', () => {
    const lib = read('src-tauri/src/lib.rs');
    expect(lib).toContain('crash::watch_webview(&main)');
    const crash = read('src-tauri/src/crash.rs');
    expect(crash).toContain('add_ProcessFailed(&handler');
    // A dead renderer is reloaded; the other kinds are logged and left.
    expect(crash).toMatch(/if reloaded \{[\s\S]*?Reload\(\)/);
  });
});

describe('what every process holds is sampled over time', () => {
  it('the Rust side starts the memory watch on the main window and routes page samples to memory.log', () => {
    expect(read('src-tauri/src/lib.rs')).toContain('crash::start_memory_watch(main.clone())');
    const crash = read('src-tauri/src/crash.rs');
    expect(crash).toContain('if kind == "memory"');
    expect(crash).toContain('GetProcessInfos()');
    expect(crash).toContain('join("memory.log")');
  });

  it('the viewport samples once a minute while a stage runs, and once right after releasing the cloud', () => {
    const view = read('src/three/OctreeView.tsx');
    const start = view.indexOf('const [busyStage, setBusyStage]');
    const effect = view.slice(start, view.indexOf('const [selectedCount, setSelectedCountState]', start));
    expect(effect).toContain('sampler = setInterval(sample, 60_000)');
    expect(effect).toContain("desktop.logCrash(describeRendererMemory(");
    expect(effect).toContain("), 'memory')");
    expect(effect).toMatch(/reloadNodes\(\);[\s\S]{0,200}setTimeout\(sample, 2_000\)/);
    // The api it reads from exists.
    expect(view).toContain('memoryInfo: () => ({');
    expect(view).toContain('memoryInfo: () => RendererMemoryInfo;');
  });
});

describe('the skeleton cache crosses the bridge as bytes', () => {
  it('the bridge decodes the planar buffer and nothing types the columns as number[]', () => {
    const bridge = read('src/persistence/desktopBridge.ts');
    const start = bridge.indexOf('octreeReadSkeletons:');
    const block = bridge.slice(start, bridge.indexOf('octreeClearSkeletons:', start));
    expect(block).toContain("ctx.invoke<ArrayBuffer | Uint8Array>('octree_read_skeletons'");
    expect(block).toContain('decodeSkeletonPlanar(bytes)');
    expect(block).not.toMatch(/xyz: number\[\]/);
  });

  it('the panel hands the arrays to the overlay without copying them', () => {
    const panel = read('src/components/shell/SkeletonTransferPanel.tsx');
    expect(panel).not.toContain('Float32Array.from(payload');
    expect(panel).not.toContain('Int32Array.from(payload');
    expect(panel).toMatch(/setSkeletonOverlay\(\{\s*origin: payload\.origin, xyz: payload\.xyz, treeId: payload\.treeId, order: payload\.order,\s*radiusMm: payload\.radiusMm, colorMode: skelColor, sourceDir: viewedDir,\s*\}\)/);
  });

  it('the Rust command returns a Response, not JSON', () => {
    const octree = read('src-tauri/src/commands/octree.rs');
    expect(octree).toMatch(/pub fn octree_read_skeletons\(octree_dir: String\) -> Result<tauri::ipc::Response, String>/);
    expect(octree).not.toContain('SkeletonReadResult');
  });

  it('the overlay colours are bytes', () => {
    const view = read('src/three/OctreeView.tsx');
    const start = view.indexOf('function SkeletonPointsOverlay');
    const body = view.slice(start, view.indexOf('function M3C2PointsOverlay', start));
    expect(body).toContain('const col = new Uint8Array(n * 3)');
    expect(body).toContain("setAttribute('color', new THREE.BufferAttribute(col, 3, true))");
  });
});
