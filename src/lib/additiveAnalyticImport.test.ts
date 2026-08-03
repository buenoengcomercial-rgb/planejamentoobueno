import { describe, expect, it } from 'vitest';
import type { Additive, AdditiveComposition } from '@/types/project';
import {
  applyAdditiveAnalyticImport,
  buildAdditiveAnalyticImportPreview,
  computeAdditiveRow,
  normalizeAdditiveAnalyticCode,
  parseAdditiveSyntheticWorkbook,
  parseAnalyticRowsFlexible,
} from './additiveImport';

const composition = (overrides: Partial<AdditiveComposition>): AdditiveComposition => ({
  id: 'c', item: '2.9.1', itemNumber: '2.9.1', code: 'ABHI_3', bank: 'Próprio',
  description: 'Abrigo', quantity: 0, originalQuantity: 0, addedQuantity: 1,
  suppressedQuantity: 0, unit: 'UN', unitPriceNoBDI: 0, unitPriceWithBDI: 0,
  total: 0, inputs: [], phaseId: 'phase-29', isNewService: true,
  ...overrides,
});

const additive = (compositions: AdditiveComposition[]): Additive => ({
  id: 'a', name: 'Aditivo', importedAt: '', status: 'rascunho',
  bdiPercent: 27.58, globalDiscountPercent: 6, compositions, issues: [],
});

