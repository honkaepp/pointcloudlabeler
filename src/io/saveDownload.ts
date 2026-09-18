// Saving a file the user asked for, from a panel.
//
// THE BUTTONS DID NOTHING. Fourteen exports across the application built
// a Blob, made an object URL, and clicked a synthetic `<a download>`.
// That is how a web page saves a file, and this is not a web page: in
// the WebView2 control the desktop build runs in, a download navigation
// is not handled — no dialog, no file, no error. The QC panel's CSV
// button was reported as "does not work" and every one of the others
// was equally dead.
//
// So a save goes through the native dialog and the Rust writer when the
// bridge is there, and keeps the object-URL path only for a plain
// browser (`npm run dev` in Chrome), where it is the only way.

import { csvText } from './csv';

interface SaveBridge {
  saveCsvDialog?: (defaultName: string) => Promise<string | null>;
  saveExportDialog?: (
    defaultName: string,
    filters: { name: string; extensions: string[] }[],
    title?: string,
  ) => Promise<string | null>;
  writeFile?: (path: string, content: string) => Promise<boolean>;
  writeFileBytes?: (path: string, bytes: Uint8Array) => Promise<boolean>;
}

function bridge(): SaveBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { desktop?: SaveBridge }).desktop;
}

/** What a save did: the path written, or null when the user cancelled
 *  the dialog or the browser took the download. */
export type SaveResult = string | null;

export type { SaveBridge };

/** The extension of a file name, without the dot; '' when it has none. */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : '';
}

/** A filter for the OS dialog's dropdown, from the default name's own
 *  extension, so the dialog offers what the caller is writing. */
export function filtersFor(defaultName: string): { name: string; extensions: string[] }[] {
  const ext = extensionOf(defaultName);
  const label: Record<string, string> = {
    csv: 'CSV (comma-separated)',
    gpx: 'GPX track / waypoints',
    html: 'HTML document',
    json: 'JSON',
    png: 'PNG image',
    svg: 'SVG image',
    txt: 'Text file',
  };
  if (!ext) return [{ name: 'All files', extensions: ['*'] }];
  return [{ name: label[ext] ?? `${ext.toUpperCase()} file`, extensions: [ext] }];
}

/** Ask the user where to put a file called `defaultName`. Null when
 *  they cancel, or when there is no desktop bridge to ask. */
async function askWhere(d: SaveBridge, defaultName: string): Promise<SaveResult> {
  if (extensionOf(defaultName) === 'csv' && d.saveCsvDialog) return d.saveCsvDialog(defaultName);
  if (d.saveExportDialog) return d.saveExportDialog(defaultName, filtersFor(defaultName));
  return null;
}

/** The browser's own download, for a build with no desktop bridge. */
function downloadBlob(blob: Blob, defaultName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Save text — the dialog and the native writer on the desktop, the
 *  browser's download without one. The path written, or null. */
export function saveTextFile(text: string, defaultName: string, mime = 'text/plain;charset=utf-8'): Promise<SaveResult> {
  return saveTextFileWith(bridge(), text, defaultName, mime);
}

/** `saveTextFile` against a given bridge — the seam the tests drive,
 *  since they run without a DOM to hang one on. */
export async function saveTextFileWith(
  d: SaveBridge | undefined, text: string, defaultName: string, mime = 'text/plain;charset=utf-8',
): Promise<SaveResult> {
  if (d?.writeFile) {
    const path = await askWhere(d, defaultName);
    if (!path) return null;
    await d.writeFile(path, text);
    return path;
  }
  downloadBlob(new Blob([text], { type: mime }), defaultName);
  return null;
}

/** Save a CSV: the same file `csvBlob` made — UTF-8 with the BOM Excel
 *  needs — through whichever path exists. */
export function saveCsvFile(lines: string[], defaultName: string): Promise<SaveResult> {
  return saveCsvFileWith(bridge(), lines, defaultName);
}

export function saveCsvFileWith(d: SaveBridge | undefined, lines: string[], defaultName: string): Promise<SaveResult> {
  return saveTextFileWith(d, csvText(lines), defaultName, 'text/csv;charset=utf-8');
}

/** Save bytes (a PNG, say). */
export function saveBytesFile(bytes: Uint8Array, defaultName: string, mime = 'application/octet-stream'): Promise<SaveResult> {
  return saveBytesFileWith(bridge(), bytes, defaultName, mime);
}

export async function saveBytesFileWith(
  d: SaveBridge | undefined, bytes: Uint8Array, defaultName: string, mime = 'application/octet-stream',
): Promise<SaveResult> {
  if (d?.writeFileBytes) {
    const path = await askWhere(d, defaultName);
    if (!path) return null;
    await d.writeFileBytes(path, bytes);
    return path;
  }
  // A copy into a plain ArrayBuffer: a view onto a larger or shared
  // buffer would put the whole buffer in the blob.
  downloadBlob(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }), defaultName);
  return null;
}
