import type { Additive, AdditiveComposition, BudgetItem, Phase, Project, Task } from '@/types/project';

const TEST_PROJECT_TASK_LIMIT = 15;

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function taskEndTime(task: Task): number {
  const start = Date.parse(task.startDate || '');
  if (!Number.isFinite(start)) return 0;
  const days = Math.max(1, Number(task.duration) || 1);
  return start + (days - 1) * 24 * 60 * 60 * 1000;
}

function isFullySuppressed(task: Task): boolean {
  if (task.suppressedByAdditive) return true;
  const qty = Number(task.quantity ?? 0);
  if (qty <= 0 && (task.additiveHistory ?? []).some(h => h.kind === 'supressao' && h.newQuantity <= 0)) return true;
  return false;
}

function isCompositionFullySuppressed(composition: AdditiveComposition): boolean {
  const qty = Number(composition.quantity ?? 0);
  const suppressed = Number(composition.suppressedQuantity ?? 0);
  const finalQty = Math.max(0, qty + Number(composition.addedQuantity ?? 0) - suppressed);
  return composition.changeKind === 'suprimido' && finalQty <= 0;
}

function walkTasks(tasks: Task[], visitor: (task: Task) => void) {
  for (const task of tasks) {
    visitor(task);
    if (task.children?.length) walkTasks(task.children, visitor);
  }
}

function getApprovedAdditiveTaskIds(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const additive of project.additives ?? []) {
    const approved = additive.status === 'aprovado' || additive.status === 'aditivo_contratado' || additive.isContracted;
    if (!approved) continue;
    for (const composition of additive.compositions ?? []) {
      if (isCompositionFullySuppressed(composition)) continue;
      const taskId = composition.linkedTaskId ?? composition.taskId;
      if (taskId) ids.add(taskId);
    }
  }
  return ids;
}

function selectTaskIds(project: Project, limit = TEST_PROJECT_TASK_LIMIT): Set<string> {
  const approvedIds = getApprovedAdditiveTaskIds(project);
  const preferredScope = approvedIds.size > 0 ? approvedIds : null;
  const selected = new Set<string>();

  for (const phase of project.phases ?? []) {
    walkTasks(phase.tasks ?? [], task => {
      if (selected.size >= limit) return;
      if (isFullySuppressed(task)) return;
      if (preferredScope && !preferredScope.has(task.id)) return;
      selected.add(task.id);
    });
    if (selected.size >= limit) break;
  }

  return selected;
}

function pruneTask(task: Task, selectedIds: Set<string>): Task | null {
  const children = (task.children ?? [])
    .map(child => pruneTask(child, selectedIds))
    .filter(Boolean) as Task[];

  if (!selectedIds.has(task.id) && children.length === 0) return null;

  const next: Task = clone(task);
  next.dependencies = (next.dependencies ?? []).filter(id => selectedIds.has(id));
  if (next.dependencyDetails?.length) {
    next.dependencyDetails = next.dependencyDetails.filter(dep => selectedIds.has(dep.taskId));
  }
  next.percentComplete = 0;
  next.dailyLogs = [];
  next.executedQuantityTotal = 0;
  next.remainingQuantity = next.quantity ?? next.remainingQuantity;
  next.accumulatedDelayQuantity = 0;
  next.physicalProgress = 0;
  next.children = children.length > 0 ? children : undefined;
  return next;
}

function prunePhases(project: Project, selectedIds: Set<string>): Phase[] {
  const kept: Phase[] = [];
  const keptPhaseIds = new Set<string>();

  for (const phase of project.phases ?? []) {
    const tasks = (phase.tasks ?? [])
      .map(task => pruneTask(task, selectedIds))
      .filter(Boolean) as Task[];
    if (tasks.length === 0) continue;
    kept.push({ ...clone(phase), tasks });
    keptPhaseIds.add(phase.id);
  }

  let addedParent = true;
  while (addedParent) {
    addedParent = false;
    for (const phase of project.phases ?? []) {
      if (!phase.parentId || !keptPhaseIds.has(phase.id)) continue;
      if (keptPhaseIds.has(phase.parentId)) continue;
      const parent = project.phases.find(p => p.id === phase.parentId);
      if (!parent) continue;
      kept.unshift({ ...clone(parent), tasks: [] });
      keptPhaseIds.add(parent.id);
      addedParent = true;
    }
  }

  return kept;
}

