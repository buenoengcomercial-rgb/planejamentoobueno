import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlanTakeoff from './PlanTakeoff';
import { readTakeoffs, saveTakeoffs, type TakeoffPlan, type MeasureKind } from '@/lib/planTakeoff';
import type { CaptureKind } from '@/lib/dxfSnap';

vi.mock('@/lib/planTakeoff', async original => ({ ...await original<object>(), readTakeoffs: vi.fn(), saveTakeoffs: vi.fn() }));
vi.mock('./PlanCanvas', () => ({ default: forwardRef(function Canvas({ onReady, onCaptureAvailable, onPoint, plan }: { onReady?: (ready: boolean) => void; onCaptureAvailable?: (kinds: CaptureKind[]) => void; onPoint: (p: { x: number; y: number }) => void; plan: TakeoffPlan }, _ref) {
  useEffect(() => { onReady?.(true); onCaptureAvailable?.(['endpoint', 'nearest']); }, [onReady, onCaptureAvailable]);
  return <><span>{plan.name}</span><button onClick={() => onPoint({ x: 1, y: 1 })}>Primeiro ponto</button><button onClick={() => onPoint({ x: 4, y: 5 })}>Segundo ponto</button><button onClick={() => onPoint({ x: 1, y: 5 })}>Terceiro ponto</button></>;
}) }));
const plan: TakeoffPlan = { id: 'p', name: 'PPCI', floor: 'Térreo', chapterId: 'c', file: new Blob(), kind: 'dxf', scales: { 1: 1 }, measures: [] };
beforeEach(() => { localStorage.clear(); vi.mocked(readTakeoffs).mockResolvedValue([plan]); vi.mocked(saveTakeoffs).mockReset().mockResolvedValue(); });
const props = { storageKey: 'usuario/obra', readOnly: false, embedded: true, chapterId: 'c', measureContext: { taskId: 't', logId: 'l' } };
async function openCaptures() { fireEvent.click(await screen.findByRole('button', { name: 'Capturas para máscaras' })); await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Ativar capturas' })).toBeEnabled()); }

describe('preferências persistentes do ímã', () => {
  it('restaura ativação e tipos ao reabrir outra célula, sem gravar quantitativos', async () => {
    const view = render(<PlanTakeoff {...props} />);
    await openCaptures();
    for (const name of ['Ativar capturas', 'Ativar rastreamento', 'Extremo', 'Ponto mais próximo']) fireEvent.click(screen.getByRole('checkbox', { name }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    view.unmount();
    render(<PlanTakeoff {...props} destinationColumn="B" measureContext={{ taskId: 'other', logId: 'second' }} />);
    await openCaptures();
    for (const name of ['Ativar capturas', 'Ativar rastreamento', 'Extremo', 'Ponto mais próximo']) expect(screen.getByRole('checkbox', { name })).toBeChecked();
    expect(saveTakeoffs).not.toHaveBeenCalled();
    expect(screen.queryByText('Experimental')).not.toBeInTheDocument();
  });
  it('cancelar descarta mudanças, e desativação confirmada permanece após reabrir', async () => {
    const view = render(<PlanTakeoff {...props} />);
    await openCaptures(); fireEvent.click(screen.getByRole('checkbox', { name: 'Ativar capturas' })); fireEvent.click(screen.getByRole('checkbox', { name: 'Extremo' })); fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await openCaptures(); fireEvent.click(screen.getByRole('button', { name: 'Desmarcar todas' })); fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await openCaptures(); expect(screen.getByRole('checkbox', { name: 'Extremo' })).toBeChecked(); fireEvent.click(screen.getByRole('checkbox', { name: 'Ativar capturas' })); fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    view.unmount(); render(<PlanTakeoff {...props} />); await openCaptures();
    expect(screen.getByRole('checkbox', { name: 'Ativar capturas' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Extremo' })).toBeChecked();
  });
  it('não reaproveita preferências em outra obra', async () => {
    const view = render(<PlanTakeoff {...props} />); await openCaptures(); fireEvent.click(screen.getByRole('checkbox', { name: 'Ativar capturas' })); fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    view.unmount(); render(<PlanTakeoff {...props} storageKey="usuario/outra-obra" />); await openCaptures(); expect(screen.getByRole('checkbox', { name: 'Ativar capturas' })).not.toBeChecked();
  });
});

describe('ferramentas de quantitativo pela mesma transação', () => {
  it.each<[string, MeasureKind, number, number]>([
    ['Contagem', 'count', 2, 2], ['Comprimento linear', 'linearLength', 2, 5], ['Comprimento poligonal', 'length', 2, 5],
    ['Perímetro circular', 'circlePerimeter', 2, 10 * Math.PI], ['Superfície retangular', 'rectangleArea', 2, 12],
    ['Superfície poligonal', 'area', 3, 6], ['Superfície circular', 'circleArea', 2, 25 * Math.PI],
    ['Superfície vertical', 'verticalArea', 2, 15], ['Volume de planta poligonal', 'polygonVolume', 3, 18],
  ])('%s confirma geometria e resultado na célula', async (name, kind, points, result) => {
    const use = vi.fn().mockResolvedValue(true);
    const save = vi.fn();
    render(<PlanTakeoff {...props} repository={{ storage: 'cloud', load: async () => [plan], save }} onUseMeasure={use} />);
    await waitFor(() => expect(screen.getByRole('button', { name })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name })); fireEvent.click(screen.getByRole('button', { name: 'Primeiro ponto' })); fireEvent.click(screen.getByRole('button', { name: 'Segundo ponto' }));
    if (points === 3) fireEvent.click(screen.getByRole('button', { name: 'Terceiro ponto' }));
    if (screen.getByRole('button', { name: 'Concluir traçado' }).hasAttribute('disabled') === false) fireEvent.click(screen.getByRole('button', { name: 'Concluir traçado' }));
    await waitFor(() => expect(use).toHaveBeenCalledOnce());
    expect(use.mock.calls[0][1]).toMatchObject({ kind, taskId: 't', logId: 'l' }); expect(use.mock.calls[0][2]).toBeCloseTo(result);
    expect(use.mock.calls[0][3].measures[0]).toEqual(use.mock.calls[0][1]);
    expect(save).not.toHaveBeenCalled();
  });
});
