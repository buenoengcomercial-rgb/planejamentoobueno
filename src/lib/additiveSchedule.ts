import type {
  Additive,
  AdditiveComposition,
  AdditiveScheduleBlockingCompositionRef,
  AdditiveScheduleContractedTaskPlan,
  AdditiveScheduleDraft,
  AdditiveScheduleDependencyBlock,
  AdditiveScheduleFinancialTreatment,
  AdditiveSchedulePlannedTask,
  AdditiveScheduleQuantityRestriction,
  AdditiveScheduleState,
  AdditiveScheduleSnapshot,
  AdditiveScheduleSnapshotRow,
  Project,
  Task,
} from '@/types/project';
import { computeAdditiveRow, resolveAdditivePricingRule } from '@/lib/additiveImport';
import {
  calculateRupDuration,
  settleAllDependencies,
  type JornadaConfig,
  type WorkCalendar,
} from '@/lib/calculations';

export const ADDITIVE_SCHEDULE_REFERENCE = 'Termo de Retomada Parcial - SEI nº 74863858';
export const ADDITIVE_SCHEDULE_WARNING = 'PLANEJAMENTO PRELIMINAR - NÃO AUTORIZA EXECUÇÃO';
export const ADDITIVE_SCHEDULE_GUIDANCE = 'Os itens submetidos ao aditamento e os serviços deles dependentes permanecem suspensos até deliberação administrativa, formalização do termo aditivo e liberação formal da fiscalização.';
export const PROPOSED_STATUS_LABEL = 'A CONTRATAR - EXECUÇÃO NÃO AUTORIZADA';
export const SUSPENDED_STATUS_LABEL = 'SUSPENSO - AGUARDA FORMALIZAÇÃO DO ADITIVO';
export const FULLY_SUPPRESSED_STATUS_LABEL = 'ITEM SUPRIMIDO - QUANTIDADE A EXECUTAR: 0';
export const DEPENDENCY_SUSPENDED_STATUS_LABEL = 'SUSPENSO POR DEPENDÊNCIA';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = (value: string | undefined) => !!value && ISO_DATE.test(value) && !Number.isNaN(new Date(`${value}T12:00:00`).getTime());

export interface AdditiveScheduleSuspensionMeta {
  kind: 'automatic' | 'manual' | 'dependency' | 'proposed' | 'quantity_limited';
  label: string;
  reason: string;
  additiveId: string;
  additiveName: string;
  checked: boolean;
  disabled: boolean;
  scheduleState: AdditiveScheduleState;
  financialTreatment: AdditiveScheduleFinancialTreatment;
  quantityRestriction?: AdditiveScheduleQuantityRestriction;
  blockingCompositions?: AdditiveScheduleBlockingCompositionRef[];
  blockingNote?: string;
  dependencyBlockingTaskIds?: string[];
}

type AdditiveScheduleCalendar = JornadaConfig & Partial<Pick<WorkCalendar, 'uf' | 'municipio'>>;

const dependencyCalendar = (config?: AdditiveScheduleCalendar): WorkCalendar | undefined => (
  config?.uf && config?.municipio
    ? {
        uf: config.uf,
        municipio: config.municipio,
        trabalhaSabado: config.trabalhaSabado,
        jornadaDiaria: config.jornadaDiaria,
      }
    : undefined
);

export interface AdditiveScheduleQuantityTaskMeta {
  compositionId: string;
  restriction: AdditiveScheduleQuantityRestriction;
  label: string;
}

const taskIdForComposition = (additiveId: string, compositionId: string) => `add-${additiveId}-${compositionId}`;

const allPhaseTasks = (project: Project) => project.phases.flatMap(phase => phase.tasks);

const findTask = (project: Project, taskId: string | undefined) => (
  taskId ? allPhaseTasks(project).find(task => task.id === taskId) : undefined
);

const compositionTaskId = (composition: AdditiveComposition) => (
  composition.taskId ?? composition.baseTaskId ?? composition.linkedTaskId
);

export function isAdditiveSchedulePending(additive: Additive): boolean {
  if (additive.isContracted && !additive.editUnlocked) return false;
  return additive.status !== 'cancelado' && additive.status !== 'rejeitado' && additive.status !== 'reprovado';
}

export function isDirectlyChangedComposition(project: Project, composition: AdditiveComposition): boolean {
  if (composition.isNewService) return true;
  if ((composition.addedQuantity ?? 0) > 0 || (composition.suppressedQuantity ?? 0) > 0) return true;
  if (composition.changeKind === 'acrescido' || composition.changeKind === 'suprimido') return true;
  const task = findTask(project, compositionTaskId(composition));
  if (!task) return false;
  return Math.abs((composition.unitPriceWithBDI ?? 0) - (task.unitPrice ?? 0)) >= 0.01
    || Math.abs((composition.unitPriceNoBDI ?? 0) - (task.unitPriceNoBDI ?? 0)) >= 0.01;
}

/** Fonte única das composições que podem justificar uma suspensão manual. */
export function getEligibleBlockingCompositions(
  project: Project,
  additive: Additive,
): AdditiveComposition[] {
  const plannedCompositionIds = new Set(
    (additive.scheduleDraft?.plannedTasks ?? []).map(task => task.compositionId),
  );
  return additive.compositions.filter(composition => (
    plannedCompositionIds.has(composition.id)
    || isDirectlyChangedComposition(project, composition)
  ));
}

function hasUnitPriceChange(project: Project, composition: AdditiveComposition): boolean {
  const task = findTask(project, compositionTaskId(composition));
  if (!task) return false;
  const withBdi = Number(composition.unitPriceWithBDI ?? 0);
  const withoutBdi = Number(composition.unitPriceNoBDI ?? 0);
  const changedWithBdi = withBdi > 0 && Number(task.unitPrice ?? 0) > 0
    && Math.abs(withBdi - Number(task.unitPrice ?? 0)) >= 0.01;
  const changedWithoutBdi = withoutBdi > 0 && Number(task.unitPriceNoBDI ?? 0) > 0
    && Math.abs(withoutBdi - Number(task.unitPriceNoBDI ?? 0)) >= 0.01;
  return changedWithBdi || changedWithoutBdi;
}

