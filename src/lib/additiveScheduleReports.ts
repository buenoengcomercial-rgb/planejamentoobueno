/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Additive, AdditiveScheduleSnapshotRow, Phase, Project } from '@/types/project';
import { buildAdditiveScheduleForecast } from '@/lib/additiveScheduleForecast';
import { flattenPhasesByChapter, getChapterNumbering } from '@/lib/chapters';
import { sortTasksForSchedule } from '@/lib/taskOrdering';
import { getWorkStartDate } from '@/lib/workStartDate';
import {
  ADDITIVE_SCHEDULE_GUIDANCE,
  ADDITIVE_SCHEDULE_REFERENCE,
  ADDITIVE_SCHEDULE_WARNING,
  FULLY_SUPPRESSED_STATUS_LABEL,
  getFullySuppressedTaskIds,
  isStatusOnlyScheduleRow,
} from '@/lib/additiveSchedule';

const safeFile = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
const brl = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateBR = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '-';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
};
const endDate = (start: string, duration: number) => {
  const date = new Date(`${start}T12:00:00`);
  date.setDate(date.getDate() + Math.max(0, duration - 1));
  return date.toISOString().slice(0, 10);
};

const classificationLabel = (row: AdditiveScheduleSnapshotRow) => ({
  contracted_released: 'Contratado liberado',
  contracted_suspended: 'Contratado suspenso',
  proposed_addition: 'Proposta - acréscimo',
  proposed_suppression: 'Proposta - supressão',
}[row.classification]);

const classificationColor = (row: AdditiveScheduleSnapshotRow): [number, number, number] => ({
  contracted_released: [5, 150, 105],
  contracted_suspended: [217, 119, 6],
  proposed_addition: [225, 29, 72],
  proposed_suppression: [185, 28, 28],
}[row.classification] as [number, number, number]);

const blockingLabel = (row: AdditiveScheduleSnapshotRow) => (row.blockingCompositions ?? [])
  .map(item => {
    const ref = [item.item, item.code].filter(Boolean).join(' - ');
    const quantity = Math.abs(item.quantity);
    const impact = quantity > 0 ? `${quantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}${item.unit ? ` ${item.unit}` : ''}` : 'alteração de preço/escopo';
    return `${ref ? `${ref}: ` : ''}${item.description} (${impact})`;
  })
  .join('; ');

async function loadXlsx() {
  const mod: any = await import('xlsx-js-style');
  return mod.default || mod;
}

function styleSheet(XLSX: any, sheet: any, headerRow = 0) {
  if (!sheet['!ref']) return;
  const range = XLSX.utils.decode_range(sheet['!ref']);
  for (let col = range.s.c; col <= range.e.c; col += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: headerRow, c: col })];
    if (cell) cell.s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '334155' } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } };
  }
  sheet['!freeze'] = { xSplit: 0, ySplit: headerRow + 1 };
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ r: headerRow, c: range.s.c }, { r: range.e.r, c: range.e.c }) };
}

const bodyStyle = (fill = 'FFFFFF', options?: { centered?: boolean; wrap?: boolean; bold?: boolean }) => ({
  font: { color: { rgb: '1F2937' }, bold: options?.bold },
  fill: { fgColor: { rgb: fill } },
  alignment: {
    horizontal: options?.centered ? 'center' : 'left',
    vertical: 'center',
    wrapText: options?.wrap ?? false,
  },
  border: { bottom: { style: 'thin', color: { rgb: 'E2E8F0' } } },
});

const excelDate = (date: string) => new Date(`${date}T12:00:00`);

const normalizeLegacyRows = (rows: AdditiveScheduleSnapshotRow[], additive: Additive) => {
  const fullySuppressedTaskIds = getFullySuppressedTaskIds(additive);
  return rows.map(row => fullySuppressedTaskIds.has(row.taskId) && isStatusOnlyScheduleRow(row)
    ? { ...row, scheduleState: 'fully_suppressed' as const, statusLabel: FULLY_SUPPRESSED_STATUS_LABEL }
    : row);
};

