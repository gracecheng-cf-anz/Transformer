export function normalizePlId(v: unknown): string {
  const m = String(v || '').toUpperCase().match(/PL\s*[-_ ]?\s*(\d{6})/);
  return m ? 'PL' + m[1] : '';
}

async function readSheet(spreadsheetId: string, sheetName: string, range: string, token: string): Promise<string[][]> {
  const encoded = encodeURIComponent(`${sheetName}!${range}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encoded}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Sheets API error: ' + await res.text());
  const data = await res.json();
  return (data.values || []) as string[][];
}

export async function resolveAccountIds(plIds: string[], token: string): Promise<string[]> {
  const spreadsheetId = process.env.SPREADSHEET_ID!;
  const sheetName = process.env.ALL_DATA_SHEET_NAME || 'All Data (Daily)';
  // Columns E:U — E=PL ID, U=Account ID (17 cols)
  const rows = await readSheet(spreadsheetId, sheetName, 'E:U', token);
  const wanted = new Set(plIds.map(normalizePlId).filter(Boolean));
  const found = new Set<string>();
  for (const row of rows) {
    const pl = normalizePlId(row[0]);
    const accountId = String(row[16] || '').trim().replace(/-/g, '').replace(/\s+/g, '');
    if (pl && wanted.has(pl) && accountId) found.add(accountId);
  }
  return [...found].sort();
}

export async function buildPlLookupMap(plIds: string[], token: string): Promise<Record<string, { costMethod: string; clientRate: number | string }>> {
  const spreadsheetId = process.env.SPREADSHEET_ID!;
  const sheetName = process.env.PL_MAP_SHEET_NAME || 'OP PL Map';
  const rows = await readSheet(spreadsheetId, sheetName, 'A:Z', token);
  if (rows.length < 2) return {};

  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const plCol = header.findIndex(h => h === 'pl id' || h === 'plid' || h === 'pl');
  const cmCol = header.findIndex(h => h === 'cost method');
  const rateCol = header.findIndex(h => h === 'client rate');
  if (plCol === -1) return {};

  const map: Record<string, { costMethod: string; clientRate: number | string }> = {};
  const wanted = new Set(plIds.map(normalizePlId).filter(Boolean));
  for (let r = 1; r < rows.length; r++) {
    const pl = normalizePlId(rows[r][plCol]);
    if (!pl || !wanted.has(pl)) continue;
    const rate = cmCol >= 0 ? parseFloat(String(rows[r][rateCol] || '').replace(/[^0-9.]/g, '')) : NaN;
    map[pl] = {
      costMethod: cmCol >= 0 ? String(rows[r][cmCol] || '').trim() : '',
      clientRate: isNaN(rate) ? '' : rate,
    };
  }
  return map;
}

export async function buildOpportunityName(plIds: string[], token: string): Promise<string> {
  const spreadsheetId = process.env.SPREADSHEET_ID!;
  const sheetName = process.env.PL_MAP_SHEET_NAME || 'OP PL Map';
  // Cols B:E — B=PL ID, E=Opportunity Name
  const rows = await readSheet(spreadsheetId, sheetName, 'B:E', token);
  if (rows.length < 2) return '';

  const wanted = new Set(plIds.map(normalizePlId).filter(Boolean));
  const seen = new Set<string>();
  const out: string[] = [];
  for (let r = 1; r < rows.length; r++) {
    const pl = normalizePlId(rows[r][0]);
    const name = String(rows[r][3] || '').trim();
    if (!pl || !wanted.has(pl) || !name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(name); }
  }
  return out.join(', ');
}

export async function buildCampaignFilterCodes(plIds: string[], token: string): Promise<string[]> {
  const spreadsheetId = process.env.SPREADSHEET_ID!;
  const sheetName = process.env.PL_MAP_SHEET_NAME || 'OP PL Map';
  const rows = await readSheet(spreadsheetId, sheetName, 'A:Z', token);
  if (rows.length < 2) return plIds;

  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const plCol = header.findIndex(h => h === 'pl id' || h === 'plid' || h === 'pl');
  const opCol = header.findIndex(h => h === 'op id' || h === 'opid' || h === 'opportunity id');
  if (plCol === -1) return plIds;

  const wanted = new Set(plIds.map(normalizePlId).filter(Boolean));
  const out = new Set<string>(plIds.map(normalizePlId).filter(Boolean));

  for (let r = 1; r < rows.length; r++) {
    const pl = normalizePlId(rows[r][plCol]);
    if (!pl || !wanted.has(pl)) continue;
    if (opCol >= 0) {
      const op = String(rows[r][opCol] || '').trim().toUpperCase().replace(/\s+/g, '').replace(/^OP[-_ ]?/, 'OP');
      if (op) out.add(op);
    }
  }
  return [...out].sort();
}