const quantityLabel = (value: number) => Number(value || 0).toLocaleString('pt-BR', {
  minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  maximumFractionDigits: 2,
});

export function formatQuantityRestrictionLabel(restriction: AdditiveScheduleQuantityRestriction): string {
  const unit = restriction.unit ? ` ${restriction.unit}` : '';
  const parts = [restriction.suppressedQuantity > 0
    ? `EXECUTAR SALDO: ${quantityLabel(restriction.executableQuantity)}${unit}`
    : `EXECUTAR: ${quantityLabel(restriction.executableQuantity)}${unit} CONTRATADAS`];
  if (restriction.addedQuantity > 0) {
    parts.push(`ACRÉSCIMO DE ${quantityLabel(restriction.addedQuantity)}${unit} AGUARDA ADITIVO`);
  }
  if (restriction.suppressedQuantity > 0) {
    parts.push(`SUPRESSÃO PROPOSTA: ${quantityLabel(restriction.suppressedQuantity)}${unit}`);
  }
  return parts.join(' | ');
}

export function getQuantitativelyRestrictedTasks(
  project: Project,
  additive: Additive,
): Map<string, AdditiveScheduleQuantityTaskMeta> {
  const candidates = new Map<string, AdditiveComposition[]>();
  additive.compositions.forEach(composition => {
    if (composition.isNewService) return;
    const taskId = compositionTaskId(composition);
    if (!taskId) return;
    const list = candidates.get(taskId) ?? [];
    if (isDirectlyChangedComposition(project, composition)) list.push(composition);
    candidates.set(taskId, list);
  });
  const result = new Map<string, AdditiveScheduleQuantityTaskMeta>();
  candidates.forEach((compositions, taskId) => {
    // Um vínculo ambíguo entre várias composições e a mesma tarefa exige decisão manual.
    if (compositions.length !== 1) return;
    const composition = compositions[0];
    const financial = computeAdditiveRow(
      composition,
      additive.bdiPercent ?? 0,
      additive.globalDiscountPercent ?? 0,
      resolveAdditivePricingRule(additive),
    );
    const hasQuantityChange = financial.qtdAcrescida > 0 || financial.qtdSuprimida > 0;
    const executableQuantity = Math.max(0, financial.qtdContratada - financial.qtdSuprimida);
    if (!hasQuantityChange || financial.qtdContratada <= 0 || executableQuantity <= 0 || hasUnitPriceChange(project, composition)) return;
    const restriction: AdditiveScheduleQuantityRestriction = {
      kind: 'contracted_balance_only',
      contractedQuantity: financial.qtdContratada,
      executableQuantity,
      addedQuantity: financial.qtdAcrescida,
      suppressedQuantity: financial.qtdSuprimida,
      unit: composition.unit,
    };
    result.set(taskId, { compositionId: composition.id, restriction, label: formatQuantityRestrictionLabel(restriction) });
  });
  return result;
}

export function getAutomaticSuspendedTaskIds(project: Project, additive: Additive): Set<string> {
  const quantitative = getQuantitativelyRestrictedTasks(project, additive);
  return new Set(additive.compositions
    .filter(composition => !composition.isNewService && isDirectlyChangedComposition(project, composition))
    .map(compositionTaskId)
    .filter((taskId): taskId is string => !!taskId && !quantitative.has(taskId)));
}

export function isFullySuppressedComposition(additive: Additive, composition: AdditiveComposition): boolean {
  if (composition.isNewService) return false;
  const financial = computeAdditiveRow(
    composition,
    additive.bdiPercent ?? 0,
    additive.globalDiscountPercent ?? 0,
    resolveAdditivePricingRule(additive),
  );
  return financial.qtdSuprimida > 0 && financial.qtdFinal <= 0;
}

export function getFullySuppressedTaskIds(additive: Additive): Set<string> {
  return new Set(additive.compositions
    .filter(composition => isFullySuppressedComposition(additive, composition))
    .map(compositionTaskId)
    .filter((taskId): taskId is string => !!taskId));
}

function taskToContractedPlan(task: Task): AdditiveScheduleContractedTaskPlan {
  return {
    taskId: task.id,
    startDate: task.startDate,
    duration: task.duration,
    dependencies: task.dependencies ?? [],
    dependencyDetails: task.dependencyDetails,
    responsible: task.responsible ?? '',
    team: task.team,
    scheduleOrder: task.scheduleOrder,
    durationMode: task.durationMode ?? 'manual',
    isManual: task.isManual ?? (task.durationMode !== 'rup'),
    manualDuration: task.manualDuration ?? task.duration,
  };
}

function manualBlockedTaskIds(additive: Additive): Set<string> {
  return new Set([
    ...(additive.scheduleDraft?.dependentTaskIds ?? []),
    ...(additive.scheduleDraft?.dependencyBlocks ?? []).map(block => block.taskId),
  ]);
}

export function getBlockingCompositionRefs(
  additive: Additive,
  compositionIds: string[],
): AdditiveScheduleBlockingCompositionRef[] {
  const selected = new Set(compositionIds);
  return additive.compositions
    .filter(composition => selected.has(composition.id))
    .map(composition => {
      const financial = computeAdditiveRow(
        composition,
        additive.bdiPercent ?? 0,
        additive.globalDiscountPercent ?? 0,
        resolveAdditivePricingRule(additive),
      );
      return {
        compositionId: composition.id,
        item: composition.itemNumber || composition.item,
        code: composition.code,
        description: composition.description,
        quantity: composition.isNewService
          ? financial.qtdAcrescida
          : financial.qtdAcrescida - financial.qtdSuprimida,
        unit: composition.unit,
      };
    });
}

