import { beforeEach, describe, expect, it } from 'vitest';
import type { CloudProjectMeta } from '@/lib/cloudProjects';
import { projectDraftKey } from '@/lib/cloudProjectDraftCore';
import { includePendingDraftCollections, selectInitialProject } from './projectBootstrap';

const project = (id: string): CloudProjectMeta => ({
  id, name: id, createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z',
});

beforeEach(() => localStorage.clear());

describe('seleção da obra na abertura', () => {
  it('prioriza a rota válida e conserva a aba autorizada', () => {
    expect(selectInitialProject(
      [project('one'), project('two')], 'two', 'one', 'measurement', 'owner', 'gantt', true,
    )).toEqual({ projectId: 'two', view: 'measurement', warehouseTab: 'painel' });
  });

  it('ignora rota de obra indisponível e respeita o acesso da função', () => {
    const result = selectInitialProject(
      [project('one'), project('two')], 'deleted', 'two', 'additive', 'warehouse_operator', 'warehouse', false,
    );
    expect(result).toEqual({ projectId: 'two', view: 'warehouse', warehouseTab: 'notas' });
  });

  it('não tenta carregar uma obra ausente', () => {
    expect(() => selectInitialProject([], undefined, undefined, 'gantt', 'owner', 'gantt', true))
      .toThrow('Não há obras disponíveis');
  });
});

it('carrega as coleções de um rascunho pendente sem duplicar nem puxar auditoria para a abertura', () => {
  localStorage.setItem(projectDraftKey('one'), JSON.stringify({
    version: 2, baseUpdatedAt: null, localDraftUpdatedAt: '2026-10-20T10:00:00Z',
    project: { id: 'one' }, loadedCollections: ['warehouseMovements', 'auditLogs'],
  }));
  expect(includePendingDraftCollections('one', ['tasks', 'warehouseMovements']))
    .toEqual(['tasks', 'warehouseMovements']);
  expect(includePendingDraftCollections('other', ['tasks'])).toEqual(['tasks']);
});
