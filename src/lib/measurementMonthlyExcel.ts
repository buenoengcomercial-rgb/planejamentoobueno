import type { CellObject, WorkBook, WorkSheet, Range } from 'xlsx';
import { measurementBulletin, measurementStatusLabels, monthlyLines, type MeasurementWorkspace } from './measurementWorkspace';
import { measurementPresentation } from '@/components/measurement/measurementWorkspacePresentation';
import type { GroupNode, GroupTotals, Row } from '@/components/measurement/types';
import { fmtDateBR } from '@/components/measurement/measurementFormat';
import { monthlyPdfColumns, type MonthlyPdfOptions } from './measurementMonthlyPdf';

const ink = '0F172A', muted = '64748B', border = 'E2E8F0', primary = '3B82F6';
const groupHeads = ['F1F5F9', 'E0F2FE', 'D1FAE5', 'FEF3C7', 'FFE4E6'];
const groupFills = ['F8FAFC', 'F3F9FD', 'F0FCF5', 'FFFCEF', 'FFF5F7'];
const currency = '"R$" #,##0.00', quantity = '#,##0.###';
const groupIndex = (column: number) => column < 5 ? 0 : column < 9 ? 1 : column < 11 ? 2 : column < 13 ? 3 : 4;
const columnWidths = [8, 12, 12, 50, 7, 12, 18, 18, 20, 12, 20, 12, 20, 12, 20];

