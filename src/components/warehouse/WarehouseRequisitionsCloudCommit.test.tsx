import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { addMovement, emptyWarehouse } from '@/lib/warehouse';
import WarehouseRequisitionsTab from '@/components/warehouse/WarehouseRequisitionsTab';

const { commitMock, makeAttachmentMock } = vi.hoisted(() => ({
  commitMock: vi.fn(),
  makeAttachmentMock: vi.fn(),
}));

vi.mock('@/lib/warehouseCloudCommit', () => ({ commitWarehouseOperation: commitMock }));
vi.mock('@/lib/warehouse', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/warehouse')>();
  return { ...actual, makeAttachment: makeAttachmentMock };
});
vi.mock('@/components/warehouse/SignaturePad', () => ({
  default: ({ value, onChange }: { value?: string; onChange: (value: string) => void }) => (
    <>
      <button type="button" onClick={() => onChange('assinatura')}>Assinar teste</button>
      {value && <img alt="Assinatura registrada" src={value} />}
    </>
  ),
}));

function projectWithStock(): Project {
  const project: Project = {
    id: 'p', name: 'Obra', startDate: '2026-09-01', endDate: '2026-12-31', totalBudget: 0,
    phases: [{ id: 'chapter-1', name: 'Prédio 1', color: '#000', tasks: [] }],
    warehouse: { ...emptyWarehouse(), receivers: [{ name: 'CANANDA' }] },
  };
  return addMovement(project, {
    type: 'entrada', date: '2026-09-12', itemKey: 'placa', itemCode: 'PL-01',
    itemDescription: 'Placa de sinalização', itemUnit: 'UN', quantity: 10,
  });
}

