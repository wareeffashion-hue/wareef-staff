// PDF of the printable reports, rendered by a headless Chromium so Arabic shaping, the Gamila font
// and RTL tables come out exactly like the page you print from the browser.
// Docker installs Chromium (Alpine: /usr/bin/chromium-browser); CHROMIUM_PATH overrides.
import { existsSync } from 'node:fs';
import { config } from './config.js';

const CANDIDATES = [process.env.CHROMIUM_PATH, '/usr/bin/chromium-browser', '/usr/bin/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
export const chromiumPath = () => CANDIDATES.find((p) => p && existsSync(p)) || null;

let busy = Promise.resolve();

/** HTML (with root-relative /print.css, /fonts, /img) → PDF buffer. One render at a time; the browser is closed after each. */
export function htmlToPdf(html, { landscape = false } = {}) {
  const run = async () => {
    const executablePath = chromiumPath();
    if (!executablePath) throw new Error('Chromium غير مثبّت على السيرفر');
    const { default: puppeteer } = await import('puppeteer-core');
    const browser = await puppeteer.launch({
      executablePath, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
    });
    try {
      const page = await browser.newPage();
      // Served from this same server's origin (fonts refuse to load cross-origin): the page request
      // itself is answered here, its CSS, fonts and images come from the running app.
      const url = `http://127.0.0.1:${config.port}/__pdf-render`;
      await page.setRequestInterception(true);
      // only the page itself and the app's own fonts and styles; nothing else may load
      const own = `http://127.0.0.1:${config.port}/`;
      page.on('request', (r) => (r.url() === url ? r.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
        : r.url().startsWith(own) ? r.continue() : r.abort()));
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
      return Buffer.from(await page.pdf({ format: 'A4', landscape, printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } }));
    } finally {
      await browser.close().catch(() => {});
    }
  };
  const p = busy.then(run, run);
  busy = p.catch(() => {});
  return p;
}