function dependencyBlockForTask(additive: Additive, taskId: string): AdditiveScheduleDependencyBlock | undefined {
  return additive.scheduleDraft?.dependencyBlocks?.find(block => block.taskId === taskId);
}

export function isStatusOnlySuspension(meta: AdditiveScheduleSuspensionMeta | undefined): boolean {
  return meta?.scheduleState === 'suspended' || meta?.scheduleState === 'fully_suppressed';
}

export function resolveAdditiveScheduleState(row: AdditiveScheduleSnapshotRow): AdditiveScheduleState {
  if (row.scheduleState) return row.scheduleState;
  if (row.classification === 'contracted_suspended' || row.description.startsWith('Impacto do aditivo - ')) {
    return 'suspended';
  }
  return 'scheduled';
}

export function resolveAdditiveScheduleFinancialTreatment(
  row: AdditiveScheduleSnapshotRow,
): AdditiveScheduleFinancialTreatment {
  if (row.financialTreatment) return row.financialTreatment;
  if (row.classification === 'contracted_suspended') return 'excluded';
  if (row.description.startsWith('Impacto do aditivo - ')) return 'total_only';
  return 'monthly';
}

export function isStatusOnlyScheduleRow(row: AdditiveScheduleSnapshotRow): boolean {
  return resolveAdditiveScheduleState(row) !== 'scheduled';
}

export function buildAdditiveScheduleAnalysisProject(
  project: Project,
  suspensionMap: Record<string, AdditiveScheduleSuspensionMeta>,
): Project {
  const statusOnlyIds = new Set(Object.entries(suspensionMap)
    .filter(([, meta]) => isStatusOnlySuspension(meta))
    .map(([taskId]) => taskId));
  if (!statusOnlyIds.size) return project;
  return {
    ...project,
    phases: project.phases.map(phase => ({
      ...phase,
      tasks: phase.tasks.filter(task => !statusOnlyIds.has(task.id)),
    })),
  };
}

/**
 * Serialização estável: ignora ordem de chaves e valores indefinidos, para que a
 * comparação do rascunho não acuse mudança apenas por ordem diferente (o que
 * gerava gravações em laço no cronograma do aditivo).
 */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/** Compara listas por `taskId`, sem depender da ordem em que foram geradas. */
function sameTaskKeyedList<T extends { taskId: string }>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  const sort = (list: T[]) => list.slice().sort((x, y) => x.taskId.localeCompare(y.taskId));
  return stableJson(sort(a)) === stableJson(sort(b));
}


function initialPlannedTask(project: Project, additive: Additive, composition: AdditiveComposition): AdditiveSchedulePlannedTask {
  return {
    compositionId: composition.id,
    taskId: taskIdForComposition(additive.id, composition.id),
    phaseId: composition.phaseId || project.phases[0]?.id || 'additive-schedule-unassigned',
    name: composition.description || 'Novo serviço do aditivo',
    startDate: additive.effectiveDate || project.startDate,
    duration: 1,
    dependencies: [],
    responsible: '',
    scheduleOrder: undefined,
    durationMode: 'manual',
    isManual: true,
    manualDuration: 1,
    datesConfirmed: false,
  };
}

export function syncAdditiveScheduleDraft(project: Project, additiveId: string, now = new Date().toISOString()): Project {
  const additive = (project.additives ?? []).find(item => item.id === additiveId);
  if (!additive || (additive.isContracted && !additive.editUnlocked)) return project;
  const version = additive.isContracted && additive.editUnlocked
    ? (additive.version ?? 0) + 1
    : Math.max(1, additive.version ?? 1);
  const previous = additive.scheduleDraft;
  const byComposition = new Map((previous?.plannedTasks ?? []).map(task => [task.compositionId, task]));
  const plannedTasks = additive.compositions
    .filter(composition => composition.isNewService)
    .map(composition => {
      const current = byComposition.get(composition.id);
      if (!current) return initialPlannedTask(project, additive, composition);
      return {
        ...current,
        taskId: taskIdForComposition(additive.id, composition.id),
        phaseId: composition.phaseId || current.phaseId,
        name: composition.description || current.name,
      };
    });
  const automatic = getAutomaticSuspendedTaskIds(project, additive);
  const validCompositionIds = new Set(additive.compositions.map(composition => composition.id));
  const dependencyBlocks = (previous?.dependencyBlocks ?? []).flatMap(block => {
    if (!findTask(project, block.taskId) || automatic.has(block.taskId)) return [];
    const compositionIds = block.compositionIds.filter(id => validCompositionIds.has(id));
    return compositionIds.length ? [{ ...block, compositionIds }] : [];
  });
  const dependentTaskIds = Array.from(new Set([
    ...(previous?.dependentTaskIds ?? []).filter(taskId => !!findTask(project, taskId) && !automatic.has(taskId)),
    ...dependencyBlocks.map(block => block.taskId),
  ]));
  const previousPlans = new Map((previous?.contractedTaskPlans ?? []).map(plan => [plan.taskId, plan]));
  const validTaskIds = new Set(allPhaseTasks(project).map(task => task.id));
  const requiredPlanIds = new Set([
    ...Array.from(previousPlans.keys()).filter(taskId => validTaskIds.has(taskId)),
    ...getQuantitativelyRestrictedTasks(project, additive).keys(),
  ]);
  const contractedTaskPlans = Array.from(requiredPlanIds).flatMap(taskId => {
    const task = findTask(project, taskId);
    if (!task) return [];
    return [previousPlans.get(taskId) ?? taskToContractedPlan(task)];
  });
  const changed = !previous
    || previous.version !== version
    || JSON.stringify(previous.plannedTasks) !== JSON.stringify(plannedTasks)
    || JSON.stringify(previous.dependentTaskIds) !== JSON.stringify(dependentTaskIds)
    || JSON.stringify(previous.contractedTaskPlans ?? []) !== JSON.stringify(contractedTaskPlans)
    || JSON.stringify(previous.dependencyBlocks ?? []) !== JSON.stringify(dependencyBlocks);
  if (!changed) return project;
  const scheduleDraft: AdditiveScheduleDraft = {
    version,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    dependentTaskIds,
    plannedTasks,
    contractedTaskPlans,
    dependencyBlocks,
  };
  return {
    ...project,
    additives: (project.additives ?? []).map(item => item.id === additiveId ? { ...item, scheduleDraft } : item),
  };
}

