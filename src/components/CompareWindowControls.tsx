// The second window's controls (src-tauri/src/commands/
// compare_window.rs, state/compareWindow.ts): open it beside the editor
// with a dataset in it, link the two cameras and colour modes, put the
// windows side by side, close it. In the editor's module tabs it is a
// button that does what View → Second Window… does (secondWindowCommand,
// the one path both take) and a ▾ beside it whose menu holds the rest
// (the tabs leave no room once the windows share a screen); along the top
// of the second window, a strip.
//
// useCompareChannel keeps each page's idea of the other in step: the
// second window says hello when its page starts and the editor answers
// with the link; either closing says so.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useProject } from '../context/ProjectContext';
import { listOctrees, type OctreeListEntry } from '../persistence/octreeReader';
import {
  getCompare, setCompare, useCompare, type CameraLink, type CompareLink, type CompareMessage,
  type CompareState, type OutgoingCompareMessage as Outgoing,
} from '../state/compareWindow';
import { pushNotice } from '../state/notices';

export interface CompareBridge {
  windowLabel?: () => string;
  compareWindowOpen?: (dataset: string | null, sideBySide: boolean) => Promise<void>;
  compareWindowArrange?: () => Promise<void>;
  compareWindowIsOpen?: () => Promise<boolean>;
  compareWindowClose?: () => Promise<void>;
  windowClaimDataset?: (dir: string) => Promise<string | null>;
  windowReleaseDataset?: (dir: string) => Promise<void>;
  setReadOnlyDatasets?: (dirs: string[]) => void;
  compareSend?: (msg: Outgoing) => Promise<void>;
  onCompareMessage?: (cb: (msg: CompareMessage) => void) => Promise<() => void>;
  onCompareOpenDataset?: (cb: (dir: string) => void) => Promise<() => void>;
  onCompareWindowClosed?: (cb: () => void) => Promise<() => void>;
}

export function compareBridge(): CompareBridge | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as { desktop?: CompareBridge }).desktop;
}

export function sendCompare(msg: Outgoing): void {
  void compareBridge()?.compareSend?.(msg).catch(() => { /* the other page is gone */ });
}

/** Change the link here and in the other window. */
export function setLink(patch: Partial<CompareLink>): void {
  const link = { ...getCompare().link, ...patch };
  setCompare({ link });
  sendCompare({ kind: 'link', link });
}

/** Open the second window beside the editor, with `dir` open in it (or
 *  its dataset list when null). */
export async function openCompareWindow(dir: string | null): Promise<void> {
  const d = compareBridge();
  if (!d?.compareWindowOpen) throw new Error('The second window needs the desktop build.');
  await d.compareWindowOpen(dir, true);
  setCompare({ otherOpen: true });
}

/** View → Second Window… and the ⧉ button: one action. In the editor,
 *  open the second window beside it — its dataset list when it is new;
 *  brought forward and put back beside the editor when it is open. In the
 *  second window, the two side by side. A failure is shown as a notice,
 *  whichever of the two asked. */
export async function secondWindowCommand(): Promise<void> {
  try {
    if (getCompare().role === 'compare') await compareBridge()?.compareWindowArrange?.();
    else await openCompareWindow(null);
  } catch (e) {
    pushNotice({ kind: 'err', title: 'The second window did not open', text: e instanceof Error ? e.message : String(e) });
  }
}

/** What the editor's ⧉ button shows and runs. */
export function secondWindowButton(st: CompareState, hasProject: boolean): {
  label: string; title: string; disabled: boolean; run: () => Promise<void>;
} {
  const linked = `${st.link.camera === 'off' ? 'not linked' : st.link.camera}${st.link.colors ? ' · colours' : ''}`;
  return {
    label: st.otherOpen ? `⧉ ${linked}` : '⧉ Second window',
    title: !hasProject
      ? 'Open a project first'
      : st.otherOpen
        ? `Bring the second window forward, beside this one (View → Second Window…). Linked: ${linked}`
        : 'Open a second window beside this one, for another tree or cloud; choose its dataset there (View → Second Window…)',
    disabled: !hasProject,
    run: secondWindowCommand,
  };
}

/** Mounted once per page. */
export function useCompareChannel(): void {
  useEffect(() => {
    const d = compareBridge();
    if (!d?.onCompareMessage) return;
    const role = getCompare().role;
    const offs: Array<() => void> = [];
    let alive = true;
    const keep = (p: Promise<() => void> | undefined) => {
      void p?.then((u) => { if (alive) offs.push(u); else u(); }).catch(() => { /* ignore */ });
    };
    keep(d.onCompareMessage((msg) => {
      if (msg.kind === 'hello') {
        setCompare({ otherOpen: true });
        // The editor's link is the one both use.
        if (role === 'main') sendCompare({ kind: 'link', link: getCompare().link });
      } else if (msg.kind === 'bye') {
        if (role === 'main') setCompare({ otherOpen: false });
      } else if (msg.kind === 'link') {
        setCompare({ link: msg.link });
      }
    }));
    keep(d.onCompareWindowClosed?.(() => setCompare({ otherOpen: false })));
    if (role === 'compare') sendCompare({ kind: 'hello' });
    else void d.compareWindowIsOpen?.().then((open) => setCompare({ otherOpen: open })).catch(() => { /* ignore */ });
    const bye = () => sendCompare({ kind: 'bye' });
    window.addEventListener('beforeunload', bye);
    return () => {
      alive = false;
      for (const u of offs) u();
      window.removeEventListener('beforeunload', bye);
    };
  }, []);
}

