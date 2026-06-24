/**
 * Run once to get your Google OAuth2 refresh token.
 * Usage:
 *   node scripts/get-refresh-token.mjs
 *
 * Prerequisites:
 * 1. Create OAuth2 credentials at https://console.cloud.google.com/apis/credentials
 *    - Application type: Desktop app
 *    - Download the JSON and get client_id + client_secret
 * 2. Enable these APIs in your GCP project:
 *    - Google Ads API
 *    - Google Sheets API
 *    - YouTube Data API v3
 */

import http from 'http';
import { exec } from 'child_process';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'PASTE_YOUR_CLIENT_ID';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'PASTE_YOUR_CLIENT_SECRET';
const REDIRECT_URI = 'http://localhost:4321/oauth2callback';

const SCOPES = [
  'https://www.googleapis.com/auth/adwords',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/youtube.readonly',
].join(' ');

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent`;

console.log('\nOpening browser for authorization...\n');
console.log('If browser does not open, visit:\n' + authUrl + '\n');

// Try to open browser
const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
exec(`${open} "${authUrl}"`);

// Start local server to receive callback
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:4321');
  const code = url.searchParams.get('code');
  if (!code) { res.end('No code received'); return; }

  res.end('<h2>Authorization received! Check your terminal for the refresh token.</h2>');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const data = await tokenRes.json();

  if (data.refresh_token) {
    console.log('\n✅ SUCCESS! Add these to your .env.local:\n');
    console.log(`GOOGLE_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GOOGLE_REFRESH_TOKEN=${data.refresh_token}`);
    console.log('');
  } else {
    console.error('\n❌ No refresh token received. Response:', JSON.stringify(data, null, 2));
  }

  server.close();
});

server.listen(4321, () => console.log('Waiting for OAuth callback on http://localhost:4321 ...'));
