const API_VERSION = 'v22';

interface Bucket {
  impr: number; clicks: number; views: number; costMicros: number;
  q25w: number; q50w: number; q75w: number; q100w: number; vrw: number;
}

function makeBucket(): Bucket {
  return { impr: 0, clicks: 0, views: 0, costMicros: 0, q25w: 0, q50w: 0, q75w: 0, q100w: 0, vrw: 0 };
}

function toInt(v: unknown): number { const n = parseInt(String(v ?? ''), 10); return isNaN(n) ? 0 : n; }
function toNum(v: unknown): number { const n = parseFloat(String(v ?? '')); return isNaN(n) ? 0 : n; }

function getField(row: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.').map(s => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = row;
  for (const p of parts) { if (cur == null) return ''; cur = cur[p]; }
  return cur ?? '';
}

function addToBucket(b: Bucket, row: Record<string, unknown>, opts?: { includeQuartiles?: boolean }) {
  const I = toInt(getField(row, 'metrics.impressions'));
  if (I <= 0) return;
  b.impr += I;
  b.clicks += toInt(getField(row, 'metrics.clicks'));
  b.views += toInt(getField(row, 'metrics.video_trueview_views'));
  b.costMicros += toInt(getField(row, 'metrics.cost_micros'));
  if (opts?.includeQuartiles !== false) {
    b.q25w += toNum(getField(row, 'metrics.video_quartile_p25_rate')) * I;
    b.q50w += toNum(getField(row, 'metrics.video_quartile_p50_rate')) * I;
    b.q75w += toNum(getField(row, 'metrics.video_quartile_p75_rate')) * I;
    b.q100w += toNum(getField(row, 'metrics.video_quartile_p100_rate')) * I;
  }
  const vvr = toNum(getField(row, 'metrics.video_trueview_view_rate'));
  if (vvr > 0) b.vrw += vvr * I;
}

function finalizeBucket(b: Bucket) {
  const I = b.impr;
  return {
    impr: I, clicks: b.clicks, views: b.views,
    cost: b.costMicros / 1_000_000,
    ctr: I > 0 ? b.clicks / I : 0,
    p25: I > 0 ? b.q25w / I : 0,
    p50: I > 0 ? b.q50w / I : 0,
    p75: I > 0 ? b.q75w / I : 0,
    p100: I > 0 ? b.q100w / I : 0,
    vrMetric: I > 0 ? b.vrw / I : 0,
  };
}

async function searchPage(customerId: string, gaql: string, token: string, pageToken?: string) {
  const clean = customerId.replace(/-/g, '');
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${clean}/googleAds:search`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
    'Content-Type': 'application/json',
  };
  const loginId = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');
  if (loginId) headers['login-customer-id'] = loginId;

  const body: Record<string, unknown> = { query: gaql };
  if (pageToken) body.pageToken = pageToken;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Ads API failed. Customer: ${clean}. HTTP ${res.status}: ${text}`);
  return JSON.parse(text) as { results?: Record<string, unknown>[]; nextPageToken?: string };
}

export async function queryRows(customerId: string, gaql: string, token: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const page = await searchPage(customerId, gaql, token, pageToken);
    if (page.results) rows.push(...page.results);
    pageToken = page.nextPageToken;
    if (++pages > 1000) throw new Error('Too many pages — reduce date range');
  } while (pageToken);
  return rows;
}

function dateFilter(start: string, end: string) {
  return `segments.date BETWEEN '${start}' AND '${end}'`;
}

