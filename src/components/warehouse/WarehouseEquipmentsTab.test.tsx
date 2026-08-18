import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { emptyWarehouse } from '@/lib/warehouse';
import WarehouseEquipmentsTab from './WarehouseEquipmentsTab';

const { invokeMock, uploadMock, successMock, warningMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  uploadMock: vi.fn(),
  successMock: vi.fn(),
  warningMock: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: { invoke: invokeMock },
    storage: { from: () => ({ upload: uploadMock }) },
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
    successMock.mockReset();
    warningMock.mockReset();
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
});
