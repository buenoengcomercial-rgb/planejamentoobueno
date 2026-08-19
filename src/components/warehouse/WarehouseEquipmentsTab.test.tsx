import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { emptyWarehouse } from '@/lib/warehouse';
import WarehouseEquipmentsTab from './WarehouseEquipmentsTab';

const { invokeMock, uploadMock, downloadMock, openMock, replaceMock, closeMock, successMock, warningMock, optimizePhotoMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  uploadMock: vi.fn(),
  downloadMock: vi.fn(),
  openMock: vi.fn(),
  replaceMock: vi.fn(),
  closeMock: vi.fn(),
  successMock: vi.fn(),
  warningMock: vi.fn(),
  optimizePhotoMock: vi.fn(),
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

vi.mock('@/lib/equipmentPhotoOptimization', () => ({
  optimizeEquipmentPhoto: optimizePhotoMock,
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

type EquipmentPhotoInput = { dataUrl?: string; storagePath?: string; name?: string };

function projectWithEquipment(photoInput: EquipmentPhotoInput | EquipmentPhotoInput[] = { storagePath: 'project-equipment/warehouse/equipment/furadeira.jpg' }): Project {
  const current = project();
  const photos = (Array.isArray(photoInput) ? photoInput : [photoInput]).map((photo, index) => ({
    id: `photo-${index + 1}`,
    name: photo.name || `furadeira-${index + 1}.jpg`,
    mimeType: 'image/jpeg',
    uploadedAt: '2026-08-18T10:00:00.000Z',
    ...photo,
  }));
  current.warehouse!.equipments = [{
    id: 'equipment-1', name: 'Furadeira Makita', description: 'Furadeira de impacto', internalCode: 'EQ-2026-0001',
    brand: 'Makita', model: 'HP002G', serial: '0029612 Y', status: 'disponivel', createdAt: '2026-08-18T10:00:00.000Z',
    photos,
  }];
  return current;
}

async function addPhotoAndRead() {
  fireEvent.click(screen.getByRole('button', { name: 'Adicionar equipamento' }));
  const file = new File(['foto da bateria'], 'makita.jpeg', { type: 'image/jpeg' });
  const cameraInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(cameraInput, { target: { files: [file] } });
  const readButton = screen.getByRole('button', { name: /Ler etiqueta e equipamento com IA/i });
  await waitFor(() => expect(readButton).toBeEnabled());
  fireEvent.click(readButton);
}

describe('WarehouseEquipmentsTab - leitura por IA', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    uploadMock.mockReset().mockResolvedValue({ error: null });
    downloadMock.mockReset().mockResolvedValue({ data: new Blob(['foto'], { type: 'image/jpeg' }), error: null });
    successMock.mockReset();
    warningMock.mockReset();
    optimizePhotoMock.mockReset().mockImplementation(async (file: File) => file);
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

    await addPhotoAndRead();

    expect(await screen.findByDisplayValue('Makita')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Bateria de íons de lítio XGT 40Vmax 4,0 Ah')).toBeInTheDocument();
    expect(screen.getByLabelText('Modelo')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Bateria Makita XGT 40Vmax 4,0 Ah' } });
    fireEvent.click(screen.getByRole('button', { name: /Cadastrar equipamento/i }));

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

    await addPhotoAndRead();

    await waitFor(() => expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('não foi implantado')));
    expect(screen.getByLabelText('Descrição')).toBeEnabled();
    expect(screen.getByRole('button', { name: /Cadastrar equipamento/i })).toBeEnabled();
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

  it('mantém a galeria compacta e responsiva em até quatro colunas', () => {
    render(<WarehouseEquipmentsTab project={projectWithEquipment({ dataUrl: 'data:image/png;base64,Zm90bw==' })} onProjectChange={vi.fn()} />);

    expect(screen.getByTestId('equipment-gallery')).toHaveClass('grid-cols-1', 'sm:grid-cols-2', 'lg:grid-cols-3', 'xl:grid-cols-4');
    expect(screen.getByRole('button', { name: 'Abrir foto 1 de 1 de Furadeira de impacto' })).toHaveClass('h-28', 'sm:h-32');
    expect(screen.getByRole('img', { name: 'Furadeira de impacto' })).toHaveAttribute('loading', 'lazy');
    expect(screen.getByRole('img', { name: 'Furadeira de impacto' })).toHaveAttribute('decoding', 'async');
    expect(screen.getByRole('img', { name: 'Furadeira de impacto' })).toHaveClass('object-contain');
    expect(screen.queryByLabelText('Fotos de Furadeira de impacto')).not.toBeInTheDocument();
  });

  it('não oferece arquivamento de equipamento quando a função não pode apagar registros', () => {
    render(
      <WarehouseEquipmentsTab
        project={projectWithEquipment({ dataUrl: 'data:image/png;base64,Zm90bw==' })}
        onProjectChange={vi.fn()}
        canArchive={false}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Arquivar' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Etiqueta QR' })).toBeInTheDocument();
  });

  it('mostra até três miniaturas e troca a foto principal sem recortar', () => {
    render(<WarehouseEquipmentsTab project={projectWithEquipment([
      { dataUrl: 'data:image/png;base64,Zm90bzE=' },
      { dataUrl: 'data:image/png;base64,Zm90bzI=' },
      { dataUrl: 'data:image/png;base64,Zm90bzM=' },
    ])} onProjectChange={vi.fn()} />);

    expect(screen.getByLabelText('Fotos de Furadeira de impacto')).toBeInTheDocument();
    expect(screen.getByText('1 de 3')).toBeInTheDocument();
    const secondThumbnail = screen.getByRole('button', { name: 'Selecionar foto 2 de 3 de Furadeira de impacto' });
    fireEvent.click(secondThumbnail);

    expect(secondThumbnail).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('2 de 3')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Furadeira de impacto' })).toHaveAttribute('src', 'data:image/png;base64,Zm90bzI=');
    expect(screen.getAllByRole('img')).toHaveLength(4);
    screen.getAllByRole('img').forEach(image => expect(image).toHaveClass('object-contain'));
  });

  it('usa a mesma foto otimizada na IA e no armazenamento', async () => {
    const optimized = new File(['foto otimizada'], 'makita.jpg', { type: 'image/jpeg' });
    optimizePhotoMock.mockResolvedValueOnce(optimized);
    invokeMock.mockResolvedValue({
      data: { ok: true, equipment: { description: 'Bateria Makita', serial: 'A00724' } },
      error: null,
    });
    const view = render(<WarehouseEquipmentsTab project={project()} onProjectChange={vi.fn()} />);

    await addPhotoAndRead();
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(invokeMock.mock.calls[0][1].body.imageDataUrls[0]).toBe(`data:image/jpeg;base64,${btoa('foto otimizada')}`);

    fireEvent.click(screen.getByRole('button', { name: /Cadastrar equipamento/i }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    expect(uploadMock.mock.calls[0][1]).toBe(optimized);
    expect(screen.queryByRole('dialog', { name: 'Cadastrar novo equipamento' })).not.toBeInTheDocument();
  });

  it('abre a foto original ao tocar na miniatura', async () => {
    render(<WarehouseEquipmentsTab project={projectWithEquipment()} onProjectChange={vi.fn()} />);
    await screen.findByRole('img', { name: 'Furadeira de impacto' });

    fireEvent.click(screen.getByRole('button', { name: 'Abrir foto 1 de 1 de Furadeira de impacto' }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('blob:equipment'));
    expect(openMock).toHaveBeenCalledWith('about:blank', '_blank');
    expect(downloadMock).toHaveBeenCalledTimes(2);
  });

  it('abre a foto selecionada e mantém as demais utilizáveis quando uma falha', async () => {
    downloadMock.mockImplementation(async (path: string) => path.endsWith('foto-2.jpg')
      ? { data: null, error: { statusCode: 404, message: 'Not found' } }
      : { data: new Blob([path], { type: 'image/jpeg' }), error: null });
    render(<WarehouseEquipmentsTab project={projectWithEquipment([
      { storagePath: 'project-equipment/warehouse/equipment/foto-1.jpg' },
      { storagePath: 'project-equipment/warehouse/equipment/foto-2.jpg' },
      { storagePath: 'project-equipment/warehouse/equipment/foto-3.jpg' },
    ])} onProjectChange={vi.fn()} />);

    await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(3));
    expect(screen.getByText('Erro')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar foto 3 de 3 de Furadeira de impacto' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abrir foto 3 de 3 de Furadeira de impacto' }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('blob:equipment'));
    expect(downloadMock).toHaveBeenLastCalledWith('project-equipment/warehouse/equipment/foto-3.jpg');
  });

  it('mantém somente o cadastro patrimonial sem controles de cautela', () => {
    render(<WarehouseEquipmentsTab project={project()} onProjectChange={vi.fn()} />);

    expect(screen.getByText('Patrimônio identificado')).toBeInTheDocument();
    expect(screen.queryByText('Termos de cautela')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Novo termo/i })).not.toBeInTheDocument();
  });

  it('abre mostrando somente a galeria e revela o cadastro apenas por solicitação', () => {
    render(<WarehouseEquipmentsTab project={projectWithEquipment({ dataUrl: 'data:image/png;base64,Zm90bw==' })} onProjectChange={vi.fn()} />);

    expect(screen.getByTestId('equipment-gallery')).toBeInTheDocument();
    expect(screen.queryByLabelText('Descrição')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar equipamento' }));

    const dialog = screen.getByRole('dialog', { name: 'Cadastrar novo equipamento' });
    expect(dialog).toHaveClass('max-h-[95dvh]', 'w-[calc(100vw-1rem)]', 'overflow-hidden');
    expect(dialog.querySelector('.overflow-y-auto')).not.toBeNull();
    expect(screen.getByLabelText('Descrição')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveClass('min-h-11');
    expect(screen.getByRole('button', { name: 'Cadastrar equipamento' })).toHaveClass('min-h-11');
  });

  it('fecha um cadastro vazio e confirma antes de descartar dados preenchidos', () => {
    render(<WarehouseEquipmentsTab project={project()} onProjectChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar equipamento' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog', { name: 'Cadastrar novo equipamento' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar equipamento' }));
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Furadeira nova' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByText('Descartar cadastro do equipamento?')).toBeInTheDocument();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Descartar cadastro' }));
    expect(screen.queryByRole('dialog', { name: 'Cadastrar novo equipamento' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar equipamento' }));
    expect(screen.getByLabelText('Descrição')).toHaveValue('');
  });
});