const CAMERA: Array<{ v: CameraLink; label: string; title: string }> = [
  { v: 'off', label: 'off', title: 'Each window has its own camera' },
  { v: 'orbit', label: 'orbit', title: 'Turning and zooming in one window turns and zooms the other about its own centre — two trees side by side, seen from the same direction and distance' },
  { v: 'world', label: 'world', title: 'The same camera in world coordinates — two epochs or two processings of the same place' },
];

function CameraSeg({ value, onChange }: { value: CameraLink; onChange: (v: CameraLink) => void }) {
  return (
    <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
      {CAMERA.map(o => (
        <button key={o.v} title={o.title} className="mono text-[10px] px-2 py-0.5"
          style={{
            background: value === o.v ? 'color-mix(in oklch, var(--accent) 22%, transparent)' : 'transparent',
            color: value === o.v ? 'var(--accent)' : 'var(--text-dim)',
          }}
          onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

/** Link the cameras and the colours; side by side; close. */
function LinkControls({ onError }: { onError: (e: string) => void }) {
  const st = useCompare();
  const d = compareBridge();
  const isCompare = st.role === 'compare';
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span title="Link the two windows' cameras">camera</span>
      <CameraSeg value={st.link.camera} onChange={(v) => setLink({ camera: v })} />
      <label className="flex items-center gap-1" title="A colour mode chosen in one window is chosen in the other">
        <input type="checkbox" checked={st.link.colors} onChange={(e) => setLink({ colors: e.target.checked })} />colours
      </label>
      <button className="btn !h-6 !px-1.5 mono text-[10.5px]" title="The editor on the left half of its screen, the second window on the right"
        onClick={() => void d?.compareWindowArrange?.().catch((e: unknown) => onError(String(e)))}>⇆ side by side</button>
      <button className="btn !h-6 !px-1.5 mono text-[10.5px]" title="Close the second window"
        onClick={() => { void d?.compareWindowClose?.().then(() => { if (!isCompare) setCompare({ otherOpen: false }); }); }}>✕ close</button>
    </div>
  );
}

/** The editor's button and ▾ (`compact`, in the module tabs) or the
 *  second window's strip. */
export default function CompareWindowControls({ compact = true }: { compact?: boolean }) {
  const st = useCompare();
  const { project } = useProject();
  const [menu, setMenu] = useState<OctreeListEntry[] | null>(null);
  // Where the menu hangs: under the ▾, from the window's right edge.
  const [at, setAt] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  const d = compareBridge();

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !pop.current?.contains(t)) setMenu(null);
    };
    const gone = () => setMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', gone);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', gone);
    };
  }, [menu]);

  if (!d?.compareWindowOpen) return null;

  if (!compact || st.role === 'compare') {
    return (
      <div className="flex items-center gap-1.5 px-2 mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
        <LinkControls onError={setErr} />
        {err && <span style={{ color: '#e0506b' }} title={err}>!</span>}
      </div>
    );
  }

  const toggle = async () => {
    setErr(null);
    if (menu) { setMenu(null); return; }
    const r = box.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 4, right: Math.max(0, window.innerWidth - r.right) });
    try { setMenu(project?.folder ? await listOctrees(project.folder) : []); }
    catch { setMenu([]); }
  };
  const open = async (dir: string) => {
    setMenu(null);
    try { await openCompareWindow(dir); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const main = secondWindowButton(st, !!project);
  const on = st.otherOpen ? { color: 'var(--accent)', borderColor: 'var(--accent)' } : undefined;

  return (
    <div ref={box} className="flex items-center px-2 mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
      <button className="btn !h-6 mono text-[10.5px] !rounded-r-none" disabled={main.disabled} style={on}
        title={main.title} onClick={() => { setMenu(null); void main.run(); }}>{main.label}</button>
      <button className="btn !h-6 !px-1.5 mono text-[10.5px] !rounded-l-none" disabled={main.disabled}
        style={{ ...on, borderLeftWidth: 0 }}
        title={project ? 'Open one of this project’s datasets in the second window; link the two windows’ cameras and colours' : 'Open a project first'}
        aria-haspopup="menu" aria-expanded={!!menu}
        onClick={() => void toggle()}>▾</button>
      {err && <span className="ml-1" style={{ color: '#e0506b' }} title={err}>!</span>}
      {/* On the page itself: inside the module tabs it would sit under the
          editor below them, which is stacked at the same level and comes
          later — the menu opened unseen. */}
      {menu && createPortal(
        <div ref={pop} role="menu" className="fixed rounded-md py-1 max-h-[420px] overflow-y-auto scroll-thin mono text-[10px]"
          style={{ top: at.top, right: at.right, zIndex: 70, color: 'var(--text-dim)', background: 'var(--bg-elev, #0d1611)', border: '1px solid var(--line)', minWidth: 300, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
          {st.otherOpen && (
            <div className="px-2 py-1.5 flex flex-col gap-1" style={{ borderBottom: '1px solid var(--line)' }}>
              <div style={{ color: 'var(--text-mute)' }}>The second window is open</div>
              <LinkControls onError={setErr} />
            </div>
          )}
          <div className="px-2 py-1" style={{ color: 'var(--text-mute)' }}>Open in the second window</div>
          {menu.map(e => (
            <button key={e.dir} className="w-full text-left px-2 py-1 hover:bg-[var(--wash-1)]" style={{ color: 'var(--text)' }}
              title={e.dir} onClick={() => void open(e.dir)}>
              {e.name} <span style={{ color: 'var(--text-mute)' }}>· {e.pointCount.toLocaleString()} pts</span>
            </button>
          ))}
          {!st.otherOpen && (
            <button className="w-full text-left px-2 py-1 hover:bg-[var(--wash-1)]" style={{ color: 'var(--text-dim)' }}
              onClick={() => { setMenu(null); void main.run(); }}>{menu.length ? 'Choose there…' : 'Open it (no datasets yet)'}</button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
