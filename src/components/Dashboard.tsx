import { Project } from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { generateCurvaS, suggestOptimizations } from '@/lib/calculations';
import { buildDashboardFinancialSummary } from '@/lib/dashboardFinancial';
import { getChapterTree, getChapterTasks, getChapterNumbering } from '@/lib/chapters';
import { motion } from 'framer-motion';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { lazyWithReload } from '@/lib/lazyWithReload';
import { ModulePageHeader } from './ModulePageHeader';
import {
  AlertTriangle,
  BrickWall,
  CheckCircle2,
  CircleSlash,
  HardHat,
  Target,
  TrendingUp,
  Truck,
  Zap,
} from 'lucide-react';

const DashboardCostChart = lazyWithReload(() => import('./DashboardCharts').then(module => ({ default: module.DashboardCostChart })));
const DashboardOperationalCharts = lazyWithReload(() => import('./DashboardCharts').then(module => ({ default: module.DashboardOperationalCharts })));

function ChartFallback({ className = 'h-[220px]' }: { className?: string }) {
  return <div className={`${className} animate-pulse rounded-lg bg-muted/40`} role="status" aria-label="Carregando gráficos" />;
}

interface DashboardProps {
  project: Project;
  undoButton?: React.ReactNode;
}

const COST_CLASS_ICON = {
  material: BrickWall,
  labor: HardHat,
  equipment: Truck,
  unclassified: CircleSlash,
} as const;

const COST_CLASS_TONE = {
  material: 'text-orange-600 bg-orange-50 border-orange-200',
  labor: 'text-red-600 bg-red-50 border-red-200',
  equipment: 'text-blue-600 bg-blue-50 border-blue-200',
  unclassified: 'text-slate-600 bg-slate-50 border-slate-200',
} as const;

const COST_CLASS_LABEL = {
  material: 'Material',
  labor: 'Mao de obra',
  equipment: 'Equipamento',
  unclassified: 'Outros',
} as const;

