// The camera and colour link between the editor and the second
// window (state/compareWindow.ts). Draws nothing.
//
// Each page watches its own camera every frame. A move it did not make
// itself goes to the other page as a pose in world coordinates; a pose
// that comes in is put on this camera ('world': as it is; 'orbit': its
// direction and distance about this window's own target) and remembered,
// so the move it causes here is not sent back. Whichever window the user
// is moving leads; the other follows.
//
// Colours the same way: a colour mode chosen here is sent, one taken from
// the other window is not sent back. When the link is made (or the second
// window opens a dataset) the editor's colour mode is the one both start
// with — were both to send theirs, each would take the other's, forever.

import { useEffect, useRef } from 'react';
import { useOctreeShell, type ColorMode } from './OctreeShellContext';
import { viewer } from './viewToolsStore';
import { followPose, poseToWorld, posesClose, useCompare, type ScenePose, type Vec3 } from '../../state/compareWindow';
import { compareBridge, sendCompare } from '../CompareWindowControls';

export default function CompareSync() {
  const { octree, display, setDisplay } = useOctreeShell();
  const st = useCompare();
  const offset = (octree?.meta.offset ?? null) as Vec3 | null;
  const camera = st.otherOpen ? st.link.camera : 'off';
  const colors = st.otherOpen && st.link.colors;
  const last = useRef<ScenePose | null>(null);
  const colorMode = useRef(display.colorMode);
  colorMode.current = display.colorMode;
  const remoteColor = useRef<ColorMode | null>(null);
  const prevColor = useRef<ColorMode | null>(null);

  // Out: this camera's moves.
  useEffect(() => {
    if (camera === 'off' || !offset) return;
    let raf = 0;
    last.current = null;
    const tick = () => {
      const v = viewer();
      if (v) {
        const p = v.getPose() as ScenePose;
        if (!last.current || !posesClose(p, last.current)) {
          // The first look is only a baseline: making the link must not
          // throw the other window's camera to wherever this one is.
          if (last.current) sendCompare({ kind: 'pose', world: poseToWorld(p, offset) });
          last.current = p;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [camera, offset]);

  // In: the other window's moves and colour mode.
  useEffect(() => {
    const d = compareBridge();
    if (!d?.onCompareMessage || !offset) return;
    let off: (() => void) | null = null;
    let alive = true;
    void d.onCompareMessage((msg) => {
      if (msg.kind === 'pose' && camera !== 'off') {
        const v = viewer();
        if (!v) return;
        const next = followPose(camera, msg.world, v.getPose() as ScenePose, offset);
        if (!next) return;
        v.setPose(next);
        last.current = v.getPose() as ScenePose;
      } else if (msg.kind === 'color' && colors) {
        remoteColor.current = msg.colorMode;
        if (msg.colorMode !== colorMode.current) setDisplay({ colorMode: msg.colorMode });
      } else if (msg.kind === 'hello' && colors && st.role === 'main') {
        // The second window has a dataset now: it takes the editor's colours.
        sendCompare({ kind: 'color', colorMode: colorMode.current });
      }
    }).then((u) => { if (alive) off = u; else u(); });
    return () => { alive = false; off?.(); };
  }, [camera, colors, offset, setDisplay, st.role]);

  // Out: a colour mode chosen here.
  useEffect(() => {
    const mode = display.colorMode;
    const changed = prevColor.current !== null && prevColor.current !== mode;
    prevColor.current = mode;
    if (!colors || !octree) return;
    if (changed) {
      if (mode !== remoteColor.current) sendCompare({ kind: 'color', colorMode: mode });
    } else if (st.role === 'main') {
      sendCompare({ kind: 'color', colorMode: mode });
    } else {
      // The second window, its dataset just opened: ask for the editor's.
      sendCompare({ kind: 'hello' });
    }
  }, [display.colorMode, colors, octree, st.role]);

  return null;
}
