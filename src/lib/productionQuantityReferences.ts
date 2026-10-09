import { getAllTasks } from '@/data/sampleProject';
import type { DailyProductionLog, ProductionQuantityDetail, Project, Task } from '@/types/project';
import { logToProject, type AuditUserInfo } from '@/lib/audit';
import { applyDailyProductionLogs } from '@/lib/dailyProductionLogs';
import { detailTotal, formulasForUnit, measureMatchesDetailCell, withDetailValue, type DetailField } from '@/lib/productionQuantityDetails';
import { measureUnit, quantity } from '@/lib/planTakeoff';
import { validateDailyProductionLogs } from '@/lib/productionQuantityLimit';
import { productionRecordBlock } from '@/lib/productionMeasurementPeriods';

export interface QuantityRowAddress { taskId: string; logId: string; rowId: string }
export type QuantityClipboardMode = 'cut' | 'copy' | 'reference';
export interface QuantityClipboard {
  projectId: string;
  mode: QuantityClipboardMode;
  source: QuantityRowAddress;
  unit: string;
  snapshot: ProductionQuantityDetail;
}
export interface QuantityChangeResult { project?: Project; error?: string; affectedTaskNames?: string[] }

const sourceFields = { multiplier: 'multiplierSource', measuredQuantity: 'source', dimensionC: 'dimensionCSource', dimensionD: 'dimensionDSource' } as const;
const fields = Object.keys(sourceFields) as DetailField[];
/** Include every task/day and reference copy, even legacy sources without ownership tags. */
export function referencedTakeoffMeasureIds(project: Project): string[] {
  return [...new Set(getAllTasks(project).flatMap(task =>
    (task.dailyLogs ?? []).flatMap(log => (log.quantityDetails ?? []).flatMap(row =>
      Object.values(sourceFields).flatMap(field => row[field]?.measureId ? [row[field]!.measureId] : []),
    )),
  ))];
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function normalizedUnit(unit: string): string {
  const value = unit.trim().toLowerCase().replace(/²/g, '2').replace(/³/g, '3').replace(/\s/g, '');
  if (['un', 'und', 'unid', 'unidade', 'unidades', 'pç', 'pc', 'peça', 'peças'].includes(value)) return 'un';
  if (['m', 'ml', 'metro', 'metros'].includes(value)) return 'm';
  if (['m2', 'metroquadrado', 'metrosquadrados'].includes(value)) return 'm2';
  if (['m3', 'metrocubico', 'metroscubicos', 'metrocúbico', 'metroscúbicos'].includes(value)) return 'm3';
  return value;
}

function getTask(project: Project, id: string): Task | undefined {
  return getAllTasks(project).find(task => task.id === id);
}

function getRow(project: Project, address: QuantityRowAddress): ProductionQuantityDetail | undefined {
  return getTask(project, address.taskId)?.dailyLogs?.find(log => log.id === address.logId)?.quantityDetails?.find(row => row.id === address.rowId);
}

function sharedContent(row: ProductionQuantityDetail): Omit<ProductionQuantityDetail, 'id' | 'location' | 'sharedRecordId'> {
  const { id: _id, location: _location, sharedRecordId: _sharedRecordId, ...content } = row;
  return clone(content);
}

function matchingSharedRow(row: ProductionQuantityDetail, changed: ProductionQuantityDetail): ProductionQuantityDetail {
  return { ...row, ...sharedContent(changed) };
}

function independentCopy(row: ProductionQuantityDetail): ProductionQuantityDetail {
  const copied = clone(row);
  return {
    ...copied, id: crypto.randomUUID(), location: '', sharedRecordId: undefined,
    multiplierSource: undefined, source: undefined, dimensionCSource: undefined, dimensionDSource: undefined,
  };
}

function rowFitsUnit(row: ProductionQuantityDetail, unit: string): boolean {
  if (!formulasForUnit(unit).includes(row.formula ?? 'A*B')) return false;
  return fields.every(field => {
    const source = row[sourceFields[field]];
    return !source || measureMatchesDetailCell(source.kind, field, row, unit);
  });
}

function changedLog(log: DailyProductionLog, rows: ProductionQuantityDetail[]): DailyProductionLog {
  const before = detailTotal(log.quantityDetails ?? []);
  const after = detailTotal(rows);
  const followDetail = before > 0 || after > 0 || log.quantityDetailsAppliedTotal !== undefined;
  return followDetail
    ? { ...log, quantityDetails: rows, actualQuantity: after, quantityDetailsAppliedTotal: after }
    : { ...log, quantityDetails: rows };
}

type RowChanges = Map<string, Map<string, ProductionQuantityDetail[]>>;
function setRows(changes: RowChanges, taskId: string, logId: string, rows: ProductionQuantityDetail[]) {
  const taskChanges = changes.get(taskId) ?? new Map<string, ProductionQuantityDetail[]>();
  taskChanges.set(logId, rows);
  changes.set(taskId, taskChanges);
}
function currentRows(project: Project, changes: RowChanges, taskId: string, logId: string): ProductionQuantityDetail[] {
  return changes.get(taskId)?.get(logId) ?? getTask(project, taskId)?.dailyLogs?.find(log => log.id === logId)?.quantityDetails ?? [];
}

function finishChange(project: Project, changes: RowChanges, actor: AuditUserInfo, title: string, before: unknown, after: unknown, recordId?: string, canEditTask: (task: Task) => boolean = () => true): QuantityChangeResult {
  const touchedNames: string[] = [];
  let failure = '';
  const visit = (originalTask: Task): Task => {
    const task = originalTask.children?.length ? { ...originalTask, children: originalTask.children.map(visit) } : originalTask;
    const taskChanges = changes.get(task.id);
    if (!taskChanges) return task;
    if (!canEditTask(task)) { failure ||= `A tarefa “${task.name}” impediu a alteração: seu perfil não tem permissão de edição.`; return task; }
    const lockedRecord = (task.dailyLogs ?? []).find(log => taskChanges.has(log.id) && productionRecordBlock(project, log));
    if (lockedRecord) { failure ||= `A tarefa “${task.name}” impediu a alteração: ${productionRecordBlock(project, lockedRecord)}`; return task; }
    const logs = (task.dailyLogs ?? []).map(log => taskChanges.has(log.id) ? changedLog(log, taskChanges.get(log.id)!) : log);
    const invalidRows = logs.flatMap(log => log.quantityDetails ?? []).some(row => !rowFitsUnit(row, task.unit || 'un'));
    const validation = validateDailyProductionLogs(task, logs);
    if (invalidRows || !validation.allowed) {
      failure ||= `A tarefa “${task.name}” impediu a alteração: ${invalidRows ? `fórmula ou marcação incompatível com ${task.unit || 'un'}.` : validation.message}`;
      return task;
    }
    touchedNames.push(task.name);
    return { ...task, ...applyDailyProductionLogs(task, logs) };
  };
  const phases = project.phases.map(phase => ({ ...phase, tasks: phase.tasks.map(visit) }));
  if (failure) return { error: failure };
  const changed = { ...project, phases };
  let audited = changed;
  const operationId = crypto.randomUUID();
  for (const [taskId, logs] of changes) {
    for (const logId of logs.keys()) {
      const oldLog = getTask(project, taskId)?.dailyLogs?.find(log => log.id === logId);
      const newLog = getTask(changed, taskId)?.dailyLogs?.find(log => log.id === logId);
      audited = logToProject(audited, {
        ...actor, entityType: 'task', entityId: taskId, action: 'updated', title,
        description: touchedNames.join(' · '), before: oldLog, after: newLog,
        metadata: { logId, operationId, recordId, affectedTaskIds: [...changes.keys()], affectedTaskNames: touchedNames, beforeRows: before, afterRows: after },
      });
    }
  }
  return { project: audited, affectedTaskNames: touchedNames };
}

export function makeQuantityClipboard(projectId: string, mode: QuantityClipboardMode, source: QuantityRowAddress, unit: string, row: ProductionQuantityDetail): QuantityClipboard {
  return { projectId, mode, source, unit, snapshot: clone(row) };
}

/** Substitui linhas de um dia e propaga todo conteúdo compartilhado em uma única alteração do Project. */
export function changeQuantityRows(project: Project, address: Pick<QuantityRowAddress, 'taskId' | 'logId'>, rows: ProductionQuantityDetail[], actor: AuditUserInfo = {}, readOnly = false, canEditTask: (task: Task) => boolean = () => true): QuantityChangeResult {
  if (readOnly) return { error: 'Seu perfil permite apenas consultar a Produção.' };
  const task = getTask(project, address.taskId);
  const log = task?.dailyLogs?.find(item => item.id === address.logId);
  if (!task || !log) return { error: 'Lançamento não encontrado. Reabra a tarefa.' };
  const beforeRows = log.quantityDetails ?? [];
  const beforeById = new Map(beforeRows.map(row => [row.id, row]));
  const sharedUpdates = new Map<string, ProductionQuantityDetail>();
  for (const row of rows) {
    const old = beforeById.get(row.id);
    if (!old) {
      if (row.sharedRecordId) return { error: 'Use Colar referência para criar um vínculo.' };
      continue;
    }
    if (old.sharedRecordId !== row.sharedRecordId) return { error: 'O vínculo não pode ser alterado por edição comum.' };
    if (row.sharedRecordId && JSON.stringify(sharedContent(old)) !== JSON.stringify(sharedContent(row))) sharedUpdates.set(row.sharedRecordId, row);
  }
  const changes: RowChanges = new Map();
  setRows(changes, task.id, log.id, rows);
  for (const [recordId, updated] of sharedUpdates) {
    for (const otherTask of getAllTasks(project)) {
      for (const otherLog of otherTask.dailyLogs ?? []) {
        if (otherTask.id === task.id && otherLog.id === log.id) continue;
        const oldRows = currentRows(project, changes, otherTask.id, otherLog.id);
        if (oldRows.some(row => row.sharedRecordId === recordId)) {
          setRows(changes, otherTask.id, otherLog.id, oldRows.map(row => row.sharedRecordId === recordId ? matchingSharedRow(row, updated) : row));
        }
      }
    }
  }
  for (const recordId of sharedUpdates.keys()) {
    const referenceUnits = getAllTasks(project).filter(item => item.dailyLogs?.some(day => day.quantityDetails?.some(row => row.sharedRecordId === recordId))).map(item => normalizedUnit(item.unit || 'un'));
    if (referenceUnits.some(unit => unit !== normalizedUnit(task.unit || 'un'))) return { error: `O registro vinculado tem tarefas com unidades diferentes; nenhuma alteração foi gravada.` };
  }
  const removedShared = beforeRows.find(row => row.sharedRecordId && !rows.some(next => next.id === row.id));
  return finishChange(project, changes, actor, sharedUpdates.size ? 'Quantitativo compartilhado alterado' : removedShared ? 'Referência de quantitativo desvinculada' : 'Detalhe de quantitativo alterado', beforeRows, rows, [...sharedUpdates.keys()][0] ?? removedShared?.sharedRecordId, canEditTask);
}

/** Colar normal, mover e vincular são operações inteiras: nenhuma tarefa muda se outra falhar. */
export function pasteQuantityRow(project: Project, clipboard: QuantityClipboard, destination: Pick<QuantityRowAddress, 'taskId' | 'logId'> & { afterRowId?: string }, actor: AuditUserInfo = {}, readOnly = false, canEditTask: (task: Task) => boolean = () => true): QuantityChangeResult {
  if (readOnly) return { error: 'Seu perfil permite apenas consultar a Produção.' };
  if (clipboard.projectId !== project.id) return { error: 'Copie uma linha desta obra antes de colar.' };
  const sourceTask = getTask(project, clipboard.source.taskId);
  const destinationTask = getTask(project, destination.taskId);
  const sourceRow = getRow(project, clipboard.source);
  const destinationLog = destinationTask?.dailyLogs?.find(log => log.id === destination.logId);
  if (!sourceTask || !sourceRow || !destinationTask || !destinationLog) return { error: 'A linha de origem ou o lançamento de destino não está mais disponível.' };
  if (normalizedUnit(clipboard.unit) !== normalizedUnit(sourceTask.unit || 'un') || normalizedUnit(clipboard.unit) !== normalizedUnit(destinationTask.unit || 'un')) {
    return { error: `A tarefa “${destinationTask.name}” impediu a colagem: unidade ${destinationTask.unit || 'un'} incompatível com ${clipboard.unit}.` };
  }
  if (clipboard.mode === 'reference' && destinationTask.id === sourceTask.id) return { error: `A tarefa “${destinationTask.name}” já contém a origem deste registro; escolha outra tarefa para a referência.` };
  if (clipboard.mode === 'reference' && destinationTask.dailyLogs?.some(log => log.quantityDetails?.some(row => row.sharedRecordId && row.sharedRecordId === sourceRow.sharedRecordId))) {
    return { error: `A tarefa “${destinationTask.name}” já contém este registro vinculado.` };
  }
  const changes: RowChanges = new Map();
  let inserted: ProductionQuantityDetail;
  if (clipboard.mode === 'copy') inserted = independentCopy(clipboard.snapshot);
  else if (clipboard.mode === 'cut') inserted = clone(sourceRow);
  else inserted = { ...clone(sourceRow), id: crypto.randomUUID(), location: '', sharedRecordId: sourceRow.sharedRecordId ?? crypto.randomUUID() };
  if (!rowFitsUnit(inserted, destinationTask.unit || 'un')) return { error: `A tarefa “${destinationTask.name}” impediu a colagem: fórmula ou marcação incompatível com ${destinationTask.unit || 'un'}.` };
  if (clipboard.mode === 'cut') {
    const sourceRows = currentRows(project, changes, sourceTask.id, clipboard.source.logId).filter(row => row.id !== sourceRow.id);
    setRows(changes, sourceTask.id, clipboard.source.logId, sourceRows);
  }
  if (clipboard.mode === 'reference' && !sourceRow.sharedRecordId) {
    const sourceRows = currentRows(project, changes, sourceTask.id, clipboard.source.logId).map(row => row.id === sourceRow.id ? { ...row, sharedRecordId: inserted.sharedRecordId } : row);
    setRows(changes, sourceTask.id, clipboard.source.logId, sourceRows);
  }
  const rows = currentRows(project, changes, destinationTask.id, destination.logId);
  const at = destination.afterRowId ? rows.findIndex(row => row.id === destination.afterRowId) + 1 : rows.length;
  const nextRows = [...rows];
  nextRows.splice(at <= 0 ? rows.length : at, 0, inserted);
  setRows(changes, destinationTask.id, destination.logId, nextRows);
  return finishChange(project, changes, actor, clipboard.mode === 'reference' ? 'Referência de quantitativo vinculada' : clipboard.mode === 'cut' ? 'Linha de quantitativo movida' : 'Linha de quantitativo copiada', clipboard.mode === 'copy' ? clipboard.snapshot : sourceRow, inserted, inserted.sharedRecordId, canEditTask);
}

export function sharedTaskNames(project: Project, recordId: string): string[] {
  return getAllTasks(project).filter(task => task.dailyLogs?.some(log => log.quantityDetails?.some(row => row.sharedRecordId === recordId))).map(task => task.name);
}

/** Recalibra todas as células ligadas à prancha, com validação única de todos os dias e tarefas. */
export function recalibrateQuantitySources(project: Project, planId: string, page: number, metersPerUnit: number | null, actor: AuditUserInfo = {}, readOnly = false, canEditTask: (task: Task) => boolean = () => true): QuantityChangeResult {
  if (readOnly) return { error: 'Seu perfil permite apenas consultar a Produção.' };
  if (metersPerUnit !== null && (!Number.isFinite(metersPerUnit) || metersPerUnit <= 0)) return { error: 'Informe uma escala positiva.' };
  const changes: RowChanges = new Map();
  const before: unknown[] = [], after: unknown[] = [];
  let failure = '';
  for (const task of getAllTasks(project)) for (const log of task.dailyLogs ?? []) {
    let affected = false;
    const rows = (log.quantityDetails ?? []).map(row => {
      let updated = row;
      for (const field of fields) {
        const source = updated[sourceFields[field]];
        if (source?.planId !== planId || source.page !== page) continue;
        const value = quantity(source.kind, source.points, metersPerUnit, source.heightMeters);
        if (value === null || !Number.isFinite(value)) { failure ||= `A tarefa “${task.name}” contém uma medição incompatível com a nova escala.`; return row; }
        updated = withDetailValue(updated, field, value);
        updated = { ...updated, [sourceFields[field]]: { ...source, resultUnit: measureUnit(source.kind, metersPerUnit) } };
        affected = true;
      }
      return updated;
    });
    if (!affected) continue;
    setRows(changes, task.id, log.id, rows);
    before.push({ task: task.name, date: log.date, rows: log.quantityDetails });
    after.push({ task: task.name, date: log.date, rows });
  }
  if (failure) return { error: failure };
  if (!changes.size) return { project, affectedTaskNames: [] };
  return finishChange(project, changes, actor, 'Escala da planta recalibrada', before, after, undefined, canEditTask);
}
