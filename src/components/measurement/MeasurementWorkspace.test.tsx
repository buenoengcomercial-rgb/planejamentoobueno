import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeasurementWorkspace from './MeasurementWorkspace';
import type { MeasurementRepository } from '@/lib/measurementWorkspaceStore';
import type { MeasurementWorkspace as Workspace } from '@/lib/measurementWorkspace';

afterEach(cleanup);
const actor = { id: 'u', name: 'Engenheiro', canEdit: true };
function fixture() {
  const w: Workspace = { schema: 1, projectId: 'p', projectName: 'Obra isolada', revision: 0, services: [{ id: 's', item: '1.1', description: 'Placas', unit: 'UN', contracted: 100, priceNoBDI: 10, priceWithBDI: 12.5, bdi: 25, importedPrice: true, chapterId: 'c', chapter: 'Prédio', path: 'Prédio › Sinalização', availableFromNumber: 1 }], periods: [1, 2, 3].map(n => ({ id: `m${n}`, number: n, startDate: `2026-0${n}-01`, endDate: `2026-0${n}-28`, status: 'draft' })), entries: [], plans: [], audit: [], importedKeys: [], backupId: 'backup' };
  const repository: MeasurementRepository = { load: vi.fn(async () => w), initialize: vi.fn(async () => w), commit: vi.fn(async next => next), pending: vi.fn(async () => null), pendingSaves: vi.fn(async () => []), archivePending: vi.fn(async () => undefined), drafts: vi.fn(async () => []), writeDraft: vi.fn(async () => undefined), clearDraft: vi.fn(async () => undefined), backup: vi.fn(async () => null) };
  return { w, repository };
}
describe('Tela própria de Medição', () => {
  it('preserva digitação até blur e bloqueia troca de período enquanto a gravação está pendente', async () => {
    const { repository } = fixture(); let confirm!: (w: Workspace) => void;
    vi.mocked(repository.commit).mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
    render(<MeasurementWorkspace repository={repository} actor={actor}/>);
    const input = await screen.findByLabelText('Quantidade de Placas');
    fireEvent.change(input, { target: { value: '3' } });
    expect(repository.commit).not.toHaveBeenCalled();
    await waitFor(() => expect(repository.writeDraft).toHaveBeenCalledWith(expect.objectContaining({ measurementId: 'm1', serviceId: 's', changes: { multiplier: '3' } })));
    fireEvent.blur(input);
    const selector = screen.getByLabelText('Medição selecionada');
    expect(selector).toBeDisabled();
    fireEvent.change(selector, { target: { value: 'm2' } });
    expect(selector).toHaveValue('m1');
    const candidate = vi.mocked(repository.commit).mock.calls[0][0];
    expect(candidate.entries[0]).toMatchObject({ projectId: 'p', measurementId: 'm1', serviceId: 's' });
    await act(async () => confirm(candidate));
    await waitFor(() => expect(selector).not.toBeDisabled());
    expect(screen.getByTestId('monthly-value')).toHaveTextContent('37,50');
    fireEvent.change(selector, { target: { value: 'm2' } });
    expect(screen.getByLabelText('Quantidade de Placas')).toHaveValue(0);
    expect(screen.getByTestId('monthly-value')).toHaveTextContent('0,00');
  });
  it('não anuncia confirmação quando o repositório falha e mantém a troca bloqueada', async () => {
    const { repository } = fixture(); vi.mocked(repository.commit).mockRejectedValue(new Error('Sem conexão: rascunho preservado'));
    render(<MeasurementWorkspace repository={repository} actor={actor}/>);
    const input = await screen.findByLabelText('Quantidade de Placas');
    fireEvent.change(input, { target: { value: '3' } }); fireEvent.blur(input);
    await screen.findByText('Não salvo · rascunho preservado');
    expect(screen.getByLabelText('Medição selecionada')).toBeDisabled();
    expect(screen.getByTestId('monthly-value')).toHaveTextContent('0,00');
    expect(screen.getByText('Tentar salvar novamente')).toBeVisible();
  });
  it('perfil de consulta não permite editar ou criar período', async () => {
    const { repository } = fixture(); render(<MeasurementWorkspace repository={repository} actor={{ ...actor, canEdit: false }}/>);
    expect(await screen.findByLabelText('Quantidade de Placas')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Nova medição' })).toBeDisabled();
    expect(repository.commit).not.toHaveBeenCalled();
  });
});