/** Persists only the visual collapse preference of one additive schedule. */
export function setAdditiveScheduleCollapsedPhaseIds(
  project: Project,
  additiveId: string,
  phaseIds: string[],
): Project {
  const normalized = [...new Set(phaseIds)].sort();
  const additive = (project.additives ?? []).find(item => item.id === additiveId);
  if (!additive) return project;
  const previous = [...(additive.uiState?.scheduleCollapsedPhaseIds ?? [])].sort();
  const same = normalized.length === previous.length
    && normalized.every((phaseId, index) => phaseId === previous[index]);
  if (same) return project;

  return {
    ...project,
    additives: (project.additives ?? []).map(item => item.id === additiveId
      ? {
          ...item,
          uiState: {
            ...(item.uiState ?? {}),
            scheduleCollapsedPhaseIds: normalized,
          },
        }
      : item),
  };
}

export function createAdditiveScheduleRevisionDraft(project: Project, additiveId: string, now = new Date().toISOString()): AdditiveScheduleDraft | undefined {
  const additive = (project.additives ?? []).find(item => item.id === additiveId);
  if (!additive) return undefined;
  const previous = additive.scheduleDraft;
  const plannedTasks = additive.compositions.filter(composition => composition.isNewService).map(composition => {
    const linked = findTask(project, composition.linkedTaskId || taskIdForComposition(additive.id, composition.id));
    const prior = previous?.plannedTasks.find(task => task.compositionId === composition.id);
    return {
      ...initialPlannedTask(project, additive, composition),
      ...(prior ?? {}),
      ...(linked ? {
        taskId: taskIdForComposition(additive.id, composition.id),
        phaseId: linked.phase,
        name: linked.name,
        startDate: linked.startDate,
        duration: linked.duration,
        dependencies: linked.dependencies ?? [],
        dependencyDetails: linked.dependencyDetails,
        responsible: linked.responsible,
        team: linked.team,
        scheduleOrder: linked.scheduleOrder,
        durationMode: linked.durationMode,
        isManual: linked.isManual,
        manualDuration: linked.manualDuration,
        datesConfirmed: true,
      } : {}),
    };
  });
  return {
    version: (additive.version ?? 0) + 1,
    createdAt: now,
    updatedAt: now,
    dependentTaskIds: previous?.dependentTaskIds ?? [],
    plannedTasks,
    contractedTaskPlans: previous?.contractedTaskPlans ?? [],
    dependencyBlocks: previous?.dependencyBlocks ?? [],
  };
}

function plannedTaskToTask(project: Project, additive: Additive, planned: AdditiveSchedulePlannedTask): Task {
  const composition = additive.compositions.find(item => item.id === planned.compositionId);
  const row = composition
    ? computeAdditiveRow(composition, additive.bdiPercent ?? 0, additive.globalDiscountPercent ?? 0, resolveAdditivePricingRule(additive))
    : undefined;
  return {
    id: planned.taskId,
    name: planned.name,
    phase: planned.phaseId,
    startDate: planned.startDate,
    duration: Math.max(1, planned.duration || 1),
    dependencies: planned.dependencies ?? [],
    dependencyDetails: planned.dependencyDetails,
    responsible: planned.responsible ?? '',
    percentComplete: 0,
    materials: [],
    level: 0,
    team: planned.team,
    scheduleOrder: planned.scheduleOrder,
    durationMode: planned.durationMode ?? 'manual',
    isManual: planned.isManual ?? true,
    manualDuration: planned.manualDuration ?? planned.duration,
    quantity: composition?.addedQuantity ?? composition?.quantity ?? 0,
    unit: composition?.unit,
    unitPrice: row?.unitPriceWithBDI ?? 0,
    unitPriceNoBDI: row?.unitPriceNoBDI ?? 0,
    itemCode: composition?.code,
    priceBank: composition?.bank,
    originAdditiveId: additive.id,
    originAdditiveName: `${additive.name} (prévia)`,
    originAdditiveVersion: planned.datesConfirmed ? additive.version : undefined,
  };
}

function buildAdditiveSchedulePreviewBase(
  project: Project,
  additive: Additive,
  draft: AdditiveScheduleDraft,
  jornadaConfig?: AdditiveScheduleCalendar,
): Project {
  const plannedByPhase = new Map<string, Task[]>();
  draft.plannedTasks.forEach(planned => {
    const tasks = plannedByPhase.get(planned.phaseId) ?? [];
    tasks.push(plannedTaskToTask(project, additive, planned));
    plannedByPhase.set(planned.phaseId, tasks);
  });
  const plannedIds = new Set(draft.plannedTasks.map(task => task.taskId));
  const quantityRestrictions = getQuantitativelyRestrictedTasks(project, additive);
  const contractedPlans = new Map((draft.contractedTaskPlans ?? []).map(plan => [plan.taskId, plan]));
  let phases = project.phases.map(phase => ({
    ...phase,
    tasks: [
      ...phase.tasks.filter(task => !plannedIds.has(task.id)).map(task => {
        const restricted = quantityRestrictions.get(task.id);
        const storedPlan = contractedPlans.get(task.id);
        if (!restricted && !storedPlan) return task;
        const plan = storedPlan ?? taskToContractedPlan(task);
        let previewTask: Task = {
          ...task,
          startDate: plan.startDate,
          duration: plan.duration,
          dependencies: plan.dependencies ?? [],
          dependencyDetails: plan.dependencyDetails,
          responsible: plan.responsible,
          team: plan.team,
          scheduleOrder: plan.scheduleOrder,
          durationMode: plan.durationMode,
          isManual: plan.isManual,
          manualDuration: plan.manualDuration,
          quantity: restricted?.restriction.executableQuantity ?? task.quantity,
        };
        if ((previewTask.durationMode ?? 'manual') === 'rup') {
          const calculated = calculateRupDuration(previewTask, jornadaConfig);
          previewTask = { ...previewTask, ...calculated, calculatedDuration: calculated.duration };
        }
        return previewTask;
      }),
      ...(plannedByPhase.get(phase.id) ?? []),
    ],
  }));
  const orphaned = draft.plannedTasks.filter(task => !phases.some(phase => phase.id === task.phaseId));
  if (orphaned.length) {
    phases = [...phases, {
      id: 'additive-schedule-unassigned',
      name: 'SERVIÇOS DO ADITIVO SEM CAPÍTULO',
      color: '#f97316',
      tasks: orphaned.map(task => plannedTaskToTask(project, additive, { ...task, phaseId: 'additive-schedule-unassigned' })),
    }];
  }
  return { ...project, phases };
}

