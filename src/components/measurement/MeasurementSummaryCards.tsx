import { Card, CardContent } from '@/components/ui/card';
import { fmtBRL, fmtPct } from '@/components/measurement/measurementFormat';
import type { GroupTotals } from '@/components/measurement/types';

interface MeasurementSummaryCardsProps {
  totals: GroupTotals;
  /** Null means unavailable; never invent zero planning for a copied ledger. */
  forecastTotal?: number | null;
}

export default function MeasurementSummaryCards({ totals, forecastTotal }: MeasurementSummaryCardsProps) {
  const forecast = forecastTotal === undefined ? totals.forecast : forecastTotal;
  const diff = forecastTotal === undefined ? totals.diffForecast || 0 : forecast === null ? null : totals.period - forecast;
  const diffTone = diff > 0 ? 'text-success' : diff < 0 ? 'text-destructive' : 'text-foreground';
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <SummaryCard label="Contratado c/ BDI" value={fmtBRL(totals.contracted)} />
        <SummaryCard label="Desta medição" value={fmtBRL(totals.period)} highlight />
        <SummaryCard label="Acumulado" value={fmtBRL(totals.accum)} />
        <SummaryCard label="Saldo a executar" value={fmtBRL(totals.balance)} />
        <SummaryCard label="% desta medição" value={fmtPct(totals.pctPeriod)} />
        <SummaryCard label="% acumulado" value={fmtPct(totals.pctAccum)} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card className="border-info/40 bg-info/5">
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">Previsto no período (Gantt)</p>
            <p data-testid="forecast-period" className="text-sm font-bold mt-1 tabular-nums text-info">{forecast === null ? 'Não disponível' : fmtBRL(forecast)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">Realizado no período</p>
            <p className="text-sm font-bold mt-1 tabular-nums text-foreground">{fmtBRL(totals.period)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">Diferença Real x Previsto</p>
            <p data-testid="forecast-difference" className={`text-sm font-bold mt-1 tabular-nums ${diffTone}`}>{diff === null ? 'Não disponível' : fmtBRL(diff)}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <Card className={highlight ? 'border-primary/40 bg-primary/5' : ''}>
      <CardContent className="p-3">
        <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">{label}</p>
        <p className={`text-sm font-bold mt-1 tabular-nums ${highlight ? 'text-primary' : 'text-foreground'}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