function taskMatchesBudget(task: Task, item: BudgetItem): boolean {
  if (item.taskId && item.taskId === task.id) return true;
  if (task.itemCode && item.code && task.itemCode === item.code) return true;
  return item.description?.trim().toLowerCase() === task.name?.trim().toLowerCase();
}

function taskMatchesComposition(task: Task, composition: AdditiveComposition): boolean {
  const linked = composition.linkedTaskId ?? composition.taskId;
  if (linked && linked === task.id) return true;
  if (task.itemCode && composition.code && task.itemCode === composition.code) return true;
  return composition.description?.trim().toLowerCase() === task.name?.trim().toLowerCase();
}

function selectedTasksFromPhases(phases: Phase[]): Task[] {
  const tasks: Task[] = [];
  for (const phase of phases) walkTasks(phase.tasks ?? [], task => tasks.push(task));
  return tasks;
}

function filterBudgetItems(project: Project, tasks: Task[]): BudgetItem[] {
  return (project.budgetItems ?? []).filter(item => tasks.some(task => taskMatchesBudget(task, item)));
}

function filterAdditives(project: Project, tasks: Task[]): Additive[] {
  const hasApprovedAdditive = (project.additives ?? []).some(additive =>
    additive.status === 'aprovado' || additive.status === 'aditivo_contratado' || additive.isContracted
  );

  return (project.additives ?? [])
    .filter(additive => {
      if (!hasApprovedAdditive) return true;
      return additive.status === 'aprovado' || additive.status === 'aditivo_contratado' || additive.isContracted;
    })
    .map(additive => {
      const compositions = (additive.compositions ?? []).filter(comp =>
        !isCompositionFullySuppressed(comp) && tasks.some(task => taskMatchesComposition(task, comp))
      );
      return compositions.length > 0 ? { ...clone(additive), compositions } : null;
    })
    .filter(Boolean) as Additive[];
}

function filterAnalyticCompositions(project: Project, tasks: Task[]): AdditiveComposition[] {
  return (project.analyticCompositions ?? []).filter(comp =>
    tasks.some(task => taskMatchesComposition(task, comp))
  );
}

export function createManagementTestProjectSeed(source: Project, limit = TEST_PROJECT_TASK_LIMIT): Partial<Project> {
  const selectedIds = selectTaskIds(source, limit);
  const phases = prunePhases(source, selectedIds);
  const tasks = selectedTasksFromPhases(phases);
  const startDates = tasks.map(t => Date.parse(t.startDate || '')).filter(time => Number.isFinite(time) && time > 0);
  const endDates = tasks.map(taskEndTime).filter(time => Number.isFinite(time) && time > 0);
  const today = new Date().toISOString().split('T')[0];

  return {
    name: `Teste gestao - 15 composicoes`,
    startDate: startDates.length ? new Date(Math.min(...startDates)).toISOString().split('T')[0] : source.startDate || today,
    endDate: endDates.length ? new Date(Math.max(...endDates)).toISOString().split('T')[0] : source.endDate || today,
    phases,
    totalBudget: filterBudgetItems(source, tasks).reduce((sum, item) => sum + (Number(item.totalWithBDI) || 0), 0),
    teams: clone(source.teams ?? []),
    operationalRoles: clone(source.operationalRoles ?? []),
    laborNormalizationRules: clone(source.laborNormalizationRules ?? []),
    laborAvailability: clone(source.laborAvailability ?? []),
    laborDimensioningSettings: clone(source.laborDimensioningSettings),
    contractInfo: clone(source.contractInfo),
    syntheticBdiPercent: source.syntheticBdiPercent,
    syntheticImportedAt: source.syntheticImportedAt,
    budgetItems: filterBudgetItems(source, tasks),
    additives: filterAdditives(source, tasks),
    analyticCompositions: filterAnalyticCompositions(source, tasks),
    measurements: [],
    measurementDraft: undefined,
    measurementUiState: undefined,
    dailyReports: [],
    managementRoutine: undefined,
    auditLogs: [],
    materialComparisons: [],
    materialPriceHistory: [],
    stockMovements: [],
    warehouse: source.warehouse ? { ...clone(source.warehouse), movements: [], requisitions: [], custodyTerms: [] } : undefined,
    uiState: undefined,
  };
}
