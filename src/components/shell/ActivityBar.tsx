// Vertical activity bar on the left edge. Each icon toggles a floating
// panel (tools / display / history / layers); the Open action is a
// one-shot file picker the parent owns. Visual style mirrors Linear /
// VS Code activity bars — narrow, icon-only, the active icon picks up
// the accent colour. PointCloudLabeler: » under the monogram widens it to show
// every tool's name beside its icon (« narrows it again), remembered
// between sessions.

import { createContext, useContext, useState } from 'react';
import { useOctreeShell, countActiveFilters, type PanelId } from './OctreeShellContext';
import { PRODUCT_NAME, brandMonogram } from '../PointCloudLabelerLogo';
import { SurveyIcon } from './SurveyPanel';
import { ViewToolsIcon } from './ViewToolsPanel';
import { shortName } from './activityNames';

interface Props {
  onOpenFile: () => void;
  /** Disabled when no octree is open — most panels need a dataset. */
  disabled?: boolean;
}

const BAR_WIDTH = 56;
/** Wide enough for the longest name ("Tree Skeleton Transfer") beside the scroll bar. */
const WIDE_WIDTH = 240;
const GROUPS_KEY = 'pointcloudlabeler-activity-groups';
const WIDE_KEY = 'pointcloudlabeler-activity-wide';
/** Open at first: seeing the data, editing it. */
const GROUPS_OPEN: Record<string, boolean> = { view: true, edit: true, measure: false, analyse: false, compare: false };

/** The bar is widened, with the names beside the icons. */
const Wide = createContext(false);

