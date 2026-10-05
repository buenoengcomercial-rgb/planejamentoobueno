import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlanTakeoff from './PlanTakeoff';
import { readTakeoffs, saveTakeoffs, type TakeoffPlan } from '@/lib/planTakeoff';
import { projectCollectionsForView } from '@/lib/projectDataScope';
import { canAccessAppView } from '@/lib/organizations';
vi.mock('@/lib/planTakeoff', async importOriginal => ({ ...await importOriginal<object>(), readTakeoffs: vi.fn(), saveTakeoffs: vi.fn() }));
vi.mock('./PlanCanvas', () => ({ default: forwardRef<HTMLButtonElement, { onPoint: (p: { x: number; y: number }) => void; plan: TakeoffPlan }>(function MockCanvas({ onPoint, plan }, ref) { return <><button ref={ref} onClick={() => onPoint({ x: 1, y: 1 })}>Ponto de teste</button><span data-testid="visible-measures">{plan.measures.map(measure => measure.id).join(',')}</span></>; }) }));
const example: TakeoffPlan = { id: 'p', name: 'Planta', floor: 'Térreo', chapterId: 'building-1', building: 'Prédio principal', file: new Blob(), kind: 'image', scales: {}, measures: [] };
beforeEach(() => { vi.mocked(readTakeoffs).mockResolvedValue([example]); vi.mocked(saveTakeoffs).mockReset().mockResolvedValue(); });
describe('teste independente de levantamento', () => {
  it('retira o comando antigo de uso no detalhe da tabela independente', async () => {
    vi.mocked(readTakeoffs).mockResolvedValueOnce([{ ...example, measures: [{ id: 'placas', name: 'Placas executadas', kind: 'count', page: 1, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }] }]);
    render(<PlanTakeoff storageKey="user/project" readOnly={false} />);
    await screen.findByText('2 un');
    expect(screen.queryByRole('button', { name: 'Usar no detalhe' })).not.toBeInTheDocument();
  });
  it('no modal da Produção conclui a contagem direto na célula e oculta a tabela inferior', async () => {
    const onUseMeasure = vi.fn().mockReturnValue(true);
    render(<PlanTakeoff storageKey="user/project" readOnly={false} embedded chapterId="building-1" measureContext={{ taskId: 'task-1', logId: 'day-1' }} allowedKinds={['count']} onUseMeasure={onUseMeasure} />);
    await screen.findByRole('button', { name: 'Contagem' });
    expect(screen.queryByRole('region', { name: 'Detalhe dos levantamentos' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Adicionar planta')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comprimento' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Contagem' }));
    fireEvent.click(screen.getByText('Ponto de teste'));
    fireEvent.click(screen.getByText('Ponto de teste'));
    fireEvent.click(screen.getByText('Ponto de teste'));
    fireEvent.click(screen.getByRole('button', { name: 'Concluir traçado' }));
    await waitFor(() => expect(onUseMeasure).toHaveBeenCalledWith(expect.objectContaining({ id: 'p' }), expect.objectContaining({ kind: 'count', points: [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }] }), 3));
    expect(saveTakeoffs).toHaveBeenCalledWith('user/project', expect.arrayContaining([expect.objectContaining({ measures: [expect.objectContaining({ kind: 'count', taskId: 'task-1', logId: 'day-1' })] })]));
  });
  it('permite reutilizar uma contagem já salva sem reabrir a tabela inferior', async () => {
    const onUseMeasure = vi.fn().mockReturnValue(true);
    vi.mocked(readTakeoffs).mockResolvedValueOnce([{ ...example, measures: [{ id: 'placas', name: 'Placas executadas', kind: 'count', page: 1, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }] }] }]);
    render(<PlanTakeoff storageKey="user/project" readOnly={false} embedded chapterId="building-1" measureContext={{ taskId: 'task-1', logId: 'day-1' }} focusMeasure={{ planId: 'p', page: 1, measureId: 'placas' }} onUseMeasure={onUseMeasure} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Usar marcação selecionada' }));
    await waitFor(() => expect(onUseMeasure).toHaveBeenCalledWith(expect.objectContaining({ id: 'p' }), expect.objectContaining({ id: 'placas', taskId: 'task-1', logId: 'day-1' }), 3));
    expect(saveTakeoffs).toHaveBeenCalledWith('user/project', expect.arrayContaining([expect.objectContaining({ measures: [expect.objectContaining({ id: 'placas', taskId: 'task-1', logId: 'day-1' })] })]));
    expect(screen.queryByRole('region', { name: 'Detalhe dos levantamentos' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Excluir marcação selecionada' })).toBeInTheDocument();
  });
  it('abre a mesma planta em tarefas diferentes sem mostrar os pontos da outra tarefa', async () => {
    let saved = [example];
    vi.mocked(readTakeoffs).mockImplementation(async () => saved);
    vi.mocked(saveTakeoffs).mockImplementation(async (_key, plans) => { saved = plans; });
    const first = render(<PlanTakeoff storageKey="obra" readOnly={false} embedded chapterId="building-1" measureContext={{ taskId: 'tarefa-a', logId: 'dia-1' }} onUseMeasure={vi.fn().mockReturnValue(true)} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Contagem' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Contagem' }));
    fireEvent.click(screen.getByText('Ponto de teste'));
    fireEvent.click(screen.getByRole('button', { name: 'Concluir traçado' }));
    await waitFor(() => expect(saved[0].measures).toHaveLength(1));
    first.unmount();
    render(<PlanTakeoff storageKey="obra" readOnly={false} embedded chapterId="building-1" measureContext={{ taskId: 'tarefa-b', logId: 'dia-1' }} onUseMeasure={vi.fn().mockReturnValue(true)} />);
    await screen.findByRole('button', { name: 'Contagem' });
    expect(screen.getByTestId('visible-measures')).toBeEmptyDOMElement();
    expect(screen.getByRole('combobox', { name: 'Planta' })).toHaveValue('p');
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
