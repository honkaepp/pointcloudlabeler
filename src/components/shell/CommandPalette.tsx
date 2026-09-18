// Command palette (⌘K) — fuzzy-ish action launcher. Linear/Figma style:
// a single centred input over a dimmed backdrop, arrow-key navigation,
// Enter to run. Commands are supplied by the shell so everything the
// toolbar / panels can do is reachable from the keyboard. Matching is a
// simple case-insensitive subsequence test — fast, no dependency, and
// good enough for a few dozen commands.

import { useEffect, useMemo, useRef, useState } from 'react';

export interface Command {
  id: string;
  title: string;
  /** Optional grouping label shown as a section header. */
  group?: string;
  /** Optional keyboard hint shown on the right (e.g. "⌘S"). */
  hint?: string;
  /** Optional keyword string folded into the match text. */
  keywords?: string;
  run: () => void;
  disabled?: boolean;
}

interface Props {
  commands: Command[];
  onClose: () => void;
}

function subsequence(query: string, text: string): boolean {
  if (!query) return true;
  let qi = 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

export default function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = useMemo(() => {
    const items = commands.filter(c => !c.disabled && subsequence(query, c.title + ' ' + (c.keywords ?? '')));
    return items;
  }, [commands, query]);

  useEffect(() => { setActive(0); }, [query]);

  // Keep the active row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${active}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (cmd?: Command) => {
    if (!cmd) return;
    onClose();
    // Defer so the palette is gone before the action paints.
    requestAnimationFrame(() => cmd.run());
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(filtered.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(filtered[active]); }
  };

  // Render with lightweight group headers when the active query is empty.
  let lastGroup: string | undefined;

  return (
    <div
      className="fixed inset-0 flex items-start justify-center"
      style={{ zIndex: 100, background: 'rgba(2,6,4,0.55)', backdropFilter: 'blur(3px)', paddingTop: '14vh' }}
      onClick={onClose}
    >
      <div
        className="panel rounded-xl overflow-hidden"
        style={{ width: 560, maxWidth: '92vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4" style={{ borderBottom: '1px solid var(--line)' }}>
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Type a command…"
            className="flex-1 bg-transparent py-3.5 text-[14px] outline-none"
            style={{ color: 'var(--text)', border: 'none' }}
          />
          <span className="kbd">esc</span>
        </div>

        <div ref={listRef} className="max-h-[46vh] overflow-y-auto scroll-thin py-1.5">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center mono text-[12px]" style={{ color: 'var(--text-mute)' }}>
              No matching command
            </div>
          ) : filtered.map((c, i) => {
            const showGroup = c.group && c.group !== lastGroup;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {showGroup && (
                  <div className="px-4 pt-2 pb-1 chip">{c.group}</div>
                )}
                <button
                  data-idx={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(c)}
                  className="w-full flex items-center gap-3 px-4 py-2 text-left transition-colors"
                  style={{ background: i === active ? 'color-mix(in oklch, var(--accent) 14%, transparent)' : 'transparent' }}
                >
                  <span className="text-[13px]" style={{ color: i === active ? 'var(--text)' : 'var(--text-dim)' }}>
                    {c.title}
                  </span>
                  {c.hint && <span className="kbd ml-auto">{c.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-mute)" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-3.5-3.5" />
    </svg>
  );
}