/** A formatted snapshot of the same ledger and hierarchy rendered on the page. */
export async function buildMonthlyMeasurementExcel(w: MeasurementWorkspace, id: string, options: MonthlyPdfOptions = {}): Promise<WorkBook> {
  const mod = await import('xlsx-js-style');
  const XLSX = mod.default ?? mod;
  const period = w.periods.find(p => p.id === id);
  if (!period) throw new Error('Medição não encontrada.');
  const bulletin = measurementBulletin(w, id), contract = bulletin.contract;
  const { rows, groupTree, totals } = measurementPresentation(monthlyLines(w, id));
  const sheet: WorkSheet = {}, merges: Range[] = [], heights: { hpt: number }[] = [];
  let row = 0;
  const style = (fill = 'FFFFFF', bold = false, color = ink, align = 'center', size = 10) => ({
    font: { name: 'Arial', sz: size, bold, color: { rgb: color } },
    fill: { patternType: 'solid', fgColor: { rgb: fill } },
    alignment: { horizontal: align, vertical: 'center', wrapText: true },
    border: Object.fromEntries(['top', 'bottom', 'left', 'right'].map(edge => [edge, { style: 'thin', color: { rgb: border } }])),
  });
  const put = (r: number, c: number, value: string | number, cellStyle = style(), format?: string) => {
    sheet[XLSX.utils.encode_cell({ r, c })] = { v: value, t: typeof value === 'number' ? 'n' : 's', s: { ...cellStyle, ...(format ? { numFmt: format } : {}) }, ...(format ? { z: format } : {}) } as CellObject;
  };
  const merged = (r: number, first: number, last: number, value: string | number, cellStyle = style(), format?: string) => {
    for (let c = first; c <= last; c++) put(r, c, c === first ? value : '', cellStyle, c === first ? format : undefined);
    if (last > first) merges.push({ s: { r, c: first }, e: { r, c: last } });
  };
  const blank = () => { heights[row++] = { hpt: 9 }; };
  merged(row, 0, 12, 'BOLETIM DE MEDIÇÃO PARA PAGAMENTO', style('F8FAFC', true, ink, 'left', 14));
  merged(row, 13, 14, 'MEDIÇÃO Nº', style('F8FAFC', true, muted, 'center', 9)); heights[row++] = { hpt: 27 };
  const dates = `${fmtDateBR(period.startDate)} a ${fmtDateBR(period.endDate)}`;
  merged(row, 0, 12, `${bulletin.projectName} · Período ${dates}`, style('F8FAFC', false, muted, 'left'));
  merged(row, 13, 14, period.number, style('F8FAFC', true, ink, 'center', 14), '0'); heights[row++] = { hpt: 22 };
  type Field = [number, number, string, string | number];
  const fields: Field[][] = [
    [[0, 6, 'CONTRATANTE', contract.contractor ?? ''], [7, 14, 'CONTRATADA', contract.contracted ?? '']],
    [[0, 9, 'OBRA', bulletin.projectName], [10, 14, 'LOCAL / MUNICÍPIO', contract.location ?? '']],
    [[0, 9, 'OBJETO', contract.contractObject ?? ''], [10, 13, 'Nº DO CONTRATO', contract.contractNumber ?? '']],
    [[0, 3, 'Nº DA ART', contract.artNumber ?? ''], [4, 8, 'PERÍODO DA MEDIÇÃO', dates], [9, 11, 'DATA DE EMISSÃO', fmtDateBR(bulletin.issueDate)]],
    [[0, 4, 'FONTE DE ORÇAMENTO', contract.budgetSource ?? ''], [5, 6, 'BDI %', contract.bdiPercent ?? 0], [7, 9, 'MEDIÇÃO Nº', period.number]],
  ];
  for (const group of fields) {
    group.forEach(([first, last, label]) => merged(row, first, last, label, style('FFFFFF', true, muted, 'left', 9)));
    heights[row++] = { hpt: 18 };
    let h = 22;
    group.forEach(([first, last, label, value]) => {
      merged(row, first, last, value, style('FFFFFF', false, ink, 'left'), label === 'BDI %' ? '0.00' : label === 'MEDIÇÃO Nº' ? '0' : undefined);
      const width = columnWidths.slice(first, last + 1).reduce((a, b) => a + b, 0);
      h = Math.max(h, Math.ceil(String(value).length / (width * 0.85)) * 14 + 8);
    });
    heights[row++] = { hpt: h };
  }
  blank();
  merged(row, 0, 14, `Situação: ${measurementStatusLabels[period.status]} · Acumulado inclui a medição selecionada.`, style('FFFFFF', false, muted, 'left', 9)); heights[row++] = { hpt: 20 };
  merged(row, 0, 14, `Planilha de medição (${rows.length} itens)`, style('F8FAFC', true, ink, 'left', 11)); heights[row++] = { hpt: 25 };
  [[0, 4, 'IDENTIFICAÇÃO'], [5, 8, 'CONTRATO'], [9, 10, 'MEDIÇÃO ATUAL'], [11, 12, 'ACUMULADO'], [13, 14, 'SALDO']].forEach(([first, last, label], i) => merged(row, Number(first), Number(last), String(label), style(groupHeads[i], true, ink, 'center', 10)));
  heights[row++] = { hpt: 22 };
  monthlyPdfColumns.forEach((label, c) => put(row, c, label, style('F1F5F9', true, ink, c === 3 ? 'left' : 'center', 9))); heights[row++] = { hpt: 34 };
  const totalRow = (t: GroupTotals, label: string, fill: string, color = ink) => {
    merged(row, 0, 7, label, style(fill, true, color, label === 'TOTAL GERAL' ? 'center' : 'left'));
    [t.contracted, '-', t.period, '-', t.accum, '-', t.balance].forEach((value, i) => put(row, i + 8, value, style(fill, true, color), typeof value === 'number' ? currency : undefined));
    heights[row++] = { hpt: 24 };
  };
  const service = (r: Row) => {
    const excess = r.qtyCurrentAccum - r.qtyContracted > 1e-9;
    const description = `${r.description}${excess ? `\nUltrapassou o limite contratado: ${r.qtyCurrentAccum - r.qtyContracted} ${r.unit}` : ''}`;
    const values = [r.item, r.itemCode || '-', r.priceBank || '-', description, r.unit, r.qtyContracted, r.unitPriceNoBDI, r.unitPriceWithBDI, r.valueContracted, r.qtyPeriod, r.valuePeriod, r.qtyCurrentAccum, r.valueAccum, r.qtyBalance, r.valueBalance];
    values.forEach((value, c) => {
      const fill = excess ? 'FEF3C7' : c < 4 && r.hasNoLogsInPeriod ? 'FFF8EC' : groupFills[groupIndex(c)];
      put(row, c, value, style(fill, c === 10, c >= 13 ? muted : ink, c === 3 ? 'left' : 'center'), typeof value === 'number' ? [5, 9, 11, 13].includes(c) ? quantity : currency : undefined);
    });
    const lines = description.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 48)), 0);
    heights[row++] = { hpt: Math.max(25, lines * 15 + 10) };
  };
  const walk = (g: GroupNode) => { totalRow(g.totals, `${'  '.repeat(g.depth)}${g.number}  ${g.name.toUpperCase()}`, g.depth === 0 ? 'EBF2FE' : g.depth === 1 ? 'F2F6FA' : 'F8FAFC'); g.rows.forEach(service); g.children.forEach(walk); };
  groupTree.forEach(walk);
  totalRow(totals, 'TOTAL GERAL', ink, 'FFFFFF'); blank();
  const bdi = w.contract?.bdiPercent ?? period.originalSnapshot?.bdiPercent ?? (totals.contractedNoBDI > 0 ? (totals.contracted / totals.contractedNoBDI - 1) * 100 : 0);
  const pct = (value: number) => totals.contracted > 0 ? value / totals.contracted : 0;
  const blocks = [[0, 4], [5, 9], [10, 14]];
  ['SEM BDI', `BDI (${bdi.toFixed(2)}%)`, 'COM BDI'].forEach((title, i) => merged(row, blocks[i][0], blocks[i][1], title, style(i === 2 ? 'F0F6FF' : 'FFFFFF', true, ink, 'left'))); heights[row++] = { hpt: 24 };
  const summaries: [string, number, string?][][] = [
    [['Custo total da obra', totals.contractedNoBDI], ['Valor desta medição', totals.periodNoBDI], ['Valor acumulado', totals.accumNoBDI], ['Valor a executar', totals.balanceNoBDI]],
    [['BDI total', totals.contracted - totals.contractedNoBDI], ['BDI desta medição', totals.period - totals.periodNoBDI], ['BDI acumulado', totals.accum - totals.accumNoBDI], ['BDI a executar', totals.balance - totals.balanceNoBDI]],
    [['Custo total da obra', totals.contracted], ['Valor desta medição', totals.period], ['Valor acumulado', totals.accum], ['Valor a executar', totals.balance], ['% desta medição', pct(totals.period), '0.00%'], ['% acumulado', pct(totals.accum), '0.00%'], ['% a executar', pct(totals.balance), '0.00%']],
  ];
  for (let i = 0; i < 7; i++) {
    blocks.forEach(([first, last], b) => {
      const [label, value, format] = summaries[b][i] ?? ['', '', undefined];
      merged(row, first, last - 2, label, style(b === 2 ? 'F0F6FF' : 'FFFFFF', false, muted, 'left', 9));
      merged(row, last - 1, last, value, style(b === 2 ? 'F0F6FF' : 'FFFFFF', true, b === 2 ? primary : ink, 'right'), typeof value === 'number' ? format ?? currency : undefined);
    }); heights[row++] = { hpt: 23 };
  }
  blank();
  const mini = [[0, 2], [3, 3], [4, 6], [7, 8], [9, 11], [12, 14]];
  const cards: [string, number, string?][] = [['CONTRATADO C/ BDI', totals.contracted], ['DESTA MEDIÇÃO', totals.period], ['ACUMULADO', totals.accum], ['SALDO A EXECUTAR', totals.balance], ['% DESTA MEDIÇÃO', pct(totals.period), '0.00%'], ['% ACUMULADO', pct(totals.accum), '0.00%']];
  cards.forEach(([label], i) => merged(row, mini[i][0], mini[i][1], label, style(i === 1 ? 'F0F6FF' : 'FFFFFF', true, muted, 'left', 9))); heights[row++] = { hpt: 26 };
  cards.forEach(([, value, format], i) => merged(row, mini[i][0], mini[i][1], value, style(i === 1 ? 'F0F6FF' : 'FFFFFF', true, i === 1 ? primary : ink, 'left', 11), format ?? currency)); heights[row++] = { hpt: 28 };
  blank();
  const forecast = options.forecastTotal ?? null, difference = forecast === null ? null : totals.period - forecast;
  ['PREVISTO NO PERÍODO (GANTT)', 'REALIZADO NO PERÍODO', 'DIFERENÇA REAL X PREVISTO'].forEach((label, i) => merged(row, blocks[i][0], blocks[i][1], label, style(i === 0 ? 'F0FAFE' : 'FFFFFF', true, muted, 'left', 9))); heights[row++] = { hpt: 24 };
  [forecast, totals.period, difference].forEach((value, i) => merged(row, blocks[i][0], blocks[i][1], value ?? 'Não disponível', style(i === 0 ? 'F0FAFE' : 'FFFFFF', true, i === 0 ? '0EA5E9' : i === 2 && difference !== null ? difference < 0 ? 'EF4444' : '22C55E' : ink, 'left', 11), value === null ? undefined : currency)); heights[row++] = { hpt: 28 };
  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: row - 1, c: 14 } });
  sheet['!merges'] = merges; sheet['!rows'] = heights; sheet['!cols'] = columnWidths.map(wch => ({ wch }));
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Medição mensal');
  return book;
}

export async function saveMonthlyMeasurementExcel(w: MeasurementWorkspace, id: string, options: MonthlyPdfOptions = {}) {
  const mod = await import('xlsx-js-style'), XLSX = mod.default ?? mod;
  const book = await buildMonthlyMeasurementExcel(w, id, options);
  XLSX.writeFile(book, `medicao-${w.periods.find(p => p.id === id)!.number}.xlsx`);
}