export async function buildAdditiveScheduleWorkbook(
  project: Project,
  additive: Additive,
  rows: AdditiveScheduleSnapshotRow[],
  trabalhaSabado = false,
) {
  rows = normalizeLegacyRows(rows, additive);
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();
  const activities = [
    [ADDITIVE_SCHEDULE_WARNING],
    [ADDITIVE_SCHEDULE_GUIDANCE],
    [ADDITIVE_SCHEDULE_REFERENCE],
    [],
    ['Item', 'Código', 'Capítulo', 'Descrição', 'Classificação', 'Situação', 'Início', 'Fim', 'Duração (d)', 'Quantidade', 'Unidade', 'Valor unitário c/ BDI', 'Total c/ BDI', 'Responsável', 'Equipe', 'Dependências', 'Composições bloqueadoras', 'Justificativa do bloqueio'],
    ...rows.map(row => {
      const statusOnly = isStatusOnlyScheduleRow(row);
      return [
        row.item || '', row.code || '', row.phaseName, row.description, classificationLabel(row), row.statusLabel,
        statusOnly ? '' : excelDate(row.startDate), statusOnly ? '' : excelDate(endDate(row.startDate, row.duration)), statusOnly ? '' : row.duration,
        row.quantity, row.unit || '', row.unitPriceWithBDI, row.totalWithBDI,
        statusOnly ? '' : row.responsible || '', statusOnly ? '' : row.team || '', statusOnly ? '' : row.dependencies.join(', '),
        blockingLabel(row), row.blockingNote || row.suspensionReason || '',
      ];
    }),
  ];
  const wsActivities = XLSX.utils.aoa_to_sheet(activities);
  wsActivities['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 17 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 17 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 17 } },
  ];
  wsActivities['!cols'] = [8, 12, 24, 48, 22, 48, 12, 12, 11, 12, 10, 18, 18, 22, 14, 24, 58, 36].map(wch => ({ wch }));
  styleSheet(XLSX, wsActivities, 4);
  wsActivities.A1.s = { font: { bold: true, color: { rgb: '991B1B' }, sz: 14 }, fill: { fgColor: { rgb: 'FEE2E2' } }, alignment: { horizontal: 'center' } };
  wsActivities.A2.s = { font: { color: { rgb: '7C2D12' } }, fill: { fgColor: { rgb: 'FFF7ED' } }, alignment: { wrapText: true } };
  wsActivities.A3.s = { font: { italic: true, color: { rgb: '475569' } }, fill: { fgColor: { rgb: 'F8FAFC' } } };
  wsActivities['!rows'] = [{ hpt: 24 }, { hpt: 34 }, { hpt: 20 }, { hpt: 8 }, { hpt: 30 }, ...rows.map(() => ({ hpt: 30 }))];
  for (let index = 5; index < activities.length; index += 1) {
    for (let col = 0; col < 18; col += 1) {
      const cell = wsActivities[XLSX.utils.encode_cell({ r: index, c: col })];
      if (cell) cell.s = bodyStyle(index % 2 ? 'FFFFFF' : 'F8FAFC', { centered: col >= 6 && col <= 10, wrap: [2, 3, 4, 5, 13, 15, 16, 17].includes(col) });
    }
    const totalCell = wsActivities[XLSX.utils.encode_cell({ r: index, c: 12 })];
    const unitCell = wsActivities[XLSX.utils.encode_cell({ r: index, c: 11 })];
    const startCell = wsActivities[XLSX.utils.encode_cell({ r: index, c: 6 })];
    const endCell = wsActivities[XLSX.utils.encode_cell({ r: index, c: 7 })];
    if (totalCell) totalCell.z = 'R$ #,##0.00;[Red]-R$ #,##0.00';
    if (unitCell) unitCell.z = 'R$ #,##0.00';
    if (startCell) startCell.z = 'dd/mm/yyyy';
    if (endCell) endCell.z = 'dd/mm/yyyy';
  }
  XLSX.utils.book_append_sheet(wb, wsActivities, 'Atividades');

  const ganttSourceRows = rows.filter(row => !(row.compositionId && row.description.startsWith('Impacto do aditivo - ')));
  const validRows = ganttSourceRows.filter(row => !isStatusOnlyScheduleRow(row) && /^\d{4}-\d{2}-\d{2}$/.test(row.startDate));
  const min = validRows.reduce((value, row) => !value || row.startDate < value ? row.startDate : value, '');
  const max = validRows.reduce((value, row) => {
    const end = endDate(row.startDate, row.duration);
    return !value || end > value ? end : value;
  }, '');
  const weekStarts: string[] = [];
  if (min && max) {
    const minimumTimelineEnd = new Date(`${min}T12:00:00`);
    minimumTimelineEnd.setDate(minimumTimelineEnd.getDate() + 27);
    const displayMax = minimumTimelineEnd.toISOString().slice(0, 10) > max
      ? minimumTimelineEnd.toISOString().slice(0, 10)
      : max;
    const cursor = new Date(`${min}T12:00:00`);
    while (cursor.toISOString().slice(0, 10) <= displayMax) {
      weekStarts.push(cursor.toISOString().slice(0, 10));
      cursor.setDate(cursor.getDate() + 7);
    }
  }
  const ganttRows = [
    ['Descrição', 'Situação', 'Início', 'Fim', ...weekStarts.map(dateBR)],
    ...ganttSourceRows.map(row => {
      const statusOnly = isStatusOnlyScheduleRow(row);
      const finish = endDate(row.startDate, row.duration);
      return [row.description, row.statusLabel, statusOnly ? '' : dateBR(row.startDate), statusOnly ? '' : dateBR(finish), ...weekStarts.map((week, weekIndex) => {
        if (statusOnly) return weekIndex === 0 ? row.statusLabel : '';
        const weekEnd = new Date(`${week}T12:00:00`); weekEnd.setDate(weekEnd.getDate() + 6);
        return week <= finish && weekEnd.toISOString().slice(0, 10) >= row.startDate ? '■' : '';
      })];
    }),
  ];
  const wsGantt = XLSX.utils.aoa_to_sheet(ganttRows);
  wsGantt['!merges'] = ganttSourceRows.flatMap((row, rowIndex) => (
    isStatusOnlyScheduleRow(row) && weekStarts.length > 1
      ? [{ s: { r: rowIndex + 1, c: 4 }, e: { r: rowIndex + 1, c: 3 + weekStarts.length } }]
      : []
  ));
  wsGantt['!cols'] = [{ wch: 52 }, { wch: 52 }, { wch: 12 }, { wch: 12 }, ...weekStarts.map(() => ({ wch: 11 }))];
  styleSheet(XLSX, wsGantt, 0);
  ganttSourceRows.forEach((row, rowIndex) => {
    for (let col = 0; col < 4 + weekStarts.length; col += 1) {
      const cell = wsGantt[XLSX.utils.encode_cell({ r: rowIndex + 1, c: col })];
      if (cell) cell.s = bodyStyle(rowIndex % 2 ? 'F8FAFC' : 'FFFFFF', { centered: col >= 1, wrap: col <= 1 });
    }
    if (isStatusOnlyScheduleRow(row) && weekStarts.length) {
      const statusCell = wsGantt[XLSX.utils.encode_cell({ r: rowIndex + 1, c: 4 })];
      if (statusCell) statusCell.s = {
        font: { bold: true, color: { rgb: row.scheduleState === 'fully_suppressed' ? '9F1239' : '92400E' } },
        fill: { fgColor: { rgb: row.scheduleState === 'fully_suppressed' ? 'FFF1F2' : 'FFFBEB' } },
        alignment: { horizontal: 'left', vertical: 'center' },
      };
    }
    for (let col = 4; col < 4 + weekStarts.length && !isStatusOnlyScheduleRow(row); col += 1) {
      const cell = wsGantt[XLSX.utils.encode_cell({ r: rowIndex + 1, c: col })];
      if (cell?.v) {
        const [r, g, b] = classificationColor(row);
        cell.s = { font: { color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: [r, g, b].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase() } }, alignment: { horizontal: 'center' } };
      }
    }
  });
  wsGantt['!rows'] = [{ hpt: 28 }, ...ganttSourceRows.map(() => ({ hpt: 26 }))];
  XLSX.utils.book_append_sheet(wb, wsGantt, 'Gantt');

  const forecast = buildAdditiveScheduleForecast(rows, trabalhaSabado);
  const forecastRows = [
    ['Mês', 'Contratados liberados', 'Proposta não contratada'],
    ...forecast.months.map(month => [month.label, month.contractedReleased, month.proposed]),
    ...(forecast.totalOnlyProposed !== 0 ? [['Impactos sem distribuição mensal', '', forecast.totalOnlyProposed]] : []),
    ['TOTAL', forecast.totalContractedReleased, forecast.totalProposed],
  ];
  const wsForecast = XLSX.utils.aoa_to_sheet(forecastRows);
  wsForecast['!cols'] = [{ wch: 34 }, { wch: 24 }, { wch: 28 }];
  styleSheet(XLSX, wsForecast, 0);
  for (let row = 1; row < forecastRows.length; row += 1) {
    for (let col = 1; col <= 2; col += 1) {
      const cell = wsForecast[XLSX.utils.encode_cell({ r: row, c: col })];
      if (cell) {
        cell.s = bodyStyle(row === forecastRows.length - 1 ? 'E2E8F0' : (row % 2 ? 'FFFFFF' : 'F8FAFC'), { centered: false, bold: row === forecastRows.length - 1 });
        cell.z = 'R$ #,##0.00;[Red]-R$ #,##0.00';
      }
    }
    const label = wsForecast[XLSX.utils.encode_cell({ r: row, c: 0 })];
    if (label) label.s = bodyStyle(row === forecastRows.length - 1 ? 'E2E8F0' : (row % 2 ? 'FFFFFF' : 'F8FAFC'), { bold: row === forecastRows.length - 1 });
  }
  const totalRow = forecastRows.length;
  [forecast.totalContractedReleased, forecast.totalProposed].forEach((value, index) => {
    const cell = wsForecast[XLSX.utils.encode_cell({ r: totalRow - 1, c: index + 1 })];
    cell.f = `SUM(${XLSX.utils.encode_col(index + 1)}2:${XLSX.utils.encode_col(index + 1)}${totalRow - 1})`;
    cell.v = value;
  });
  wsForecast['!rows'] = [{ hpt: 28 }, ...forecastRows.slice(1).map(() => ({ hpt: 24 }))];
  const forecastNoteRow = forecastRows.length + 1;
  XLSX.utils.sheet_add_aoa(wsForecast, [[
    'Nota: o valor mensal representa somente a execução contratada liberada. Os impactos da proposta são deltas contratuais e não devem ser somados diretamente a essa coluna.',
  ]], { origin: `A${forecastNoteRow}` });
  wsForecast['!merges'] = [{ s: { r: forecastNoteRow - 1, c: 0 }, e: { r: forecastNoteRow - 1, c: 2 } }];
  wsForecast[`A${forecastNoteRow}`].s = { font: { italic: true, color: { rgb: '475569' } }, fill: { fgColor: { rgb: 'F8FAFC' } }, alignment: { wrapText: true, vertical: 'center' } };
  wsForecast['!rows'][forecastNoteRow - 1] = { hpt: 34 };
  XLSX.utils.book_append_sheet(wb, wsForecast, 'Previsão Financeira');
  wb.Props = { Title: `Cronograma do Aditivo - ${additive.name}`, Subject: ADDITIVE_SCHEDULE_WARNING, Company: project.contractInfo?.contracted || project.name };
  return { XLSX, workbook: wb };
}

