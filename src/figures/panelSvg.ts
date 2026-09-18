// A UI panel as a figure, laid out from its data rather than captured
// from the screen.
//
// WHY NOT A SCREENSHOT. The QC panel renders about 505 CSS px wide.
// Captured at the display's pixel ratio and printed 8 cm wide, its body
// text sets at 4.9 pt and the image is 160 dpi, where Elsevier asks 300
// for halftone and 500 for combination art. Page zoom does not help:
// printed type size is the ratio of text height to panel width, and zoom
// scales both. The two levers are a NARROWER LAYOUT WIDTH, which raises
// that ratio, and a HIGHER DEVICE PIXEL RATIO, which raises dpi without
// touching the layout. Neither is reachable from a screen capture, and
// neither alone is enough.
//
// So the panel is laid out here, at a width the caller chooses, as SVG:
// text stays text (sharp at any size, and searchable in the PDF), the
// raster comes from the same document at whatever DPR is asked for, and
// nothing can clip — the wrapping is ours, so a hint too long for its
// column takes another line instead of being cut off. A row whose hint
// is cut off is worthless; the words are the content.

import { FLAG_LABEL, SEV_RANK, type Flag, type FlagCode, type Severity } from '../metrics/qcFlags';

/** Widest advance-per-em among the monospace faces this SVG asks for
 *  (Consolas 0.55, Menlo and DejaVu Sans Mono 0.602, Courier New 0.6).
 *  Wrapping against the widest means a narrower face leaves slack and
 *  no face overflows — the no-truncation guarantee is arithmetic, not a
 *  measurement of whatever font the exporting machine happens to have. */
export const MONO_ADVANCE = 0.62;
export const FONT_STACK = 'Consolas, Menlo, &quot;DejaVu Sans Mono&quot;, &quot;Courier New&quot;, monospace';

/** Text sizes, in CSS px at the chosen layout width. The panel's own. */
export const TEXT = {
  header: 10.5,
  chip: 9.5,
  treeId: 11,
  code: 9,
  reason: 10,
  hint: 9.5,
} as const;

/** 6 pt in centimetres — the floor a printed figure's smallest type
 *  must clear. Below it a reader cannot read the row. */
export const MIN_PRINTED_CM = 0.21;

export interface QcPanelFigure {
  /** Flags to draw, in the order they appear. */
  flags: Flag[];
  /** The header's counters, as the panel computes them. */
  shown: number;
  total: number;
  flaggedTrees: number;
  treeCount: number;
  counts: Record<Severity, number>;
  /** Per-check chips: every check with a count, and which are hidden. */
  byCode: Array<[FlagCode, number]>;
  hiddenCodes: FlagCode[];
  /** Which sort the list is in. */
  sort: 'severity' | 'tree';
  /** CSS px the panel is laid out at. */
  width: number;
}

/** How many characters of `size` px text fit in `px` pixels. */
export function fitChars(px: number, size: number): number {
  return Math.max(1, Math.floor(px / (size * MONO_ADVANCE)));
}

/** Wrap text to a pixel width, breaking between words and inside a word
 *  only when the word alone is wider than the line. */
export function wrapText(text: string, px: number, size: number): string[] {
  const max = fitChars(px, size);
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= max) {
      line += ` ${word}`;
    } else {
      out.push(line);
      line = word;
    }
    while (line.length > max) {
      out.push(line.slice(0, max));
      line = line.slice(max);
    }
  }
  if (line !== '') out.push(line);
  return out.length > 0 ? out : [''];
}

/** The printed size, in centimetres, of `px` px of type in a figure
 *  `widthPx` wide printed `printedCm` wide. */
export function printedCm(px: number, widthPx: number, printedCm_: number): number {
  return (px / widthPx) * printedCm_;
}

/** The narrowest layout width at which `size` px type clears the floor
 *  when printed `printedCm` wide. What the error message names. */
export function widthForLegibility(size: number, printedWidthCm: number, floorCm = MIN_PRINTED_CM): number {
  return Math.floor((size * printedWidthCm) / floorCm);
}

export interface LegibilityCheck {
  ok: boolean;
  smallestPx: number;
  printedCm: number;
  /** Set when the check fails: the layout width that would satisfy it. */
  suggestedWidth?: number;
  message?: string;
}

/** Will the smallest type in this panel be readable in print? An
 *  arithmetic check, not a judgement — and it names the layout width
 *  that would pass, because "too small" without a number is not a
 *  fault report. */
