import { expect, it } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { prepareIncorporation } from './measurementIncorporation';
import { newMeasuredRow } from './measurementWorkspace';
import { settleReleaseProject } from './scheduleReleaseMath';
import { includeMeasuredSchedule, measurementReferenceDate, stripMeasuredSchedule } from './measuredSchedule';
import { getAllTasks } from '@/data/sampleProject';

it('keeps measured work in its historical interval and only the balance in the future', () => {
  const { project, plans } = measurementFixture();
  project.scheduleCalendar = { uf: 'RO', municipio: 'Porto Velho', trabalhaSabado: false, jornadaDiaria: 8 };
  project.phases[1].tasks.forEach(t => { t.startDate = '2027-04-12'; });
  const { candidate } = prepareIncorporation({ project, plans, drafts: [], id: 'b', createdAt: '', manifest: { dataHash: '', files: [] } });
  candidate.entries = [
    { projectId: project.id, serviceId: 'detectors', measurementId: 'm1', rows: [{ ...newMeasuredRow('a'), multiplier: 400 }] },
    { projectId: project.id, serviceId: 'signs', measurementId: 'm1', rows: [{ ...newMeasuredRow('b'), multiplier: 10, origin: { kind: 'daily', date: '2026-08-26' } }] },
  ];
  const original = JSON.stringify(project), measured = includeMeasuredSchedule(project, candidate);
  const tasks = getAllTasks(measured.project);
  expect(tasks.find(t => t.id === 'detectors')).toMatchObject({ startDate: '2026-09-15', percentComplete: 100, team: undefined });
  expect(tasks.find(t => t.id === 'signs')?.startDate).toBe('2027-04-12');
  expect(tasks.find(t => t.id === 'measured:signs:1')).toMatchObject({ startDate: '2026-08-26', duration: 1 });
  expect(tasks.find(t => t.id === 'measured:detectors:1')?.name).toContain('data de referência convencionada pela medição');
  expect(measured.lockedIds.has('detectors')).toBe(true);
  expect(JSON.stringify(project)).toBe(original);
  expect(stripMeasuredSchedule(project, measured.project, measured.lockedIds).phases[1].tasks[0]).toEqual(project.phases[1].tasks[0]);
  expect(stripMeasuredSchedule(project, measured.project, measured.lockedIds).phases).toHaveLength(project.phases.length);
});


it('usa o dia 05 ou o primeiro dia de segunda a sexta sem feriado', () => {
  const calendar = { uf: 'RO', municipio: 'Porto Velho' };
  expect(measurementReferenceDate('2026-11-28', calendar)).toBe('2026-11-05');
  expect(measurementReferenceDate('2026-12-28', calendar)).toBe('2026-12-07');
  expect(measurementReferenceDate('2027-09-28', calendar)).toBe('2027-09-06');
  expect(measurementReferenceDate('2024-09-28', { uf: 'AM', municipio: 'Manaus' })).toBe('2024-09-06');
});

it('reposiciona somente a parcela medida e reage à correção do boletim sem regravar a tarefa', () => {
  const { project, plans } = measurementFixture();
  project.scheduleCalendar = { uf: 'RO', municipio: 'Porto Velho', trabalhaSabado: true, jornadaDiaria: 8 };
  const task = getAllTasks(project).find(item => item.id === 'detectors')!;
  task.startDate = '2027-02-19';
  const { candidate } = prepareIncorporation({ project, plans, drafts: [], id: 'b', createdAt: '', manifest: { dataHash: '', files: [] } });
  candidate.periods = candidate.periods.filter(period => period.number < 3);
  candidate.periods.push({ id: 'm3', number: 3, startDate: '2026-10-30', endDate: '2026-11-28', status: 'draft' });
  candidate.entries = [{ projectId: project.id, serviceId: 'detectors', measurementId: 'm3', rows: [
    { ...newMeasuredRow('dated'), multiplier: 100, origin: { kind: 'daily', date: '2026-11-04' } },
    { ...newMeasuredRow('reference'), multiplier: 300 },
  ] }];
  const first = includeMeasuredSchedule(project, candidate);
  expect(first.references.get('detectors')).toEqual([
    { start: '2026-11-04', end: '2026-11-04', qty: 100, number: 3, precise: true },
    { start: '2026-11-05', end: '2026-11-05', qty: 300, number: 3, precise: false },
  ]);
  expect(getAllTasks(first.project).find(item => item.id === 'detectors')).toMatchObject({
    startDate: '2026-11-04', measuredExecutionEndDate: '2026-11-05', scheduleDisplayKind: 'completed-summary', percentComplete: 100,
  });
  candidate.entries[0].rows[1].multiplier = 200;
  const corrected = includeMeasuredSchedule(project, candidate);
  expect(corrected.balances.get('detectors')).toBe(100);
  expect(getAllTasks(corrected.project).find(item => item.id === 'detectors')?.startDate).toBe('2027-02-19');
  expect(task.startDate).toBe('2027-02-19');
});


it('mantém a data viável e adia apenas a sucessora em conflito com a data medida', () => {
  const { project, plans } = measurementFixture();
  project.scheduleCalendar = { uf: 'RO', municipio: 'Porto Velho', trabalhaSabado: false, jornadaDiaria: 8 };
  const source = getAllTasks(project).find(task => task.id === 'detectors')!;
  const { candidate } = prepareIncorporation({ project, plans, drafts: [], id: 'b', createdAt: '', manifest: { dataHash: '', files: [] } });
  candidate.periods = candidate.periods.filter(period => period.number < 3);
  candidate.periods.push({ id: 'm3', number: 3, startDate: '2026-10-30', endDate: '2026-11-28', status: 'draft' });
  candidate.entries = [{ projectId: project.id, serviceId: source.id, measurementId: 'm3',
    rows: [{ ...newMeasuredRow('execution'), multiplier: 400 }] }];
  project.phases[1].tasks.push(
    { ...source, id: 'viable', dependencies: [source.id], startDate: '2026-12-04' },
    { ...source, id: 'delay', dependencies: [source.id], startDate: '2026-11-05' },
  );
  const settled = getAllTasks(settleReleaseProject(includeMeasuredSchedule(project, candidate).project, true));
  expect(settled.find(task => task.id === 'viable')?.startDate).toBe('2026-12-04');
  expect(settled.find(task => task.id === 'delay')?.startDate).toBe('2026-11-06');
});
