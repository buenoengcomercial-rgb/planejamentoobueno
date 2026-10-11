import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function parseCsv(csv) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (char === ';' && !quoted) { row.push(value); value = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && csv[index + 1] === '\n') index++;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += char;
  }
  if (quoted) throw new Error('Incomplete CSV export');
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

const [csvPath, outputDirectory, expectedProjectId] = process.argv.slice(2);
if (!csvPath || !outputDirectory || !expectedProjectId) {
  throw new Error('Usage: node verify-current-measurement-backup.mjs <csv> <output-dir> <project-id>');
}
const csv = await fs.readFile(csvPath, 'utf8');
const [header, ...data] = parseCsv(csv);
assert.deepEqual(header, ['checksum', 'payload']);
assert.equal(data.length, 1, 'The export must contain exactly one workspace');
const [checksum, payload] = data[0];
assert.equal(typeof payload, 'string');
assert.equal(typeof checksum, 'string');
const workspace = JSON.parse(payload);
assert.equal(workspace.projectId, expectedProjectId);
assert.equal(crypto.createHash('md5').update(payload).digest('hex'), checksum);
assert.ok(Number.isSafeInteger(workspace.revision) && workspace.revision >= 0);
for (const field of ['services', 'entries', 'periods', 'plans', 'audit']) {
  assert.ok(Array.isArray(workspace[field]), `${field} must be an array`);
}
const prefix = `medicao-${expectedProjectId}-rev${workspace.revision}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await fs.mkdir(outputDirectory, { recursive: true });
const snapshotPath = path.join(outputDirectory, `${prefix}.json`);
const manifestPath = path.join(outputDirectory, `${prefix}.manifest.json`);
const manifest = {
  projectId: workspace.projectId,
  revision: workspace.revision,
  services: workspace.services.length,
  entries: workspace.entries.length,
  periods: workspace.periods.length,
  plans: workspace.plans.length,
  audit: workspace.audit.length,
  bytes: Buffer.byteLength(payload),
  sourceChecksumMd5: checksum,
  snapshotSha256: crypto.createHash('sha256').update(payload).digest('hex'),
};
await fs.writeFile(snapshotPath, payload, { flag: 'wx' });
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
assert.equal(crypto.createHash('sha256').update(await fs.readFile(snapshotPath)).digest('hex'), manifest.snapshotSha256);
console.log(JSON.stringify({ snapshotPath, manifestPath, ...manifest }));
