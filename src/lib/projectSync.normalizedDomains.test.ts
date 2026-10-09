import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { clearCloudSnapshot, confirmProjectCollectionsSnapshot, getLoadedProjectCollections, setCloudSnapshot, stripNormalizedCollections, syncNormalizedDomainAtomically } from '@/lib/projectSync';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));

const base = {
  id: 'project-domains', name: 'Obra', phases: [],
  measurements: [{ id: 'measurement-1', number: 1, status: 'draft' }],
  additives: [{ id: 'additive-1', name: 'Aditivo', version: 1 }],
  budgetItems: [{ id: 'item-1', item: 'Tubo', code: 'A' }],
  materialComparisons: [], analyticCompositions: [], materialPriceHistory: [],
  subcontracts: [{ id: 'contract-1', name: 'Equipe', status: 'draft' }],
  auditLogs: [],
} as unknown as Project;

const save = (project: Project) => syncNormalizedDomainAtomically(
  project, stripNormalizedCollections(project), 'org-1', '2026-09-30T23:00:00Z',
);

afterEach(() => { clearCloudSnapshot(base.id); rpc.mockReset(); });

describe('transações por domínio normalizado', () => {
  it('confirma Medição e auditoria nova com histórico não carregado', async () => {
    confirmProjectCollectionsSnapshot(base, ['measurements'], { replaceExisting: true });
    const next = { ...base, measurements: [{ ...base.measurements![0], status: 'approved' }], auditLogs: [{ id: 'new-audit', entityType: 'measurement', entityId: 'measurement-1', action: 'approved', at: '2026-10-09', title: 'Aprovada' }] } as Project;
    rpc.mockResolvedValue({ data: 'v2', error: null });
    expect(await save(next)).toBe('v2');
    expect(rpc).toHaveBeenCalledWith('save_normalized_domain', expect.objectContaining({ p_audit_insert: [expect.objectContaining({ id: 'new-audit' })] }));
    expect(getLoadedProjectCollections(base.id)).not.toContain('auditLogs');
    expect(await save(next)).toBeNull();
  });
  it('envia somente a Medição alterada e sua auditoria em uma RPC', async () => {
    setCloudSnapshot(base.id, base);
    const next = {
      ...base,
      measurements: [{ ...base.measurements![0], status: 'approved' }],
      auditLogs: [{ id: 'audit-1', entityType: 'measurement', entityId: 'measurement-1',
        action: 'approved', at: '2026-09-30T23:00:00Z', title: 'Medição aprovada' }],
    } as Project;
    rpc.mockResolvedValue({ data: '2026-10-01T00:00:00Z', error: null });
    expect(await save(next)).toBe('2026-10-01T00:00:00Z');
    expect(rpc).toHaveBeenCalledWith('save_normalized_domain', expect.objectContaining({
      p_domain: 'measurement', p_data: null,
      p_changes: [{ table: 'measurements', upserts: [expect.objectContaining({
        id: 'measurement-1', status: 'approved', data: expect.objectContaining({ status: 'approved' }),
      })], deletes: [] }],
      p_audit_insert: [expect.objectContaining({ id: 'audit-1' })],
    }));
    expect(await save(next)).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('agrupa orçamento e comparação em Materiais sem enviar Medição', async () => {
    setCloudSnapshot(base.id, base);
    const next = {
      ...base,
      budgetItems: [{ ...base.budgetItems![0], code: 'B' }],
      materialComparisons: [{ id: 'comparison-1', name: 'Comparação', status: 'draft' }],
    } as unknown as Project;
    rpc.mockResolvedValue({ data: '2026-10-01T00:00:00Z', error: null });
    expect(await save(next)).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('save_normalized_domain', expect.objectContaining({
      p_domain: 'materials',
      p_changes: [expect.objectContaining({ table: 'budget_items' }),
        expect.objectContaining({ table: 'material_comparisons' })],
    }));
  });

  it('inclui itens importados junto ao Aditivo e mantém a cópia do contrato de Custos', async () => {
    setCloudSnapshot(base.id, base);
    const additive = { ...base, additives: [{ ...base.additives![0], version: 2 }],
      budgetItems: [{ ...base.budgetItems![0], additiveId: 'additive-1' }] } as Project;
    rpc.mockResolvedValue({ data: '2026-10-01T00:00:00Z', error: null });
    expect(await save(additive)).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('save_normalized_domain', expect.objectContaining({
      p_domain: 'additive', p_changes: [expect.objectContaining({ table: 'additives' }),
        expect.objectContaining({ table: 'budget_items' })],
    }));

    setCloudSnapshot(base.id, base);
    const costs = { ...base, subcontracts: [{ ...base.subcontracts![0], status: 'contracted' }] } as Project;
    expect(await save(costs)).toBeTruthy();
    expect(rpc).toHaveBeenLastCalledWith('save_normalized_domain', expect.objectContaining({
      p_domain: 'costs', p_data: expect.objectContaining({ subcontracts: costs.subcontracts }),
    }));
  });

  it('mantém o fluxo conservador quando dois domínios mudam juntos ou a RPC não existe', async () => {
    setCloudSnapshot(base.id, base);
    const mixed = { ...base,
      measurements: [{ ...base.measurements![0], status: 'approved' }],
      budgetItems: [{ ...base.budgetItems![0], code: 'B' }],
    } as Project;
    expect(await save(mixed)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();

    const measurement = { ...base, measurements: [{ ...base.measurements![0], status: 'approved' }] } as Project;
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    expect(await save(measurement)).toBeNull();
  });

  it('usa os lotes controlados do fluxo geral em importações acima do limite transacional', async () => {
    setCloudSnapshot(base.id, base);
    const imported = { ...base,
      budgetItems: Array.from({ length: 502 }, (_, index) => ({ id: `item-${index}`, item: `Insumo ${index}` })),
    } as Project;
    expect(await save(imported)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});
