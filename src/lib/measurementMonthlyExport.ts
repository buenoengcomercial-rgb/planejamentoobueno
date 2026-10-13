import { measurementBulletin, measurementStatusLabels, monthlyLines, monthlyTotal, type MeasurementWorkspace } from './measurementWorkspace';
import { fmtDateBR } from '@/components/measurement/measurementFormat';
import type { MonthlyPdfOptions } from './measurementMonthlyPdf';

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
export async function exportMonthlyMeasurement(w: MeasurementWorkspace, id: string, format: 'xlsx' | 'pdf', options: MonthlyPdfOptions = {}) {
  const p = w.periods.find(p => p.id === id)!;
  if (format === 'xlsx') {
    const XLSX = await import('xlsx');
    const book = XLSX.utils.book_new(); const sheet = XLSX.utils.aoa_to_sheet(monthlyExportRows(w, id));
    sheet['!cols'] = [{ wch: 10 }, { wch: 75 }, { wch: 7 }, ...Array.from({ length: 9 }, () => ({ wch: 18 }))];
    for (const key of Object.keys(sheet)) if (sheet[key]?.t === 'n') sheet[key].z = '#,##0.00';
    XLSX.utils.book_append_sheet(book, sheet, 'Medição mensal'); XLSX.writeFile(book, `medicao-${p.number}.xlsx`); return;
  }
  const { buildMonthlyMeasurementPdf } = await import('./measurementMonthlyPdf');
  const doc = await buildMonthlyMeasurementPdf(w, id, options);
  doc.save(`medicao-${p.number}.pdf`);
}
