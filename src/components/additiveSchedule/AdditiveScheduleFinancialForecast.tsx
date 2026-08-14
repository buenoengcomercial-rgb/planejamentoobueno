import { useMemo } from 'react';
import type { AdditiveScheduleSnapshotRow } from '@/types/project';
import { buildAdditiveScheduleForecast } from '@/lib/additiveScheduleForecast';

interface Props {
  rows: AdditiveScheduleSnapshotRow[];
  trabalhaSabado?: boolean;
}

const brl = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function AdditiveScheduleFinancialForecast({ rows, trabalhaSabado = false }: Props) {
  const forecast = useMemo(() => buildAdditiveScheduleForecast(rows, trabalhaSabado), [rows, trabalhaSabado]);
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="border-b border-border bg-secondary/30 px-3 py-2">
        <h3 className="text-sm font-bold text-foreground">Previsão físico-financeira da retomada parcial</h3>
        <p className="text-[11px] text-muted-foreground">Valores do contrato vigente permanecem separados da proposta ainda não contratada.</p>
      </div>
      <div className="grid gap-2 p-3 md:grid-cols-2">
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <div className="text-[10px] font-semibold uppercase text-emerald-800">Contratados liberados</div>
          <div className="mt-1 text-lg font-bold text-emerald-900">{brl(forecast.totalContractedReleased)}</div>
        </div>
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
          <div className="text-[10px] font-semibold uppercase text-rose-800">Proposta não contratada</div>
          <div className="mt-1 text-lg font-bold text-rose-900">{brl(forecast.totalProposed)}</div>
          {forecast.totalOnlyProposed !== 0 && (
            <div className="mt-1 text-[10px] text-rose-800">
              Inclui {brl(forecast.totalOnlyProposed)} sem distribuição mensal.
            </div>
          )}
        </div>
      </div>
      <div className="overflow-x-auto px-3 pb-3">
        <table className="w-full min-w-[680px] text-[11px]">
          <thead className="bg-muted/70 text-muted-foreground">
            <tr>
              <th className="px-2 py-2 text-left">Mês</th>
              <th className="px-2 py-2 text-right">Contratados liberados</th>
              <th className="px-2 py-2 text-right">Proposta não contratada</th>
            </tr>
          </thead>
          <tbody>
            {forecast.months.map(month => (
              <tr key={month.key} className="border-t border-border">
                <td className="px-2 py-2 font-medium">{month.label}</td>
                <td className="px-2 py-2 text-right text-emerald-800">{brl(month.contractedReleased)}</td>
                <td className={`px-2 py-2 text-right font-semibold ${month.proposed < 0 ? 'text-destructive' : 'text-rose-800'}`}>{brl(month.proposed)}</td>
              </tr>
            ))}
            {forecast.totalOnlyProposed !== 0 && (
              <tr className="border-t border-rose-200 bg-rose-50/70">
                <td className="px-2 py-2 font-semibold text-rose-900">Impactos sem distribuição mensal</td>
                <td className="px-2 py-2 text-right text-muted-foreground">—</td>
                <td className={`px-2 py-2 text-right font-bold ${forecast.totalOnlyProposed < 0 ? 'text-destructive' : 'text-rose-800'}`}>
                  {brl(forecast.totalOnlyProposed)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
