import type { VercelRequest, VercelResponse } from '@vercel/node';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

const isValidShare = (s: string) => {
  try {
    const u = new URL(s);
    return (u.hostname === 'chatgpt.com' || u.hostname.endsWith('.chatgpt.com')) && u.pathname.startsWith('/share/');
  } catch { return false; }
};

const variants = (s: string) => {
  const u = new URL(s);
  const base = u.toString().replace(/\/+$/, '');
  return [base + '/', base];
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // --- CORS ---
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin'); // så caches blir rätt
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).send('Use POST');
  const { url, format = 'A4', margin = 12, forceRaster = false } = req.body || {};
  if (!url || !isValidShare(url)) return res.status(400).send('Ogiltig delningslänk (måste börja med https://chatgpt.com/share/…)');

  try {
    // puppeteer on serverless
    chromium.setHeadlessMode = true;
    chromium.setGraphicsMode = false;

    const executablePath = await chromium.executablePath();
    const browser = await puppeteer.launch({
      args: [...chromium.args, '--disable-blink-features=AutomationControlled'],
      defaultViewport: { width: 1260, height: 900, deviceScaleFactor: 1.25 },
      executablePath,
      headless: chromium.headless
    });

    const page = await browser.newPage();

    // stealth-ish
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['sv-SE','sv','en-US','en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [{name:'Chrome PDF Viewer'}] });
      // @ts-ignore
      window.chrome = window.chrome || { runtime: {} };
    });

    let messages: Array<{role:string,content:string}> | null = null;
    let opened = false;

    for (const u of variants(url)) {
      try {
        await page.setExtraHTTPHeaders({
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': 'https://chatgpt.com/'
        });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 120000 });
        opened = true;

        // dismiss likely popups (best-effort)
        for (const sel of [
          'button:has-text("Accept")','button:has-text("I agree")',
          'button:has-text("Got it")','button:has-text("OK")',
          '[data-testid="toast-dismiss"] button'
        ]) { try { await page.locator(sel).first().click({ timeout: 500 }); } catch {} }

        // wait for conversation-ish selectors
        const ok = await Promise.race([
          page.waitForSelector('[data-testid="conversation-turn"]', { timeout: 40000 }).then(() => true).catch(() => false),
          page.waitForSelector('[data-message-author-role]', { timeout: 40000 }).then(() => true).catch(() => false),
        ]);

        // expand “show more”
        await page.evaluate(() => {
          const contains = (el: Element, labels: string[]) => labels.some(t => el.textContent && el.textContent.toLowerCase().includes(t));
          const labels = ['show more','expand','visa mer','mer'];
          const btns = Array.from(document.querySelectorAll('button, a[role="button"], [data-state]'));
          btns.forEach(b => { try { if (contains(b, labels)) (b as any).click?.(); } catch {} });
          document.querySelectorAll('details').forEach((d: any) => { try { d.open = true; } catch {} });
        });

        // quick scroll
        for (let i=0;i<100;i++){
          const enough = await page.evaluate(() => {
            const qs = (s:string)=>document.querySelectorAll(s).length;
            const count = Math.max(qs('[data-testid="conversation-turn"]'), qs('[data-message-author-role]'), qs('main article'), qs('main .prose'));
            const textLen = (document.body.innerText || '').trim().length;
            return count >= 2 || textLen > 800;
          });
          if (enough) break;
          await page.evaluate(() => window.scrollBy(0, 900));
          await page.waitForTimeout(80);
        }

        // scrape DOM
        messages = await page.evaluate(() => {
          const out: Array<{role:string, content:string}> = [];
          const textOf = (el: Element | null) => (el?.innerHTML?.includes('<code') || el?.innerHTML?.includes('<pre'))
            ? (el as HTMLElement).innerText.trim()
            : (el?.textContent || '').trim();

          const turns = Array.from(document.querySelectorAll('[data-testid="conversation-turn"], [data-message-author-role]'));
          for (const node of turns) {
            const n = node as HTMLElement;
            let role = n.getAttribute('data-message-author-role')
                   || n.getAttribute('data-author')
                   || n.getAttribute('data-role')
                   || (n.querySelector('[data-message-author-role]') as HTMLElement)?.getAttribute('data-message-author-role')
                   || 'assistant';
            let content = '';
            for (const sel of ['[data-message-author-role] ~ *','[class*="prose"]','article','div']) {
              const c = n.querySelector(sel);
              if (c) { content = textOf(c); if (content) break; }
            }
            if (!content) content = textOf(n);
            if (content) out.push({ role, content });
          }
          if (out.length === 0) {
            const main = document.querySelector('main') || document.body;
            const txt = (main?.textContent || '').trim();
            if (txt.length > 200) out.push({ role: 'assistant', content: txt });
          }
          return out;
        });

        if (messages && messages.length) break;
      } catch { /* try next variant */ }
    }

    // If text failed OR user wants guaranteed result → raster fallback (always works)
    if (!messages?.length) {
      if (!opened) { try { await page.goto(variants(url)[0], { waitUntil: 'load', timeout: 120000 }); } catch {} }
      const png = await page.screenshot({ fullPage: true });
      const b64 = png.toString('base64');
      const html = `<!doctype html><html><head><meta charset="utf-8"/><style>
        body{margin:0} img{display:block;width:100%;height:auto} @page{margin:${margin}mm}
      </style></head><body><img src="data:image/png;base64,${b64}"/></body></html>`;
      await page.setContent(html, { waitUntil: 'load' });
      await page.emulateMediaType('screen');
      const pdf = await page.pdf({
        format: (format === 'Letter' ? 'Letter' : 'A4'),
        printBackground: true, preferCSSPageSize: false, displayHeaderFooter: false
      });
      await browser.close();
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition','attachment; filename="chatgpt-conversation.pdf"');
      return res.end(pdf);
    }

    // Build static HTML with scraped text → PDF
    const esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');
    const rows = messages.map(m => `
      <section class="turn ${esc(m.role)}">
        <div class="bubble">
          <div class="role">${esc(m.role)}</div>
          <div class="content">${esc(m.content)}</div>
        </div>
      </section>`).join('\n');

    const html = `<!doctype html><html lang="sv"><head><meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1"/>
      <title>ChatGPT Share Export</title>
      <style>
        body{font-family: ui-sans-serif, system-ui, Segoe UI, Roboto, Arial; margin:0; padding:24px;}
        .turn{margin:0 0 16px;}
        .bubble{border:1px solid #e5e7eb;border-radius:16px;padding:16px;}
        .turn.user .bubble{background:#f9fafb}
        .turn.assistant .bubble{background:#fff}
        .role{font-size:12px;color:#6b7280;text-transform:uppercase;margin-bottom:6px;}
        .content{white-space:pre-wrap;word-wrap:break-word;}
        pre,code{white-space:pre-wrap;}
        @page{margin:${margin}mm;}
      </style>
    </head><body>
      <h1 style="margin:0 0 12px;">ChatGPT Share Export</h1>
      ${rows}
    </body></html>`;

    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMediaType('screen');
    const pdf = await page.pdf({
      format: (format === 'Letter' ? 'Letter' : 'A4'),
      printBackground: true, preferCSSPageSize: false, displayHeaderFooter: false
    });

    if (browser) await browser.close(); else await context.close();
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition','attachment; filename="chatgpt-conversation.pdf"');
    return res.end(pdf);

  } catch (e: any) {
    console.error(e);
    return res.status(500).send('Kunde inte rendera PDF (serverless körning misslyckades).');
  }
}