export function buildAdditiveSchedulePreviewProject(
  project: Project,
  additive: Additive,
  draft: AdditiveScheduleDraft,
  jornadaConfig?: AdditiveScheduleCalendar,
): Project {
  const preview = buildAdditiveSchedulePreviewBase(project, additive, draft, jornadaConfig);
  return settleAllDependencies(preview, dependencyCalendar(jornadaConfig));
}

export function mergeAdditiveSchedulePreviewChanges(
  project: Project,
  additiveId: string,
  previousPreview: Project,
  nextPreview: Project,
  now = new Date().toISOString(),
): Project {
  const additive = (project.additives ?? []).find(item => item.id === additiveId);
  const draft = additive?.scheduleDraft;
  if (!additive || !draft) return project;
  const plannedIds = new Set(draft.plannedTasks.map(task => task.taskId));
  const restrictedIds = new Set(getQuantitativelyRestrictedTasks(project, additive).keys());
  const nextTasks = new Map(allPhaseTasks(nextPreview).map(task => [task.id, task]));
  const previousTasks = new Map(allPhaseTasks(previousPreview).map(task => [task.id, task]));
  const plannedTasks = draft.plannedTasks.map(planned => {
    const next = nextTasks.get(planned.taskId);
    if (!next) return planned;
    const previous = previousTasks.get(planned.taskId);
    const datesChanged = !!previous && (previous.startDate !== next.startDate || previous.duration !== next.duration);
    return {
      ...planned,
      name: next.name,
      phaseId: next.phase,
      startDate: next.startDate,
      duration: next.duration,
      dependencies: next.dependencies ?? [],
      dependencyDetails: next.dependencyDetails,
      responsible: next.responsible,
      team: next.team,
      scheduleOrder: next.scheduleOrder,
      durationMode: next.durationMode,
      isManual: next.isManual,
      manualDuration: next.manualDuration,
      datesConfirmed: planned.datesConfirmed || datesChanged,
    };
  });
  const existingPlans = new Map((draft.contractedTaskPlans ?? []).map(plan => [plan.taskId, plan]));
  const contractedTaskPlans = project.phases.flatMap(phase => phase.tasks).flatMap(baseTask => {
    if (plannedIds.has(baseTask.id)) return [];
    const next = nextTasks.get(baseTask.id);
    if (!next) return [];
    const nextPlan = taskToContractedPlan(next);
    const basePlan = taskToContractedPlan(baseTask);
    const changedFromOfficial = JSON.stringify(nextPlan) !== JSON.stringify(basePlan);
    if (!restrictedIds.has(baseTask.id) && !existingPlans.has(baseTask.id) && !changedFromOfficial) return [];
    if (!restrictedIds.has(baseTask.id) && !changedFromOfficial) return [];
    return [nextPlan];
  });
  const unchanged = JSON.stringify(draft.plannedTasks) === JSON.stringify(plannedTasks)
    && JSON.stringify(draft.contractedTaskPlans ?? []) === JSON.stringify(contractedTaskPlans);
  if (unchanged) return project;
  const scheduleDraft = { ...draft, plannedTasks, contractedTaskPlans, updatedAt: now };
  return {
    ...project,
    additives: (project.additives ?? []).map(item => item.id === additiveId ? { ...item, scheduleDraft } : item),
  };
}

/** Reabre o rascunho, resolve toda a rede e grava apenas os ajustes isolados do aditivo. */
export function settleAdditiveScheduleDraft(
  project: Project,
  additiveId: string,
  jornadaConfig?: AdditiveScheduleCalendar,
  now = new Date().toISOString(),
): Project {
  const additive = (project.additives ?? []).find(item => item.id === additiveId);
  const draft = additive?.scheduleDraft;
  if (!additive || !draft || (additive.isContracted && !additive.editUnlocked)) return project;
  const previousPreview = buildAdditiveSchedulePreviewBase(project, additive, draft, jornadaConfig);
  const settledPreview = settleAllDependencies(previousPreview, dependencyCalendar(jornadaConfig));
  return mergeAdditiveSchedulePreviewChanges(project, additiveId, previousPreview, settledPreview, now);
}

export function setAdditiveScheduleDependentTask(project: Project, additiveId: string, taskId: string, checked: boolean): Project {
  const additive = (project.additives ?? []).find(item => item.id === additiveId);
  if (!additive?.scheduleDraft) return project;
  if (getAutomaticSuspendedTaskIds(project, additive).has(taskId)) return project;
  const ids = new Set(additive.scheduleDraft.dependentTaskIds);
  if (checked) ids.add(taskId); else ids.delete(taskId);
  const dependencyBlocks = checked
    ? additive.scheduleDraft.dependencyBlocks ?? []
    : (additive.scheduleDraft.dependencyBlocks ?? []).filter(block => block.taskId !== taskId);
  const scheduleDraft = { ...additive.scheduleDraft, dependentTaskIds: [...ids], dependencyBlocks, updatedAt: new Date().toISOString() };
  return { ...project, additives: (project.additives ?? []).map(item => item.id === additiveId ? { ...item, scheduleDraft } : item) };
}

