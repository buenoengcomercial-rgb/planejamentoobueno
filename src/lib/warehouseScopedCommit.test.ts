import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditLog, Project, WarehouseMovement, WarehouseRequisition } from '@/types/project';
import { emptyWarehouse } from '@/lib/warehouse';
import {
  commitWarehouseScopedOperation,
  mergeWarehouseScopedCommit,
  type WarehouseScopedCommitResult,
} from '@/lib/warehouseScopedCommit';

const { rpcMock, supabaseMock } = vi.hoisted(() => {
  const rpcMock = vi.fn();
  return { rpcMock, supabaseMock: { rpc: rpcMock } };
});

vi.mock('@/integrations/supabase/client', () => ({ supabase: supabaseMock }));

const baseProject = (): Project => ({
  id: 'project-1',
  name: 'Obra protegida',
  startDate: '2026-09-01',
  endDate: '2026-12-31',
  totalBudget: 0,
  phases: [],
  warehouse: emptyWarehouse(),
  auditLogs: [],
});

const serverAudit: AuditLog = {
  id: 'audit-server-1',
  entityType: 'warehouse',
  entityId: 'project-1',
  action: 'updated',
  title: 'Almoxarifado atualizado',
  at: '2026-09-12T15:00:00.000Z',
};

const rpcResult = (project: Project, patch: Record<string, unknown> = {}) => ({
  data: {
    warehouseState: project.warehouse,
    movements: [],
    deletedMovementIds: [],
    custody: [],
    deletedCustodyIds: [],
    auditLogs: [serverAudit],
    committedAt: '2026-09-12T15:00:00.000Z',
    projectUpdatedAt: '2026-09-12T15:00:00.100Z',
    warehouseUpdatedAt: '2026-09-12T15:00:00.100Z',
    warehouseVersion: 4,
    ...patch,
  },
  error: null,
});