function escRe(s: string) { return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'); }
function plAtom(code: string) {
  const m = code.trim().toUpperCase().match(/^([A-Z]+)\s*[-_ ]?\s*(\d+)$/);
  return m ? `${m[1]}[ _-]?${m[2]}` : escRe(code.trim().toUpperCase());
}

function campaignWhereClause(filterCodes: string[]): string | null {
  const atoms = [...new Set(filterCodes.filter(Boolean).map(plAtom))];
  if (!atoms.length) return null;
  return `campaign.name REGEXP_MATCH '(?i).*(${atoms.join('|')})'`;
}

function buildWhere(parts: string[], filterCodes: string[]): string {
  const all = [...parts];
  const cl = campaignWhereClause(filterCodes);
  if (cl) all.push(cl);
  return 'WHERE ' + all.join('\n  AND ');
}

async function buildVRMap(
  customerId: string, token: string, start: string, end: string,
  filterCodes: string[], dimensionField?: string
): Promise<Record<string, number>> {
  const select = ['campaign.name', 'segments.ad_format_type', 'metrics.impressions', 'metrics.video_trueview_views'];
  if (dimensionField) select.unshift(dimensionField);

  const gaql = [
    `SELECT ${select.join(', ')}`,
    'FROM ad_group_ad',
    buildWhere([dateFilter(start, end), "segments.ad_format_type IN (INSTREAM_SKIPPABLE, SHORTS)", 'metrics.impressions > 0'], filterCodes),
  ].join('\n');

  const rows = await queryRows(customerId, gaql, token);
  const map: Record<string, { impr: number; views: number }> = {};
  for (const row of rows) {
    const key = dimensionField ? String(getField(row, dimensionField) || '') : '__ALL__';
    const I = toInt(getField(row, 'metrics.impressions'));
    if (I <= 0) continue;
    if (!map[key]) map[key] = { impr: 0, views: 0 };
    map[key].impr += I;
    map[key].views += toInt(getField(row, 'metrics.video_trueview_views'));
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) out[k] = v.impr > 0 ? v.views / v.impr : 0;
  return out;
}

function normalizeAgeLabel(raw: string): string {
  const s = String(raw || '').trim();
  const l = s.toLowerCase();
  if (/undetermined|unknown/.test(l)) return 'UNDETERMINED';
  if (/age_range_18_24|18.*24/.test(l)) return '18-24';
  if (/age_range_25_34|25.*34/.test(l)) return '25-34';
  if (/age_range_35_44|35.*44/.test(l)) return '35-44';
  if (/age_range_45_54|45.*54/.test(l)) return '45-54';
  if (/age_range_55_64|55.*64/.test(l)) return '55-64';
  if (/65_up|65\+|65.*up/.test(l)) return '65+';
  const m = s.match(/(\d{2})[-_](\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  return s;
}

function normalizeGenderLabel(raw: string): string {
  const l = String(raw || '').toLowerCase();
  if (l.includes('female')) return 'Female';
  if (l.includes('male')) return 'Male';
  return 'Undetermined';
}

function normalizeDeviceLabel(raw: string): string {
  const l = String(raw || '').toLowerCase();
  if (l.includes('mobile')) return 'Mobile phones';
  if (l.includes('desktop') || l.includes('computer')) return 'Computers';
  if (l.includes('tablet')) return 'Tablets';
  if (l.includes('connected_tv') || l.includes('tv')) return 'TV screens';
  return raw;
}

export interface AdsData {
  overall: { name: string; impr: number; clicks: number; views: number; vr: number; ctr: number; p25: number; p50: number; p75: number; p100: number; cost: number };
  placements: Array<{ campaign: string; impr: number; clicks: number; views: number; vr: number; ctr: number; p25: number; p50: number; p75: number; p100: number; cost: number; costMethod: string; clientRate: number | string }>;
  creatives: Array<{ ad: string; impr: number; clicks: number; views: number; vr: number; ctr: number; p25: number; p50: number; p75: number; p100: number }>;
  genders: Array<{ label: string; impr: number; clicks: number; views: number; vr: number; ctr: number; p25: number; p50: number; p75: number; p100: number }>;
  ages: Array<{ label: string; impr: number; clicks: number; views: number; vr: number; ctr: number; p25: number; p50: number; p75: number; p100: number }>;
  devices: Array<{ label: string; impr: number; clicks: number; views: number; vr: number; ctr: number; p25: number; p50: number; p75: number; p100: number }>;
  geos: Array<{ region: string; impr: number; clicks: number; views: number; vr: number; ctr: number }>;
  channels: Array<{ name: string; url: string; impr: number; views: number; vr: number; clicks: number; ctr: number; p100: number }>;
}

export async function pullAllAdsData(
  accountIds: string[],
  startDate: string, endDate: string,
  filterCodes: string[],
  plLookupMap: Record<string, { costMethod: string; clientRate: number | string }>,
  opportunityName: string,
  token: string
): Promise<AdsData> {
  const overallBucket = makeBucket();
  let overallVrViews = 0, overallVrImpr = 0;

  const placementMap: Record<string, Bucket> = {};
  const placementVR: Record<string, number> = {};
  const creativeMap: Record<string, Bucket> = {};
  const creativeVR: Record<string, number> = {};

  type DemoBucket = { impr: number; clicks: number; views: number; elig: number; q25w: number; q50w: number; q75w: number; q100w: number };
  const genderMap: Record<string, DemoBucket> = {};
  const ageMap: Record<string, DemoBucket> = {};
  const deviceMap: Record<string, DemoBucket> = {};

  type GeoBucket = { impr: number; clicks: number; views: number; vrw: number };
  const geoMap: Record<string, GeoBucket> = {};
  const geoResourceNames = new Set<string>();

  type ChanBucket = { url: string; impr: number; views: number; clicks: number; p100w: number };
  const chanMap: Record<string, ChanBucket> = {};

  for (const customerId of accountIds) {
    // Overall + Placement
    {
      const gaql = [
        'SELECT campaign.name, metrics.impressions, metrics.clicks, metrics.video_trueview_views, metrics.cost_micros,',
        '  metrics.video_quartile_p25_rate, metrics.video_quartile_p50_rate, metrics.video_quartile_p75_rate, metrics.video_quartile_p100_rate',
        'FROM ad_group_ad',
        buildWhere([dateFilter(startDate, endDate), 'metrics.impressions > 0'], filterCodes),
      ].join('\n');
      const rows = await queryRows(customerId, gaql, token);
      for (const row of rows) {
        addToBucket(overallBucket, row);
        const key = String(getField(row, 'campaign.name') || 'UNKNOWN');
        if (!placementMap[key]) placementMap[key] = makeBucket();
        addToBucket(placementMap[key], row);
      }

      const vrAll = await buildVRMap(customerId, token, startDate, endDate, filterCodes);
      if ((vrAll.__ALL__ || 0) > 0) {
        overallVrViews += overallBucket.views;
        overallVrImpr += overallBucket.views / vrAll.__ALL__!;
      }
      const vrByCampaign = await buildVRMap(customerId, token, startDate, endDate, filterCodes, 'campaign.name');
      Object.assign(placementVR, vrByCampaign);
    }

    // Creative
    {
      const gaql = [
        'SELECT campaign.name, ad_group_ad.ad.name, metrics.impressions, metrics.clicks, metrics.video_trueview_views,',
        '  metrics.video_quartile_p25_rate, metrics.video_quartile_p50_rate, metrics.video_quartile_p75_rate, metrics.video_quartile_p100_rate',
        'FROM ad_group_ad',
        buildWhere([dateFilter(startDate, endDate), 'metrics.impressions > 0'], filterCodes),
      ].join('\n');
      const rows = await queryRows(customerId, gaql, token);
      for (const row of rows) {
        const key = String(getField(row, 'ad_group_ad.ad.name') || 'UNKNOWN');
        if (!creativeMap[key]) creativeMap[key] = makeBucket();
        addToBucket(creativeMap[key], row);
      }
      const vrByAd = await buildVRMap(customerId, token, startDate, endDate, filterCodes, 'ad_group_ad.ad.name');
      Object.assign(creativeVR, vrByAd);
    }

    // Gender
    {
      const gaql = [
        'SELECT campaign.name, ad_group_criterion.gender.type, metrics.impressions, metrics.clicks, metrics.video_trueview_views, metrics.video_trueview_view_rate,',
        '  metrics.video_quartile_p25_rate, metrics.video_quartile_p50_rate, metrics.video_quartile_p75_rate, metrics.video_quartile_p100_rate',
        'FROM gender_view',
        buildWhere([dateFilter(startDate, endDate), 'metrics.impressions > 0'], filterCodes),
      ].join('\n');
      for (const row of await queryRows(customerId, gaql, token)) {
        const key = normalizeGenderLabel(String(getField(row, 'ad_group_criterion.gender.type') || ''));
        const I = toInt(getField(row, 'metrics.impressions'));
        if (I <= 0) continue;
        const V = toInt(getField(row, 'metrics.video_trueview_views'));
        const VR = toNum(getField(row, 'metrics.video_trueview_view_rate'));
        if (!genderMap[key]) genderMap[key] = { impr: 0, clicks: 0, views: 0, elig: 0, q25w: 0, q50w: 0, q75w: 0, q100w: 0 };
        const b = genderMap[key];
        b.impr += I; b.clicks += toInt(getField(row, 'metrics.clicks')); b.views += V;
        b.q25w += toNum(getField(row, 'metrics.video_quartile_p25_rate')) * I;
        b.q50w += toNum(getField(row, 'metrics.video_quartile_p50_rate')) * I;
        b.q75w += toNum(getField(row, 'metrics.video_quartile_p75_rate')) * I;
        b.q100w += toNum(getField(row, 'metrics.video_quartile_p100_rate')) * I;
        if (VR > 0) b.elig += V / VR;
      }
    }

    // Age
    {
      const gaql = [
        'SELECT campaign.name, ad_group_criterion.age_range.type, metrics.impressions, metrics.clicks, metrics.video_trueview_views, metrics.video_trueview_view_rate,',
        '  metrics.video_quartile_p25_rate, metrics.video_quartile_p50_rate, metrics.video_quartile_p75_rate, metrics.video_quartile_p100_rate',
        'FROM age_range_view',
        buildWhere([dateFilter(startDate, endDate), 'metrics.impressions > 0'], filterCodes),
      ].join('\n');
      for (const row of await queryRows(customerId, gaql, token)) {
        const key = normalizeAgeLabel(String(getField(row, 'ad_group_criterion.age_range.type') || ''));
        const I = toInt(getField(row, 'metrics.impressions'));
        if (I <= 0) continue;
        const V = toInt(getField(row, 'metrics.video_trueview_views'));
        const VR = toNum(getField(row, 'metrics.video_trueview_view_rate'));
        if (!ageMap[key]) ageMap[key] = { impr: 0, clicks: 0, views: 0, elig: 0, q25w: 0, q50w: 0, q75w: 0, q100w: 0 };
        const b = ageMap[key];
        b.impr += I; b.clicks += toInt(getField(row, 'metrics.clicks')); b.views += V;
        b.q25w += toNum(getField(row, 'metrics.video_quartile_p25_rate')) * I;
        b.q50w += toNum(getField(row, 'metrics.video_quartile_p50_rate')) * I;
        b.q75w += toNum(getField(row, 'metrics.video_quartile_p75_rate')) * I;
        b.q100w += toNum(getField(row, 'metrics.video_quartile_p100_rate')) * I;
        if (VR > 0) b.elig += V / VR;
      }
    }

    // Devices
    {
      const gaql = [
        "SELECT campaign.name, segments.device, metrics.impressions, metrics.video_trueview_views, metrics.video_trueview_view_rate, metrics.clicks,",
        "  metrics.video_quartile_p25_rate, metrics.video_quartile_p50_rate, metrics.video_quartile_p75_rate, metrics.video_quartile_p100_rate",
        "FROM campaign",
        buildWhere([dateFilter(startDate, endDate), "campaign.advertising_channel_type = 'VIDEO'", 'metrics.impressions > 0'], filterCodes),
      ].join('\n');
      for (const row of await queryRows(customerId, gaql, token)) {
        const key = normalizeDeviceLabel(String(getField(row, 'segments.device') || 'UNKNOWN'));
        const I = toInt(getField(row, 'metrics.impressions'));
        if (I <= 0) continue;
        const V = toInt(getField(row, 'metrics.video_trueview_views'));
        const VR = toNum(getField(row, 'metrics.video_trueview_view_rate'));
        if (!deviceMap[key]) deviceMap[key] = { impr: 0, clicks: 0, views: 0, elig: 0, q25w: 0, q50w: 0, q75w: 0, q100w: 0 };
        const b = deviceMap[key];
        b.impr += I; b.clicks += toInt(getField(row, 'metrics.clicks')); b.views += V;
        b.q25w += toNum(getField(row, 'metrics.video_quartile_p25_rate')) * I;
        b.q50w += toNum(getField(row, 'metrics.video_quartile_p50_rate')) * I;
        b.q75w += toNum(getField(row, 'metrics.video_quartile_p75_rate')) * I;
        b.q100w += toNum(getField(row, 'metrics.video_quartile_p100_rate')) * I;
        if (VR > 0) b.elig += V / VR;
      }
    }

    // Geo
    {
      const gaql = [
        'SELECT campaign.name, segments.geo_target_state, metrics.impressions, metrics.clicks, metrics.video_trueview_views, metrics.video_trueview_view_rate',
        'FROM geographic_view',
        buildWhere([dateFilter(startDate, endDate), 'metrics.impressions > 0', 'geographic_view.location_type = LOCATION_OF_PRESENCE'], filterCodes),
      ].join('\n');
      for (const row of await queryRows(customerId, gaql, token)) {
        const geoRes = String(getField(row, 'segments.geo_target_state') || '').trim();
        if (!geoRes) continue;
        geoResourceNames.add(geoRes);
        const I = toInt(getField(row, 'metrics.impressions'));
        if (I <= 0) continue;
        if (!geoMap[geoRes]) geoMap[geoRes] = { impr: 0, clicks: 0, views: 0, vrw: 0 };
        const b = geoMap[geoRes];
        b.impr += I;
        b.clicks += toInt(getField(row, 'metrics.clicks'));
        b.views += toInt(getField(row, 'metrics.video_trueview_views'));
        const VR = toNum(getField(row, 'metrics.video_trueview_view_rate'));
        if (VR > 0) b.vrw += VR * I;
      }
    }

    // Top Channels
    {
      const gaql = [
        'SELECT campaign.name, detail_placement_view.group_placement_target_url, metrics.impressions, metrics.video_trueview_views, metrics.clicks, metrics.video_quartile_p100_rate',
        'FROM detail_placement_view',
        buildWhere([dateFilter(startDate, endDate), 'metrics.impressions > 0'], filterCodes),
      ].join('\n');
      for (const row of await queryRows(customerId, gaql, token)) {
        const url = String(getField(row, 'detail_placement_view.group_placement_target_url') || '').trim();
        if (!url || !/youtube\.com\/channel\/UC/i.test(url)) continue;
        const key = url.trim().replace(/^https?:\/\//i, '').toLowerCase();
        const I = toInt(getField(row, 'metrics.impressions'));
        if (!chanMap[key]) chanMap[key] = { url, impr: 0, views: 0, clicks: 0, p100w: 0 };
        chanMap[key].impr += I;
        chanMap[key].views += toInt(getField(row, 'metrics.video_trueview_views'));
        chanMap[key].clicks += toInt(getField(row, 'metrics.clicks'));
        chanMap[key].p100w += toNum(getField(row, 'metrics.video_quartile_p100_rate')) * I;
      }
    }
  }

  // Resolve geo names
  const geoNames: Record<string, string> = {};
  const geoList = [...geoResourceNames];
  const CHUNK = 100;
  for (let i = 0; i < geoList.length; i += CHUNK) {
    const chunk = geoList.slice(i, i + CHUNK);
    const quoted = chunk.map(n => `'${n.replace(/'/g, "\\'")}'`).join(', ');
    const gaql = `SELECT geo_target_constant.resource_name, geo_target_constant.name FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${quoted})`;
    try {
      const rows = await queryRows(accountIds[0], gaql, token);
      for (const row of rows) {
        const rn = String(getField(row, 'geo_target_constant.resource_name') || '').trim();
        const name = String(getField(row, 'geo_target_constant.name') || '').trim();
        if (rn) geoNames[rn] = name || rn;
      }
    } catch { /* ignore geo lookup errors */ }
  }

  // Fetch YouTube channel titles
  const topChannels = Object.values(chanMap).sort((a, b) => b.impr - a.impr).slice(0, 20);
  const channelIdRe = /youtube\.com\/channel\/(UC[\w-]+)/i;
  const channelIds = [...new Set(topChannels.map(c => { const m = c.url.match(channelIdRe); return m ? m[1] : ''; }).filter(Boolean))];
  const channelTitles: Record<string, string> = {};
  if (channelIds.length) {
    try {
      for (let i = 0; i < channelIds.length; i += 50) {
        const ids = channelIds.slice(i, i + 50).join(',');
        const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${ids}`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const data = await res.json() as { items?: Array<{ id: string; snippet?: { title?: string } }> };
          for (const item of data.items || []) if (item.id) channelTitles[item.id] = item.snippet?.title || item.id;
        }
      }
    } catch { /* ignore */ }
  }

  // Assemble demo helper
  type DB = { impr: number; clicks: number; views: number; elig: number; q25w: number; q50w: number; q75w: number; q100w: number };
  function demoRows(map: Record<string, DB>, sortFn?: (a: string, b: string) => number) {
    return Object.entries(map)
      .sort(sortFn ? ([a], [b]) => sortFn(a, b) : ([, a], [, b]) => b.impr - a.impr)
      .map(([label, b]) => ({
        label,
        impr: b.impr, clicks: b.clicks, views: b.views,
        vr: b.elig > 0 ? b.views / b.elig : 0,
        ctr: b.impr > 0 ? b.clicks / b.impr : 0,
        p25: b.impr > 0 ? b.q25w / b.impr : 0,
        p50: b.impr > 0 ? b.q50w / b.impr : 0,
        p75: b.impr > 0 ? b.q75w / b.impr : 0,
        p100: b.impr > 0 ? b.q100w / b.impr : 0,
      }));
  }

  const AGE_ORDER = ['18-24', '25-34', '35-44', '45-54', '55-64', '65+', 'UNDETERMINED'];

  // Extract PL ID from campaign name for lookup
  function plFromCampaign(name: string): string {
    const m = name.match(/PL\s*[-_ ]?\s*(\d{6})/i);
    return m ? 'PL' + m[1] : '';
  }

  const oFin = finalizeBucket(overallBucket);
  const overallVR = overallVrImpr > 0 ? overallVrViews / overallVrImpr : oFin.vrMetric;

  return {
    overall: { name: opportunityName || '', ...oFin, vr: overallVR },
    placements: Object.entries(placementMap)
      .filter(([, b]) => b.impr > 0)
      .sort(([, a], [, b]) => b.impr - a.impr)
      .map(([campaign, b]) => {
        const fin = finalizeBucket(b);
        const plId = plFromCampaign(campaign);
        const meta = plId && plLookupMap[plId] ? plLookupMap[plId] : {};
        return { campaign, ...fin, vr: placementVR[campaign] ?? fin.vrMetric, costMethod: meta.costMethod || '', clientRate: meta.clientRate ?? '' };
      }),
    creatives: Object.entries(creativeMap)
      .filter(([, b]) => b.impr > 0)
      .sort(([, a], [, b]) => b.impr - a.impr)
      .map(([ad, b]) => { const fin = finalizeBucket(b); return { ad, ...fin, vr: creativeVR[ad] ?? fin.vrMetric }; }),
    genders: demoRows(genderMap),
    ages: demoRows(ageMap, (a, b) => {
      const ai = AGE_ORDER.indexOf(a), bi = AGE_ORDER.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    }),
    devices: demoRows(deviceMap),
    geos: Object.entries(geoMap)
      .filter(([, b]) => b.impr > 0)
      .sort(([, a], [, b]) => b.impr - a.impr)
      .map(([res, b]) => ({
        region: geoNames[res] || res,
        impr: b.impr, clicks: b.clicks, views: b.views,
        vr: b.impr > 0 ? b.vrw / b.impr : 0,
        ctr: b.impr > 0 ? b.clicks / b.impr : 0,
      })),
    channels: topChannels.map(c => {
      const m = c.url.match(channelIdRe);
      const chId = m ? m[1] : '';
      return {
        name: channelTitles[chId] || chId || c.url,
        url: c.url,
        impr: c.impr, views: c.views, clicks: c.clicks,
        vr: c.impr > 0 ? c.views / c.impr : 0,
        ctr: c.impr > 0 ? c.clicks / c.impr : 0,
        p100: c.impr > 0 ? c.p100w / c.impr : 0,
      };
    }),
  };
}
