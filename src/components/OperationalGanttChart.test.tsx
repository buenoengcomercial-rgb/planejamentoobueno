import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { prepareIncorporation } from '@/lib/measurementIncorporation';
import { newMeasuredRow, monthlyTotal } from '@/lib/measurementWorkspace';
import { getAllTasks } from '@/data/sampleProject';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import OperationalGanttChart from './OperationalGanttChart';
import type { ComponentProps } from 'react';
import type GanttChart from './GanttChart';

const captured = vi.hoisted(() => ({ props: null as ComponentProps<typeof GanttChart> | null }));
vi.mock('./GanttChart', () => ({ default: (props: ComponentProps<typeof GanttChart>) => { captured.props = props; return null; } }));

it('permite editar e referenciar itens contratados sem transformar a projeção em contrato-base', () => {
  const { project } = measurementFixture();
  const additives = [{ id: 'ad', name: 'Aditivo', importedAt: '', version: 1,
    status: 'aditivo_contratado' as const, isContracted: true,
    compositions: [{ id: 'new', item: '8.1', isNewService: true, description: 'Novo', code: '', bank: '', unit: 'UN',
      quantity: 0, addedQuantity: 2, unitPriceNoBDI: 10, unitPriceWithBDI: 10, total: 20, inputs: [] }],
    scheduleSnapshots: [{ id: 'archive', version: 1, archivedAt: '', referenceDocument: '', rows: [{
      taskId: 'add-ad-new', compositionId: 'new', phaseId: 'alarm', phaseName: 'Alarme', description: 'Novo',
      classification: 'proposed_addition' as const, statusLabel: '', startDate: '2026-08-24', duration: 1,
      dependencies: [], responsible: '', quantity: 2, unit: 'UN', unitPriceWithBDI: 10, totalWithBDI: 20,
    }] }],
  }];
  let saved = project;
  render(<OperationalGanttChart project={project} confirmedAdditives={additives}
    onProjectChange={next => { saved = typeof next === 'function' ? next(saved) : next; }} />);
  expect(captured.props!.lockedTaskLabels?.['add-ad-new']).toBeUndefined();
  expect(captured.props!.displayOnlyTaskIds?.has('add-ad-new')).toBeFalsy();
  const updated = structuredClone(captured.props!.project);
  updated.phases.at(-1)!.tasks[0].startDate = '2026-11-13';
  captured.props!.onProjectChange(updated);
  expect(saved.contractedTaskSchedules?.['add-ad-new'].startDate).toBe('2026-11-13');
  expect(saved.phases).toEqual(project.phases);
  expect(additives[0].scheduleSnapshots[0].rows[0].startDate).toBe('2026-08-24');
});

it('salva alteração de uma data derivada sem mudar tarefas ou medições não editadas', async () => {
  const { calculateProjectSchedule } = await import('@/domains/schedule/useCalculatedProject');
  const { project } = measurementFixture();
  const raw = structuredClone(project);
  const tasks = raw.phases[0].tasks;
  tasks[0] = { id: 'pred', name: 'Predecessora', phase: 'Teste', responsible: '', materials: [], level: 0, startDate: '2026-11-13', duration: 3, percentComplete: 0, dependencies: [] };
  tasks[0].isManual = true; tasks[0].manualDuration = 3; tasks[0].durationMode = 'manual';
  tasks[1] = { ...tasks[0], id: 'dependent', startDate: '2026-11-13', dependencies: [tasks[0].id],
    dependencyDetails: [{ taskId: tasks[0].id, type: 'TI' }] };
  const calculated = calculateProjectSchedule(raw, true);
  expect(calculated.phases[0].tasks[1].startDate).not.toBe(raw.phases[0].tasks[1].startDate);
  let saved = raw;
  render(<OperationalGanttChart project={calculated}
    onProjectChange={next => { saved = typeof next === 'function' ? next(saved) : next; }} />);
  const updated = structuredClone(captured.props!.project);
  updated.phases[0].tasks[1].startDate = '2026-12-01';
  captured.props!.onProjectChange(updated);
  expect(saved.phases[0].tasks[1].startDate).toBe('2026-12-01');
  expect(saved.phases[0].tasks[0]).toEqual(raw.phases[0].tasks[0]);
  expect(saved.measurements).toEqual(raw.measurements);
});

