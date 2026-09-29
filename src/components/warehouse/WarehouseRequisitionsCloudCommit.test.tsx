import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { addMovement, emptyWarehouse } from '@/lib/warehouse';
import WarehouseRequisitionsTab from '@/components/warehouse/WarehouseRequisitionsTab';
import { WarehouseAvailabilityUnavailableError } from '@/lib/warehouseAvailability';
import { WarehouseInsufficientStockError } from '@/lib/warehouseCloudCommit';

const { commitMock, makeAttachmentMock, makeAttachmentsMock, availabilityMock, committedMock } = vi.hoisted(() => ({
  commitMock: vi.fn(),
  makeAttachmentMock: vi.fn(),
  makeAttachmentsMock: vi.fn(),
  availabilityMock: vi.fn(),
  committedMock: vi.fn(),
}));

vi.mock('@/lib/warehouseCloudCommit', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/warehouseCloudCommit')>(),
  commitWarehouseOperation: commitMock,
}));
vi.mock('@/lib/warehouseAvailability', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/warehouseAvailability')>(),
  checkWarehouseWithdrawalAvailability: availabilityMock,
  warehouseOperationWasCommitted: committedMock,
}));
vi.mock('@/lib/warehouse', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/warehouse')>();
  return { ...actual, makeAttachment: makeAttachmentMock, makeAttachments: makeAttachmentsMock };
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
    makeAttachmentsMock.mockReset();
    availabilityMock.mockReset();
    committedMock.mockReset();
    availabilityMock.mockImplementation((_projectId: string, items: Array<{ itemKey: string; quantity: number }>) => Promise.resolve({
      warehouseVersion: 1, items: items.map(item => ({ itemKey: item.itemKey, requested: item.quantity, available: 10 })),
    }));
    committedMock.mockResolvedValue(false);
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
    expect(screen.getByText('Salvo na nuvem · REQ-2026-0120')).toBeInTheDocument();
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

  it('mostra no item o saldo concorrente e conserva assinatura e quantidade', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollIntoView = vi.fn();
    availabilityMock.mockImplementation((_projectId: string, items: Array<{ itemKey: string; quantity: number }>) => Promise.resolve({
      warehouseVersion: 2, items: items.map(item => ({ itemKey: item.itemKey, requested: item.quantity, available: 2 })),
    }));
    render(<WarehouseRequisitionsTab project={projectWithStock()} onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));
    fireEvent.change(document.getElementById('withdrawal-chapter')!, { target: { value: 'chapter-1' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Quem recebeu' }));
    fireEvent.click(screen.getByText('CANANDA'));
    fireEvent.click(within(screen.getByLabelText('Materiais disponíveis')).getByRole('button'));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Quantidade de Placa de sinalização' }), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assinar teste' }));
    fireEvent.click(screen.getByRole('button', { name: 'Entregar e baixar estoque' }));
    await waitFor(() => expect(screen.getByText(/Faltam 6 UN/)).toBeInTheDocument());
    expect(commitMock).not.toHaveBeenCalled();
    expect(screen.getByRole('spinbutton', { name: 'Quantidade de Placa de sinalização' })).toHaveValue(8);
    expect(screen.getByAltText('Assinatura registrada')).toBeInTheDocument();
  });

  it('identifica o item quando o saldo muda depois da consulta e o servidor rejeita tudo', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollIntoView = vi.fn();
    commitMock.mockRejectedValue(new WarehouseInsufficientStockError([{ itemKey: 'placa', requested: 8, available: 2 }]));
    render(<WarehouseRequisitionsTab project={projectWithStock()} onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));
    fireEvent.change(document.getElementById('withdrawal-chapter')!, { target: { value: 'chapter-1' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Quem recebeu' }));
    fireEvent.click(screen.getByText('CANANDA'));
    fireEvent.click(within(screen.getByLabelText('Materiais disponíveis')).getByRole('button'));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Quantidade de Placa de sinalização' }), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assinar teste' }));
    fireEvent.click(screen.getByRole('button', { name: 'Entregar e baixar estoque' }));
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Faltam 6 UN/)).toBeInTheDocument());
    expect(screen.getByAltText('Assinatura registrada')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'PDF' })).not.toBeInTheDocument();
  });

  it('verifica a chave antes de repetir uma resposta perdida e usa a mesma requisição', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollIntoView = vi.fn();
    commitMock.mockRejectedValueOnce(new Error('Failed to fetch'));
    commitMock.mockImplementationOnce((_before: Project, after: Project) => Promise.resolve({
      project: after, committedAt: '2026-09-12T14:00:00Z', projectUpdatedAt: '2026-09-12T14:00:00Z',
      warehouseUpdatedAt: '2026-09-12T14:00:00Z', warehouseVersion: 3,
      acknowledgement: { requisitionId: after.warehouse!.requisitions[0].id, movementIds: [], auditLogIds: [] },
      dailyReportChanges: [],
    }));
    committedMock.mockResolvedValue(true);
    render(<WarehouseRequisitionsTab project={projectWithStock()} onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));
    fireEvent.change(document.getElementById('withdrawal-chapter')!, { target: { value: 'chapter-1' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Quem recebeu' }));
    fireEvent.click(screen.getByText('CANANDA'));
    fireEvent.click(within(screen.getByLabelText('Materiais disponíveis')).getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Assinar teste' }));
    fireEvent.click(screen.getByRole('button', { name: 'Entregar e baixar estoque' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verificar e concluir tentativa' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Verificar e concluir tentativa' }));
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(2));
    expect(committedMock).toHaveBeenCalledTimes(1);
    expect(committedMock.mock.invocationCallOrder[0]).toBeLessThan(commitMock.mock.invocationCallOrder[1]);
    expect(commitMock.mock.calls[0][2]).toEqual(commitMock.mock.calls[1][2]);
    expect(commitMock.mock.calls[0][1].warehouse.requisitions[0].id).toBe(commitMock.mock.calls[1][1].warehouse.requisitions[0].id);
  });

  it('confirma os oito materiais em uma única tentativa atômica', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollIntoView = vi.fn();
    let project = projectWithStock();
    for (let index = 1; index < 8; index += 1) project = addMovement(project, {
      type: 'entrada', date: '2026-09-12', itemKey: `material-${index}`,
      itemDescription: `Material ${index}`, itemUnit: 'UN', quantity: 10,
    });
    commitMock.mockImplementation((_before: Project, after: Project) => Promise.resolve({
      project: after, committedAt: '2026-09-12T14:00:00Z', projectUpdatedAt: '2026-09-12T14:00:00Z',
      warehouseUpdatedAt: '2026-09-12T14:00:00Z', warehouseVersion: 3,
      acknowledgement: { requisitionId: after.warehouse!.requisitions[0].id, movementIds: [], auditLogIds: [] },
      dailyReportChanges: [],
    }));
    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));
    fireEvent.change(document.getElementById('withdrawal-chapter')!, { target: { value: 'chapter-1' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Quem recebeu' }));
    fireEvent.click(screen.getByText('CANANDA'));
    for (let index = 0; index < 8; index += 1) {
      fireEvent.click(within(screen.getByLabelText('Materiais disponíveis')).getAllByRole('button')[0]);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Assinar teste' }));
    fireEvent.click(screen.getByRole('button', { name: 'Entregar e baixar estoque' }));
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(commitMock.mock.calls[0][1].warehouse.requisitions[0].items).toHaveLength(8);
    expect(availabilityMock).toHaveBeenCalledWith('p', expect.arrayContaining([{ itemKey: 'placa', quantity: 1 }]));
  });

  it('mantém a retirada transacional durante a implantação gradual da consulta antecipada', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollIntoView = vi.fn();
    availabilityMock.mockRejectedValue(new WarehouseAvailabilityUnavailableError());
    commitMock.mockImplementation((_before: Project, after: Project) => Promise.resolve({
      project: after, committedAt: '2026-09-12T14:00:00Z', projectUpdatedAt: '2026-09-12T14:00:00Z',
      warehouseUpdatedAt: '2026-09-12T14:00:00Z', warehouseVersion: 3,
      acknowledgement: { requisitionId: after.warehouse!.requisitions[0].id, movementIds: [], auditLogIds: [] },
      dailyReportChanges: [],
    }));
    render(<WarehouseRequisitionsTab project={projectWithStock()} onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));
    fireEvent.change(document.getElementById('withdrawal-chapter')!, { target: { value: 'chapter-1' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Quem recebeu' }));
    fireEvent.click(screen.getByText('CANANDA'));
    fireEvent.click(within(screen.getByLabelText('Materiais disponíveis')).getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Assinar teste' }));
    fireEvent.click(screen.getByRole('button', { name: 'Entregar e baixar estoque' }));
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
  });

  it('inicia a trava global antes do upload e a libera somente após a confirmação integral', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Element.prototype.scrollIntoView = vi.fn();
    let finishUpload: (() => void) | undefined;
    makeAttachmentsMock.mockImplementation(() => new Promise(resolve => {
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

    await waitFor(() => expect(makeAttachmentsMock).toHaveBeenCalledTimes(1));
    expect(criticalFlowCalls).toBe(1);
    expect(commitMock).not.toHaveBeenCalled();
    expect(criticalFlowFinished).toBe(false);

    await act(async () => finishUpload?.());
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCloudOperationConfirmed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(criticalFlowFinished).toBe(true));
  });
});
