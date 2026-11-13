import { expect, it } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { prepareIncorporation } from './measurementIncorporation';
import { newMeasuredRow } from './measurementWorkspace';
import { includeMeasuredSchedule, stripMeasuredSchedule } from './measuredSchedule';
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
  expect(tasks.find(t => t.id === 'detectors')).toMatchObject({ startDate: '2026-08-24', percentComplete: 100, team: undefined });
  expect(tasks.find(t => t.id === 'signs')?.startDate).toBe('2027-04-12');
  expect(tasks.find(t => t.id === 'measured:signs:1')).toMatchObject({ startDate: '2026-08-26', duration: 1 });
  expect(tasks.find(t => t.id === 'measured:detectors:1')?.name).toContain('intervalo de referência');
  expect(measured.lockedIds.has('detectors')).toBe(true);
  expect(JSON.stringify(project)).toBe(original);
  expect(stripMeasuredSchedule(project, measured.project, measured.lockedIds).phases[1].tasks[0]).toEqual(project.phases[1].tasks[0]);
  expect(stripMeasuredSchedule(project, measured.project, measured.lockedIds).phases).toHaveLength(project.phases.length);
});
