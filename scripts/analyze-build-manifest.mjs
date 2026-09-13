import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const manifest = JSON.parse(readFileSync('dist/.vite/manifest.json', 'utf8'));
const keys = Object.keys(manifest);
const findKey = source => keys.find(key => key === source || key.includes(source));
const roots = [
  'index.html',
  findKey('src/pages/Index.tsx'),
  findKey('src/components/Dashboard.tsx'),
].filter(Boolean);

const staticClosure = new Set();
const visit = key => {
  if (!key || staticClosure.has(key)) return;
  staticClosure.add(key);
  for (const imported of manifest[key]?.imports ?? []) visit(imported);
};
roots.forEach(visit);

const rows = [];
let minifiedBytes = 0;
let gzipBytes = 0;
for (const key of staticClosure) {
  const file = manifest[key]?.file;
  if (!file?.endsWith('.js')) continue;
  const contents = readFileSync(`dist/${file}`);
  const gzip = gzipSync(contents).length;
  minifiedBytes += contents.length;
  gzipBytes += gzip;
  rows.push({ file, minifiedKb: contents.length / 1000, gzipKb: gzip / 1000 });
}

const format = value => `${value.toFixed(2)} kB`;
console.table(rows
  .sort((left, right) => right.gzipKb - left.gzipKb)
  .map(row => ({ arquivo: row.file, minificado: format(row.minifiedKb), gzip: format(row.gzipKb) })));
console.log(`Caminho inicial do Dashboard: ${format(minifiedBytes / 1000)} minificado; ${format(gzipBytes / 1000)} gzip.`);

const forbiddenInitialEngines = ['jspdf', 'jspdf-autotable', 'xlsx', 'xlsx-js-style', 'pdfjs-dist'];
const leakedEngines = [...staticClosure].filter(key => forbiddenInitialEngines.some(engine => key.includes(engine)));
if (leakedEngines.length) {
  console.error(`Motores de documentos antecipados indevidamente: ${leakedEngines.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('PDF, XLSX e PDF.js permanecem fora do caminho inicial.');
}