export async function exportAdditiveScheduleExcel(project: Project, additive: Additive, rows: AdditiveScheduleSnapshotRow[], trabalhaSabado = false) {
  const { XLSX, workbook } = await buildAdditiveScheduleWorkbook(project, additive, rows, trabalhaSabado);
  XLSX.writeFile(workbook, `cronograma_aditivo_${safeFile(additive.name)}.xlsx`);
}

async function loadPdf() {
  const jspdf = await import('jspdf');
  return {
    jsPDF: (jspdf as any).default || (jspdf as any).jsPDF || jspdf,
  };
}

function drawHeader(doc: any, project: Project, additive: Additive, subtitle: string) {
  const width = doc.internal.pageSize.getWidth();
  doc.setFillColor(254, 226, 226);
  doc.rect(0, 0, width, 18, 'F');
  doc.setTextColor(153, 27, 27);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(ADDITIVE_SCHEDULE_WARNING, width / 2, 7, { align: 'center' });
  doc.setFontSize(8);
  doc.text(subtitle, width / 2, 13, { align: 'center' });
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(8);
  doc.text(`Obra: ${project.name}`, 8, 23);
  doc.text(`Contrato: ${project.contractInfo?.contractNumber || '-'}`, width / 2, 23);
  doc.text(`Aditivo: ${additive.name}`, 8, 28);
  doc.text(ADDITIVE_SCHEDULE_REFERENCE, width / 2, 28);
  doc.setFont('helvetica', 'normal');
  const guidance = doc.splitTextToSize(ADDITIVE_SCHEDULE_GUIDANCE, width - 16);
  doc.text(guidance, 8, 34);
  return 34 + guidance.length * 3.4 + 2;
}

