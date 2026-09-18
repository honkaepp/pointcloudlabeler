// Reusable floating panel — drag-to-move, collapsible, persisted position
// per panel id (localStorage). Used by Tools / Display / History / Layers.
// The drag handle is the title row; clicks on the title itself toggle
// collapse so the body can hide without unmounting (preserves panel
// state). Pointer-events stay confined to the panel rectangle so it
// never blocks the viewport behind it.

import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  id: string;
  title: string;
  /** Initial position in pixels from the top-left of the parent. Used
   *  the very first time the panel is mounted; subsequent renders
   *  restore the position the user last dragged it to. */
  initial: { x: number; y: number };
  /** Optional fixed width — default 280. */
  width?: number;
  /** When false the panel renders nothing (and unmounts its tree).
   *  The shell uses this to wire visibility to the activity bar. */
  open: boolean;
  /** Right-side icon button slot (e.g. close ✕). */
  onClose?: () => void;
  children: React.ReactNode;
}

const STORAGE_PREFIX = 'pointcloudlabeler.panel.';

function loadPos(id: string, fallback: { x: number; y: number }) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + id);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    if (typeof v?.x === 'number' && typeof v?.y === 'number') return v;
  } catch { /* ignore */ }
  return fallback;
}
function savePos(id: string, p: { x: number; y: number }) {
  try { localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(p)); } catch { /* ignore */ }
}

export default function FloatingPanel({ id, title, initial, width = 280, open, onClose, children }: Props) {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => loadPos(id, initial));
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef<{ ox: number; oy: number; px: number; py: number } | null>(null);

  useEffect(() => { savePos(id, pos); }, [id, pos]);

  // Clamp on window resize so a panel dragged off-screen on a big
  // monitor doesn't vanish when the user later opens PointCloudLabeler on a smaller
  // one. Top edge is y=0 (flush against the TopBar above) so a panel
  // can be docked all the way up; bottom keeps a 40 px title-grab safe
  // gutter so a panel pushed nearly off-screen is still recoverable.
  useEffect(() => {
    const clamp = () => setPos(p => ({
      x: Math.max(0, Math.min(window.innerWidth - 80, p.x)),
      y: Math.max(0, Math.min(window.innerHeight - 60, p.y)),
    }));
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);

  const onDragDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { ox: pos.x, oy: pos.y, px: e.clientX, py: e.clientY };
  }, [pos]);
  const onDragMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const d = dragRef.current;
    setPos({
      x: Math.max(0, Math.min(window.innerWidth - 80, d.ox + e.clientX - d.px)),
      y: Math.max(0, Math.min(window.innerHeight - 60, d.oy + e.clientY - d.py)),
    });
  }, []);
  const onDragUp = useCallback((e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
  }, []);

  if (!open) return null;

  return (
    <div
      className="panel rounded-lg overflow-hidden absolute select-none"
      style={{
        left: pos.x, top: pos.y, width,
        zIndex: 25,
      }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-grab"
        style={{
          borderBottom: collapsed ? 'none' : '1px solid var(--line)',
          background: 'var(--wash-1)',
        }}
        onPointerDown={onDragDown}
        onPointerMove={onDragMove}
        onPointerUp={onDragUp}
        onDoubleClick={() => setCollapsed(c => !c)}
      >
        <button
          onClick={(e) => { e.stopPropagation(); setCollapsed(c => !c); }}
          onPointerDown={(e) => e.stopPropagation()}
          className="opacity-60 hover:opacity-100 transition-opacity"
          title={collapsed ? 'Expand' : 'Collapse'}
          style={{ color: 'var(--text-dim)' }}
        >
          {collapsed ? <CaretRight /> : <CaretDown />}
        </button>
        <div
          className="mono text-[10.5px] font-semibold flex-1"
          style={{ color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase' }}
        >
          {title}
        </div>
        {onClose && (
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="opacity-50 hover:opacity-100 transition-opacity"
            style={{ color: 'var(--text-dim)' }}
            title="Hide panel"
          >
            <XIcon />
          </button>
        )}
      </div>
      {!collapsed && (
        // Scrollable body so a panel whose contents overflow the visible
        // canvas (Terrain, Subset, Tree review, …) stays usable instead
        // of clipping below the status bar. Cap is computed from the
        // panel's top edge: the parent absolute container starts at the
        // ModuleTabs row (52 px) and sits below the TopBar (52 px), so
        // the panel's screen-Y is `52 + 52 + pos.y` ≈ pos.y + 104; leave
        // ~80 px for the status bar + StatusBanner + margin.
        <div
          className="p-3 scroll-thin"
          style={{ maxHeight: `calc(100vh - ${pos.y + 184}px)`, overflowY: 'auto' }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function CaretDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4l4 4 4-4" />
    </svg>
  );
}
function CaretRight() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2l4 4-4 4" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  );
}
