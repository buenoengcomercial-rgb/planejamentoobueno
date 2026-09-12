import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, WarehouseRequisition } from '@/types/project';
import { addMovement, createAndDeliverRequisition, emptyWarehouse } from '@/lib/warehouse';
import { commitWarehouseOperation } from '@/lib/warehouseCloudCommit';

const { rpcMock, supabaseMock } = vi.hoisted(() => {
  const rpcMock = vi.fn();
  return { rpcMock, supabaseMock: { rpc: rpcMock } };
});

vi.mock('@/integrations/supabase/client', () => ({
  supabase: supabaseMock,
}));

function stockedProject(): Project {
  return addMovement({
    id: 'project-1',
    name: 'Obra protegida',
    startDate: '2026-09-01',
    endDate: '2026-12-31',
    totalBudget: 0,
    phases: [{ id: 'chapter-1', name: 'Prédio 1', color: '#000', tasks: [] }],
    warehouse: emptyWarehouse(),
  }, {
    type: 'entrada', date: '2026-09-12', itemKey: 'placa', itemCode: 'PL-01',
    itemDescription: 'Placa de sinalização', itemUnit: 'UN', quantity: 10,
  });
}

describe('confirmação transacional do Almoxarifado', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    vi.stubGlobal('navigator', { ...navigator, onLine: true });
  });

  it('só devolve a retirada depois que a RPC confirma requisição, movimento e auditoria', async () => {
    const before = stockedProject();
    const provisional = createAndDeliverRequisition(before, {
      date: '2026-09-12', chapterId: 'chapter-1', chapterName: 'Prédio 1',
      receiverName: 'CANANDA', requesterName: 'CANANDA', signatureReceiver: 'assinatura',
      deliveryIdempotencyKey: 'attempt-1',
      items: [{ itemKey: 'placa', code: 'PL-01', description: 'Placa de sinalização', unit: 'UN', quantity: 4 }],
    }, { publishToDailyReport: true, actor: { userId: 'user-1', userName: 'Gabriel' } });
    const localRequisition = provisional.project.warehouse!.requisitions[0];
    const canonicalRequisition: WarehouseRequisition = { ...localRequisition, number: 'REQ-2026-0116' };
    const canonicalAudit = (provisional.project.auditLogs ?? []).map(log => ({
      ...log,
      title: log.title.replace(localRequisition.number, canonicalRequisition.number),
    }));
    rpcMock.mockResolvedValue({
      data: {
        requisition: canonicalRequisition,
        movements: provisional.project.warehouse!.movements.filter(row => row.requisitionId === localRequisition.id),
        auditLogs: canonicalAudit,
        committedAt: '2026-09-12T14:00:00.000Z',
      },
      error: null,
    });

    const confirmed = await commitWarehouseOperation(before, provisional.project, {
      type: 'delivery', requisitionId: provisional.requisitionId, operationKey: 'attempt-1',
    });

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.contexts[0]).toBe(supabaseMock);
    expect(rpcMock.mock.calls[0][0]).toBe('commit_warehouse_operation');
    expect(rpcMock.mock.calls[0][1]).toMatchObject({
      p_project_id: 'project-1',
      p_operation_key: 'attempt-1',
      p_operation_type: 'delivery',
      p_expected_requisition: null,
    });
    expect(rpcMock.mock.calls[0][1].p_upsert_movements).toHaveLength(1);
    expect(rpcMock.mock.calls[0][1].p_audit_logs).toHaveLength(1);
    expect(confirmed.warehouse!.requisitions[0].number).toBe('REQ-2026-0116');
    expect(confirmed.dailyReports?.[0].observations).toContain('REQ-2026-0116');
  });

  it('bloqueia uma segunda edição concorrente sem aplicar o projeto local', async () => {
    const before = stockedProject();
    const provisional = createAndDeliverRequisition(before, {
      date: '2026-09-12', chapterId: 'chapter-1', receiverName: 'CANANDA', requesterName: 'CANANDA',
      signatureReceiver: 'assinatura', deliveryIdempotencyKey: 'attempt-conflict',
      items: [{ itemKey: 'placa', description: 'Placa', unit: 'UN', quantity: 1 }],
    });
    rpcMock.mockResolvedValue({ data: null, error: { message: 'WAREHOUSE_RECORD_CONFLICT' } });

    await expect(commitWarehouseOperation(before, provisional.project, {
      type: 'delivery', requisitionId: provisional.requisitionId, operationKey: 'attempt-conflict',
    })).rejects.toThrow('primeira versão confirmada foi preservada');
  });
});
