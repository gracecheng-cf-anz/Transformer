import { NextRequest, NextResponse } from 'next/server';
import { getAccessToken } from '@/lib/googleAuth';
import { buildPlLookupMap } from '@/lib/googleSheets';
import { pullAllAdsData } from '@/lib/googleAds';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { startDate, endDate, plIds, accountIds, campaignFilterCodes, opportunityName } = await req.json() as {
      startDate: string; endDate: string; plIds: string[];
      accountIds: string[]; campaignFilterCodes: string[]; opportunityName: string;
    };

    if (!startDate || !endDate) return NextResponse.json({ error: 'Missing date range' }, { status: 400 });
    if (!accountIds?.length) return NextResponse.json({ error: 'Missing account IDs' }, { status: 400 });
    if (!plIds?.length) return NextResponse.json({ error: 'Missing PL IDs' }, { status: 400 });

    const token = await getAccessToken();
    const plLookupMap = await buildPlLookupMap(plIds, token);

    const adsData = await pullAllAdsData(
      accountIds, startDate, endDate,
      campaignFilterCodes?.length ? campaignFilterCodes : plIds,
      plLookupMap, opportunityName || '', token
    );

    const hasDelivery = adsData.overall.impr > 0 || adsData.placements.length > 0;
    if (!hasDelivery) {
      return NextResponse.json({ error: 'No Google Ads delivery found for the given PL IDs and date range.' }, { status: 400 });
    }

    return NextResponse.json({ adsData });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
