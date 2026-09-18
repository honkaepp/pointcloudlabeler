import { detectHeader, type HeaderInfo } from './parser/headerDetect';
import { TxtStreamParser, type ParsedCloudData } from './parser/streamParser';

export type ParsedCloud = ParsedCloudData;

export interface FileLike {
  name?: string;
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

const CHUNK = 16 * 1024 * 1024;

// Parses TXT/XYZ/CSV on the main thread. Worker-based parsing was attempted but a
// 4.8 GB / ~100M-point file overruns the worker's 4 GiB heap (final positions alone
// are ~1.2 GB; segments + treeIds + the pre-transfer clone push us over). The main
// thread has the same V8 limit but the Tauri webview renderer gets the bigger heap budget
// because no extra buffers have to be cloned out at the end.
//
// We yield with setTimeout(0) every chunk so the UI thread can process input even
// while parsing. The actual parse loop still blocks; that's the cost of getting
// the parsing to complete at all.
export async function parseTxtStream(
  file: File | FileLike,
  onProgress?: (bytesRead: number, total: number, rows: number) => void,
): Promise<ParsedCloud> {
  const headerInfo = await detectHeader(file);
  return parseTxtStreamWithHeader(file, headerInfo, onProgress);
}

/** Parse with a caller-supplied (possibly user-overridden) HeaderInfo —
 *  the import column-mapping dialog uses this to reassign which source
 *  columns become X / Y / Z / tree_id before the body parse runs. */
export async function parseTxtStreamWithHeader(
  file: File | FileLike,
  headerInfo: HeaderInfo,
  onProgress?: (bytesRead: number, total: number, rows: number) => void,
): Promise<ParsedCloud> {
  const parser = new TxtStreamParser(headerInfo);
  const total = file.size;
  let offset = headerInfo.headerBytes;
  while (offset < total) {
    const end = Math.min(offset + CHUNK, total);
    const buf = await file.slice(offset, end).arrayBuffer();
    const bytes = new Uint8Array(buf);
    const isLast = end >= total;
    parser.processChunk(bytes, isLast);
    offset = end;
    if (onProgress) onProgress(offset, total, parser.rows());
    // Yield so the UI can paint progress and handle input.
    await new Promise(r => setTimeout(r, 0));
  }
  return parser.finish();
}
