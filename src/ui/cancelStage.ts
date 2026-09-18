// One way to stop a backend run from any panel.
//
// Every long tool reports on a named channel and, since the runs became
// stoppable, takes a stop request on the same name (see
// src-tauri/src/commands/cancel.rs). Asking for a stop on a stage that
// is not running is harmless — the next run of that stage clears the
// request when it takes its token — so a panel that runs two things
// under one busy flag may ask for both.

export function cancelStage(...stages: string[]): void {
  const d = (window as unknown as { desktop?: { octreeCancel?: (s: string) => Promise<boolean> } }).desktop;
  if (!d?.octreeCancel) return;
  for (const s of stages) void d.octreeCancel(s).catch(() => { /* nothing was running */ });
}

/** Whether this build can stop a run at all — the desktop with the
 *  cancel command. */
export function canCancel(): boolean {
  return !!(window as unknown as { desktop?: { octreeCancel?: unknown } }).desktop?.octreeCancel;
}
