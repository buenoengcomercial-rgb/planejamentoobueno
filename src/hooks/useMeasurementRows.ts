import { useMemo } from 'react';
import type { Project, Task, Phase, SavedMeasurement } from '@/types/project';
import { getChapterTree, getChapterNumbering, type ChapterNode } from '@/lib/chapters';
import {
  trunc2,
  money2,
  calculateMeasurementLine,
} from '@/lib/measurementCalculations';
import { computeTaskForecast } from '@/lib/measurementForecast';
import type { Row, GroupNode } from '@/components/measurement/types';
import { isLockedStatus } from '@/components/measurement/types';
import {
  emptyTotals,
  estimateTaskValue,
  buildOrderedTasks,
} from '@/components/measurement/measurementFormat';
import { loadObraConfig } from '@/components/ConfiguracaoObra';

export interface UseMeasurementRowsParams {
  project: Project;
  measurements: SavedMeasurement[];
  activeId: string;
  startDate: string;
  endDate: string;
  chapterFilter: string;
  search: string;
  issueDate: string;
  bdiPercent: number;
  measurementNumber: string;
}

/**
 * Centraliza a montagem de linhas, filtros, agrupamento por capítulos/subcapítulos
 * e totais da tela de Medição.
 *
 * IMPORTANTE: NÃO altera nenhum cálculo financeiro. Mantém exatamente o mesmo
 * comportamento que estava inline em Measurement.tsx (snapshot vs live, BDI implícito,
 * money2 para valores vindos da Sintética, trunc2 para valores calculados).
 */
