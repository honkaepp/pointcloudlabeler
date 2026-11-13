// Short messages from things that happen away from where the user
// is looking: where a dropped file went, an archive being unpacked, a
// processing run that finished while its panel was closed. Shown by
// components/NoticeStack.tsx in the corner of every module.

import { useSyncExternalStore } from 'react';

export interface NoticeAction { label: string; run: () => void }

export interface Notice {
  id: number;
  kind: 'info' | 'ok' | 'warn' | 'err';
  title: string;
  text?: string;
  action?: NoticeAction;
  /** 0–100 while something runs; undefined otherwise. */
  progress?: number;
  /** Stays until dismissed (errors, and anything still running). */
  sticky?: boolean;
}

let notices: Notice[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** How long a notice that is not sticky stays (ms). */
export const NOTICE_MS = 9000;
const MAX_NOTICES = 5;

function emit(): void {
  for (const l of listeners) l();
}

function schedule(n: Notice): void {
  const t = timers.get(n.id);
  if (t) clearTimeout(t);
  timers.delete(n.id);
  if (n.sticky || n.kind === 'err' || n.progress !== undefined) return;
  timers.set(n.id, setTimeout(() => dismissNotice(n.id), NOTICE_MS));
}

export function pushNotice(n: Omit<Notice, 'id'>): number {
  const notice = { ...n, id: nextId++ };
  notices = [...notices, notice].slice(-MAX_NOTICES);
  schedule(notice);
  emit();
  return notice.id;
}

export function updateNotice(id: number, patch: Partial<Omit<Notice, 'id'>>): void {
  let changed: Notice | null = null;
  notices = notices.map((n) => (n.id === id ? (changed = { ...n, ...patch }) : n));
  if (changed) schedule(changed);
  emit();
}

export function dismissNotice(id: number): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  notices = notices.filter((n) => n.id !== id);
  emit();
}

export function getNotices(): Notice[] {
  return notices;
}

export function useNotices(): Notice[] {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    getNotices,
    getNotices,
  );
}

/** For tests. */
export function resetNotices(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  notices = [];
  emit();
}
