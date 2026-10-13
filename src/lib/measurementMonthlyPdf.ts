import type { jsPDF } from 'jspdf';
import type { CellInput, RowInput } from 'jspdf-autotable';
import { measurementBulletin, measurementStatusLabels, monthlyLines, type MeasurementWorkspace } from './measurementWorkspace';
import { measurementPresentation } from '@/components/measurement/measurementWorkspacePresentation';
import type { GroupNode, GroupTotals, Row } from '@/components/measurement/types';
import { fmtBRL, fmtDateBR, fmtNum, fmtPct } from '@/components/measurement/measurementFormat';

export interface MonthlyPdfOptions { forecastTotal?: number | null }
type Color = [number, number, number];
const ink: Color = [15, 23, 42], muted: Color = [100, 116, 139], border: Color = [226, 232, 240];
const blue: Color = [59, 130, 246], white: Color = [255, 255, 255];
const heads: Color[] = [[241, 245, 249], [224, 242, 254], [209, 250, 229], [254, 243, 199], [255, 228, 230]];
const fills: Color[] = [[248, 250, 252], [243, 249, 253], [240, 252, 245], [255, 252, 239], [255, 245, 247]];
// Same fifteen columns, ordering and proportions as measurement-table--ledger.
export const monthlyPdfColumns = ['Item', 'Código', 'Banco', 'Descrição', 'Und.', 'Quant. Contrat.', 'V. Unit. s/ BDI', 'V. Unit. c/ BDI', 'Total Contratado', 'Quant. Medição', 'Subtotal Medição', 'Quant. Acum.', 'Subtotal Acumulado', 'Quant. a Executar', 'Subtotal a Executar'];
const proportions = [4.2, 4.8, 5, 17.6, 4, 4.2, 7.4, 7.4, 8.2, 4.2, 8.2, 4.2, 8.2, 4.2, 8.2];
const money = (n: number) => fmtBRL(n).replace(/\s/g, ' ');
const groupForColumn = (index: number) => index < 5 ? 0 : index < 9 ? 1 : index < 11 ? 2 : index < 13 ? 3 : 4;
const totalCells = (t: GroupTotals, label: string, fill: Color, text: Color = ink): RowInput => [
  { content: label, colSpan: 8, styles: { halign: label === 'TOTAL GERAL' ? 'center' : 'left', fillColor: fill, textColor: text, fontStyle: 'bold' } },
  ...[money(t.contracted), '-', money(t.period), '-', money(t.accum), '-', money(t.balance)].map(content => ({ content, styles: { fillColor: fill, textColor: text, fontStyle: 'bold' } } as CellInput)),
];

/** Shares the screen's grouping and financial inputs, without changing the ledger. */
export function monthlyPdfPresentation(w: MeasurementWorkspace, id: string) {
  const presentation = measurementPresentation(monthlyLines(w, id));
  const body: RowInput[] = [];
  const item = (r: Row) => {
    const excess = r.qtyCurrentAccum - r.qtyContracted > 1e-9;
    const cells = [r.item, r.itemCode || '-', r.priceBank || '-', r.description + (excess ? `\nUltrapassou o limite contratado: ${fmtNum(r.qtyCurrentAccum - r.qtyContracted)} ${r.unit}` : ''), r.unit,
      fmtNum(r.qtyContracted), money(r.unitPriceNoBDI), money(r.unitPriceWithBDI), money(r.valueContracted), fmtNum(r.qtyPeriod), money(r.valuePeriod), fmtNum(r.qtyCurrentAccum), money(r.valueAccum), fmtNum(r.qtyBalance), money(r.valueBalance)];
    body.push(cells.map((content, index) => ({ content, styles: { fillColor: excess ? heads[3] : index < 4 && r.hasNoLogsInPeriod ? [255, 248, 236] : fills[groupForColumn(index)], halign: index === 3 ? 'left' : 'center', fontStyle: index === 10 ? 'bold' : 'normal' } } as CellInput)));
  };
  const walk = (g: GroupNode) => {
    body.push(totalCells(g.totals, `${'  '.repeat(g.depth)}${g.number}  ${g.name.toUpperCase()}`, g.depth === 0 ? [235, 242, 254] : g.depth === 1 ? [242, 246, 250] : fills[0]));
    g.rows.forEach(item);
    g.children.forEach(walk);
  };
  presentation.groupTree.forEach(walk);
  return { ...presentation, body };
}

