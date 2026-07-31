import { Task, Project, DependencyType, TaskBaseline } from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { parseISODateLocal, toISODateLocal } from '@/components/gantt/utils';
import { isDiaUtil, getFeriadosMap } from '@/lib/feriados';

/** Calendário de trabalho usado pelo motor de dependências. */
export interface WorkCalendar {
  uf: string;
  municipio: string;
  trabalhaSabado: boolean;
  jornadaDiaria?: number;
}

/** Próximo dia útil ≥ `date` respeitando feriados, domingos e sábados conforme config. */
export function nextWorkDay(date: Date, cal?: WorkCalendar): Date {
  let d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (!cal) {
    // Legado: pula apenas domingo.
    while (d.getDay() === 0) d.setDate(d.getDate() + 1);
    return d;
  }
  let safety = 0;
  while (!isDiaUtil(d, cal.uf, cal.municipio, cal.trabalhaSabado) && safety < 400) {
    d.setDate(d.getDate() + 1);
    safety++;
  }
  return d;
}

/** Soma N dias úteis a partir de `start` (inclusivo). N=1 retorna o próprio start (após ajuste). */
function addWorkDaysCal(start: Date, days: number, cal?: WorkCalendar): Date {
  // Posiciona no primeiro dia útil ≥ start
  let current = nextWorkDay(start, cal);
  let remaining = days - 1;
  // Sábado conta como meio dia quando habilitado
  let safety = 0;
  while (remaining > 0 && safety < 5000) {
    safety++;
    current.setDate(current.getDate() + 1);
    if (cal) {
      if (!isDiaUtil(current, cal.uf, cal.municipio, cal.trabalhaSabado)) continue;
      if (current.getDay() === 6 && cal.trabalhaSabado) {
        remaining -= 0.5;
      } else {
        remaining -= 1;
      }
    } else {
      const dow = current.getDay();
      if (dow === 0) continue;
      remaining -= 1;
    }
  }
  return current;
}

/** Último dia trabalhado da tarefa (start + duration−1 em dias úteis). */
function workEndDate(startISO: string, duration: number, cal?: WorkCalendar): Date {
  const start = parseISODateLocal(startISO);
  const dur = Math.max(1, Math.ceil(duration));
  return addWorkDaysCal(start, dur, cal);
}

/** Próximo dia útil estritamente APÓS `date`. */
function nextWorkDayAfter(date: Date, cal?: WorkCalendar): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return nextWorkDay(d, cal);
}

const DAILY_HOURS = 8;

export interface JornadaConfig {
  trabalhaSabado: boolean;
  jornadaDiaria: number;
}

/** Calculate task duration from RUP compositions, respecting the configured workday/Saturday rule. */
export function calculateRupDuration(
  task: Task,
  config?: JornadaConfig
): { duration: number; totalHours: number; calendarHours: number; bottleneckRole: string } {
  const jornadaDiaria = config?.jornadaDiaria ?? DAILY_HOURS;
  const trabalhaSabado = config?.trabalhaSabado ?? false;

  // Average hours per working day, accounting for half-day Saturdays.
  // Mon–Fri = jornadaDiaria; Sat = jornadaDiaria/2 when trabalhaSabado.
  const horasPorSemana = trabalhaSabado
    ? 5 * jornadaDiaria + jornadaDiaria / 2
    : 5 * jornadaDiaria;
  const diasUteisSemana = trabalhaSabado ? 5.5 : 5;
  const horasPorDia = horasPorSemana / diasUteisSemana;

  if (!task.laborCompositions?.length || !task.quantity) {
    return {
      duration: task.duration,
      totalHours: task.duration * horasPorDia,
      calendarHours: task.duration * horasPorDia,
      bottleneckRole: '',
    };
  }

  let totalHours = 0;
  let maxRoleHours = 0;
  let bottleneck = '';
  const stageHours = new Map<number, number>();

  for (const comp of task.laborCompositions) {
    const totalHoursForRole = task.quantity * comp.rup;
    totalHours += totalHoursForRole;
    const effectiveHours = totalHoursForRole / Math.max(1, comp.workerCount);
    const stage = Math.max(1, Math.trunc(comp.executionStage ?? 1));
    stageHours.set(stage, Math.max(stageHours.get(stage) ?? 0, effectiveHours));
    if (effectiveHours > maxRoleHours) {
      maxRoleHours = effectiveHours;
      bottleneck = comp.role;
    }
  }

  // Etapas sao sequenciais; profissionais dentro da mesma etapa atuam em paralelo.
  const calendarHours = Array.from(stageHours.values()).reduce((sum, hours) => sum + hours, 0);
  const duration = Math.ceil(calendarHours / horasPorDia);
  return { duration, totalHours, calendarHours, bottleneckRole: bottleneck };
}

