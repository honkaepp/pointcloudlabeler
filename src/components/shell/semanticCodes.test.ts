// The semantic codes mean one thing everywhere: 1 stem, 2 branch, 4 leaf
// (3 is the patches' "cleared"). The leaf/wood separation used to write
// 1 = wood and 2 = leaf, which the editor showed as stem and branch.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { stripComments } from '../../testing/sourceScan';
import { SEMANTIC_OPTIONS } from './FiltersPanel';
import { colorNode, type LoadedNode } from '../../three/OctreeView';
import { KEY_ACTIONS } from '../../state/keybindings';

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('the semantic codes', () => {
  it('stem, branch and leaf in the filters and the legend, never 3', () => {
    expect(SEMANTIC_OPTIONS.map((o) => [o.code, o.label])).toEqual([[0, 'Unlabelled'], [1, 'Stem'], [2, 'Branch'], [4, 'Leaf']]);
    expect(read('./ColorLegend.tsx')).toContain('const SEMANTIC_DOMAIN_MAX = 4;');
  });
  it('the viewer colours stem brown, branch wood tan and leaf green; the tools and a key label it, the export keeps it', () => {
    const n = 5;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(n * 3), 3, true));
    const ln = {
      geom, positions: new Float32Array(n * 3), treeIds: new Int32Array(n), intensity: new Uint16Array(n),
      classification: new Uint8Array(n), returnNumber: new Uint8Array(n), semantic: Uint8Array.from([0, 1, 2, 4, 3]),
      extras: {}, selection: null, dim: new Uint8Array(n), visibility: new Uint8Array(n).fill(1), strays: 0,
      standingDeadwood: null, layingDeadwood: null, tile: 0, record: 0,
    } as unknown as LoadedNode;
    colorNode(ln, 'semantic', 'viridis', { tree: 0, standing: 0, laying: 0 }, [255, 0, 255], undefined, {}, [120, 120, 120]);
    const c = Array.from(geom.attributes.color.array as Uint8Array);
    expect(c.slice(0, 3)).toEqual([120, 120, 120]);
    expect(c.slice(3, 6)).toEqual([175, 110, 60]);
    expect(c.slice(6, 9)).toEqual([225, 165, 95]);
    expect(c.slice(9, 12)).toEqual([70, 180, 90]);
    expect(c.slice(12, 15)).toEqual([120, 120, 120]);
    // the edit API takes leaf
    expect(read('../../three/OctreeView.tsx')).toContain('semantic?: 0 | 1 | 2 | 3 | 4;');
    expect(read('./ToolsPanel.tsx')).toContain('api?.apply({ semantic: 4 })');
    expect(KEY_ACTIONS.find((a) => a.id === 'edit.semLeaf')?.defaultChord).toBe('4');
    const rs = read('../../../src-tauri/src/commands/octree.rs');
    expect(rs).toContain('let sem_out = if sem == 1 || sem == 2 || sem == 4 { sem } else { 0 };');
    expect(rs).toContain('pub const SEM_LEAF: u8 = 4;');
  });
});
