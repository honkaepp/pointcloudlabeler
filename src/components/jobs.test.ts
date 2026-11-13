// Long jobs are seen from every module, and their end is told.

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';
import { callAttention, getJobs, setJob } from '../state/jobs';
import { endNoticeFor } from './JobsIndicator';

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('the job registry', () => {
  afterEach(() => { setJob('a', null); setJob('b', null); });
  it('sets, replaces and clears a job by its id', () => {
    setJob('a', { label: 'Converting x.laz', stage: 'bin', pct: 10, module: 'editor' });
    setJob('b', { label: 'Unpacking Scans.zip', stage: 'x', pct: null, module: 'preprocessing' });
    setJob('a', { label: 'Converting x.laz', stage: 'build', pct: 60, module: 'editor' });
    expect(getJobs().map((j) => [j.id, j.stage])).toEqual([['b', 'x'], ['a', 'build']]);
    setJob('a', null);
    expect(getJobs().map((j) => j.id)).toEqual(['b']);
  });
  it('a window not in front says it in its title until focused', () => {
    const handlers: Array<() => void> = [];
    const g = globalThis as Record<string, unknown>;
    g.document = { title: 'PointCloudLabeler — Forest point cloud editor', hasFocus: () => false };
    g.window = { addEventListener: (_: string, h: () => void) => handlers.push(h) };
    try {
      callAttention('Conversion done');
      const doc = g.document as { title: string };
      expect(doc.title).toBe('● Conversion done — PointCloudLabeler — Forest point cloud editor');
      handlers.forEach((h) => h());
      expect(doc.title).toBe('PointCloudLabeler — Forest point cloud editor');
    } finally {
      delete g.document;
      delete g.window;
    }
  });
});

describe('the end of a run', () => {
  it('is told as failed, stopped or done', () => {
    expect(endNoticeFor('Forest pass', { error: 'no stems', note: null }, () => 'x'))
      .toMatchObject({ kind: 'err', title: 'Forest pass failed', text: 'no stems', attention: true, show: true });
    expect(endNoticeFor('Unpacking', { error: null, note: 'Stopped — …' }, () => 'x'))
      .toMatchObject({ kind: 'info', title: 'Unpacking stopped', attention: false });
    expect(endNoticeFor('Crop', { error: null, note: null }, () => 'Kept 1 of 2 points.'))
      .toMatchObject({ kind: 'ok', title: 'Crop done', text: 'Kept 1 of 2 points.', attention: true });
  });
  it('is watched from the module strip; the editor and the door report their jobs', () => {
    expect(read('./ModuleTabs.tsx')).toContain('<JobsIndicator onGo={onChange} />');
    const editor = read('../modules/EditorModule.tsx');
    expect(editor).toContain("setJob('editor-convert', { label: `Converting ${p.fileName}`, stage, pct: pct * 100, module: 'editor' });");
    expect(editor).toContain("setJob('editor-convert', null);");
    const door = read('./DataDoor.tsx');
    expect(door).toContain("setJob('data-extract', null);");
  });
});