describe('importação Analítica dos novos serviços', () => {
  it('permite mapear as colunas da Sintética antes da criação', () => {
    const rows = [
      ['Código', 'Item', 'Banco', 'Descrição', 'Und', 'Quant.', 'Valor Unit', 'Total', 'Valor c/ BDI', 'Total c/ BDI'],
      ['C.0060', '2.4.2', 'Próprio', 'Eletroduto', 'M', 819, 11.74, 9615.06, 14.97, 12260.43],
    ];
    const result = parseAdditiveSyntheticWorkbook(rows, 'Teste', {
      headerRowIndex: 0, firstDataRowIndex: 1,
      columns: { code: 0, item: 1, bank: 2, description: 3, unit: 4, quantity: 5, unitPriceNoBDI: 6, totalNoBDI: 7, unitPriceWithBDI: 8, totalWithBDI: 9 },
    });
    expect(result.additive.compositions[0]).toMatchObject({ code: 'C.0060', item: '2.4.2', quantity: 819, unit: 'M', totalWithBDI: 12260.43 });
  });

  it('lê blocos marcados por Composição e filhos com marcador vazio', () => {
    const rows = [
      ['', 'Código', 'Banco', 'Descrição', 'Und', 'Quant.', 'Valor Unit', 'Total'],
      ['Composição', 'ABHI_3', 'Próprio', 'Abrigo', 'UN', 1, 2775.03, 2775.03],
      ['', '88489', 'SINAPI', 'Pintura', 'm²', 5.238, 13.88, 72.7],
      ['', '', '', '', '', '', '', ''],
      ['', 'Código', 'Banco', 'Descrição', 'Und', 'Quant.', 'Valor Unit', 'Total'],
      ['Composição', 'MANG_1', 'Próprio', 'Mangueira', 'UN', 1, 1325.01, 1325.01],
      ['', '88267', 'SINAPI', 'Bombeiro hidráulico', 'H', 0.146, 28.18, 4.11],
    ];
    const parsed = parseAnalyticRowsFlexible(rows, {
      headerRowIndex: 0, firstDataRowIndex: 1, blockMode: 'composition_marker',
    });
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0]).toMatchObject({ code: 'ABHI_3', bank: 'Próprio', unit: 'UN', referenceUnitPriceNoBDI: 2775.03 });
    expect(parsed.blocks[0].inputs).toHaveLength(1);
    expect(parsed.blocks[1].inputs[0]).toMatchObject({ code: '88267', coefficient: 0.146, unit: 'H', unitPrice: 28.18 });
  });

  it('normaliza somente espaços, pontos e sublinhados, preservando zeros', () => {
    expect(normalizeAdditiveAnalyticCode('ABHI_3')).toBe('ABHI3');
    expect(normalizeAdditiveAnalyticCode('C.0060')).toBe('C0060');
    expect(normalizeAdditiveAnalyticCode('C0060')).toBe('C0060');
  });

  it('preserva a coluna Total da Analítica em vez de recalcular pelos valores exibidos', () => {
    const rows = [
      ['', 'Código', 'Banco', 'Descrição', 'Und', 'Quant.', 'Valor Unit', 'Total'],
      ['Composição', '9106', 'ORSE', 'Suporte', 'un', 1, 26.11, 26.11],
      ['', '00006111/SINAPI', 'ORSE', 'Servente', 'h', 0.25, 14.58, 3.64],
      ['', '00002696/SINAPI', 'ORSE', 'Encanador', 'h', 0.25, 20.44, 5.10],
      ['', '10549', 'ORSE', 'Encargos', 'h', 0.25, 3.87, 0.96],
    ];
    const parsed = parseAnalyticRowsFlexible(rows, {
      headerRowIndex: 0, firstDataRowIndex: 1, blockMode: 'composition_marker',
    });
    expect(parsed.blocks[0].inputs.map(input => input.total)).toEqual([3.64, 5.10, 0.96]);
  });

  it('substitui somente a Analítica nova, recalcula a linha e preserva o contrato', () => {
    const contracted = composition({ id: 'contract', item: '2.4.1', itemNumber: '2.4.1', phaseId: 'phase-24', isNewService: false, code: '88489', bank: 'SINAPI', unitPriceNoBDI: 10, inputs: [{ id: 'old', code: '88489', bank: 'SINAPI', description: 'Original', unit: 'm²', coefficient: 1, unitPrice: 10, total: 10 }] });
    const fresh = composition({ id: 'new' });
    const source = additive([contracted, fresh]);
    const blocks = [{ normCode: 'ABHI3', code: 'ABHI3', item: '', bank: 'Próprio', description: 'Abrigo Excel', unit: 'UN', referenceUnitPriceNoBDI: 26.19, startRow: 2, inputs: [{ code: '88489', bank: 'SINAPI', description: 'Pintura', unit: 'm²', coefficient: 0.25, unitPrice: 14.58, total: 3.65, rowIndex: 3 }] }];
    const preview = buildAdditiveAnalyticImportPreview(source, blocks, ['phase-29']);
    const result = applyAdditiveAnalyticImport(source, blocks, preview);
    expect(preview).toMatchObject({ matched: 1, priceDivergences: 1, contractedCompositionsAffected: 0 });
    expect(preview.matches[0].referenceUnitPriceNoBDI).toBe(3.64);
    expect(result.compositions[0]).toEqual(contracted);
    expect(result.compositions[1].inputs[0].unitPrice).toBe(14.58);
    expect(result.compositions[1].inputs[0].total).toBe(3.64);
    expect(result.compositions[1].analyticReferenceUnitPriceNoBDI).toBe(3.64);
    const financial = computeAdditiveRow(result.compositions[1], 27.58, 6);
    expect(financial.referenceUnitNoBDI).toBe(3.64);
  });

  it('preserva o Total importado em um aditivo contratado legado', () => {
    const fresh = composition({ id: 'legacy-new' });
    const source = { ...additive([fresh]), isContracted: true } as Additive;
    const blocks = [{ normCode: 'ABHI3', code: 'ABHI3', item: '', bank: 'Próprio', referenceUnitPriceNoBDI: 26.19, startRow: 1, inputs: [{ code: 'I1', bank: 'ORSE', description: 'Servente', unit: 'H', coefficient: 0.25, unitPrice: 14.58, total: 3.65, rowIndex: 2 }] }];
    const result = applyAdditiveAnalyticImport(source, blocks, buildAdditiveAnalyticImportPreview(source, blocks, ['phase-29']));
    expect(result.compositions[0].inputs[0].total).toBe(3.65);
    expect(result.compositions[0].analyticReferenceUnitPriceNoBDI).toBe(26.19);
  });

  it('bloqueia códigos duplicados quando a quantidade de ocorrências diverge', () => {
    const source = additive([composition({ id: 'one', code: '11304', bank: 'ORSE' })]);
    const block = (startRow: number) => ({ normCode: '11304', code: '11304', item: '', bank: 'ORSE', startRow, inputs: [] });
    const preview = buildAdditiveAnalyticImportPreview(source, [block(1), block(2)], ['phase-29']);
    expect(preview).toMatchObject({ matched: 0, conflicts: 2 });
  });

  it('reimporta substituindo vinculados e mantém não vinculados intactos', () => {
    const matched = composition({ id: 'matched', inputs: [{ id: 'before', code: 'OLD', bank: 'SINAPI', description: 'Antigo', unit: 'UN', coefficient: 1, unitPrice: 1, total: 1 }] });
    const untouched = composition({ id: 'untouched', code: 'SEM_MATCH', inputs: [{ id: 'keep', code: 'KEEP', bank: 'SINAPI', description: 'Manter', unit: 'UN', coefficient: 1, unitPrice: 2, total: 2 }] });
    const source = additive([matched, untouched]);
    const blocks = [{ normCode: 'ABHI3', code: 'ABHI3', item: '', bank: 'Próprio', referenceUnitPriceNoBDI: 100, startRow: 1, inputs: [{ code: 'NEW', bank: 'SINAPI', description: 'Novo', unit: 'UN', coefficient: 2, unitPrice: 3, total: 6, rowIndex: 2 }] }];
    const result = applyAdditiveAnalyticImport(source, blocks, buildAdditiveAnalyticImportPreview(source, blocks, ['phase-29']));
    expect(result.compositions[0].inputs[0].code).toBe('NEW');
    expect(result.compositions[1]).toEqual(untouched);
  });
});