export default function ActivityBar({ onOpenFile, disabled }: Props) {
  const { visiblePanels, togglePanel, filters } = useOctreeShell();
  const nFilters = countActiveFilters(filters);
  const [wide, setWide] = useState(() => {
    try { return localStorage.getItem(WIDE_KEY) === '1'; } catch { return false; }
  });
  const toggleWide = () => setWide((w) => {
    try { localStorage.setItem(WIDE_KEY, w ? '0' : '1'); } catch { /* storage unavailable */ }
    return !w;
  });
  // Which groups are open, kept between sessions
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try { return { ...GROUPS_OPEN, ...(JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '{}') as Record<string, boolean>) }; } catch { return { ...GROUPS_OPEN }; }
  });
  const groupOpen = (id: string) => open[id] !== false;
  const toggleGroup = (id: string) => setOpen((o) => {
    const next = { ...o, [id]: !(o[id] !== false) };
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
    return next;
  });

  return (
    <Wide.Provider value={wide}>
    <div
      className={`flex flex-col ${wide ? 'items-stretch px-2' : 'items-center'} py-2 gap-1 hairline-r shrink-0 overflow-y-auto overflow-x-hidden scroll-thin`}
      style={{
        width: wide ? WIDE_WIDTH : BAR_WIDTH,
        background: 'rgba(8, 14, 11, 0.92)',
        backdropFilter: 'blur(20px) saturate(140%)',
        WebkitBackdropFilter: 'blur(20px) saturate(140%)',
        zIndex: 30,
      }}
    >
      {/* Brand monogram. Derived from the product name rather than
          typed — it used to be the literal `T·R`, which no rename and
          no grep could find because the name was not in the string. */}
      <div
        className="mono text-[10px] font-semibold text-center w-full"
        style={{ color: 'var(--accent)', letterSpacing: '0.10em' }}
        title={PRODUCT_NAME}
      >
        {brandMonogram()}
      </div>
      {/* The names of the tools beside their icons, or not. */}
      <button
        type="button"
        onClick={toggleWide}
        data-activity-wide={wide ? 'on' : 'off'}
        aria-expanded={wide}
        title={wide ? 'Icons only (narrow the bar)' : 'Show the tool names (widen the bar)'}
        className={`mono shrink-0 rounded-md mb-1 ${wide ? 'self-end px-2' : 'w-10'}`}
        style={{ height: 18, fontSize: 11, lineHeight: '18px', color: 'var(--text-mute)', background: 'none', border: 'none', cursor: 'pointer' }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-mute)'; }}
      >
        {wide ? '«' : '»'}
      </button>

      <ActivityBtn label="Open file" onClick={onOpenFile} shortcut="O">
        <IconFolder />
      </ActivityBtn>
      {/* The panels in groups by what they are for, each folding
          away (ActivityGroup) — 36 icons in one column did not fit a laptop
          screen and the last ones could not be reached. */}
      <ActivityGroup id="view" label="VIEW" title="Seeing the cloud: display, filters, layers, views & video, sections" open={groupOpen('view')} onToggle={() => toggleGroup('view')}
        active={['display', 'filters', 'layers', 'viewtools', 'slab', 'scaninspect'].some((p) => visiblePanels.has(p as PanelId))}>
        <PanelToggle id="display" label="Display" disabled={disabled} active={visiblePanels.has('display')} onClick={() => togglePanel('display')}>
          <IconPalette />
        </PanelToggle>
        <PanelToggle
          id="filters"
          label={nFilters > 0 ? `Filters (${nFilters} active)` : 'Filters'}
          disabled={disabled}
          active={visiblePanels.has('filters')}
          onClick={() => togglePanel('filters')}
          badge={nFilters > 0 ? nFilters : undefined}
        >
          <IconFilter />
        </PanelToggle>
        <PanelToggle id="layers" label="Layers" disabled={false} active={visiblePanels.has('layers')} onClick={() => togglePanel('layers')}>
          <IconLayers />
        </PanelToggle>
        <PanelToggle id="viewtools" label="Views & video — X-ray view, fly-through, slice through, time lapse; recorded as video" disabled={disabled} active={visiblePanels.has('viewtools')} onClick={() => togglePanel('viewtools')}>
          <ViewToolsIcon />
        </PanelToggle>
        <PanelToggle id="slab" label="Cross-section slab" disabled={disabled} active={visiblePanels.has('slab')} onClick={() => togglePanel('slab')}>
          <IconSlab />
        </PanelToggle>
        <PanelToggle id="scaninspect" label="Scan inspection — HPR + panorama" disabled={disabled} active={visiblePanels.has('scaninspect')} onClick={() => togglePanel('scaninspect')}>
          <IconScanInspect />
        </PanelToggle>
      </ActivityGroup>
      <ActivityGroup id="edit" label="EDIT" title="Editing: tools, history, segmentation, terrain, tree review" open={groupOpen('edit')} onToggle={() => toggleGroup('edit')}
        active={['tools', 'history', 'segment', 'ground', 'review', 'branches', 'subset'].some((p) => visiblePanels.has(p as PanelId))}>
        <PanelToggle id="tools" label="Tools" disabled={disabled} active={visiblePanels.has('tools')} onClick={() => togglePanel('tools')}>
          <IconCursor />
        </PanelToggle>
        <PanelToggle id="history" label="History" disabled={disabled} active={visiblePanels.has('history')} onClick={() => togglePanel('history')}>
          <IconClock />
        </PanelToggle>
        <PanelToggle id="segment" label="Auto-segment (trees + deadwood)" disabled={disabled} active={visiblePanels.has('segment')} onClick={() => togglePanel('segment')}>
          <IconSegment />
        </PanelToggle>
        <PanelToggle id="ground" label="Terrain" disabled={disabled} active={visiblePanels.has('ground')} onClick={() => togglePanel('ground')}>
          <IconGround />
        </PanelToggle>
        <PanelToggle id="review" label="Tree review" disabled={disabled} active={visiblePanels.has('review')} onClick={() => togglePanel('review')}>
          <IconTree />
        </PanelToggle>
        <PanelToggle id="branches" label="Branches — cut branches out by hand, caliper their base diameter, measure their length" disabled={disabled} active={visiblePanels.has('branches')} onClick={() => togglePanel('branches')}>
          <IconBranches />
        </PanelToggle>
        <PanelToggle id="subset" label="Subset / extract" disabled={disabled} active={visiblePanels.has('subset')} onClick={() => togglePanel('subset')}>
          <IconScissors />
        </PanelToggle>
      </ActivityGroup>
      <ActivityGroup id="measure" label="MEASURE" title="Measuring trees and the plot" open={groupOpen('measure')} onToggle={() => toggleGroup('measure')}
        active={['survey', 'height', 'caliper', 'treehandle', 'stems', 'centerline', 'taper', 'plotbound'].some((p) => visiblePanels.has(p as PanelId))}>
        {/* Measuring, contours, volumes, change, ortho images, profiles. */}
        <PanelToggle id="survey" label="Survey — measure lines and areas, contour lines, volumes, voxel change, ortho images, section profiles" disabled={disabled} active={visiblePanels.has('survey')} onClick={() => togglePanel('survey')}>
          <SurveyIcon />
        </PanelToggle>
        <PanelToggle id="height" label="Height — click two points (a root and a top): the height and distance between them on a scale with lines every few metres" disabled={disabled} active={visiblePanels.has('height')} onClick={() => togglePanel('height')}>
          <IconHeight />
        </PanelToggle>
        <PanelToggle id="caliper" label="Virtual caliper (click any stem)" disabled={disabled} active={visiblePanels.has('caliper')} onClick={() => togglePanel('caliper')}>
          <IconCaliper />
        </PanelToggle>
        <PanelToggle id="treehandle" label="Click-to-measure-tree (DBH + height + lean + crown)" disabled={disabled} active={visiblePanels.has('treehandle')} onClick={() => togglePanel('treehandle')}>
          <IconTreeHandle />
        </PanelToggle>
        <PanelToggle id="stems" label="Stems — calipers at DBH, d6 or any height above the ground, a taper series, tree height and stem length" disabled={disabled} active={visiblePanels.has('stems')} onClick={() => togglePanel('stems')}>
          <IconStems />
        </PanelToggle>
        <PanelToggle id="centerline" label="Stem centerline extraction (trunk polylines)" disabled={disabled} active={visiblePanels.has('centerline')} onClick={() => togglePanel('centerline')}>
          <IconCenterline />
        </PanelToggle>
        <PanelToggle id="taper" label="Stem taper — per-tree diameter profile, volume & log bucking" disabled={disabled} active={visiblePanels.has('taper')} onClick={() => togglePanel('taper')}>
          <IconStemTaper />
        </PanelToggle>
        <PanelToggle id="plotbound" label="Plot boundary + expansion factors" disabled={disabled} active={visiblePanels.has('plotbound')} onClick={() => togglePanel('plotbound')}>
          <IconPlotBound />
        </PanelToggle>
      </ActivityGroup>
      <ActivityGroup id="analyse" label="ANALYSE" title="Quality, metrics and reports" open={groupOpen('analyse')} onToggle={() => toggleGroup('analyse')}
        active={['qc', 'pointqc', 'rescan', 'validation', 'density', 'bucking', 'thinning', 'report'].some((p) => visiblePanels.has(p as PanelId))}>
        <PanelToggle id="qc" label="QC — flag suspect trees" disabled={disabled} active={visiblePanels.has('qc')} onClick={() => togglePanel('qc')}>
          <IconQc />
        </PanelToggle>
        <PanelToggle id="pointqc" label="Point QC — reflectance / outlier / wind" disabled={disabled} active={visiblePanels.has('pointqc')} onClick={() => togglePanel('pointqc')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M2 12.5h12" />
            <circle cx="5" cy="9" r="0.9" />
            <circle cx="8" cy="6" r="0.9" />
            <circle cx="11" cy="8.5" r="0.9" />
            <path d="M12.6 3.4l2 2M14.6 3.4l-2 2" />
          </svg>
        </PanelToggle>
        <PanelToggle id="rescan" label="Rescan advisor — coverage heatmap" disabled={disabled} active={visiblePanels.has('rescan')} onClick={() => togglePanel('rescan')}>
          <IconRescan />
        </PanelToggle>
        <PanelToggle id="validation" label="Field-data validation" disabled={disabled} active={visiblePanels.has('validation')} onClick={() => togglePanel('validation')}>
          <IconValidation />
        </PanelToggle>
        <PanelToggle id="density" label="Forestry density metrics" disabled={disabled} active={visiblePanels.has('density')} onClick={() => togglePanel('density')}>
          <IconDensity />
        </PanelToggle>
        <PanelToggle id="bucking" label="Stem bucking (log assortments)" disabled={disabled} active={visiblePanels.has('bucking')} onClick={() => togglePanel('bucking')}>
          <IconBucking />
        </PanelToggle>
        <PanelToggle id="thinning" label="Thinning simulator (harvennus)" disabled={disabled} active={visiblePanels.has('thinning')} onClick={() => togglePanel('thinning')}>
          <IconThinning />
        </PanelToggle>
        <PanelToggle id="report" label="One-click report (HTML / PDF)" disabled={disabled} active={visiblePanels.has('report')} onClick={() => togglePanel('report')}>
          <IconReport />
        </PanelToggle>
      </ActivityGroup>
      <ActivityGroup id="compare" label="COMPARE" title="Two clouds: registration, change, growth, transfer" open={groupOpen('compare')} onToggle={() => toggleGroup('compare')}
        active={['register', 'finereg', 'm3c2', 'growth', 'tst', 'crosssensor'].some((p) => visiblePanels.has(p as PanelId))}>
        <PanelToggle id="register" label="Cloud registration — put two clouds of one plot on each other: skeletons → target trees, lossless georeference shift" disabled={disabled} active={visiblePanels.has('register')} onClick={() => togglePanel('register')}>
          <IconRegister />
        </PanelToggle>
        <PanelToggle id="finereg" label="Fine registration — two datasets on each other in six degrees of freedom: symmetric ICP with error bars, written as a moved copy" disabled={disabled} active={visiblePanels.has('finereg')} onClick={() => togglePanel('finereg')}>
          <IconFineRegister />
        </PanelToggle>
        <PanelToggle id="m3c2" label="M3C2 — multi-temporal change / growth between two epochs" disabled={disabled} active={visiblePanels.has('m3c2')} onClick={() => togglePanel('m3c2')}>
          <IconM3C2 />
        </PanelToggle>
        <PanelToggle id="growth" label="Tree growth — per-tree DBH / height / volume increment between two epochs" disabled={disabled} active={visiblePanels.has('growth')} onClick={() => togglePanel('growth')}>
          <IconTreeGrowth />
        </PanelToggle>
        <PanelToggle id="tst" label="Tree Skeleton Transfer (TST) — baseline → target labels" disabled={disabled} active={visiblePanels.has('tst')} onClick={() => togglePanel('tst')}>
          <IconSkeletonTransfer />
        </PanelToggle>
        <PanelToggle id="crosssensor" label="ALS ↔ TLS join — match airborne crowns to ground-based stems, detection rate by diameter class" disabled={disabled} active={visiblePanels.has('crosssensor')} onClick={() => togglePanel('crosssensor')}>
          <IconCrossSensor />
        </PanelToggle>
      </ActivityGroup>

      <div className="flex-1" />
      <PanelToggle id="keys" label="Keyboard shortcuts" disabled={disabled} active={visiblePanels.has('keys')} onClick={() => togglePanel('keys')}>
        <IconKeyboard />
      </PanelToggle>
    </div>
    </Wide.Provider>
  );
}

