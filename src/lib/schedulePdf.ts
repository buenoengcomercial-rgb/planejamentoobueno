import type { jsPDF } from 'jspdf';
import type { CellInput } from 'jspdf-autotable';
import type { Project } from '@/types/project';
import { flattenPhasesByChapter, getChapterNumbering } from './chapters';
import { isStatusOnlySuspension, type AdditiveScheduleSuspensionMeta } from './additiveSchedule';
import { executionMonth } from './monthlyExecution';
import { resolveObraConfig } from './obraConfig';
import { monthRange, monthlyPercentage, monthlyPeriodLabel, type buildPhysicalFinancialSchedule } from './physicalFinancialSchedule';
import { operationalEndDate } from './scheduleCalendar';
import { sortTasksForSchedule } from './taskOrdering';
import { flattenTaskTree } from './taskTree';

type MonthlyRow = ReturnType<typeof buildPhysicalFinancialSchedule>['rows'][number];
interface SchedulePdfInput {
  project: Project;
  monthlyRows: ReadonlyMap<string, MonthlyRow>;
  measurementValues?: Readonly<Record<string, number>>;
  suspensionMap?: Readonly<Record<string, AdditiveScheduleSuspensionMeta>>;
  byChapter?: boolean;
}

const money = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthsPerPage = 9;
const margin = 10;
const rowFontSize = 9;
const codeWidth = 17;
const progressWidth = 19;
const minimumMonthWidth = 21;

function shortActivityName(doc: jsPDF, name: string, width: number): string {
  const lines: string[] = doc.splitTextToSize(name.replace(/\s+/g, ' ').trim(), width);
  if (lines.length <= 2) return lines.join('\n');
  let last = lines[1];
  while (last && doc.getTextWidth(`${last}…`) > width) {
    const boundary = last.lastIndexOf(' ');
    last = last.slice(0, boundary > 0 ? boundary : -1);
  }
  return `${lines[0]}\n${last}…`;
}

export function buildSchedulePdfData({ project, monthlyRows, measurementValues = {}, suspensionMap = {} }: SchedulePdfInput) {
  const phases = flattenPhasesByChapter(project);
  const phaseById = new Map(phases.map(phase => [phase.id, phase]));
  const numbers = getChapterNumbering(project);
  const calendar = resolveObraConfig(project);
  const months = new Set<string>();
  const includeMonth = (month: string | undefined) => {
    if (month && executionMonth(`${month}-01`)) months.add(month);
  };
  Object.keys(measurementValues).forEach(includeMonth);

  const groups = phases.flatMap(phase => {
    const rows = sortTasksForSchedule(flattenTaskTree(phase.tasks)).flatMap(task => {
      if (task.scheduleDisplayKind === 'history' || task.scheduleDisplayKind === 'release'
        || suspensionMap[task.id]?.kind === 'proposed') return [];
      const monthly = monthlyRows.get(task.id);
      const measured = new Map<string, string>();
      const planned = new Map<string, string>();
      const addPortions = (target: Map<string, string>, portions: MonthlyRow['measured'] | undefined) => {
        for (const [month, cell] of Object.entries(portions ?? {})) {
          if (cell.quantity === 0 || !executionMonth(`${month}-01`)) continue;
          target.set(month, monthly?.quantity ? monthlyPercentage(cell.quantity / monthly.quantity) : '');
          includeMonth(month);
        }
      };
      const progress = Math.min(100, Math.max(0, task.physicalProgress ?? task.percentComplete));
      const suspended = isStatusOnlySuspension(suspensionMap[task.id]);
      addPortions(measured, monthly?.measured);
      if (!suspended && progress < 100 && (!monthly || monthly.balance > 0)) {
        const segments = task.operationalReschedule?.monthlySegments;
        if (segments?.length) {
          const quantities: MonthlyRow['planned'] = {};
          for (const segment of segments) {
            const month = executionMonth(segment.startDate);
            if (!month) continue;
            (quantities[month] ??= { quantity: 0, value: 0 }).quantity += segment.quantity;
          }
          addPortions(planned, quantities);
        } else if (monthly?.manual) {
          addPortions(planned, monthly.planned);
        } else {
          const start = task.startDate;
          const first = executionMonth(start);
          const last = first && task.duration > 0 ? executionMonth(operationalEndDate(start, task.duration, calendar)) : undefined;
          if (first && last) for (const month of monthRange(first, last)) {
            planned.set(month, '');
            includeMonth(month);
          }
        }
      }
      const note = suspensionMap[task.id]?.scheduleState === 'fully_suppressed' ? 'Item suprimido'
        : suspended ? 'Aguardando aditivo'
        : progress >= 100 && !measured.size ? 'Concluído · mês sem registro na Medição'
        : progress < 100 && !planned.size && (!monthly || monthly.balance > 0) ? 'Sem mês programado' : '';
      return [{ code: monthly?.code || task.contractItem || '', name: monthly?.name || task.name, note, progress, measured, planned }];
    });
    if (!rows.length) return [];
    const trail = [phase];
    const seen = new Set([phase.id]);
    let parent = phase.parentId && phaseById.get(phase.parentId);
    while (parent && !seen.has(parent.id)) {
      trail.unshift(parent);
      seen.add(parent.id);
      parent = parent.parentId && phaseById.get(parent.parentId);
    }
    const title = trail.map(item => `${numbers.get(item.id)} ${item.name}`).join(' / ');
    return [{ title, root: trail[0], rows }];
  });
  return { groups, months: [...months].sort(), measurementValues, numbers };
}

