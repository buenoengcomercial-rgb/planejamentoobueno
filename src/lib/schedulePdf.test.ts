import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@/types/project';
import { buildPhysicalFinancialSchedule } from './physicalFinancialSchedule';
import { buildSchedulePdfData, buildSchedulePdfDocument } from './schedulePdf';

const task: Task = {
  id: 'partial', phase: 'systems', contractItem: '2.1.1', name: 'Montagem do sistema de proteção',
  startDate: '2026-11-13', duration: 1, quantity: 10, unit: 'UN', unitPrice: 100, percentComplete: 50,
  dependencies: ['MARCO-INTERNO'], responsible: '', materials: [], level: 0,
};
const project: Project = {
  id: 'obra', name: 'Palácio Rio Madeira', startDate: '2026-09-01', endDate: '2027-05-14', totalBudget: 1000,
  contractInfo: { contractNumber: '123/2026', location: 'Porto Velho', contractor: 'SUGESP' },
  phases: [
    { id: 'root', name: 'Proteção contra incêndio', customNumber: '2', tasks: [], color: '#fff' },
    { id: 'systems', parentId: 'root', name: 'Hidrantes', tasks: [
      task,
      { ...task, id: 'complete', contractItem: '2.1.2', name: 'Serviço medido', percentComplete: 100 },
      { ...task, id: 'unscheduled', contractItem: '2.1.3', name: 'Conjunto sem programação', percentComplete: 0, startDate: '', duration: 0 },
      { ...task, id: 'MARCO-INTERNO', name: 'Marco de liberação interno', scheduleDisplayKind: 'release' },
      { ...task, id: 'history', name: 'Parcela histórica sintética', scheduleDisplayKind: 'history' },
    ], color: '#fff' },
  ],
};

function inputForPdf() {
  const { rows } = buildPhysicalFinancialSchedule(project, null, []);
  const partial = rows.find(row => row.id === 'partial')!;
  partial.measured = { '2026-09': { quantity: 5, value: 500 } };
  partial.planned = { '2027-01': { quantity: 5, value: 500 } };
  partial.manual = true;
  const complete = rows.find(row => row.id === 'complete')!;
  complete.measured = { '2026-10': { quantity: 10, value: 1000 } };
  return { project, monthlyRows: new Map(rows.map(row => [row.id, row])), measurementValues: { '2026-09': 500, '2026-10': 1000 } };
}

function pageContents(doc: Awaited<ReturnType<typeof buildSchedulePdfDocument>>) {
  // jsPDF stores one array of PDF commands per page after the unused index zero.
  return (doc.internal.pages as unknown as string[][]).slice(1).map(page => page.join('\n'));
}

describe('PDF do cronograma oficial', () => {
  it('consolida a EAP, preserva os meses vazios e não programa serviços integralmente executados', () => {
    const input = inputForPdf();
    const data = buildSchedulePdfData(input);
    expect(data.months).toEqual(['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05']);
    expect(data.groups.map(group => group.title)).toEqual(['2 Proteção contra incêndio / 2.1 Hidrantes']);
    const rows = Object.fromEntries(data.groups[0].rows.map(row => [row.code, row]));
    expect(Object.keys(rows)).toHaveLength(3);
    expect([...rows['2.1.1'].measured]).toEqual([['2026-09', '50,00%']]);
    expect([...rows['2.1.1'].planned]).toEqual([['2027-01', '50,00%']]);
    expect([...rows['2.1.2'].planned]).toEqual([]);
    expect(rows['2.1.3'].note).toBe('Sem mês programado');
    expect(data.measurementValues).toEqual(input.measurementValues);
    expect(project.phases[1].tasks[0].dependencies).toEqual(['MARCO-INTERNO']);
  });

  it('gera A4 paisagem com cabeçalho e identificação das atividades em cada bloco de meses', async () => {
    const input = inputForPdf();
    const partial = input.monthlyRows.get(task.id)!;
    partial.planned = { '2027-05': { quantity: 5, value: 500 } };
    partial.name = `${'Montagem completa do sistema de protecao com fornecimento de materiais e testes. '.repeat(8)} DESCRICAO-FINAL`;
    const doc = await buildSchedulePdfDocument(input);
    expect(doc.internal.pageSize.getWidth()).toBeCloseTo(297);
    expect(doc.internal.pageSize.getHeight()).toBeCloseTo(210);
    expect(doc.getNumberOfPages()).toBe(2);
    const pages = pageContents(doc);
    for (const content of pages) {
      expect(content).toContain('Palácio Rio Madeira');
      expect(content).toContain('Contrato 123/2026');
      expect(content).toContain('2.1.1');
      expect(content).toContain('DESCRICAO-FINAL');
      expect(content).not.toMatch(/Predecessora|MARCO-INTERNO|Marco de liberação interno|Parcela histórica sintética/);
    }
    expect(pages[0]).toContain('500,00');
    expect(pages[1]).toContain('maio/2027');
    expect(pages[1]).not.toContain('Conjunto sem programação');
  });

  it('gera o cabeçalho com o nome da obra quando os dados contratuais não foram cadastrados', async () => {
    const doc = await buildSchedulePdfDocument({ ...inputForPdf(), project: { ...project, contractInfo: undefined } });
    const [firstPage] = pageContents(doc);
    expect(firstPage).toContain('Palácio Rio Madeira');
    expect(firstPage).not.toMatch(/Contratante:|Contratada:|undefined/);
  });

  it('informa quando não há atividades para exportar', async () => {
    const input = inputForPdf();
    await expect(buildSchedulePdfDocument({ ...input, project: { ...project, phases: [], contractInfo: undefined } }))
      .rejects.toThrow('O cronograma está sem atividades para exportar.');
  });
});
