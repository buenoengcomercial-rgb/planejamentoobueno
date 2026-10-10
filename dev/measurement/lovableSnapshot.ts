import type { Project, Phase } from '../../src/types/project';
import { createIncorporationBackup, prepareIncorporation } from '../../src/lib/measurementIncorporation';
import { monthlyLines } from '../../src/lib/measurementWorkspace';
import { calculateLineTotal, sumMoney } from '../../src/lib/financialEngine';

type Cell = string | number | null;
type Sheet = Cell[][];
const text = (value: Cell | undefined) => String(value ?? '').trim();
const fail = (message: string): never => { throw new Error(`Cópia local da Medição: ${message}`); };
const number = (value: Cell | undefined, label: string) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fail(`${label} ausente ou inválido.`);
const isoDate = (date: string) => {
  const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
  if (!parts) return fail(`data inválida: ${date}.`);
  const iso = `${parts[3]}-${parts[2]}-${parts[1]}`;
  if (new Date(`${iso}T12:00:00Z`).toISOString().slice(0, 10) !== iso) return fail(`data inválida: ${date}.`);
  return iso;
};

/** Dev-only adapter of an exported sheet, never a cloud backup or operational migration. */
export async function lovableSheetPreview(rows: Sheet, hash: string) {
  const metadata = (label: string) => {
    for (const row of rows) {
      const index = row.findIndex(cell => text(cell) === label);
      if (index >= 0) return row[index + 1];
    }
    return fail(`cabeçalho ${label} não encontrado.`);
  };
  const header = rows.findIndex(row => text(row[0]) === 'Item' && text(row[3]) === 'Descrição');
  const expected = ['Item', 'Código', 'Banco', 'Descrição', 'Und.', 'Quant. Contratada', 'V. Unit. s/ BDI', 'V. Unit. c/ BDI', 'Total Contratado', 'Quant. Medição', 'Subtotal Medição', 'Quant. Acumulada', 'Subtotal Acumulado', 'Quant. a Executar', 'Subtotal a Executar'];
  if (header < 0 || expected.some((name, i) => text(rows[header][i]) !== name)) return fail('formato da planilha não reconhecido.');
  const periodNumber = Number(metadata('Medição Nº:'));
  // A later export cannot reconstruct the individual prior periods from an accumulated value.
  if (periodNumber !== 1) return fail('para simular medições posteriores, forneça também os períodos anteriores; o acumulado não será convertido em lançamento.');
  const [from, to] = text(metadata('Período:')).split(' a ');
  const startDate = isoDate(from), endDate = isoDate(to);
  if (endDate < startDate) return fail('período invertido.');
  if (text(metadata('Status:')) !== 'Em preparação') return fail('esta prévia aceita apenas uma cópia da medição em preparação.');
  const project: Project = {
    id: `measurement-preview-export-${hash}`, name: text(metadata('Obra:')),
    startDate, endDate, totalBudget: 0, phases: [], budgetItems: [],
    contractInfo: {
      contractor: text(metadata('Contratante:')), contracted: text(metadata('Contratada:')),
      contractNumber: text(metadata('Nº Contrato:')), contractObject: text(metadata('Objeto:')),
      location: text(metadata('Local/Município:')), artNumber: text(metadata('Nº ART:')),
      budgetSource: text(metadata('Fonte de orçamento:')), bdiPercent: number(metadata('BDI %:'), 'BDI'),
    },
    measurements: [{ id: 'export-period-1', number: periodNumber, startDate, endDate,
      issueDate: isoDate(text(metadata('Data emissão:'))), status: 'draft',
      bdiPercent: number(metadata('BDI %:'), 'BDI'), items: [] }],
  };
  const phases = new Map<string, Phase>();
  const sourceItems = new Map<string, Cell[]>();
  for (const row of rows.slice(header + 1)) {
    const item = text(row[0]);
    if (!item) continue; // Exported subtotal/total lines are reconciled separately below.
    if (!/^\d+(\.\d+)*$/.test(item) || phases.has(item) || sourceItems.has(item)) return fail(`item inválido ou repetido: ${item}.`);
    const parentCode = item.split('.').slice(0, -1).join('.');
    const parent = phases.get(parentCode);
    if (!text(row[4])) {
      if (parentCode && !parent) return fail(`capítulo pai de ${item} ausente.`);
      const phase: Phase = { id: `export-chapter-${item}`, parentId: parent?.id, name: text(row[3]), color: '#3b82f6', tasks: [] };
      phases.set(item, phase); project.phases.push(phase); continue;
    }
    if (!parent) return fail(`capítulo de ${item} ausente.`);
    const quantity = number(row[5], `${item} contratado`), price = number(row[6], `${item} preço`), withBDI = number(row[7], `${item} preço com BDI`);
    const qty = number(row[9], `${item} medição`), accumulated = number(row[11], `${item} acumulado`);
    if (qty !== accumulated) return fail(`${item}: acumulado inclui valores sem período de origem.`);
    if (qty > quantity) return fail(`${item}: medição excede o contratado.`);
    const id = `export-service-${item}`;
    parent.tasks.push({ id, name: text(row[3]), phase: parent.id, startDate, duration: 1, dependencies: [], responsible: '', percentComplete: 0, materials: [], level: 0, quantity, unit: text(row[4]), dailyLogs: [] });
    project.budgetItems!.push({ id: `export-budget-${item}`, taskId: id, item, code: text(row[1]), bank: text(row[2]), description: text(row[3]), unit: text(row[4]), quantity, unitPriceNoBDI: price, unitPriceWithBDI: withBDI, totalNoBDI: calculateLineTotal(price, quantity), totalWithBDI: number(row[8], `${item} total contratado`), source: 'sintetica' });
    const chain = item.split('.').slice(0, -1).map((_, i, all) => phases.get(all.slice(0, i + 1).join('.'))!.name).join(' › ');
    project.measurements![0].items.push({ item, phaseId: parent.id, phaseChain: chain, taskId: id, description: text(row[3]), unit: text(row[4]), itemCode: text(row[1]), priceBank: text(row[2]), qtyContracted: quantity, unitPriceNoBDI: price, unitPriceWithBDI: withBDI, qtyProposed: qty, qtyPriorAccum: 0 });
    sourceItems.set(item, row);
  }
  if (!sourceItems.size) return fail('nenhum serviço encontrado.');
  const totals = rows.filter(row => text(row[3]) === 'TOTAL GERAL');
  if (totals.length !== 1) return fail('total geral ausente ou repetido; carga não confirmada.');
  project.totalBudget = number(totals[0][8], 'total contratado');
  const backup = await createIncorporationBackup(project, [], []);
  const incorporation = prepareIncorporation(backup);
  if (incorporation.issues.length) return fail(incorporation.issues.map(i => i.message).join(' '));
  const lines = monthlyLines(incorporation.candidate, 'export-period-1');
  const checks = [[8, 'totalContracted'], [10, 'totalPeriod'], [12, 'totalAccumulated'], [14, 'totalBalance']] as const;
  const match = (actual: number, expected: number, label: string) => {
    if (Math.abs(actual - expected) > 0.005) fail(`${label}: ${actual} difere do exportado ${expected}.`);
  };
  for (const line of lines) {
    const row = sourceItems.get(line.service.item)!;
    for (const [column, field] of checks) match(line.financial[field], number(row[column], line.service.item), line.service.item);
    match(line.balance, number(row[13], `${line.service.item} saldo`), `${line.service.item} saldo`);
  }
  for (const [column, field] of checks) match(sumMoney(lines.map(line => line.financial[field])), number(totals[0][column], field), field);
  return { project, plans: [], backup, itemCount: lines.length, chapterCount: project.phases.filter(p => !p.parentId).length };
}
