// The open project's coordinate system, shown and changed where data comes
// in (the Data tab). It is the project's record; each dataset keeps its own.

import { useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { COORD_PRESETS, type ProjectMeta } from '../../persistence/projectStore';

interface MetaDesktop { projectSaveMeta?: (patch: Partial<ProjectMeta>) => Promise<ProjectMeta> }

/** "EPSG:3067 + N2000", or null when the project has none. */
export function crsLabel(crs: ProjectMeta['coordinateSystem'] | null | undefined): string | null {
  if (!crs?.epsg) return null;
  return `EPSG:${crs.epsg}${crs.vertical ? ` + ${crs.vertical}` : ''}`;
}

export default function ProjectCrs() {
  const { project, setProject } = useProject();
  const [editing, setEditing] = useState(false);
  const [custom, setCustom] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!project) return null;
  const crs = project.meta.coordinateSystem;
  const label = crsLabel(crs);

  const save = async (next: ProjectMeta['coordinateSystem']) => {
    setErr(null);
    const d = (window as unknown as { desktop?: MetaDesktop }).desktop;
    if (!d?.projectSaveMeta) return;
    try {
      const meta = await d.projectSaveMeta({ coordinateSystem: next });
      setProject({ ...project, meta });
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const presetIndex = COORD_PRESETS.findIndex((p) => p.epsg === crs?.epsg);
  return (
    <div className="flex items-center gap-2 mono text-[10.5px] flex-wrap" style={{ color: 'var(--text-mute)' }}
      title="The project's coordinate system, as recorded in project.json. Each imported dataset keeps its own coordinate system.">
      <span>Project coordinate system</span>
      {!editing ? (
        <>
          <span style={{ color: label ? 'var(--accent)' : 'var(--text-dim)' }}>{label ?? 'not set'}</span>
          <button className="mono text-[10.5px]" onClick={() => setEditing(true)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-mute)', textDecoration: 'underline' }}>
            change
          </button>
        </>
      ) : (
        <>
          <select className="mono text-[10.5px] rounded-md px-1.5 py-1" autoFocus
            style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
            value={presetIndex >= 0 ? String(presetIndex) : crs?.epsg ? 'custom' : 'none'}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'none') void save({ epsg: null, name: 'unknown' });
              else if (v !== 'custom') {
                const p = COORD_PRESETS[parseInt(v, 10)];
                void save({ epsg: p.epsg, name: p.name, vertical: p.vertical });
              } else setCustom(crs?.epsg ? String(crs.epsg) : '');
            }}>
            {COORD_PRESETS.map((p, i) => <option key={p.epsg} value={i}>EPSG:{p.epsg} — {p.name}{p.vertical ? ` (${p.vertical})` : ''}</option>)}
            <option value="custom">Other EPSG code…</option>
            <option value="none">Not set</option>
          </select>
          <input className="mono text-[10.5px] rounded-md px-1.5 py-1" style={{ width: 80, background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
            placeholder="EPSG" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter' && /^\d{4,6}$/.test(custom)) void save({ epsg: parseInt(custom, 10), name: `EPSG:${custom}` }); if (e.key === 'Escape') setEditing(false); }} />
          <button className="mono text-[10.5px]" onClick={() => setEditing(false)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-mute)' }}>cancel</button>
        </>
      )}
      {err && <span style={{ color: '#f08a7e' }}>{err}</span>}
    </div>
  );
}
