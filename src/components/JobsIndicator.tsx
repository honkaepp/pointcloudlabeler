// What is running, seen from every module: the editor's octree conversion,
// an archive being unpacked. Drawn in the module strip; a click goes to the
// module the job belongs to.

import type { ModuleId } from './ModuleTabs';
import { useJobs } from '../state/jobs';

interface Props {
  onGo: (m: ModuleId) => void;
}

interface Shown { id: string; label: string; stage: string; pct: number | null; go: () => void }

/** The notice for a run that ended: failed (the store's error), stopped (its
 *  note) or done (what it gave); `attention` when the window should say so. */
export function endNoticeFor(title: string, s: { error: string | null; note: string | null }, outcome: () => string):
  { kind: 'err' | 'info' | 'ok'; title: string; text: string; attention: boolean; show: boolean } {
  if (s.error) return { kind: 'err', title: `${title} failed`, text: s.error, attention: true, show: true };
  if (s.note) return { kind: 'info', title: `${title} stopped`, text: s.note, attention: false, show: false };
  return { kind: 'ok', title: `${title} done`, text: outcome(), attention: true, show: true };
}

export default function JobsIndicator({ onGo }: Props) {
  const jobs = useJobs();
  const shown: Shown[] = jobs.map((j) => ({ id: j.id, label: j.label, stage: j.stage, pct: j.pct, go: () => onGo(j.module) }));
  if (shown.length === 0) return null;

  return (
    <div className="flex items-center gap-2 pl-3" role="status" aria-label="Running jobs">
      {shown.slice(0, 3).map((j) => (
        <button key={j.id} onClick={j.go} title={`${j.label} — ${j.stage}${j.pct !== null ? ` (${j.pct.toFixed(0)} %)` : ''}. Click to show it.`}
          className="flex flex-col justify-center gap-1 rounded-md px-2.5"
          style={{ height: 34, minWidth: 150, maxWidth: 230, border: '1px solid var(--line)', background: 'var(--wash-1)', cursor: 'pointer' }}>
          <span className="flex items-center gap-1.5 mono text-[10px] w-full" style={{ color: 'var(--text)' }}>
            <span className="rounded-full shrink-0 animate-pulse" style={{ width: 6, height: 6, background: 'var(--accent)' }} />
            <span className="truncate">{j.label}</span>
            {j.pct !== null && <span className="ml-auto tnum" style={{ color: 'var(--accent)' }}>{j.pct.toFixed(0)}%</span>}
          </span>
          <span className="block w-full rounded-full overflow-hidden" style={{ height: 2, background: 'var(--wash-3)' }}>
            <span className="block" style={{ width: `${Math.max(2, Math.min(100, j.pct ?? 100)).toFixed(1)}%`, height: '100%', background: 'var(--accent)', opacity: j.pct === null ? 0.4 : 1, transition: 'width 0.2s' }} />
          </span>
        </button>
      ))}
      {shown.length > 3 && <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>+{shown.length - 3}</span>}
    </div>
  );
}
