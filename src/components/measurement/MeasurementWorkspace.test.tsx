import { act, fireEvent, render, screen, waitFor, cleanup, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeasurementWorkspace from './MeasurementWorkspace';
import type { MeasurementRepository } from '@/lib/measurementWorkspaceStore';
import type { MeasurementWorkspace as Workspace } from '@/lib/measurementWorkspace';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';

afterEach(cleanup);
const actor = { id: 'u', name: 'Engenheiro', canEdit: true };
function fixture() {
  const w: Workspace = { schema: 1, projectId: 'p', projectName: 'Obra isolada', revision: 0, services: [{ id: 's', item: '1.1', description: 'Placas', unit: 'UN', contracted: 100, priceNoBDI: 10, priceWithBDI: 12.5, bdi: 25, importedPrice: true, chapterId: 'c', chapter: 'Prédio', path: 'Prédio › Sinalização', availableFromNumber: 1 }], periods: [1, 2, 3].map(n => ({ id: `m${n}`, number: n, startDate: `2026-0${n}-01`, endDate: `2026-0${n}-28`, status: 'draft' })), entries: [], plans: [], audit: [], importedKeys: [], backupId: 'backup' };
  const repository: MeasurementRepository = { load: vi.fn(async () => w), initialize: vi.fn(async () => w), commit: vi.fn(async next => next), pending: vi.fn(async () => null), pendingSaves: vi.fn(async () => []), archivePending: vi.fn(async () => undefined), drafts: vi.fn(async () => []), writeDraft: vi.fn(async () => undefined), clearDraft: vi.fn(async () => undefined), backup: vi.fn(async () => null) };
  return { w, repository };
}
describe('Tela própria de Medição', () => {
  it('limpa o painel ao clicar fora da quantidade, preservando cliques e rascunhos dentro do editor', async () => {
    const { w, repository } = fixture();
    w.services.push({ ...w.services[0], id: 's2', description: 'Outra tarefa' });
    render(<MeasurementWorkspace repository={repository} actor={actor}/>);
    const quantity = await screen.findByLabelText('Quantidade de Placas');
    const panel = screen.getByRole('region', { name: 'Painel inferior de quantitativos' });
    const cells = within(screen.getByTestId('service-s2')).getAllByRole('cell');
    for (const index of [0, 3, 5, 8, 10, 11, 12, 13, 14]) {
      fireEvent.click(quantity);
      expect(within(panel).getByLabelText('Unidades da linha 1')).toBeVisible();
      fireEvent.click(cells[index]);
      expect(panel).toHaveTextContent(/^$/);
    }
    fireEvent.click(quantity);
    expect(within(panel).queryByText('Placas', { exact: true })).not.toBeInTheDocument();
    const a = within(panel).getByLabelText('Unidades da linha 1');
    fireEvent.click(a);
    fireEvent.change(a, { target: { value: '3' } });
    expect(repository.commit).not.toHaveBeenCalled();
    fireEvent.blur(a);
    fireEvent.click(cells[11]);
    await waitFor(() => expect(screen.getByLabelText('Quantidade de Placas')).toHaveValue(3));
    expect(panel).toHaveTextContent(/^$/);
    const saved = vi.mocked(repository.commit).mock.calls.at(-1)![0];
    expect(saved.entries[0]).toMatchObject({ measurementId: 'm1', serviceId: 's' });
    expect(saved.services.map(s => s.contracted)).toEqual([100, 100]);
    fireEvent.click(screen.getByLabelText('Quantidade de Placas'));
    expect(within(panel).getByLabelText('Unidades da linha 1')).toHaveValue(3);
    fireEvent.click(within(panel).getByLabelText('Comentário da linha 1'));
    expect(within(panel).getByLabelText('Unidades da linha 1')).toBeVisible();
  });
  it('abre a composição pela descrição em leitura e mantém o painel de quantitativos vazio', async () => {
    const { w, repository } = fixture();
    const { project } = measurementFixture();
    w.services[0].sourceTaskId = 'signs';
    w.services[0].sourceBudgetId = 'budget-signs';
    const before = structuredClone(project);
    render(<MeasurementWorkspace repository={repository} actor={actor} analyticProject={project}/>);
    fireEvent.click(await screen.findByLabelText('Quantidade de Placas'));
    fireEvent.click(screen.getByRole('button', { name: 'Ver composição analítica de Placas' }));
    const analytic = screen.getByRole('region', { name: 'Composição analítica de Placas' });
    expect(analytic).toHaveTextContent('Placa de sinalização · insumo fictício');
    expect(within(analytic).getAllByRole('columnheader')).toHaveLength(8);
    expect(within(analytic).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Painel inferior de quantitativos' })).toHaveTextContent(/^$/);
    expect(repository.commit).not.toHaveBeenCalled();
    expect(project).toEqual(before);
    fireEvent.click(screen.getByLabelText('Quantidade de Placas'));
    expect(screen.queryByRole('region', { name: 'Composição analítica de Placas' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Unidades da linha 1')).toBeVisible();
  });
  it('troca o detalhe no painel inferior sem inserir linhas na planilha ou gravar a seleção', async () => {
    const { w, repository } = fixture();
    w.services.push({ ...w.services[0], id: 's2', item: '1.2', description: 'Detectores' });
    w.entries = [
      { projectId: 'p', measurementId: 'm1', serviceId: 's', rows: [{ id: 'plates', location: '', comment: 'Placas no térreo', formula: 'STANDARD', multiplier: 3, measuredQuantity: 0, origin: { kind: 'manual' } }] },
      { projectId: 'p', measurementId: 'm1', serviceId: 's2', rows: [{ id: 'detectors', location: '', comment: 'Detectores na cobertura', formula: 'STANDARD', multiplier: 5, measuredQuantity: 0, origin: { kind: 'manual' } }] },
    ];
    render(<MeasurementWorkspace repository={repository} actor={actor}/>);
    const sheet = await screen.findByRole('region', { name: 'Planilha da medição atual' });
    const detail = screen.getByRole('region', { name: 'Painel inferior de quantitativos' });
    const rowCount = within(sheet).getAllByRole('row').length;
    expect(detail).toHaveTextContent(/^$/);
    expect(screen.getByRole('separator', { name: 'Ajustar altura da planilha e do detalhe' })).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByLabelText('Quantidade de Placas')); });
    expect(within(detail).getByLabelText('Comentário da linha 1')).toHaveValue('Placas no térreo');
    expect(within(sheet).queryByLabelText('Unidades da linha 1')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByLabelText('Quantidade de Detectores')); });
    expect(within(detail).getByLabelText('Comentário da linha 1')).toHaveValue('Detectores na cobertura');
    expect(within(detail).getByLabelText('Unidades da linha 1')).toHaveValue(5);
    expect(within(sheet).getAllByRole('row')).toHaveLength(rowCount);
    fireEvent.change(screen.getByLabelText('Medição selecionada'), { target: { value: 'm2' } });
    expect(detail).toHaveTextContent(/^$/);
    expect(repository.commit).not.toHaveBeenCalled();
  });
  it('abre o detalhe somente pela medição atual e soma períodos sem editar o contrato ou o acumulado', async () => {
    const { w, repository } = fixture();
    w.entries = [{ projectId: 'p', measurementId: 'm1', serviceId: 's', rows: [{ id: 'original', location: '', comment: 'Primeira medição', formula: 'STANDARD', multiplier: 7, measuredQuantity: 0, origin: { kind: 'manual' } }] }];
    render(<MeasurementWorkspace repository={repository} actor={actor}/>);
    const selector = await screen.findByLabelText('Medição selecionada');
    fireEvent.change(selector, { target: { value: 'm2' } });
    const row = screen.getByTestId('service-s');
    const cells = within(row).getAllByRole('cell');
    expect(cells[5]).toHaveTextContent('100');
    expect(cells[11]).toHaveTextContent('7');
    for (const index of [3, 5, 6, 7, 8, 10, 11, 12, 13, 14]) {
      if (index !== 3) expect(within(cells[index]).queryByRole('button')).not.toBeInTheDocument();
      fireEvent.click(cells[index]);
      expect(screen.queryByLabelText('Unidades da linha 1')).not.toBeInTheDocument();
    }
    expect(within(cells[9]).queryByRole('button')).not.toBeInTheDocument();
    const detail = within(cells[9]).getByLabelText('Quantidade de Placas');
    fireEvent.click(detail);
    expect(screen.getByText('Detalhe de quantitativos · 2ª medição')).toBeVisible();
    const a = screen.getByLabelText('Unidades da linha 1');
    fireEvent.change(a, { target: { value: '3' } }); fireEvent.blur(a);
    await waitFor(() => expect(screen.getByLabelText('Quantidade de Placas')).toHaveValue(3));
    expect(cells[5]).toHaveTextContent('100');
    expect(cells[11]).toHaveTextContent('10');
    expect(screen.getByTestId('monthly-value')).toHaveTextContent('37,50');
    const saved = vi.mocked(repository.commit).mock.calls.at(-1)![0];
    expect(saved.entries.find(e => e.measurementId === 'm1')?.rows[0].multiplier).toBe(7);
    expect(saved.entries.find(e => e.measurementId === 'm2')?.rows[0].multiplier).toBe(3);
    expect(saved.services[0].contracted).toBe(100);
    expect(saved.entries.find(e => e.measurementId === 'm2')?.rows[0].id).not.toBe('__new__');
    fireEvent.change(selector, { target: { value: 'm1' } });
    expect(screen.getByLabelText('Quantidade de Placas')).toHaveValue(7);
  });
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
    const quantity = await screen.findByLabelText('Quantidade de Placas');
    expect(quantity).toHaveAttribute('readonly');
    await act(async () => { fireEvent.click(quantity); });
    expect(screen.getByText('Detalhe de quantitativos · 1ª medição')).toBeVisible();
    await act(async () => { fireEvent.blur(quantity); });
    expect(screen.getByRole('button', { name: 'Nova medição' })).toBeDisabled();
    expect(repository.commit).not.toHaveBeenCalled();
  });
});
