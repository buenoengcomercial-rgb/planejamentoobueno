import { Project } from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { generateCurvaS, suggestOptimizations } from '@/lib/calculations';
import { buildDashboardFinancialSummary } from '@/lib/dashboardFinancial';
import { getChapterTree, getChapterTasks, getChapterNumbering } from '@/lib/chapters';
import { motion } from 'framer-motion';
import { useMemo } from 'react';
import {
  AlertTriangle,
  BrickWall,
  CheckCircle2,
  CircleSlash,
  DollarSign,
  HardHat,
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
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={costUsageChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
                <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={value => compactBRL(Number(value)).replace('R$', '').trim()} />
                <Tooltip
                  formatter={(value: number, name: string) => [fmtBRL(value), name === 'orcado' ? 'Orcado' : 'Utilizado']}
                  labelFormatter={(label, payload) => {
                    const row = payload?.[0]?.payload;
                    if (!row) return label;
                    return `${label} - saldo ${fmtBRL(row.saldo)} - ${row.itensPendentes} pendente(s)`;
                  }}
                  contentStyle={{ borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }}
                />
                <Legend />
                <Bar dataKey="orcado" name="Orcado" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
                <Bar dataKey="utilizado" name="Utilizado" fill="hsl(152, 60%, 42%)" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
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
