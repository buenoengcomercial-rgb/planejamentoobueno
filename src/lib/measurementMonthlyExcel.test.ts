// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation } from './measurementIncorporation';
import { buildMonthlyMeasurementExcel } from './measurementMonthlyExcel';
import { monthlyLines } from './measurementWorkspace';
import { measurementPresentation } from '@/components/measurement/measurementWorkspacePresentation';

async function fixture() {
  const f = measurementFixture();
  return prepareIncorporation(await createIncorporationBackup(f.project, f.plans, [])).candidate;
}
describe('Excel da Medição com o layout da aba', () => {
  it('mantém as quinze colunas, códigos, bancos, hierarquia e estilos de alinhamento', async () => {
    const w = await fixture(), before = structuredClone(w);
    const book = await buildMonthlyMeasurementExcel(w, 'm1');
    const sheet = book.Sheets[book.SheetNames[0]];
    expect(sheet['!cols']).toHaveLength(15);
    const cells = Object.entries(sheet).filter(([key]) => !key.startsWith('!'));
    const header = cells.find(([, cell]) => cell.v === 'V. Unit. s/ BDI')![0].match(/\d+$/)![0];
    expect(sheet[`B${header}`].v).toBe('Código');
    expect(sheet[`C${header}`].v).toBe('Banco');
    const itemRow = cells.find(([, cell]) => cell.v === '1.1.1')![0].match(/\d+$/)![0];
    expect(sheet[`B${itemRow}`].v).toBe('TEST-0');
    expect(sheet[`D${itemRow}`].s.alignment.horizontal).toBe('left');
    expect(sheet[`J${itemRow}`].s.alignment.horizontal).toBe('center');
    expect(sheet[`J${itemRow}`].s.fill.fgColor.rgb).toBe('F0FCF5');
    expect(sheet[`M${itemRow}`].s.fill.fgColor.rgb).toBe('FFFCEF');
    expect(sheet[`O${itemRow}`].s.fill.fgColor.rgb).toBe('FFF5F7');
    expect(w).toEqual(before);
  });
  it('conserva números, totais da tela e os quadros finais ao serializar o XLSX', async () => {
    const w = await fixture(), before = structuredClone(w);
    const book = await buildMonthlyMeasurementExcel(w, 'm1', { forecastTotal: 100 });
    const sheet = book.Sheets[book.SheetNames[0]];
    const total = Object.entries(sheet).find(([, cell]) => cell.v === 'TOTAL GERAL')![0].match(/\d+$/)![0];
    const t = measurementPresentation(monthlyLines(w, 'm1')).totals;
    expect(sheet[`I${total}`]).toMatchObject({ t: 'n', v: t.contracted, z: '"R$" #,##0.00' });
    expect(sheet[`K${total}`].v).toBe(t.period);
    expect(sheet[`O${total}`].v).toBe(t.balance);
    expect(sheet[`A${total}`].s.fill.fgColor.rgb).toBe('0F172A');
    for (const label of ['SEM BDI', 'COM BDI', 'PREVISTO NO PERÍODO (GANTT)', 'DIFERENÇA REAL X PREVISTO']) expect(Object.values(sheet).some(cell => cell.v === label)).toBe(true);
    const mod = await import('xlsx-js-style'), XLSX = mod.default ?? mod;
    const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    const reloaded = XLSX.read(bytes, { type: 'buffer', cellStyles: true });
    const saved = reloaded.Sheets[reloaded.SheetNames[0]];
    expect(saved[`K${total}`]).toMatchObject({ t: 'n', v: t.period });
    expect(saved[`A${total}`].s.fgColor.rgb).toBe('0F172A');
    expect(saved['!merges']).toEqual(sheet['!merges']);
    expect(w).toEqual(before);
  });
});
