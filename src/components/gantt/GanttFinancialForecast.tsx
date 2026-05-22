import { useMemo } from 'react';
import { CalendarDays, CircleDollarSign, TrendingDown, TrendingUp, WalletCards } from 'lucide-react';
import type { Project } from '@/types/project';
import {
  buildGanttFinancialForecast,
  type GanttFinancialForecastMonth,
} from '@/lib/ganttFinancialForecast';
import { cn } from '@/lib/utils';

interface GanttFinancialForecastProps {
  project: Project;
  trabalhaSabado?: boolean;
}

const fmtBRL = (value: number) =>
  (Number(value) || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtPct = (value: number) =>
  `${(Number.isFinite(value) ? value : 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;

const getVisibleMonths = (months: GanttFinancialForecastMonth[]) => {
  if (!months.length) return [];
  const todayKey = new Date().toISOString().slice(0, 7);
  const todayIndex = months.findIndex(month => month.key === todayKey);
  if (todayIndex >= 0) return months.slice(todayIndex, todayIndex + 6);

  const firstOpen = months.findIndex(month => month.planned > 0 || month.realized > 0);
  if (firstOpen >= 0) return months.slice(firstOpen, firstOpen + 6);
  return months.slice(0, 6);
};

function ForecastCard({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'neutral' | 'good' | 'bad' | 'info';
}) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-background/70 p-3',
        tone === 'good' && 'border-success/30 bg-success/5',
        tone === 'bad' && 'border-destructive/30 bg-destructive/5',
        tone === 'info' && 'border-primary/30 bg-primary/5',
      )}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-bold tabular-nums text-foreground">{value}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{detail}</div>
    </div>
  );
}

export default function GanttFinancialForecast({
  project,
  trabalhaSabado = false,
}: GanttFinancialForecastProps) {
  const forecast = useMemo(
    () => buildGanttFinancialForecast(project, trabalhaSabado),
    [project, trabalhaSabado],
  );

  const visibleMonths = useMemo(() => getVisibleMonths(forecast.months), [forecast.months]);
  const selectedMonth = visibleMonths[0];
  const nextMonth = visibleMonths[1];

  if (!forecast.months.length) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card p-3 text-xs text-muted-foreground">
        O cronograma ainda não tem datas suficientes para montar a previsão financeira mensal.
      </div>
    );
  }

  const currentPlanned = selectedMonth?.planned ?? 0;
  const currentRealized = selectedMonth?.realized ?? 0;
  const currentDelta = currentRealized - currentPlanned;
  const currentPct = currentPlanned > 0 ? (currentRealized / currentPlanned) * 100 : 0;

  return (
    <section className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-secondary/30 px-3 py-2">
        <div>
          <div className="flex items-center gap-2">
            <WalletCards className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-bold text-foreground">Previsão financeira do cronograma</h3>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Centro de custos mensal: previsto pelo Gantt x realizado pelos apontamentos de produção.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <CalendarDays className="h-3.5 w-3.5" />
          {forecast.months.length} competência(s) calculada(s)
        </div>
      </div>

      <div className="grid gap-2 p-3 md:grid-cols-4">
        <ForecastCard
          label={selectedMonth ? `Previsto em ${selectedMonth.label}` : 'Previsto no mês'}
          value={fmtBRL(currentPlanned)}
          detail={`${selectedMonth?.taskCount ?? 0} serviço(s) planejado(s)`}
          tone="info"
        />
        <ForecastCard
          label="Realizado apontado"
          value={fmtBRL(currentRealized)}
          detail={`${selectedMonth?.realizedTaskCount ?? 0} apontamento(s) no mês`}
          tone={currentRealized >= currentPlanned && currentPlanned > 0 ? 'good' : 'neutral'}
        />
        <ForecastCard
          label="Diferença do mês"
          value={fmtBRL(currentDelta)}
          detail={currentPlanned > 0 ? `${fmtPct(currentPct)} do previsto` : 'sem previsão no mês'}
          tone={currentDelta >= 0 ? 'good' : 'bad'}
        />
        <ForecastCard
          label={nextMonth ? `Próximo mês (${nextMonth.label})` : 'Próximo mês'}
          value={fmtBRL(nextMonth?.planned ?? 0)}
          detail="base para prever medição"
          tone="neutral"
        />
      </div>

      <div className="px-3 pb-3">
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-[11px]">
            <thead className="bg-muted/70 text-muted-foreground">
              <tr>
                <th className="px-2 py-2 text-left font-semibold">Mês</th>
                <th className="px-2 py-2 text-right font-semibold">Previsto</th>
                <th className="px-2 py-2 text-right font-semibold">Realizado</th>
                <th className="px-2 py-2 text-right font-semibold">Diferença</th>
                <th className="px-2 py-2 text-left font-semibold">Leitura rápida</th>
              </tr>
            </thead>
            <tbody>
              {visibleMonths.map(month => {
                const delta = month.realized - month.planned;
                const pct = month.planned > 0 ? Math.min(130, Math.max(0, (month.realized / month.planned) * 100)) : 0;
                const isPositive = delta >= 0;
                return (
                  <tr key={month.key} className="border-t border-border/70">
                    <td className="px-2 py-2 font-medium text-foreground">{month.label}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtBRL(month.planned)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtBRL(month.realized)}</td>
                    <td className={cn('px-2 py-2 text-right font-semibold tabular-nums', isPositive ? 'text-success' : 'text-destructive')}>
                      {fmtBRL(delta)}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-2">
                        {isPositive ? (
                          <TrendingUp className="h-3.5 w-3.5 text-success" />
                        ) : (
                          <TrendingDown className="h-3.5 w-3.5 text-destructive" />
                        )}
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn('h-full rounded-full', isPositive ? 'bg-success' : 'bg-primary')}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="w-12 text-right tabular-nums text-muted-foreground">{fmtPct(month.planned > 0 ? (month.realized / month.planned) * 100 : 0)}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {(forecast.tasksWithoutDate > 0 || forecast.tasksWithoutPrice > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <CircleDollarSign className="h-3.5 w-3.5 text-warning" />
            {forecast.tasksWithoutDate > 0 && <span>{forecast.tasksWithoutDate} serviço(s) sem data não entraram na previsão.</span>}
            {forecast.tasksWithoutPrice > 0 && <span>{forecast.tasksWithoutPrice} serviço(s) sem preço não entraram no valor mensal.</span>}
          </div>
        )}
      </div>
    </section>
  );
}
