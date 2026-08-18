import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Equipment } from '@/types/project';
import {
  WarehouseActionBar,
  WarehouseEmptyState,
  WarehouseEquipmentThumbnail,
  WarehouseField,
  WarehouseHelp,
  WarehouseStatusBadge,
} from './WarehouseVisual';

const { loadBlobMock } = vi.hoisted(() => ({ loadBlobMock: vi.fn() }));

vi.mock('@/lib/warehouseAttachments', () => ({
  loadWarehouseAttachmentBlob: loadBlobMock,
}));

describe('padrão visual do almoxarifado', () => {
  beforeEach(() => {
    loadBlobMock.mockReset();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:thumbnail') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  it('mostra ajuda por clique e identifica campos opcionais e inválidos', () => {
    render(<>
      <WarehouseHelp text="Orientação completa" />
      <WarehouseField label="Observação" optional error="Revise este campo"><input aria-label="Observação" /></WarehouseField>
    </>);

    fireEvent.click(screen.getByRole('button', { name: 'Ver ajuda' }));
    expect(screen.getByText('Orientação completa')).toBeInTheDocument();
    expect(screen.getByText('Opcional')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Observação' })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Revise este campo');
  });

  it('combina texto e ícone nos status e mantém a barra de ação identificável', () => {
    render(<>
      <WarehouseStatusBadge label="Disponível" tone="success" />
      <WarehouseEmptyState message="Nenhum equipamento escolhido" hint="Toque em + para adicionar" />
      <WarehouseActionBar><button>Cancelar</button><button>Confirmar</button></WarehouseActionBar>
    </>);

    expect(screen.getByText('Disponível')).toBeInTheDocument();
    expect(screen.getByText('Nenhum equipamento escolhido')).toBeInTheDocument();
    expect(screen.getByTestId('warehouse-action-bar')).toContainElement(screen.getByRole('button', { name: 'Confirmar' }));
  });

  it('usa data URL imediatamente e carrega a primeira foto armazenada', async () => {
    const inline: Equipment = { id: 'inline', name: 'Furadeira', status: 'disponivel', createdAt: '2026-08-18', photos: [{ id: 'p1', name: 'foto.jpg', mimeType: 'image/jpeg', uploadedAt: '2026-08-18', dataUrl: 'data:image/png;base64,AA==' }] };
    const stored: Equipment = { id: 'stored', name: 'Parafusadeira', status: 'disponivel', createdAt: '2026-08-18', photos: [{ id: 'p2', name: 'foto.jpg', mimeType: 'image/jpeg', uploadedAt: '2026-08-18', storagePath: 'equipments/foto.jpg' }] };
    loadBlobMock.mockResolvedValue(new Blob(['foto'], { type: 'image/jpeg' }));

    const { rerender } = render(<WarehouseEquipmentThumbnail equipment={inline} />);
    expect(screen.getByRole('img', { name: 'Foto de Furadeira' })).toHaveAttribute('src', inline.photos![0].dataUrl);

    rerender(<WarehouseEquipmentThumbnail equipment={stored} />);
    await waitFor(() => expect(screen.getByRole('img', { name: 'Foto de Parafusadeira' })).toHaveAttribute('src', 'blob:thumbnail'));
    expect(loadBlobMock).toHaveBeenCalledWith(stored.photos![0]);
  });

  it('mostra ícone quando não existe foto ou quando o carregamento falha', async () => {
    const withoutPhoto: Equipment = { id: 'empty', name: 'Serra', status: 'disponivel', createdAt: '2026-08-18' };
    const broken: Equipment = { id: 'broken', name: 'Esmerilhadeira', status: 'disponivel', createdAt: '2026-08-18', photos: [{ id: 'p3', name: 'foto.jpg', mimeType: 'image/jpeg', uploadedAt: '2026-08-18', storagePath: 'missing.jpg' }] };
    loadBlobMock.mockRejectedValue(new Error('indisponível'));

    const { rerender } = render(<WarehouseEquipmentThumbnail equipment={withoutPhoto} />);
    expect(screen.getByLabelText('Equipamento sem foto')).toBeInTheDocument();

    rerender(<WarehouseEquipmentThumbnail equipment={broken} />);
    await waitFor(() => expect(screen.getByLabelText('Foto indisponível')).toBeInTheDocument());
  });
});