function drawGanttPages(
  doc: any,
  rows: AdditiveScheduleSnapshotRow[],
  project: Project,
  additive: Additive,
  trabalhaSabado = false,
) {
  const chunks: AdditiveScheduleSnapshotRow[][] = [];
  for (let index = 0; index < rows.length; index += 14) chunks.push(rows.slice(index, index + 14));
  if (!chunks.length) chunks.push([]);
  const scheduledRows = rows.filter(row => !isStatusOnlyScheduleRow(row));
  const allStart = scheduledRows.map(row => row.startDate).filter(Boolean).sort()[0] || project.startDate;
  const allEnd = scheduledRows.map(row => endDate(row.startDate, row.duration)).filter(Boolean).sort().at(-1) || project.endDate || project.startDate;
  const firstDate = new Date(`${allStart}T12:00:00`);
  const lastDate = new Date(`${allEnd}T12:00:00`);
  const start = new Date(firstDate.getFullYear(), firstDate.getMonth(), 1, 12);
  const end = new Date(lastDate.getFullYear(), lastDate.getMonth() + 1, 0, 12);
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
  const forecast = buildAdditiveScheduleForecast(rows, trabalhaSabado);
  const forecastByMonth = new Map(forecast.months.map(month => [month.key, month]));
  const months: Array<{ key: string; label: string; offset: number; days: number }> = [];
  let monthCursor = new Date(start);
  while (monthCursor <= end) {
    const monthEnd = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0, 12);
    const visibleEnd = monthEnd < end ? monthEnd : end;
    months.push({
      key: `${monthCursor.getFullYear()}-${String(monthCursor.getMonth() + 1).padStart(2, '0')}`,
      label: monthCursor.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', ''),
      offset: Math.round((monthCursor.getTime() - start.getTime()) / 86400000),
      days: Math.round((visibleEnd.getTime() - monthCursor.getTime()) / 86400000) + 1,
    });
    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1, 12);
  }
  chunks.forEach((chunk, chunkIndex) => {
    if (chunkIndex > 0) doc.addPage();
    const y = drawHeader(doc, project, additive, `DIAGRAMA DE GANTT - PARTE ${chunkIndex + 1}/${chunks.length}`);
    const pageWidth = doc.internal.pageSize.getWidth();
    const labelWidth = 92;
    const chartX = 8 + labelWidth;
    const chartWidth = pageWidth - chartX - 8;
    const rowHeight = 10;
    const headerHeight = 16;
    doc.setFontSize(7);
    doc.setFillColor(226, 232, 240);
    doc.rect(8, y, pageWidth - 16, headerHeight, 'F');
    doc.setFont('helvetica', 'bold');
    doc.text('ATIVIDADE / SITUAÇÃO', 10, y + 7.2);
    months.forEach(month => {
      const x = chartX + (month.offset / days) * chartWidth;
      const width = (month.days / days) * chartWidth;
      doc.setDrawColor(203, 213, 225);
      doc.line(x, y, x, y + headerHeight + rowHeight * chunk.length);
      doc.setTextColor(15, 23, 42);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(5.7);
      doc.text(month.label, x + width / 2, y + 3.5, { align: 'center' });
      const monthForecast = forecastByMonth.get(month.key);
      if (monthForecast) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(4.4);
        doc.setTextColor(4, 120, 87);
        doc.text(brl(monthForecast.contractedReleased), x + width / 2, y + 8.3, { align: 'center', maxWidth: Math.max(5, width - 1) });
        doc.setTextColor(190, 18, 60);
        doc.text(brl(monthForecast.proposed), x + width / 2, y + 12.7, { align: 'center', maxWidth: Math.max(5, width - 1) });
      }
    });
    doc.setDrawColor(203, 213, 225);
    doc.line(chartX + chartWidth, y, chartX + chartWidth, y + headerHeight + rowHeight * chunk.length);
    chunk.forEach((row, index) => {
      const rowY = y + headerHeight + rowHeight * index;
      if (index % 2) { doc.setFillColor(248, 250, 252); doc.rect(8, rowY, pageWidth - 16, rowHeight, 'F'); }
      doc.setDrawColor(226, 232, 240); doc.line(8, rowY + rowHeight, pageWidth - 8, rowY + rowHeight);
      doc.setTextColor(15, 23, 42); doc.setFont('helvetica', 'normal');
      doc.text(doc.splitTextToSize(row.description, labelWidth - 5)[0], 10, rowY + 2.8);
      if (row.quantityRestriction && !isStatusOnlyScheduleRow(row)) {
        const statusLines = doc.splitTextToSize(row.statusLabel, labelWidth - 5).slice(0, 2);
        doc.setFont('helvetica', 'bold'); doc.setTextColor(7, 89, 133); doc.setFontSize(4.8);
        doc.text(statusLines, 10, rowY + 5.2);
      } else {
        doc.setFontSize(5.7); doc.text(classificationLabel(row), 10, rowY + 6.5);
      }
      doc.setFontSize(7);
      if (isStatusOnlyScheduleRow(row)) {
        doc.setFont('helvetica', 'bold');
        if (row.scheduleState === 'fully_suppressed') doc.setTextColor(159, 18, 57);
        else doc.setTextColor(146, 64, 14);
        doc.text(row.statusLabel, chartX + 2, rowY + 6.1);
        return;
      }
      const rowStart = new Date(`${row.startDate}T12:00:00`);
      const rowEnd = new Date(`${endDate(row.startDate, row.duration)}T12:00:00`);
      const left = Math.max(0, (rowStart.getTime() - start.getTime()) / 86400000) / days * chartWidth;
      const barDays = Math.max(1, (rowEnd.getTime() - rowStart.getTime()) / 86400000 + 1);
      const barWidth = Math.max(2, barDays / days * chartWidth);
      const [r, g, b] = classificationColor(row);
      doc.setFillColor(r, g, b); doc.roundedRect(chartX + left, rowY + 2.6, barWidth, 4.6, 1, 1, 'F');
    });
  });
}

