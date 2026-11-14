import { describe, expect, it } from 'vitest';
import { captureContractedTaskSchedules, includeContractedAdditiveTasks } from '@/lib/contractedAdditiveSchedule';
import { applyProjectOperation, projectWriteOrigin } from '@/lib/projectOperations';
import { mergeOperationalProjectIntoRaw } from '@/lib/operationalProject';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import type { Additive } from '@/types/project';
import { flattenPhasesByChapter, getChapterNumbering } from '@/lib/chapters';

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
  it('resolve o subcapítulo por item e o ordena no fim do capítulo correspondente', () => {
    const { project } = measurementFixture();
    project.phases[0].customNumber = '2';
    project.phases[1].order = 10;
    const existing = { id: 'new-central', parentId: 'building', name: 'Serviços – Itens Novos', color: '#000', order: 0, customNumber: '2.9', tasks: [] };
    project.phases.push(existing, { id: 'other', name: 'Outro prédio', customNumber: '3', color: '#000', tasks: [] });
    const composition = confirmedAdditive.compositions[0];
    const archive = confirmedAdditive.scheduleSnapshots![0];
    const additive = { ...confirmedAdditive, compositions: [
      { ...composition, item: '2.9.1', phaseId: 'stale' },
      { ...composition, id: 'second', item: '3.9.1', linkedTaskId: undefined },
    ], scheduleSnapshots: [{ ...archive, rows: [
      { ...archive.rows[0], item: '2.9.1' },
      { ...archive.rows[0], item: '3.9.1', compositionId: 'second', taskId: 'add-ad-second' },
    ] }] };
    const { project: projected } = includeContractedAdditiveTasks(project, [additive]);
    expect(projected.phases.filter(phase => !phase.parentId)).toEqual([project.phases[0], project.phases[3]]);
    const phases = flattenPhasesByChapter(projected);
    expect(phases.map(phase => phase.id).slice(0, 4)).toEqual(['building', 'alarm', existing.id, 'other']);
    expect(phases[2].tasks[0]).toMatchObject({ id: 'add-ad-new', phase: existing.id });
    const created = phases.at(-1)!;
    expect(created).toMatchObject({ parentId: 'other', name: 'SERVIÇOS - ITENS NOVOS', tasks: [{ id: 'add-ad-second' }] });
    expect(getChapterNumbering(projected).get(created.id)).toBe('3.9');
  });

  it('projeta 21 + 7 como 28 e recalcula RUP sem reaplicar acréscimo já integrado', () => {
    const { project } = measurementFixture();
    const task = project.phases[1].tasks[0];
    Object.assign(task, { quantity: 21, duration: 3, durationMode: 'rup', isManual: false,
      laborCompositions: [{ role: 'Instalador', rup: 1, workerCount: 1 }] });
    const composition = { ...confirmedAdditive.compositions[0], isNewService: false, item: '2.1.7',
      baseTaskId: task.id, quantity: 0, addedQuantity: 7, unit: task.unit! };
    const additive = { ...confirmedAdditive, compositions: [composition] };
    const result = includeContractedAdditiveTasks(project, [additive]);
    expect(result.project.phases[1].tasks[0]).toMatchObject({ quantity: 28, duration: 4 });
    expect(result.projectedTaskIds.size).toBe(0);
    expect(result.quantityAdjustments.get(task.id)).toEqual({ base: 21, added: 7, suppressed: 0, total: 28 });
    expect(task).toMatchObject({ quantity: 21, duration: 3 });
    expect(includeContractedAdditiveTasks(result.project, [additive]).project.phases[1].tasks[0].quantity).toBe(28);
    task.quantity = 28;
    task.additiveHistory = [{ additiveId: additive.id, additiveName: additive.name, version: 1,
      at: '', kind: 'acrescimo', previousQuantity: 21, newQuantity: 28, addedQuantity: 7, suppressedQuantity: 0 }];
    expect(includeContractedAdditiveTasks(project, [additive]).project.phases[1].tasks[0].quantity).toBe(28);
  });
  it('persiste datas operacionais sem criar tarefas fiscais nem modificar o arquivo aprovado', () => {
    const { project } = measurementFixture();
    const untouched = JSON.stringify({ project, confirmedAdditive });
    const display = includeContractedAdditiveTasks(project, [confirmedAdditive]);
    const after = structuredClone(display.project);
    const task = after.phases.at(-1)!.tasks[0];
    Object.assign(task, { startDate: '2026-11-13', duration: 12, dependencies: ['detectors'],
      dependencyDetails: [{ taskId: 'detectors', type: 'II' }], quantity: 999, percentComplete: 99 });
    const captured = captureContractedTaskSchedules(project, display.project, after, [confirmedAdditive], display.projectedTaskIds);
    const persisted = mergeOperationalProjectIntoRaw(project,
      applyProjectOperation('gantt', display.project, display.project, captured));
    expect(persisted.phases).toEqual(project.phases);
    expect(projectWriteOrigin(persisted)).toBe('gantt');
    const reloaded = includeContractedAdditiveTasks(JSON.parse(JSON.stringify(persisted)), [confirmedAdditive]);
    expect(reloaded.project.phases.at(-1)!.tasks[0]).toMatchObject({ startDate: '2026-11-13', duration: 12,
      dependencyDetails: [{ taskId: 'detectors', type: 'II' }], quantity: 3, percentComplete: 0 });
    expect(JSON.stringify({ project, confirmedAdditive })).toBe(untouched);
  });

  it('não aplica programação de outra revisão do arquivo', () => {
    const { project } = measurementFixture();
    project.contractedTaskSchedules = { 'add-ad-new': { archiveId: 'outro', startDate: '2027-04-01', duration: 30, dependencies: [] } };
    expect(includeContractedAdditiveTasks(project, [confirmedAdditive]).project.phases.at(-1)!.tasks[0].startDate).toBe('2026-11-02');
  });
  it('recupera a tarefa e datas pelo arquivo da revisão contratada sem alterar a EAP', () => {
    const { project } = measurementFixture();
    const result = includeContractedAdditiveTasks(project, [confirmedAdditive]);
    expect(result.project.phases.at(-1)?.tasks).toMatchObject([
      { id: 'add-ad-new', startDate: '2026-11-02', duration: 7, dependencies: ['detectors'], quantity: 3 },
    ]);
    expect(project.phases).toHaveLength(2);
    expect(includeContractedAdditiveTasks(result.project, [confirmedAdditive]).project).toBe(result.project);
  });

  it('encaixa serviços no capítulo vinculado, preserva a ordem e separa apenas órfãos', () => {
    const { project } = measurementFixture();
    const original = confirmedAdditive.compositions[0];
    const archive = confirmedAdditive.scheduleSnapshots![0];
    const row = archive.rows[0];
    const additive = {
      ...confirmedAdditive,
      compositions: [
        { ...original, phaseId: 'alarm' },
        { ...original, id: 'orphan', phaseId: 'missing', linkedTaskId: undefined },
      ],
      scheduleSnapshots: [{ ...archive, rows: [
        { ...row, phaseId: 'old-preview-phase', scheduleOrder: -1, durationMode: 'rup' as const },
        { ...row, taskId: 'add-ad-orphan', compositionId: 'orphan' },
      ] }],
    };
    const result = includeContractedAdditiveTasks(project, [additive]);
    expect(result.project.phases.find(phase => phase.id === 'alarm')).toMatchObject({
      parentId: 'building',
      tasks: [
        expect.objectContaining({ id: 'add-ad-new', phase: 'alarm', scheduleOrder: -1, durationMode: 'rup', unitPrice: 12 }),
        ...project.phases[1].tasks,
      ],
    });
    expect(result.project.phases.at(-1)?.tasks.map(task => task.id)).toEqual(['add-ad-orphan']);
    expect([...result.projectedTaskIds]).toEqual(['add-ad-new', 'add-ad-orphan']);
    expect(project.phases[1].tasks).toHaveLength(3);
  });

  it('aguarda contratação e evita duplicar uma tarefa com vínculo legado', () => {
    const { project } = measurementFixture();
    const pending = { ...confirmedAdditive, status: 'aprovado' as const, isContracted: false };
    expect(includeContractedAdditiveTasks(project, [pending]).project).toBe(project);
    const linked = { ...confirmedAdditive, compositions: [{ ...confirmedAdditive.compositions[0], linkedTaskId: 'detectors' }] };
    expect(includeContractedAdditiveTasks(project, [linked]).project).toBe(project);
  });
});