/** Apply RUP calculations to all tasks, mutating duration */
export function applyRupToProject(project: Project): Project {
  return {
    ...project,
    phases: project.phases.map(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        // Respect manual override — don't overwrite duration
        if (t.isManual) {
          return t;
        }
        const { duration, totalHours, calendarHours, bottleneckRole } = calculateRupDuration(t);
        return { ...t, duration, totalHours, calendarHours, bottleneckRole, calculatedDuration: duration };
      }),
    })),
  };
}

/** Capture baseline (linha de base fixa) for tasks that don't yet have one.
 * Runs once on first load — baseline never changes after capture.
 * For RUP-mode tasks the baseline duration is anchored to the RUP calculation. */
export function captureBaseline(project: Project): Project {
  const now = new Date().toISOString();
  return {
    ...project,
    phases: project.phases.map(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.baseline) return t;
        const isRup = (t.durationMode || 'manual') === 'rup';
        const baseDuration = isRup
          ? calculateRupDuration(t).duration
          : t.duration;
        const start = parseISODateLocal(t.startDate);
        const end = new Date(start);
        // Fim = último dia trabalhado = start + (duration − 1)
        end.setDate(end.getDate() + Math.max(0, baseDuration - 1));
        const baseline: TaskBaseline = {
          startDate: t.startDate,
          duration: baseDuration,
          endDate: end.toISOString().split('T')[0],
          plannedDailyProduction: t.quantity && baseDuration > 0 ? t.quantity / baseDuration : undefined,
          quantity: t.quantity,
          capturedAt: now,
        };
        return { ...t, baseline };
      }),
    })),
  };
}

/** Sync baseline endDate/duration with current RUP calculation for RUP-mode tasks.
 * Manual-mode tasks keep their captured baseline untouched.
 * Baseline startDate is preserved (the planning anchor). */
export function syncBaselineWithRup(project: Project): Project {
  return {
    ...project,
    phases: project.phases.map(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (!t.baseline) return t;
        const isRup = (t.durationMode || 'manual') === 'rup';
        if (!isRup) return t;
        const rupDuration = calculateRupDuration(t).duration;
        if (rupDuration === t.baseline.duration) return t;
        const start = parseISODateLocal(t.baseline.startDate);
        const end = new Date(start);
        // Fim = último dia trabalhado = start + (duration − 1)
        end.setDate(end.getDate() + Math.max(0, rupDuration - 1));
        return {
          ...t,
          baseline: {
            ...t.baseline,
            duration: rupDuration,
            endDate: end.toISOString().split('T')[0],
            plannedDailyProduction: t.quantity && rupDuration > 0
              ? t.quantity / rupDuration
              : t.baseline.plannedDailyProduction,
          },
        };
      }),
    })),
  };
}

/** Apply daily production logs: recompute remaining duration, forecast date, physical progress.
 * Logs override `duration` (unless task.isManual), so CPM downstream propagates automatically.
 * Also populates `task.current` (cronograma variável). */