export type AdditivePdfGanttRow =
  | { kind: 'phase'; phaseId: string; phaseNumber: string; phaseName: string; depth: number; taskCount: number; startDate: string; endDate: string; ancestorPhaseIds: string[]; continuation?: boolean }
  | { kind: 'taskHeader'; phaseId: string; ancestorPhaseIds: string[] }
  | { kind: 'task'; phaseId: string; ancestorPhaseIds: string[]; item: string; row: AdditiveScheduleSnapshotRow };

const isValidISODate = (value: string | undefined) => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);

function getPhaseAncestors(phase: Phase, phaseById: Map<string, Phase>): string[] {
  const ancestors: string[] = [];
  const visited = new Set<string>([phase.id]);
  let current = phase;
  while (current.parentId && !visited.has(current.parentId)) {
    const parent = phaseById.get(current.parentId);
    if (!parent) break;
    ancestors.unshift(parent.id);
    visited.add(parent.id);
    current = parent;
  }
  return ancestors;
}

/** Builds the same expanded hierarchy shown by GanttChart, independently of UI collapse state. */
export function buildAdditivePdfGanttRows(
  scheduleProject: Project,
  sourceRows: AdditiveScheduleSnapshotRow[],
): AdditivePdfGanttRow[] {
  const rows = sourceRows.filter(row => !(row.compositionId && row.description.startsWith('Impacto do aditivo - ')));
  const phases = flattenPhasesByChapter(scheduleProject);
  const phaseById = new Map(scheduleProject.phases.map(phase => [phase.id, phase]));
  const numbering = getChapterNumbering(scheduleProject);
  const rowByTaskId = new Map(rows.map(row => [row.taskId, row]));
  const taskById = new Map(scheduleProject.phases.flatMap(phase => phase.tasks).map(task => [task.id, task]));
  const directRowsByPhase = new Map<string, AdditiveScheduleSnapshotRow[]>();

  phases.forEach(phase => {
    const ordered: AdditiveScheduleSnapshotRow[] = [];
    const seen = new Set<string>();
    sortTasksForSchedule(phase.tasks).forEach(task => {
      const row = rowByTaskId.get(task.id);
      if (row && row.phaseId === phase.id && !seen.has(row.taskId)) {
        ordered.push(row);
        seen.add(row.taskId);
      }
    });
    rows
      .filter(row => row.phaseId === phase.id && !seen.has(row.taskId))
      .sort((left, right) => (left.scheduleOrder ?? Number.MAX_SAFE_INTEGER) - (right.scheduleOrder ?? Number.MAX_SAFE_INTEGER))
      .forEach(row => { ordered.push(row); seen.add(row.taskId); });
    directRowsByPhase.set(phase.id, ordered);
  });

  const collectRows = (phaseId: string, visited = new Set<string>()): AdditiveScheduleSnapshotRow[] => {
    if (visited.has(phaseId)) return [];
    visited.add(phaseId);
    return [
      ...(directRowsByPhase.get(phaseId) ?? []),
      ...scheduleProject.phases
        .filter(phase => phase.parentId === phaseId)
        .flatMap(phase => collectRows(phase.id, visited)),
    ];
  };

  const result: AdditivePdfGanttRow[] = [];
  phases.forEach(phase => {
    const ancestors = getPhaseAncestors(phase, phaseById);
    const directRows = directRowsByPhase.get(phase.id) ?? [];
    const scheduled = collectRows(phase.id).filter(row => isValidISODate(row.startDate) && !isStatusOnlyScheduleRow(row));
    const starts = scheduled.map(row => row.startDate).sort();
    const ends = scheduled.map(row => endDate(row.startDate, row.duration)).sort();
    const phaseNumber = numbering.get(phase.id) ?? '';
    result.push({
      kind: 'phase',
      phaseId: phase.id,
      phaseNumber,
      phaseName: phase.name,
      depth: ancestors.length,
      taskCount: directRows.length,
      startDate: starts[0] ?? '',
      endDate: ends.at(-1) ?? '',
      ancestorPhaseIds: ancestors,
    });
    if (!directRows.length) return;
    const taskAncestors = [...ancestors, phase.id];
    result.push({ kind: 'taskHeader', phaseId: phase.id, ancestorPhaseIds: taskAncestors });
    directRows.forEach((row, index) => {
      const task = taskById.get(row.taskId);
      const item = row.item?.trim() || task?.contractItem?.trim() || `${phaseNumber}.${index + 1}`;
      result.push({ kind: 'task', phaseId: phase.id, ancestorPhaseIds: taskAncestors, item, row });
    });
  });
  return result;
}

