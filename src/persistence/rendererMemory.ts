// What the page holds, for memory.log.
//
// The renderer process died of memory with the point cloud released and
// this process at a quarter of a gigabyte. Which of the browser's
// processes grew, the Rust side now samples (crash.rs); what of it was
// the JS heap, and what the viewport still had loaded, only the page can
// say. So while a heavy stage runs the viewport writes one line a minute
// here, through the crash_log command with kind "memory", which files it
// beside the process samples.

/** Chromium's `performance.memory`, where it exists. Bytes. */
export interface PerfMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/** What the viewport is holding, from the streamer's own bookkeeping
 *  and the WebGL renderer's counters. */
export interface RendererMemoryInfo {
  loadedNodes: number;
  loadedPoints: number;
  pendingGpu: number;
  inFlight: number;
  queued: number;
  geometries: number;
  textures: number;
  programs: number;
}

export function readPerformanceMemory(): PerfMemory | null {
  const m = (globalThis.performance as unknown as { memory?: Partial<PerfMemory> } | undefined)?.memory;
  if (!m || typeof m.usedJSHeapSize !== 'number') return null;
  return {
    usedJSHeapSize: m.usedJSHeapSize,
    totalJSHeapSize: m.totalJSHeapSize ?? 0,
    jsHeapSizeLimit: m.jsHeapSizeLimit ?? 0,
  };
}

const mib = (b: number) => `${(b / (1024 * 1024)).toFixed(0)} MiB`;

/** One line: the stage, whether the cloud is released, the JS heap, and
 *  the viewport's counts. Fixed field order so the lines diff by eye. */
export function describeRendererMemory(
  stage: string,
  released: boolean,
  perf: PerfMemory | null,
  info: RendererMemoryInfo | null,
  domNodes: number | null = null,
): string {
  const parts = [`stage ${stage}`, released ? 'cloud released' : 'cloud held'];
  parts.push(perf
    ? `js heap ${mib(perf.usedJSHeapSize)} used / ${mib(perf.totalJSHeapSize)} total / ${mib(perf.jsHeapSizeLimit)} limit`
    : 'js heap ?');
  if (info) {
    parts.push(`nodes ${info.loadedNodes} loaded (${info.loadedPoints.toLocaleString('en-US')} pts), ${info.pendingGpu} pending gpu, ${info.inFlight} in flight, ${info.queued} queued`);
    parts.push(`gl ${info.geometries} geometries, ${info.textures} textures, ${info.programs} programs`);
  } else {
    parts.push('viewport ?');
  }
  if (domNodes != null) parts.push(`dom ${domNodes} nodes`);
  return parts.join(' | ');
}
