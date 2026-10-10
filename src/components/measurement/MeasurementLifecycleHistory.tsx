import type { MeasurementAudit } from '@/lib/measurementWorkspace';
import { detailTotal } from '@/lib/productionQuantityDetails';
import { fmtNum } from './measurementFormat';
export default function MeasurementLifecycleHistory({ event }: { event: MeasurementAudit }) {
  const snapshots = event.lifecycle ? event.beforePeriods?.filter(p => p.id === event.lifecycle?.measurementId && p.frozen) ?? [] : event.afterPeriods?.filter(p => p.frozen && JSON.stringify(p) !== JSON.stringify(event.beforePeriods?.find(old => old.id === p.id))) ?? [];
  return <div className="my-2">
    {event.lifecycle && <p>Motivo: {event.lifecycle.reason}</p>}
    {snapshots.map(period => <details key={period.id} className="mt-2"><summary>Versão {period.status === 'approved' ? 'aprovada' : 'enviada'} preservada · {period.number}ª medição</summary>
      <table className="mt-2 w-full"><thead><tr><th>Item</th><th>Serviço</th><th>Quantidade</th><th>Acumulado</th></tr></thead><tbody>{period.frozen!.filter(l => l.qty || l.accumulated).map(l => <tr key={l.service.id}><td>{l.service.item}</td><td>{l.service.description}</td><td>{fmtNum(l.qty)}</td><td>{fmtNum(l.accumulated)}</td></tr>)}</tbody></table>
    </details>)}
    {event.lifecycle?.kind === 'delete' && event.before.map(e => <details key={e.serviceId} className="mt-2"><summary>Quantitativos preservados · {e.serviceId} · Total {fmtNum(detailTotal(e.rows))}</summary>{e.rows.map(r => <p key={r.id}>{r.comment || 'Sem comentário'} · A {fmtNum(r.multiplier)} · B {fmtNum(r.measuredQuantity)} · C {fmtNum(r.dimensionC ?? 0)} · D {fmtNum(r.dimensionD ?? 0)}</p>)}</details>)}
  </div>;
}
