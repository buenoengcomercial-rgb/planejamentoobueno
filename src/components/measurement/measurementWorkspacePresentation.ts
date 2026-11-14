import type { MonthlyLine } from '@/lib/measurementWorkspace';
import { sumMoney } from '@/lib/financialEngine';
import { emptyTotals } from './measurementFormat';
import type { GroupNode, GroupTotals, Row } from './types';

const pathSeparator = ' › ';

/** Older incorporated services can carry a subchapter ID in the ledger's root chapter field. */
export function measurementChapterOverrides(lines: MonthlyLine[]) {
  const rootsByNumber = new Map<string, Map<string, { id: string; name: string }>>();
  const rootIds = new Set<string>();
  for (const { service } of lines) {
    if (service.additiveId) continue;
    rootIds.add(service.chapterId);
    const number = /^([0-9]+)\./.exec(service.item)?.[1];
    if (!number) continue;
    const roots = rootsByNumber.get(number) ?? new Map();
    roots.set(service.chapterId, { id: service.chapterId, name: service.path.split(pathSeparator)[0] || service.chapter });
    rootsByNumber.set(number, roots);
  }
  const overrides = new Map<string, { id: string; name: string; path: string }>();
  for (const { service } of lines) {
    if (!service.additiveId || rootIds.has(service.chapterId)) continue;
    const item = /^(\d+)(\.\d+)+$/.exec(service.item.trim());
    const roots = item && rootsByNumber.get(item[1]);
    if (!roots || roots.size !== 1) continue;
    const root = [...roots.values()][0];
    const segments = service.item.trim().split('.');
    const subchapter = segments.slice(0, -1).join('.');
    const names = service.path.split(pathSeparator).map(name => name.trim()).filter(Boolean);
    if (names[0] === root.name) names.shift();
    if (names.length === 1 && names[0].startsWith(subchapter + ' ')) {
      names[0] = names[0].slice(subchapter.length).trim();
    } else if (names.length === 1 && names[0] === service.chapter) continue;
    if (!names.length || names.length > segments.length - 2) continue;
    overrides.set(service.id, { ...root, path: [root.name, ...names].join(pathSeparator) });
  }
  return overrides;
}

/** Adapts the independent ledger to the existing table; no Project or planning reads. */
export function measurementPresentation(lines: MonthlyLine[], overrides = measurementChapterOverrides(lines)) {
  const rows: Row[] = lines.map(({ service: s, qty, prior, accumulated, balance, financial: f }) => ({
    taskId: s.id, item: s.item, description: s.description, unit: s.unit,
    phaseId: overrides.get(s.id)?.id ?? s.chapterId, phaseChain: overrides.get(s.id)?.path ?? s.path, itemCode: s.code ?? '', priceBank: s.bank ?? '',
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
