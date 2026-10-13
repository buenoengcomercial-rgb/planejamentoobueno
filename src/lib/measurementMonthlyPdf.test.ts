// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation } from './measurementIncorporation';
import { buildMonthlyMeasurementPdf, monthlyPdfColumns, monthlyPdfPresentation } from './measurementMonthlyPdf';
import { measurementPresentation } from '@/components/measurement/measurementWorkspacePresentation';
import { monthlyLines } from './measurementWorkspace';
import { writeFile } from 'node:fs/promises';

async function fixture() {
  const f = measurementFixture();
  return prepareIncorporation(await createIncorporationBackup(f.project, f.plans, [])).candidate;
}
describe('PDF da planilha de Medição', () => {
  it('preserva as quinze colunas, capítulos e totais calculados pela tela', async () => {
    const w = await fixture(), before = structuredClone(w);
    const model = monthlyPdfPresentation(w, 'm1');
    expect(monthlyPdfColumns).toHaveLength(15);
    expect(model.totals).toEqual(measurementPresentation(monthlyLines(w, 'm1')).totals);
    expect(model.body).toHaveLength(5); // Two hierarchy rows followed by the three services.
    expect(model.body[0]).toHaveLength(8);
    expect(model.body[2]).toHaveLength(15);
    expect(JSON.stringify(model.body[2])).toContain('TEST-0');
    expect(JSON.stringify(model.body[2])).not.toContain('INCÊNDIO');
    expect(w).toEqual(before);
  });
  it('gera o boletim, os totais completos e o resumo financeiro sem alterar nenhum dado', async () => {
    const w = await fixture(), before = structuredClone(w);
    const doc = await buildMonthlyMeasurementPdf(w, 'm1', { forecastTotal: 100 });
    const output = doc.output();
    for (const label of ['BOLETIM DE', 'CONTRATANTE', 'CONTRATADA', 'TOTAL GERAL', 'SEM BDI', 'COM BDI', 'REALIZADO NO', 'GANTT', 'BDI total']) expect(output).toContain(label);
    expect(output).toContain('0.059 0.09 0.165 rg'); // Screen's slate-900 total bar.
    expect(doc.getNumberOfPages()).toBeLessThanOrEqual(2);
    expect(w).toEqual(before);
    if (process.env.MEASUREMENT_PDF_TEST_OUTPUT) await writeFile(process.env.MEASUREMENT_PDF_TEST_OUTPUT, Buffer.from(doc.output('arraybuffer')));
  });
  it('repete o cabeçalho em documentos longos e fecha com totais sem duplicar serviços', async () => {
    const w = await fixture();
    w.services = Array.from({ length: 75 }, (_, i) => ({ ...w.services[0], id: `item-${i}`, item: `1.1.${i + 1}`, description: `Serviço ${i + 1} ${'Descrição longa para conferir paginação e quebras de linha. '.repeat(6)}` }));
    const doc = await buildMonthlyMeasurementPdf(w, 'm1');
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    const output = doc.output();
    expect(output.match(/BOLETIM DE/g)).toHaveLength(doc.getNumberOfPages());
    expect(output.match(/TOTAL GERAL/g)).toHaveLength(1);
    expect(monthlyPdfPresentation(w, 'm1').rows).toHaveLength(75);
  });
});
