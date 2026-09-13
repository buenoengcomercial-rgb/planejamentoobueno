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

const fmtBRL = (value: number) => value.toLocaleString('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactBRL = (value: number) => {
  if (Math.abs(value) >= 1000000) return `${fmtBRL(value / 1000000)} mi`;
  if (Math.abs(value) >= 1000) return `${fmtBRL(value / 1000)} mil`;
  return fmtBRL(value);
};

type CostUsagePoint = {
  name: string;
  orcado: number;
  utilizado: number;
  saldo: number;
  itensPendentes: number;
};

export function DashboardCostChart({ data }: { data: CostUsagePoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data}>
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
  );
}

type ProgressPoint = { name: string; progresso: number };
type StatusPoint = { name: string; value: number; color: string };
type CurvePoint = { day: string; planejado: number; realizado: number };

export function DashboardOperationalCharts({
  phaseData,
  statusData,
  curvaS,
}: {
  phaseData: ProgressPoint[];
  statusData: StatusPoint[];
  curvaS: CurvePoint[];
}) {
  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm lg:col-span-2">
          <h3 className="mb-4 text-sm font-semibold text-foreground">Progresso por Capítulo</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={phaseData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
              <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} domain={[0, 100]} />
              <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }} />
              <Bar dataKey="progresso" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold text-foreground">Status das Tarefas</h3>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={statusData} cx="50%" cy="50%" innerRadius={55} outerRadius={80} paddingAngle={4} dataKey="value">
                {statusData.map((entry, index) => <Cell key={entry.name || index} fill={entry.color} />)}
              </Pie>
              <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="mt-2 flex justify-center gap-4">
            {statusData.map(status => (
              <div key={status.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <div className="h-2.5 w-2.5 rounded-full" style={{ background: status.color }} />
                {status.name}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h3 className="mb-4 text-sm font-semibold text-foreground">Curva S - Planejado vs Realizado</h3>
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
        <div className="mt-2 flex justify-center gap-6">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><div className="h-0.5 w-6 rounded bg-primary" /> Planejado</div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><div className="h-0.5 w-6 rounded bg-success" /> Realizado</div>
        </div>
      </div>
    </>
  );
}