/** An icon button's shape — a square, or in the widened bar a
 *  row with the name beside the icon. */
function buttonClass(wide: boolean): string {
  return wide
    ? 'w-full h-9 px-2.5 gap-2.5 rounded-md flex items-center justify-start transition-all relative shrink-0'
    : 'w-10 h-10 rounded-md flex items-center justify-center transition-all relative shrink-0';
}

function NameBeside({ label }: { label: string }) {
  return <span className="text-[12px] truncate text-left" style={{ minWidth: 0 }}>{shortName(label)}</span>;
}

/** A group of panel icons under a small header that folds it;
 *  folded, the header lights up while one of its panels is open. */
function ActivityGroup({ id, label, title, open, onToggle, active, children }: {
  id: string; label: string; title: string; open: boolean; onToggle: () => void; active: boolean; children: React.ReactNode;
}) {
  const wide = useContext(Wide);
  return (
    <>
      <button type="button" onClick={onToggle} data-group={id} title={`${title} — click to ${open ? 'fold' : 'unfold'}`}
        className={`w-full mono flex items-center ${wide ? 'justify-start gap-1' : 'justify-center gap-0.5'} shrink-0`}
        style={{ fontSize: wide ? 9 : 8, letterSpacing: '0.08em', color: active && !open ? 'var(--accent)' : 'var(--text-mute)', background: 'none', border: 'none', padding: wide ? '7px 0 2px 4px' : '5px 0 1px', cursor: 'pointer' }}>
        <span style={{ fontSize: 7 }}>{open ? '▾' : '▸'}</span>
        <span>{label}</span>
        {active && !open && <span className="rounded-full" style={{ width: 4, height: 4, background: 'var(--accent)', marginLeft: 2 }} />}
      </button>
      {open && children}
    </>
  );
}

