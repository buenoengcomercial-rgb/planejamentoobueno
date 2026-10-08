import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChapterPlanCatalog from './ChapterPlanCatalog';
import { readTakeoffs, updateTakeoffs, type TakeoffPlan } from '@/lib/planTakeoff';

vi.mock('@/lib/planTakeoff', async original => ({ ...await original<object>(), readTakeoffs: vi.fn(), updateTakeoffs: vi.fn() }));
let stored: TakeoffPlan[];
beforeEach(() => {
  stored = [];
  vi.mocked(readTakeoffs).mockImplementation(async () => stored);
  vi.mocked(updateTakeoffs).mockImplementation(async (_key, edit) => { stored = edit(stored); return stored; });
});

describe('catálogo de plantas do prédio', () => {
  it('cadastra uma vez no capítulo e recupera após remontagem', async () => {
    const first = render(<ChapterPlanCatalog storageKey="obra" chapterId="predio" building="Prédio A" readOnly={false} />);
    await screen.findByText('0 cadastradas');
    fireEvent.change(screen.getByRole('textbox', { name: 'Pavimento da planta de Prédio A' }), { target: { value: 'Térreo' } });
    fireEvent.change(screen.getByLabelText('Adicionar planta ao prédio Prédio A'), { target: { files: [new File(['DXF'], 'PPCI.dxf')] } });
    await waitFor(() => expect(stored).toHaveLength(1));
    expect(stored[0]).toMatchObject({ name: 'PPCI.dxf', chapterId: 'predio', building: 'Prédio A', floor: 'Térreo', scales: { 1: 1 }, measures: [] });
    first.unmount();
    render(<ChapterPlanCatalog storageKey="obra" chapterId="predio" building="Prédio A" readOnly={false} />);
    expect(await screen.findByText(/PPCI\.dxf/)).toBeInTheDocument();
  });
  it('vincula planta antiga sem descartar seus pontos', async () => {
    stored = [{ id: 'legacy', name: 'Antiga.dxf', floor: '', kind: 'dxf', file: new Blob(['DXF']), scales: {}, measures: [{ id: 'pontos', name: 'Placas', kind: 'count', page: 1, points: [{ x: 1, y: 2 }] }] }];
    render(<ChapterPlanCatalog storageKey="obra" chapterId="predio" building="Prédio A" readOnly={false} />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Pavimento da planta de Prédio A' }), { target: { value: '1º pavimento' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vincular Antiga.dxf a este prédio' }));
    await waitFor(() => expect(stored[0].chapterId).toBe('predio'));
    expect(stored[0].measures[0].points).toEqual([{ x: 1, y: 2 }]);
  });
});