const pdfGanttRowHeight = (row: AdditivePdfGanttRow) => row.kind === 'phase' ? 12 : row.kind === 'taskHeader' ? 6 : 10;

function paginatePdfGanttRows(rows: AdditivePdfGanttRow[], maxHeight: number): AdditivePdfGanttRow[][] {
  const phaseRows = new Map(rows
    .filter((row): row is Extract<AdditivePdfGanttRow, { kind: 'phase' }> => row.kind === 'phase')
    .map(row => [row.phaseId, row]));
  const pages: AdditivePdfGanttRow[][] = [];
  let page: AdditivePdfGanttRow[] = [];
  let used = 0;
  const finishPage = () => { pages.push(page); page = []; used = 0; };

  rows.forEach((row, index) => {
    const height = pdfGanttRowHeight(row);
    const mustKeepNext = row.kind === 'phase' || row.kind === 'taskHeader';
    const nextHeight = mustKeepNext && rows[index + 1] ? pdfGanttRowHeight(rows[index + 1]) : 0;
    if (page.length && used + height + nextHeight > maxHeight) {
      finishPage();
      row.ancestorPhaseIds.forEach(id => {
        const context = phaseRows.get(id);
        if (!context || used + pdfGanttRowHeight(context) > maxHeight) return;
        page.push({ ...context, continuation: true });
        used += pdfGanttRowHeight(context);
      });
      if (row.kind === 'task') {
        const header: AdditivePdfGanttRow = { kind: 'taskHeader', phaseId: row.phaseId, ancestorPhaseIds: row.ancestorPhaseIds };
        page.push(header);
        used += pdfGanttRowHeight(header);
      }
    }
    page.push(row);
    used += height;
  });
  if (page.length || !pages.length) pages.push(page);
  return pages;
}