export function applyDailyLogsToProject(project: Project): Project {
  return {
    ...project,
    phases: project.phases.map(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        const logs = t.dailyLogs || [];

        // Build "current" mirror of baseline by default
        const buildCurrent = (overrides: Partial<NonNullable<Task['current']>> = {}): NonNullable<Task['current']> => {
          const start = parseISODateLocal(t.startDate);
          const end = new Date(start);
          // Fim = último dia trabalhado = start + (duration − 1)
          end.setDate(end.getDate() + Math.max(0, t.duration - 1));
          return {
            startDate: t.startDate,
            duration: t.duration,
            endDate: end.toISOString().split('T')[0],
            ...overrides,
          };
        };

        if (!t.quantity || t.quantity <= 0 || t.duration <= 0) {
          return { ...t, current: buildCurrent() };
        }
        const baseDuration = t.baseline?.duration ?? t.originalDuration ?? t.duration;
        const plannedDailyProduction = t.baseline?.plannedDailyProduction ?? (t.quantity / baseDuration);

        if (logs.length === 0) {
          return {
            ...t,
            executedQuantityTotal: 0,
            remainingQuantity: t.quantity,
            accumulatedDelayQuantity: 0,
            recalculatedDuration: baseDuration,
            physicalProgress: t.percentComplete,
            current: buildCurrent({
              executedQuantityTotal: 0,
              remainingQuantity: t.quantity,
              accumulatedDelayQuantity: 0,
              physicalProgress: t.percentComplete,
            }),
          };
        }

        const executedQuantityTotal = logs.reduce((s, l) => s + (l.actualQuantity || 0), 0);
        const remainingQuantity = Math.max(0, t.quantity - executedQuantityTotal);
        const accumulatedDelayQuantity = logs.reduce(
          (s, l) => s + ((l.plannedQuantity || 0) - (l.actualQuantity || 0)),
          0
        );
        const remainingDuration = plannedDailyProduction > 0
          ? Math.ceil(remainingQuantity / plannedDailyProduction)
          : 0;

        const validLogs = logs.filter(l => l.date && !isNaN(parseISODateLocal(l.date).getTime()));
        const sortedLogs = [...validLogs].sort((a, b) => a.date.localeCompare(b.date));
        if (sortedLogs.length === 0) {
          return { ...t, current: buildCurrent() };
        }
        const firstLogISO = sortedLogs[0].date;
        const lastLogISO = sortedLogs[sortedLogs.length - 1].date;
        // Parse local (sem timezone shift)
        const parseLocal = (iso: string) => {
          const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
          return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
        };
        const firstLogDate = parseLocal(firstLogISO);
        const lastLogDate = parseLocal(lastLogISO);

        // Previsão = EXATAMENTE último log (sem somar saldo, sem clamp pela baseline).
        // Suprimimos `remainingDuration` propositalmente: a previsão deve refletir
        // a última data de execução real registrada no diário de obra.
        void remainingDuration;
        const forecastEnd = new Date(lastLogDate);
        const forecastEndDate = lastLogISO;

        const startDate = parseLocal(t.startDate);
        const recalculatedDuration = Math.max(
          1,
          Math.ceil((forecastEnd.getTime() - startDate.getTime()) / 86400000) + 1
        );
        const currentDuration = Math.max(
          1,
          Math.ceil((lastLogDate.getTime() - firstLogDate.getTime()) / 86400000) + 1
        );

        const physicalProgress = Math.min(100, Math.round((executedQuantityTotal / t.quantity) * 1000) / 10);

        const shouldOverrideDuration = !t.isManual;
        const newDuration = shouldOverrideDuration ? recalculatedDuration : t.duration;

        return {
          ...t,
          originalDuration: baseDuration,
          duration: newDuration,
          executedQuantityTotal,
          remainingQuantity,
          accumulatedDelayQuantity,
          recalculatedDuration,
          forecastEndDate,
          physicalProgress,
          percentComplete: Math.max(t.percentComplete, Math.round(physicalProgress)),
          current: {
            startDate: firstLogISO,
            duration: currentDuration,
            // Sync end with forecast so Gantt + panel show same date
            endDate: forecastEndDate,
            forecastEndDate,
            executedQuantityTotal,
            remainingQuantity,
            accumulatedDelayQuantity,
            physicalProgress,
          },
        };
      }),
    })),
  };
}

