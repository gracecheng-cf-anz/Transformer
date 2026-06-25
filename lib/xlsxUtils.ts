import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { createRequire } from 'module';
import type { AdsData } from './googleAds';

// --- Bulletproof safety net -------------------------------------------------
// ExcelJS 4.x crashes with "Cannot read properties of undefined (reading
// 'anchors')" inside WorksheetXform.reconcile when a worksheet references a
// drawing/chart that did not parse into options.drawings. We only care about
// cell values, so we patch reconcile to drop the unresolved drawing and retry
// instead of throwing. This runs once at module load.
let reconcilePatched = false;
function patchExcelJsReconcile() {
  if (reconcilePatched) return;
  reconcilePatched = true;
  try {
    // Prefer the ambient require (present in Next.js server bundles); fall back
    // to createRequire when running as pure ESM.
    const req: NodeRequire =
      typeof require !== 'undefined'
        ? require
        : createRequire(typeof __filename !== 'undefined' ? __filename : process.cwd() + '/');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const WorksheetXform = req('exceljs/lib/xlsx/xform/sheet/worksheet-xform');
    const proto = WorksheetXform?.prototype;
    if (!proto || typeof proto.reconcile !== 'function' || proto.__v0Patched) return;
    const original = proto.reconcile;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proto.reconcile = function patchedReconcile(model: any, options: any) {
      try {
        return original.call(this, model, options);
      } catch (err) {
        if (model && model.drawing) {
          // Drop the unresolvable drawing reference and retry once.
          delete model.drawing;
          return original.call(this, model, options);
        }
        throw err;
      }
    };
    proto.__v0Patched = true;
  } catch {
    // If the internal path changes, fall back to zip sanitization only.
  }
}
patchExcelJsReconcile();

// ExcelJS 4.x throws "Cannot read properties of undefined (reading 'anchors')"
// when a worksheet references a drawing (chart/image) that it cannot fully
// reconcile. This app only reads/writes cell values, so we strip all drawing
// references from the xlsx zip before handing it to ExcelJS.
async function sanitizeXlsxBuffer(buffer: Buffer): Promise<Buffer> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    // Not a zip we can read; let ExcelJS handle/report it.
    return buffer;
  }

  let modified = false;

  // 1. Remove all drawing definition files (drawings, charts, embedded media refs).
  Object.keys(zip.files).forEach(path => {
    if (/^xl\/drawings\//i.test(path) || /^xl\/charts\//i.test(path)) {
      zip.remove(path);
      modified = true;
    }
  });

  // 2. Strip <drawing .../> elements from each worksheet xml.
  const sheetPaths = Object.keys(zip.files).filter(p => /^xl\/worksheets\/sheet[^/]+\.xml$/i.test(p));
  for (const p of sheetPaths) {
    const xml = await zip.file(p)!.async('string');
    const cleaned = xml
      .replace(/<drawing\b[^>]*\/>/gi, '')
      .replace(/<drawing\b[^>]*>[\s\S]*?<\/drawing>/gi, '');
    if (cleaned !== xml) {
      zip.file(p, cleaned);
      modified = true;
    }
  }

  // 3. Remove drawing/chart relationships from worksheet rels.
  const relPaths = Object.keys(zip.files).filter(p => /^xl\/worksheets\/_rels\/.+\.rels$/i.test(p));
  for (const p of relPaths) {
    const xml = await zip.file(p)!.async('string');
    const cleaned = xml.replace(
      /<Relationship\b[^>]*Type="[^"]*\/(?:drawing|chart)[^"]*"[^>]*\/>/gi,
      ''
    );
    if (cleaned !== xml) {
      zip.file(p, cleaned);
      modified = true;
    }
  }

  if (!modified) return buffer;
  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const safe = await sanitizeXlsxBuffer(buffer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(safe as any);
  return wb;
}

export async function workbookToBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function getWeeklySheet(wb: ExcelJS.Workbook): ExcelJS.Worksheet {
  return wb.getWorksheet('Weekly Report') || wb.worksheets[0];
}

