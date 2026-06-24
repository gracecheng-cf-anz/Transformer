import { NextRequest, NextResponse } from 'next/server';
import { fillWeeklyReport } from '@/lib/xlsxUtils';
import type { AdsData } from '@/lib/googleAds';

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { fileBase64, adsData, opportunityName } = await req.json() as {
      fileBase64: string; adsData: AdsData; opportunityName: string;
    };
    if (!fileBase64) return NextResponse.json({ error: 'Missing fileBase64' }, { status: 400 });
    if (!adsData) return NextResponse.json({ error: 'Missing adsData' }, { status: 400 });

    const buffer = Buffer.from(fileBase64, 'base64');
    const result = await fillWeeklyReport(buffer, adsData, opportunityName || '');

    return NextResponse.json({ fileBase64: result.toString('base64') });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
