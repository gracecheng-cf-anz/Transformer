'use client';
import { useState, useRef, useCallback } from 'react';

const css = `
  :root { --blue:#1a73e8; --blue-dark:#1558b0; --green:#188038; --red:#d93025; --text:#202124; --muted:#5f6368; --border:#dadce0; --bg:#f8fafd; --card:#ffffff; --shadow:0 8px 24px rgba(60,64,67,0.16); }
  *{box-sizing:border-box}
  body{margin:0;font-family:Arial,Helvetica,sans-serif;background:var(--bg);color:var(--text)}
  .page{min-height:100vh;display:flex;flex-direction:column}
  .header{background:#fff;border-bottom:1px solid var(--border);padding:22px 36px;display:flex;justify-content:space-between;align-items:center}
  .brand-title{font-size:22px;font-weight:700}
  .brand-subtitle{font-size:13px;color:var(--muted);margin-top:4px}
  .badge{font-size:12px;padding:6px 10px;border-radius:999px;background:#e8f0fe;color:#174ea6;font-weight:600}
  .main{width:100%;max-width:820px;margin:36px auto;padding:0 24px 48px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow);overflow:hidden}
  .card-header{padding:24px 28px 16px;border-bottom:1px solid #eef0f3}
  .card-title{font-size:20px;font-weight:700;margin:0}
  .card-desc{font-size:13px;color:var(--muted);margin-top:8px;line-height:1.5}
  .card-body{padding:24px 28px 28px}
  .upload-box{border:2px dashed var(--border);border-radius:16px;padding:26px;text-align:center;background:#fff;cursor:pointer}
  .upload-box.over{border-color:var(--blue);background:#f4f8ff}
  .upload-title{font-size:16px;font-weight:700;margin-bottom:8px}
  .upload-help{font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:16px}
  .file-btn{display:inline-block;background:#f1f3f4;color:var(--text);border:0;border-radius:10px;padding:13px 18px;font-size:14px;font-weight:700;cursor:pointer}
  .file-name{margin-top:12px;color:var(--muted);font-size:13px}
  .parsed-box{display:none;margin-top:16px;border:1px solid var(--border);border-radius:12px;padding:14px;background:#fff;font-size:13px;line-height:1.6}
  .actions{display:flex;gap:12px;margin-top:26px}
  .primary-btn{flex:1;background:var(--blue);color:white;border:0;border-radius:10px;padding:13px 18px;font-size:14px;font-weight:700;cursor:pointer;transition:.15s}
  .primary-btn:hover{background:var(--blue-dark)}
  .secondary-btn{background:#f1f3f4;color:var(--text);border:0;border-radius:10px;padding:13px 18px;font-size:14px;font-weight:700;cursor:pointer}
  button:disabled{opacity:.6;cursor:not-allowed}
  .progress-card{margin-top:22px;border:1px solid var(--border);border-radius:14px;background:#fff;padding:16px}
  .progress-title{font-size:14px;font-weight:700;margin-bottom:10px}
  .progress-bar{width:100%;height:10px;background:#eef0f3;border-radius:999px;overflow:hidden;margin-bottom:14px}
  .progress-fill{height:100%;background:var(--blue);transition:width .25s ease}
  .step-list{display:grid;gap:8px;font-size:13px}
  .step-muted{color:var(--muted)}
  .step-active{color:var(--blue);font-weight:700}
  .step-done{color:var(--green);font-weight:700}
  .result-link{display:block;margin-top:14px;text-decoration:none;color:white;background:var(--green);padding:12px 14px;border-radius:10px;text-align:center;font-size:14px;font-weight:700;cursor:pointer}
  .modal-backdrop{position:fixed;inset:0;background:rgba(32,33,36,.55);display:flex;align-items:center;justify-content:center;padding:24px;z-index:1000}
  .modal{width:100%;max-width:520px;background:#fff;border-radius:18px;box-shadow:0 18px 48px rgba(0,0,0,.22);overflow:hidden}
  .modal-header{padding:22px 24px 10px;font-size:20px;font-weight:700}
  .modal-body{padding:8px 24px 20px;color:var(--muted);font-size:14px;line-height:1.6}
  .modal-actions{display:flex;justify-content:flex-end;gap:10px;padding:16px 24px 24px}
  .danger{color:var(--red)}
  @media(max-width:700px){.header{padding:18px 22px}.main{margin:24px auto;padding:0 16px 36px}.actions{flex-direction:column}}
`;