function drawHierarchicalGanttPages(
  doc: any,
  rows: AdditiveScheduleSnapshotRow[],
  project: Project,
  scheduleProject: Project,
  additive: Additive,
  trabalhaSabado = false,
) {
  const renderRows = buildAdditivePdfGanttRows(scheduleProject, rows);
  const scheduledRows = rows.filter(row => isValidISODate(row.startDate) && !isStatusOnlyScheduleRow(row));
  const earliestTask = scheduledRows.map(row => row.startDate).sort()[0] || scheduleProject.startDate;
  const workStartDate = getWorkStartDate(scheduleProject, earliestTask);
  const allStart = [earliestTask, workStartDate].filter(isValidISODate).sort()[0] || scheduleProject.startDate;
  const latestTask = scheduledRows.map(row => endDate(row.startDate, row.duration)).sort().at(-1) || scheduleProject.endDate || scheduleProject.startDate;
  const allEnd = [latestTask, workStartDate].filter(isValidISODate).sort().at(-1) || latestTask;
  const firstDate = new Date(`${allStart}T12:00:00`);
  const lastDate = new Date(`${allEnd}T12:00:00`);
  const timelineStart = new Date(firstDate.getFullYear(), firstDate.getMonth(), 1, 12);
  const timelineEnd = new Date(lastDate.getFullYear(), lastDate.getMonth() + 1, 0, 12);
  const totalDays = Math.max(1, Math.round((timelineEnd.getTime() - timelineStart.getTime()) / 86400000) + 1);
  const forecast = buildAdditiveScheduleForecast(rows, trabalhaSabado);
  const forecastByMonth = new Map(forecast.months.map(month => [month.key, month]));
  const months: Array<{ key: string; label: string; offset: number; days: number }> = [];
  let monthCursor = new Date(timelineStart);
  while (monthCursor <= timelineEnd) {
    const monthEnd = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0, 12);
    const visibleEnd = monthEnd < timelineEnd ? monthEnd : timelineEnd;
    months.push({
      key: `${monthCursor.getFullYear()}-${String(monthCursor.getMonth() + 1).padStart(2, '0')}`,
      label: monthCursor.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', ''),
      offset: Math.round((monthCursor.getTime() - timelineStart.getTime()) / 86400000),
      days: Math.round((visibleEnd.getTime() - monthCursor.getTime()) / 86400000) + 1,
    });
    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1, 12);
  }

  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 8;
  const sidebarColumns = [14, 46, 16, 16, 9, 10, 8, 11];
  const sidebarWidth = sidebarColumns.reduce((sum, value) => sum + value, 0);
  const chartX = margin + sidebarWidth;
  const chartWidth = pageWidth - chartX - margin;
  const headerHeight = 17;
  const pages = paginatePdfGanttRows(renderRows, 142);
  const itemByTaskId = new Map(renderRows
    .filter((row): row is Extract<AdditivePdfGanttRow, { kind: 'task' }> => row.kind === 'task')
    .map(row => [row.row.taskId, row.item]));
  const xForDate = (iso: string) => {
    const value = new Date(`${iso}T12:00:00`);
    const offset = (value.getTime() - timelineStart.getTime()) / 86400000;
    return chartX + Math.max(0, Math.min(totalDays, offset)) / totalDays * chartWidth;
  };
  const clippedLine = (text: string, width: number) => doc.splitTextToSize(text || '-', Math.max(2, width))[0] || '';

  pages.forEach((pageRows, pageIndex) => {
    if (pageIndex > 0) doc.addPage();
    const y = drawHeader(doc, project, additive, `DIAGRAMA DE GANTT - PARTE ${pageIndex + 1}/${pages.length}`);
    const bodyHeight = pageRows.reduce((sum, row) => sum + pdfGanttRowHeight(row), 0);
    const bodyBottom = y + headerHeight + bodyHeight;
    doc.setFillColor(226, 232, 240);
    doc.rect(margin, y, pageWidth - margin * 2, headerHeight, 'F');
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.2);

    const headers = ['ITEM', 'TAREFA', 'INÍCIO', 'FIM', 'DUR.', 'DEP.', 'TIPO', 'EQUIPE'];
    let headerX = margin;
    headers.forEach((label, index) => {
      const width = sidebarColumns[index];
      doc.line(headerX, y, headerX, bodyBottom);
      doc.setTextColor(51, 65, 85); doc.setFont('helvetica', 'bold'); doc.setFontSize(index === 1 ? 5.5 : 5.1);
      doc.text(label, headerX + width / 2, y + 9, { align: 'center' });
      headerX += width;
    });
    doc.line(chartX, y, chartX, bodyBottom);
    months.forEach(month => {
      const x = chartX + month.offset / totalDays * chartWidth;
      const width = month.days / totalDays * chartWidth;
      doc.line(x, y, x, bodyBottom);
      doc.setTextColor(15, 23, 42); doc.setFont('helvetica', 'bold'); doc.setFontSize(5.4);
      doc.text(month.label, x + width / 2, y + 3.6, { align: 'center' });
      const monthForecast = forecastByMonth.get(month.key);
      if (monthForecast) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(4.2); doc.setTextColor(4, 120, 87);
        doc.text(clippedLine(brl(monthForecast.contractedReleased), width - 1), x + width / 2, y + 8.5, { align: 'center' });
        doc.setTextColor(190, 18, 60);
        doc.text(clippedLine(brl(monthForecast.proposed), width - 1), x + width / 2, y + 13, { align: 'center' });
      }
    });
    doc.line(chartX + chartWidth, y, chartX + chartWidth, bodyBottom);
    doc.line(margin, y, pageWidth - margin, y);
    doc.line(margin, y + headerHeight, pageWidth - margin, y + headerHeight);

    let rowY = y + headerHeight;
    pageRows.forEach((renderRow, rowIndex) => {
      const height = pdfGanttRowHeight(renderRow);
      if (renderRow.kind === 'phase') {
        if (renderRow.depth === 0) doc.setFillColor(226, 232, 240);
        else doc.setFillColor(241, 245, 249);
        doc.rect(margin, rowY, pageWidth - margin * 2, height, 'F');
        doc.setTextColor(15, 23, 42); doc.setFont('helvetica', 'bold'); doc.setFontSize(renderRow.depth === 0 ? 7.5 : 6.8);
        const suffix = renderRow.continuation ? ' (CONTINUAÇÃO)' : '';
        doc.text(clippedLine(`${renderRow.phaseNumber}  ${renderRow.phaseName}${suffix}`, sidebarWidth - 8 - renderRow.depth * 4), margin + 3 + renderRow.depth * 4, rowY + 4.5);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(4.8); doc.setTextColor(71, 85, 105);
        const range = renderRow.startDate ? `Início: ${dateBR(renderRow.startDate)}   Fim: ${dateBR(renderRow.endDate)}` : 'Início: -   Fim: -';
        doc.text(range, margin + 3 + renderRow.depth * 4, rowY + 9.2);
        doc.text(`${renderRow.taskCount} tarefa(s)`, chartX - 2, rowY + 4.5, { align: 'right' });
        if (renderRow.startDate && renderRow.endDate) {
          const startX = xForDate(renderRow.startDate);
          const endX = xForDate(renderRow.endDate);
          const centerY = rowY + height / 2;
          doc.setDrawColor(55, 65, 81); doc.setFillColor(55, 65, 81); doc.setLineWidth(0.45);
          doc.line(startX, centerY, endX, centerY);
          [startX, endX].forEach(markerX => {
            doc.triangle(markerX, centerY - 1.7, markerX + 1.7, centerY, markerX, centerY + 1.7, 'F');
            doc.triangle(markerX, centerY - 1.7, markerX - 1.7, centerY, markerX, centerY + 1.7, 'F');
          });
          doc.setFont('helvetica', 'bold'); doc.setFontSize(4.8); doc.setTextColor(30, 41, 59);
          doc.text(clippedLine(renderRow.phaseName, Math.max(12, chartX + chartWidth - startX - 3)), Math.min(startX + 3, chartX + chartWidth - 3), centerY + 4.1);
        }
      } else if (renderRow.kind === 'taskHeader') {
        doc.setFillColor(248, 250, 252); doc.rect(margin, rowY, pageWidth - margin * 2, height, 'F');
        doc.setTextColor(100, 116, 139); doc.setFont('helvetica', 'bold'); doc.setFontSize(4.4);
        doc.text('TAREFAS DO CAPÍTULO', margin + 3, rowY + 4.1);
        doc.text('PLANEJAMENTO MENSAL', chartX + 2, rowY + 4.1);
      } else {
        const row = renderRow.row;
        if (rowIndex % 2) { doc.setFillColor(248, 250, 252); doc.rect(margin, rowY, pageWidth - margin * 2, height, 'F'); }
        const dependencyIds = row.dependencyDetails?.length ? row.dependencyDetails.map(dep => dep.taskId) : row.dependencies;
        const dependencyItems = dependencyIds.map(id => itemByTaskId.get(id)).filter(Boolean).join(', ');
        const dependencyTypes = row.dependencyDetails?.map(dep => dep.type).filter(Boolean).join(', ') || '';
        const finish = isValidISODate(row.startDate) ? endDate(row.startDate, row.duration) : '';
        const statusOnly = isStatusOnlyScheduleRow(row);
        const values = [
          renderRow.item, row.description, statusOnly ? '-' : dateBR(row.startDate), statusOnly ? '-' : dateBR(finish),
          statusOnly ? '-' : `${row.duration}d`, dependencyItems || '-', dependencyTypes || '-', row.team || '-',
        ];
        let cellX = margin;
        values.forEach((value, index) => {
          const width = sidebarColumns[index];
          doc.setTextColor(15, 23, 42); doc.setFont('helvetica', index === 1 ? 'normal' : 'bold'); doc.setFontSize(index === 1 ? 5.2 : 4.7);
          if (index === 1) {
            doc.text(clippedLine(value, width - 2), cellX + 1, rowY + 3.4);
            const secondary = row.quantityRestriction ? row.statusLabel : classificationLabel(row);
            doc.setFont('helvetica', 'bold'); doc.setFontSize(3.9);
            if (row.quantityRestriction) doc.setTextColor(7, 89, 133); else doc.setTextColor(100, 116, 139);
            doc.text(clippedLine(secondary, width - 2), cellX + 1, rowY + 7.5);
          } else {
            doc.text(clippedLine(value, width - 1.5), cellX + width / 2, rowY + 5.8, { align: 'center' });
          }
          cellX += width;
        });
        const presentationOnly = statusOnly || row.classification === 'proposed_addition';
        if (presentationOnly) {
          doc.setFont('helvetica', 'bold'); doc.setFontSize(5.2);
          if (row.scheduleState === 'fully_suppressed') doc.setTextColor(159, 18, 57);
          else if (row.classification === 'proposed_addition') doc.setTextColor(190, 18, 60);
          else doc.setTextColor(146, 64, 14);
          doc.text(clippedLine(row.statusLabel, chartWidth - 4), chartX + 2, rowY + 6.1);
        } else if (isValidISODate(row.startDate)) {
          const rowStart = new Date(`${row.startDate}T12:00:00`);
          const rowEnd = new Date(`${finish}T12:00:00`);
          const left = Math.max(0, (rowStart.getTime() - timelineStart.getTime()) / 86400000) / totalDays * chartWidth;
          const barDays = Math.max(1, (rowEnd.getTime() - rowStart.getTime()) / 86400000 + 1);
          const barWidth = Math.max(1.8, barDays / totalDays * chartWidth);
          const [red, green, blue] = classificationColor(row);
          doc.setFillColor(red, green, blue);
          doc.roundedRect(chartX + left, rowY + 2.7, Math.min(barWidth, chartWidth - left), 4.6, 1, 1, 'F');
        }
      }
      doc.setDrawColor(226, 232, 240); doc.setLineWidth(0.18);
      doc.line(margin, rowY + height, pageWidth - margin, rowY + height);
      rowY += height;
    });

    if (isValidISODate(workStartDate)) {
      const markerX = xForDate(workStartDate);
      doc.setDrawColor(5, 150, 105); doc.setLineWidth(0.5);
      doc.line(markerX, y + headerHeight, markerX, bodyBottom);
      doc.setFillColor(5, 150, 105);
      doc.triangle(markerX, y + headerHeight, markerX + 2.5, y + headerHeight + 1.5, markerX, y + headerHeight + 3, 'F');
      const markerLabel = `INÍCIO DA OBRA ${dateBR(workStartDate)}`;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(4.2);
      const labelWidth = Math.min(38, doc.getTextWidth(markerLabel) + 3);
      const labelX = markerX + labelWidth + 1 > chartX + chartWidth ? markerX - labelWidth - 1 : markerX + 1;
      doc.roundedRect(labelX, y + headerHeight + 0.7, labelWidth, 4.2, 0.7, 0.7, 'F');
      doc.setTextColor(255, 255, 255);
      doc.text(markerLabel, labelX + labelWidth / 2, y + headerHeight + 3.5, { align: 'center' });
    }
  });
}

