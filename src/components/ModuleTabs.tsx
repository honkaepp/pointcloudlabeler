// Module tab strip pinned to the top of the window. The user switches
// between Editor / Inventory / Metrics; module state persists while not
// active so flipping tabs is cheap.
//
// Styling matches the editor shell: a flat, hairline-bordered, glass
// strip that reads as part of the same product as the TopBar (rather
// than a floating capsule overlaid on it). The active module is marked
// by the accent green underline + foreground colour; inactive labels
// stay calm so the editor's content owns the visual hierarchy.

import { PointCloudLabelerLogoMark, PointCloudLabelerWordmark } from './PointCloudLabelerLogo';
import JobsIndicator from './JobsIndicator';
import CompareWindowControls from './CompareWindowControls';
import type { ProjectState } from '../persistence/projectStore';
import { EDITION, preprocessingTabSub } from '../build/edition';

export type ModuleId = 'editor' | 'preprocessing' | 'inventory' | 'metrics' | 'figures';

interface Props {
  active: ModuleId;
  onChange: (id: ModuleId) => void;
  /** The open project, by name; a click renames it. */
  project?: ProjectState | null;
  onRenameProject?: () => void;
}

const TABS: Array<{ id: ModuleId; label: string; sub: string }> = [
  { id: 'editor',        label: 'Editor',        sub: 'cloud · segment · save' },
  // where all data comes in
  { id: 'preprocessing', label: 'Data',          sub: preprocessingTabSub(EDITION) },
  { id: 'inventory',     label: 'Inventory',     sub: 'stands · plots · trees' },
  { id: 'metrics',       label: 'Metrics',       sub: 'plugins · DBH · height' },
  { id: 'figures',       label: 'Figures',       sub: 'panels · views · compose' },
];

const HEIGHT = 52;

export default function ModuleTabs({ active, onChange, project, onRenameProject }: Props) {
  return (
    <div
      className="absolute top-0 left-0 right-0 z-40 flex items-stretch px-3 hairline-b"
      style={{
        height: HEIGHT,
        background: 'rgba(8, 14, 11, 0.92)',
        backdropFilter: 'blur(20px) saturate(140%)',
        WebkitBackdropFilter: 'blur(20px) saturate(140%)',
      }}
    >
      {/* Brand mark — anchors the strip to the PointCloudLabeler identity in every module. */}
      <div className="flex items-center gap-2 pr-4 select-none" style={{ borderRight: '1px solid var(--line)' }}>
        <PointCloudLabelerLogoMark size={20} />
        <PointCloudLabelerWordmark size={12} />
      </div>

      {/* Which project this is — its folder's name — and Rename Project… */}
      {project && (
        <button
          onClick={onRenameProject}
          className="group flex flex-col items-start justify-center px-3 min-w-0"
          style={{ maxWidth: 220, borderRight: '1px solid var(--line)' }}
          title={`${project.folder}\nClick to rename the project (its folder too)`}
          aria-label={`Project ${project.meta.name}. Rename project…`}
        >
          <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>project</span>
          <span className="flex items-center gap-1.5 w-full min-w-0">
            <span className="text-[12px] truncate" style={{ color: 'var(--text)' }}>{project.meta.name}</span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              className="shrink-0 opacity-40 group-hover:opacity-100" style={{ color: 'var(--accent)' }}>
              <path d="M4 20h4L19 9l-4-4L4 16v4z" />
            </svg>
          </span>
        </button>
      )}

      <div className="flex items-stretch">
        {TABS.map(t => (
          <TabButton
            key={t.id}
            label={t.label}
            sub={t.sub}
            active={t.id === active}
            onClick={() => onChange(t.id)}
          />
        ))}
      </div>

      <div className="flex-1" />
      {/* The second window beside this one */}
      <CompareWindowControls />
      {/* What is running, from every module */}
      <JobsIndicator onGo={onChange} />
    </div>
  );
}

function TabButton({ label, sub, active, onClick }: {
  label: string;
  sub: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="relative flex flex-col items-start justify-center px-4 py-1 transition-all"
      style={{ minWidth: 130 }}
      title={sub}
      aria-pressed={active}
    >
      <span
        className="text-[12.5px] font-medium tracking-wide"
        style={{ color: active ? 'var(--accent)' : 'var(--text)' }}
      >
        {label}
      </span>
      <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
        {sub}
      </span>
      {/* Active indicator — a thin accent rule along the bottom that
          reads as a tab affordance without the heavy filled-pill look
          the old design used. */}
      <span
        className="absolute left-3 right-3 bottom-0 rounded-t-sm transition-opacity"
        style={{
          height: 2,
          background: 'var(--accent)',
          boxShadow: active ? '0 0 8px color-mix(in oklch, var(--accent) 60%, transparent)' : 'none',
          opacity: active ? 1 : 0,
        }}
      />
    </button>
  );
}