interface ParsedInfo {
  startDate: string;
  endDate: string;
  plIds: string[];
  accountIds: string[];
  opportunityName: string;
  campaignFilterCodes: string[];
  fileBase64: string;
}

interface StepState {
  state: 'idle' | 'active' | 'done';
}

type ModalConfig = {
  title: string;
  message: string;
  isError: boolean;
  actions: { label: string; primary: boolean; onClick: () => void }[];
} | null;

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedInfo | null>(null);
  const [steps, setSteps] = useState<StepState[]>(Array(6).fill({ state: 'idle' }));
  const [progress, setProgress] = useState(0);
  const [progressTitle, setProgressTitle] = useState('');
  const [running, setRunning] = useState(false);
  const [modal, setModal] = useState<ModalConfig>(null);
  const [resultBase64, setResultBase64] = useState<string | null>(null);
  const [resultFileName, setResultFileName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const setStep = useCallback((n: number, state: 'idle' | 'active' | 'done', pct: number, title: string) => {
    setSteps(prev => prev.map((s, i) => ({ state: i < n ? 'done' : i === n ? state : 'idle' })));
    setProgress(pct);
    setProgressTitle(title);
  }, []);

  const showError = (title: string, msg: string) => setModal({
    title, message: msg, isError: true,
    actions: [{ label: 'OK', primary: true, onClick: () => setModal(null) }]
  });

  const handleFile = (f: File | null) => {
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) { showError('Invalid file', 'Please upload an .xlsx file.'); return; }
    setFile(f);
    setParsed(null);
    setResultBase64(null);
  };

  const readAsBase64 = (f: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const result = String(e.target?.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('File read failed'));
    reader.readAsDataURL(f);
  });

  const run = async () => {
    if (!file) { showError('Missing file', 'Please upload an XLSX file first.'); return; }
    setRunning(true);
    setResultBase64(null);

    try {
      // Step 1: parse
      setStep(0, 'active', 8, 'Uploading and reading XLSX file...');
      const base64 = await readAsBase64(file);
      const formData = new FormData();
      formData.append('file', file);

      const parseRes = await fetch('/api/parse', { method: 'POST', body: formData });
      if (!parseRes.ok) throw new Error(await parseRes.text());
      const info: ParsedInfo = await parseRes.json();
      info.fileBase64 = base64;
      setParsed(info);
      setStep(1, 'done', 18, 'File parsed.');

      // Confirm if multiple accounts
      if (info.accountIds.length > 1) {
        await new Promise<void>((resolve, reject) => {
          setModal({
            title: 'Multiple Account IDs found',
            message: `The PL IDs map to more than one Google Ads Account ID: ${info.accountIds.join(', ')}. The report will pull from all listed accounts.`,
            isError: false,
            actions: [
              { label: 'Cancel', primary: false, onClick: () => { setModal(null); reject(new Error('Cancelled')); } },
              { label: 'Continue', primary: true, onClick: () => { setModal(null); resolve(); } },
            ]
          });
        });
      }

      setStep(1, 'done', 30, `Account ID resolved: ${info.accountIds.join(', ')}`);

      // Step 2: pull ads data
      setStep(2, 'active', 45, 'Pulling Google Ads raw data. This may take a few minutes...');
      const adsRes = await fetch('/api/pull-ads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: info.startDate, endDate: info.endDate, plIds: info.plIds, accountIds: info.accountIds, campaignFilterCodes: info.campaignFilterCodes }),
      });
      if (!adsRes.ok) throw new Error(await adsRes.text());
      const { adsData } = await adsRes.json();
      setStep(2, 'done', 65, 'Google Ads raw data pulled.');

      // Step 3: format
      setStep(3, 'active', 76, 'Filling uploaded blue-format tables...');
      const fmtRes = await fetch('/api/format', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileBase64: base64, adsData, opportunityName: info.opportunityName }),
      });
      if (!fmtRes.ok) throw new Error(await fmtRes.text());
      const { fileBase64: formattedBase64 } = await fmtRes.json();
      setStep(3, 'done', 84, 'Uploaded report tables filled.');

      // Step 4: insights
      setStep(4, 'active', 92, 'Generating insights...');
      const insRes = await fetch('/api/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileBase64: formattedBase64 }),
      });
      if (!insRes.ok) throw new Error(await insRes.text());
      const { fileBase64: finalBase64 } = await insRes.json();
      setStep(4, 'done', 97, 'Insights generated.');
      setStep(5, 'done', 100, 'Report completed.');

      setResultBase64(finalBase64);
      setResultFileName(file.name.replace(/\.xlsx$/i, '') + ' - Google Ads Updated.xlsx');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'Cancelled') showError('Error', msg);
    } finally {
      setRunning(false);
    }
  };

  const download = () => {
    if (!resultBase64) return;
    const bytes = Uint8Array.from(atob(resultBase64), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = resultFileName; a.click();
    URL.revokeObjectURL(url);
  };

  const clear = () => {
    setFile(null); setParsed(null); setRunning(false);
    setSteps(Array(6).fill({ state: 'idle' }));
    setProgress(0); setProgressTitle('');
    setResultBase64(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const stepLabels = [
    '1. Upload and read XLSX file',
    '2. Resolve Google Ads Account ID',
    '3. Pull Google Ads raw data',
    '4. Fill uploaded blue-format tables',
    '5. Generate insights',
    '6. Complete',
  ];

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div className="page">
        <header className="header">
          <div>
            <div className="brand-title">Campaign Report Builder</div>
            <div className="brand-subtitle">Upload an XLSX weekly report, pull Google Ads data, keep the uploaded blue format, and generate insights</div>
          </div>
          <div className="badge">Google Ads API</div>
        </header>

        <main className="main">
          <section className="card">
            <div className="card-header">
              <h1 className="card-title">Build report from uploaded XLSX</h1>
              <div className="card-desc">Upload the client weekly report file. The app will read the Date Range, extract PL IDs, pull Google Ads data, fill the existing blue tables, and generate insights.</div>
            </div>
            <div className="card-body">
              <div
                className={`upload-box${dragging ? ' over' : ''}`}
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files?.[0] ?? null); }}
                onClick={() => fileInputRef.current?.click()}
              >
                <div className="upload-title">Upload weekly report XLSX</div>
                <div className="upload-help">The file must include a Date Range or Reporting Range and PL IDs in the Placement table.</div>
                <label className="file-btn" onClick={e => e.stopPropagation()}>
                  Choose XLSX file
                  <input ref={fileInputRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={e => handleFile(e.target.files?.[0] ?? null)} />
                </label>
                <div className="file-name">{file ? file.name : 'No file selected'}</div>
              </div>

              {parsed && (
                <div className="parsed-box" style={{ display: 'block' }}>
                  <b>Detected Date Range:</b> {parsed.startDate} to {parsed.endDate}<br />
                  <b>Detected PL IDs:</b> {parsed.plIds.join(', ')}<br />
                  <b>Google Ads Account ID:</b> {parsed.accountIds.join(', ')}
                </div>
              )}

              <div className="actions">
                <button className="secondary-btn" onClick={clear}>Clear</button>
                <button className="primary-btn" disabled={running} onClick={run}>Run report</button>
              </div>

              {(running || progress > 0) && (
                <div className="progress-card">
                  <div className="progress-title">{progressTitle}</div>
                  <div className="progress-bar"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
                  <div className="step-list">
                    {stepLabels.map((label, i) => (
                      <div key={i} className={`step-${steps[i]?.state === 'active' ? 'active' : steps[i]?.state === 'done' ? 'done' : 'muted'}`}>{label}</div>
                    ))}
                  </div>
                </div>
              )}

              {resultBase64 && (
                <button className="result-link" onClick={download}>Download updated report</button>
              )}
            </div>
          </section>
        </main>
      </div>

      {modal && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className={`modal-header${modal.isError ? ' danger' : ''}`}>{modal.title}</div>
            <div className="modal-body">{modal.message}</div>
            <div className="modal-actions">
              {modal.actions.map((a, i) => (
                <button key={i} className={a.primary ? 'primary-btn' : 'secondary-btn'} style={{ flex: '0 0 auto' }} onClick={a.onClick}>{a.label}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
