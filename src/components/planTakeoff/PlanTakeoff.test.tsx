import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlanTakeoff from './PlanTakeoff';
import { readTakeoffs, saveTakeoffs, type TakeoffPlan } from '@/lib/planTakeoff';
import { projectCollectionsForView } from '@/lib/projectDataScope';
import { canAccessAppView } from '@/lib/organizations';
vi.mock('@/lib/planTakeoff', async importOriginal => ({ ...await importOriginal<object>(), readTakeoffs: vi.fn(), saveTakeoffs: vi.fn() }));
vi.mock('./PlanCanvas', () => ({ default: forwardRef<HTMLButtonElement, { onPoint: (p: { x: number; y: number }) => void }>(function MockCanvas({ onPoint }, ref) { return <button ref={ref} onClick={() => onPoint({ x: 1, y: 1 })}>Ponto de teste</button>; }) }));
const example: TakeoffPlan = { id: 'p', name: 'Planta', floor: 'Térreo', file: new Blob(), kind: 'image', scales: {}, measures: [] };
beforeEach(() => { vi.mocked(readTakeoffs).mockResolvedValue([example]); vi.mocked(saveTakeoffs).mockReset().mockResolvedValue(); });
describe('teste independente de levantamento', () => {
  it('entrega ao detalhe o grupo de pontos concluído e o resultado calculado', async () => {
    const onUseMeasure = vi.fn();
    vi.mocked(readTakeoffs).mockResolvedValueOnce([{ ...example, measures: [{ id: 'placas', name: 'Placas executadas', kind: 'count', page: 1, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }] }]);
    render(<PlanTakeoff storageKey="user/project" readOnly={false} onUseMeasure={onUseMeasure} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Usar no detalhe' }));
    expect(onUseMeasure).toHaveBeenCalledWith(expect.objectContaining({ id: 'p' }), expect.objectContaining({ id: 'placas', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }), 2);
  });
  it('não carrega coleções operacionais e respeita os perfis restritos', () => {
    expect(projectCollectionsForView('planTakeoff')).toEqual([]);
    expect(canAccessAppView('field_user', 'planTakeoff')).toBe(false);
    expect(canAccessAppView('warehouse_operator', 'planTakeoff')).toBe(false);
    expect(canAccessAppView('engineer', 'planTakeoff')).toBe(true);
  });
  it('exige escala para dimensões mas permite contagem', async () => {
    render(<PlanTakeoff storageKey="user/project" readOnly={false} />);
    await screen.findByText('Nenhum levantamento nesta planta.');
    expect(screen.getByRole('button', { name: 'Comprimento' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Área' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Contagem' }));
    fireEvent.click(screen.getByText('Ponto de teste'));
    fireEvent.click(screen.getByRole('button', { name: 'Concluir traçado' }));
    await screen.findByText('1 un');
    expect(saveTakeoffs).toHaveBeenCalledWith('user/project', expect.arrayContaining([expect.objectContaining({ measures: [expect.objectContaining({ kind: 'count', points: [{ x: 1, y: 1 }] })] })]));
    fireEvent.click(screen.getByText('Desfazer'));
    await screen.findByText('Nenhum levantamento nesta planta.');
  });
  it('preserva o traçado quando falha o salvamento e permite nova tentativa', async () => {
    vi.mocked(saveTakeoffs).mockRejectedValueOnce(new Error('quota'));
    render(<PlanTakeoff storageKey="failure" readOnly={false} />);
    await screen.findByText('Nenhum levantamento nesta planta.');
    fireEvent.click(screen.getByRole('button', { name: 'Contagem' }));
    fireEvent.click(screen.getByText('Ponto de teste'));
    fireEvent.click(screen.getByRole('button', { name: 'Concluir traçado' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Concluir traçado' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Concluir traçado' }));
    await screen.findByText('1 un');
  });
  it('visualizador não grava nem importa', async () => {
    render(<PlanTakeoff storageKey="viewer" readOnly />);
    await screen.findByText('Nenhum levantamento nesta planta.');
    expect(screen.getByLabelText('Adicionar planta')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Contagem' })).toBeDisabled();
    await waitFor(() => expect(saveTakeoffs).not.toHaveBeenCalled());
  });
});