// Returns row number (1-based) where any cell exactly matches one of the texts (case-insensitive)
function findRowWithText(sheet: ExcelJS.Worksheet, texts: string[], afterRow = 0): number {
  const lower = texts.map(t => t.toLowerCase().trim());
  const last = sheet.rowCount;
  for (let r = afterRow + 1; r <= last + 5; r++) {
    const row = sheet.getRow(r);
    let found = false;
    row.eachCell({ includeEmpty: false }, cell => {
      const v = String(cell.value ?? '').trim().toLowerCase();
      if (lower.includes(v)) found = true;
    });
    if (found) return r;
  }
  return -1;
}

// Clear cell values (preserve formatting) in a range
function clearRange(sheet: ExcelJS.Worksheet, rowStart: number, rowEnd: number, colStart: number, colEnd: number) {
  for (let r = rowStart; r <= rowEnd; r++) {
    const row = sheet.getRow(r);
    for (let c = colStart; c <= colEnd; c++) {
      row.getCell(c).value = null;
    }
    row.commit();
  }
}

interface FillOptions {
  startCol: number;          // 1-based column B = 2
  percentCols?: number[];    // absolute column indices that should be formatted as 0.00%
  numberCols?: number[];     // absolute column indices formatted as #,##0
  urlCol?: number;           // column to force plain text / wrap off
}

function fillSection(
  sheet: ExcelJS.Worksheet,
  sectionHeaders: string[],
  nextSectionHeaders: string[] | null,
  data: unknown[][],
  opts: FillOptions
) {
  const sectionRow = findRowWithText(sheet, sectionHeaders);
  if (sectionRow === -1) return;

  // Data starts 2 rows after the section header (skip column header row)
  const dataStart = sectionRow + 2;

  // Find data end
  let dataEnd: number;
  if (nextSectionHeaders) {
    const nextRow = findRowWithText(sheet, nextSectionHeaders, sectionRow + 1);
    dataEnd = nextRow !== -1 ? nextRow - 2 : sheet.rowCount;
  } else {
    dataEnd = sheet.rowCount;
  }

  const width = opts.startCol + 14; // clear up to 15 cols
  clearRange(sheet, dataStart, dataEnd, opts.startCol, width);

  data.forEach((rowData, i) => {
    const r = dataStart + i;
    const row = sheet.getRow(r);
    rowData.forEach((val, j) => {
      const cell = row.getCell(opts.startCol + j);
      cell.value = val as ExcelJS.CellValue;
    });
    if (opts.percentCols) {
      opts.percentCols.forEach(c => {
        const cell = row.getCell(c);
        if (!cell.numFmt) cell.numFmt = '0.00%';
      });
    }
    if (opts.numberCols) {
      opts.numberCols.forEach(c => {
        const cell = row.getCell(c);
        if (!cell.numFmt) cell.numFmt = '#,##0';
      });
    }
    if (opts.urlCol) {
      const cell = row.getCell(opts.urlCol);
      cell.alignment = { wrapText: false };
    }
    row.commit();
  });
}

// Write insights to rows 13-20 in column B of Weekly Report
export async function fillInsights(buffer: Buffer, lines: string[]): Promise<Buffer> {
  const wb = await loadWorkbook(buffer);
  const sheet = getWeeklySheet(wb);
  const TARGET_START = 13, TARGET_END = 20, TARGET_COL = 2;
  const count = TARGET_END - TARGET_START + 1;
  const padded = lines.slice(0, count);
  while (padded.length < count) padded.push('');

  for (let i = 0; i < count; i++) {
    const row = sheet.getRow(TARGET_START + i);
    row.getCell(TARGET_COL).value = padded[i];
    row.commit();
  }
  return workbookToBuffer(wb);
}

// Read the Weekly Report sheet as TSV for the insights prompt
export async function sheetToTsv(buffer: Buffer): Promise<string> {
  const wb = await loadWorkbook(buffer);
  const sheet = getWeeklySheet(wb);
  const lines: string[] = [];
  sheet.eachRow({ includeEmpty: false }, row => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, cell => {
      cells.push(String(cell.value ?? '').replace(/\t/g, ' '));
    });
    lines.push(cells.join('\t'));
  });
  return '### Weekly Report\n' + lines.join('\n');
}