/** CPM Forward + Backward pass */
export function calculateCPM(project: Project): Project {
  const allTasks = getAllTasks(project);
  const taskMap = new Map<string, Task>();
  allTasks.forEach(t => taskMap.set(t.id, { ...t }));

  // Build successor map
  const successors = new Map<string, string[]>();
  allTasks.forEach(t => {
    t.dependencies.forEach(depId => {
      if (!successors.has(depId)) successors.set(depId, []);
      successors.get(depId)!.push(t.id);
    });
  });

  // Forward pass
  const visited = new Set<string>();
  function forwardPass(id: string): number {
    const task = taskMap.get(id);
    if (!task) return 0;
    if (visited.has(id)) return task.ef!;
    visited.add(id);

    const validDeps = task.dependencies.filter(depId => taskMap.has(depId));
    if (validDeps.length === 0) {
      task.es = 0;
    } else {
      task.es = Math.max(...validDeps.map(depId => forwardPass(depId)));
    }
    task.ef = task.es + task.duration;
    taskMap.set(id, task);
    return task.ef;
  }

  allTasks.forEach(t => forwardPass(t.id));

  // Project end
  const projectEnd = Math.max(...Array.from(taskMap.values()).map(t => t.ef!));

  // Backward pass
  const visitedBack = new Set<string>();
  function backwardPass(id: string): number {
    const task = taskMap.get(id)!;
    if (visitedBack.has(id)) return task.ls!;
    visitedBack.add(id);

    const succs = successors.get(id);
    if (!succs || succs.length === 0) {
      task.lf = projectEnd;
    } else {
      task.lf = Math.min(...succs.map(sId => backwardPass(sId)));
    }
    task.ls = task.lf - task.duration;
    task.float = task.ls - task.es!;
    task.isCritical = task.float === 0;
    taskMap.set(id, task);
    return task.ls;
  }

  allTasks.forEach(t => backwardPass(t.id));

  // Write back
  return {
    ...project,
    phases: project.phases.map(p => ({
      ...p,
      tasks: p.tasks.map(t => taskMap.get(t.id)!),
    })),
  };
}

/** Generate real Curva S data based on task weights and progress */
export function generateCurvaS(project: Project): { day: string; planejado: number; realizado: number }[] {
  const tasks = getAllTasks(project);
  if (tasks.length === 0) return [];

  const validTasks = tasks.filter(t => t.startDate && !isNaN(parseISODateLocal(t.startDate).getTime()));
  if (validTasks.length === 0) return [];

  const projectStart = new Date(Math.min(...validTasks.map(t => parseISODateLocal(t.startDate).getTime())));
  const projectEnd = new Date(Math.max(...validTasks.map(t => {
    const d = parseISODateLocal(t.startDate);
    d.setDate(d.getDate() + t.duration);
    return d.getTime();
  })));

  const totalDays = Math.max(1, Math.ceil((projectEnd.getTime() - projectStart.getTime()) / 86400000) + 1);
  const totalWeight = validTasks.reduce((s, t) => s + t.duration, 0);
  if (totalWeight === 0) return [];

  // Distribute weight per day
  const plannedPerDay = new Array(totalDays).fill(0);
  const actualPerDay = new Array(totalDays).fill(0);

  tasks.forEach(t => {
    const taskStart = Math.ceil((parseISODateLocal(t.startDate).getTime() - projectStart.getTime()) / 86400000);
    const weight = t.duration / totalWeight;
    const dailyWeight = weight / t.duration;

    for (let d = 0; d < t.duration; d++) {
      const dayIndex = taskStart + d;
      if (dayIndex >= 0 && dayIndex < totalDays) {
        plannedPerDay[dayIndex] += dailyWeight;
        actualPerDay[dayIndex] += dailyWeight * (t.percentComplete / 100);
      }
    }
  });

  // Accumulate - sample weekly
  const result: { day: string; planejado: number; realizado: number }[] = [];
  let cumPlanned = 0;
  let cumActual = 0;
  const step = Math.max(1, Math.floor(totalDays / 12));

  for (let i = 0; i < totalDays; i++) {
    cumPlanned += plannedPerDay[i];
    cumActual += actualPerDay[i];
    if (i % step === 0 || i === totalDays - 1) {
      const date = new Date(projectStart);
      date.setDate(date.getDate() + i);
      result.push({
        day: date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }),
        planejado: Math.round(cumPlanned * 1000) / 10,
        realizado: Math.round(cumActual * 1000) / 10,
      });
    }
  }

  return result;
}

