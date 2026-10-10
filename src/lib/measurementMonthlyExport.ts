import { measurementBulletin, measurementStatusLabels, monthlyLines, monthlyTotal, type MeasurementWorkspace } from './measurementWorkspace';
import { fmtBRL, fmtDateBR, fmtNum } from '@/components/measurement/measurementFormat';

export function monthlyBulletinRows(w: MeasurementWorkspace, id: string): (string | number)[][] {
  const p = w.periods.find(p => p.id === id)!;
  const b = measurementBulletin(w, id), c = b.contract;
  return [
    ['Contratante', c.contractor ?? '', 'Contratada', c.contracted ?? ''],
    ['Obra', b.projectName, 'Local / Município', c.location ?? ''],
    ['Objeto', c.contractObject ?? '', 'Nº do contrato', c.contractNumber ?? ''],
    ['Nº da ART', c.artNumber ?? '', 'Medição nº', p.number],
    ['Período da Medição', `${fmtDateBR(p.startDate)} a ${fmtDateBR(p.endDate)}`, 'Data de Emissão', fmtDateBR(b.issueDate)],
    ['Fonte de Orçamento', c.budgetSource ?? '', 'BDI %', c.bdiPercent ?? 0],
    ['Situação', measurementStatusLabels[p.status], '', ''],
  ];
}
export function monthlyExportRows(w: MeasurementWorkspace, id: string): (string | number)[][] {
  const rows: (string | number)[][] = [
    ['BOLETIM DE MEDIÇÃO PARA PAGAMENTO'], ...monthlyBulletinRows(w, id),
    ['Acumulado inclui a medição selecionada'], [],
    ['Item', 'Descrição', 'Un.', 'Qtd. contratada', 'Qtd. medição', 'Preço s/ BDI', 'Preço c/ BDI', 'Valor medição', 'Qtd. acumulada', 'Valor acumulado', 'Saldo qtd.', 'Saldo valor'],
  ];
  let path = '';
  for (const l of monthlyLines(w, id)) {
    if (path !== l.service.path) { path = l.service.path; rows.push(['', path]); }
    rows.push([l.service.item, l.service.description, l.service.unit, l.service.contracted, l.qty, l.financial.unitPriceNoBDI, l.financial.unitPriceWithBDI, l.financial.totalPeriod, l.accumulated, l.financial.totalAccumulated, l.balance, l.financial.totalBalance]);
  }
  rows.push(['', 'TOTAL DA MEDIÇÃO', '', '', '', '', '', monthlyTotal(w, id)]);
  return rows;
}
export async function exportMonthlyMeasurement(w: MeasurementWorkspace, id: string, format: 'xlsx' | 'pdf') {
  const p = w.periods.find(p => p.id === id)!;
  if (format === 'xlsx') {
    const XLSX = await import('xlsx');
    const book = XLSX.utils.book_new(); const sheet = XLSX.utils.aoa_to_sheet(monthlyExportRows(w, id));
    sheet['!cols'] = [{ wch: 10 }, { wch: 75 }, { wch: 7 }, ...Array.from({ length: 9 }, () => ({ wch: 18 }))];
    for (const key of Object.keys(sheet)) if (sheet[key]?.t === 'n') sheet[key].z = '#,##0.00';
    XLSX.utils.book_append_sheet(book, sheet, 'Medição mensal'); XLSX.writeFile(book, `medicao-${p.number}.xlsx`); return;
  }
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  doc.setFontSize(14); doc.text('BOLETIM DE MEDIÇÃO PARA PAGAMENTO', 12, 15);
  let headerEnd = 22;
  autoTable(doc, { startY: headerEnd, margin: { left: 12, right: 12 }, theme: 'grid', body: monthlyBulletinRows(w, id),
    styles: { fontSize: 8, cellPadding: 2 }, columnStyles: { 0: { cellWidth: 32, fontStyle: 'bold' }, 1: { cellWidth: 115 }, 2: { cellWidth: 32, fontStyle: 'bold' } },
    didDrawPage: data => { headerEnd = data.cursor?.y ?? headerEnd; },
  });
  doc.setFontSize(8); doc.text('Acumulado inclui a medição selecionada. Preços com BDI.', 12, headerEnd + 5);
  autoTable(doc, { startY: headerEnd + 9, styles: { fontSize: 7, cellPadding: 2 }, head: [['Item', 'Serviço', 'Un.', 'Contratado', 'Medição', 'Preço unit.', 'Valor', 'Acumulado', 'Saldo']],
    body: monthlyLines(w, id).map(l => [l.service.item, `${l.service.path}\n${l.service.description}`, l.service.unit, fmtNum(l.service.contracted), fmtNum(l.qty), fmtBRL(l.financial.unitPriceWithBDI), fmtBRL(l.financial.totalPeriod), fmtNum(l.accumulated), fmtNum(l.balance)]),
    foot: [['', 'TOTAL', '', '', '', '', fmtBRL(monthlyTotal(w, id)), '', '']], columnStyles: { 1: { cellWidth: 88 }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' } },
  });
  doc.save(`medicao-${p.number}.pdf`);
}
