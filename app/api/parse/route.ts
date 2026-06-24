import { NextRequest, NextResponse } from 'next/server';
import { getAccessToken } from '@/lib/googleAuth';
import { resolveAccountIds, buildCampaignFilterCodes, buildOpportunityName } from '@/lib/googleSheets';
import { loadWorkbook, extractDateRange, extractPlIds } from '@/lib/xlsxUtils';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const wb = await loadWorkbook(buffer);
    const dateRange = extractDateRange(wb);
    if (!dateRange) return NextResponse.json({ error: 'Could not find "Date Range" or "Reporting Range" in the uploaded file.' }, { status: 400 });

    const plIds = extractPlIds(wb);
    if (!plIds.length) return NextResponse.json({ error: 'No PL IDs found (expected format: PL + 6 digits, e.g. PL263085).' }, { status: 400 });

    const token = await getAccessToken();
    const accountIds = await resolveAccountIds(plIds, token);
    if (!accountIds.length) return NextResponse.json({ error: `No Google Ads Account IDs found for PL IDs: ${plIds.join(', ')}. Check the All Data (Daily) sheet.` }, { status: 400 });

    const campaignFilterCodes = await buildCampaignFilterCodes(plIds, token);
    const opportunityName = await buildOpportunityName(plIds, token);

    return NextResponse.json({
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      plIds,
      accountIds,
      opportunityName,
      campaignFilterCodes,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
