/** How a delimited point-cloud line is cut into cells.
 *
 *  ONE definition, because the header detector and the row parser must
 *  agree: the detector names the columns and records each extra's index,
 *  the parser reads the rows by that index, and if they count columns
 *  differently every extra is off by one for the whole file.
 *
 *  Space collapses runs — an aligned ASCII dump pads with them. Tab and
 *  comma cut one-for-one, so an EMPTY cell stays a cell. Collapsing tab
 *  runs made a missing value vanish and slid every later column left, on
 *  exactly the rows with missing data. Same rule as the Rust importer's
 *  split_cells. */
export function splitCells(line: string, sep: ' ' | ',' | '\t'): string[] {
  if (sep === ' ') return line.trim().split(/\s+/);
  return line.split(sep === '\t' ? '\t' : ',');
}

export interface HeaderInfo {
  header: string[];
  sep: ' ' | ',' | '\t';
  ix: number;
  iy: number;
  iz: number;
  iId: number;
  extraIdx: number[];
  extraNames: string[];
  hadHeader: boolean;
  headerBytes: number;
}

export interface FileLikeForHeader {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** Throwing detector used by the plain parse path — requires X/Y/Z to be
 *  auto-recognised. The import dialog uses detectColumns() instead, which
 *  never throws so the user can map coordinates by hand. */
export async function detectHeader(file: File | FileLikeForHeader): Promise<HeaderInfo> {
  const info = await detectColumns(file);
  if (info.ix < 0 || info.iy < 0 || info.iz < 0) {
    throw new Error('Missing x/y/(z|h) columns in header');
  }
  return info;
}

/** Lenient detector — returns the header names + best-effort role indices
 *  (which may be -1 when a coordinate column can't be auto-recognised) and
 *  never throws. Lets the import dialog open on any delimited file so the
 *  user can assign X/Y/Z/tree_id to the right source columns. */
export async function detectColumns(file: File | FileLikeForHeader): Promise<HeaderInfo> {
  const SAMPLE = Math.min(512 * 1024, file.size);
  const sampleBuf = await file.slice(0, SAMPLE).arrayBuffer();
  const decoder = new TextDecoder('utf-8');
  const sampleText = decoder.decode(sampleBuf);

  const firstNL = sampleText.indexOf('\n');
  let headerLine = (firstNL < 0 ? sampleText : sampleText.slice(0, firstNL)).trim();
  const hadCommentPrefix = /^(\/\/|#)/.test(headerLine);
  if (hadCommentPrefix) headerLine = headerLine.replace(/^(\/\/|#)\s*/, '');
  const sep: ' ' | ',' | '\t' = /,/.test(headerLine) ? ',' : /\t/.test(headerLine) ? '\t' : ' ';
  const firstTok = splitCells(headerLine, sep);
  const firstIsNumeric = !hadCommentPrefix && firstTok.every(t => t !== '' && !isNaN(parseFloat(t)));

  let header: string[];
  let headerBytes = 0;
  if (firstIsNumeric) {
    header = ['x', 'y', 'z', 'tree_id'];
    if (firstTok.length > 4) {
      for (let i = 4; i < firstTok.length; i++) header.push(i === 4 ? 'class' : `col${i}`);
    }
  } else {
    header = splitCells(headerLine, sep).map(s => s.toLowerCase().trim());
    headerBytes = new TextEncoder().encode(
      (firstNL < 0 ? sampleText : sampleText.slice(0, firstNL)) + '\n',
    ).length;
  }

  const ix = header.indexOf('x');
  const iy = header.indexOf('y');
  let iz = header.indexOf('z');
  if (iz < 0) iz = header.indexOf('h');
  let iId = header.indexOf('tree_id');
  if (iId < 0) iId = header.indexOf('treeid');
  if (iId < 0) iId = header.indexOf('instance_pred');
  if (iId < 0) iId = header.indexOf('instance_id');
  if (iId < 0) iId = header.indexOf('instance');
  if (iId < 0) iId = header.indexOf('id');

  const extraIdx: number[] = [];
  const extraNames: string[] = [];
  for (let h = 0; h < header.length; h++) {
    if (h !== ix && h !== iy && h !== iz && h !== iId) {
      extraIdx.push(h);
      extraNames.push(header[h]);
    }
  }

  return { header, sep, ix, iy, iz, iId, extraIdx, extraNames, hadHeader: !firstIsNumeric, headerBytes };
}
