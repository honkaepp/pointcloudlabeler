/** PNG bytes out of what WebGL read back — for the Compare view's
 *  figure export. The encoder is the browser's own (a canvas's
 *  toBlob): no library, and the same PNG every browser writes. */

/** WebGL reads pixels bottom row first; an image starts at the top.
 *  Flip, and force the alpha opaque — the export is drawn on a solid
 *  white, so a stray alpha would only ever be a premultiplication
 *  artefact of the read-back. */
export type RgbaImage = Uint8ClampedArray<ArrayBuffer>;

export function flipRowsRgba(rgba: Uint8Array, width: number, height: number): RgbaImage {
  const rowBytes = width * 4;
  const out = new Uint8ClampedArray(new ArrayBuffer(rgba.length));
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * rowBytes;
    out.set(rgba.subarray(src, src + rowBytes), y * rowBytes);
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
}

function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas context for the PNG encoder');
  return { canvas, ctx };
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('the canvas produced no PNG');
  return new Uint8Array(await blob.arrayBuffer());
}

/** One pane as a PNG. `rgba` is top row first (see flipRowsRgba). */
export async function rgbaToPng(rgba: RgbaImage, width: number, height: number): Promise<Uint8Array> {
  const { canvas, ctx } = canvasOf(width, height);
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvasToPng(canvas);
}

/** Both panes in one image, a white gutter between them, nothing else:
 *  no labels, no captions — a publication adds those. */
export async function composeSideBySidePng(
  left: RgbaImage, right: RgbaImage, width: number, height: number, gutter: number,
): Promise<Uint8Array> {
  const { canvas, ctx } = canvasOf(2 * width + gutter, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.putImageData(new ImageData(left, width, height), 0, 0);
  ctx.putImageData(new ImageData(right, width, height), width + gutter, 0);
  return canvasToPng(canvas);
}
