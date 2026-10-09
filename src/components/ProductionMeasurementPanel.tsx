import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Layers3 } from 'lucide-react';
import type { DailyProductionLog } from '@/types/project';
import { recordInMeasurement, type ProductionMeasurementPeriod } from '@/lib/productionMeasurementPeriods';

interface Props {
  periods: ProductionMeasurementPeriod[]; logs: DailyProductionLog[]; unit: string; readOnly: boolean;
  onBegin: (period: ProductionMeasurementPeriod) => void;
  renderDetail: (log: DailyProductionLog, readOnly: boolean, period: boolean) => ReactNode;
}
const fmt = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const date = (iso: string) => iso.split('-').reverse().join('/');
export default function ProductionMeasurementPanel({ periods, logs, unit, readOnly, onBegin, renderDetail }: Props) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const assignedDays = new Set<string>();
  const sections = periods.map(period => {
    const historical = logs.filter(log => !log.measurementPeriod && !assignedDays.has(log.id) && log.date >= period.startDate && log.date <= period.endDate);
    historical.forEach(log => assignedDays.add(log.id));
    return { period, historical, records: logs.filter(log => recordInMeasurement(log, period)) };
  });
  const outside = logs.filter(log => log.measurementPeriod ? !periods.some(p => recordInMeasurement(log, p)) : !assignedDays.has(log.id));
  const history = (items: DailyProductionLog[]) => <details className="px-3 py-2 text-xs text-slate-600"><summary className="cursor-pointer">Histórico preservado · {items.length} registro(s) · {fmt(items.reduce((n, log) => n + log.actualQuantity, 0))} {unit}</summary>{items.map(log => <div key={log.id} className="mt-2 border-t border-slate-200 pt-2"><span>{log.measurementPeriod ? `${log.measurementPeriod.number}ª medição (período não cadastrado)` : date(log.date)} · {fmt(log.actualQuantity)} {unit}{log.notes ? ` · ${log.notes}` : ''}</span>{!!log.quantityDetails?.length && renderDetail(log, true, !!log.measurementPeriod)}</div>)}</details>;
  return <section aria-label="Produção por medição" className="space-y-2">
    {!periods.length && <p className="rounded border border-slate-300 bg-white p-3 text-xs text-slate-600">Defina o número e as datas do período na aba Medição para abrir o detalhe de quantitativos.</p>}
    {sections.map(({ period, historical, records }) => {
      const expanded = !collapsed.includes(period.key);
      const total = [...historical, ...records].reduce((n, log) => n + log.actualQuantity, 0);
      const locked = readOnly || !!period.blockedReason;
      return <section key={period.key} className="overflow-hidden rounded border border-slate-300 bg-white">
        <button type="button" aria-label={`${period.number}ª medição`} aria-expanded={expanded} onClick={() => setCollapsed(ids => expanded ? [...ids, period.key] : ids.filter(id => id !== period.key))} className="flex w-full flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-100 px-3 py-2 text-left text-xs">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}<Layers3 className="h-3.5 w-3.5 text-sky-700" /><strong>{period.number}ª medição</strong><span className="text-[11px] text-slate-500">{date(period.startDate)} a {date(period.endDate)} · Aba Medição</span><strong className="ml-auto tabular-nums" aria-label={`Total da ${period.number}ª medição`}>{fmt(total)} {unit}</strong>
        </button>
        {expanded && <div className="space-y-2 py-2">
          {period.blockedReason && <p className="px-3 text-[11px] text-amber-800">{period.blockedReason}</p>}
          {!!historical.length && <><p className="px-3 text-[11px] text-slate-500">{fmt(historical.reduce((n, log) => n + log.actualQuantity, 0))} {unit} de lançamentos anteriores já incluídos no total desta medição. Novos detalhes somam somente os acréscimos.</p>{history(historical)}</>}
          {records.map(log => <div key={log.id}>{renderDetail(log, locked, true)}</div>)}
          {!records.length && (locked ? <p className="px-3 text-xs text-slate-500">Sem novos quantitativos neste período.</p> : <button type="button" className="ml-3 rounded border border-slate-300 px-2 py-1 text-xs text-sky-800 hover:bg-sky-50" onClick={() => onBegin(period)}>Abrir detalhe de quantitativos</button>)}
        </div>}
      </section>;
    })}
    {!!outside.length && <div className="rounded border border-slate-300 bg-white"><p className="px-3 pt-2 text-[11px] text-slate-500">Registros fora dos períodos cadastrados não foram transferidos ou apagados.</p>{history(outside)}</div>}
  </section>;
}
