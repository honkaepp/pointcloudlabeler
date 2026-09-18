// What WebView2 told the Rust side when the renderer process failed —
// see src-tauri/src/crash.rs — and how to say it to the person looking
// at the page that came back.

export interface RendererFailure {
  /** `render-process-exited`, `browser-process-exited`, `gpu-process-exited`, … */
  kind: string;
  /** `out-of-memory`, `crashed`, `terminated`, `unresponsive`, … */
  reason: string;
  exitCode: number;
  description: string;
  /** Unix seconds. */
  at: number;
  /** Whether the Rust side reloaded the page in response. */
  reloaded: boolean;
}

const REASONS: Record<string, string> = {
  'out-of-memory': 'it ran out of memory',
  crashed: 'it crashed',
  terminated: 'it was ended from outside, by Windows or by a person',
  unresponsive: 'it stopped responding',
  'launch-failed': 'it failed to start',
  'profile-deleted': 'its browser profile was deleted',
  unexpected: 'the browser gave no reason',
};

function reasonPhrase(reason: string): string {
  return REASONS[reason] ?? `reason: ${reason}`;
}

export function describeRendererFailure(
  f: RendererFailure,
  logPath: string | null,
  formatTime: (unixSeconds: number) => string = defaultTime,
): { title: string; detail: string } {
  const when = formatTime(f.at);
  const why = reasonPhrase(f.reason);
  let title: string;
  if (f.kind === 'render-process-exited') {
    title = f.reloaded
      ? `The interface was reloaded at ${when} because its renderer process exited: ${why}.`
      : `The interface's renderer process exited at ${when}: ${why}.`;
  } else if (f.kind === 'browser-process-exited') {
    title = `The browser process behind the interface exited at ${when}: ${why}. Restart PointCloudLabeler.`;
  } else if (f.kind === 'gpu-process-exited') {
    title = `The GPU process behind the interface exited at ${when}: ${why}.`;
  } else if (f.kind === 'render-process-unresponsive') {
    title = `The interface stopped responding at ${when}.`;
  } else {
    title = `A browser process behind the interface failed at ${when} (${f.kind}): ${why}.`;
  }
  const parts = [
    'PointCloudLabeler itself kept running: a skeleton build or transfer that was going continued, and its checkpoints are kept.',
    `Exit code ${f.exitCode}${f.description ? `, process "${f.description}"` : ''}.`,
  ];
  if (logPath) parts.push(`Written to ${logPath}.`);
  return { title, detail: parts.join(' ') };
}

function defaultTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
