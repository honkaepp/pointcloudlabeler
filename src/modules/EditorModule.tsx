// Editor module — the native point-cloud editor. Octree-only since
// Phase 7 cleanup: the in-memory CloudData pipeline is gone, so this
// module's job is small — wire the EditorShell to the project's saved
// octrees, run the LAS/LAZ → octree converter via the import dialog, run
// the exporter via the export dialog, and surface long-running status
// + progress through the shell's banner.

import { useCallback, useEffect, useState } from 'react';
import { useProject } from '../context/ProjectContext';
import EditorShell, { type ShellStatus } from '../components/shell/EditorShell';
import type { FilterConfig } from '../components/shell/OctreeShellContext';
import ImportMappingDialog from '../components/ImportMappingDialog';
import OctreeExportDialog, { type OctreeExportOptions, type OctreeExportFilter } from '../components/OctreeExportDialog';
import type { ExportReport } from '../persistence/desktopBridge';
import {
  listOctrees, openOctree,
  type OpenOctree, type OctreeListEntry,
} from '../persistence/octreeReader';
import { takeReopen } from '../persistence/reopenAfterReload';
import { findDir } from '../persistence/datasetDirs';
import {
  importLazAsOctree, octreeImportAvailable, onOctreeProgress, safeOutputName,
} from '../persistence/octreeStore';
import { suggestMapping, type ColumnMapping } from '../io/columnMapping';
import { detectLasSource, isLasLikeName } from '../io/parseLasStream';
import type { ScannerType } from '../state/multiCloud';
import { invalidateTreeMetrics } from '../metrics/loadMetrics';
import { confirmDialog } from '../ui/dialogs';

interface FileLike { name: string; size: number; path?: string }

interface PendingImport {
  fileName: string;
  srcPath: string;
  sizeBytes: number;
  columns: string[];
  /** LAS point data record format, for the dialog to disclose which
   *  standard fields the octree will not carry. null = not a LAS. */
  pointFormat: number | null;
  suggested: ColumnMapping;
}

