import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
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