export async function buildAdditiveSchedulePdfDocument(
  project: Project,
  additive: Additive,
  rows: AdditiveScheduleSnapshotRow[],
  trabalhaSabado = false,
  scheduleProject: Project = project,
) {
  rows = normalizeLegacyRows(rows, additive);
  const { jsPDF } = await loadPdf();
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  doc.setProperties({ title: `Cronograma do Aditivo - ${additive.name}`, subject: ADDITIVE_SCHEDULE_WARNING, author: project.contractInfo?.contracted || project.name });
  drawHierarchicalGanttPages(
    doc,
    rows.filter(row => !row.description.startsWith('Impacto do aditivo - ')),
    project,
    scheduleProject,
    additive,
    trabalhaSabado,
  );
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page); doc.setFontSize(6.5); doc.setTextColor(100);
    doc.text(`Página ${page}/${pages}`, doc.internal.pageSize.getWidth() - 8, doc.internal.pageSize.getHeight() - 4, { align: 'right' });
  }
  return doc;
}

export async function exportAdditiveSchedulePdf(project: Project, additive: Additive, rows: AdditiveScheduleSnapshotRow[], trabalhaSabado = false, scheduleProject: Project = project) {
  const doc = await buildAdditiveSchedulePdfDocument(project, additive, rows, trabalhaSabado, scheduleProject);
  doc.save(`cronograma_aditivo_${safeFile(additive.name)}.pdf`);
}
