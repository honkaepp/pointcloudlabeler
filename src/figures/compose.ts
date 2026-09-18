// Composing exported images into a print-ready figure, so the
// author never opens an image editor.
//
// Two properties matter and both are geometry, not taste.
//
// REGISTRATION. A before-and-after pair, or a source-and-target pair,
// must be the same camera, the same pixel dimensions and the same crop.
// Matched by hand over the author's own captures the two panels agreed
// to within 2–4 px, which is good enough and is also luck. A shared crop
// box applied to a set of cells is what makes registration survive the
// crop, and it is exactly the Python script this replaces.
//
// PLACEMENT, NOT RESAMPLING. Every cell in a row is the same pixel
// height and every cell in a column the same pixel width, and an image
// is placed at its own size. Resampling is only done when the caller
// asks for a fit, and then it is reported — a figure that was quietly
// stretched is a figure whose scale bar lies.

export interface Size { width: number; height: number }
export interface Rect { x: number; y: number; width: number; height: number }

/** A crop rectangle in source-image pixels, shared across a set of
 *  cells. Clamped to each image, so a box larger than an image crops to
 *  the image rather than producing a torn edge. */
export interface CropBox { x: number; y: number; width: number; height: number }

export function clampCrop(crop: CropBox, img: Size): Rect {
  const x = Math.max(0, Math.min(Math.round(crop.x), img.width - 1));
  const y = Math.max(0, Math.min(Math.round(crop.y), img.height - 1));
  return {
    x, y,
    width: Math.max(1, Math.min(Math.round(crop.width), img.width - x)),
    height: Math.max(1, Math.min(Math.round(crop.height), img.height - y)),
  };
}

export interface GridOptions {
  rows: number;
  cols: number;
  /** Between cells, in output pixels. */
  gutter: number;
  /** Around the whole figure, in output pixels. */
  margin: number;
}

export interface GridLayout {
  /** The composed image's size. */
  size: Size;
  /** One rect per cell, row-major, for the cells that were supplied. */
  cells: Rect[];
  /** Per-column width and per-row height, as the rule demands. */
  colWidths: number[];
  rowHeights: number[];
}

/** Lay out `sizes` (row-major, rows × cols) into a grid. A column is as
 *  wide as its widest cell and a row as tall as its tallest, so every
 *  cell in a row shares a height and every cell in a column a width —
 *  the images are placed inside, centred, never scaled. */
export function layoutGrid(sizes: Size[], opt: GridOptions): GridLayout {
  const { rows, cols, gutter, margin } = opt;
  const colWidths = new Array(cols).fill(0);
  const rowHeights = new Array(rows).fill(0);
  for (let i = 0; i < sizes.length && i < rows * cols; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    colWidths[c] = Math.max(colWidths[c], sizes[i].width);
    rowHeights[r] = Math.max(rowHeights[r], sizes[i].height);
  }
  const width = margin * 2 + colWidths.reduce((a, b) => a + b, 0) + gutter * Math.max(0, cols - 1);
  const height = margin * 2 + rowHeights.reduce((a, b) => a + b, 0) + gutter * Math.max(0, rows - 1);
  const cells: Rect[] = [];
  for (let i = 0; i < sizes.length && i < rows * cols; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const x = margin + colWidths.slice(0, c).reduce((a, b) => a + b, 0) + gutter * c;
    const y = margin + rowHeights.slice(0, r).reduce((a, b) => a + b, 0) + gutter * r;
    // Centred in its cell: a pair that differs by a pixel stays aligned
    // about its middle rather than drifting from one edge.
    cells.push({
      x: x + Math.round((colWidths[c] - sizes[i].width) / 2),
      y: y + Math.round((rowHeights[r] - sizes[i].height) / 2),
      width: sizes[i].width,
      height: sizes[i].height,
    });
  }
  return { size: { width, height }, cells, colWidths, rowHeights };
}

/** Are these images registered — same dimensions, so one crop box means
 *  the same ground on each? */
export function sameSize(sizes: Size[]): boolean {
  return sizes.every((s) => s.width === sizes[0].width && s.height === sizes[0].height);
}

/** The dpi a composed figure prints at, at a stated physical width.
 *  Shown BEFORE the file is written, so an under-resolution figure is
 *  caught in the application rather than at submission. */
export function dpiAt(widthPx: number, printedWidthCm: number): number {
  return (widthPx / printedWidthCm) * 2.54;
}

/** Elsevier's floors: 300 dpi for halftone (a photograph or a rendered
 *  point cloud), 500 for combination art (a rendering with type on it,
 *  and any panel export). */
export const DPI_HALFTONE = 300;
export const DPI_COMBINATION = 500;

export interface DpiVerdict {
  dpi: number;
  ok: boolean;
  required: number;
  /** The pixel width that would clear the floor at this printed width. */
  neededPx: number;
  message: string;
}

export function checkDpi(widthPx: number, printedWidthCm: number, kind: 'halftone' | 'combination'): DpiVerdict {
  const required = kind === 'halftone' ? DPI_HALFTONE : DPI_COMBINATION;
  const dpi = dpiAt(widthPx, printedWidthCm);
  const neededPx = Math.ceil((required * printedWidthCm) / 2.54);
  return {
    dpi, required, neededPx,
    ok: dpi >= required,
    message: dpi >= required
      ? `${Math.round(dpi)} dpi at ${printedWidthCm} cm — clears the ${required} dpi floor`
      : `${Math.round(dpi)} dpi at ${printedWidthCm} cm, below the ${required} dpi floor — export at ${neededPx} px wide or print it narrower`,
  };
}