function ActivityBtn({
  children, onClick, label, shortcut, disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  shortcut?: string;
  disabled?: boolean;
}) {
  const wide = useContext(Wide);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={buttonClass(wide)}
      style={{
        color: disabled ? 'var(--text-mute)' : 'var(--text-dim)',
        background: 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = 'rgba(126,224,168,0.06)';
        e.currentTarget.style.color = 'var(--text)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = disabled ? 'var(--text-mute)' : 'var(--text-dim)';
      }}
    >
      {children}
      {wide && <NameBeside label={label} />}
    </button>
  );
}

function PanelToggle({
  children, label, active, onClick, disabled, id, badge,
}: {
  children: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  id: PanelId;
  badge?: number;
}) {
  const wide = useContext(Wide);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      data-panel={id}
      className={buttonClass(wide)}
      style={{
        color: disabled ? 'var(--text-mute)' : (active ? 'var(--accent)' : 'var(--text-dim)'),
        background: active ? 'color-mix(in oklch, var(--accent) 14%, transparent)' : 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      onMouseEnter={(e) => {
        if (disabled || active) return;
        e.currentTarget.style.background = 'rgba(126,224,168,0.06)';
        e.currentTarget.style.color = 'var(--text)';
      }}
      onMouseLeave={(e) => {
        if (disabled || active) return;
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = 'var(--text-dim)';
      }}
    >
      {children}
      {wide && <NameBeside label={label} />}
      {active && (
        <span
          className="absolute left-0 top-1/2 -translate-y-1/2 rounded-full"
          style={{ width: 3, height: 16, background: 'var(--accent)' }}
        />
      )}
      {badge !== undefined && badge > 0 && (
        <span
          className="absolute mono"
          style={{
            top: 3, right: 3,
            minWidth: 14, height: 14, padding: '0 3px',
            borderRadius: 7, background: 'var(--accent)', color: '#06140d',
            fontSize: 9, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 0 1.5px rgba(8,14,11,0.92)',
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

// ---------------- Inline SVG icons (no extra dep). 18px stroke. ----------------

function IconFolder() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

function IconCursor() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3 L19 11 L12 13 L10 20 Z" />
    </svg>
  );
}

function IconPalette() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="8" cy="9" r="1" fill="currentColor" />
      <circle cx="12" cy="7" r="1" fill="currentColor" />
      <circle cx="16" cy="9" r="1" fill="currentColor" />
      <circle cx="17" cy="13" r="1" fill="currentColor" />
    </svg>
  );
}

function IconFilter() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5h16l-6 8v6l-4-2v-4z" />
    </svg>
  );
}

function IconTree() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 L17 11 H7 Z" />
      <path d="M9.5 11 L15 18 H9 Z" />
      <path d="M12 18 v3" />
    </svg>
  );
}