export async function buildSchedulePdfDocument(input: SchedulePdfInput): Promise<jsPDF> {
  const { project, byChapter = false } = input;
  const { groups, months, measurementValues, numbers } = buildSchedulePdfData(input);
  if (!groups.length) throw new Error('O cronograma está sem atividades para exportar.');
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: 'landscape', format: 'a4', compress: true });
  const reportName = byChapter ? 'Cronograma por capítulos' : 'Cronograma da obra';
  doc.setProperties({ title: `${reportName} - ${project.name}` });
  doc.setLineHeightFactor(1.1);

  const width = doc.internal.pageSize.getWidth() - 2 * margin;
  const contract = project.contractInfo;
  const identification = [
    contract?.location,
    contract?.contractNumber && `Contrato ${contract.contractNumber}`,
  ].filter(Boolean).join('  |  ');
  const parties = [
    contract?.contractor && `Contratante: ${contract.contractor}`,
    contract?.contracted && `Contratada: ${contract.contracted}`,
  ].filter(Boolean).join('  |  ');
  doc.setFont('helvetica', 'bold').setFontSize(15);
  const titleLines: string[] = doc.splitTextToSize(project.name, width);
  doc.setFont('helvetica', 'normal').setFontSize(9);
  const metadataLines: string[] = [identification, parties].filter(Boolean).flatMap(line => doc.splitTextToSize(line, width));
  const legendY = 18 + titleLines.length * 6 + metadataLines.length * 4;
  const tableTop = legendY + 6;
  const period = months.length ? [months[0], ...(months.length > 1 ? [months.at(-1)!] : [])].map(monthlyPeriodLabel).join(' a ') : '';
  const blocks = Array.from({ length: Math.max(1, Math.ceil(months.length / monthsPerPage)) },
    (_, index) => months.slice(index * monthsPerPage, (index + 1) * monthsPerPage));
  type Portions = Pick<typeof groups[number]['rows'][number], 'measured' | 'planned'>;
  const chapters = new Map<string, Portions & { title: string }>();
  if (byChapter) for (const group of groups) {
    const chapter = chapters.get(group.root.id) ?? {
      title: `${numbers.get(group.root.id)} ${group.root.name}`,
      measured: new Map<string, string>(),
      planned: new Map<string, string>(),
    };
    for (const row of group.rows) {
      for (const month of row.measured.keys()) chapter.measured.set(month, '');
      for (const month of row.planned.keys()) chapter.planned.set(month, '');
    }
    chapters.set(group.root.id, chapter);
  }

  function drawHeader() {
    doc.setTextColor('#0f172a').setFont('helvetica', 'bold').setFontSize(15);
    doc.text(titleLines, margin, 14);
    doc.setFont('helvetica', 'normal').setFontSize(9);
    const subheading = 13 + titleLines.length * 6;
    doc.text(`${reportName}${period ? ` · ${period}` : ''}`, margin, subheading);
    if (metadataLines.length) doc.text(metadataLines, margin, subheading + 4);
    doc.setFillColor('#bbf7d0').rect(margin, legendY - 3, 4, 3, 'F');
    doc.text('Execução medida', margin + 6, legendY);
    doc.setFillColor('#dbeafe').rect(margin + 42, legendY - 3, 4, 3, 'F');
    doc.text('Saldo planejado', margin + 48, legendY);
    doc.text('Valores das medições por competência (R$)', margin + 86, legendY);
  }

  blocks.forEach((block, index) => {
    if (index) doc.addPage();
    const leadingColumns = byChapter ? 1 : 3;
    const calendarWidth = blocks[0].length * minimumMonthWidth;
    const descriptions = width - calendarWidth - (byChapter ? 0 : codeWidth + progressWidth);
    const monthWidth = block.length ? calendarWidth / block.length : 0;
    const body: CellInput[][] = [];
    const portions = new Map<number, Portions>();
    function addRow(labels: CellInput[], row: Portions) {
      portions.set(body.length, row);
      body.push([...labels, ...block.map(month => ({ content: '', styles: {
        minCellHeight: row.measured.has(month) && row.planned.has(month) ? 12 : 0,
      } }))]);
    }
    doc.setFont('helvetica', 'normal').setFontSize(rowFontSize);
    if (byChapter) {
      for (const chapter of chapters.values()) addRow([{ content: chapter.title, styles: { fontStyle: 'bold' } }], chapter);
    } else {
      for (const group of groups) {
        const rows = group.rows.filter(row => row.measured.size || row.planned.size
          ? block.some(month => row.measured.has(month) || row.planned.has(month))
          : index === 0);
        if (!rows.length) continue;
        body.push([{ content: group.title, colSpan: leadingColumns + block.length,
          styles: { fillColor: '#e2e8f0', fontStyle: 'bold', halign: 'left' } }]);
        for (const row of rows) {
          const name = shortActivityName(doc, row.name, descriptions - 4);
          addRow([row.code || '—', row.note ? `${name}\n${row.note}` : name, monthlyPercentage(row.progress / 100)], row);
        }
      }
    }
    if (!body.length) body.push([{ content: 'Nenhuma atividade com parcela nestes meses.', colSpan: leadingColumns + block.length }]);
    autoTable(doc, {
      theme: 'grid',
      head: [[
        ...(byChapter ? ['Capítulo'] : ['EAP', 'Atividade', 'Execução\n(%)']),
        ...block.map<CellInput>(month => ({
          content: `${monthlyPeriodLabel(month).replace('/', '\n')}${measurementValues[month] === undefined ? '' : `\n${money.format(measurementValues[month])}`}`,
          styles: { halign: 'center', cellPadding: { top: 1.4, bottom: 1.4, left: 0.8, right: 0.8 } },
        })),
      ]],
      body,
      margin: { top: tableTop, bottom: 14, left: margin, right: margin },
      showHead: 'everyPage',
      rowPageBreak: 'avoid',
      styles: { font: 'helvetica', fontSize: rowFontSize, cellPadding: { top: 1.4, bottom: 1.4, left: 2, right: 2 },
        textColor: '#0f172a', lineColor: '#e2e8f0',
        valign: 'middle', overflow: 'linebreak' },
      headStyles: { fillColor: '#334155', textColor: '#ffffff' },
      columnStyles: {
        ...(byChapter ? { 0: { cellWidth: descriptions } } : {
          0: { cellWidth: codeWidth, cellPadding: { top: 1.4, bottom: 1.4, left: 1.4, right: 1.4 } },
          1: { cellWidth: descriptions }, 2: { cellWidth: progressWidth, halign: 'right' as const },
        }),
        ...Object.fromEntries(block.map((_, column) => [column + leadingColumns, { cellWidth: monthWidth, halign: 'center' }])),
      },
      willDrawPage: drawHeader,
      didDrawCell: ({ section, column, row, cell }) => {
        const month = block[column.index - leadingColumns];
        const task = portions.get(row.index);
        if (section !== 'body' || !month || !task) return;
        const measured = task.measured.get(month);
        const planned = task.planned.get(month);
        const bars = [
          { text: measured, fill: '#bbf7d0', ink: '#14532d' },
          { text: planned, fill: '#dbeafe', ink: '#1e3a8a' },
        ].filter(bar => bar.text !== undefined);
        bars.forEach((bar, order) => {
          const center = cell.y + cell.height / 2 + (order - (bars.length - 1) / 2) * 5;
          doc.setFillColor(bar.fill).roundedRect(cell.x + 1, center - 2, cell.width - 2, 4, 0.8, 0.8, 'F');
          if (bar.text) {
            doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(bar.ink);
            doc.text(bar.text, cell.x + cell.width / 2, center, { align: 'center', baseline: 'middle' });
          }
        });
      },
    });
  });
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page).setFont('helvetica', 'normal').setFontSize(9).setTextColor('#475569');
    doc.text(`Página ${page} de ${pageCount}`, margin + width, doc.internal.pageSize.getHeight() - 7, { align: 'right' });
  }
  return doc;
}

export async function exportSchedulePdf(input: SchedulePdfInput) {
  const document = await buildSchedulePdfDocument(input);
  const name = input.project.name.trim().replace(/[<>:"/\\|?*]/g, '-');
  document.save(`${input.byChapter ? 'Cronograma por capítulos' : 'Cronograma'} - ${name || 'Obra'}.pdf`);
}
