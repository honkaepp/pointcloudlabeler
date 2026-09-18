// Tells the person what happened when the interface they were looking at
// went away. Shown by App after a reload the Rust side did because the
// renderer process died (src-tauri/src/crash.rs). The Rust side
// remembers the failure for as long as it runs; this asks once, at
// mount, and says it.

import { useEffect, useState } from 'react';
import { describeRendererFailure, type RendererFailure } from '../persistence/rendererFailure';

interface Desktop {
  rendererLastFailure?: () => Promise<RendererFailure | null>;
  crashLogLocation?: () => Promise<string | null>;
}

const DISMISSED_KEY = 'pointcloudlabeler.rendererFailure.dismissedAt';

function wasDismissed(f: RendererFailure): boolean {
  try { return localStorage.getItem(DISMISSED_KEY) === String(f.at); } catch { return false; }
}
function markDismissed(f: RendererFailure) {
  try { localStorage.setItem(DISMISSED_KEY, String(f.at)); } catch { /* per-viewer convenience only */ }
}

export default function RendererCrashNotice() {
  const [failure, setFailure] = useState<RendererFailure | null>(null);
  const [logPath, setLogPath] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const desktop = (window as unknown as { desktop?: Desktop }).desktop;
    if (!desktop?.rendererLastFailure) return;
    let live = true;
    Promise.all([desktop.rendererLastFailure(), desktop.crashLogLocation?.() ?? Promise.resolve(null)])
      .then(([f, path]) => {
        if (!live || !f || wasDismissed(f)) return;
        setFailure(f);
        setLogPath(path ?? null);
      })
      .catch(() => { /* nothing to report is the common case */ });
    return () => { live = false; };
  }, []);

  if (!failure || dismissed) return null;
  const { title, detail } = describeRendererFailure(failure, logPath);
  return (
    <div
      className="panel rounded-md p-3 fixed left-1/2 -translate-x-1/2 select-text"
      style={{ top: 64, zIndex: 200, maxWidth: 640, width: 'calc(100vw - 32px)', borderColor: 'color-mix(in oklch, #e6c068 55%, transparent)' }}
      role="alert"
    >
      <div className="flex items-start gap-2">
        <span style={{ width: 9, height: 9, borderRadius: 999, background: '#e6c068', display: 'inline-block', marginTop: 4, flexShrink: 0 }} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px]" style={{ color: 'var(--text)' }}>{title}</div>
          <div className="mono text-[10.5px] mt-1" style={{ color: 'var(--text-dim)', lineHeight: 1.5, wordBreak: 'break-word' }}>{detail}</div>
        </div>
        <button
          className="btn !h-7 !px-2 mono text-[11px] shrink-0"
          onClick={() => { markDismissed(failure); setDismissed(true); }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