function IconQc() {
  // Triangle with exclamation — "look here" hint, matches the
  // flagging metaphor.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 L22 20 H2 Z" />
      <path d="M12 10 v5" />
      <circle cx="12" cy="17.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconRescan() {
  // Crosshair + small arc — "next scan position" / coverage
  // heatmap. Reads as a survey marker / compass rose.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="6.5" />
      <path d="M12 4 v4 M12 16 v4 M4 12 h4 M16 12 h4" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconValidation() {
  // Scatter-plot motif: axes + four points + a 1:1 diagonal. Reads
  // as "field-vs-PointCloudLabeler comparison".
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20 V4 M4 20 H20" />
      <path d="M4 20 L20 4" strokeDasharray="2 2" opacity="0.55" />
      <circle cx="9" cy="14" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="10" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="16" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconBucking() {
  // A vertical stem segmented into three coloured "logs" by horizontal
  // cut lines — the visual metaphor for log assortments.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 21 V3 M14 21 V3" />
      <path d="M9 16 H15 M9 10 H15" />
      <path d="M9 21 H15" />
    </svg>
  );
}

function IconSlab() {
  // Stack of horizontal slabs with one highlighted in the middle —
  // reads as "movable horizontal cross-section".
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7 H20" opacity="0.45" />
      <path d="M4 17 H20" opacity="0.45" />
      <rect x="4" y="11" width="16" height="3" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconPlotBound() {
  // Circle in a square — "plot boundary on a map", reads as forestry
  // plot bound at a glance.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" strokeDasharray="2 2" opacity="0.55" />
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconScanInspect() {
  // Eye-and-radial-rays — viewpoint + projection rays. Reads as
  // "what does this point see?".
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
      <path d="M12 4 V7" />
      <path d="M12 17 V20" />
      <path d="M4 12 H7" />
      <path d="M17 12 H20" />
      <path d="M6.5 6.5 L8.5 8.5" />
      <path d="M15.5 15.5 L17.5 17.5" />
      <path d="M17.5 6.5 L15.5 8.5" />
      <path d="M8.5 15.5 L6.5 17.5" />
    </svg>
  );
}

function IconStems() {
  // A stem on the ground with caliper jaws across it at breast height.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21 H21" />
      <path d="M10 21 V3" />
      <path d="M14 21 V5" />
      <path d="M6 13 H18" />
      <path d="M6 11 V15" />
      <path d="M18 11 V15" />
    </svg>
  );
}

function IconBranches() {
  // A branch leaving a stem, with caliper jaws across its base.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 21 V3" />
      <path d="M6 14 L19 6" />
      <path d="M10 9.5 L12.5 13.5" />
      <path d="M8.6 10.4 L11.1 14.4" opacity="0.5" />
    </svg>
  );
}