export function checkLegibility(widthPx: number, printedWidthCm: number, smallestPx = TEXT.code): LegibilityCheck {
  const cm = printedCm(smallestPx, widthPx, printedWidthCm);
  if (cm >= MIN_PRINTED_CM) return { ok: true, smallestPx, printedCm: cm };
  const suggestedWidth = widthForLegibility(smallestPx, printedWidthCm);
  return {
    ok: false,
    smallestPx,
    printedCm: cm,
    suggestedWidth,
    message: `the smallest type would print at ${(cm * 28.35).toFixed(1)} pt, below the 6 pt floor — `
      + `lay the panel out at ${suggestedWidth} px or narrower, or print it wider than ${printedWidthCm} cm`,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A severity's colour as a figure can use it: the panel's `info` is a
 *  CSS variable, which an SVG opened outside the application cannot
 *  resolve. */
export function severityColor(sev: Severity, dark: boolean): string {
  if (dark) return { critical: '#ffb4be', warning: '#e6c068', info: '#9aa4b2' }[sev];
  // Darker on white: the pale pink and amber the dark surface wants are
  // barely visible on paper, and a severity a reader cannot see is not
  // a severity.
  return { critical: '#b3123a', warning: '#8a5a00', info: '#5b6572' }[sev];
}

interface Theme {
  bg: string; text: string; dim: string; mute: string; line: string; chipBg: string;
}

const LIGHT: Theme = { bg: '#ffffff', text: '#12161c', dim: '#39424f', mute: '#69727f', line: '#c8cdd4', chipBg: '#f0f2f5' };
const DARK: Theme = { bg: '#12161c', text: '#e8ecf1', dim: '#b8c0cb', mute: '#8a94a1', line: '#2b323c', chipBg: '#1c222b' };

export interface RenderedPanel {
  svg: string;
  width: number;
  height: number;
  /** Rows actually drawn. */
  rows: number;
  legibility: LegibilityCheck;
}

/** The QC panel as an SVG document, laid out at `fig.width` CSS px.
 *  `printedWidthCm` only feeds the legibility check; it does not change
 *  the drawing. */
export function renderQcPanelSvg(fig: QcPanelFigure, opts: { dark?: boolean; printedWidthCm?: number } = {}): RenderedPanel {
  const t = opts.dark ? DARK : LIGHT;
  const W = fig.width;
  const pad = 10;
  const inner = W - 2 * pad;
  const parts: string[] = [];
  let y = pad;

  const line = (text: string, x: number, size: number, fill: string, extra = '') =>
    parts.push(`<text x="${x.toFixed(2)}" y="${(y + size * 0.8).toFixed(2)}" font-size="${size}" fill="${fill}"${extra}>${esc(text)}</text>`);

  // --- Header: the counters, then the severity chips on the right.
  // They are what makes the review auditable and the first thing a
  // reader checks, so they are never cropped out of the figure.
  const counters = `${fig.shown}/${fig.total} flag${fig.total === 1 ? '' : 's'} on ${fig.flaggedTrees} of ${fig.treeCount} trees`;
  line(counters, pad, TEXT.header, t.dim);
  {
    const chips: Array<[string, Severity]> = [
      [`${fig.counts.critical} critical`, 'critical'],
      [`${fig.counts.warning} warn`, 'warning'],
      [`${fig.counts.info} info`, 'info'],
    ];
    let x = W - pad;
    for (const [label, sev] of chips.slice().reverse()) {
      const w = label.length * TEXT.chip * MONO_ADVANCE + 10;
      x -= w;
      const col = severityColor(sev, !!opts.dark);
      parts.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${(TEXT.chip + 6).toFixed(2)}" rx="3" fill="none" stroke="${col}" stroke-opacity="0.55"/>`);
      parts.push(`<text x="${(x + 5).toFixed(2)}" y="${(y + TEXT.chip * 0.8 + 3).toFixed(2)}" font-size="${TEXT.chip}" fill="${col}">${esc(label)}</text>`);
      x -= 4;
    }
  }
  y += TEXT.header + 10;

  // --- Filter chips: every check, with the hidden ones drawn as the
  // panel draws them. A figure that silently dropped the filters would
  // not say why 56 trees are missing from the list.
  if (fig.byCode.length > 0) {
    let x = pad;
    let rowH = 0;
    for (const [code, n] of fig.byCode) {
      const hidden = fig.hiddenCodes.includes(code);
      const label = `${FLAG_LABEL[code]} ${n}`;
      const w = label.length * TEXT.chip * MONO_ADVANCE + 10;
      if (x + w > W - pad) { x = pad; y += TEXT.chip + 10; }
      const h = TEXT.chip + 6;
      parts.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="2" fill="${hidden ? 'none' : t.chipBg}" stroke="${t.line}"/>`);
      parts.push(`<text x="${(x + 5).toFixed(2)}" y="${(y + TEXT.chip * 0.8 + 3).toFixed(2)}" font-size="${TEXT.chip}" fill="${hidden ? t.mute : t.dim}">${esc(label)}</text>`);
      x += w + 4;
      rowH = h;
    }
    y += rowH + 8;
  }

  // --- The sort state, as the panel shows it.
  line(`sort  ${fig.sort === 'severity' ? '[severity]  tree' : ' severity  [tree]'}`, pad, TEXT.chip, t.mute);
  y += TEXT.chip + 8;

  // --- The rows. Each is a severity bar, a head line, the reason and
  // the hint, both wrapped to the column.
  const listTop = y;
  const barW = 3;
  const textX = pad + barW + 8;
  const textW = W - pad - textX;
  let rows = 0;
  for (const f of fig.flags) {
    const col = severityColor(f.severity, !!opts.dark);
    const head = `tree ${f.treeId}`;
    const badge = FLAG_LABEL[f.code];
    const reason = wrapText(f.reason, textW, TEXT.reason);
    const hint = wrapText(`→ ${f.hint}`, textW, TEXT.hint);
    const rowH = 6 + TEXT.treeId + 4 + reason.length * (TEXT.reason * 1.45) + 2 + hint.length * (TEXT.hint * 1.45) + 6;
    parts.push(`<rect x="${pad}" y="${y.toFixed(2)}" width="${barW}" height="${rowH.toFixed(2)}" fill="${col}"/>`);
    let ry = y + 6;
    parts.push(`<text x="${textX.toFixed(2)}" y="${(ry + TEXT.treeId * 0.8).toFixed(2)}" font-size="${TEXT.treeId}" fill="${t.text}">${esc(head)}</text>`);
    const badgeX = textX + (head.length + 1) * TEXT.treeId * MONO_ADVANCE;
    const badgeW = badge.length * TEXT.code * MONO_ADVANCE + 8;
    parts.push(`<rect x="${badgeX.toFixed(2)}" y="${(ry + 1).toFixed(2)}" width="${badgeW.toFixed(2)}" height="${(TEXT.code + 5).toFixed(2)}" rx="2" fill="none" stroke="${col}" stroke-opacity="0.45"/>`);
    parts.push(`<text x="${(badgeX + 4).toFixed(2)}" y="${(ry + TEXT.code * 0.8 + 3).toFixed(2)}" font-size="${TEXT.code}" fill="${col}">${esc(badge)}</text>`);
    parts.push(`<text x="${(badgeX + badgeW + 6).toFixed(2)}" y="${(ry + TEXT.code * 0.8 + 3).toFixed(2)}" font-size="${TEXT.code}" fill="${col}" letter-spacing="0.4">${esc(f.severity.toUpperCase())}</text>`);
    ry += TEXT.treeId + 4;
    for (const l of reason) {
      parts.push(`<text x="${textX.toFixed(2)}" y="${(ry + TEXT.reason * 0.8).toFixed(2)}" font-size="${TEXT.reason}" fill="${t.dim}">${esc(l)}</text>`);
      ry += TEXT.reason * 1.45;
    }
    ry += 2;
    for (const l of hint) {
      parts.push(`<text x="${textX.toFixed(2)}" y="${(ry + TEXT.hint * 0.8).toFixed(2)}" font-size="${TEXT.hint}" fill="${t.mute}">${esc(l)}</text>`);
      ry += TEXT.hint * 1.45;
    }
    y += rowH;
    parts.push(`<line x1="${pad}" y1="${y.toFixed(2)}" x2="${(W - pad).toFixed(2)}" y2="${y.toFixed(2)}" stroke="${t.line}"/>`);
    rows++;
  }
  if (rows > 0) {
    parts.push(`<rect x="${pad}" y="${listTop.toFixed(2)}" width="${inner.toFixed(2)}" height="${(y - listTop).toFixed(2)}" rx="3" fill="none" stroke="${t.line}"/>`);
  }
  y += pad;

  const height = Math.ceil(y);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="${FONT_STACK}">`
    + `<rect width="${W}" height="${height}" fill="${t.bg}"/>`
    + parts.join('')
    + '</svg>';
  return {
    svg, width: W, height, rows,
    legibility: checkLegibility(W, opts.printedWidthCm ?? 8, TEXT.code),
  };
}

/** The flags a figure shows: the panel's filters applied, its sort, and
 *  the first `rowCount` of the result — never "whatever the scroll
 *  position happens to show". */
export function selectFlags(
  all: Flag[], opts: { hiddenCodes?: FlagCode[]; severities?: Severity[]; sort?: 'severity' | 'tree'; rowCount?: number },
): Flag[] {
  const hidden = new Set(opts.hiddenCodes ?? []);
  const sevOk = new Set(opts.severities ?? ['critical', 'warning', 'info']);
  const kept = all.filter((f) => !hidden.has(f.code) && sevOk.has(f.severity));
  const sorted = kept.slice().sort((a, b) => (
    opts.sort === 'tree'
      ? a.treeId - b.treeId || SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.code.localeCompare(b.code)
      : SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.treeId - b.treeId || a.code.localeCompare(b.code)
  ));
  return opts.rowCount != null ? sorted.slice(0, Math.max(0, opts.rowCount)) : sorted;
}
