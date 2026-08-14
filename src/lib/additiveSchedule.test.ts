import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Additive, AdditiveComposition, Project } from '@/types/project';
import {
  buildAdditiveSchedulePreviewProject,
  buildAdditiveScheduleAnalysisProject,
  buildAdditiveScheduleRows,
  buildPendingAdditiveSuspensionMap,
  buildProjectFromScheduleSnapshot,
  buildPreviewSuspensionMap,
  confirmAdditiveScheduleDates,
  createAdditiveScheduleSnapshot,
  getAutomaticSuspendedTaskIds,
  getQuantitativelyRestrictedTasks,
  mergeAdditiveSchedulePreviewChanges,
  setAdditiveScheduleDependencyBlock,
  setAdditiveScheduleDependentTask,
  syncAdditiveScheduleDraft,
  validateAdditiveSchedule,
} from './additiveSchedule';
import { buildAdditiveScheduleForecast } from './additiveScheduleForecast';
import { buildAdditiveSchedulePdfDocument, buildAdditiveScheduleWorkbook } from './additiveScheduleReports';
import { contractAdditive } from './additiveImport';

const existingComposition: AdditiveComposition = {
  id: 'existing-comp', item: '1.1.1', code: 'EX-1', bank: 'SINAPI', description: 'Serviço contratado alterado',
  quantity: 10, originalQuantity: 10, addedQuantity: 2, suppressedQuantity: 0, changeKind: 'acrescido',
  unit: 'UN', unitPriceNoBDI: 80, unitPriceWithBDI: 100, total: 1000, totalWithBDI: 1000,
  inputs: [], taskId: 'task-1', phaseId: 'phase-1',
};

const newComposition: AdditiveComposition = {
  id: 'new-comp', item: '1.1.2', code: 'NEW-1', bank: 'SINAPI', description: 'Novo serviço do aditivo',
  quantity: 3, originalQuantity: 0, addedQuantity: 3, suppressedQuantity: 0, changeKind: 'acrescido',
  unit: 'UN', unitPriceNoBDI: 50, unitPriceWithBDI: 62.5, total: 187.5, totalWithBDI: 187.5,
  inputs: [], phaseId: 'phase-1', isNewService: true,
};

const additive: Additive = {
  id: 'add-1', name: '1º Aditivo', importedAt: '2026-08-01T00:00:00.000Z', status: 'aprovado',
  effectiveDate: '2026-10-01', version: 1, bdiPercent: 25, compositions: [existingComposition, newComposition],
};

const project: Project = {
  id: 'project-1', name: 'Obra teste', startDate: '2026-08-01', endDate: '2027-02-01', totalBudget: 1500,
  phases: [{
    id: 'phase-1', name: 'Capítulo 1', color: '#000000', tasks: [
      { id: 'task-1', name: 'Serviço contratado alterado', phase: 'phase-1', startDate: '2026-08-10', duration: 5, dependencies: [], responsible: '', percentComplete: 0, materials: [], level: 0, quantity: 10, unit: 'UN', unitPrice: 100, unitPriceNoBDI: 80, itemCode: 'EX-1' },
      { id: 'task-2', name: 'Serviço contratado dependente', phase: 'phase-1', startDate: '2026-08-20', duration: 4, dependencies: [], responsible: '', percentComplete: 0, materials: [], level: 0, quantity: 5, unit: 'UN', unitPrice: 50, unitPriceNoBDI: 40, itemCode: 'EX-2' },
    ],
  }],
  additives: [additive],
};