export function setAdditiveScheduleDependencyBlock(
  project: Project,
  additiveId: string,
  taskId: string,
  compositionIds: string[],
  note?: string,
): Project {
  const additive = (project.additives ?? []).find(item => item.id === additiveId);
  if (!additive?.scheduleDraft || getAutomaticSuspendedTaskIds(project, additive).has(taskId)) return project;
  const validIds = new Set(
    getEligibleBlockingCompositions(project, additive).map(composition => composition.id),
  );
  const selected = Array.from(new Set(compositionIds.filter(id => validIds.has(id))));
  if (!selected.length) return setAdditiveScheduleDependentTask(project, additiveId, taskId, false);
  const ids = new Set(additive.scheduleDraft.dependentTaskIds);
  ids.add(taskId);
  const dependencyBlocks = [
    ...(additive.scheduleDraft.dependencyBlocks ?? []).filter(block => block.taskId !== taskId),
    { taskId, compositionIds: selected, note: note?.trim() || undefined },
  ];
  const scheduleDraft: AdditiveScheduleDraft = {
    ...additive.scheduleDraft,
    dependentTaskIds: [...ids],
    dependencyBlocks,
    updatedAt: new Date().toISOString(),
  };
  return { ...project, additives: (project.additives ?? []).map(item => item.id === additiveId ? { ...item, scheduleDraft } : item) };
}

export function confirmAdditiveScheduleDates(project: Project, additiveId: string, compositionIds?: string[]): Project {
  const additive = (project.additives ?? []).find(item => item.id === additiveId);
  if (!additive?.scheduleDraft) return project;
  const selected = compositionIds ? new Set(compositionIds) : null;
  const plannedTasks = additive.scheduleDraft.plannedTasks.map(task => (
    !selected || selected.has(task.compositionId) ? { ...task, datesConfirmed: true } : task
  ));
  const scheduleDraft = { ...additive.scheduleDraft, plannedTasks, updatedAt: new Date().toISOString() };
  return { ...project, additives: (project.additives ?? []).map(item => item.id === additiveId ? { ...item, scheduleDraft } : item) };
}

export function validateAdditiveSchedule(project: Project, additive: Additive): string[] {
  const draft = additive.scheduleDraft;
  const plannedByComposition = new Map((draft?.plannedTasks ?? []).map(task => [task.compositionId, task]));
  return additive.compositions
    .filter(composition => composition.isNewService && (composition.addedQuantity ?? composition.quantity ?? 0) > 0)
    .flatMap(composition => {
      const task = plannedByComposition.get(composition.id);
      if (!task) return [`${composition.itemNumber || composition.item || composition.code || composition.description}: sem programação preliminar.`];
      const problems: string[] = [];
      if (!isValidDate(task.startDate)) problems.push('data de início inválida');
      if (!Number.isFinite(task.duration) || task.duration < 1) problems.push('duração menor que 1 dia');
      if (!task.datesConfirmed) problems.push('datas ainda não confirmadas');
      return problems.length ? [`${composition.itemNumber || composition.item || composition.code || composition.description}: ${problems.join(', ')}.`] : [];
    });
}