describe('transações específicas do Almoxarifado', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    vi.stubGlobal('navigator', { ...navigator, onLine: true });
  });

  it('envia somente o cadastro alterado pela RPC do domínio, sem salvar a obra inteira', async () => {
    const before = baseProject();
    const after: Project = {
      ...before,
      warehouse: { ...before.warehouse!, receivers: [{ name: 'KENNEDY' }] },
    };
    rpcMock.mockResolvedValue(rpcResult(after));

    const result = await commitWarehouseScopedOperation(before, after, 3, 'catalog:attempt-1', 'catalog');

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0][0]).toBe('commit_warehouse_catalog');
    expect(rpcMock.mock.calls[0][1]).toMatchObject({
      p_project_id: 'project-1',
      p_operation_key: 'catalog:attempt-1',
      p_expected_warehouse_version: 3,
      p_changes: {
        state: { receivers: { expected: [], next: [{ name: 'KENNEDY' }] } },
        movements: { upserts: [], deletes: [] },
        custody: { upserts: [], deletes: [] },
        audits: [],
      },
    });
    expect(result).toMatchObject({ warehouseVersion: 4, affectedStateKeys: ['receivers'] });
  });

  it('reutiliza uma chave idempotente derivada da mesma alteração em nova tentativa', async () => {
    const before = baseProject();
    const after: Project = { ...before, warehouse: { ...before.warehouse!, receivers: [{ name: 'KENNEDY' }] } };
    rpcMock.mockResolvedValue(rpcResult(after));

    const first = await commitWarehouseScopedOperation(before, after, 3, '', 'catalog');
    const retry = await commitWarehouseScopedOperation(before, after, 3, '', 'catalog');

    expect(first.operationKey).toMatch(/^catalog:/);
    expect(retry.operationKey).toBe(first.operationKey);
    expect(rpcMock.mock.calls[0][1].p_operation_key).toBe(rpcMock.mock.calls[1][1].p_operation_key);
  });

  it('envia somente o ajuste de inventário e sua auditoria', async () => {
    const before = baseProject();
    const movement: WarehouseMovement = {
      id: 'inventory-movement-1', createdAt: '2026-09-12T15:00:00.000Z',
      type: 'ajuste_positivo', date: '2026-09-12', itemKey: 'placa',
      itemDescription: 'Placa', itemUnit: 'UN', quantity: 2,
      originType: 'inventory', originId: 'inventory-1',
    };
    const audit: AuditLog = { ...serverAudit, id: 'audit-client-1', entityId: 'inventory-1' };
    const after: Project = {
      ...before,
      warehouse: { ...before.warehouse!, movements: [movement] },
      auditLogs: [audit],
    };
    rpcMock.mockResolvedValue(rpcResult(after, { movements: [movement], auditLogs: [audit] }));

    const result = await commitWarehouseScopedOperation(before, after, 3, 'inventory:attempt-1', 'inventory');

    expect(rpcMock.mock.calls[0][0]).toBe('commit_warehouse_inventory');
    expect(rpcMock.mock.calls[0][1].p_changes.movements.upserts).toEqual([
      { id: movement.id, expected: null, row: movement },
    ]);
    expect(rpcMock.mock.calls[0][1].p_changes.audits).toEqual([audit]);
    expect(result.project.warehouse!.movements).toEqual([movement]);
  });

  it('bloqueia qualquer tentativa de alterar requisição fora da RPC exclusiva', async () => {
    const before = baseProject();
    const requisition: WarehouseRequisition = {
      id: 'req-1', number: 'REQ-2026-0001', date: '2026-09-12',
      requesterName: 'CANANDA', receiverName: 'CANANDA', status: 'entregue',
      items: [], createdAt: '2026-09-12T15:00:00.000Z',
    };
    const after: Project = { ...before, warehouse: { ...before.warehouse!, requisitions: [requisition] } };

    await expect(commitWarehouseScopedOperation(before, after, 3, 'catalog:invalid', 'catalog'))
      .rejects.toThrow('transação exclusiva de requisições');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('não permite que uma edição do Diário seja enviada junto com o Almoxarifado', async () => {
    const before = baseProject();
    const after: Project = {
      ...before,
      dailyReports: [{
        id: 'daily-1',
        date: '2026-09-12',
        teamsPresent: [],
        equipment: [],
        attachments: [],
        observations: 'Serviço executado no dia.',
        createdAt: '2026-09-12T15:00:00.000Z',
        updatedAt: '2026-09-12T15:00:00.000Z',
      }],
    };

    await expect(commitWarehouseScopedOperation(before, after, 3, 'catalog:invalid-daily', 'catalog'))
      .rejects.toThrow('alteração do Diário');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('mescla apenas o domínio confirmado e preserva edições locais paralelas', () => {
    const current = baseProject();
    current.name = 'Nome local pendente';
    current.warehouse!.locations = [{ id: 'local-location', name: 'Local em edição' }];
    const confirmed = baseProject();
    confirmed.warehouse!.receivers = [{ name: 'KENNEDY' }];
    const result: WarehouseScopedCommitResult = {
      project: confirmed,
      domain: 'catalog',
      operationKey: 'catalog:attempt-2',
      committedAt: '2026-09-12T15:00:00.000Z',
      projectUpdatedAt: '2026-09-12T15:00:00.100Z',
      warehouseUpdatedAt: '2026-09-12T15:00:00.100Z',
      warehouseVersion: 5,
      affectedStateKeys: ['receivers'],
      affectedMovementIds: [],
      affectedCustodyIds: [],
      affectedAuditIds: [],
    };

    const merged = mergeWarehouseScopedCommit(current, result);

    expect(merged.name).toBe('Nome local pendente');
    expect(merged.warehouse!.locations).toEqual(current.warehouse!.locations);
    expect(merged.warehouse!.receivers).toEqual([{ name: 'KENNEDY' }]);
  });
});
