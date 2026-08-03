import { describe, expect, it } from 'vitest';
import type { Additive, AdditiveComposition, Project } from '@/types/project';
import {
  cloneTemplateTechnicalPatch,
  consolidateAdditiveCompositionCatalog,
  isIncompleteNewService,
  normalizeAdditiveCatalogCode,
  removeNewServiceAndCompact,
  reorderNewService,
  reconcileAdditiveCompositionsFromCatalog,
  resolveAdditiveCompositionTemplate,
  restoreIncompleteNewServices,
  synchronizeAdditiveCompositionOccurrences,
  upsertAdditiveCompositionTemplate,
} from './additiveCompositionCatalog';
import { stripNormalizedCollections } from './projectSync';

const composition = (id: string, item: string, code = id): AdditiveComposition => ({
  id, item, itemNumber: item, code, bank: 'ORSE', description: `Serviço ${id}`,
  quantity: 0, unit: 'UN', unitPriceNoBDI: 10, unitPriceNoBDIInformed: 10,
  unitPriceWithBDI: 0, total: 0, inputs: [{ id: `input-${id}`, code: 'I1', bank: 'ORSE', description: 'Insumo', unit: 'UN', coefficient: 1, unitPrice: 10, total: 10 }],
  phaseId: 'phase-3-10', phaseChain: '3.10 NOVOS', isNewService: true,
});

describe('sincronização técnica por código', () => {
  const additive = (
    id: string,
    compositions: AdditiveComposition[],
    extra: Partial<Additive> = {},
  ): Additive => ({
    id,
    name: id,
    importedAt: '2026-08-03T00:00:00.000Z',
    status: 'rascunho',
    compositions,
    ...extra,
  });

  it('propaga a estrutura completa e preserva campos locais de cada ocorrência', () => {
    const source = {
      ...composition('source', '2.9.19', 'ABHI_4'),
      description: 'Abrigo corrigido',
      addedQuantity: 1,
      calculationMemory: [{ id: 'memory-source', type: 'acrescida' as const, partial: 1 }],
      inputs: [
        { id: 's1', code: 'A', bank: 'SINAPI', description: 'Primeiro', unit: 'H', coefficient: 2, unitPrice: 3, total: 6 },
        { id: 's2', code: 'B', bank: 'SBC', description: 'Segundo', unit: 'UN', coefficient: 4, unitPrice: 5, total: 20 },
      ],
    };
    const target = {
      ...composition('target', '4.9.1', 'ABHI.4'),
      description: 'Estrutura antiga',
      addedQuantity: 10,
      phaseId: 'phase-4-9',
      calculationMemory: [{ id: 'memory-target', type: 'acrescida' as const, partial: 10 }],
    };
    let nextId = 0;
    const result = synchronizeAdditiveCompositionOccurrences(
      [additive('a1', [source]), additive('a2', [target])],
      [], 'a1', source.id, () => `clone-${++nextId}`, '2026-08-03T12:00:00.000Z',
    );
    const synced = result.additives[1].compositions[0];
    expect(synced).toMatchObject({
      code: 'ABHI_4', description: 'Abrigo corrigido', itemNumber: '4.9.1',
      phaseId: 'phase-4-9', addedQuantity: 10,
      calculationMemory: [{ id: 'memory-target', type: 'acrescida', partial: 10 }],
    });
    expect(synced.inputs.map(input => [input.code, input.coefficient, input.total]))
      .toEqual([['A', 2, 6], ['B', 4, 20]]);
    expect(synced.inputs.map(input => input.id)).toEqual(['clone-1', 'clone-2']);
    expect(result.catalog).toHaveLength(1);
    expect(result.synchronized).toHaveLength(1);
  });

  it('preserva aprovados, contratados, snapshots e revisões bloqueadas', () => {
    const source = { ...composition('source', '2.9.1', 'ABHI4'), description: 'Vigente' };
    const divergent = (id: string) => ({ ...composition(id, '4.9.1', 'ABHI_4'), description: 'Congelada' });
    const locked = [
      additive('approved', [divergent('approved-c')], { status: 'aprovado' }),
      additive('contracted', [divergent('contracted-c')], { status: 'aditivo_contratado', isContracted: true }),
      additive('revision-locked', [divergent('revision-c')], { isContracted: true, editUnlocked: false }),
    ];
    const snapshotComposition = divergent('snapshot-c');
    locked[0].approvalSnapshots = [{
      version: 1, approvedAt: '2026-08-03', bdiPercent: 27.58,
      globalDiscountPercent: 6, totals: {}, issues: [], compositions: [snapshotComposition],
    }];
    const openRevision = additive('open', [divergent('open-c')], {
      status: 'aditivo_contratado', isContracted: true, editUnlocked: true,
    });
    const result = synchronizeAdditiveCompositionOccurrences(
      [additive('source-add', [source]), ...locked, openRevision], [],
      'source-add', source.id, () => 'new-id',
    );
    expect(result.synchronized.map(item => item.additiveId)).toEqual(['open']);
    expect(result.additives.slice(1, 4).map(item => item.compositions[0].description))
      .toEqual(['Congelada', 'Congelada', 'Congelada']);
    expect(result.additives[1].approvalSnapshots?.[0].compositions[0].description).toBe('Congelada');
    expect(result.additives[4].compositions[0].description).toBe('Vigente');
  });

  it('reconcilia pelo catálogo existente e não escolhe uma estrutura em legado sem catálogo', () => {
    const master = { ...composition('master', '2.9.1', 'ABHI_4'), description: 'Catálogo vigente' };
    const divergent = { ...composition('old', '4.9.1', 'ABHI4'), description: 'Legado divergente' };
    const catalog = upsertAdditiveCompositionTemplate([], master);
    const reconciled = reconcileAdditiveCompositionsFromCatalog(
      [additive('draft', [divergent])], catalog, () => 'reconciled-input',
    );
    expect(reconciled.reconciled).toHaveLength(1);
    expect(reconciled.additives[0].compositions[0].description).toBe('Catálogo vigente');

    const untouched = reconcileAdditiveCompositionsFromCatalog(
      [additive('legacy', [master, divergent])], [], () => 'unused',
    );
    expect(untouched.reconciled).toHaveLength(0);
    expect(untouched.additives[0].compositions.map(item => item.description))
      .toEqual(['Catálogo vigente', 'Legado divergente']);
  });
});

