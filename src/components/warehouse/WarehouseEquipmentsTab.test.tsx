import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { emptyWarehouse } from '@/lib/warehouse';
import WarehouseEquipmentsTab from './WarehouseEquipmentsTab';

const { invokeMock, uploadMock, downloadMock, openMock, replaceMock, closeMock, successMock, warningMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  uploadMock: vi.fn(),
  downloadMock: vi.fn(),
  openMock: vi.fn(),
  replaceMock: vi.fn(),
  closeMock: vi.fn(),
  successMock: vi.fn(),
  warningMock: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: { invoke: invokeMock },
    storage: { from: () => ({ upload: uploadMock, download: downloadMock }) },
  },
}));

vi.mock('sonner', () => ({
  toast: { success: successMock, warning: warningMock, error: vi.fn() },
}));

function project(): Project {
  return {
    id: 'project-equipment',
    name: 'Obra teste',
    startDate: '2026-08-01',
    endDate: '2026-12-31',
    totalBudget: 0,
    phases: [],
    warehouse: emptyWarehouse(),
  };
}

function projectWithEquipment(photo: { dataUrl?: string; storagePath?: string } = { storagePath: 'project-equipment/warehouse/equipment/furadeira.jpg' }): Project {
  const current = project();
  current.warehouse!.equipments = [{
    id: 'equipment-1', name: 'Furadeira Makita', description: 'Furadeira de impacto', internalCode: 'EQ-2026-0001',
    brand: 'Makita', model: 'HP002G', serial: '0029612 Y', status: 'disponivel', createdAt: '2026-08-18T10:00:00.000Z',
    photos: [{ id: 'photo-1', name: 'furadeira.jpg', mimeType: 'image/jpeg', uploadedAt: '2026-08-18T10:00:00.000Z', ...photo }],
  }];
  return current;
}

async function addPhotoAndRead(container: HTMLElement) {
  const file = new File(['foto da bateria'], 'makita.jpeg', { type: 'image/jpeg' });
  const cameraInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(cameraInput, { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: /Ler etiqueta e equipamento com IA/i }));
}

describe('WarehouseEquipmentsTab - leitura por IA', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    uploadMock.mockReset().mockResolvedValue({ error: null });
    downloadMock.mockReset().mockResolvedValue({ data: new Blob(['foto'], { type: 'image/jpeg' }), error: null });
    successMock.mockReset();
    warningMock.mockReset();
    replaceMock.mockReset();
    closeMock.mockReset();
    openMock.mockReset().mockReturnValue({ opener: null, location: { replace: replaceMock }, close: closeMock });
    Object.defineProperty(window, 'open', { configurable: true, value: openMock });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:equipment') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  it('preenche somente os dados sugeridos e permite revisão antes do cadastro', async () => {
    invokeMock.mockResolvedValue({
      data: {
        ok: true,
        equipment: {
          brand: 'Makita',
          description: 'Bateria de íons de lítio XGT 40Vmax 4,0 Ah',
          category: 'Bateria para ferramenta elétrica',
          serial: 'A00724',
          confidence: { brand: 0.99, description: 0.96, category: 0.88, serial: 0.72 },
        },
      },
      error: null,
    });
    const onProjectChange = vi.fn();
    const view = render(<WarehouseEquipmentsTab project={project()} onProjectChange={onProjectChange} />);

    await addPhotoAndRead(view.container);

    expect(await screen.findByDisplayValue('Makita')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Bateria de íons de lítio XGT 40Vmax 4,0 Ah')).toBeInTheDocument();
    expect(screen.getByLabelText('Modelo')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Bateria Makita XGT 40Vmax 4,0 Ah' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirmar cadastro/i }));

    await waitFor(() => expect(onProjectChange).toHaveBeenCalledTimes(1));
    const saved = onProjectChange.mock.calls[0][0] as Project;
    expect(saved.warehouse!.equipments[0]).toMatchObject({
      brand: 'Makita',
      model: undefined,
      serial: 'A00724',
      description: 'Bateria Makita XGT 40Vmax 4,0 Ah',
    });
  });

  it('explica a indisponibilidade da função e mantém o formulário utilizável', async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('Failed to send a request to the Edge Function'), { name: 'FunctionsFetchError' }),
    });
    const view = render(<WarehouseEquipmentsTab project={project()} onProjectChange={vi.fn()} />);

    await addPhotoAndRead(view.container);

    await waitFor(() => expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('não foi implantado')));
    expect(screen.getByLabelText('Descrição')).toBeEnabled();
    expect(screen.getByRole('button', { name: /Confirmar cadastro/i })).toBeEnabled();
  });

  it('carrega a primeira foto do Storage como miniatura e libera a URL temporária', async () => {
    const view = render(<WarehouseEquipmentsTab project={projectWithEquipment()} onProjectChange={vi.fn()} />);

    const image = await screen.findByRole('img', { name: 'Furadeira de impacto' });
    expect(image).toHaveAttribute('src', 'blob:equipment');
    expect(downloadMock).toHaveBeenCalledWith('project-equipment/warehouse/equipment/furadeira.jpg');

    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:equipment');
  });

  it('exibe foto legada em dataUrl sem consultar o Storage', async () => {
    render(<WarehouseEquipmentsTab project={projectWithEquipment({ dataUrl: 'data:image/png;base64,Zm90bw==' })} onProjectChange={vi.fn()} />);

    expect(await screen.findByRole('img', { name: 'Furadeira de impacto' })).toHaveAttribute('src', 'data:image/png;base64,Zm90bw==');
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('mostra indisponibilidade quando a miniatura não pode ser carregada', async () => {
    downloadMock.mockResolvedValueOnce({ data: null, error: { statusCode: 403, message: 'Forbidden' } });
    render(<WarehouseEquipmentsTab project={projectWithEquipment()} onProjectChange={vi.fn()} />);

    expect(await screen.findByText('Foto indisponível')).toBeInTheDocument();
  });

  it('mantém a galeria responsiva em uma, duas e três colunas', () => {
    render(<WarehouseEquipmentsTab project={projectWithEquipment({ dataUrl: 'data:image/png;base64,Zm90bw==' })} onProjectChange={vi.fn()} />);

    expect(screen.getByTestId('equipment-gallery')).toHaveClass('grid-cols-1', 'md:grid-cols-2', 'lg:grid-cols-3');
    expect(screen.getByRole('button', { name: 'Abrir foto de Furadeira de impacto' })).toBeInTheDocument();
  });

  it('abre a foto original ao tocar na miniatura', async () => {
    render(<WarehouseEquipmentsTab project={projectWithEquipment()} onProjectChange={vi.fn()} />);
    await screen.findByRole('img', { name: 'Furadeira de impacto' });

    fireEvent.click(screen.getByRole('button', { name: 'Abrir foto de Furadeira de impacto' }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('blob:equipment'));
    expect(openMock).toHaveBeenCalledWith('about:blank', '_blank');
    expect(downloadMock).toHaveBeenCalledTimes(2);
  });
});