export function buildPreviewSuspensionMap(
  project: Project,
  additive: Additive,
  previewProject: Project = project,
): Record<string, AdditiveScheduleSuspensionMeta> {
  const quantitative = getQuantitativelyRestrictedTasks(project, additive);
  const automatic = getAutomaticSuspendedTaskIds(project, additive);
  const fullySuppressed = getFullySuppressedTaskIds(additive);
  const manual = manualBlockedTaskIds(additive);
  const result: Record<string, AdditiveScheduleSuspensionMeta> = {};
  quantitative.forEach((meta, taskId) => {
    result[taskId] = {
      kind: 'quantity_limited', label: meta.label, reason: 'A execução está limitada ao saldo contratado indicado; os impactos adicionais permanecem sem programação até a formalização.',
      additiveId: additive.id, additiveName: additive.name, checked: false, disabled: false,
      scheduleState: 'scheduled', financialTreatment: 'monthly', quantityRestriction: meta.restriction,
    };
  });
  automatic.forEach(taskId => {
    const isFullySuppressed = fullySuppressed.has(taskId);
    result[taskId] = {
      kind: 'automatic', label: isFullySuppressed ? FULLY_SUPPRESSED_STATUS_LABEL : SUSPENDED_STATUS_LABEL, reason: ADDITIVE_SCHEDULE_GUIDANCE,
      additiveId: additive.id, additiveName: additive.name, checked: true, disabled: true,
      scheduleState: isFullySuppressed ? 'fully_suppressed' : 'suspended', financialTreatment: 'excluded',
    };
  });
  manual.forEach(taskId => {
    if (result[taskId]?.kind === 'automatic') return;
    const block = dependencyBlockForTask(additive, taskId);
    result[taskId] = {
      kind: 'manual', label: SUSPENDED_STATUS_LABEL, reason: ADDITIVE_SCHEDULE_GUIDANCE,
      additiveId: additive.id, additiveName: additive.name, checked: true, disabled: false,
      scheduleState: 'suspended', financialTreatment: 'excluded',
      quantityRestriction: quantitative.get(taskId)?.restriction,
      blockingCompositions: block ? getBlockingCompositionRefs(additive, block.compositionIds) : undefined,
      blockingNote: block?.note,
    };
  });
  (additive.scheduleDraft?.plannedTasks ?? []).forEach(task => {
    result[task.taskId] = {
      kind: 'proposed', label: PROPOSED_STATUS_LABEL, reason: ADDITIVE_SCHEDULE_GUIDANCE,
      additiveId: additive.id, additiveName: additive.name, checked: true, disabled: true,
      scheduleState: 'scheduled', financialTreatment: 'monthly',
    };
  });

  const previewTasks = allPhaseTasks(previewProject);
  const taskById = new Map(previewTasks.map(task => [task.id, task]));
  const successors = new Map<string, Set<string>>();
  previewTasks.forEach(task => {
    const predecessorIds = task.dependencyDetails?.length
      ? task.dependencyDetails.map(dependency => dependency.taskId)
      : task.dependencies ?? [];
    predecessorIds.forEach(predecessorId => {
      if (!taskById.has(predecessorId) || predecessorId === task.id) return;
      const ids = successors.get(predecessorId) ?? new Set<string>();
      ids.add(task.id);
      successors.set(predecessorId, ids);
    });
  });

  // Itens suspensos e serviços ainda a contratar são raízes de bloqueio operacional.
  const directBlockingIds = new Set(Object.entries(result)
    .filter(([, meta]) => isStatusOnlySuspension(meta) || meta.kind === 'proposed')
    .map(([taskId]) => taskId));
  const rootBlockingIds = new Map<string, Set<string>>(
    Array.from(directBlockingIds).map(taskId => [taskId, new Set([taskId])]),
  );
  const queue = Array.from(directBlockingIds);

  while (queue.length) {
    const predecessorId = queue.shift()!;
    const predecessorRoots = rootBlockingIds.get(predecessorId) ?? new Set([predecessorId]);
    for (const successorId of successors.get(predecessorId) ?? []) {
      // Uma causa direta conserva sua classificação, mas continua propagando o bloqueio.
      if (directBlockingIds.has(successorId)) continue;
      const existingRoots = rootBlockingIds.get(successorId) ?? new Set<string>();
      const nextRoots = new Set([...existingRoots, ...predecessorRoots]);
      if (nextRoots.size === existingRoots.size) continue;
      rootBlockingIds.set(successorId, nextRoots);

      const sourceNames = Array.from(nextRoots).map(taskId => (
        taskById.get(taskId)?.name ?? taskId
      ));
      const sourceLabel = sourceNames.join(', ');
      const previousMeta = result[successorId];
      result[successorId] = {
        kind: 'dependency',
        label: `${DEPENDENCY_SUSPENDED_STATUS_LABEL} — ${sourceLabel}`,
        reason: `A execução depende de ${sourceLabel}, que permanece sem autorização para execução.`,
        additiveId: additive.id,
        additiveName: additive.name,
        checked: true,
        disabled: true,
        scheduleState: 'suspended',
        financialTreatment: 'excluded',
        quantityRestriction: previousMeta?.quantityRestriction,
        dependencyBlockingTaskIds: Array.from(nextRoots),
      };
      queue.push(successorId);
    }
  }
  return result;
}

export function buildPendingAdditiveSuspensionMap(project: Project): Record<string, AdditiveScheduleSuspensionMeta> {
  const result: Record<string, AdditiveScheduleSuspensionMeta> = {};
  (project.additives ?? []).filter(isAdditiveSchedulePending).forEach(additive => {
    const previewProject = additive.scheduleDraft
      ? buildAdditiveSchedulePreviewProject(project, additive, additive.scheduleDraft)
      : project;
    const suspensionMap = buildPreviewSuspensionMap(project, additive, previewProject);
    Object.entries(suspensionMap).forEach(([taskId, meta]) => {
      if (meta.kind === 'proposed') return;
      const previous = result[taskId];
      if (!previous) {
        result[taskId] = meta;
        return;
      }
      const previousStatusOnly = isStatusOnlySuspension(previous);
      const nextStatusOnly = isStatusOnlySuspension(meta);
      const selected = nextStatusOnly && !previousStatusOnly ? meta : previous;
      result[taskId] = { ...selected, additiveName: `${previous.additiveName}; ${meta.additiveName}` };
    });
  });
  return result;
}

function taskValue(task: Task, quantity = task.quantity ?? 0): number {
  return Number((quantity * (task.unitPrice ?? 0)).toFixed(2));
}

