import { describe, expect, it } from 'vitest';
import { includeContractedAdditiveTasks } from '@/lib/contractedAdditiveSchedule';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import type { Additive } from '@/types/project';

const confirmedAdditive: Additive = {
  id: 'ad', name: 'Aditivo', importedAt: '', version: 2, status: 'aditivo_contratado', isContracted: true,
  contractRevisionId: 'rev2',
  compositions: [{ id: 'new', isNewService: true, linkedTaskId: 'add-ad-new', item: '8.1', code: '', bank: '', description: 'Serviço novo',
    unit: 'UN', quantity: 0, addedQuantity: 3, unitPriceNoBDI: 10, unitPriceWithBDI: 12, total: 36, inputs: [] }],
  scheduleSnapshots: [{
    id: 's', version: 1, archivedAt: '', referenceDocument: '', contractRevisionId: 'rev2',
    rows: [{ taskId: 'add-ad-new', compositionId: 'new', phaseId: 'alarm', phaseName: 'Alarme',
      description: 'Serviço novo', classification: 'proposed_addition', statusLabel: '',
      startDate: '2026-11-02', duration: 7, dependencies: ['detectors'], responsible: '', quantity: 3,
      unit: 'UN', unitPriceWithBDI: 12, totalWithBDI: 36 }],
  }],
};

describe('serviços aditivados no Gantt', () => {
  it('recupera a tarefa e datas pelo arquivo da revisão contratada sem alterar a EAP', () => {
    const { project } = measurementFixture();
    const result = includeContractedAdditiveTasks(project, [confirmedAdditive]);
    expect(result.project.phases.at(-1)?.tasks).toMatchObject([
      { id: 'add-ad-new', startDate: '2026-11-02', duration: 7, dependencies: ['detectors'], quantity: 3 },
    ]);
    expect(project.phases).toHaveLength(2);
    expect(includeContractedAdditiveTasks(result.project, [confirmedAdditive]).project).toBe(result.project);
  });

  it('aguarda contratação e evita duplicar uma tarefa com vínculo legado', () => {
    const { project } = measurementFixture();
    const pending = { ...confirmedAdditive, status: 'aprovado' as const, isContracted: false };
    expect(includeContractedAdditiveTasks(project, [pending]).project).toBe(project);
    const linked = { ...confirmedAdditive, compositions: [{ ...confirmedAdditive.compositions[0], linkedTaskId: 'detectors' }] };
    expect(includeContractedAdditiveTasks(project, [linked]).project).toBe(project);
  });
});
