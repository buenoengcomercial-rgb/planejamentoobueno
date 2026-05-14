import type { Project, Task, Phase, SavedMeasurement } from '@/types/project';
import { getChapterTree, getChapterNumbering, type ChapterNode } from '@/lib/chapters';
import { buildDailyReportSnapshot, summarizeDailyReportsForPeriod } from '@/lib/dailyReportSummary';
import type { GroupTotals } from './types';

// ───────────────────────── Helpers de formatação ─────────────────────────
export const fmtBRL = (n: number) => {
  // money2: arredondamento seguro em 2 casas — preserva valores já vindos da Sintética
  const v = Number(n) || 0;
  const safe = Math.round((v + Number.EPSILON) * 100) / 100;
  return safe.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};
export const fmtNum = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
export const fmtPct = (n: number) => `${n.toFixed(2)}%`;
export const fmtDateBR = (iso: string) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

export const emptyTotals = (): GroupTotals => ({
  contracted: 0, period: 0, accum: 0, balance: 0,
  contractedNoBDI: 0, periodNoBDI: 0, accumNoBDI: 0, balanceNoBDI: 0,
  qtyContracted: 0, qtyAccum: 0,
  forecast: 0, forecastNoBDI: 0, diffForecast: 0,
});

export function estimateTaskValue(task: Task): number {
  const materialsCost = (task.materials || []).reduce(
    (s, m) => s + (m.estimatedCost || 0) * (m.quantity || 1), 0,
  );
  const laborCost = (task.laborCompositions || []).reduce((s, c) => {
    if (!c.hourlyRate || !task.quantity) return s;
    return s + task.quantity * c.rup * c.hourlyRate;
  }, 0);
  return materialsCost + laborCost;
}

export function buildOrderedTasks(
  project: Project,
): Array<{ task: Task; phase: Phase; itemNumber: string; chain: string }> {
  const tree = getChapterTree(project);
  const numbering = getChapterNumbering(project);
  const out: Array<{ task: Task; phase: Phase; itemNumber: string; chain: string }> = [];

  const walk = (nodes: ChapterNode[], chain: string[]) => {
    nodes.forEach(node => {
      const phaseNumber = numbering.get(node.phase.id) || '';
      const newChain = [...chain, node.phase.name];
      node.phase.tasks.forEach((task, idx) => {
        out.push({
          task, phase: node.phase,
          itemNumber: `${phaseNumber}.${idx + 1}`,
          chain: newChain.join(' › '),
        });
      });
      walk(node.children, newChain);
    });
  };
  walk(tree, []);

  const visited = new Set(out.map(o => o.phase.id));
  project.phases.forEach(phase => {
    if (visited.has(phase.id)) return;
    const phaseNumber = numbering.get(phase.id) || '?';
    phase.tasks.forEach((task, idx) => {
      out.push({
        task, phase,
        itemNumber: `${phaseNumber}.${idx + 1}`,
        chain: phase.name,
      });
    });
  });

  return out;
}

// Helpers de data ISO (yyyy-mm-dd) sem timezone shift
export const isoAddDays = (iso: string, days: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

/**
 * Retorna a data de início da obra com base no Cronograma/Gantt.
 * Prioridade:
 *  1. Menor `task.startDate` entre tarefas com quantidade contratada ou valor unitário > 0.
 *  2. Menor `task.startDate` entre todas as tarefas da EAP.
 *  3. `undefined` se não houver nenhuma tarefa.
 */
export function getProjectStartDate(project: Project): string | undefined {
  const all: string[] = [];
  const contracted: string[] = [];
  (project.phases || []).forEach(ph => {
    (ph.tasks || []).forEach(t => {
      if (!t.startDate) return;
      all.push(t.startDate);
      const qty = Number(t.quantity) || 0;
      const price = (Number(t.unitPrice) || 0) + (Number(t.unitPriceNoBDI) || 0);
      if (qty > 0 || price > 0) contracted.push(t.startDate);
    });
  });
  const pool = contracted.length ? contracted : all;
  if (!pool.length) return undefined;
  return pool.reduce((min, d) => (d < min ? d : min), pool[0]);
}

/**
 * Calcula o período sugerido para a próxima medição em preparação.
 * Ciclo padrão de 30 dias corridos (data inicial + 29 dias).
 * - Sem medições anteriores: usa o início da obra (Gantt) se informado;
 *   caso contrário, faz fallback para `monthAgo` (hoje - 30 dias).
 * - Com medições anteriores: startDate = (data final da última) + 1 dia.
 */
export function suggestPeriodForNext(
  measurements: Array<{ number: number; endDate: string }>,
  today: string,
  monthAgo: string,
  projectStart?: string,
): { startDate: string; endDate: string } {
  if (!measurements.length) {
    const start = projectStart || monthAgo;
    return { startDate: start, endDate: isoAddDays(start, 29) };
  }
  // Última pelo maior nº; em empate, pela data final mais recente
  const last = [...measurements].sort((a, b) => {
    if (a.number !== b.number) return a.number - b.number;
    return a.endDate.localeCompare(b.endDate);
  })[measurements.length - 1];
  const start = isoAddDays(last.endDate, 1);
  const end = isoAddDays(start, 29);
  return { startDate: start, endDate: end };
}
