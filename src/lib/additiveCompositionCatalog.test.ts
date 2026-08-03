import { describe, expect, it } from 'vitest';
import type { AdditiveComposition, Project } from '@/types/project';
import {
  cloneTemplateTechnicalPatch,
  normalizeAdditiveCatalogCode,
  removeNewServiceAndCompact,
  reorderNewService,
  resolveAdditiveCompositionTemplate,
  upsertAdditiveCompositionTemplate,
} from './additiveCompositionCatalog';
import { stripNormalizedCollections } from './projectSync';

const composition = (id: string, item: string, code = id): AdditiveComposition => ({
  id, item, itemNumber: item, code, bank: 'ORSE', description: `Serviço ${id}`,
  quantity: 0, unit: 'UN', unitPriceNoBDI: 10, unitPriceNoBDIInformed: 10,
  unitPriceWithBDI: 0, total: 0, inputs: [{ id: `input-${id}`, code: 'I1', bank: 'ORSE', description: 'Insumo', unit: 'UN', coefficient: 1, unitPrice: 10, total: 10 }],
  phaseId: 'phase-3-10', phaseChain: '3.10 NOVOS', isNewService: true,
});

describe('catálogo de composições aditivadas', () => {
  it('normaliza somente espaços, pontos e sublinhados, preservando zeros', () => {
    expect(normalizeAdditiveCatalogCode(' ABHI_3 ')).toBe('ABHI3');
    expect(normalizeAdditiveCatalogCode('C.0060')).toBe('C0060');
  });

  it('salva e recupera a estrutura técnica sem campos de quantidade ou memória', () => {
    const source = { ...composition('source', '3.10.1', 'C.0060'), addedQuantity: 8, calculationMemory: [{ id: 'm1', type: 'acrescida' as const, partial: 8 }] };
    const catalog = upsertAdditiveCompositionTemplate([], source, 'add-1', '2026-08-03T00:00:00.000Z');
    const resolution = resolveAdditiveCompositionTemplate(catalog, [], 'target', 'C0060', 'ORSE');
    expect(resolution.ambiguous).toBe(false);
    expect(resolution.template).toMatchObject({ code: 'C.0060', bank: 'ORSE', description: 'Serviço source' });
    expect(resolution.template).not.toHaveProperty('addedQuantity');
    expect(resolution.template).not.toHaveProperty('calculationMemory');
    const restored = cloneTemplateTechnicalPatch(resolution.template!, () => 'new-input-id');
    expect(restored.inputs?.[0].id).toBe('new-input-id');
    expect(restored).not.toHaveProperty('addedQuantity');
    expect(restored).not.toHaveProperty('calculationMemory');
  });

  it('mantém conflito quando o mesmo código possui definições em bancos diferentes', () => {
    const first = composition('first', '3.10.1', '11304');
    const second = { ...composition('second', '3.10.2', '11304'), bank: 'SINAPI' };
    const catalog = upsertAdditiveCompositionTemplate(upsertAdditiveCompositionTemplate([], first), second);
    expect(resolveAdditiveCompositionTemplate(catalog, [], 'target', '11304').ambiguous).toBe(true);
    expect(resolveAdditiveCompositionTemplate(catalog, [], 'target', '11304', 'SINAPI').template?.bank).toBe('SINAPI');
  });

  it('mantém o catálogo no data_json da obra ao separar as coleções normalizadas', () => {
    const catalog = upsertAdditiveCompositionTemplate([], composition('source', '3.10.1'));
    const project = { id: 'project-1', additives: [], analyticCompositions: [], additiveCompositionCatalog: catalog } as unknown as Project;
    expect(stripNormalizedCollections(project).additiveCompositionCatalog).toEqual(catalog);
  });
});

describe('reordenação de novos serviços', () => {
  it('move 3.10.26 para 3.10.21 e desloca os itens seguintes', () => {
    const rows = Array.from({ length: 26 }, (_, index) => composition(`c${index + 1}`, `3.10.${index + 1}`));
    const result = reorderNewService(rows, 'c26', '3.10.21');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compositions.slice(20, 26).map(row => row.id)).toEqual(['c26', 'c21', 'c22', 'c23', 'c24', 'c25']);
    expect(result.compositions.slice(20, 26).map(row => row.itemNumber)).toEqual(['3.10.21', '3.10.22', '3.10.23', '3.10.24', '3.10.25', '3.10.26']);
  });

  it('aceita somente o sufixo e rejeita mudança de subcapítulo', () => {
    const rows = [composition('c1', '3.10.1'), composition('c2', '3.10.2')];
    expect(reorderNewService(rows, 'c2', '1').ok).toBe(true);
    expect(reorderNewService(rows, 'c2', '2.9.1')).toMatchObject({ ok: false });
    expect(reorderNewService(rows, 'c2', '0')).toMatchObject({ ok: false });
  });

  it('não ocupa nem renumera a posição de um item contratado', () => {
    const contracted = { ...composition('base', '3.10.2'), isNewService: false };
    const rows = [composition('c1', '3.10.1'), contracted, composition('c2', '3.10.3')];
    expect(reorderNewService(rows, 'c2', '2')).toMatchObject({ ok: false });
    const moved = reorderNewService(rows, 'c2', '1');
    expect(moved.ok).toBe(true);
    if (moved.ok) expect(moved.compositions.find(row => row.id === 'base')?.itemNumber).toBe('3.10.2');
  });

  it('compacta lacunas após exclusão preservando a ordem estável', () => {
    const rows = [composition('c1', '3.10.1'), composition('c2', '3.10.2'), composition('c3', '3.10.4'), composition('c4', '3.10.4')];
    const remaining = removeNewServiceAndCompact(rows, 'c2');
    expect(remaining.map(row => [row.id, row.itemNumber])).toEqual([
      ['c1', '3.10.1'], ['c3', '3.10.2'], ['c4', '3.10.3'],
    ]);
  });
});