/** Suggest optimization: identify critical tasks where adding workers reduces duration */
export function suggestOptimizations(project: Project): { taskId: string; taskName: string; currentDuration: number; bottleneck: string; suggestedWorkers: number; newDuration: number }[] {
  const tasks = getAllTasks(project);
  const suggestions: { taskId: string; taskName: string; currentDuration: number; bottleneck: string; suggestedWorkers: number; newDuration: number }[] = [];

  tasks.forEach(t => {
    if (!t.isCritical || !t.laborCompositions?.length || !t.quantity || t.percentComplete === 100) return;

    const { bottleneckRole, duration } = calculateRupDuration(t);
    const bottleneckComp = t.laborCompositions.find(c => c.role === bottleneckRole);
    if (!bottleneckComp) return;

    const doubled = { ...bottleneckComp, workerCount: bottleneckComp.workerCount * 2 };
    const simTask = { ...t, laborCompositions: t.laborCompositions.map(c => c.role === bottleneckRole ? doubled : c) };
    const newCalc = calculateRupDuration(simTask);

    if (newCalc.duration < duration) {
      suggestions.push({
        taskId: t.id,
        taskName: t.name,
        currentDuration: duration,
        bottleneck: bottleneckRole,
        suggestedWorkers: doubled.workerCount,
        newDuration: newCalc.duration,
      });
    }
  });

  return suggestions;
}

// ─── Dependency Propagation Engine ───────────────────────────────────

function dateToISO(d: Date): string {
  return d.toISOString().split('T')[0];
}

function addDaysCalc(date: Date, days: number): Date {
  const r = new Date(date);
  r.setDate(r.getDate() + days);
  return r;
}

/**
 * Central dependency propagation engine.
 * Cascades date adjustments through all successor tasks respecting the
 * configured work calendar (Sundays, Saturdays, holidays, half-day Saturday).
 */

export function propagateAllDependencies(
  tasks: Task[],
  changedTaskId: string,
  cal?: WorkCalendar,
): { tasks: Task[]; changed: boolean; adjustedTypes: Set<DependencyType> } {
  const taskMap = new Map(tasks.map(t => [t.id, { ...t }]));
  const visited = new Set<string>();
  let anyChanged = false;
  const adjustedTypes = new Set<DependencyType>();

  // Build successor index: predId -> [{successorId, type}]
  const successorIndex = new Map<string, { successorId: string; type: DependencyType }[]>();
  tasks.forEach(t => {
    const details = (t.dependencyDetails && t.dependencyDetails.length)
      ? t.dependencyDetails
      : (t.dependencies || []).map(id => ({ taskId: id, type: 'TI' as DependencyType }));
    details.forEach(dep => {
      if (!successorIndex.has(dep.taskId)) successorIndex.set(dep.taskId, []);
      successorIndex.get(dep.taskId)!.push({ successorId: t.id, type: dep.type });
    });
  });

  function propagate(predId: string, depth: number) {
    if (depth > 50 || visited.has(predId)) return;
    visited.add(predId);

    const succs = successorIndex.get(predId);
    if (!succs) return;

    for (const { successorId, type } of succs) {
      const pred = taskMap.get(predId)!;
      const succ = taskMap.get(successorId)!;
      if (!pred || !succ) continue;

      const predStart = nextWorkDay(parseISODateLocal(pred.startDate), cal);
      // Último dia trabalhado da predecessora respeitando o calendário
      const predLastWorkDay = workEndDate(pred.startDate, pred.duration, cal);
      // Próximo dia útil estritamente após o término real da predecessora
      const predNextStart = nextWorkDayAfter(predLastWorkDay, cal);

      let newStartDate: Date | null = null;

      switch (type) {
        case 'TI':
          // Sucessora começa NO PRÓXIMO DIA ÚTIL após o último dia trabalhado da predecessora
          newStartDate = predNextStart;
          break;
        case 'II':
          // Início da sucessora = início (útil) da predecessora
          newStartDate = predStart;
          break;
        case 'TT': {
          // Fim da sucessora = fim da predecessora
          // Calculamos o início que produz esse fim, recuando dias úteis.
          // Aproximação: encontrar start tal que workEndDate(start, succ.duration) == predLastWorkDay
          // Recuamos a partir de predLastWorkDay duration−1 dias úteis.
          const dur = Math.max(1, Math.ceil(succ.duration));
          let cur = new Date(predLastWorkDay);
          let remaining = dur - 1;
          let safety = 0;
          while (remaining > 0 && safety < 5000) {
            safety++;
            cur.setDate(cur.getDate() - 1);
            if (cal) {
              if (!isDiaUtil(cur, cal.uf, cal.municipio, cal.trabalhaSabado)) continue;
              if (cur.getDay() === 6 && cal.trabalhaSabado) remaining -= 0.5;
              else remaining -= 1;
            } else {
              if (cur.getDay() === 0) continue;
              remaining -= 1;
            }
          }
          newStartDate = nextWorkDay(cur, cal);
          break;
        }
        case 'IT': {
          // Fim da sucessora = início da predecessora (rara; mantém comportamento)
          const dur = Math.max(1, Math.ceil(succ.duration));
          let cur = new Date(predStart);
          let remaining = dur;
          let safety = 0;
          while (remaining > 0 && safety < 5000) {
            safety++;
            cur.setDate(cur.getDate() - 1);
            if (cal) {
              if (!isDiaUtil(cur, cal.uf, cal.municipio, cal.trabalhaSabado)) continue;
              if (cur.getDay() === 6 && cal.trabalhaSabado) remaining -= 0.5;
              else remaining -= 1;
            } else {
              if (cur.getDay() === 0) continue;
              remaining -= 1;
            }
          }
          newStartDate = nextWorkDay(cur, cal);
          break;
        }
      }

      if (newStartDate !== null) {
        const newISO = toISODateLocal(newStartDate);
        if (newISO !== succ.startDate) {
          taskMap.set(successorId, { ...succ, startDate: newISO });
          anyChanged = true;
          adjustedTypes.add(type);
          propagate(successorId, depth + 1);
        }
      }
    }
  }

  propagate(changedTaskId, 0);

  return {
    tasks: tasks.map(t => taskMap.get(t.id) || t),
    changed: anyChanged,
    adjustedTypes,
  };
}

