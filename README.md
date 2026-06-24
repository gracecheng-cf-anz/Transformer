# Campaign Report Builder — Vercel App

Same functionality as the Apps Script version, no OAuth headaches.

## Setup

### 1. GCP Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create or select a project
3. Enable these APIs:
   - **Google Ads API**
   - **Google Sheets API**
   - **YouTube Data API v3**
4. Go to **Credentials** → **Create Credentials** → **OAuth client ID**
   - Application type: **Desktop app**
   - Note down the **Client ID** and **Client Secret**

### 2. Get your Refresh Token

```bash
cd campaign-report-builder
GOOGLE_CLIENT_ID=your_id GOOGLE_CLIENT_SECRET=your_secret node scripts/get-refresh-token.mjs
```

This opens a browser, asks you to sign in with the Google account that has access to Google Ads and the Sheets, then prints your refresh token.

### 3. Create .env.local

```bash
cp .env.local.example .env.local
```

Fill in all values:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...          # from step 2
GOOGLE_ADS_DEVELOPER_TOKEN=...   # from Google Ads Manager → Tools → API Center
GOOGLE_ADS_LOGIN_CUSTOMER_ID=2092131207
SPREADSHEET_ID=1tnfrSHOkLuyMpv0b1ulgJTIM7POTX6wWDP6ip7yUvXE
PL_MAP_SHEET_NAME=OP PL Map
ALL_DATA_SHEET_NAME=All Data (Daily)
OPENAI_API_KEY=...
```

### 4. Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### 5. Deploy to Vercel

```bash
npx vercel
```

Add all env vars in **Vercel Dashboard → Project → Settings → Environment Variables**.

> **Note:** The Google Ads data pull can take 30-60 seconds. Vercel **Pro plan** ($20/mo) is required for the 60s function timeout. On the free Hobby plan, it will timeout at 10s.

## How it works

1. Upload your client XLSX weekly report
2. App detects **Date Range** and **PL IDs** from the file automatically
3. Looks up Google Ads Account IDs from your All Data (Daily) sheet
4. Pulls all Google Ads data (Overall, Placement, Creative, Gender, Age, Devices, Geo, Top Channels)
5. Fills the existing blue-format tables in the uploaded file
6. Generates 8 AI insights via OpenAI
7. Download the updated file