export default function EditorModule() {
  const { project } = useProject();
  const [viewingOctree, setViewingOctree] = useState<OpenOctree | null>(null);
  const [octreeList, setOctreeList] = useState<OctreeListEntry[]>([]);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [operation, setOperation] = useState<string | null>(null);
  const [status, setStatus] = useState<ShellStatus | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  // `filters` rides along with the export target: the shell owns the live
  // Filters-panel state (not EditorModule), so onExportLas hands us a
  // snapshot when the dialog opens — that's what OctreeExportDialog uses
  // to build the optional "apply current view filters" payload.
  const [exportTarget, setExportTarget] = useState<{ dir: string; name: string; filters: FilterConfig } | null>(null);

  // Refresh the dataset list whenever the project changes or after a
  // fresh convert / subset writes a new octree.
  const refreshList = useCallback(async () => {
    if (!project?.folder) { setOctreeList([]); return; }
    try { setOctreeList(await listOctrees(project.folder)); }
    catch (e) { console.warn('listOctrees failed', e); setOctreeList([]); }
  }, [project?.folder]);
  useEffect(() => { void refreshList(); }, [refreshList]);

  // After a reload the lost-context overlay asked for, come back to the
  // cloud that was open rather than to this list — see
  // persistence/reopenAfterReload.ts. Once the list is in, onto an empty
  // viewer only, and the crumb is taken whether or not the dataset is
  // still there to open.
  useEffect(() => {
    if (viewingOctree || octreeList.length === 0) return;
    const dir = takeReopen();
    if (!dir || !octreeList.some((e) => e.dir === dir)) return;
    let cancelled = false;
    openOctree(dir)
      .then((opened) => { if (!cancelled) setViewingOctree(opened); })
      .catch((e) => setStatus({ kind: 'err', msg: `Reopen after reload failed: ${(e as Error).message}` }));
    return () => { cancelled = true; };
  }, [octreeList, viewingOctree]);

  // Native menu clicks are dispatched by EditorShell (File → Add Cloud…
  // reaches triggerImport through the shell's onImport), so that the
  // menu, the keyboard and the command palette run one and the same code.

  // Open a LAS/LAZ via the OS file dialog → show the import-mapping
  // dialog → convert via the Rust pipeline → list refresh.
  const triggerImport = useCallback(async () => {
    if (!project?.folder) {
      setStatus({ kind: 'warn', msg: 'Open or create a project first.' });
      return;
    }
    const d = (window as unknown as Record<string, unknown>).desktop as {
      openFileDialog?: (opts?: Record<string, unknown>) => Promise<FileLike | null>;
    } | undefined;
    if (!d?.openFileDialog) {
      setStatus({ kind: 'err', msg: 'Native file picker not available (desktop build needed).' });
      return;
    }
    const picked = await d.openFileDialog({ filters: [{ name: 'LAS / LAZ', extensions: ['las', 'laz'] }] });
    if (!picked) return;
    if (!isLasLikeName(picked.name)) {
      setStatus({ kind: 'err', msg: 'Pick a .las or .laz file (octree converter only handles those).' });
      return;
    }
    if (!picked.path) {
      setStatus({ kind: 'err', msg: 'Selected file has no native path — drag-drop is not yet supported here.' });
      return;
    }
    // Probe the LAS header for its columns so the dialog can show every
    // extra column the user might want to carry along. detectLasSource
    // reads only the first ~64 KiB of the file so a small FileLike that
    // resolves a single ranged read is enough; we lean on the existing
    // Blob.slice contract by wrapping each range read in a tiny Blob.
    let columns: string[] = [];
    let pointFormat: number | null = null;
    try {
      const path = picked.path;
      const reader = (window as unknown as Record<string, unknown>).desktop as {
        readFileRange?: (path: string, start: number, end: number) => Promise<ArrayBuffer>;
      } | undefined;
      const fileLike = {
        name: picked.name,
        size: picked.size,
        slice: (start: number, end: number) => ({
          arrayBuffer: async () => {
            if (!reader?.readFileRange) return new ArrayBuffer(0);
            return reader.readFileRange(path, start, end);
          },
        }),
      };
      const info = await detectLasSource(fileLike);
      columns = info.extraNames;
      pointFormat = info.pointFormat;
    } catch (e) { console.warn('detectLasSource failed', e); }
    setPendingImport({
      fileName: picked.name,
      pointFormat,
      srcPath: picked.path,
      sizeBytes: picked.size,
      columns,
      suggested: suggestMapping(columns),
    });
  }, [project?.folder]);

  // Run the Rust converter. The dialog already validated the scanner +
  // pre-segmented column picks; we just plumb them through.
  const runConvert = useCallback(async (
    p: PendingImport,
    scannerType: ScannerType,
    preSegmented?: { treeIdExtra: string; semanticExtra: string; standingDeadwoodExtra: string; layingDeadwoodExtra: string },
    extraNames?: string[],
    includeDeadwood?: boolean,
  ) => {
    if (!project?.folder) return;
    const outDir = `${project.folder}/octrees/${safeOutputName(p.fileName)}`;
    setOperation('Converting');
    setLoading(true);
    setProgress(0);
    setStatus({ kind: 'info', msg: `Converting ${p.fileName} → octree…` });
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onOctreeProgress((stage, pct) => {
        setProgress(pct);
        setStatus({ kind: 'info', msg: `Octree · ${stage} · ${Math.round(pct * 100)}%` });
      });
      const res = await importLazAsOctree({
        srcPath: p.srcPath, outDir, name: p.fileName,
        scannerType,
        rootSpacing: 0,
        maxDepth: 14,
        treeIdExtraName: preSegmented?.treeIdExtra || undefined,
        semanticExtraName: preSegmented?.semanticExtra || undefined,
        standingDeadwoodExtraName: preSegmented?.standingDeadwoodExtra || undefined,
        layingDeadwoodExtraName: preSegmented?.layingDeadwoodExtra || undefined,
        extraNames: extraNames && extraNames.length > 0 ? extraNames : undefined,
        includeDeadwood,
      });
      const sec = (res.durationMs / 1000).toFixed(1);
      // Surface the observed tree_id range when a source column was
      // mapped — a too-narrow range (e.g. 0..255) is the dead giveaway
      // that the writer packed wider ids into a small EB type and
      // saturated them, so the user catches it immediately.
      let extra = '';
      if (res.treeIdRange) {
        const [lo, hi] = res.treeIdRange;
        const range = `${lo.toLocaleString()}..${hi.toLocaleString()}`;
        const suspicious = (lo >= 0 && hi <= 255) || (lo >= 0 && hi <= 65535 && hi - lo < 256);
        extra = suspicious
          ? ` · tree_id: ${range} ⚠ (looks saturated — check source column type)`
          : ` · tree_id: ${range}`;
      }
      setStatus({ kind: 'ok', msg: `Converted ${p.fileName} in ${sec}s — ${res.pointCount.toLocaleString()} pts${extra}` });
      await refreshList();
      // Open it in the viewer immediately — under the LIST's spelling of
      // its folder, not the importer's: the list spells it as the OS does
      // and the importer as this code did, and a cloud open under the
      // other spelling matched no list entry (see persistence/datasetDirs).
      const listed = findDir(await listOctrees(project.folder), res.outDir);
      try { setViewingOctree(await openOctree(listed?.dir ?? res.outDir)); }
      catch (e) { setStatus({ kind: 'err', msg: `Open after convert failed: ${(e as Error).message}` }); }
    } catch (e) {
      setStatus({ kind: 'err', msg: `Convert failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      unlisten?.();
      setLoading(false);
      setOperation(null);
      setProgress(0);
    }
  }, [project?.folder, refreshList]);

  // Export the active octree via the dialog → save-file picker → Rust.
  const handleExport = useCallback(async (octreeDir: string, name: string, opts: OctreeExportOptions) => {
    const api = (window as unknown as Record<string, unknown>).desktop as {
      saveLasDialog?: (n: string) => Promise<string | null>;
      cloudExportOctreeLas?: (
        dir: string, out: string, normalize?: boolean, cellSize?: number,
        o?: {
          includeTreeId?: boolean; includeSemantic?: boolean;
          includeStandingDeadwood?: boolean; includeLayingDeadwood?: boolean;
          keepClassification?: boolean; keepIntensity?: boolean;
          decimals?: number; extrasToExport?: string[];
          filter?: OctreeExportFilter;
          targetCrs?: string;
          geoid?: string;
          las14?: boolean;
        },
      ) => Promise<ExportReport>;
    } | undefined;
    if (!api?.saveLasDialog || !api?.cloudExportOctreeLas) {
      setStatus({ kind: 'err', msg: 'Octree export needs the desktop build.' });
      return;
    }
    const ext = opts.format;
    const picked = await api.saveLasDialog(`${safeOutputName(name) || 'octree'}.${ext}`);
    if (!picked) return;
    // The Rust writer dispatches LAS vs LAZ on the path's extension; honour
    // the dialog's container choice even if the save sheet kept a different
    // one.
    const target = picked.replace(/\.(las|laz)$/i, '') + `.${ext}`;
    let unlisten: (() => void) | null = null;
    try {
      setOperation('Exporting');
      setLoading(true);
      setProgress(0);
      // Name every transformation that will run. Reprojection and the
      // geoid correction each change the numbers in the file, and a
      // status line that mentions only one of them makes the other
      // invisible in exactly the case where the user most needs to know
      // it happened.
      const transforms = [
        opts.targetCrs ? `reprojecting to ${opts.targetCrs.label}` : null,
        opts.geoid ? `converting heights to orthometric via ${opts.geoid}` : null,
      ].filter(Boolean) as string[];
      setStatus({
        kind: 'info',
        msg: transforms.length
          ? `Exporting octree to ${ext.toUpperCase()}, ${transforms.join(' and ')}…`
          : `Exporting octree to ${ext.toUpperCase()}…`,
      });
      unlisten = await onOctreeProgress((stage, pct) => {
        if (stage === 'export') setProgress(pct);
      });
      const report = await api.cloudExportOctreeLas(octreeDir, target, opts.normalize, opts.cellSize, {
        includeTreeId: opts.includeTreeId,
        includeSemantic: opts.includeSemantic,
        includeStandingDeadwood: opts.includeStandingDeadwood,
        includeLayingDeadwood: opts.includeLayingDeadwood,
        keepClassification: opts.keepClassification,
        keepIntensity: opts.keepIntensity,
        decimals: opts.decimals,
        extrasToExport: opts.extrasToExport,
        filter: opts.filter,
        targetCrs: opts.targetCrs?.spec,
        geoid: opts.geoid,
        las14: opts.las14,
      });
      // A normalised export leaves out any point with no ground beneath
      // it — it has no height above ground, and LAS cannot store a NaN Z.
      // Say so: a file quietly short of points is the thing worth
      // noticing, not the thing to hide.
      const dropped = report.skippedNoGround > 0
        ? ` — ${report.skippedNoGround.toLocaleString()} points left out, no ground surface beneath them`
        : '';
      setStatus({
        kind: report.skippedNoGround > 0 ? 'warn' : 'ok',
        msg: transforms.length
          ? `Exported ${report.written.toLocaleString()} points → ${target} (${transforms.join(', ')})${dropped}`
          : `Exported ${report.written.toLocaleString()} points → ${target}${dropped}`,
      });
    } catch (e) {
      setStatus({ kind: 'err', msg: `Octree export failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      unlisten?.();
      setLoading(false);
      setOperation(null);
      setProgress(0);
    }
  }, []);

  const closeOctreeView = useCallback(async () => {
    if (dirty && !await confirmDialog('Octree has unsaved edits. Close anyway and lose them?')) return;
    setViewingOctree(null);
    setDirty(false);
  }, [dirty]);

  if (!octreeImportAvailable() && !project) {
    return (
      <div className="absolute left-0 right-0 bottom-0 flex items-center justify-center mono text-[12px]" style={{ top: 52, color: 'var(--text-mute)', background: 'var(--viewport-bg)' }}>
        Open a project to start editing.
      </div>
    );
  }

  return (
    <>
      <EditorShell
        octree={viewingOctree}
        projectName={project?.meta.name ?? null}
        octreeList={octreeList}
        onImport={() => void triggerImport()}
        onOpenOctree={async (entry) => {
          if (entry.dir === viewingOctree?.dir) return;
          if (dirty && !await confirmDialog('The active cloud has unsaved edits. Switch anyway and lose them?')) return;
          try {
            const opened = await openOctree(entry.dir);
            setDirty(false);
            setViewingOctree(opened);
          } catch (e) {
            setStatus({ kind: 'err', msg: `Open octree failed: ${(e as Error).message}` });
          }
        }}
        onRemoveDataset={async (entry) => {
          // If the user is currently editing this dataset, refuse without
          // explicit consent — silently dropping unsaved edits is exactly
          // what we're trying to stop happening. Otherwise just one
          // confirm for the disk delete itself.
          const isActive = entry.dir === viewingOctree?.dir;
          if (isActive && dirty) {
            if (!await confirmDialog(`"${entry.name}" has UNSAVED EDITS. Remove the dataset anyway and lose them permanently?`)) return;
          } else if (!await confirmDialog(`Delete dataset "${entry.name}" from the project? This removes the octree directory from disk and cannot be undone.`)) {
            return;
          }
          const api = (window as unknown as Record<string, unknown>).desktop as {
            octreeRemoveDataset?: (dir: string) => Promise<void>;
          } | undefined;
          if (!api?.octreeRemoveDataset) {
            setStatus({ kind: 'err', msg: 'Dataset removal needs the desktop build.' });
            return;
          }
          try {
            if (isActive) {
              // Close the viewer first so nothing tries to read the dir
              // mid-delete (Windows file-locking quirks otherwise).
              setViewingOctree(null);
              setDirty(false);
            }
            await api.octreeRemoveDataset(entry.dir);
            // The metrics cache holds one row per tree of every dataset
            // it has measured. A deleted dataset's rows can never be
            // asked for again, so holding them is pure leak.
            invalidateTreeMetrics(entry.dir);
            setStatus({ kind: 'ok', msg: `Removed dataset "${entry.name}".` });
            await refreshList();
          } catch (e) {
            setStatus({ kind: 'err', msg: `Remove dataset failed: ${e instanceof Error ? e.message : String(e)}` });
          }
        }}
        onCloseOctree={closeOctreeView}
        onExportLas={(filters) => { if (viewingOctree) setExportTarget({ dir: viewingOctree.dir, name: viewingOctree.meta.name, filters }); }}
        onDirtyChange={setDirty}
        busy={loading}
        status={status}
        progress={progress}
        operation={operation}
        onDismissStatus={() => setStatus(null)}
        onDatasetsChanged={refreshList}
        onReloadActiveOctree={async () => {
          if (!viewingOctree) return;
          // Defence in depth. Editing is blocked while a dataset-mutating
          // command runs (src/state/datasetBusy.ts), so this should never
          // fire — but the reload replaces the in-memory patch store with
          // what is on disk and clears undo, so if an edit did survive to
          // here, losing it silently is the one outcome that must not
          // happen. onOpenOctree guards a dataset switch the same way.
          if (dirty && !await confirmDialog(
            'The active cloud has unsaved edits and reloading it will discard them. Reload anyway?',
          )) return;
          try {
            const reopened = await openOctree(viewingOctree.dir);
            setDirty(false);
            setViewingOctree(reopened);
          } catch (e) {
            setStatus({ kind: 'err', msg: `Reload failed: ${(e as Error).message}` });
          }
        }}
      />

      {exportTarget && (
        <OctreeExportDialog
          datasetName={exportTarget.name}
          availableExtras={viewingOctree?.meta.extras?.map(e => ({ name: e.name, min: e.min, max: e.max })) ?? []}
          filters={exportTarget.filters}
          sourceCrs={viewingOctree?.meta.crs}
          verticalCrs={viewingOctree?.meta.vertical}
          onCancel={() => setExportTarget(null)}
          onExport={(opts) => {
            const t = exportTarget;
            setExportTarget(null);
            void handleExport(t.dir, t.name, opts);
          }}
          octreeDir={exportTarget.dir}
          onRealigned={() => {
            // The offset on disk moved; the open view still holds the
            // old one. Reopen when nothing unsaved would be lost — the
            // reload replaces the in-memory patch store — and otherwise
            // leave it to the user's own Reload after saving.
            if (dirty || !viewingOctree || viewingOctree.dir !== exportTarget.dir) return;
            const dir = exportTarget.dir;
            void (async () => {
              try { setViewingOctree(await openOctree(dir)); }
              catch (e) { setStatus({ kind: 'err', msg: `Reload failed: ${(e as Error).message}` }); }
            })();
          }}
        />
      )}

      {pendingImport && (
        <ImportMappingDialog
          fileName={pendingImport.fileName}
          isLas
          columns={pendingImport.columns}
          pointFormat={pendingImport.pointFormat}
          suggested={pendingImport.suggested}
          mode="scannerOnly"
          onCancel={() => setPendingImport(null)}
          onConfirm={(scannerType, _mapping, _verticalAxis, preSegmented, extraNames, includeDeadwood) => {
            const p = pendingImport;
            setPendingImport(null);
            void runConvert(p, scannerType, preSegmented, extraNames, includeDeadwood);
          }}
        />
      )}
    </>
  );
}
