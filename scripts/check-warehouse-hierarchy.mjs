// Run after the production build: node scripts/check-warehouse-hierarchy.mjs
// Uses the shipped CSS in Chrome so CSS specificity, hover and row insertion are checked.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const files = await readdir(new URL('../dist/assets/', import.meta.url));
const css = await Promise.all(['index-', 'Warehouse-'].map(async prefix => {
  const file = files.find(name => name.startsWith(prefix) && name.endsWith('.css'));
  assert.ok(file, `Build CSS missing: ${prefix}`);
  return readFile(new URL(`../dist/assets/${file}`, import.meta.url), 'utf8');
}));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.setContent(`<html><head><style>${css.join('\n')}</style></head>
    <body><main class="warehouse-ui p-4">
      <h1 class="font-semibold p-3">Histórico — conferência visual da hierarquia</h1>
      <table class="w-full text-sm"><tbody>
        <tr id="chapter-a" class="bg-primary/15 border-y border-primary/30"><td class="p-3 font-semibold">5 · INCÊNDIO — CURVO 03</td></tr>
        <tr id="date" class="bg-primary/20 border-y border-primary/50"><td class="p-3">⌄ 04/09/2026 · Data aberta</td></tr>
        <tr id="open-a" class="bg-primary/30 hover:bg-primary/35 border-t border-primary/70"><td class="pl-10">⌄ REQUISIÇÃO A · Aberta</td></tr>
        <tr id="open-b" class="bg-primary/30 hover:bg-primary/35 border-t border-primary/70"><td class="pl-10">⌄ REQUISIÇÃO B · Aberta</td></tr>
        <tr id="detail" class="bg-primary/15"><td class="pl-12 pr-4"><div class="bg-primary/20 border border-primary/45 border-l-4 border-l-primary rounded-lg p-3">Materiais da requisição<table class="w-full mt-2"><thead><tr><th class="text-left">Material</th><th>Quantidade</th></tr></thead><tbody><tr><td>Luminária de emergência</td><td>20 UN</td></tr><tr><td>Condulete</td><td>30 UN</td></tr></tbody></table></div></td></tr>
        <tr id="chapter-b" class="bg-primary/15 border-y border-primary/30"><td class="p-3 font-semibold">6 · INCÊNDIO — RETO 04</td></tr>
        <tr id="date-closed" class="bg-muted/80 border-y border-border"><td class="p-3">› 03/09/2026 · Data fechada</td></tr>
      </tbody></table>
      <table class="w-full mt-4"><tbody><tr id="plain-a"><td>Lista simples · primeira linha</td></tr><tr id="plain-b"><td>Lista simples · segunda linha</td></tr></tbody></table>
    </main></body></html>`);
  const bg = id => page.locator(`#${id}`).evaluate(el => getComputedStyle(el).backgroundColor);
  const reportOnly = process.argv.includes('--report-only');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    await page.mouse.move(0, 0);
    const chapter = await bg('chapter-a');
    const open = await bg('open-a');
    const observed = { theme, chapterA: chapter, chapterB: await bg('chapter-b'), openA: open, openB: await bg('open-b') };
    console.log(JSON.stringify(observed));
    if (!reportOnly) {
      assert.equal(observed.chapterB, chapter, 'Chapters must not depend on odd/even position');
      assert.equal(observed.openB, open, 'All open requisitions must have the same tone');
      assert.notEqual(await bg('date'), await bg('date-closed'), 'Open dates must be distinguishable');
      assert.notEqual(open, chapter, 'Open requisitions must differ from chapter headers');
      assert.notEqual(await bg('plain-a'), await bg('plain-b'), 'Plain tables keep their zebra styling');
      await page.locator('#chapter-b').hover();
      assert.equal(await bg('chapter-b'), chapter, 'Hover must not erase a chapter background');
      await page.locator('#open-b').hover();
      assert.notEqual(await bg('open-b'), open, 'Explicit requisition hover must still work');
      await page.mouse.move(0, 0);
      await page.locator('#open-a').evaluate(el => el.before(document.createElement('tr')));
      assert.equal(await bg('chapter-b'), chapter, 'Expanding a row must not recolor later chapters');
      assert.equal(await bg('open-b'), open, 'Expanding a row must not recolor other requisitions');
    }
    const output = join(tmpdir(), 'obraplanner-hierarchy-audit');
    await mkdir(output, { recursive: true });
    const screenshot = join(output, `${reportOnly ? 'before' : 'after'}-${theme}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(screenshot);
  }
} finally {
  await browser.close();
}