export function useMeasurementRows({
  project,
  measurements,
  activeId,
  startDate,
  endDate,
  chapterFilter,
  search,
  issueDate,
  bdiPercent,
  measurementNumber,
}: UseMeasurementRowsParams) {
  // Itens financeiros importados da Sintética + itens de aditivos APROVADOS (fonte da Medição).
  const syntheticBudgetItems = useMemo(
    () => (project.budgetItems || []).filter(b => b.source === 'sintetica' || b.source === 'aditivo'),
    [project.budgetItems],
  );
  const hasSyntheticBudget = syntheticBudgetItems.length > 0;

  const numbering = useMemo(() => getChapterNumbering(project), [project]);
  const orderedTasks = useMemo(() => buildOrderedTasks(project), [project]);

  // ───────── Medição ativa ─────────
  const activeMeasurement = useMemo<SavedMeasurement | null>(() => {
    if (activeId === 'live') return null;
    return measurements.find(m => m.id === activeId) || null;
  }, [activeId, measurements]);

  const isLocked = activeMeasurement ? isLockedStatus(activeMeasurement.status) : false;
  // Snapshot só para medições enviadas/aprovadas. "generated" continua como previsão viva.
  const isSnapshotMode = !!activeMeasurement && (
    activeMeasurement.status === 'in_review' ||
    activeMeasurement.status === 'approved'
  );

  // Período/BDI vigentes para cálculo (snapshot vs live)
  const effStart = activeMeasurement?.startDate ?? startDate;
  const effEnd = activeMeasurement?.endDate ?? endDate;
  const effBdi = activeMeasurement?.bdiPercent ?? bdiPercent;
  const effBdiFactor = 1 + effBdi / 100;
  const effIssue = activeMeasurement?.issueDate ?? issueDate;
  const effNumber = activeMeasurement?.number?.toString() ?? measurementNumber;

  // Acumulado anterior considerando medições anteriores APROVADAS/GERADAS quando em live ou previsão
  const priorAccumByTask = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (isSnapshotMode) return map;
    measurements.forEach(m => {
      if (m.status === 'draft' || m.status === 'rejected') return;
      // Não dupla-conta a própria medição ativa (que está sendo recalculada ao vivo).
      if (activeMeasurement && m.id === activeMeasurement.id) return;
      m.items.forEach(it => {
        const qty = it.qtyApproved ?? it.qtyProposed ?? 0;
        map.set(it.taskId, (map.get(it.taskId) || 0) + qty);
      });
    });
    return map;
  }, [measurements, isSnapshotMode, activeMeasurement]);

  // Mapa rápido taskId → Task (para previsão usar dados atuais do Gantt mesmo em snapshot)
  const taskById = useMemo<Map<string, Task>>(() => {
    const m = new Map<string, Task>();
    project.phases.forEach(p => p.tasks.forEach(t => m.set(t.id, t)));
    return m;
  }, [project.phases]);

  // Calendário de trabalho (sábado conta meio dia ou não) — mesma fonte do Gantt
  const trabalhaSabado = useMemo(() => loadObraConfig().trabalhaSabado, []);

  // ───────── Cálculo das linhas ─────────
  const rows: Row[] = useMemo(() => {
    if (isSnapshotMode && activeMeasurement) {
      // Snapshot: não recalcula da EAP — usa o que foi salvo
      return activeMeasurement.items.map(it => {
        const qtyPeriod = it.qtyApproved ?? it.qtyProposed ?? 0;
        // Snapshot: preserva preços já congelados — derivamos BDI implícito p/ manter c/BDI exato
        const snapNoBDI = trunc2(it.unitPriceNoBDI);
        const snapWithBDI = trunc2(it.unitPriceWithBDI);
        const implicitBdi = snapNoBDI > 0 ? ((snapWithBDI / snapNoBDI) - 1) * 100 : 0;
        const calc = calculateMeasurementLine({
          quantityContracted: it.qtyContracted,
          quantityPeriod: qtyPeriod,
          quantityPriorAccum: it.qtyPriorAccum,
          unitPriceNoBDI: snapNoBDI,
          bdiPercent: implicitBdi,
        });
        const sourceTask = taskById.get(it.taskId);
        const fc = sourceTask
          ? computeTaskForecast({
              task: sourceTask,
              periodStart: effStart,
              periodEnd: effEnd,
              qtyContracted: it.qtyContracted,
              unitPriceWithBDI: calc.unitPriceWithBDI,
              unitPriceNoBDI: calc.unitPriceNoBDI,
              trabalhaSabado,
              unit: it.unit,
            })
          : { qtyForecast: 0, valueForecast: 0, valueForecastNoBDI: 0, plannedDaily: 0, plannedDaysInPeriod: 0 };
        return {
          item: it.item,
          phaseId: it.phaseId,
          phaseChain: it.phaseChain,
          taskId: it.taskId,
          description: it.description,
          unit: it.unit,
          itemCode: it.itemCode,
          priceBank: it.priceBank,
          qtyContracted: it.qtyContracted,
          qtyPriorAccum: it.qtyPriorAccum,
          qtyPeriod,
          qtyProposed: it.qtyProposed,
          qtyApproved: it.qtyApproved,
          qtyCurrentAccum: calc.quantityCurrentAccum,
          qtyBalance: calc.quantityBalance,
          percentExecuted: calc.percentExecuted,
          unitPriceNoBDI: calc.unitPriceNoBDI,
          unitPriceWithBDI: calc.unitPriceWithBDI,
          unitPriceIsEstimated: false,
          valueContractedNoBDI: calc.totalContractedNoBDI,
          valuePeriodNoBDI: calc.totalPeriodNoBDI,
          valueAccumNoBDI: calc.totalAccumulatedNoBDI,
          valueBalanceNoBDI: calc.totalBalanceNoBDI,
          valueContracted: calc.totalContracted,
          valuePeriod: calc.totalPeriod,
          valueAccum: calc.totalAccumulated,
          valueBalance: calc.totalBalance,
          qtyForecast: fc.qtyForecast,
          valueForecast: fc.valueForecast,
          valueForecastNoBDI: fc.valueForecastNoBDI,
          diffForecastVsReal: trunc2(calc.totalPeriod - fc.valueForecast),
          hasNoLogsInPeriod: qtyPeriod === 0,
          hasNoLogsAtAll: false,
          notes: it.notes,
        };
      });
    }


    // Normalização de códigos para casamento robusto entre EAP e Sintética.
    const normalizeCode = (s: string | undefined | null): string => {
      if (!s) return '';
      let v = String(s).trim().toUpperCase();
      // Remove acentos
      v = v.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      // Colapsa espaços
      v = v.replace(/\s+/g, ' ');
      return v;
    };
    const normalizeNumeric = (s: string | undefined | null): string => {
      const v = normalizeCode(s);
      // Remove zeros à esquerda em segmentos puramente numéricos
      return v.split('.').map(seg => /^\d+$/.test(seg) ? String(parseInt(seg, 10)) : seg).join('.');
    };
    const normalizeDesc = (s: string | undefined | null): string => normalizeCode(s).replace(/[^A-Z0-9 ]/g, '');

    const computeQtyFromTask = (task: Task | undefined): { prior: number; period: number; hasNoLogsAtAll: boolean; hasNoLogsInPeriod: boolean } => {
      if (!task) return { prior: 0, period: 0, hasNoLogsAtAll: true, hasNoLogsInPeriod: true };
      const logs = task.dailyLogs || [];
      const hasNoLogsAtAll = logs.length === 0;
      let prior = 0;
      let period = 0;
      let hasLogsInPeriod = false;
      if (!hasNoLogsAtAll) {
        for (const log of logs) {
          const d = log.date;
          if (d < effStart) prior += log.actualQuantity || 0;
          else if (d >= effStart && d <= effEnd) {
            period += log.actualQuantity || 0;
            if ((log.actualQuantity || 0) > 0) hasLogsInPeriod = true;
          }
        }
      }
      return { prior, period, hasNoLogsAtAll, hasNoLogsInPeriod: !hasLogsInPeriod };
    };

    // ── Construção das filas de BudgetItems (Sintética) por chave, para consumo único ──
    // Cada item da Sintética só pode ser associado a UMA tarefa da EAP.
    const budgetById = new Map<string, typeof syntheticBudgetItems[number]>();
    const budgetQueueByCode = new Map<string, typeof syntheticBudgetItems>();
    const budgetQueueByItem = new Map<string, typeof syntheticBudgetItems>();
    const budgetQueueByDesc = new Map<string, typeof syntheticBudgetItems>();
    const consumed = new Set<string>();

    if (hasSyntheticBudget) {
      syntheticBudgetItems.forEach(b => {
        budgetById.set(b.id, b);
        const cKey = normalizeCode(b.code);
        if (cKey) {
          const arr = budgetQueueByCode.get(cKey) || [];
          arr.push(b);
          budgetQueueByCode.set(cKey, arr);
        }
        const iKey = normalizeNumeric(b.item);
        if (iKey) {
          const arr = budgetQueueByItem.get(iKey) || [];
          arr.push(b);
          budgetQueueByItem.set(iKey, arr);
        }
        const dKey = normalizeDesc(b.description);
        if (dKey) {
          const arr = budgetQueueByDesc.get(dKey) || [];
          arr.push(b);
          budgetQueueByDesc.set(dKey, arr);
        }
      });
    }

    const popFromQueue = (q: typeof syntheticBudgetItems | undefined): typeof syntheticBudgetItems[number] | undefined => {
      if (!q) return undefined;
      while (q.length > 0) {
        const candidate = q.shift()!;
        if (!consumed.has(candidate.id)) {
          consumed.add(candidate.id);
          return candidate;
        }
      }
      return undefined;
    };

    const matchBudgetForTask = (task: Task): typeof syntheticBudgetItems[number] | undefined => {
      if (!hasSyntheticBudget) return undefined;
      // 1) taskId direto
      const direct = syntheticBudgetItems.find(b => b.taskId === task.id && !consumed.has(b.id));
      if (direct) { consumed.add(direct.id); return direct; }
      // 2) código normalizado
      const codeKey = normalizeCode(task.itemCode);
      if (codeKey) {
        const m = popFromQueue(budgetQueueByCode.get(codeKey));
        if (m) return m;
      }
      // 3) descrição normalizada (fallback)
      const descKey = normalizeDesc(task.name);
      if (descKey) {
        const m = popFromQueue(budgetQueueByDesc.get(descKey));
        if (m) return m;
      }
      return undefined;
    };

    // ── Iteração principal: SEMPRE pela EAP (ordem/numeração/hierarquia da EAP) ──
    const eapRows: Row[] = orderedTasks.map(({ task, phase, itemNumber, chain }) => {
      const matchedBudget = matchBudgetForTask(task);

      const qtyContracted = matchedBudget
        ? (matchedBudget.quantity || 0)
        : (task.quantity ?? task.baseline?.quantity ?? 0);
      const unit = matchedBudget?.unit || task.unit || '';

      const logsInfo = computeQtyFromTask(task);
      const priorFromMeas = priorAccumByTask.get(task.id) || 0;
      const qtyPriorAccum = Math.max(logsInfo.prior, priorFromMeas);
      let qtyPeriod = logsInfo.period;
      if (logsInfo.hasNoLogsAtAll) {
        qtyPeriod = 0;
      }

      // Determinar preço s/ BDI base — Sintética (se vinculada) tem prioridade
      let unitPriceNoBDIBase = 0;
      let unitPriceIsEstimated = false;
      let lineBdi = effBdi;

      if (matchedBudget) {
        // Valores vindos PRONTOS da Sintética: normalizar com money2 (preserva o que veio do Excel)
        const noBDI = money2(matchedBudget.unitPriceNoBDI);
        const withBDI = money2(matchedBudget.unitPriceWithBDI);
        unitPriceNoBDIBase = noBDI;
        // Preserva BDI implícito da Sintética (mantém c/BDI exato)
        lineBdi = noBDI > 0 ? ((withBDI / noBDI) - 1) * 100 : effBdi;
      } else if ((task.unitPriceNoBDI ?? 0) > 0) {
        unitPriceNoBDIBase = task.unitPriceNoBDI!;
      } else if ((task.unitPrice ?? 0) > 0) {
        const withBDI = trunc2(task.unitPrice!);
        unitPriceNoBDIBase = trunc2(withBDI / effBdiFactor);
      } else {
        const est = estimateTaskValue(task);
        const withBDI = qtyContracted > 0 ? trunc2(est / qtyContracted) : 0;
        unitPriceNoBDIBase = trunc2(withBDI / effBdiFactor);
        unitPriceIsEstimated = withBDI > 0;
      }

      const calc = calculateMeasurementLine({
        quantityContracted: qtyContracted,
        quantityPeriod: qtyPeriod,
        quantityPriorAccum: qtyPriorAccum,
        unitPriceNoBDI: unitPriceNoBDIBase,
        bdiPercent: lineBdi,
      });

      // Quando vinculado à Sintética, preserva totais contratados EXATOS da planilha (money2, sem trunc)
      const valueContracted = matchedBudget
        ? money2(matchedBudget.totalWithBDI || calc.totalContracted)
        : calc.totalContracted;
      const valueContractedNoBDI = matchedBudget
        ? money2(matchedBudget.totalNoBDI || calc.totalContractedNoBDI)
        : calc.totalContractedNoBDI;
      const valueBalance = matchedBudget
        ? Math.max(0, money2(valueContracted - calc.totalAccumulated))
        : calc.totalBalance;
      const valueBalanceNoBDI = matchedBudget
        ? Math.max(0, money2(valueContractedNoBDI - calc.totalAccumulatedNoBDI))
        : calc.totalBalanceNoBDI;

      const fc = computeTaskForecast({
        task,
        periodStart: effStart,
        periodEnd: effEnd,
        qtyContracted,
        unitPriceWithBDI: calc.unitPriceWithBDI,
        unitPriceNoBDI: calc.unitPriceNoBDI,
        trabalhaSabado,
        unit,
      });

      return {
        item: itemNumber, phaseId: phase.id, phaseChain: chain, taskId: task.id,
        description: task.name, unit,
        itemCode: matchedBudget?.code || task.itemCode || '',
        priceBank: matchedBudget?.bank || task.priceBank || '',
        qtyContracted, qtyPriorAccum, qtyPeriod,
        qtyProposed: qtyPeriod,
        qtyApproved: undefined,
        qtyCurrentAccum: calc.quantityCurrentAccum,
        qtyBalance: calc.quantityBalance,
        percentExecuted: qtyContracted > 0 ? calc.percentExecuted : (task.percentComplete || 0),
        unitPriceNoBDI: calc.unitPriceNoBDI,
        unitPriceWithBDI: calc.unitPriceWithBDI,
        unitPriceIsEstimated,
        valueContractedNoBDI,
        valuePeriodNoBDI: calc.totalPeriodNoBDI,
        valueAccumNoBDI: calc.totalAccumulatedNoBDI,
        valueBalanceNoBDI,
        valueContracted,
        valuePeriod: calc.totalPeriod,
        valueAccum: calc.totalAccumulated,
        valueBalance,
        qtyForecast: fc.qtyForecast,
        valueForecast: fc.valueForecast,
        valueForecastNoBDI: fc.valueForecastNoBDI,
        diffForecastVsReal: trunc2(calc.totalPeriod - fc.valueForecast),
        hasNoLogsInPeriod: logsInfo.hasNoLogsInPeriod,
        hasNoLogsAtAll: logsInfo.hasNoLogsAtAll,
      };
    });

    // ── Itens da Sintética sem vínculo na EAP — agrupados em seção separada ──
    const orphanRows: Row[] = [];
    if (hasSyntheticBudget) {
      syntheticBudgetItems.forEach(b => {
        if (consumed.has(b.id)) return;
        const noBDI = money2(b.unitPriceNoBDI);
        const withBDI = money2(b.unitPriceWithBDI);
        const implicitBdi = noBDI > 0 ? ((withBDI / noBDI) - 1) * 100 : effBdi;
        const calc = calculateMeasurementLine({
          quantityContracted: b.quantity || 0,
          quantityPeriod: 0,
          quantityPriorAccum: 0,
          unitPriceNoBDI: noBDI,
          bdiPercent: implicitBdi,
        });
        const valueContracted = money2(b.totalWithBDI || calc.totalContracted);
        const valueContractedNoBDI = money2(b.totalNoBDI || calc.totalContractedNoBDI);
        const isAdditive = b.source === 'aditivo';
        orphanRows.push({
          item: b.item,
          phaseId: isAdditive ? '__additive_items__' : '__synthetic_orphans__',
          phaseChain: isAdditive ? 'Itens de Aditivo aprovado' : 'Itens da Sintética sem vínculo na EAP',
          taskId: `budget-${b.id}`,
          description: b.description,
          unit: b.unit,
          itemCode: b.code,
          priceBank: b.bank,
          qtyContracted: b.quantity || 0,
          qtyPriorAccum: 0,
          qtyPeriod: 0,
          qtyProposed: 0,
          qtyApproved: undefined,
          qtyCurrentAccum: 0,
          qtyBalance: b.quantity || 0,
          percentExecuted: 0,
          unitPriceNoBDI: noBDI,
          unitPriceWithBDI: withBDI,
          unitPriceIsEstimated: false,
          valueContractedNoBDI,
          valuePeriodNoBDI: 0,
          valueAccumNoBDI: 0,
          valueBalanceNoBDI: valueContractedNoBDI,
          valueContracted,
          valuePeriod: 0,
          valueAccum: 0,
          valueBalance: valueContracted,
          qtyForecast: 0,
          valueForecast: 0,
          valueForecastNoBDI: 0,
          diffForecastVsReal: 0,
          hasNoLogsInPeriod: true,
          hasNoLogsAtAll: true,
        });
      });
    }

    return [...eapRows, ...orphanRows];
  }, [isSnapshotMode, activeMeasurement, orderedTasks, effStart, effEnd, effBdi, effBdiFactor, priorAccumByTask, hasSyntheticBudget, syntheticBudgetItems, taskById, trabalhaSabado]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (!isSnapshotMode && chapterFilter !== 'all') {
        const phase = project.phases.find(p => p.id === r.phaseId);
        let match = false;
        let cur: Phase | undefined = phase;
        while (cur) {
          if (cur.id === chapterFilter) { match = true; break; }
          cur = cur.parentId ? project.phases.find(p => p.id === cur!.parentId) : undefined;
        }
        if (!match) return false;
      }
      if (q) {
        const blob = `${r.item} ${r.phaseChain} ${r.description} ${r.itemCode}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [rows, chapterFilter, search, project.phases, isSnapshotMode]);

  // ───────── Árvore de grupos ─────────
  const groupTree: GroupNode[] = useMemo(() => {
    const rowsByPhase = new Map<string, Row[]>();
    filteredRows.forEach(r => {
      const arr = rowsByPhase.get(r.phaseId) || [];
      arr.push(r);
      rowsByPhase.set(r.phaseId, arr);
    });

    const tree = getChapterTree(project);

    const buildNode = (chapterNode: ChapterNode, depth: number): GroupNode | null => {
      const directRows = rowsByPhase.get(chapterNode.phase.id) || [];
      const childGroups = chapterNode.children
        .map(c => buildNode(c, depth + 1))
        .filter((g): g is GroupNode => g !== null);
      if (directRows.length === 0 && childGroups.length === 0) return null;

      const totals = emptyTotals();
      directRows.forEach(r => {
        totals.contracted += r.valueContracted;
        totals.period += r.valuePeriod;
        totals.accum += r.valueAccum;
        totals.balance += r.valueBalance;
        totals.contractedNoBDI += r.valueContractedNoBDI;
        totals.periodNoBDI += r.valuePeriodNoBDI;
        totals.accumNoBDI += r.valueAccumNoBDI;
        totals.balanceNoBDI += r.valueBalanceNoBDI;
        totals.qtyContracted += r.qtyContracted;
        totals.qtyAccum += r.qtyCurrentAccum;
        totals.forecast += r.valueForecast;
        totals.forecastNoBDI += r.valueForecastNoBDI;
        totals.diffForecast += r.diffForecastVsReal;
      });
      childGroups.forEach(c => {
        totals.contracted += c.totals.contracted;
        totals.period += c.totals.period;
        totals.accum += c.totals.accum;
        totals.balance += c.totals.balance;
        totals.contractedNoBDI += c.totals.contractedNoBDI;
        totals.periodNoBDI += c.totals.periodNoBDI;
        totals.accumNoBDI += c.totals.accumNoBDI;
        totals.balanceNoBDI += c.totals.balanceNoBDI;
        totals.qtyContracted += c.totals.qtyContracted;
        totals.qtyAccum += c.totals.qtyAccum;
        totals.forecast += c.totals.forecast;
        totals.forecastNoBDI += c.totals.forecastNoBDI;
        totals.diffForecast += c.totals.diffForecast;
      });

      return {
        phaseId: chapterNode.phase.id,
        number: numbering.get(chapterNode.phase.id) || '',
        name: chapterNode.phase.name,
        depth, rows: directRows, children: childGroups, totals,
      };
    };

    const groups = tree
      .map(n => buildNode(n, 0))
      .filter((g): g is GroupNode => g !== null);
    const sorted = groups.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));

    // Seção extra: itens da Sintética sem vínculo na EAP (apenas para revisão)
    const orphanRows = rowsByPhase.get('__synthetic_orphans__') || [];
    if (orphanRows.length > 0) {
      const orphanTotals = emptyTotals();
      orphanRows.forEach(r => {
        orphanTotals.contracted += r.valueContracted;
        orphanTotals.period += r.valuePeriod;
        orphanTotals.accum += r.valueAccum;
        orphanTotals.balance += r.valueBalance;
        orphanTotals.contractedNoBDI += r.valueContractedNoBDI;
        orphanTotals.periodNoBDI += r.valuePeriodNoBDI;
        orphanTotals.accumNoBDI += r.valueAccumNoBDI;
        orphanTotals.balanceNoBDI += r.valueBalanceNoBDI;
        orphanTotals.qtyContracted += r.qtyContracted;
        orphanTotals.qtyAccum += r.qtyCurrentAccum;
        orphanTotals.forecast += r.valueForecast;
        orphanTotals.forecastNoBDI += r.valueForecastNoBDI;
        orphanTotals.diffForecast += r.diffForecastVsReal;
      });
      sorted.push({
        phaseId: '__synthetic_orphans__',
        number: '∅',
        name: 'Itens da Sintética sem vínculo na EAP',
        depth: 0,
        rows: orphanRows,
        children: [],
        totals: orphanTotals,
      });
    }
    return sorted;
  }, [filteredRows, project, numbering]);

  const totals = useMemo(() => {
    const t = emptyTotals();
    filteredRows.forEach(r => {
      t.contracted += r.valueContracted; t.period += r.valuePeriod;
      t.accum += r.valueAccum; t.balance += r.valueBalance;
      t.contractedNoBDI += r.valueContractedNoBDI; t.periodNoBDI += r.valuePeriodNoBDI;
      t.accumNoBDI += r.valueAccumNoBDI; t.balanceNoBDI += r.valueBalanceNoBDI;
      t.qtyContracted += r.qtyContracted; t.qtyAccum += r.qtyCurrentAccum;
      t.forecast += r.valueForecast; t.forecastNoBDI += r.valueForecastNoBDI;
      t.diffForecast += r.diffForecastVsReal;
    });
    // Normaliza acumuladores em 2 casas (arredondamento seguro) p/ bater com Excel
    t.contracted = money2(t.contracted); t.period = money2(t.period);
    t.accum = money2(t.accum); t.balance = money2(t.balance);
    t.contractedNoBDI = money2(t.contractedNoBDI); t.periodNoBDI = money2(t.periodNoBDI);
    t.accumNoBDI = money2(t.accumNoBDI); t.balanceNoBDI = money2(t.balanceNoBDI);
    t.forecast = money2(t.forecast); t.forecastNoBDI = money2(t.forecastNoBDI);
    t.diffForecast = money2(t.diffForecast);
    const pctPeriod = t.contracted > 0 ? (t.period / t.contracted) * 100 : 0;
    const pctAccum = t.contracted > 0 ? (t.accum / t.contracted) * 100 : 0;
    const pctBalance = t.contracted > 0 ? (t.balance / t.contracted) * 100 : 0;
    return { ...t, pctPeriod, pctAccum, pctBalance };
  }, [filteredRows]);

  return {
    syntheticBudgetItems,
    hasSyntheticBudget,
    numbering,
    orderedTasks,
    activeMeasurement,
    isLocked,
    isSnapshotMode,
    effStart,
    effEnd,
    effBdi,
    effBdiFactor,
    effIssue,
    effNumber,
    priorAccumByTask,
    rows,
    filteredRows,
    groupTree,
    totals,
  };
}
