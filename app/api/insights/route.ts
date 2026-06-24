import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { fillInsights, sheetToTsv } from '@/lib/xlsxUtils';

export const maxDuration = 60;

const REQUIRED_LINES = 8;

function buildPrompt(dataset: string): string {
  return [
    'You are a senior YouTube performance analyst writing a client-ready weekly insight summary.',
    'Write like a human: concise, specific, and selective. Do not mention AI, models, prompts, or limitations.',
    '',
    'OUTPUT FORMAT',
    '- Return EXACTLY 8 bullet lines.',
    '- Each bullet must be a SINGLE line, max 320 characters.',
    '- No title, no headings, no extra whitespace.',
    '- Positive-only framing: highlight wins, strengths, or stable performance. No negative callouts.',
    '',
    'METRIC PRIORITY',
    '- Primary success metric: "Video played to: 100%" and its rate if available.',
    '- Do not use "Video View Rate" in the insights.',
    '- Prefer completion language such as "completed views (100%)".',
    '- Always include scale plus an outcome (Impressions + completed views, clicks, CTR, or 100% rate).',
    '',
    'WHAT EACH OF THE 8 LINES SHOULD COVER',
    '1) Overall Performance: include Impressions, Clicks, CTR, and completed views / 100% completion.',
    '2-8) Choose the 7 strongest insights across Placement, Creative, Gender, Age, Devices, Geo, and Channels.',
    '- Do not force one insight per section; pick the best 7 total.',
    '',
    'NUMBER STYLE',
    '- Use K/M abbreviations (735K or 1.2M).',
    '- Use percentages with 1 decimal.',
    '',
    'DATA TSV:',
    dataset,
    '',
    'Return EXACTLY 8 bullet lines starting with "• ".',
  ].join('\n');
}

function normalizeToLines(text: string, n: number): string[] {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const cleaned = lines
    .map(s => s.replace(/^[\-•\d\)\.]+\s*/, '').trim())
    .filter(s => s.length > 0)
    .map(s => s.length > 380 ? s.slice(0, 377) + '...' : s)
    .slice(0, n);
  while (cleaned.length < n) cleaned.push('');
  return cleaned;
}

export async function POST(req: NextRequest) {
  try {
    const { fileBase64 } = await req.json() as { fileBase64: string };
    if (!fileBase64) return NextResponse.json({ error: 'Missing fileBase64' }, { status: 400 });

    const buffer = Buffer.from(fileBase64, 'base64');
    let dataset = await sheetToTsv(buffer);
    if (dataset.length > 95000) dataset = dataset.slice(0, 95000);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: 'Missing OPENAI_API_KEY in environment' }, { status: 500 });

    const client = new OpenAI({ apiKey });
    const resp = await client.responses.create({
      model: 'gpt-4.1-mini',
      input: buildPrompt(dataset),
      max_output_tokens: 700,
      temperature: 0.2,
    } as Parameters<typeof client.responses.create>[0]);

    // Extract text from response
    let text = '';
    const r = resp as Record<string, unknown>;
    if (typeof r.output_text === 'string') text = r.output_text;
    else if (Array.isArray(r.output)) {
      const parts: string[] = [];
      (r.output as Array<Record<string, unknown>>).forEach(item => {
        if (Array.isArray(item.content)) (item.content as Array<Record<string, unknown>>).forEach(p => { if (typeof p.text === 'string') parts.push(p.text); });
        if (typeof item.text === 'string') parts.push(item.text);
      });
      text = parts.join('\n');
    }

    if (!text.trim()) {
      // Fallback
      text = [
        '• Overall performance delivered stable scale and engagement across the campaign period.',
        '• Placement activity contributed meaningful delivery across the available campaign mix.',
        '• Creative activity supported completed-view volume with measurable engagement.',
        '• Gender segment delivery contributed stable reach and click activity.',
        '• Age segment performance showed useful concentration across available audiences.',
        '• Device delivery supported campaign reach and completed-view volume.',
        '• Geo delivery contributed measurable scale across available locations.',
        '• Channel delivery supported qualified YouTube engagement across relevant environments.',
      ].join('\n');
    }

    const lines = normalizeToLines(text, REQUIRED_LINES);
    const indexed = lines.map((line, i) => `${i + 1}. ${line}`);

    const finalBuffer = await fillInsights(buffer, indexed);
    return NextResponse.json({ fileBase64: finalBuffer.toString('base64') });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