const fmtBRL = (value: number) => value.toLocaleString('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const fmtPct = (value: number) => `${(Number(value) || 0).toLocaleString('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}%`;

const compactBRL = (value: number) => {
  if (Math.abs(value) >= 1000000) return `${fmtBRL(value / 1000000)} mi`;
  if (Math.abs(value) >= 1000) return `${fmtBRL(value / 1000)} mil`;
  return fmtBRL(value);
};

function MetricLine({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={`text-right tabular-nums ${strong ? 'font-bold text-foreground' : 'font-semibold text-foreground'}`}>{value}</span>
    </div>
  );
}

export default function Dashboard({ project, undoButton }: DashboardProps) {
  const [chartsReady, setChartsReady] = useState(false);
  useEffect(() => {
    const windowWithIdle = window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (windowWithIdle.requestIdleCallback) {
      const id = windowWithIdle.requestIdleCallback(() => setChartsReady(true), { timeout: 800 });
      return () => windowWithIdle.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(() => setChartsReady(true), 0);
    return () => window.clearTimeout(id);
  }, []);
  const tasks = useMemo(() => getAllTasks(project), [project]);
  const financial = useMemo(() => buildDashboardFinancialSummary(project), [project]);
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.percentComplete === 100).length;
  const delayedTasks = tasks.filter(t => {
    const end = new Date(t.startDate);
    end.setDate(end.getDate() + Math.max(0, t.duration - 1));
    return end < new Date() && t.percentComplete < 100;
  }).length;
  const criticalTasks = tasks.filter(t => t.isCritical).length;
  const overallProgress = totalTasks > 0 ? Math.round(tasks.reduce((s, t) => s + t.percentComplete, 0) / totalTasks) : 0;

  const costUsageRows = useMemo(() => financial.classRows.map(row => ({
    ...row,
    label: COST_CLASS_LABEL[row.costClass],
    utilized: row.quotedLocalTotal,
    balance: Math.max(0, row.budgetTotal - row.quotedLocalTotal),
  })), [financial.classRows]);

  const costUsageChart = useMemo(() => costUsageRows.map(row => ({
    name: row.label,
    orcado: row.budgetTotal,
    utilizado: row.utilized,
    saldo: row.balance,
    itensCotados: row.quotedItemsCount,
    itensPendentes: row.pendingItemsCount,
  })), [costUsageRows]);

  const chapterTree = useMemo(() => getChapterTree(project), [project]);
  const chapterNumbering = useMemo(() => getChapterNumbering(project), [project]);
  const phaseData = useMemo(() => chapterTree.map(node => {
    const all = getChapterTasks(project, node.phase.id);
    const progresso = all.length
      ? Math.round(all.reduce((s, t) => s + t.percentComplete, 0) / all.length)
      : 0;
    const label = `${chapterNumbering.get(node.phase.id)} ${node.phase.name}`;
    return {
      name: label.length > 14 ? `${label.slice(0, 14)}...` : label,
      progresso,
    };
  }), [chapterTree, chapterNumbering, project]);

  const statusData = [
    { name: 'Concluido', value: completedTasks, color: 'hsl(152, 60%, 42%)' },
    { name: 'Em andamento', value: totalTasks - completedTasks - delayedTasks, color: 'hsl(230, 65%, 52%)' },
    { name: 'Atrasado', value: delayedTasks, color: 'hsl(0, 72%, 51%)' },
  ].filter(d => d.value > 0);

  const curvaS = generateCurvaS(project);
  const optimizations = suggestOptimizations(project);

  const cards = [
    { label: 'Progresso Geral', value: `${overallProgress}%`, icon: TrendingUp, color: 'text-primary' },
    { label: 'Tarefas concluídas', value: `${completedTasks}/${totalTasks}`, icon: CheckCircle2, color: 'text-success' },
    { label: 'Caminho crítico', value: `${criticalTasks}`, icon: Target, color: 'text-destructive' },
    { label: 'Atrasos', value: `${delayedTasks}`, icon: AlertTriangle, color: 'text-destructive' },
  ];

  return (
    <div className="p-6 space-y-6">
      <ModulePageHeader title="Dashboard" description={project.name} actions={undoButton} />

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {cards.map((card, i) => (
          <motion.div
            key={card.label}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.08 }}
            className="bg-card rounded-xl p-5 border border-border shadow-sm"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{card.label}</span>
              <card.icon className={`w-4 h-4 ${card.color}`} />
            </div>
            <p className="text-2xl font-bold text-foreground">{card.value}</p>
            {'hint' in card && Boolean(card.hint) && <p className="mt-1 text-[11px] text-muted-foreground">{String(card.hint)}</p>}
          </motion.div>
        ))}
      </div>

      <section className="rounded-xl border border-border bg-card p-4 shadow-sm" aria-label="Alertas prioritários">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <h3 className="text-sm font-semibold">Alertas prioritários</h3>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
          <div className="rounded-lg bg-muted/40 p-3 text-sm"><strong>{delayedTasks}</strong> tarefa(s) atrasada(s)</div>
          <div className="rounded-lg bg-muted/40 p-3 text-sm"><strong>{criticalTasks}</strong> atividade(s) no caminho crítico</div>
          <div className="rounded-lg bg-muted/40 p-3 text-sm"><strong>{financial.pendingQuoteItemsCount}</strong> insumo(s) pendente(s) de cotação</div>
        </div>
      </section>

      <details className="group overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide">Custos da obra</h3>
            <p className="mt-1 text-sm text-muted-foreground">Cobertura de cotações: {fmtPct(financial.quoteCoveragePct)} · custo cotado: {compactBRL(financial.quotedLocalTotal)}</p>
          </div>
          <span className="text-sm font-semibold text-primary group-open:hidden">Ver detalhes</span>
          <span className="hidden text-sm font-semibold text-primary group-open:inline">Recolher</span>
        </summary>
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }} className="border-t border-border p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground uppercase tracking-wide">Custos da obra</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Orçado vem da composição analítica/Lista de Material. Utilizado vem das cotações válidas registradas na aba Custos.
            </p>
          </div>
          <span className="rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
            Cobertura {fmtPct(financial.quoteCoveragePct)}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          {costUsageRows.map(row => {
            const Icon = COST_CLASS_ICON[row.costClass];
            const tone = COST_CLASS_TONE[row.costClass];
            return (
              <div key={row.costClass} className="rounded-lg border border-border bg-background p-4 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold uppercase tracking-wide text-foreground">{row.label}</span>
                  <span className={`flex h-9 w-9 items-center justify-center rounded-md border ${tone}`}>
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                </div>
                <div className="mt-4 space-y-2 text-sm">
                  <MetricLine label="Orcado" value={fmtBRL(row.budgetTotal)} />
                  <MetricLine label="Utilizado" value={fmtBRL(row.utilized)} />
                  <MetricLine label="Saldo" value={fmtBRL(row.balance)} strong />
                </div>
                <div className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{row.quotedItemsCount} cotado(s)</span>
                  <span>{row.pendingItemsCount} pendente(s)</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span><strong>BDI:</strong> {fmtPct(financial.bdiPercent)}</span>
            <span><strong>Valor do BDI:</strong> {fmtBRL(financial.bdiValue)}</span>
            <span><strong>Contratado:</strong> {fmtBRL(financial.contractedWithBdi)}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span><strong>Custo direto:</strong> {fmtBRL(financial.budgetDirectCost)}</span>
            <span><strong>Utilizado:</strong> {fmtBRL(financial.quotedLocalTotal)}</span>
            <span><strong>Saldo:</strong> {fmtBRL(Math.max(0, financial.budgetDirectCost - financial.quotedLocalTotal))}</span>
          </div>
        </div>

        <div className="mt-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h4 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Grafico: Orcado x Utilizado</h4>
            <span className="text-[11px] text-muted-foreground">{financial.quotedItemsCount} item(ns) cotado(s)</span>
          </div>
          <div className="h-[260px]">
            {chartsReady ? <Suspense fallback={<ChartFallback className="h-[260px]" />}><DashboardCostChart data={costUsageChart} /></Suspense> : <ChartFallback className="h-[260px]" />}
          </div>
        </div>
      </motion.div>
      </details>

      {chartsReady
        ? <Suspense fallback={<><ChartFallback /><ChartFallback /></>}><DashboardOperationalCharts phaseData={phaseData} statusData={statusData} curvaS={curvaS} /></Suspense>
        : <><ChartFallback /><ChartFallback /></>}

      {optimizations.length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }} className="bg-card rounded-xl p-5 border border-border shadow-sm">
          <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
            <Zap className="w-4 h-4 text-warning" />
            Sugestões de otimização (caminho crítico)
          </h3>
          <div className="space-y-2">
            {optimizations.map(opt => (
              <div key={opt.taskId} className="flex items-center justify-between p-3 rounded-lg bg-warning/5 border border-warning/20">
                <div>
                  <p className="text-xs font-semibold text-foreground">{opt.taskName}</p>
                  <p className="text-[10px] text-muted-foreground">
                    Dobrar <strong>{opt.bottleneck}</strong> para {opt.suggestedWorkers} trab.
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-bold text-foreground">{opt.currentDuration}d para {opt.newDuration}d</p>
                  <p className="text-[10px] text-success font-medium">-{opt.currentDuration - opt.newDuration} dias</p>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </div>
  );
}
