import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { Project, WarehouseRequisition, CustodyTerm, WarehouseInventorySession } from '@/types/project';
import { custodyTermAggregateStatus, custodyTermEquipmentItems } from '@/lib/warehouse';

function header(doc: jsPDF, project: Project, title: string, subtitle: string) {
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(title, 14, 18);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(project.name, 14, 25);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(subtitle, 14, 30);
  doc.setTextColor(0);
  doc.setDrawColor(200);
  doc.line(14, 33, 196, 33);
}

function signatures(doc: jsPDF, y: number, leftLabel: string, leftSig: string | undefined, rightLabel: string, rightSig: string | undefined) {
  const w = 80, h = 30;
  doc.setDrawColor(160);
  if (leftSig) try { doc.addImage(leftSig, 'PNG', 18, y, w, h); } catch { /* ignore */ }
  if (rightSig) try { doc.addImage(rightSig, 'PNG', 110, y, w, h); } catch { /* ignore */ }
  doc.line(18, y + h + 1, 18 + w, y + h + 1);
  doc.line(110, y + h + 1, 110 + w, y + h + 1);
  doc.setFontSize(9);
  doc.text(leftLabel, 18, y + h + 6);
  doc.text(rightLabel, 110, y + h + 6);
}

export function generateRequisitionReceipt(project: Project, req: WarehouseRequisition) {
  const doc = new jsPDF();
  header(doc, project, 'RECIBO DE RETIRADA DE MATERIAL', `${req.number} · ${req.date}`);
  doc.setFontSize(10);
  let y = 40;
  doc.text(`Recebedor: ${req.receiverName ?? req.requesterName ?? '—'}`, 14, y); y += 5;
  doc.text(`Prédio / capítulo: ${req.chapterName ?? req.taskName ?? '—'}`, 14, y); y += 5;
  doc.text(`Equipe: ${req.teamName ?? req.teamId ?? '—'}`, 14, y); y += 5;
  doc.text(`Almoxarife: ${req.warehouseOperator ?? '—'}`, 14, y); y += 5;
  if (req.deliveryAttachments?.length) { doc.text(`Fotos da entrega: ${req.deliveryAttachments.length}`, 14, y); y += 5; }
  if (req.notes) { doc.text(`Observação: ${req.notes}`, 14, y); y += 5; }

  autoTable(doc, {
    startY: y + 2,
    head: [['Código', 'Descrição', 'Un', 'Qtd']],
    body: req.items.map(it => [it.code ?? '—', it.description, it.unit, String(it.quantity)]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: [60, 60, 60] },
  });
  const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y + 30;
  signatures(doc, finalY + 15, 'Operador identificado pelo login', undefined, 'Recebedor', req.signatureReceiver);

  doc.save(`recibo-${req.number}.pdf`);
}

export function generateInventoryReportPdf(project: Project, session: WarehouseInventorySession) {
  const doc = new jsPDF();
  header(doc, project, 'RELATÓRIO MENSAL DE INVENTÁRIO', `${session.number} · ${session.month}`);
  autoTable(doc, {
    startY: 40,
    head: [['Código', 'Material', 'Un', 'Esperado', 'Contado', 'Diferença', 'Valor']],
    body: session.lines.map(line => {
      const impact = line.difference != null && line.unitCostSnapshot != null
        ? line.difference * line.unitCostSnapshot
        : undefined;
      return [
        line.itemCode ?? '—',
        line.itemDescription,
        line.itemUnit,
        line.expectedQuantity ?? '—',
        line.countedQuantity ?? '—',
        line.difference ?? '—',
        impact == null ? 'Cálculo incompleto' : impact.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      ];
    }),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [60, 60, 60] },
  });
  doc.save(`${session.number}.pdf`);
}

export function generateCustodyTermPdf(project: Project, term: CustodyTerm) {
  const doc = new jsPDF();
  header(doc, project, 'TERMO DE CAUTELA DE EQUIPAMENTO', `${term.number} · ${term.issuedAt}`);
  doc.setFontSize(10);
  let y = 40;
  const items = custodyTermEquipmentItems(term);
  const aggregateStatus = custodyTermAggregateStatus(items);
  const lines = [
    `Recebedor: ${term.workerName}`,
    `Prédio / capítulo: ${term.chapterName ?? 'Registro legado'}`,
    `Equipe: ${term.teamName ?? term.teamId ?? '—'}`,
    `Devolver até: ${term.dueDate ?? '—'}`,
    `Status: ${aggregateStatus}`,
  ];
  for (const l of lines) { doc.text(l, 14, y); y += 5; }
  if (term.attachments?.length) { doc.text(`Fotos da entrega: ${term.attachments.length}`, 14, y); y += 5; }

  autoTable(doc, {
    startY: y + 3,
    head: [['Código / patrimônio', 'Equipamento', 'Identificação', 'Entrega', 'Situação / devolução']],
    body: items.map(item => [
      `${item.equipmentInternalCode ?? '—'}\nPatr.: ${item.equipmentPatrimony ?? '—'}`,
      item.equipmentName,
      `${[item.equipmentBrand, item.equipmentModel].filter(Boolean).join(' ') || '—'}\nSérie: ${item.equipmentSerial ?? '—'}`,
      `${item.stateOnDelivery ?? '—'}\nAcessórios: ${item.accessories ?? '—'}`,
      `${item.status}${item.returnedAt ? `\n${item.returnedAt} · ${item.stateOnReturn ?? '—'}` : ''}${item.divergenceNotes ? `\n${item.divergenceNotes}` : ''}`,
    ]),
    styles: { fontSize: 7.5, cellPadding: 2 },
    headStyles: { fillColor: [60, 60, 60] },
    columnStyles: { 0: { cellWidth: 31 }, 1: { cellWidth: 43 }, 2: { cellWidth: 40 }, 3: { cellWidth: 37 }, 4: { cellWidth: 31 } },
  });
  let finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y + 35;
  if (finalY > 225) { doc.addPage(); finalY = 20; }
  doc.setFontSize(9);
  doc.text('Declaro ter recebido os equipamentos descritos acima nas condições registradas, comprometendo-me a devolvê-los e comunicar imediatamente qualquer ocorrência.', 14, finalY + 8, { maxWidth: 182 });
  signatures(doc, finalY + 24, 'Almoxarife', term.signatureWarehouse, 'Recebedor', term.signatureReceiver);

  doc.save(`termo-${term.number}.pdf`);
}