it('grava a revisão na fronteira do cronograma sem converter histórico em serviços contratuais', async () => {
  const { fireEvent, screen } = await import('@testing-library/react');
  const { prepareIncorporation } = await import('@/lib/measurementIncorporation');
  const { newMeasuredRow } = await import('@/lib/measurementWorkspace');
  const { getAllTasks } = await import('@/data/sampleProject');
  const {project,plans}=measurementFixture();
  project.scheduleCalendar={uf:'RO',municipio:'Porto Velho',trabalhaSabado:false,jornadaDiaria:8};
  const {candidate}=prepareIncorporation({project,plans,drafts:[],id:'b',createdAt:'',manifest:{dataHash:'',files:[]}});
  candidate.entries=[{projectId:project.id,serviceId:'detectors',measurementId:'m1',rows:[{...newMeasuredRow('r'),multiplier:400}]}];
  let saved=project;
  const before=JSON.stringify(candidate);
  render(<OperationalGanttChart project={project} confirmedMeasurement={candidate} canManageCalendar onProjectChange={next=>{saved=typeof next==='function'?next(saved):next;}} />);
  fireEvent.click(screen.getByRole('button',{name:'Aplicar revisão do executado e limite de duas predecessoras'}));
  const original=getAllTasks(project).find(t=>t.id==='detectors')!;
  const changed=getAllTasks(saved).find(t=>t.id==='detectors')!;
  expect(changed.startDate).toBe('2026-09-15');
  expect(changed.dependencies).toEqual([]);
  expect(changed.operationalReschedule?.executionRevision?.completed).toBe(true);
  expect(changed.quantity).toBe(original.quantity);
  expect(changed.percentComplete).toBe(original.percentComplete);
  expect(changed.baseline).toEqual(original.baseline);
  expect(getAllTasks(saved)).toHaveLength(getAllTasks(project).length);
  expect(getAllTasks(saved).some(t=>t.id.startsWith('measured:')||t.id.startsWith('release:'))).toBe(false);
  expect(JSON.stringify(candidate)).toBe(before);
});

it('exibe a quantidade aditivada sem gravá-la ao editar uma data', () => {
  const { project } = measurementFixture();
  const task = project.phases[1].tasks[0];
  task.quantity = 21;
  const additive = { id: 'ad', name: 'Aditivo', importedAt: '', version: 1, status: 'contratado' as const,
    compositions: [{ id: 'increase', item: '2.1.7', description: task.name, code: '', bank: '', unit: 'UN',
      baseTaskId: task.id, quantity: 21, addedQuantity: 7, unitPriceNoBDI: 10, unitPriceWithBDI: 10, total: 280, inputs: [] }],
  };
  let saved = project;
  render(<OperationalGanttChart project={project} confirmedAdditives={[additive]}
    onProjectChange={next => { saved = typeof next === 'function' ? next(saved) : next; }} />);
  expect(captured.props!.contractedQuantityAdjustments?.get(task.id)).toEqual({ base: 21, added: 7, suppressed: 0, total: 28 });
  const updated = structuredClone(captured.props!.project);
  updated.phases[1].tasks[0].startDate = '2026-11-13';
  captured.props!.onProjectChange(updated);
  expect(saved.phases[1].tasks[0]).toEqual({ ...task, startDate: '2026-11-13' });
  expect(saved.measurements).toBe(project.measurements);
});


it('reúne a execução e o saldo na mesma linha com o total fiscal da competência', () => {
  const { project, plans } = measurementFixture();
  project.scheduleCalendar = { uf: 'RO', municipio: 'Porto Velho', trabalhaSabado: false, jornadaDiaria: 8 };
  const { candidate } = prepareIncorporation({ project, plans, drafts: [], id: 'test', createdAt: '', manifest: { dataHash: '', files: [] } });
  candidate.entries = [{ projectId: project.id, serviceId: 'detectors', measurementId: 'm1',
    rows: [{ ...newMeasuredRow('measured'), multiplier: 200 }] }];
  render(<OperationalGanttChart project={project} confirmedMeasurement={candidate} monthlyPresentation onProjectChange={() => {}} />);
  const visible = captured.props!;
  const rows = getAllTasks(visible.project);
  expect(rows.filter(task => task.id === 'detectors')).toHaveLength(1);
  expect(rows.some(task => task.id.startsWith('measured:'))).toBe(false);
  expect(visible.monthlyRows?.get('detectors')?.measured['2026-09']).toMatchObject({ quantity: 200, evidence: ['1ª medição'] });
  expect(visible.measurementValues?.['2026-09']).toBe(monthlyTotal(candidate, 'm1'));
});