describe('confirmação visual da retirada', () => {
  beforeEach(() => {
    commitMock.mockReset();
    makeAttachmentMock.mockReset();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:foto-teste') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  it('não publica a linha nem libera PDF enquanto o servidor não confirmou', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Element.prototype.scrollIntoView = vi.fn();
    let confirmServer: (() => void) | undefined;
    commitMock.mockImplementation((_before: Project, after: Project) => new Promise(resolve => {
      const requisitionId = after.warehouse!.requisitions[0].id;
      confirmServer = () => resolve({
        project: {
          ...after,
          warehouse: {
            ...after.warehouse!,
            requisitions: after.warehouse!.requisitions.map(requisition => ({
              ...requisition,
              number: 'REQ-2026-0120',
            })),
          },
        },
        committedAt: '2026-09-12T14:00:00.000Z',
        projectUpdatedAt: '2026-09-12T14:00:00.100Z',
        warehouseUpdatedAt: '2026-09-12T14:00:00.100Z',
        warehouseVersion: 3,
        acknowledgement: {
          requisitionId,
          movementIds: after.warehouse!.movements.filter(movement => movement.requisitionId === requisitionId).map(movement => movement.id),
          auditLogIds: (after.auditLogs ?? []).map(log => log.id),
        },
        dailyReportChanges: [],
      });
    }));
    const onProjectChange = vi.fn();
    const onCloudOperationConfirmed = vi.fn();
    const onPrepareCloudOperation = vi.fn().mockResolvedValue(undefined);
    render(<WarehouseRequisitionsTab project={projectWithStock()} onProjectChange={onProjectChange} onCloudOperationConfirmed={onCloudOperationConfirmed} onPrepareCloudOperation={onPrepareCloudOperation} />);

    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));
    fireEvent.change(document.getElementById('withdrawal-chapter')!, { target: { value: 'chapter-1' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Quem recebeu' }));
    fireEvent.click(screen.getByText('CANANDA'));
    fireEvent.click(within(screen.getByLabelText('Materiais disponíveis')).getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Assinar teste' }));
    fireEvent.click(screen.getByRole('button', { name: 'Entregar e baixar estoque' }));

    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(onPrepareCloudOperation).toHaveBeenCalledTimes(1);
    expect(onPrepareCloudOperation.mock.invocationCallOrder[0]).toBeLessThan(commitMock.mock.invocationCallOrder[0]);
    expect(onProjectChange).not.toHaveBeenCalled();
    const pendingButton = screen.getByRole('button', { name: 'Salvando na nuvem...' });
    expect(pendingButton).toBeDisabled();
    expect(document.getElementById('withdrawal-date')).toBeDisabled();
    expect(document.getElementById('withdrawal-chapter')).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'PDF' })).not.toBeInTheDocument();

    const dialog = screen.getByRole('dialog', { name: 'Nova retirada de materiais' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(dialog).toBeInTheDocument();

    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    await act(async () => confirmServer?.());
    await waitFor(() => expect(onCloudOperationConfirmed).toHaveBeenCalledTimes(1));
    expect(onProjectChange).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Salvo na nuvem · REQ-2026-0120');
    expect(screen.getByRole('dialog', { name: 'Nova retirada de materiais' })).toBeInTheDocument();
    await waitFor(
      () => expect(screen.queryByRole('dialog', { name: 'Nova retirada de materiais' })).not.toBeInTheDocument(),
      { timeout: 2_000 },
    );
  });

  it('preserva o formulário e não libera PDF quando a transação é rejeitada', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Element.prototype.scrollIntoView = vi.fn();
    commitMock.mockRejectedValue(new Error('A auditoria desta operação não pôde ser validada.'));
    const onProjectChange = vi.fn();
    render(<WarehouseRequisitionsTab project={projectWithStock()} onProjectChange={onProjectChange} />);

    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));
    fireEvent.change(document.getElementById('withdrawal-chapter')!, { target: { value: 'chapter-1' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Quem recebeu' }));
    fireEvent.click(screen.getByText('CANANDA'));
    fireEvent.click(within(screen.getByLabelText('Materiais disponíveis')).getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Assinar teste' }));
    fireEvent.click(screen.getByRole('button', { name: 'Entregar e baixar estoque' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Entregar e baixar estoque' })).toBeEnabled());
    expect(onProjectChange).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Nova retirada de materiais' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Quem recebeu' })).toHaveTextContent('CANANDA');
    expect(within(dialog).getByText('Materiais selecionados')).toBeInTheDocument();
    expect(within(dialog).getByText('1 item(ns)')).toBeInTheDocument();
    expect(screen.getByAltText('Assinatura registrada')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'PDF' })).not.toBeInTheDocument();
  });

  it('inicia a trava global antes do upload e a libera somente após a confirmação integral', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Element.prototype.scrollIntoView = vi.fn();
    let finishUpload: (() => void) | undefined;
    makeAttachmentMock.mockImplementation(() => new Promise(resolve => {
      finishUpload = () => resolve({
        id: 'attachment-1',
        name: 'foto.jpg',
        type: 'image/jpeg',
        size: 10,
        storagePath: 'withdrawals/foto.jpg',
      });
    }));
    commitMock.mockImplementation((_before: Project, after: Project) => Promise.resolve({
      project: after,
      committedAt: '2026-09-12T14:00:00.000Z',
      projectUpdatedAt: '2026-09-12T14:00:00.100Z',
      warehouseUpdatedAt: '2026-09-12T14:00:00.100Z',
      warehouseVersion: 3,
      acknowledgement: {
        requisitionId: after.warehouse!.requisitions[0].id,
        movementIds: [],
        auditLogIds: [],
      },
      dailyReportChanges: [],
    }));
    let criticalFlowCalls = 0;
    let criticalFlowFinished = false;
    const onRunCriticalCloudOperation = async <T,>(operation: () => Promise<T>): Promise<T> => {
      criticalFlowCalls += 1;
      try {
        return await operation();
      } finally {
        criticalFlowFinished = true;
      }
    };
    const onCloudOperationConfirmed = vi.fn().mockResolvedValue(undefined);

    render(<WarehouseRequisitionsTab
      project={projectWithStock()}
      onProjectChange={vi.fn()}
      onCloudOperationConfirmed={onCloudOperationConfirmed}
      onRunCriticalCloudOperation={onRunCriticalCloudOperation}
    />);

    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));
    fireEvent.change(document.getElementById('withdrawal-chapter')!, { target: { value: 'chapter-1' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Quem recebeu' }));
    fireEvent.click(screen.getByText('CANANDA'));
    fireEvent.click(within(screen.getByLabelText('Materiais disponíveis')).getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Assinar teste' }));
    const galleryInput = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    fireEvent.change(galleryInput, { target: { files: [new File(['foto'], 'foto.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Entregar e baixar estoque' }));

    await waitFor(() => expect(makeAttachmentMock).toHaveBeenCalledTimes(1));
    expect(criticalFlowCalls).toBe(1);
    expect(commitMock).not.toHaveBeenCalled();
    expect(criticalFlowFinished).toBe(false);

    await act(async () => finishUpload?.());
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCloudOperationConfirmed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(criticalFlowFinished).toBe(true));
  });
});
