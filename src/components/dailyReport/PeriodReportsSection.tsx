import { CalendarDays, Activity, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { STATUS_META, WEATHER_LABEL_MAP, formatBR } from '@/components/dailyReport/dailyReportFormat';
import type { summarizeDailyReportsForPeriod } from '@/lib/dailyReportSummary';

interface PeriodReportsSectionProps {
  period: { id: string; label: string; startDate: string; endDate: string };
  summary: ReturnType<typeof summarizeDailyReportsForPeriod>;
  selectedDate: string;
  onSelectDate: (date: string) => void;
}

export function PeriodReportsSection({ period, summary, selectedDate, onSelectDate }: PeriodReportsSectionProps) {
  return (
    <Card className="border border-border">
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-primary" /> Diários por Medição — {period.label}
        </CardTitle>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatBR(period.startDate)} a {formatBR(period.endDate)}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
          <PeriodStat label="Dias no período" value={summary.totalDays} />
          <PeriodStat label="Diários preenchidos" value={summary.filledReports} tone="success" />
          <PeriodStat label="Diários pendentes" value={summary.missingReports} tone={summary.missingReports > 0 ? 'warning' : 'default'} />
          <PeriodStat label="Dias com produção" value={summary.productionDays} tone="info" />
          <PeriodStat label="Dias sem produção" value={summary.noProductionDays} />
          <PeriodStat label="Dias com impedimento" value={summary.impedimentDays} tone={summary.impedimentDays > 0 ? 'destructive' : 'default'} />
        </div>

        <div className="border border-border rounded-md overflow-hidden">
          <div className="max-h-[420px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold w-24">Data</th>
                  <th className="text-left px-3 py-2 font-semibold w-36">Status</th>
                  <th className="text-left px-3 py-2 font-semibold">Responsável</th>
                  <th className="text-left px-3 py-2 font-semibold w-28">Clima</th>
                  <th className="text-right px-3 py-2 font-semibold w-28">Produção</th>
                  <th className="text-right px-3 py-2 font-semibold w-32">Ação</th>
                </tr>
              </thead>
              <tbody>
                {summary.entries.map(e => {
                  const meta = STATUS_META[e.status];
                  const Icon = meta.icon;
                  const isCurrent = e.date === selectedDate;
                  return (
                    <tr
                      key={e.date}
                      className={`border-t border-border ${meta.row} ${isCurrent ? 'ring-1 ring-primary/40' : ''}`}
                    >
                      <td className="px-3 py-2 tabular-nums">{formatBR(e.date)}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${meta.pill}`}>
                          <Icon className="w-3 h-3" /> {meta.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 truncate max-w-[260px]">
                        {e.responsible || <span className="text-muted-foreground italic">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        {e.weather ? (WEATHER_LABEL_MAP[e.weather] || e.weather) : <span className="text-muted-foreground italic">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {e.totalProduction > 0 ? (
                          <span className="inline-flex items-center gap-1 text-foreground">
                            <Activity className="w-3 h-3 text-info" />
                            {e.totalProduction.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="sm"
                          variant={isCurrent ? 'default' : 'ghost'}
                          className="h-8 px-3 text-xs"
                          onClick={() => onSelectDate(e.date)}
                        >
                          Abrir/Editar <ArrowRight className="w-3 h-3 ml-1" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PeriodStat({
  label, value, tone = 'default',
}: { label: string; value: number; tone?: 'default' | 'success' | 'warning' | 'info' | 'destructive' }) {
  const toneCls =
    tone === 'success' ? 'text-success' :
    tone === 'warning' ? 'text-warning' :
    tone === 'info' ? 'text-info' :
    tone === 'destructive' ? 'text-destructive' :
    'text-foreground';
  return (
    <div className="bg-muted/30 border border-border rounded-lg p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground truncate">{label}</div>
      <div className={`text-xl font-bold tabular-nums leading-tight ${toneCls}`}>{value}</div>
    </div>
  );
}