describe('catálogo de composições aditivadas', () => {
  it('normaliza somente espaços, pontos e sublinhados, preservando zeros', () => {
    expect(normalizeAdditiveCatalogCode(' ABHI_3 ')).toBe('ABHI3');
    expect(normalizeAdditiveCatalogCode('C.0060')).toBe('C0060');
  });

  it('salva e recupera a estrutura técnica sem campos de quantidade ou memória', () => {
    const source = { ...composition('source', '3.10.1', 'C.0060'), addedQuantity: 8, calculationMemory: [{ id: 'm1', type: 'acrescida' as const, partial: 8 }] };
    const catalog = upsertAdditiveCompositionTemplate([], source, 'add-1', '2026-08-03T00:00:00.000Z');
    const resolution = resolveAdditiveCompositionTemplate(catalog, [], 'target', 'C0060');
    expect(resolution.template).toMatchObject({ code: 'C.0060', bank: 'ORSE', description: 'Serviço source' });
    expect(resolution.template).not.toHaveProperty('addedQuantity');
    expect(resolution.template).not.toHaveProperty('calculationMemory');
    const restored = cloneTemplateTechnicalPatch(resolution.template!, () => 'new-input-id');
    expect(restored.inputs?.[0].id).toBe('new-input-id');
    expect(restored).not.toHaveProperty('addedQuantity');
    expect(restored).not.toHaveProperty('calculationMemory');
  });

  it('mantém uma única composição por código e usa a versão completa mais recente', () => {
    const first = composition('first', '3.10.1', '11304');
    const second = { ...composition('second', '3.10.2', '11304'), bank: 'SINAPI' };
    const catalog = upsertAdditiveCompositionTemplate(
      upsertAdditiveCompositionTemplate([], first, 'add-1', '2026-08-01T00:00:00.000Z'),
      second,
      'add-2',
      '2026-08-02T00:00:00.000Z',
    );
    expect(catalog).toHaveLength(1);
    expect(resolveAdditiveCompositionTemplate(catalog, [], 'target', '11304').template)
      .toMatchObject({ bank: 'SINAPI', description: 'Serviço second' });
  });

  it('consolida duplicidades legadas e descarta a versão incompleta mais recente', () => {
    const complete = upsertAdditiveCompositionTemplate(
      [], composition('complete', '5.10.3', 'FIXA_1'), 'add-1', '2026-08-01T00:00:00.000Z',
    )[0];
    const incomplete = {
      ...complete,
      id: 'legacy-empty',
      code: 'FIXA1',
      bank: '',
      description: 'Novo serviço',
      unitPriceNoBDIInformed: 0,
      inputs: [],
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    const result = consolidateAdditiveCompositionCatalog([complete, incomplete]);
    expect(result.changed).toBe(true);
    expect(result.catalog).toHaveLength(1);
    expect(result.catalog[0]).toMatchObject({
      id: 'additive-template:FIXA1', bank: 'ORSE', description: 'Serviço complete',
    });
  });

  it('usa a ocorrência completa mais recente quando o catálogo ainda não existe', () => {
    const oldOccurrence = composition('old', '2.9.1', 'FIXA_1');
    const recentOccurrence = {
      ...composition('recent', '6.9.1', 'FIXA1'), bank: 'PRÓPRIO', description: 'Fixação vigente',
    };
    const resolution = resolveAdditiveCompositionTemplate(
      [], [oldOccurrence, recentOccurrence], 'target', 'FIXA_1',
    );
    expect(resolution.template).toMatchObject({ bank: 'PRÓPRIO', description: 'Fixação vigente' });
  });

  it('mantém o catálogo no data_json da obra ao separar as coleções normalizadas', () => {
    const catalog = upsertAdditiveCompositionTemplate([], composition('source', '3.10.1'));
    const project = { id: 'project-1', additives: [], analyticCompositions: [], additiveCompositionCatalog: catalog } as unknown as Project;
    expect(stripNormalizedCollections(project).additiveCompositionCatalog).toEqual(catalog);
  });

  it('recupera uma linha incompleta em outro subcapítulo sem restaurar quantidade ou memória', () => {
    const source = {
      ...composition('source', '5.10.3', 'FIXA_1'),
      addedQuantity: 42,
      calculationMemory: [{ id: 'm1', type: 'acrescida' as const, partial: 42 }],
    };
    const catalog = upsertAdditiveCompositionTemplate([], source);
    const target: AdditiveComposition = {
      ...composition('target', '6.9.3', 'FIXA1'),
      phaseId: 'phase-6-9',
      phaseChain: '6.9 SERVIÇOS - ITENS NOVOS',
      bank: '',
      description: 'Novo serviço',
      unitPriceNoBDI: 0,
      unitPriceNoBDIInformed: 0,
      inputs: [],
      addedQuantity: 0,
      calculationMemory: [],
    };
    expect(isIncompleteNewService(target)).toBe(true);
    const result = restoreIncompleteNewServices(catalog, [target], [target], () => 'restored-input');
    expect(result.restored).toHaveLength(1);
    expect(result.compositions[0]).toMatchObject({
      itemNumber: '6.9.3', phaseId: 'phase-6-9', bank: 'ORSE',
      description: 'Serviço source', addedQuantity: 0, calculationMemory: [],
    });
    expect(result.compositions[0].inputs[0].id).toBe('restored-input');
  });

  it('não sobrescreve linha parcialmente preenchida e restaura a vazia pela versão mais recente', () => {
    const first = composition('first', '5.10.3', 'PINT_02');
    const second = { ...composition('second', '6.10.2', 'PINT02'), bank: 'SINAPI' };
    const catalog = upsertAdditiveCompositionTemplate(
      upsertAdditiveCompositionTemplate([], first, 'add-1', '2026-08-01T00:00:00.000Z'),
      second,
      'add-2',
      '2026-08-02T00:00:00.000Z',
    );
    const partial = {
      ...composition('partial', '6.9.4', 'PINT02'), bank: '', description: 'Descrição manual',
      unitPriceNoBDI: 0, unitPriceNoBDIInformed: 0, inputs: [],
    };
    const blank = { ...partial, id: 'blank', description: 'Novo serviço' };
    const priced = { ...blank, id: 'priced', unitPriceNoBDI: 5 };
    expect(isIncompleteNewService(partial)).toBe(false);
    expect(isIncompleteNewService(priced)).toBe(false);
    const result = restoreIncompleteNewServices(catalog, [partial, blank], [partial, blank], () => 'new-id');
    expect(result.restored).toHaveLength(1);
    expect(result.compositions[0]).toEqual(partial);
    expect(result.compositions[1]).toMatchObject({ bank: 'SINAPI', description: 'Serviço second' });
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