describe('Cronograma do Aditivo', () => {
  it('isola tarefas virtuais e o planejamento da execução quantitativa parcial', () => {
    const withDraft = syncAdditiveScheduleDraft(project, additive.id, '2026-08-13T12:00:00.000Z');
    const active = withDraft.additives![0];
    expect(active.scheduleDraft?.plannedTasks).toHaveLength(1);
    expect(validateAdditiveSchedule(withDraft, active)[0]).toMatch(/não confirmadas/i);
    expect(getAutomaticSuspendedTaskIds(withDraft, active)).toEqual(new Set());
    expect(getQuantitativelyRestrictedTasks(withDraft, active).get('task-1')?.restriction).toMatchObject({
      contractedQuantity: 10, executableQuantity: 10, addedQuantity: 2, suppressedQuantity: 0,
    });

    const withManual = setAdditiveScheduleDependentTask(withDraft, active.id, 'task-2', true);
    const selected = withManual.additives![0];
    const preview = buildAdditiveSchedulePreviewProject(withManual, selected, selected.scheduleDraft!);
    expect(preview.phases[0].tasks.map(task => task.id)).toContain('add-add-1-new-comp');
    expect(withManual.phases[0].tasks.map(task => task.id)).not.toContain('add-add-1-new-comp');
    expect(buildPreviewSuspensionMap(withManual, selected)['task-2'].kind).toBe('manual');

    const nextPreview: Project = {
      ...preview,
      phases: preview.phases.map(phase => ({
        ...phase,
        tasks: phase.tasks.map(task => task.id === 'task-1'
          ? { ...task, startDate: '2026-08-15' }
          : task.id === 'task-2'
          ? { ...task, startDate: '2026-09-01' }
          : task.id === 'add-add-1-new-comp'
            ? { ...task, startDate: '2026-11-10', duration: 8 }
            : task),
      })),
    };
    const merged = mergeAdditiveSchedulePreviewChanges(withManual, active.id, preview, nextPreview, '2026-08-13T13:00:00.000Z');
    expect(merged.phases[0].tasks.find(task => task.id === 'task-1')?.startDate).toBe('2026-08-10');
    expect(merged.phases[0].tasks.find(task => task.id === 'task-2')?.startDate).toBe('2026-08-20');
    expect(merged.phases[0].tasks.map(task => task.id)).not.toContain('add-add-1-new-comp');
    expect(merged.additives![0].scheduleDraft?.plannedTasks[0]).toMatchObject({ startDate: '2026-11-10', duration: 8, datesConfirmed: true });
    expect(merged.additives![0].scheduleDraft?.contractedTaskPlans?.[0]).toMatchObject({ taskId: 'task-1', startDate: '2026-08-15' });
    expect(validateAdditiveSchedule(merged, merged.additives![0])).toEqual([]);
    expect(buildPendingAdditiveSuspensionMap(merged)).toMatchObject({ 'task-1': { kind: 'quantity_limited' }, 'task-2': { kind: 'manual' } });

    const released = setAdditiveScheduleDependentTask(merged, active.id, 'task-2', false);
    const releasedActive = released.additives![0];
    const releasedPreview = buildAdditiveSchedulePreviewProject(released, releasedActive, releasedActive.scheduleDraft!);
    const editedReleasedPreview = {
      ...releasedPreview,
      phases: releasedPreview.phases.map(phase => ({
        ...phase,
        tasks: phase.tasks.map(task => task.id === 'task-2' ? { ...task, startDate: '2026-09-01' } : task),
      })),
    };
    const releasedMerged = mergeAdditiveSchedulePreviewChanges(released, active.id, releasedPreview, editedReleasedPreview);
    expect(releasedMerged.phases[0].tasks.find(task => task.id === 'task-2')?.startDate).toBe('2026-09-01');
  });

  it('classifica execução parcial, suspensão integral e novos serviços', () => {
    const fullSuppression: AdditiveComposition = {
      ...existingComposition,
      id: 'fully-suppressed',
      taskId: 'task-2',
      code: 'EX-2',
      description: 'Serviço integralmente suprimido',
      quantity: 10,
      originalQuantity: 10,
      addedQuantity: 0,
      suppressedQuantity: 10,
      changeKind: 'suprimido',
    };
    const partialSuppression: AdditiveComposition = {
      ...existingComposition,
      id: 'partially-suppressed',
      taskId: 'task-3',
      code: 'EX-3',
      description: 'Serviço parcialmente suprimido',
      addedQuantity: 0,
      suppressedQuantity: 2,
      changeKind: 'suprimido',
    };
    const priceChange: AdditiveComposition = {
      ...existingComposition,
      id: 'price-change',
      taskId: 'task-4',
      code: 'EX-4',
      description: 'Serviço com novo preço',
      quantity: 5,
      originalQuantity: 5,
      addedQuantity: 0,
      suppressedQuantity: 0,
      changeKind: 'sem_alteracao',
      unitPriceNoBDI: 88,
      unitPriceWithBDI: 110,
      total: 550,
      totalWithBDI: 550,
    };
    const changedProject: Project = {
      ...project,
      phases: project.phases.map(phase => ({
        ...phase,
        tasks: [...phase.tasks, {
          id: 'task-3', name: 'Serviço parcialmente suprimido', phase: 'phase-1', startDate: '2026-08-25', duration: 5,
          dependencies: [], responsible: '', percentComplete: 0, materials: [], level: 0, quantity: 10, unit: 'UN',
          unitPrice: 100, unitPriceNoBDI: 80, itemCode: 'EX-3',
        }, {
          id: 'task-4', name: 'Serviço com novo preço', phase: 'phase-1', startDate: '2026-08-28', duration: 3,
          dependencies: [], responsible: '', percentComplete: 0, materials: [], level: 0, quantity: 5, unit: 'UN',
          unitPrice: 100, unitPriceNoBDI: 80, itemCode: 'EX-4',
        }],
      })),
      additives: [{ ...additive, compositions: [existingComposition, partialSuppression, fullSuppression, priceChange, newComposition] }],
    };
    const withDraft = syncAdditiveScheduleDraft(changedProject, additive.id);
    const active = withDraft.additives![0];
    const map = buildPreviewSuspensionMap(withDraft, active);
    expect(map['task-1']).toMatchObject({ kind: 'quantity_limited', scheduleState: 'scheduled', financialTreatment: 'monthly' });
    expect(map['task-3']).toMatchObject({
      kind: 'quantity_limited', scheduleState: 'scheduled',
      quantityRestriction: { contractedQuantity: 10, executableQuantity: 8, suppressedQuantity: 2 },
    });
    expect(map['task-4']).toMatchObject({ kind: 'automatic', scheduleState: 'suspended', financialTreatment: 'excluded' });
    expect(map['task-2']).toMatchObject({
      scheduleState: 'fully_suppressed',
      financialTreatment: 'excluded',
      label: 'ITEM SUPRIMIDO - QUANTIDADE A EXECUTAR: 0',
    });
    expect(map['add-add-1-new-comp']).toMatchObject({ scheduleState: 'scheduled', financialTreatment: 'monthly' });

    const preview = buildAdditiveSchedulePreviewProject(withDraft, active, active.scheduleDraft!);
    const rows = buildAdditiveScheduleRows(withDraft, active, preview);
    expect(rows.find(row => row.taskId === 'task-1' && !row.compositionId)).toMatchObject({
      scheduleState: 'scheduled', financialTreatment: 'monthly', quantity: 10, totalWithBDI: 1000,
    });
    expect(rows.find(row => row.taskId === 'task-3' && !row.compositionId)).toMatchObject({
      scheduleState: 'scheduled', financialTreatment: 'monthly', quantity: 8, totalWithBDI: 800,
    });
    expect(rows.find(row => row.taskId === 'task-2' && !row.compositionId)).toMatchObject({
      scheduleState: 'fully_suppressed', financialTreatment: 'excluded',
    });
    expect(rows.find(row => row.compositionId === 'fully-suppressed')).toMatchObject({
      scheduleState: 'fully_suppressed', financialTreatment: 'total_only', totalWithBDI: -1000,
    });
    expect(rows.find(row => row.compositionId === 'partially-suppressed')).toMatchObject({
      scheduleState: 'suspended', financialTreatment: 'total_only', totalWithBDI: -200,
    });
    const analysis = buildAdditiveScheduleAnalysisProject(preview, map);
    expect(analysis.phases.flatMap(phase => phase.tasks).map(task => task.id)).toEqual(['task-1', 'task-3', 'add-add-1-new-comp']);
  });

  it('registra e remove composições bloqueadoras de uma suspensão manual', () => {
    const withDraft = syncAdditiveScheduleDraft(project, additive.id);
    const blockedPartial = setAdditiveScheduleDependencyBlock(withDraft, additive.id, 'task-1', ['new-comp'], 'Acréscimo necessário ao sistema');
    expect(buildPreviewSuspensionMap(blockedPartial, blockedPartial.additives![0])['task-1']).toMatchObject({
      kind: 'manual', scheduleState: 'suspended', quantityRestriction: { executableQuantity: 10 },
    });
    const restoredPartial = setAdditiveScheduleDependentTask(blockedPartial, additive.id, 'task-1', false);
    expect(buildPreviewSuspensionMap(restoredPartial, restoredPartial.additives![0])['task-1']).toMatchObject({
      kind: 'quantity_limited', scheduleState: 'scheduled',
    });

    const blocked = setAdditiveScheduleDependencyBlock(withDraft, additive.id, 'task-2', ['existing-comp', 'new-comp'], 'Sistema incompleto');
    const active = blocked.additives![0];
    expect(active.scheduleDraft?.dependencyBlocks?.[0]).toMatchObject({
      taskId: 'task-2', compositionIds: ['existing-comp', 'new-comp'], note: 'Sistema incompleto',
    });
    expect(buildPreviewSuspensionMap(blocked, active)['task-2']).toMatchObject({
      kind: 'manual', scheduleState: 'suspended', blockingNote: 'Sistema incompleto',
    });
    expect(buildPreviewSuspensionMap(blocked, active)['task-2'].blockingCompositions).toHaveLength(2);
    const preview = buildAdditiveSchedulePreviewProject(blocked, active, active.scheduleDraft!);
    expect(buildAdditiveScheduleRows(blocked, active, preview).find(row => row.taskId === 'task-2' && !row.compositionId)?.blockingCompositions).toHaveLength(2);

    const released = setAdditiveScheduleDependentTask(blocked, additive.id, 'task-2', false);
    expect(released.additives![0].scheduleDraft?.dependencyBlocks).toEqual([]);
    expect(buildPreviewSuspensionMap(released, released.additives![0])['task-2']).toBeUndefined();
  });

  it('congela os bloqueadores e os inclui nos documentos', async () => {
    const withDraft = syncAdditiveScheduleDraft(project, additive.id);
    const blocked = setAdditiveScheduleDependencyBlock(withDraft, additive.id, 'task-2', ['existing-comp', 'new-comp'], 'Bomba depende do sistema completo');
    const active = blocked.additives![0];
    const preview = buildAdditiveSchedulePreviewProject(blocked, active, active.scheduleDraft!);
    const snapshot = createAdditiveScheduleSnapshot(blocked, active, preview);
    const taskRow = snapshot.rows.find(row => row.taskId === 'task-2' && !row.compositionId);
    expect(taskRow).toMatchObject({ blockingNote: 'Bomba depende do sistema completo' });
    expect(taskRow?.blockingCompositions).toHaveLength(2);

    const { workbook } = await buildAdditiveScheduleWorkbook(blocked, active, snapshot.rows);
    expect(workbook.Sheets.Atividades.Q7.v).toContain('Serviço contratado alterado');
    expect(workbook.Sheets.Atividades.R7.v).toBe('Bomba depende do sistema completo');
  });

  it('exige confirmação explícita quando as datas sugeridas não foram editadas', () => {
    const withDraft = syncAdditiveScheduleDraft(project, additive.id);
    const confirmed = confirmAdditiveScheduleDates(withDraft, additive.id);
    expect(validateAdditiveSchedule(confirmed, confirmed.additives![0])).toEqual([]);
  });

  it('copia a programação preliminar exatamente ao contratar', () => {
    let prepared = syncAdditiveScheduleDraft(project, additive.id);
    const draft = prepared.additives![0].scheduleDraft!;
    prepared = {
      ...prepared,
      additives: prepared.additives!.map(item => item.id === additive.id ? {
        ...item,
        scheduleDraft: {
          ...draft,
          plannedTasks: draft.plannedTasks.map(task => ({
            ...task,
            startDate: '2026-11-10', duration: 8, manualDuration: 8, datesConfirmed: true,
            dependencies: ['task-2'], responsible: 'Encarregado', team: 'alpha' as const, scheduleOrder: 17,
          })),
        },
      } : item),
    };
    const active = prepared.additives![0];
    const preview = buildAdditiveSchedulePreviewProject(prepared, active, active.scheduleDraft!);
    const snapshot = createAdditiveScheduleSnapshot(prepared, active, preview, 'Administrador', '2026-08-13T14:00:00.000Z');
    prepared = {
      ...prepared,
      additives: prepared.additives!.map(item => item.id === additive.id
        ? { ...item, scheduleSnapshots: [snapshot] }
        : item),
    };
    const contracted = contractAdditive(prepared, additive.id, 'Administrador');
    const task = contracted.phases[0].tasks.find(item => item.id === 'add-add-1-new-comp');
    expect(task).toMatchObject({
      startDate: '2026-11-10', duration: 8, manualDuration: 8, dependencies: ['task-2'],
      responsible: 'Encarregado', team: 'alpha', scheduleOrder: 17, originAdditiveId: additive.id,
    });
    expect(contracted.additives![0].scheduleSnapshots?.[0].contractRevisionId).toBeTruthy();
    const archivedPreview = buildProjectFromScheduleSnapshot(contracted, contracted.additives![0].scheduleSnapshots![0]);
    expect(archivedPreview.phases.flatMap(phase => phase.tasks).find(item => item.id === task?.id)).toMatchObject({
      startDate: '2026-11-10', duration: 8, dependencies: ['task-2'], responsible: 'Encarregado', team: 'alpha',
    });
  });

  it('recalcula RUP pelo saldo na prévia e pela quantidade final na contratação', () => {
    const rupProject: Project = {
      ...project,
      phases: project.phases.map(phase => ({
        ...phase,
        tasks: phase.tasks.map(task => task.id === 'task-1' ? {
          ...task,
          durationMode: 'rup' as const,
          isManual: false,
          laborCompositions: [{ id: 'labor-1', role: 'Instalador', rup: 8, workerCount: 1 }],
        } : task),
      })),
    };
    let prepared = syncAdditiveScheduleDraft(rupProject, additive.id);
    const active = prepared.additives![0];
    const preview = buildAdditiveSchedulePreviewProject(prepared, active, active.scheduleDraft!, { jornadaDiaria: 8, trabalhaSabado: false });
    const previewTask = preview.phases[0].tasks.find(task => task.id === 'task-1');
    expect(previewTask).toMatchObject({ quantity: 10, duration: 10, durationMode: 'rup' });
    expect(prepared.phases[0].tasks.find(task => task.id === 'task-1')).toMatchObject({ quantity: 10, duration: 5 });

    const editedPreview: Project = {
      ...preview,
      phases: preview.phases.map(phase => ({
        ...phase,
        tasks: phase.tasks.map(task => task.id === 'task-1' ? { ...task, startDate: '2026-09-10', team: 'alpha' as const } : task),
      })),
    };
    prepared = mergeAdditiveSchedulePreviewChanges(prepared, additive.id, preview, editedPreview);
    expect(prepared.phases[0].tasks.find(task => task.id === 'task-1')?.startDate).toBe('2026-08-10');
    const contracted = contractAdditive(prepared, additive.id, 'Administrador', { jornadaDiaria: 8, trabalhaSabado: false });
    expect(contracted.phases[0].tasks.find(task => task.id === 'task-1')).toMatchObject({
      quantity: 12, duration: 12, startDate: '2026-09-10', team: 'alpha', durationMode: 'rup',
    });
  });

  it('considera somente aditivos pendentes nos avisos do cronograma oficial', () => {
    const pending = setAdditiveScheduleDependentTask(syncAdditiveScheduleDraft(project, additive.id), additive.id, 'task-2', true);
    const ignoredStatuses: Additive[] = (['rejeitado', 'cancelado', 'aditivo_contratado'] as const).map((status, index) => ({
      ...additive,
      id: `ignored-${status}`,
      status,
      isContracted: status === 'aditivo_contratado',
      scheduleDraft: {
        version: 1,
        updatedAt: '2026-08-13T12:00:00.000Z',
        plannedTasks: [],
        dependentTaskIds: [index === 0 ? 'task-1' : 'task-2'],
      },
    }));
    const mixed = { ...pending, additives: [...pending.additives!, ...ignoredStatuses] };
    expect(Object.keys(buildPendingAdditiveSuspensionMap(mixed)).sort()).toEqual(['task-1', 'task-2']);
  });

  it('separa valores mensais e preserva supressões negativas', () => {
    const rows = [
      { taskId: '1', phaseId: 'p', phaseName: 'P', description: 'Liberado', classification: 'contracted_released' as const, statusLabel: '', startDate: '2026-08-03', duration: 5, dependencies: [], responsible: '', quantity: 1, unitPriceWithBDI: 100, totalWithBDI: 100 },
      { taskId: '2', phaseId: 'p', phaseName: 'P', description: 'Suspenso', classification: 'contracted_suspended' as const, statusLabel: '', scheduleState: 'suspended' as const, financialTreatment: 'excluded' as const, startDate: '2026-08-10', duration: 5, dependencies: [], responsible: '', quantity: 1, unitPriceWithBDI: 80, totalWithBDI: 80 },
      { taskId: '3', phaseId: 'p', phaseName: 'P', description: 'Impacto do aditivo - Supressão', classification: 'proposed_suppression' as const, statusLabel: '', scheduleState: 'fully_suppressed' as const, financialTreatment: 'total_only' as const, startDate: '2026-08-17', duration: 5, dependencies: [], responsible: '', quantity: -1, unitPriceWithBDI: 50, totalWithBDI: -50 },
      { taskId: '4', phaseId: 'p', phaseName: 'P', description: 'Novo serviço', classification: 'proposed_addition' as const, statusLabel: '', scheduleState: 'scheduled' as const, financialTreatment: 'monthly' as const, startDate: '2026-08-24', duration: 5, dependencies: [], responsible: '', quantity: 1, unitPriceWithBDI: 30, totalWithBDI: 30 },
    ];
    const forecast = buildAdditiveScheduleForecast(rows);
    expect(forecast).toMatchObject({ totalContractedReleased: 100, totalProposed: -20, totalOnlyProposed: -50 });
    expect(forecast.months.reduce((sum, month) => sum + month.proposed, 0)).toBe(30);

    const legacyForecast = buildAdditiveScheduleForecast([
      { taskId: 'legacy-1', phaseId: 'p', phaseName: 'P', description: 'Suspenso antigo', classification: 'contracted_suspended', statusLabel: '', startDate: '2026-08-10', duration: 2, dependencies: [], responsible: '', quantity: 1, unitPriceWithBDI: 80, totalWithBDI: 80 },
      { taskId: 'legacy-2', phaseId: 'p', phaseName: 'P', description: 'Impacto do aditivo - Supressão antiga', classification: 'proposed_suppression', statusLabel: '', startDate: '2026-08-10', duration: 2, dependencies: [], responsible: '', quantity: -1, unitPriceWithBDI: 10, totalWithBDI: -10 },
    ]);
    expect(legacyForecast).toMatchObject({ months: [], totalContractedReleased: 0, totalProposed: -10, totalOnlyProposed: -10 });
  });

  it('gera as três abas do Excel e um PDF paginado', async () => {
    const qaFullSuppression: AdditiveComposition = {
      id: 'qa-full-suppression', item: '1.1.3', code: 'EX-2', bank: 'SINAPI', description: 'Serviço contratado integralmente suprimido',
      quantity: 5, originalQuantity: 5, addedQuantity: 0, suppressedQuantity: 5, changeKind: 'suprimido',
      unit: 'UN', unitPriceNoBDI: 40, unitPriceWithBDI: 50, total: 250, totalWithBDI: 250,
      inputs: [], taskId: 'task-2', phaseId: 'phase-1',
    };
    const qaProject = {
      ...project,
      additives: [{ ...additive, compositions: [...additive.compositions, qaFullSuppression] }],
    };
    const withDraft = confirmAdditiveScheduleDates(syncAdditiveScheduleDraft(qaProject, additive.id), additive.id);
    const active = withDraft.additives![0];
    const preview = buildAdditiveSchedulePreviewProject(withDraft, active, active.scheduleDraft!);
    const rows = buildAdditiveScheduleRows(withDraft, active, preview);
    const { XLSX, workbook } = await buildAdditiveScheduleWorkbook(withDraft, active, rows);
    expect(workbook.SheetNames).toEqual(['Atividades', 'Gantt', 'Previsão Financeira']);
    expect(workbook.Sheets.Atividades.F6.v).toContain('EXECUTAR: 10 UN CONTRATADAS');
    expect(workbook.Sheets.Atividades.G6.v).toBeTypeOf('number');
    expect(workbook.Sheets.Atividades.F7.v).toBe('ITEM SUPRIMIDO - QUANTIDADE A EXECUTAR: 0');
    expect(workbook.Sheets.Atividades.G7.v).toBe('');
    expect(workbook.Sheets.Atividades.N7.v).toBe('');
    expect(workbook.Sheets.Gantt.B2.v).toContain('EXECUTAR: 10 UN CONTRATADAS');
    expect(workbook.Sheets.Gantt.E2.v).toBe('■');
    expect(workbook.Sheets.Gantt.E3.v).toBe('ITEM SUPRIMIDO - QUANTIDADE A EXECUTAR: 0');
    expect(Object.values(workbook.Sheets['Previsão Financeira']).some((cell: unknown) => (
      typeof cell === 'object' && cell !== null && 'v' in cell && (cell as { v?: unknown }).v === -50
    ))).toBe(true);
    const doc = await buildAdditiveSchedulePdfDocument(withDraft, active, rows);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(3);
    expect(doc.output('arraybuffer').byteLength).toBeGreaterThan(5000);
    if (process.env.ADDITIVE_SCHEDULE_QA_DIR) {
      mkdirSync(process.env.ADDITIVE_SCHEDULE_QA_DIR, { recursive: true });
      writeFileSync(join(process.env.ADDITIVE_SCHEDULE_QA_DIR, 'cronograma-aditivo-qa.pdf'), Buffer.from(doc.output('arraybuffer')));
      XLSX.writeFile(workbook, join(process.env.ADDITIVE_SCHEDULE_QA_DIR, 'cronograma-aditivo-qa.xlsx'));
    }
  });
});
