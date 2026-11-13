import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import MonthlyExecutionSchedule from './MonthlyExecutionSchedule';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { prepareIncorporation } from '@/lib/measurementIncorporation';
import { newMeasuredRow } from '@/lib/measurementWorkspace';

const cloud = vi.hoisted(() => ({ load: vi.fn(), record: vi.fn(), offline: vi.fn(), watch: vi.fn(), revision: vi.fn() }));
vi.mock('@/lib/measurementCloudRepository', () => ({
  cloudMeasurementRepository: () => ({ load: cloud.load, loadedOffline: cloud.offline, watch: cloud.watch, remoteRevision: cloud.revision }),
}));
vi.mock('@/lib/cloudProjects', () => ({
  loadStableCloudProjectRecord: cloud.record,
  discardCloudProjectRecord: vi.fn(),
}));

beforeEach(() => {
  cloud.load.mockReset();
  cloud.record.mockReset().mockResolvedValue({ project: { additives: [] } });
  cloud.offline.mockReset().mockReturnValue(false);
  cloud.watch.mockReset().mockReturnValue(() => undefined);
  cloud.revision.mockReset().mockResolvedValue(0);
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
  fireEvent.click(within(row).getByRole('button', { name: /set\/2026, 10 UN medidos/ }));
  const detail = screen.getByRole('dialog');
  expect(within(detail).getByText('390 UN')).toBeInTheDocument();
  expect(within(detail).getByText('2,5%')).toBeInTheDocument();
  fireEvent.click(within(detail).getByRole('button', { name: 'Close' }));
  expect(screen.getByRole('columnheader', { name: /set\/2026/ })).toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: /ago\/2026/ })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
  expect(screen.getByText('Gráfico da obra')).toBeInTheDocument();
});

it('avisa quando só existe uma cópia local e permite confirmar novamente', async () => {
  const { project } = measurementFixture();
  project.measurements = [];
  cloud.load.mockResolvedValue(null);
  cloud.offline.mockReturnValueOnce(true);
  render(<MonthlyExecutionSchedule project={project} userId="user" independentMeasurementConfirmed={false} renderGantt={() => null} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível confirmar a Medição na nuvem');

  fireEvent.click(screen.getByRole('button', { name: 'Conferir na nuvem' }));
  expect(await screen.findByText('Nenhuma competência cadastrada na Medição.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('atualiza a mesma linha quando uma nova medição é confirmada na nuvem', async () => {
  const { project, plans } = measurementFixture();
  const { candidate } = prepareIncorporation({ project, plans, drafts: [], id: 'backup', createdAt: '', manifest: { dataHash: '', files: [] } });
  const next = structuredClone(candidate);
  next.revision += 1;
  next.periods.push({ id: 'm5', number: 5, startDate: '2026-12-23', endDate: '2027-01-21', status: 'generated' });
  next.entries.push({ projectId: project.id, serviceId: 'detectors', measurementId: 'm5', rows: [{ ...newMeasuredRow('later'), multiplier: 12 }] });
  cloud.load.mockResolvedValueOnce(candidate).mockResolvedValue(next);
  render(<MonthlyExecutionSchedule project={project} userId="user" independentMeasurementConfirmed renderGantt={() => null} />);
  const row = await screen.findByRole('row', { name: /Detector de fumaça/ });
  expect(within(row).getByRole('button', { name: /set\/2026, 221 UN medidos/ })).toBeInTheDocument();
  await act(async () => cloud.watch.mock.calls[0][0](next.revision));
  expect(await within(row).findByRole('button', { name: /jan\/2027, 12 UN medidos/ })).toBeInTheDocument();
  expect(within(row).queryByRole('button', { name: /dez\/2026/ })).not.toBeInTheDocument();
  expect(screen.getAllByRole('row', { name: /Detector de fumaça/ })).toHaveLength(1);
});

it('exibe um serviço novo integrado uma única vez depois da incorporação na Medição', async () => {
  const { project, plans } = measurementFixture();
  const { candidate } = prepareIncorporation({ project, plans, drafts: [], id: 'backup', createdAt: '', manifest: { dataHash: '', files: [] } });
  const service = { ...candidate.services[0], id: 'additive:a:new', item: '8.1', description: 'Serviço novo integrado',
    sourceTaskId: 'add-a-new', sourceBudgetId: undefined, chapter: 'Aditivo', path: 'Aditivo', availableFromNumber: 3 };
  candidate.services.push(service, { ...service, id: 'add-a-new', availableFromNumber: 1 });
  cloud.load.mockResolvedValue(candidate);
  cloud.record.mockResolvedValue({ project: { additives: [{
    id: 'a', name: 'Aditivo', status: 'aditivo_contratado', isContracted: true,
    compositions: [{ id: 'new', item: '8.1', description: service.description, unit: 'UN',
      isNewService: true, addedQuantity: 400, originalQuantity: 0, unitPriceNoBDI: 10, inputs: [] }],
  }] } });
  render(<MonthlyExecutionSchedule project={project} userId="user" independentMeasurementConfirmed renderGantt={() => null} />);
  expect(await screen.findByRole('row', { name: /Serviço novo integrado/ })).toBeInTheDocument();
  expect(screen.getAllByRole('row', { name: /Serviço novo integrado/ })).toHaveLength(1);
});
