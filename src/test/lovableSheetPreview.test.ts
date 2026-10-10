// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { lovableSheetPreview } from '../../dev/measurement/lovableSnapshot';
import { prepareIncorporation } from '@/lib/measurementIncorporation';
import { editMeasuredRow, monthlyLines } from '@/lib/measurementWorkspace';

function sheet() {
  return [
    ['Contratante:', 'Órgão de demonstração', null, 'Contratada:', 'Empresa de demonstração'],
    ['Obra:', 'Obra da planilha', null, 'Local/Município:', 'Local de teste'],
    ['Objeto:', 'Instalações', null, 'Nº Contrato:', 'DEMO'],
    ['Nº ART:', '', null, 'Medição Nº:', '1'],
    ['Período:', '24/08/2026 a 22/09/2026', null, 'Data emissão:', '09/10/2026'],
    ['Fonte de orçamento:', 'Base de teste', null, 'BDI %:', 25], ['Status:', 'Em preparação'],
    ['Item', 'Código', 'Banco', 'Descrição', 'Und.', 'Quant. Contratada', 'V. Unit. s/ BDI', 'V. Unit. c/ BDI', 'Total Contratado', 'Quant. Medição', 'Subtotal Medição', 'Quant. Acumulada', 'Subtotal Acumulado', 'Quant. a Executar', 'Subtotal a Executar'],
    ['2', null, null, 'Prédio'], ['2.3', null, null, '  Instalações'],
    ['2.3.1', 'DEM1', 'PRÓPRIO', 'Detectores', 'UN', 40, 10, 12.5, 500, 29, 362.5, 29, 362.5, 11, 137.5],
    [null, null, null, 'Subtotal 2 Prédio', null, null, null, null, 500, null, 362.5, null, 362.5, null, 137.5],
    [null, null, null, 'TOTAL GERAL', null, null, null, null, 500, null, 362.5, null, 362.5, null, 137.5],
  ];
}

describe('Cópia local de uma exportação da Medição', () => {
  it('preserva hierarquia, contrato e período, permitindo editar só a cópia em A', async () => {
    const rows = sheet(), original = structuredClone(rows);
    const result = await lovableSheetPreview(rows, 'file-hash');
    const w = prepareIncorporation(result.backup).candidate;
    expect(result.itemCount).toBe(1);
    expect(result.project.id).toBe('measurement-preview-export-file-hash');
    expect(w.services[0]).toMatchObject({ item: '2.3.1', path: 'Prédio › Instalações', contracted: 40, priceWithBDI: 12.5 });
    expect(w.entries[0].rows[0]).toMatchObject({ comment: 'Dado preservado · 1ª medição', multiplier: 29, origin: { kind: 'snapshot' } });
    expect(result.project.phases.flatMap(p => p.tasks).every(t => !t.dailyLogs?.length)).toBe(true);
    expect(w.plans).toEqual([]);
    const changed = editMeasuredRow(w, { id: 'test', name: 'Teste', canEdit: true }, 'export-period-1', w.services[0].id, { ...w.entries[0].rows[0], multiplier: 30 });
    expect(monthlyLines(changed, 'export-period-1')[0]).toMatchObject({ qty: 30, accumulated: 30, balance: 10 });
    expect(changed.services).toEqual(w.services);
    expect(rows).toEqual(original);
    expect(w.entries[0].rows[0].multiplier).toBe(29);
  });
  it('bloqueia itens truncados, preços divergentes, duplicatas e acumulado sem origem', async () => {
    const missing = sheet(); missing.splice(10, 1);
    await expect(lovableSheetPreview(missing, 'x')).rejects.toThrow('nenhum serviço');
    const changed = sheet(); changed[10][10] = 360;
    await expect(lovableSheetPreview(changed, 'x')).rejects.toThrow('difere do exportado');
    const duplicate = sheet(); duplicate.splice(11, 0, duplicate[10]);
    await expect(lovableSheetPreview(duplicate, 'x')).rejects.toThrow('repetido');
    const accumulated = sheet(); accumulated[10][11] = 30;
    await expect(lovableSheetPreview(accumulated, 'x')).rejects.toThrow('sem período de origem');
    const later = sheet(); later[3][4] = '2';
    await expect(lovableSheetPreview(later, 'x')).rejects.toThrow('períodos anteriores');
  });
});