// Extract date range from all cell values
export function extractDateRange(wb: ExcelJS.Workbook): { startDate: string; endDate: string } | null {
  const sheet = getWeeklySheet(wb);
  let combined = '';
  sheet.eachRow({ includeEmpty: false }, row => {
    row.eachCell({ includeEmpty: false }, cell => {
      combined += ' ' + String(cell.value ?? '');
    });
  });

  const s = combined.replace(/ /g, ' ');
  const label = '(?:Date\\s*Range|Reporting\\s*Range)\\s*[:\\-]?\\s*';
  const date = '([0-9]{1,2}[\\/\\-][0-9]{1,2}[\\/\\-][0-9]{2,4}|[0-9]{1,2}\\s*[- ]\\s*[A-Za-z]{3,9}\\s*[- ]\\s*[0-9]{2,4}|[0-9]{4}[\\/\\-][0-9]{1,2}[\\/\\-][0-9]{1,2})';
  const re = new RegExp(label + date + '\\s*(?:to|–|—|-)\\s*' + date, 'i');
  const m = s.match(re);
  if (!m) return null;

  const startDate = parseDateToYmd(m[1]);
  const endDate = parseDateToYmd(m[2]);
  if (!startDate || !endDate) return null;
  return { startDate, endDate };
}

function parseDateToYmd(value: string): string {
  let s = String(value || '').trim().replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-');
  if (!s) return '';
  let d: Date | null = null;

  let m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (m) d = new Date(+m[1], +m[2] - 1, +m[3]);

  if (!d) {
    m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
    if (m) { const yr = m[3].length === 2 ? 2000 + +m[3] : +m[3]; d = new Date(yr, +m[2] - 1, +m[1]); }
  }

  if (!d) {
    m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3,9})[- ](\d{2,4})$/);
    if (m) {
      const months: Record<string, number> = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11,january:0,february:1,march:2,april:3,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };
      const mon = months[m[2].toLowerCase().slice(0, 9)];
      if (mon !== undefined) { const yr = m[3].length === 2 ? 2000 + +m[3] : +m[3]; d = new Date(yr, mon, +m[1]); }
    }
  }

  if (!d || isNaN(d.getTime())) return '';
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${dy}`;
}

// Extract PL IDs from Placement section
export function extractPlIds(wb: ExcelJS.Workbook): string[] {
  const sheet = getWeeklySheet(wb);
  let text = '';
  sheet.eachRow({ includeEmpty: false }, row => {
    row.eachCell({ includeEmpty: false }, cell => { text += ' ' + String(cell.value ?? ''); });
  });
  const out: Record<string, boolean> = {};
  const re = /\bPL\s*[-_ ]?\s*(\d{6})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out['PL' + m[1]] = true;
  return Object.keys(out).sort();
}

// Main formatter: fills all sections with ads data
export async function fillWeeklyReport(buffer: Buffer, adsData: AdsData, opportunityName: string): Promise<Buffer> {
  const wb = await loadWorkbook(buffer);
  const sheet = getWeeklySheet(wb);

  // Helper: build total row for 10-col sections
  function totalRow10(rows: number[][]): unknown[] {
    let impr = 0, views = 0, clicks = 0;
    rows.forEach(r => { impr += r[1]; views += r[2]; clicks += r[4]; });
    return ['Total', impr, views, impr > 0 ? views / impr : 0, clicks, impr > 0 ? clicks / impr : 0, 0, 0, 0, 0];
  }

  // Percent cols for 10-col sections (B-K): E=5(viewRate), G=7(ctr), H-K=8-11(quartiles)
  const pct10 = [5, 7, 8, 9, 10, 11];
  // Percent cols for geo (B-G): E=5(viewRate), G=7(ctr)
  const pctGeo = [5, 7];
  // Percent cols for channels (B-I): F=6(viewRate), H=8(ctr), I=9(p100)
  const pctChan = [6, 8, 9];

  // Overall Performance
  const overallRows = [[
    adsData.overall.name || opportunityName || '',
    adsData.overall.impr, adsData.overall.views, adsData.overall.vr,
    adsData.overall.clicks, adsData.overall.ctr,
    adsData.overall.p25, adsData.overall.p50, adsData.overall.p75, adsData.overall.p100,
  ]];
  fillSection(sheet, ['Overall Performance', 'Opportunity Name'], ['Placement'], overallRows, { startCol: 2, percentCols: pct10 });

  // Placement
  const placementRows = adsData.placements.map(p => [
    p.campaign, p.impr, p.views, p.vr, p.clicks, p.ctr, p.p25, p.p50, p.p75, p.p100, p.clientRate || '', p.cost,
  ]);
  // Total row
  let pImpr = 0, pViews = 0, pClicks = 0, pCost = 0;
  adsData.placements.forEach(p => { pImpr += p.impr; pViews += p.views; pClicks += p.clicks; pCost += p.cost; });
  const overallVR = adsData.overall.vr;
  placementRows.push(['Total', pImpr, pViews, overallVR, pClicks, pImpr > 0 ? pClicks / pImpr : 0, 0, 0, 0, 0, '/', pCost]);
  fillSection(sheet, ['Placement'], ['Creative', 'Gender', 'Age', 'Age Group', 'Devices', 'Device Type', 'Geo', 'Channels', 'Top Channels'], placementRows, { startCol: 2, percentCols: pct10 });

  // Creative
  const creativeRows = adsData.creatives.map(c => [
    c.ad, c.impr, c.views, c.vr, c.clicks, c.ctr, c.p25, c.p50, c.p75, c.p100,
  ]);
  let cImpr = 0, cViews = 0, cClicks = 0;
  adsData.creatives.forEach(c => { cImpr += c.impr; cViews += c.views; cClicks += c.clicks; });
  creativeRows.push(['Total', cImpr, cViews, cImpr > 0 ? cViews / cImpr : 0, cClicks, cImpr > 0 ? cClicks / cImpr : 0, 0, 0, 0, 0]);
  fillSection(sheet, ['Creative'], ['Gender', 'Age', 'Age Group', 'Devices', 'Device Type', 'Geo', 'Channels', 'Top Channels'], creativeRows, { startCol: 2, percentCols: pct10 });

  // Gender
  const genderRows = adsData.genders.map(g => [g.label, g.impr, g.views, g.vr, g.clicks, g.ctr, g.p25, g.p50, g.p75, g.p100]);
  fillSection(sheet, ['Gender'], ['Age', 'Age Group', 'Devices', 'Device Type', 'Geo', 'Channels', 'Top Channels'], genderRows, { startCol: 2, percentCols: pct10 });

  // Age Group
  const ageRows = adsData.ages.map(a => [a.label, a.impr, a.views, a.vr, a.clicks, a.ctr, a.p25, a.p50, a.p75, a.p100]);
  fillSection(sheet, ['Age', 'Age Group'], ['Devices', 'Device Type', 'Geo', 'Channels', 'Top Channels'], ageRows, { startCol: 2, percentCols: pct10 });

  // Devices
  const deviceRows = adsData.devices.map(d => [d.label, d.impr, d.views, d.vr, d.clicks, d.ctr, d.p25, d.p50, d.p75, d.p100]);
  fillSection(sheet, ['Devices', 'Device Type'], ['Geo', 'Channels', 'Top Channels'], deviceRows, { startCol: 2, percentCols: pct10 });

  // Geo (B-G, 6 cols)
  const geoRows = adsData.geos.map(g => [g.region, g.impr, g.views, g.vr, g.clicks, g.ctr]);
  fillSection(sheet, ['Geo'], ['Channels', 'Top Channels'], geoRows, { startCol: 2, percentCols: pctGeo });

  // Channels (B-I, 8 cols)
  const chanRows = adsData.channels.map(c => [c.name, c.url, c.impr, c.views, c.vr, c.clicks, c.ctr, c.p100]);
  fillSection(sheet, ['Channels', 'Top Channels', 'Top Channels Report', 'Top Channels (YT)'], null, chanRows, { startCol: 2, percentCols: pctChan, urlCol: 3 });

  // Suppress unused warning
  void totalRow10;

  return workbookToBuffer(wb);
}
