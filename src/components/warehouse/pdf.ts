import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { Project, WarehouseRequisition, CustodyTerm, WarehouseInventorySession } from '@/types/project';

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
  doc.text(`Fotos da entrega: ${req.deliveryAttachments?.length ?? 0}`, 14, y); y += 5;
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
  const lines = [
    `Código interno: ${term.equipmentInternalCode ?? '—'}`,
    `Equipamento: ${term.equipmentName}`,
    `Marca / modelo: ${[term.equipmentBrand, term.equipmentModel].filter(Boolean).join(' ') || '—'}`,
    `Número de série: ${term.equipmentSerial ?? '—'}`,
    `Patrimônio: ${term.equipmentPatrimony ?? '—'}`,
    `Recebedor: ${term.workerName}`,
    `Devolver até: ${term.dueDate ?? '—'}`,
    `Estado na entrega: ${term.stateOnDelivery ?? '—'}`,
    `Acessórios: ${term.accessories ?? '—'}`,
    `Status: ${term.status}`,
  ];
  for (const l of lines) { doc.text(l, 14, y); y += 5; }
  if (term.returnedAt) {
    y += 3;
    doc.setFont('helvetica', 'bold'); doc.text('DEVOLUÇÃO', 14, y); doc.setFont('helvetica', 'normal'); y += 5;
    doc.text(`Devolvido em: ${term.returnedAt}`, 14, y); y += 5;
    doc.text(`Estado na devolução: ${term.stateOnReturn ?? '—'}`, 14, y); y += 5;
    if (term.divergenceNotes) { doc.text(`Divergência: ${term.divergenceNotes}`, 14, y); y += 5; }
  }
  y += 8;
  doc.setFontSize(9);
  doc.text('Declaro ter recebido o equipamento descrito acima em perfeitas condições de uso, comprometendo-me a devolvê-lo nas mesmas condições.', 14, y, { maxWidth: 182 });
  signatures(doc, y + 18, 'Almoxarife', term.signatureWarehouse, 'Recebedor', term.signatureReceiver);

  doc.save(`termo-${term.number}.pdf`);
}
