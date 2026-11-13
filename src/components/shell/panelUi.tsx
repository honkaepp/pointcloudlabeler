// Small building blocks shared by the tool panels (Survey, Height, Views &
// video): a titled section, buttons, a checkbox, a labelled field, a select,
// a warning and a note, all in the panels' mono style.

import type { ReactNode } from 'react';

export function Section({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
      <div className="flex items-baseline gap-2">
        <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>{title}</span>
        <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{sub}</span>
      </div>
      {children}
    </div>
  );
}

export function PathLine({ path, empty, label }: { path: string; empty?: string; label?: string }) {
  return (
    <div className="mono text-[9.5px] truncate" title={path} style={{ color: path ? 'var(--text-dim)' : 'var(--text-mute)' }}>
      {label && <span style={{ color: 'var(--text-mute)' }}>{label}: </span>}{path || empty || ''}
    </div>
  );
}

export function Btn({ children, onClick, disabled, title, primary }: { children: ReactNode; onClick: () => void; disabled?: boolean; title?: string; primary?: boolean }) {
  return (
    <button className={`btn ${primary ? 'btn-primary' : ''} !h-7 mono text-[10.5px] justify-center`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function LinkBtn({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="mono text-[9.5px] text-left" style={{ color: 'var(--text-mute)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }} onClick={onClick}>
      {children}
    </button>
  );
}

export function Check({ checked, onChange, disabled, title, children }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-1.5 mono text-[10px]" style={{ color: 'var(--text-dim)' }} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export function Labeled({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5" title={title}>
      <span className="mono" style={{ fontSize: 9, color: 'var(--text-mute)' }}>{label}</span>
      {children}
    </label>
  );
}

export function Choice<T extends string>({ value, onChange, options, disabled }: { value: T; onChange: (v: T) => void; options: Array<[T, string]>; disabled?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} disabled={disabled}
      className="mono text-[10.5px] rounded-md px-1.5 py-1"
      style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
      {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  );
}

export function Warn({ children }: { children: ReactNode }) {
  return (
    <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e6c068', background: 'rgba(230,192,104,0.08)', border: '1px solid rgba(230,192,104,0.35)', lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>{children}</div>;
}