function IconHeight() {
  // A ruler standing up with its lines, and a point at its top — a height
  // read between two clicked points.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 21 V4" />
      <path d="M8 21 H11 M8 16.5 H12.5 M8 12 H11 M8 7.5 H12.5" />
      <path d="M5 4 H11" />
      <circle cx="17" cy="4" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="17" cy="21" r="1.6" fill="currentColor" stroke="none" />
      <path d="M17 6.5 V18.5" strokeDasharray="1.5 2" />
    </svg>
  );
}

function IconCaliper() {
  // Caliper jaws around a small circle — the visual metaphor for
  // measuring a stem's diameter at a chosen height.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5 V19" />
      <path d="M20 5 V19" />
      <path d="M4 12 H8" />
      <path d="M16 12 H20" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}

function IconReport() {
  // Document outline with text lines + a chart bar at the bottom —
  // reads as "summary report" at a glance.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3 H15 L19 7 V21 H6 Z" />
      <path d="M15 3 V7 H19" />
      <path d="M9 11 H16 M9 14 H16" />
      <rect x="9" y="17" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="12" y="16" width="2" height="3" fill="currentColor" stroke="none" />
      <rect x="15" y="17" width="2" height="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconDensity() {
  // Vertical bars with descending heights — a histogram silhouette.
  // Reads as "distribution / density metrics" at a glance.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21 H21" />
      <rect x="4"  y="11" width="3" height="9" />
      <rect x="8.5" y="6"  width="3" height="14" />
      <rect x="13" y="9"  width="3" height="11" />
      <rect x="17.5" y="13" width="3" height="7" />
    </svg>
  );
}

function IconThinning() {
  // Forest plan view: a few trees + a horizontal "road" stripe
  // through them. Reads as "thinning corridor".
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12 H21" strokeDasharray="2 2" opacity="0.6" />
      <circle cx="6" cy="6" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="18" cy="7" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="6" cy="18" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="18" cy="17" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconSegment() {
  // Crown silhouette over a divider — auto-segmentation splits the canopy
  // into individual trees from above.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 10c0-2.5 2-4 3.5-4S12 7.5 12 9c0-1.5 1-3 2.5-3S18 7.5 18 10" />
      <path d="M6 10c-1.5 0-2.5 1.5-2.5 3S5 16 6.5 16h11c1.5 0 2.5-1.5 2.5-3s-1-3-2.5-3" />
      <path d="M9 16v3M15 16v3M12 16v3" />
    </svg>
  );
}

function IconGround() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 16l5-5 4 3 4-5 5 4" />
      <path d="M3 20h18" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function IconScissors() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.6" />
      <circle cx="6" cy="18" r="2.6" />
      <path d="M8.2 7.6 L20 17" />
      <path d="M8.2 16.4 L20 7" />
    </svg>
  );
}

