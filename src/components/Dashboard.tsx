import { Project } from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { generateCurvaS, suggestOptimizations } from '@/lib/calculations';
import * as MC from '@/lib/materialComparisons';
import { buildDashboardFinancialSummary, type DashboardClassComparisonRow } from '@/lib/dashboardFinancial';
import { getChapterTree, getChapterTasks, getChapterNumbering } from '@/lib/chapters';
import { motion } from 'framer-motion';
import { useMemo } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  BrickWall,
  CheckCircle2,
  CircleSlash,
  DollarSign,
  FileText,
  HardHat,
  Percent,
  ShoppingCart,
  Target,
  TrendingUp,
  Truck,
  Zap,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

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

function FinanceMetric({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ElementType;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}) {
  const toneClass =
    tone === 'success' ? 'text-success' :
    tone === 'warning' ? 'text-warning' :
    tone === 'danger' ? 'text-destructive' :
    'text-primary';

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <Icon className={`h-4 w-4 ${toneClass}`} />
      </div>
      <p className={`mt-2 text-base font-bold tabular-nums ${toneClass}`}>{value}</p>
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ComparisonTableRow({ row, total = false }: { row: DashboardClassComparisonRow; total?: boolean }) {
  const savingsTone = row.savings < 0 ? 'text-destructive' : total ? 'text-emerald-300' : 'text-success';
  const cellClass = total ? 'px-3 py-2 text-right tabular-nums' : 'px-3 py-2 text-right tabular-nums border-t border-border';
  const leftClass = total ? 'px-3 py-2 text-left' : 'px-3 py-2 text-left border-t border-border';
  const centerClass = total ? 'px-3 py-2 text-center tabular-nums' : 'px-3 py-2 text-center tabular-nums border-t border-border';

  return (
    <tr>
      <td className={`${leftClass} font-semibold`}>{row.label}</td>
      <td className={cellClass}>{fmtBRL(row.budgetTotal)}</td>
      <td className={cellClass}>{fmtBRL(row.quotedBudgetTotal)}</td>
      <td className={cellClass}>{fmtBRL(row.quotedLocalTotal)}</td>
      <td className={`${cellClass} font-semibold ${savingsTone}`}>{fmtBRL(row.savings)}</td>
      <td className={`${cellClass} font-semibold ${savingsTone}`}>{fmtPct(row.savingsPct)}</td>
      <td className={centerClass}>{row.quotedItemsCount}</td>
      <td className={centerClass}>{row.pendingItemsCount}</td>
    </tr>
  );
}

export default function Dashboard({ project, undoButton }: DashboardProps) {
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

  const materialCostTotals = useMemo(() => MC.computeMaterialCostClassTotals(project), [project]);
  const materialCostChart = useMemo(
    () => materialCostTotals
      .filter(row => row.total > 0 || row.itemsCount > 0)
      .map(row => ({
        name: row.label,
        total: row.total,
        color: MC.MATERIAL_COST_CLASS_COLOR[row.costClass],
        costClass: row.costClass,
      })),
    [materialCostTotals],
  );

  const quotedVsBudgetChart = useMemo(() => financial.classRows.map(row => ({
    name: row.costClass === 'unclassified' ? 'Outros' : row.label,
    orcado: row.quotedBudgetTotal,
    cotado: row.quotedLocalTotal,
    economia: row.savings,
    economiaPct: row.savingsPct,
    itensCotados: row.quotedItemsCount,
    itensPendentes: row.pendingItemsCount,
  })), [financial.classRows]);

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
    { label: 'Tarefas Concluidas', value: `${completedTasks}/${totalTasks}`, icon: CheckCircle2, color: 'text-success' },
    { label: 'Caminho Critico', value: `${criticalTasks}`, icon: Target, color: 'text-destructive' },
    { label: 'Atrasos', value: `${delayedTasks}`, icon: AlertTriangle, color: 'text-destructive' },
    {
      label: 'Custo Cotado',
      value: compactBRL(financial.quotedLocalTotal),
      icon: DollarSign,
      color: 'text-warning',
      hint: 'Cotacoes selecionadas na aba Custos.',
    },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Dashboard</h2>
          <p className="text-sm text-muted-foreground mt-1">{project.name}</p>
        </div>
        {undoButton}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
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
            {'hint' in card && card.hint && <p className="mt-1 text-[11px] text-muted-foreground">{card.hint}</p>}
          </motion.div>
        ))}
      </div>

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }} className="bg-card rounded-xl p-5 border border-border shadow-sm">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Resumo financeiro da obra</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Base contratual vinda da Sintetica/Medicao; cotacoes locais vem da aba Custos com uma cotacao valida por item.
            </p>
          </div>
          <span className="rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
            Cobertura {fmtPct(financial.quoteCoveragePct)}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
          <FinanceMetric label="Custo orcado s/ BDI" value={fmtBRL(financial.budgetDirectCost)} icon={FileText} />
          <FinanceMetric label="BDI" value={fmtPct(financial.bdiPercent)} hint={fmtBRL(financial.bdiValue)} icon={Percent} />
          <FinanceMetric label="Contratado c/ BDI" value={fmtBRL(financial.contractedWithBdi)} icon={BadgeCheck} />
          <FinanceMetric label="Valor cotado localmente" value={fmtBRL(financial.quotedLocalTotal)} icon={ShoppingCart} />
          <FinanceMetric
            label={financial.savings >= 0 ? 'Economia prevista' : 'Aumento previsto'}
            value={fmtBRL(financial.savings)}
            hint={fmtPct(financial.savingsPct)}
            icon={financial.savings >= 0 ? TrendingUp : AlertTriangle}
            tone={financial.savings >= 0 ? 'success' : 'danger'}
          />
          <FinanceMetric label="Orcado dos itens cotados" value={fmtBRL(financial.quotedBudgetTotal)} icon={DollarSign} />
          <FinanceMetric label="Total elegivel p/ cotar" value={fmtBRL(financial.eligibleBudgetTotal)} icon={Target} />
          <FinanceMetric label="Itens cotados" value={String(financial.quotedItemsCount)} icon={CheckCircle2} tone="success" />
          <FinanceMetric label="Itens pendentes" value={String(financial.pendingQuoteItemsCount)} icon={AlertTriangle} tone={financial.pendingQuoteItemsCount > 0 ? 'warning' : 'success'} />
          <FinanceMetric label="BDI em separado" value={fmtBRL(financial.bdiValue)} hint="Nao entra como classe de custo." icon={CircleSlash} />
        </div>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }} className="bg-card rounded-xl p-5 border border-border shadow-sm">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Custo por classificacao</h3>
            <p className="text-xs text-muted-foreground mt-1">Referencia calculada a partir da Lista de Material.</p>
          </div>
          <span className="text-[11px] text-muted-foreground">
            Total ref.: <strong className="text-foreground">{fmtBRL(materialCostTotals.reduce((sum, row) => sum + row.total, 0))}</strong>
          </span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            {materialCostTotals.map(row => {
              const Icon = COST_CLASS_ICON[row.costClass];
              return (
                <div key={row.costClass} className="rounded-lg border border-border bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <Icon className="w-3.5 h-3.5" style={{ color: MC.MATERIAL_COST_CLASS_COLOR[row.costClass] }} />
                      {row.label}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{row.itemsCount} item{row.itemsCount === 1 ? '' : 's'}</span>
                  </div>
                  <p className="mt-2 text-base font-bold text-foreground tabular-nums">
                    {fmtBRL(row.total)}
                  </p>
                  {row.missingPriceCount > 0 && (
                    <p className="mt-1 text-[10px] text-muted-foreground">{row.missingPriceCount} sem preco ref.</p>
                  )}
                </div>
              );
            })}
          </div>
          <div className="min-h-[180px]">
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={materialCostChart} cx="50%" cy="50%" innerRadius={42} outerRadius={70} dataKey="total" nameKey="name" paddingAngle={3}>
                  {materialCostChart.map(entry => (
                    <Cell key={entry.costClass} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number) => fmtBRL(value)}
                  contentStyle={{ borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.28 }} className="bg-card rounded-xl p-5 border border-border shadow-sm">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Orcado x Cotado local por classificacao</h3>
            <p className="text-xs text-muted-foreground mt-1">
              O grafico compara somente itens que possuem cotacao valida. Pendentes nao entram como custo zero.
            </p>
          </div>
          <span className="text-[11px] text-muted-foreground">
            {fmtPct(financial.quoteCoveragePct)} do valor orcado elegivel ja possui cotacao valida.
          </span>
        </div>

        {financial.quotedItemsCount === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
            Ainda nao existem cotacoes selecionadas para comparacao.
          </div>
        ) : (
          <>
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={quotedVsBudgetChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={value => compactBRL(Number(value)).replace('R$', '').trim()} />
                  <Tooltip
                    formatter={(value: number, name: string) => [fmtBRL(value), name === 'orcado' ? 'Orcado dos itens cotados' : 'Cotado localmente']}
                    labelFormatter={(label, payload) => {
                      const row = payload?.[0]?.payload;
                      if (!row) return label;
                      return `${label} - economia ${fmtBRL(row.economia)} (${fmtPct(row.economiaPct)}) - ${row.itensCotados} item(ns)`;
                    }}
                    contentStyle={{ borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }}
                  />
                  <Legend />
                  <Bar dataKey="orcado" name="Orcado" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="cotado" name="Cotado localmente" fill="hsl(152, 60%, 42%)" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-4 overflow-auto rounded-lg border border-border">
              <table className="w-full min-w-[980px] text-xs">
                <thead className="bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Classificacao</th>
                    <th className="px-3 py-2 text-right">Orcado total</th>
                    <th className="px-3 py-2 text-right">Orcado ja cotado</th>
                    <th className="px-3 py-2 text-right">Valor cotado</th>
                    <th className="px-3 py-2 text-right">Economia</th>
                    <th className="px-3 py-2 text-right">Economia %</th>
                    <th className="px-3 py-2 text-center">Itens cotados</th>
                    <th className="px-3 py-2 text-center">Itens pendentes</th>
                  </tr>
                </thead>
                <tbody>
                  {financial.classRows.map(row => (
                    <ComparisonTableRow key={row.costClass} row={row} />
                  ))}
                </tbody>
                <tfoot className="bg-slate-900 text-white font-semibold">
                  <ComparisonTableRow row={financial.totalsRow} total />
                </tfoot>
              </table>
            </div>
          </>
        )}
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }} className="lg:col-span-2 bg-card rounded-xl p-5 border border-border shadow-sm">
          <h3 className="text-sm font-semibold text-foreground mb-4">Progresso por Capitulo</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={phaseData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
              <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} domain={[0, 100]} />
              <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }} />
              <Bar dataKey="progresso" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </motion.div>

        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }} className="bg-card rounded-xl p-5 border border-border shadow-sm">
          <h3 className="text-sm font-semibold text-foreground mb-4">Status das Tarefas</h3>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={statusData} cx="50%" cy="50%" innerRadius={55} outerRadius={80} paddingAngle={4} dataKey="value">
                {statusData.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex justify-center gap-4 mt-2">
            {statusData.map(s => (
              <div key={s.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
                {s.name}
              </div>
            ))}
          </div>
        </motion.div>
      </div>

      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }} className="bg-card rounded-xl p-5 border border-border shadow-sm">
        <h3 className="text-sm font-semibold text-foreground mb-4">Curva S - Planejado vs Realizado</h3>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={curvaS}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
            <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} domain={[0, 100]} unit="%" />
            <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }} />
            <Area type="monotone" dataKey="planejado" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.1)" strokeWidth={2} name="Planejado" />
            <Area type="monotone" dataKey="realizado" stroke="hsl(var(--success))" fill="hsl(var(--success) / 0.1)" strokeWidth={2} name="Realizado" />
          </AreaChart>
        </ResponsiveContainer>
        <div className="flex justify-center gap-6 mt-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <div className="w-6 h-0.5 bg-primary rounded" /> Planejado
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <div className="w-6 h-0.5 bg-success rounded" /> Realizado
          </div>
        </div>
      </motion.div>

      {optimizations.length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }} className="bg-card rounded-xl p-5 border border-border shadow-sm">
          <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
            <Zap className="w-4 h-4 text-warning" />
            Sugestoes de Otimizacao (Caminho Critico)
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
