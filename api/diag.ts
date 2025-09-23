import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

export default async function handler(_req: any, res: any) {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') return res.status(204).end();

  try {
    chromium.setHeadlessMode = true;
    chromium.setGraphicsMode = false;
    const executablePath = await chromium.executablePath('stable');

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1024, height: 768 },
      executablePath,
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const title = await page.title();
    await browser.close();

    return res.status(200).json({ ok: true, executablePath, title });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e), stack: e?.stack });
  }
}