function IconLayers() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 L20 8 L12 13 L4 8 Z" />
      <path d="M4 12 L12 17 L20 12" />
      <path d="M4 16 L12 21 L20 16" />
    </svg>
  );
}

function IconKeyboard() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 9.5h0M9.5 9.5h0M13 9.5h0M16.5 9.5h0M6 12.5h0M9.5 12.5h0M13 12.5h0M16.5 12.5h0M8 15.5h8" />
    </svg>
  );
}

function IconTreeHandle() {
  // Crosshair + pointer ring around a tree-like vertical bar — the
  // "click any stem to measure it" affordance.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 v18" />
      <circle cx="12" cy="11" r="4.5" />
      <path d="M12 6 v2 M12 14 v2 M7 11 h2 M15 11 h2" />
    </svg>
  );
}

function IconM3C2() {
  // Two surfaces (before / after) with a vertical Δ between them — signed
  // distance / change between two epochs.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8 C7 6, 10 6, 14 8 S20 10, 21 8" />
      <path d="M3 17 C7 15, 10 15, 14 17 S20 19, 21 17" />
      <path d="M12 9 V16" />
      <path d="M12 9 l-1.6 1.8 M12 9 l1.6 1.8 M12 16 l-1.6 -1.8 M12 16 l1.6 -1.8" />
    </svg>
  );
}

function IconStemTaper() {
  // A tapering trunk — wider at the base, narrowing upward — with two
  // horizontal section marks: the stem diameter profile.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 21 L10 4" />
      <path d="M16 21 L14 4" />
      <path d="M8 21 H16" />
      <path d="M9 15 H15" />
      <path d="M9.6 10 H14.4" />
    </svg>
  );
}

function IconRegister() {
  // Two plot outlines a step apart, and the arrow that moves one onto
  // the other — the georeference shift.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="8" width="11" height="11" rx="1.5" strokeDasharray="2.5 2" />
      <rect x="10" y="4" width="11" height="11" rx="1.5" />
      <path d="M8.5 13.5 L13 9.5 M10.5 9.5 H13 V12" />
    </svg>
  );
}

function IconFineRegister() {
  // Two stems a hair apart under one crosshair — the fit that closes
  // the gap, and the error bar it comes with.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 20 V8 M11.5 20 V8" strokeDasharray="2.5 2" />
      <path d="M13 20 V8 M15.5 20 V8" />
      <circle cx="12" cy="6" r="3.2" />
      <path d="M12 1.5 V3 M12 9 V10.5 M7.5 6 H9 M15 6 H16.5" />
    </svg>
  );
}

function IconCrossSensor() {
  // A downward cone from above and an upward one from the ground, meeting
  // at one tree — the two sensors seeing the same stem from either end.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2 L7 9 M12 2 L17 9" />
      <path d="M3 22 L8.5 15 M21 22 L15.5 15" />
      <path d="M12 9 V15" />
      <circle cx="12" cy="12" r="1.4" />
    </svg>
  );
}

function IconTreeGrowth() {
  // Three stems of increasing height on a baseline, with a small up-chevron
  // over the tallest — per-tree growth / increment between epochs.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21 H21" />
      <path d="M6 21 V15" />
      <path d="M12 21 V10" />
      <path d="M18 21 V6" />
      <path d="M15.5 8.5 L18 6 L20.5 8.5" />
    </svg>
  );
}


function IconSkeletonTransfer() {
  // Two trees connected by an arrow — "labels flow from one to the
  // other". Reads as "transfer / propagate between two clouds".
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 21 V8" />
      <path d="M5 8 L3 11 M5 8 L7 11" />
      <path d="M19 21 V8" />
      <path d="M19 8 L17 11 M19 8 L21 11" />
      <path d="M8 14 H16" />
      <path d="M14 12 L16 14 L14 16" />
    </svg>
  );
}

function IconCenterline() {
  // Vertical zig-zag polyline — a leaning trunk centreline drawn as
  // a chain of segments. Three dashes alongside hint at the radii at
  // each node.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 21 L11 15 L13 9 L12 3" />
      <circle cx="11" cy="15" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="13" cy="9" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="3" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="21" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}
