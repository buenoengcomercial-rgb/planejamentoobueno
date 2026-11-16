import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import MonthlyExecutionSchedule from './MonthlyExecutionSchedule';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { prepareIncorporation } from '@/lib/measurementIncorporation';
import { newMeasuredRow } from '@/lib/measurementWorkspace';

const cloud = vi.hoisted(() => ({ load: vi.fn(), record: vi.fn(), offline: vi.fn() }));
vi.mock('@/lib/measurementCloudRepository', () => ({
  cloudMeasurementRepository: () => ({ load: cloud.load, loadedOffline: cloud.offline }),
}));
vi.mock('@/lib/cloudProjects', () => ({
  loadStableCloudProjectRecord: cloud.record,
  discardCloudProjectRecord: vi.fn(),
}));

beforeEach(() => {
  cloud.load.mockReset();
  cloud.record.mockReset().mockResolvedValue({ project: { additives: [] } });
  cloud.offline.mockReset().mockReturnValue(false);
});

it('abre o quadro mensal e mantém o Gantt disponível', async () => {
  const { project, plans } = measurementFixture();
  const { candidate } = prepareIncorporation({ project, plans, drafts: [], id: 'backup', createdAt: '', manifest: { dataHash: '', files: [] } });
  candidate.entries = [{ projectId: project.id, serviceId: 'detectors', measurementId: 'm1', rows: [
    { ...newMeasuredRow('day'), multiplier: 3, origin: { kind: 'daily', date: '2026-08-26' } },
    { ...newMeasuredRow('undated'), multiplier: 7 },
  ] }];
  cloud.load.mockResolvedValue(candidate);
  render(<MonthlyExecutionSchedule project={project} userId="user" independentMeasurementConfirmed renderGantt={() => <div>Gráfico da obra</div>} />);

  expect(screen.getByRole('button', { name: 'Cronograma físico-financeiro' })).toHaveAttribute('aria-pressed', 'true');
  const row = await screen.findByRole('row', { name: /Detector de fumaça/ });
  expect(within(row).getByText('Competência da medição')).toBeInTheDocument();
  expect(within(row).getByText('390')).toBeInTheDocument();
  expect(within(row).getByText('Parcial')).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: '08/2026' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
  expect(screen.getByText('Gráfico da obra')).toBeInTheDocument();
});

it('avisa quando só existe uma cópia local e permite confirmar novamente', async () => {
  const { project } = measurementFixture();
  cloud.load.mockResolvedValue(null);
  cloud.offline.mockReturnValueOnce(true);
  render(<MonthlyExecutionSchedule project={project} userId="user" independentMeasurementConfirmed={false} renderGantt={() => null} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível confirmar a Medição na nuvem');

  fireEvent.click(screen.getByRole('button', { name: 'Conferir na nuvem' }));
  expect(await screen.findByText('Nenhum serviço medido nos períodos disponíveis.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('aguarda o aditivo antes de abrir diretamente o Gantt', async () => {
  const { project } = measurementFixture();
  let confirmAdditive: (value: unknown) => void = () => {};
  cloud.load.mockResolvedValue(null);
  cloud.record.mockReturnValue(new Promise(resolve => { confirmAdditive = resolve; }));
  const renderGantt = vi.fn(() => <div>Gráfico da obra</div>);
  render(<MonthlyExecutionSchedule project={project} userId="user" mode="gantt" independentMeasurementConfirmed={false} renderGantt={renderGantt} />);
  expect(await screen.findByRole('status')).toHaveTextContent('Conferindo a Medição e o Aditivo');
  expect(renderGantt).not.toHaveBeenCalled();
  confirmAdditive({ project: { additives: [] } });
  expect(await screen.findByText('Gráfico da obra')).toBeInTheDocument();
});

it('mostra mês por extenso na grade e na edição da parcela', async () => {
  const { project } = measurementFixture();
  project.endDate = '2027-01-31';
  cloud.load.mockResolvedValue(null);
  const saveMonthlyAllocation = vi.fn();
  render(<MonthlyExecutionSchedule project={project} userId="user" mode="physicalFinancial" independentMeasurementConfirmed={false}
    renderGantt={() => null} saveMonthlyAllocation={saveMonthlyAllocation} />);
  expect(await screen.findByRole('columnheader', { name: /novembro\/2026/ })).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /Editar/ }).filter(button => button.textContent?.includes('%')).every(button => /,\d{2}%/.test(button.textContent ?? ''))).toBe(true);
  fireEvent.click(screen.getAllByRole('button', { name: /Editar.*novembro\/2026/ })[0]);
  expect(screen.getByRole('option', { name: 'novembro/2026' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'janeiro/2027' })).toBeInTheDocument();
});
