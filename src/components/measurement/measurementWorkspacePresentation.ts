import type { MonthlyLine } from '@/lib/measurementWorkspace';
import { sumMoney } from '@/lib/financialEngine';
import { emptyTotals } from './measurementFormat';
import type { GroupNode, GroupTotals, Row } from './types';

/** Adapts the independent ledger to the existing table; no Project or planning reads. */
export function measurementPresentation(lines: MonthlyLine[]) {
  const rows: Row[] = lines.map(({ service: s, qty, prior, accumulated, balance, financial: f }) => ({
    taskId: s.id, item: s.item, description: s.description, unit: s.unit,
    phaseId: s.chapterId, phaseChain: s.path, itemCode: s.code ?? '', priceBank: s.bank ?? '',
    qtyContracted: s.contracted, qtyPeriod: qty, qtyProposed: qty, qtyPriorAccum: prior,
    qtyCurrentAccum: accumulated, qtyBalance: balance, percentExecuted: f.percentExecuted,
    unitPriceNoBDI: f.unitPriceNoBDI, unitPriceWithBDI: f.unitPriceWithBDI, unitPriceIsEstimated: false,
    valueContracted: f.totalContracted, valuePeriod: f.totalPeriod, valueAccum: f.totalAccumulated, valueBalance: f.totalBalance,
    valueContractedNoBDI: f.totalContractedNoBDI, valuePeriodNoBDI: f.totalPeriodNoBDI,
    valueAccumNoBDI: f.totalAccumulatedNoBDI, valueBalanceNoBDI: f.totalBalanceNoBDI,
    hasNoLogsInPeriod: qty === 0, hasNoLogsAtAll: accumulated === 0,
    qtyForecast: 0, valueForecast: 0, valueForecastNoBDI: 0, diffForecastVsReal: 0,
    originAdditiveId: s.additiveId, originAdditiveVersion: s.additiveVersion,
  }));
  const totalsOf = (items: Row[]): GroupTotals => ({ ...emptyTotals(),
    contracted: sumMoney(items.map(r => r.valueContracted)), period: sumMoney(items.map(r => r.valuePeriod)),
    accum: sumMoney(items.map(r => r.valueAccum)), balance: sumMoney(items.map(r => r.valueBalance)),
    contractedNoBDI: sumMoney(items.map(r => r.valueContractedNoBDI)), periodNoBDI: sumMoney(items.map(r => r.valuePeriodNoBDI)),
    accumNoBDI: sumMoney(items.map(r => r.valueAccumNoBDI)), balanceNoBDI: sumMoney(items.map(r => r.valueBalanceNoBDI)),
  });
  const groupTree: GroupNode[] = [];
  for (const r of rows) {
    const names = r.phaseChain.split(' › '), numbers = r.item.split('.').slice(0, -1);
    let siblings = groupTree;
    names.forEach((name, depth) => {
      const id = `${r.phaseId}:${names.slice(0, depth + 1).join(' › ')}`;
      let group = siblings.find(g => g.phaseId === id);
      if (!group) { group = { phaseId: id, name, number: numbers.slice(0, depth + 1).join('.'), depth, rows: [], children: [], totals: emptyTotals() }; siblings.push(group); }
      if (depth === names.length - 1) group.rows.push(r);
      siblings = group.children;
    });
  }
  const summarize = (g: GroupNode): Row[] => {
    const items = [...g.rows, ...g.children.flatMap(summarize)];
    g.totals = totalsOf(items); return items;
  };
  groupTree.forEach(summarize);
  return { rows, groupTree, totals: totalsOf(rows) };
}
