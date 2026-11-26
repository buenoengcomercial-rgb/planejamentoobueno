import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Equipment } from '@/types/project';
import WarehouseEquipmentPhoto from './WarehouseEquipmentPhoto';

it('amplia todas as fotos e mantém a identificação do patrimônio', () => {
  const equipment: Equipment = {
    id: 'drill', name: 'Furadeira', internalCode: 'EQ-1', patrimony: 'PAT-1', createdAt: '2026-11-25',
    photos: ['primeira', 'segunda'].map(id => ({ id, name: `${id}.png`, uploadedAt: '2026-11-25', dataUrl: `data:image/png;base64,${id}` })),
  };
  render(<WarehouseEquipmentPhoto equipment={equipment} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto de Furadeira' }));
  const dialog = screen.getByRole('dialog', { name: 'Foto do equipamento' });
  expect(dialog).toHaveTextContent('EQ-1 · Furadeira · Patrimônio PAT-1');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Ver foto 2 de Furadeira' }));
  expect(within(dialog).getByRole('button', { name: 'Ver foto 2 de Furadeira' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(dialog).getAllByRole('img')[0]).toHaveAttribute('src', equipment.photos![1].dataUrl);
});

it('identifica equipamento sem foto e não oferece ampliação vazia', () => {
  render(<WarehouseEquipmentPhoto equipment={{ id: 'legacy', name: 'Serra antiga', createdAt: '2026-11-25' }} />);
  expect(screen.getByRole('button', { name: 'Ampliar foto de Serra antiga' })).toBeDisabled();
  expect(screen.getByText('Sem foto cadastrada')).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
