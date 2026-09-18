// The renderer's uncaught errors, sent to the crash log on the Rust
// side (src-tauri/src/crash.rs).
//
// The error boundary catches what React renders. It does not see an
// exception in an event handler, a timer, or a promise nobody awaited,
// and those are exactly the errors of a long-running build's progress
// and completion callbacks. Without this they went to a devtools
// console no release build has.

export interface CrashSink {
  logCrash?: (message: string, kind?: string) => unknown;
}

/** The two events, on anything that dispatches them — `window` in the
 *  app, a stand-in in tests. */
export interface ErrorSource {
  addEventListener(type: 'error', listener: (ev: ErrorEventLike) => void): void;
  addEventListener(type: 'unhandledrejection', listener: (ev: RejectionEventLike) => void): void;
}
export interface ErrorEventLike {
  message?: string; filename?: string; lineno?: number; colno?: number; error?: unknown;
}
export interface RejectionEventLike { reason?: unknown }

/** `message` plus where, plus the stack when the error carries one. */
export function describeErrorEvent(ev: ErrorEventLike): string {
  const where = ev.filename ? ` at ${ev.filename}:${ev.lineno ?? 0}:${ev.colno ?? 0}` : '';
  const stack = ev.error instanceof Error && ev.error.stack ? `\n${ev.error.stack}` : '';
  return `${ev.message ?? 'error'}${where}${stack}`;
}

export function describeRejection(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}${reason.stack ? `\n${reason.stack}` : ''}`;
  if (typeof reason === 'string') return reason;
  try {
    const json = JSON.stringify(reason);
    // JSON.stringify(undefined) is undefined, not a string.
    return json === undefined ? String(reason) : json;
  } catch { return String(reason); }
}

export interface InstallOptions {
  /** Entries allowed per window before the rest are dropped. */
  limit?: number;
  windowMs?: number;
  now?: () => number;
}

/** Subscribe. Bounded: a page throwing every frame would otherwise
 *  write a log entry every frame, so past `limit` entries within
 *  `windowMs` the rest are dropped and one entry says so. The sink is
 *  looked up per event, because the bridge that provides it is
 *  installed after this is. */
export function installRendererErrorLog(
  target: ErrorSource,
  sink: () => CrashSink | undefined,
  opts: InstallOptions = {},
): void {
  const limit = opts.limit ?? 20;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? (() => Date.now());
  let windowStart = now();
  let sent = 0;
  let saidDropping = false;

  const send = (kind: string, message: string) => {
    const t = now();
    if (t - windowStart >= windowMs) { windowStart = t; sent = 0; saidDropping = false; }
    const log = sink()?.logCrash;
    if (!log) return;
    if (sent >= limit) {
      if (!saidDropping) {
        saidDropping = true;
        try { log(`more than ${limit} errors in ${windowMs / 1000} s; the rest of this minute is not logged`, 'flood'); } catch { /* the log is best-effort */ }
      }
      return;
    }
    sent++;
    try { log(message, kind); } catch { /* the log is best-effort */ }
  };

  target.addEventListener('error', (ev) => send('error', describeErrorEvent(ev)));
  target.addEventListener('unhandledrejection', (ev) => send('rejection', describeRejection(ev.reason)));
}
