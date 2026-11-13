// The corner where state/notices.ts messages appear, above the
// status bar, in every module.

import { dismissNotice, useNotices, type Notice } from '../state/notices';

const TONE: Record<Notice['kind'], string> = {
  info: 'var(--text-dim)',
  ok: 'var(--accent)',
  warn: '#e6c068',
  err: '#f08a7e',
};

export default function NoticeStack() {
  const notices = useNotices();
  if (notices.length === 0) return null;
  return (
    <div className="fixed flex flex-col gap-2 items-end" style={{ right: 16, bottom: 40, zIndex: 80, width: 360, maxWidth: 'calc(100vw - 32px)', pointerEvents: 'none' }}>
      {notices.map((n) => (
        <div key={n.id} role={n.kind === 'err' ? 'alert' : 'status'} className="panel rounded-md px-3 py-2 w-full flex flex-col gap-1"
          style={{ pointerEvents: 'auto', borderLeft: `3px solid ${TONE[n.kind]}`, boxShadow: '0 12px 32px -12px rgba(0,0,0,0.6)' }}>
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-[12px]" style={{ color: 'var(--text)', lineHeight: 1.4 }}>{n.title}</div>
              {n.text && (
                <div className="mono text-[10px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{n.text}</div>
              )}
            </div>
            <button className="mono text-[11px]" title="Dismiss" onClick={() => dismissNotice(n.id)}
              style={{ background: 'none', border: 'none', color: 'var(--text-mute)', cursor: 'pointer', padding: 0 }}>✕</button>
          </div>
          {n.progress !== undefined && (
            <div className="w-full rounded-full overflow-hidden" style={{ height: 3, background: 'var(--wash-3)' }}>
              <div style={{ width: `${Math.max(0, Math.min(100, n.progress)).toFixed(1)}%`, height: '100%', background: TONE[n.kind] === 'var(--text-dim)' ? 'var(--accent)' : TONE[n.kind], transition: 'width 0.15s' }} />
            </div>
          )}
          {n.action && (
            <div className="flex justify-end">
              <button className="btn !h-6 !px-2 mono text-[10.5px]" onClick={() => { n.action?.run(); dismissNotice(n.id); }}>{n.action.label}</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
