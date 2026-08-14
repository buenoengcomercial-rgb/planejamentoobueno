/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Additive, AdditiveScheduleSnapshotRow, Project } from '@/types/project';
import { buildAdditiveScheduleForecast } from '@/lib/additiveScheduleForecast';
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
    ['Item', 'Código', 'Capítulo', 'Descrição', 'Classificação', 'Situação', 'Início', 'Fim', 'Duração (d)', 'Quantidade', 'Unidade', 'Valor unitário c/ BDI', 'Total c/ BDI', 'Responsável', 'Equipe', 'Dependências'],
    ...rows.map(row => {
      const statusOnly = isStatusOnlyScheduleRow(row);
      return [
        row.item || '', row.code || '', row.phaseName, row.description, classificationLabel(row), row.statusLabel,
        statusOnly ? '' : excelDate(row.startDate), statusOnly ? '' : excelDate(endDate(row.startDate, row.duration)), statusOnly ? '' : row.duration,
        row.quantity, row.unit || '', row.unitPriceWithBDI, row.totalWithBDI,
        statusOnly ? '' : row.responsible || '', statusOnly ? '' : row.team || '', statusOnly ? '' : row.dependencies.join(', '),
      ];
    }),
  ];
  const wsActivities = XLSX.utils.aoa_to_sheet(activities);
  wsActivities['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 15 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 15 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 15 } },
  ];
  wsActivities['!cols'] = [8, 12, 24, 48, 22, 44, 12, 12, 11, 12, 10, 18, 18, 22, 14, 24].map(wch => ({ wch }));
  styleSheet(XLSX, wsActivities, 4);
  wsActivities.A1.s = { font: { bold: true, color: { rgb: '991B1B' }, sz: 14 }, fill: { fgColor: { rgb: 'FEE2E2' } }, alignment: { horizontal: 'center' } };
  wsActivities.A2.s = { font: { color: { rgb: '7C2D12' } }, fill: { fgColor: { rgb: 'FFF7ED' } }, alignment: { wrapText: true } };
  wsActivities.A3.s = { font: { italic: true, color: { rgb: '475569' } }, fill: { fgColor: { rgb: 'F8FAFC' } } };
  wsActivities['!rows'] = [{ hpt: 24 }, { hpt: 34 }, { hpt: 20 }, { hpt: 8 }, { hpt: 30 }, ...rows.map(() => ({ hpt: 30 }))];
  for (let index = 5; index < activities.length; index += 1) {
    for (let col = 0; col < 16; col += 1) {
      const cell = wsActivities[XLSX.utils.encode_cell({ r: index, c: col })];
      if (cell) cell.s = bodyStyle(index % 2 ? 'FFFFFF' : 'F8FAFC', { centered: col >= 6 && col <= 10, wrap: [2, 3, 4, 5, 13, 15].includes(col) });
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
  wsGantt['!cols'] = [{ wch: 52 }, { wch: 24 }, { wch: 12 }, { wch: 12 }, ...weekStarts.map(() => ({ wch: 11 }))];
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
  XLSX.utils.book_append_sheet(wb, wsForecast, 'Previsão Financeira');
  wb.Props = { Title: `Cronograma do Aditivo - ${additive.name}`, Subject: ADDITIVE_SCHEDULE_WARNING, Company: project.contractInfo?.contracted || project.name };
  return { XLSX, workbook: wb };
}

export async function exportAdditiveScheduleExcel(project: Project, additive: Additive, rows: AdditiveScheduleSnapshotRow[]) {
  const { XLSX, workbook } = await buildAdditiveScheduleWorkbook(project, additive, rows);
  XLSX.writeFile(workbook, `cronograma_aditivo_${safeFile(additive.name)}.xlsx`);
}

async function loadPdf() {
  const [jspdf, autotable] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  return {
    jsPDF: (jspdf as any).default || (jspdf as any).jsPDF || jspdf,
    autoTable: (autotable as any).default || (autotable as any).autoTable || autotable,
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

function drawGanttPages(doc: any, rows: AdditiveScheduleSnapshotRow[], project: Project, additive: Additive) {
  const chunks: AdditiveScheduleSnapshotRow[][] = [];
  for (let index = 0; index < rows.length; index += 20) chunks.push(rows.slice(index, index + 20));
  const scheduledRows = rows.filter(row => !isStatusOnlyScheduleRow(row));
  const allStart = scheduledRows.map(row => row.startDate).filter(Boolean).sort()[0] || project.startDate;
  const allEnd = scheduledRows.map(row => endDate(row.startDate, row.duration)).filter(Boolean).sort().at(-1) || project.endDate || project.startDate;
  const start = new Date(`${allStart}T12:00:00`);
  const end = new Date(`${allEnd}T12:00:00`);
  const days = Math.max(14, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
  chunks.forEach((chunk, chunkIndex) => {
    doc.addPage();
    const y = drawHeader(doc, project, additive, `DIAGRAMA DE GANTT - PARTE ${chunkIndex + 1}/${chunks.length}`);
    const pageWidth = doc.internal.pageSize.getWidth();
    const labelWidth = 92;
    const chartX = 8 + labelWidth;
    const chartWidth = pageWidth - chartX - 8;
    const rowHeight = 7;
    doc.setFontSize(7);
    doc.setFillColor(226, 232, 240);
    doc.rect(8, y, pageWidth - 16, rowHeight, 'F');
    doc.setFont('helvetica', 'bold');
    doc.text('ATIVIDADE / SITUAÇÃO', 10, y + 4.7);
    for (let tick = 0; tick <= 6; tick += 1) {
      const date = new Date(start); date.setDate(date.getDate() + Math.round((days - 1) * tick / 6));
      const x = chartX + chartWidth * tick / 6;
      doc.setDrawColor(203, 213, 225);
      doc.line(x, y, x, y + rowHeight * (chunk.length + 1));
      const tickLabel = dateBR(date.toISOString().slice(0, 10));
      if (tick === 6) doc.text(tickLabel, x - 1, y + 4.7, { align: 'right' });
      else doc.text(tickLabel, x + 1, y + 4.7);
    }
    chunk.forEach((row, index) => {
      const rowY = y + rowHeight * (index + 1);
      if (index % 2) { doc.setFillColor(248, 250, 252); doc.rect(8, rowY, pageWidth - 16, rowHeight, 'F'); }
      doc.setDrawColor(226, 232, 240); doc.line(8, rowY + rowHeight, pageWidth - 8, rowY + rowHeight);
      doc.setTextColor(15, 23, 42); doc.setFont('helvetica', 'normal');
      doc.text(doc.splitTextToSize(row.description, labelWidth - 5)[0], 10, rowY + 3.2);
      doc.setFontSize(5.7); doc.text(classificationLabel(row), 10, rowY + 5.8); doc.setFontSize(7);
      if (isStatusOnlyScheduleRow(row)) {
        doc.setFont('helvetica', 'bold');
        if (row.scheduleState === 'fully_suppressed') doc.setTextColor(159, 18, 57);
        else doc.setTextColor(146, 64, 14);
        doc.text(row.statusLabel, chartX + 2, rowY + 4.6);
        return;
      }
      const rowStart = new Date(`${row.startDate}T12:00:00`);
      const rowEnd = new Date(`${endDate(row.startDate, row.duration)}T12:00:00`);
      const left = Math.max(0, (rowStart.getTime() - start.getTime()) / 86400000) / days * chartWidth;
      const barDays = Math.max(1, (rowEnd.getTime() - rowStart.getTime()) / 86400000 + 1);
      const barWidth = Math.max(2, barDays / days * chartWidth);
      const [r, g, b] = classificationColor(row);
      doc.setFillColor(r, g, b); doc.roundedRect(chartX + left, rowY + 1.4, barWidth, 4.2, 1, 1, 'F');
    });
  });
}

export async function buildAdditiveSchedulePdfDocument(
  project: Project,
  additive: Additive,
  rows: AdditiveScheduleSnapshotRow[],
  trabalhaSabado = false,
) {
  rows = normalizeLegacyRows(rows, additive);
  const { jsPDF, autoTable } = await loadPdf();
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  doc.setProperties({ title: `Cronograma do Aditivo - ${additive.name}`, subject: ADDITIVE_SCHEDULE_WARNING, author: project.contractInfo?.contracted || project.name });
  let y = drawHeader(doc, project, additive, 'QUADRO DE ATIVIDADES');
  autoTable(doc, {
    startY: y,
    head: [['Item', 'Atividade', 'Classificação', 'Situação', 'Início', 'Fim', 'Dur.', 'Responsável', 'Equipe', 'Dep.', 'Total c/ BDI']],
    body: rows.map(row => {
      const statusOnly = isStatusOnlyScheduleRow(row);
      return [
        row.item || '', row.description, classificationLabel(row), row.statusLabel,
        statusOnly ? '' : dateBR(row.startDate), statusOnly ? '' : dateBR(endDate(row.startDate, row.duration)), statusOnly ? '' : `${row.duration} d`,
        statusOnly ? '' : row.responsible || '', statusOnly ? '' : row.team || '', statusOnly ? '' : row.dependencies.join(', '), brl(row.totalWithBDI),
      ];
    }),
    styles: { font: 'helvetica', fontSize: 6.6, cellPadding: 1.3, overflow: 'linebreak', valign: 'middle' },
    tableWidth: 224,
    headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 10 }, 1: { cellWidth: 38 }, 2: { cellWidth: 22 }, 3: { cellWidth: 44 },
      4: { cellWidth: 15 }, 5: { cellWidth: 15 }, 6: { cellWidth: 9 }, 7: { cellWidth: 18 },
      8: { cellWidth: 12 }, 9: { cellWidth: 16 }, 10: { cellWidth: 25, halign: 'right' },
    },
    margin: { left: 8, right: 8, top: 46, bottom: 10 },
    didDrawPage: (data: any) => { if (data.pageNumber > 1) drawHeader(doc, project, additive, 'QUADRO DE ATIVIDADES'); },
  });
  drawGanttPages(doc, rows.filter(row => !row.description.startsWith('Impacto do aditivo - ')), project, additive);

  doc.addPage();
  y = drawHeader(doc, project, additive, 'PREVISÃO FÍSICO-FINANCEIRA');
  const forecast = buildAdditiveScheduleForecast(rows, trabalhaSabado);
  autoTable(doc, {
    startY: y,
    head: [['Mês', 'Contratados liberados', 'Proposta não contratada']],
    body: [
      ...forecast.months.map(month => [month.label, brl(month.contractedReleased), brl(month.proposed)]),
      ...(forecast.totalOnlyProposed !== 0 ? [['Impactos sem distribuição mensal', '-', brl(forecast.totalOnlyProposed)]] : []),
      ['TOTAL', brl(forecast.totalContractedReleased), brl(forecast.totalProposed)],
    ],
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 2, halign: 'right', overflow: 'linebreak' },
    tableWidth: 190,
    headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: 'bold' },
    columnStyles: {
      0: { halign: 'left', cellWidth: 30 },
      1: { textColor: [4, 120, 87], cellWidth: 80 },
      2: { textColor: [190, 18, 60], cellWidth: 80 },
    },
    margin: { left: 20, right: 20 },
  });
  if (forecast.totalOnlyProposed !== 0) {
    const noteY = ((doc as any).lastAutoTable?.finalY ?? y) + 6;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.5);
    doc.setTextColor(100);
    doc.text(
      `Nota: o total da proposta inclui ${brl(forecast.totalOnlyProposed)} sem distribuição mensal. Serviços contratados suspensos não compõem os valores da retomada.`,
      20,
      noteY,
    );
  }
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page); doc.setFontSize(6.5); doc.setTextColor(100);
    doc.text(`Página ${page}/${pages}`, doc.internal.pageSize.getWidth() - 8, doc.internal.pageSize.getHeight() - 4, { align: 'right' });
  }
  return doc;
}

export async function exportAdditiveSchedulePdf(project: Project, additive: Additive, rows: AdditiveScheduleSnapshotRow[]) {
  const doc = await buildAdditiveSchedulePdfDocument(project, additive, rows);
  doc.save(`cronograma_aditivo_${safeFile(additive.name)}.pdf`);
}
