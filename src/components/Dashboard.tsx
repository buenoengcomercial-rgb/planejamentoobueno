import { Project } from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { generateCurvaS, suggestOptimizations } from '@/lib/calculations';
import * as MC from '@/lib/materialComparisons';
import { getChapterTree, getChapterTasks, getChapterNumbering } from '@/lib/chapters';
import { motion } from 'framer-motion';
import { useMemo } from 'react';
import { TrendingUp, AlertTriangle, DollarSign, CheckCircle2, Zap, Target, BrickWall, HardHat, Truck, CircleSlash } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area } from 'recharts';

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

export default function Dashboard({ project, undoButton }: DashboardProps) {
  const tasks = useMemo(() => getAllTasks(project), [project]);
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.percentComplete === 100).length;
  const delayedTasks = tasks.filter(t => {
    const end = new Date(t.startDate);
    // Fim = último dia trabalhado = start + (duration − 1)
    end.setDate(end.getDate() + Math.max(0, t.duration - 1));
    return end < new Date() && t.percentComplete < 100;
  }).length;
  const criticalTasks = tasks.filter(t => t.isCritical).length;
  const overallProgress = totalTasks > 0 ? Math.round(tasks.reduce((s, t) => s + t.percentComplete, 0) / totalTasks) : 0;

  const allMaterials = tasks.flatMap(t => t.materials);
  const totalCost = allMaterials.reduce((s, m) => s + (m.estimatedCost || 0), 0);
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

  // Agrupa progresso por capítulo principal (incluindo seus subcapítulos)
  const chapterTree = useMemo(() => getChapterTree(project), [project.phases]);
  const chapterNumbering = useMemo(() => getChapterNumbering(project), [project.phases]);
  const phaseData = useMemo(() => chapterTree.map(node => {
    const all = getChapterTasks(project, node.phase.id);
    const progresso = all.length
      ? Math.round(all.reduce((s, t) => s + t.percentComplete, 0) / all.length)
      : 0;
    const label = `${chapterNumbering.get(node.phase.id)} ${node.phase.name}`;
    return {
      name: label.length > 14 ? label.slice(0, 14) + '…' : label,
      progresso,
    };
  }), [chapterTree, chapterNumbering, project]);

  const statusData = [
    { name: 'Concluído', value: completedTasks, color: 'hsl(152, 60%, 42%)' },
    { name: 'Em andamento', value: totalTasks - completedTasks - delayedTasks, color: 'hsl(230, 65%, 52%)' },
    { name: 'Atrasado', value: delayedTasks, color: 'hsl(0, 72%, 51%)' },
  ].filter(d => d.value > 0);

  // Real Curva S from task data
  const curvaS = generateCurvaS(project);

  // Optimization suggestions
  const optimizations = suggestOptimizations(project);

  const cards = [
    { label: 'Progresso Geral', value: `${overallProgress}%`, icon: TrendingUp, color: 'text-primary' },
    { label: 'Tarefas Concluídas', value: `${completedTasks}/${totalTasks}`, icon: CheckCircle2, color: 'text-success' },
    { label: 'Caminho Crítico', value: `${criticalTasks}`, icon: Target, color: 'text-destructive' },
    { label: 'Atrasos', value: `${delayedTasks}`, icon: AlertTriangle, color: 'text-destructive' },
    { label: 'Custo Estimado', value: `R$ ${(totalCost / 1000).toFixed(0)}k`, icon: DollarSign, color: 'text-warning' },
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
          </motion.div>
        ))}
      </div>

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }} className="bg-card rounded-xl p-5 border border-border shadow-sm">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Custo por classificação</h3>
            <p className="text-xs text-muted-foreground mt-1">Referência calculada a partir da Lista de Material.</p>
          </div>
          <span className="text-[11px] text-muted-foreground">
            Total ref.: <strong className="text-foreground">{materialCostTotals.reduce((sum, row) => sum + row.total, 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</strong>
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
                    {row.total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                  </p>
                  {row.missingPriceCount > 0 && (
                    <p className="mt-1 text-[10px] text-muted-foreground">{row.missingPriceCount} sem preço ref.</p>
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
                  formatter={(value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                  contentStyle={{ borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }} className="lg:col-span-2 bg-card rounded-xl p-5 border border-border shadow-sm">
          <h3 className="text-sm font-semibold text-foreground mb-4">Progresso por Capítulo</h3>
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

      {/* Real Curva S */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }} className="bg-card rounded-xl p-5 border border-border shadow-sm">
        <h3 className="text-sm font-semibold text-foreground mb-4">Curva S — Planejado vs Realizado</h3>
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

      {/* Optimization suggestions */}
      {optimizations.length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }} className="bg-card rounded-xl p-5 border border-border shadow-sm">
          <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
            <Zap className="w-4 h-4 text-warning" />
            Sugestões de Otimização (Caminho Crítico)
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
                  <p className="text-xs font-bold text-foreground">{opt.currentDuration}d → {opt.newDuration}d</p>
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
