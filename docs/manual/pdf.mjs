import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

// Convierte el manual (HTML con capturas) en PDF A4 con número de página.
const [, , html, out] = process.argv;
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const page = await browser.newPage();
await page.goto(pathToFileURL(html).href, { waitUntil: 'networkidle' });
await page.pdf({
  path: out,
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;font-size:8pt;color:#8a8496;padding:0 15mm;display:flex;justify-content:space-between;font-family:Segoe UI,sans-serif"><span>Manual de Martina</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
});
await browser.close();
console.log('PDF listo:', out);
