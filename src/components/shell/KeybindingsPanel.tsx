// Keybindings panel — view + customize every editor shortcut. Click a
// chord to record a new one; ✕ clears it, ↺ restores the default. Changes
// persist immediately (settings.json via the localStorage mirror) and the
// global dispatcher in EditorShell picks them up live.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KEY_ACTIONS, useKeybindings, setBinding, resetBinding, resetAllBindings,
  eventToChord, formatChord, isModifierOnly, setRecording,
  type KeyActionId,
} from '../../state/keybindings';
import { confirmDialog } from '../../ui/dialogs';

export default function KeybindingsPanel() {
  const bindings = useKeybindings();
  const [recordingId, setRecordingId] = useState<KeyActionId | null>(null);

  // Group actions for display, preserving KEY_ACTIONS order within a group.
  const groups = useMemo(() => {
    const out: { name: string; items: typeof KEY_ACTIONS[number][] }[] = [];
    for (const a of KEY_ACTIONS) {
      let g = out.find(x => x.name === a.group);
      if (!g) { g = { name: a.group, items: [] }; out.push(g); }
      g.items.push(a);
    }
    return out;
  }, []);

  // Reverse map chord→id to flag conflicts (shouldn't happen — setBinding
  // clears the loser — but a stale settings.json could carry one).
  const chordOwner = useMemo(() => {
    const m = new Map<string, KeyActionId>();
    for (const a of KEY_ACTIONS) {
      const c = bindings[a.id];
      if (c) m.set(c, a.id);
    }
    return m;
  }, [bindings]);

  // While recording, capture the next non-modifier keydown as the chord.
  // setRecording() tells the global dispatcher to stand down meanwhile.
  useEffect(() => {
    if (!recordingId) { setRecording(false); return; }
    setRecording(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setRecordingId(null); return; } // cancel
      if (isModifierOnly(e)) return;                            // wait for the key
      setBinding(recordingId, eventToChord(e));
      setRecordingId(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      setRecording(false);
    };
  }, [recordingId]);

  return (
    <div className="flex flex-col gap-2.5" style={{ width: 290 }}>
      <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        Click a shortcut to rebind it, then press the keys. <span style={{ color: 'var(--text-dim)' }}>Esc</span> cancels recording. Shortcuts are ignored while typing in a field.
      </div>

      <div className="flex flex-col gap-2.5 max-h-[460px] overflow-y-auto scroll-thin pr-0.5">
        {groups.map(g => (
          <div key={g.name}>
            <div className="chip mb-1">{g.name}</div>
            <div className="flex flex-col gap-0.5">
              {g.items.map(a => {
                const chord = bindings[a.id];
                const conflict = chord !== '' && chordOwner.get(chord) !== a.id;
                const isRec = recordingId === a.id;
                return (
                  <div key={a.id} className="flex items-center gap-2 px-1.5 py-1 rounded-md" style={{ background: 'rgba(0,0,0,0.16)' }}>
                    <div className="min-w-0 flex-1">
                      <div className="mono text-[11px] truncate" style={{ color: 'var(--text)' }}>{a.label}</div>
                      {a.hint && <div className="mono text-[8.5px] truncate" style={{ color: 'var(--text-mute)' }}>{a.hint}</div>}
                    </div>
                    <button
                      onClick={() => setRecordingId(isRec ? null : a.id)}
                      className="mono text-[10.5px] px-2 py-1 rounded-md shrink-0 transition-all"
                      style={{
                        minWidth: 56, textAlign: 'center',
                        background: isRec ? 'color-mix(in oklch, var(--accent) 20%, transparent)' : 'var(--wash-2)',
                        border: `1px solid ${isRec ? 'var(--accent)' : conflict ? 'var(--danger, #e0506b)' : 'var(--line)'}`,
                        color: isRec ? 'var(--accent)' : chord ? 'var(--text)' : 'var(--text-mute)',
                      }}
                      title={isRec ? 'Press the new shortcut (Esc to cancel)' : conflict ? 'Conflicts with another action' : 'Click to rebind'}
                    >
                      {isRec ? 'press…' : formatChord(chord)}
                    </button>
                    <button
                      onClick={() => setBinding(a.id, '')}
                      disabled={!chord}
                      className="mono text-[11px] shrink-0"
                      style={{ width: 16, color: chord ? 'var(--text-mute)' : 'transparent' }}
                      title="Clear (unbind)"
                    >✕</button>
                    <button
                      onClick={() => resetBinding(a.id)}
                      className="mono text-[12px] shrink-0"
                      style={{ width: 16, color: chord === a.defaultChord ? 'var(--text-mute)' : 'var(--accent)' }}
                      title={`Restore default (${formatChord(a.defaultChord)})`}
                    >↺</button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <button
        className="btn !h-7 w-full justify-center mono text-[11px]"
        onClick={async () => { if (await confirmDialog('Restore every shortcut to its default?')) resetAllBindings(); }}
      >
        Reset all to defaults
      </button>
    </div>
  );
}
