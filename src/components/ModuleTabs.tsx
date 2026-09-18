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
import { EDITION, preprocessingTabSub } from '../build/edition';

export type ModuleId = 'editor' | 'preprocessing' | 'inventory' | 'metrics' | 'figures';

interface Props {
  active: ModuleId;
  onChange: (id: ModuleId) => void;
}

const TABS: Array<{ id: ModuleId; label: string; sub: string }> = [
  { id: 'editor',        label: 'Editor',        sub: 'cloud · segment · save' },
  { id: 'preprocessing', label: 'Preprocessing', sub: preprocessingTabSub(EDITION) },
  { id: 'inventory',     label: 'Inventory',     sub: 'stands · plots · trees' },
  { id: 'metrics',       label: 'Metrics',       sub: 'plugins · DBH · height' },
  { id: 'figures',       label: 'Figures',       sub: 'panels · views · compose' },
];

const HEIGHT = 52;

export default function ModuleTabs({ active, onChange }: Props) {
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
