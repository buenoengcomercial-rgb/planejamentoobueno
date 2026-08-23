import { describe, expect, it } from 'vitest';
import { reconcileSubcontracts, stripNormalizedCollections } from '@/lib/projectSync';
import type { Project, Subcontract } from '@/types/project';

const contract = (id: string, name = id): Subcontract => ({
  id, name, contractorName: 'Prestador', contractDate: '2026-08-23', contractedValue: 100,
  status: 'contracted', items: [], payments: [], createdAt: '2026-08-23T00:00:00Z',
});

describe('backup de terceirizados na nuvem', () => {
  it('mantém os contratos no data_json de segurança', () => {
    const project = { id: 'p', name: 'Obra', phases: [], totalBudget: 0, subcontracts: [contract('novo')] } as Project;
    expect(stripNormalizedCollections(project).subcontracts).toEqual([contract('novo')]);
  });

  it('não perde pacote recém-criado quando a tabela normalizada retorna vazia ou falha', () => {
    const backup = [contract('novo')];
    expect(reconcileSubcontracts(backup, [])).toEqual(backup);
    expect(reconcileSubcontracts(backup, null)).toEqual(backup);
  });

  it('reconcilia tabela e backup por id, preservando a versão recém-salva do projeto', () => {
    const backup = [contract('novo', 'Pacote atualizado')];
    const normalized = [contract('antigo'), contract('novo', 'Pacote antigo')];
    expect(reconcileSubcontracts(backup, normalized)).toEqual([
      contract('antigo'),
      contract('novo', 'Pacote atualizado'),
    ]);
  });
});
