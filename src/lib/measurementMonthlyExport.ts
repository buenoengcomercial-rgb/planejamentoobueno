import { measurementStatusLabels, monthlyLines, monthlyTotal, type MeasurementWorkspace } from './measurementWorkspace';
import { fmtBRL, fmtDateBR, fmtNum } from '@/components/measurement/measurementFormat';

export function monthlyExportRows(w: MeasurementWorkspace, id: string): (string | number)[][] {
  const p = w.periods.find(p => p.id === id)!;
  const rows: (string | number)[][] = [
    ['BOLETIM DE MEDIÇÃO'], ['Obra', w.projectName], ['Medição', p.number, 'Período', fmtDateBR(p.startDate), fmtDateBR(p.endDate)],
    ['Contrato', w.contract?.contractNumber ?? '', 'Situação', measurementStatusLabels[p.status]],
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
  doc.setFontSize(14); doc.text(w.projectName, 12, 15);
  doc.setFontSize(10); doc.text(`${p.number}ª MEDIÇÃO · ${fmtDateBR(p.startDate)} a ${fmtDateBR(p.endDate)} · ${measurementStatusLabels[p.status]}`, 12, 23);
  doc.setFontSize(8); doc.text('Acumulado inclui a medição selecionada. Preços com BDI.', 12, 29);
  autoTable(doc, { startY: 34, styles: { fontSize: 7, cellPadding: 2 }, head: [['Item', 'Serviço', 'Un.', 'Contratado', 'Medição', 'Preço unit.', 'Valor', 'Acumulado', 'Saldo']],
    body: monthlyLines(w, id).map(l => [l.service.item, `${l.service.path}\n${l.service.description}`, l.service.unit, fmtNum(l.service.contracted), fmtNum(l.qty), fmtBRL(l.financial.unitPriceWithBDI), fmtBRL(l.financial.totalPeriod), fmtNum(l.accumulated), fmtNum(l.balance)]),
    foot: [['', 'TOTAL', '', '', '', '', fmtBRL(monthlyTotal(w, id)), '', '']], columnStyles: { 1: { cellWidth: 88 }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' } },
  });
  doc.save(`medicao-${p.number}.pdf`);
}