export async function buildMonthlyMeasurementPdf(w: MeasurementWorkspace, id: string, options: MonthlyPdfOptions = {}): Promise<jsPDF> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const p = w.periods.find(period => period.id === id);
  if (!p) throw new Error('Medição não encontrada.');
  const b = measurementBulletin(w, id), c = b.contract;
  const { body, totals: t, rows } = monthlyPdfPresentation(w, id);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const margin = 8, width = doc.internal.pageSize.getWidth() - margin * 2;
  const height = doc.internal.pageSize.getHeight();
  const period = `${fmtDateBR(p.startDate)} a ${fmtDateBR(p.endDate)}`;
  let y = margin;
  const heading = (continued = false) => {
    doc.setFillColor(...fills[0]); doc.setDrawColor(...border); doc.rect(margin, y, width, 12, 'FD');
    doc.setTextColor(...ink); doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.text('BOLETIM DE MEDIÇÃO PARA PAGAMENTO', margin + 3, y + 4.6);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5);
    doc.text(`${b.projectName} | Período ${period}${continued ? ' | Continuação' : ''}`, margin + 3, y + 9);
    doc.setTextColor(...muted); doc.text('MEDIÇÃO Nº', margin + width - 3, y + 4, { align: 'right' });
    doc.setTextColor(...ink); doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(String(p.number), margin + width - 3, y + 9, { align: 'right' });
    y += 12;
  };
  heading();
  type Field = [string, string, number];
  const fieldRows: Field[][] = [
    [['CONTRATANTE', c.contractor ?? '', 6], ['CONTRATADA', c.contracted ?? '', 6]],
    [['OBRA', b.projectName, 8], ['LOCAL / MUNICÍPIO', c.location ?? '', 4]],
    [['OBJETO', c.contractObject ?? '', 8], ['Nº DO CONTRATO', c.contractNumber ?? '', 3]],
    [['Nº DA ART', c.artNumber ?? '', 3], ['PERÍODO DA MEDIÇÃO', period, 4], ['DATA DE EMISSÃO', fmtDateBR(b.issueDate), 2]],
    [['FONTE DE ORÇAMENTO', c.budgetSource ?? '', 4], ['BDI %', fmtNum(c.bdiPercent ?? 0), 2], ['MEDIÇÃO Nº', String(p.number), 3]],
  ];
  for (const fields of fieldRows) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
    const texts = fields.map(([, value, span]) => doc.splitTextToSize(value || '-', width * span / 12 - 5) as string[]);
    const rowHeight = Math.max(11, ...texts.map(lines => 7 + lines.length * 3));
    let x = margin;
    fields.forEach(([label, , span], i) => {
      const cellWidth = width * span / 12;
      doc.setDrawColor(...border); doc.setFillColor(...white); doc.rect(x, y, cellWidth, rowHeight, 'FD');
      doc.setTextColor(...muted); doc.setFont('helvetica', 'bold'); doc.setFontSize(6); doc.text(label, x + 2, y + 3.4);
      doc.setTextColor(...ink); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(texts[i], x + 2, y + 7.3);
      x += cellWidth;
    });
    y += rowHeight;
  }
  y += 3;
  doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(...muted);
  doc.text(`Situação: ${measurementStatusLabels[p.status]}  |  Acumulado inclui a medição selecionada.`, margin, y);
  y += 3;
  doc.setFillColor(...fills[0]); doc.setDrawColor(...border); doc.rect(margin, y, width, 7, 'FD');
  doc.setFont('helvetica', 'bold'); doc.setTextColor(...ink); doc.setFontSize(8); doc.text(`Planilha de medição (${rows.length} itens)`, margin + 2, y + 4.7); y += 7;
  const head: RowInput[] = [
    [['IDENTIFICAÇÃO', 5], ['CONTRATO', 4], ['MEDIÇÃO ATUAL', 2], ['ACUMULADO', 2], ['SALDO', 2]].map(([content, colSpan], i) => ({ content, colSpan, styles: { fillColor: heads[i], textColor: ink, halign: 'center' } } as CellInput)),
    monthlyPdfColumns.map(content => ({ content, styles: { fillColor: heads[0], textColor: ink } })),
  ];
  autoTable(doc, { startY: y, margin: { left: margin, right: margin, top: 23, bottom: 10 }, tableWidth: width, theme: 'grid', head, body,
    foot: [totalCells(t, 'TOTAL GERAL', ink, white)], showFoot: 'lastPage', rowPageBreak: 'avoid',
    styles: { font: 'helvetica', fontSize: 5.5, cellPadding: { top: 1.4, bottom: 1.4, left: 0.7, right: 0.7 }, textColor: ink, lineColor: border, lineWidth: 0.15, valign: 'middle', halign: 'center', overflow: 'linebreak' },
    headStyles: { fontStyle: 'bold', fontSize: 5.5 }, footStyles: { fontSize: 5.5, cellPadding: 2 },
    columnStyles: Object.fromEntries(proportions.map((percent, i) => [i, { cellWidth: width * percent / 100 }])),
    willDrawPage: data => { if (data.pageNumber > 1) { y = margin; heading(true); } },
    didParseCell: data => {
      // Values must never split the currency symbol from the amount.
      if (data.section === 'body' && data.cell.colSpan === 1 && typeof data.cell.raw !== 'string' && typeof data.cell.raw !== 'number') {
        const raw = data.cell.raw as { content?: unknown };
        const content = String(raw.content ?? '');
        if (content.includes('R$')) { data.cell.styles.overflow = 'visible'; data.cell.styles.fontSize = Math.min(5.5, (width * proportions[data.column.index] / 100 - 1.4) * doc.internal.scaleFactor / doc.getStringUnitWidth(content)); }
      }
    },
  });
  y = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 4;
  if (y + 83 > height - 10) { doc.addPage(); y = margin; heading(true); y += 4; }
  const pct = (value: number) => t.contracted > 0 ? value / t.contracted * 100 : 0;
  const bdi = w.contract?.bdiPercent ?? p.originalSnapshot?.bdiPercent ?? (t.contractedNoBDI > 0 ? (t.contracted / t.contractedNoBDI - 1) * 100 : 0);
  const cardWidth = (width - 6) / 3;
  const block = (x: number, title: string, entries: [string, string][], highlight = false) => {
    doc.setDrawColor(...(highlight ? [177, 205, 254] as Color : border)); doc.setFillColor(...(highlight ? [240, 246, 255] as Color : white)); doc.roundedRect(x, y, cardWidth, 48, 1.5, 1.5, 'FD');
    doc.setTextColor(...ink); doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.text(title, x + 2, y + 4.7);
    doc.line(x, y + 7, x + cardWidth, y + 7);
    entries.forEach(([label, value], i) => {
      const rowY = y + 11 + i * 5;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.3); doc.setTextColor(...muted); doc.text(label, x + 2, rowY);
      doc.setFont('helvetica', 'bold'); doc.setTextColor(...(highlight ? blue : ink)); doc.text(value, x + cardWidth - 2, rowY, { align: 'right' });
      if (i < entries.length - 1) doc.line(x, rowY + 1.6, x + cardWidth, rowY + 1.6);
    });
  };
  block(margin, 'SEM BDI', [['Custo total da obra', money(t.contractedNoBDI)], ['Valor desta medição', money(t.periodNoBDI)], ['Valor acumulado', money(t.accumNoBDI)], ['Valor a executar', money(t.balanceNoBDI)]]);
  block(margin + cardWidth + 3, `BDI (${fmtPct(bdi)})`, [['BDI total', money(t.contracted - t.contractedNoBDI)], ['BDI desta medição', money(t.period - t.periodNoBDI)], ['BDI acumulado', money(t.accum - t.accumNoBDI)], ['BDI a executar', money(t.balance - t.balanceNoBDI)]]);
  block(margin + 2 * (cardWidth + 3), 'COM BDI', [['Custo total da obra', money(t.contracted)], ['Valor desta medição', money(t.period)], ['Valor acumulado', money(t.accum)], ['Valor a executar', money(t.balance)], ['% desta medição', fmtPct(pct(t.period))], ['% acumulado', fmtPct(pct(t.accum))], ['% a executar', fmtPct(pct(t.balance))]], true);
  y += 51;
  const smallCard = (x: number, cardW: number, label: string, value: string, color: Color = ink, highlight = false) => {
    const info = highlight && color[0] === 14 && color[1] === 165;
    doc.setDrawColor(...(info ? [163, 220, 245] as Color : highlight ? [177, 205, 254] as Color : border));
    doc.setFillColor(...(info ? [240, 250, 254] as Color : highlight ? [240, 246, 255] as Color : white)); doc.roundedRect(x, y, cardW, 12, 1.3, 1.3, 'FD');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(5.8); doc.setTextColor(...muted); doc.text(label, x + 2, y + 4);
    doc.setFontSize(7.5); doc.setTextColor(...color); doc.text(value, x + 2, y + 9);
  };
  const miniWidth = (width - 15) / 6;
  [['CONTRATADO C/ BDI', money(t.contracted)], ['DESTA MEDIÇÃO', money(t.period)], ['ACUMULADO', money(t.accum)], ['SALDO A EXECUTAR', money(t.balance)], ['% DESTA MEDIÇÃO', fmtPct(pct(t.period))], ['% ACUMULADO', fmtPct(pct(t.accum))]].forEach(([label, value], i) => smallCard(margin + i * (miniWidth + 3), miniWidth, label, value, i === 1 ? blue : ink, i === 1));
  y += 15;
  const forecast = options.forecastTotal ?? null, diff = forecast === null ? null : t.period - forecast;
  smallCard(margin, cardWidth, 'PREVISTO NO PERÍODO (GANTT)', forecast === null ? 'Não disponível' : money(forecast), [14, 165, 233], true);
  smallCard(margin + cardWidth + 3, cardWidth, 'REALIZADO NO PERÍODO', money(t.period));
  smallCard(margin + 2 * (cardWidth + 3), cardWidth, 'DIFERENÇA REAL X PREVISTO', diff === null ? 'Não disponível' : money(diff), diff === null || diff === 0 ? ink : diff < 0 ? [239, 68, 68] : [34, 197, 94]);
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) { doc.setPage(page); doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.setTextColor(...muted); doc.text(`${p.number}ª medição | ${period}`, margin, height - 4); doc.text(`Página ${page} de ${pages}`, margin + width, height - 4, { align: 'right' }); }
  return doc;
}