/**
 * Settle ALL dependency relationships in the project.
 */
export function settleAllDependencies(project: Project, cal?: WorkCalendar): Project {
  let allTasks = getAllTasks(project);
  if (allTasks.length === 0) return project;

  const order = allTasks.map(t => t.id);

  let safety = 0;
  let changedAny = true;
  while (changedAny && safety < 10) {
    safety++;
    changedAny = false;
    for (const id of order) {
      const result = propagateAllDependencies(allTasks, id, cal);
      if (result.changed) {
        allTasks = result.tasks;
        changedAny = true;
      }
    }
  }

  const byId = new Map(allTasks.map(t => [t.id, t]));
  return {
    ...project,
    phases: project.phases.map(p => ({
      ...p,
      tasks: p.tasks.map(t => byId.get(t.id) || t),
    })),
  };
}

/**
 * Check if a successor's start violates dependency relative to predecessors.
 */
export function checkDependencyViolation(
  task: Task,
  newStartDate: string,
  allTasks: Task[],
  cal?: WorkCalendar,
): { predName: string; predId: string; type: DependencyType } | null {
  const details = (task.dependencyDetails && task.dependencyDetails.length)
    ? task.dependencyDetails
    : (task.dependencies || []).map(id => ({ taskId: id, type: 'TI' as DependencyType }));
  const taskMap = new Map(allTasks.map(t => [t.id, t]));

  for (const dep of details) {
    const pred = taskMap.get(dep.taskId);
    if (!pred) continue;

    const predStart = nextWorkDay(parseISODateLocal(pred.startDate), cal);
    const predLast = workEndDate(pred.startDate, pred.duration, cal);
    const predNext = nextWorkDayAfter(predLast, cal); // primeiro dia útil válido para sucessora TI
    const newStart = parseISODateLocal(newStartDate);
    const newLast = workEndDate(newStartDate, task.duration, cal);

    let violated = false;
    switch (dep.type) {
      case 'TI': violated = newStart < predNext; break;
      case 'II': violated = newStart < predStart; break;
      case 'TT': violated = newLast < predLast; break;
      case 'IT': violated = newLast < predStart; break;
    }

    if (violated) {
      return { predName: pred.name, predId: pred.id, type: dep.type };
    }
  }
  return null;
}
