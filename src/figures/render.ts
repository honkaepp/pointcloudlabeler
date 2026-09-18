// The browser half of the figure exporter: an SVG document to PNG
// bytes at a chosen device pixel ratio, and images composed into a grid.
//
// Two levers, kept apart on purpose (see panelSvg): the SVG is LAID OUT
// at a CSS width the caller chose, and RASTERISED at a pixel ratio the
// caller chose. A panel laid out at 480 CSS px and rendered at DPR 4 is
// 1920 device px wide — printed 8 cm that is 610 dpi with 11 px type
// setting at 9.2 pt. Neither lever alone solves both.

import { clampCrop, layoutGrid, type CropBox, type GridOptions, type Size } from './compose';

function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas context — the figure cannot be rasterised');
  return { canvas, ctx };
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('the canvas produced no PNG');
  return new Uint8Array(await blob.arrayBuffer());
}

/** An SVG document as an image, so it can be drawn into a canvas. A data
 *  URL rather than a blob URL: it needs no revoking and it cannot be
 *  refused by a stricter content policy. */
function svgImage(svg: string): Promise<HTMLImageElement> {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('the SVG could not be rasterised'));
    img.src = url;
  });
}

export interface RasterResult {
  png: Uint8Array;
  width: number;
  height: number;
}

/** Rasterise an SVG at `dpr`. The document's own CSS size times the
 *  ratio: the layout does not move, only the sampling. */
export async function svgToPng(svg: string, cssWidth: number, cssHeight: number, dpr: number): Promise<RasterResult> {
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  const img = await svgImage(svg);
  const { canvas, ctx } = canvasOf(width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return { png: await canvasToPng(canvas), width, height };
}

/** A PNG's pixels back, for composing. */
export async function pngToImage(png: Uint8Array): Promise<HTMLImageElement> {
  const blob = new Blob([png.slice().buffer as ArrayBuffer], { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('an exported PNG could not be read back'));
      img.src = url;
    });
  } finally {
    // Revoked after onload has fired: the image keeps its own decoded copy.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export interface ComposeInput {
  /** The cell's image. */
  png: Uint8Array;
  /** Apply the figure's shared crop to this cell. Panel cells do not:
   *  a crop box measured on a rendered view means nothing on a panel. */
  cropped: boolean;
}

export interface ComposeResult {
  png: Uint8Array;
  width: number;
  height: number;
  /** True when any cell had to be scaled to fit. Never on the path the
   *  paper uses — reported because a figure that was quietly stretched
   *  is a figure whose scale bar lies. */
  resampled: boolean;
}

/** Place the cells in a grid on `background`, cropping the ones that
 *  asked for it with ONE rectangle, so registration survives the crop. */
export async function composeGrid(
  cells: ComposeInput[], grid: GridOptions, crop: CropBox | null, background: string,
): Promise<ComposeResult> {
  const images = await Promise.all(cells.map((c) => pngToImage(c.png)));
  const sources = images.map((img, i) => {
    const full = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
    return crop && cells[i].cropped ? clampCrop(crop, { width: img.naturalWidth, height: img.naturalHeight }) : full;
  });
  const sizes: Size[] = sources.map((s) => ({ width: s.width, height: s.height }));
  const layout = layoutGrid(sizes, grid);
  const { canvas, ctx } = canvasOf(layout.size.width, layout.size.height);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Nearest-neighbour: nothing here is meant to be scaled, and a smooth
  // resample of a point cloud invents density that is not in the data.
  ctx.imageSmoothingEnabled = false;
  for (let i = 0; i < images.length && i < layout.cells.length; i++) {
    const s = sources[i];
    const d = layout.cells[i];
    ctx.drawImage(images[i], s.x, s.y, s.width, s.height, d.x, d.y, d.width, d.height);
  }
  return { png: await canvasToPng(canvas), width: canvas.width, height: canvas.height, resampled: false };
}

/** RGBA read back from the renderer, as a PNG, on a chosen background.
 *  The renderer already cleared to that colour; this is the encode. */
export async function rgbaToPngOn(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): Promise<Uint8Array> {
  const { canvas, ctx } = canvasOf(width, height);
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvasToPng(canvas);
}