export function buildAdditiveScheduleRows(project: Project, additive: Additive, preview: Project): AdditiveScheduleSnapshotRow[] {
  const phaseName = new Map(preview.phases.map(phase => [phase.id, phase.name]));
  const fullySuppressed = getFullySuppressedTaskIds(additive);
  const quantitative = getQuantitativelyRestrictedTasks(project, additive);
  const plannedIds = new Set(additive.scheduleDraft?.plannedTasks.map(task => task.taskId) ?? []);
  const suspensionMap = buildPreviewSuspensionMap(project, additive, preview);
  const rows: AdditiveScheduleSnapshotRow[] = [];
  preview.phases.forEach(phase => phase.tasks.forEach(task => {
    if (plannedIds.has(task.id)) return;
    const suspension = suspensionMap[task.id];
    const suspended = isStatusOnlySuspension(suspension);
    const restriction = quantitative.get(task.id)?.restriction;
    const block = dependencyBlockForTask(additive, task.id);
    const blockingCompositions = suspension?.blockingCompositions
      ?? (block ? getBlockingCompositionRefs(additive, block.compositionIds) : undefined);
    const scheduleState: AdditiveScheduleState = suspension?.scheduleState
      ?? (fullySuppressed.has(task.id) ? 'fully_suppressed' : suspended ? 'suspended' : 'scheduled');
    rows.push({
      taskId: task.id,
      phaseId: phase.id,
      phaseName: phase.name,
      item: task.contractItem,
      code: task.itemCode,
      description: task.name,
      classification: suspended ? 'contracted_suspended' : 'contracted_released',
      statusLabel: suspension?.label
        ?? (scheduleState === 'fully_suppressed'
          ? FULLY_SUPPRESSED_STATUS_LABEL
          : suspended ? SUSPENDED_STATUS_LABEL
            : restriction ? formatQuantityRestrictionLabel(restriction)
              : 'CONTRATADO - LIBERADO PARA PLANEJAMENTO'),
      scheduleState,
      financialTreatment: suspension?.financialTreatment ?? (suspended ? 'excluded' : 'monthly'),
      quantityRestriction: restriction,
      blockingCompositions,
      blockingNote: block?.note,
      dependencyBlockingTaskIds: suspension?.dependencyBlockingTaskIds,
      suspensionReason: suspension?.kind === 'dependency' ? suspension.reason : undefined,
      startDate: task.startDate,
      duration: task.duration,
      dependencies: task.dependencies ?? [],
      dependencyDetails: task.dependencyDetails,
      responsible: task.responsible,
      team: task.team,
      scheduleOrder: task.scheduleOrder,
      durationMode: task.durationMode,
      isManual: task.isManual,
      manualDuration: task.manualDuration,
      quantity: restriction?.executableQuantity ?? task.quantity ?? 0,
      unit: task.unit,
      unitPriceWithBDI: task.unitPrice ?? 0,
      totalWithBDI: taskValue(task, restriction?.executableQuantity ?? task.quantity ?? 0),
    });
  }));

  const previewTasks = new Map(allPhaseTasks(preview).map(task => [task.id, task]));
  additive.compositions.filter(composition => isDirectlyChangedComposition(project, composition)).forEach(composition => {
    const sourceTaskId = composition.isNewService
      ? taskIdForComposition(additive.id, composition.id)
      : compositionTaskId(composition);
    const task = sourceTaskId ? previewTasks.get(sourceTaskId) : undefined;
    if (!task) return;
    const financial = computeAdditiveRow(composition, additive.bdiPercent ?? 0, additive.globalDiscountPercent ?? 0, resolveAdditivePricingRule(additive));
    const impact = financial.diferenca;
    if (!composition.isNewService && Math.abs(impact) < 0.005) return;
    const fullySuppressedImpact = !composition.isNewService && isFullySuppressedComposition(additive, composition);
    rows.push({
      taskId: task.id,
      compositionId: composition.id,
      phaseId: task.phase,
      phaseName: phaseName.get(task.phase) ?? composition.phaseChain ?? 'Sem capítulo',
      item: composition.itemNumber || composition.item,
      code: composition.code,
      description: composition.isNewService ? composition.description : `Impacto do aditivo - ${composition.description}`,
      classification: impact < 0 ? 'proposed_suppression' : 'proposed_addition',
      statusLabel: fullySuppressedImpact ? FULLY_SUPPRESSED_STATUS_LABEL : PROPOSED_STATUS_LABEL,
      scheduleState: composition.isNewService ? 'scheduled' : fullySuppressedImpact ? 'fully_suppressed' : 'suspended',
      financialTreatment: composition.isNewService ? 'monthly' : 'total_only',
      startDate: task.startDate,
      duration: task.duration,
      dependencies: task.dependencies ?? [],
      dependencyDetails: task.dependencyDetails,
      responsible: task.responsible,
      team: task.team,
      scheduleOrder: task.scheduleOrder,
      durationMode: task.durationMode,
      isManual: task.isManual,
      manualDuration: task.manualDuration,
      quantity: composition.isNewService ? financial.qtdAcrescida : financial.qtdAcrescida - financial.qtdSuprimida,
      unit: composition.unit,
      unitPriceWithBDI: financial.unitPriceWithBDI,
      totalWithBDI: impact,
    });
  });
  return rows;
}

export function createAdditiveScheduleSnapshot(
  project: Project,
  additive: Additive,
  preview: Project,
  user?: string,
  archivedAt = new Date().toISOString(),
): AdditiveScheduleSnapshot {
  const version = additive.scheduleDraft?.version ?? additive.version ?? 1;
  return {
    id: `additive-schedule-${additive.id}-v${version}`,
    version,
    archivedAt,
    archivedBy: user,
    referenceDocument: ADDITIVE_SCHEDULE_REFERENCE,
    phases: preview.phases.map(phase => ({
      id: phase.id,
      name: phase.name,
      parentId: phase.parentId,
      order: phase.order,
      customNumber: phase.customNumber,
    })),
    rows: buildAdditiveScheduleRows(project, additive, preview),
  };
}

export function buildProjectFromScheduleSnapshot(project: Project, snapshot: AdditiveScheduleSnapshot): Project {
  const originalPhaseById = new Map(project.phases.map(phase => [phase.id, phase]));
  const phases: Project['phases'] = (snapshot.phases ?? []).map(phase => ({
    ...phase,
    color: originalPhaseById.get(phase.id)?.color ?? '#64748b',
    tasks: [],
  }));
  snapshot.rows.reduce<Project['phases']>((acc, row) => {
    if (row.compositionId && row.description.startsWith('Impacto do aditivo - ')) return acc;
    let phase = acc.find(item => item.id === row.phaseId);
    if (!phase) {
      phase = { id: row.phaseId, name: row.phaseName, color: '#64748b', tasks: [] };
      acc.push(phase);
    }
    if (phase.tasks.some(task => task.id === row.taskId)) return acc;
    phase.tasks.push({
      id: row.taskId,
      name: row.description,
      phase: row.phaseId,
      startDate: row.startDate,
      duration: row.duration,
      dependencies: row.dependencies,
      dependencyDetails: row.dependencyDetails,
      responsible: row.responsible,
      percentComplete: 0,
      materials: [],
      level: 0,
      team: row.team,
      scheduleOrder: row.scheduleOrder,
      durationMode: row.durationMode,
      isManual: row.isManual,
      manualDuration: row.manualDuration,
      quantity: row.quantity,
      unit: row.unit,
      unitPrice: row.unitPriceWithBDI,
      itemCode: row.code,
      contractItem: row.item,
    });
    return acc;
  }, phases);
  return { ...project, phases };
}
