import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cloudMeasurementRepository } from '@/lib/measurementCloudRepository';
import type { MeasurementWorkspace } from '@/lib/measurementWorkspace';
import { buildMonthlyExecution } from '@/lib/monthlyExecution';
import { additiveServiceId, approvedAdditiveRows, includeContractedAdditiveTasks, isContractedAdditive, isNewAdditiveTaskLinked } from '@/lib/contractedAdditiveSchedule';
import { discardCloudProjectRecord, loadStableCloudProjectRecord } from '@/lib/cloudProjects';
import type { Additive, Project } from '@/types/project';

const formatQuantity = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 8 }).format;
const formatMonth = (month: string) => `${month.slice(5)}/${month.slice(0, 4)}`;

interface Props {
  project: Project;
  userId?: string;
  independentMeasurementConfirmed: boolean;
  openMeasurement?: () => void;
  openAdditive?: () => void;
  renderGantt: (additives: readonly Additive[], measurement?: MeasurementWorkspace | null) => ReactNode;
}

interface ConfirmedData {
  measurement?: MeasurementWorkspace | null;
  additives?: Additive[];
  measurementError?: boolean;
  additiveError?: boolean;
}

export default function MonthlyExecutionSchedule({
  project, userId, independentMeasurementConfirmed, openMeasurement, openAdditive, renderGantt,
}: Props) {
  const [view, setView] = useState<'monthly' | 'gantt'>('monthly');
  const [read, setRead] = useState(0);
  const [data, setData] = useState<ConfirmedData>({});
  const projectId = project.id;
  const repository = useMemo(() => userId ? cloudMeasurementRepository({ projectId, userId }) : null, [projectId, userId]);
  useEffect(() => {
    let active = true;
    if (!repository) return;
    void (repository.loadForRetry?.() ?? repository.load()).then(workspace => {
      if (repository.loadedOffline?.() || (!workspace && independentMeasurementConfirmed)) throw new Error();
      if (active) setData(current => ({ ...current, measurement: workspace, measurementError: false }));
    }).catch(() => {
      if (active) setData(current => ({ ...current, measurementError: true }));
    });
    void loadStableCloudProjectRecord(projectId, { collections: ['additives'], strict: true }).then(record => {
      if (!record) throw new Error();
      discardCloudProjectRecord(record);
      if (active) setData(current => ({ ...current, additives: record.project.additives ?? [], additiveError: false }));
    }).catch(() => {
      if (active) setData(current => ({ ...current, additiveError: true }));
    });
    return () => { active = false; };
  }, [independentMeasurementConfirmed, projectId, read, repository]);

  const { measurement, additives, measurementError, additiveError } = data;
  const execution = useMemo(() => measurement === undefined || measurementError ? null
    : buildMonthlyExecution(measurement, project), [measurement, measurementError, project]);
  const additiveRows = useMemo(() => {
    const confirmed = additives ?? [];
    const { taskIds } = includeContractedAdditiveTasks(project, confirmed);
    const measured = new Map(measurement?.services.map(service => [service.id, service]));
    const accumulated = new Map(execution?.rows.map(row => [row.id, row.accumulated]));
    return confirmed.filter(additive => additive.status === 'aprovado' || isContractedAdditive(additive)).map(additive => {
      const rows = approvedAdditiveRows(additive);
      return {
        id: additive.id,
        name: additive.name,
        services: rows.filter(({ composition, quantity }) => composition.isNewService && quantity > 0).map(({ composition, quantity }) => {
          const id = additiveServiceId(additive.id, composition.id);
          return {
            id, code: composition.itemNumber || composition.item || composition.code,
            description: composition.description, unit: composition.unit, quantity,
            measurementStart: measured.get(id)?.availableFromNumber,
            contracted: isContractedAdditive(additive),
            scheduled: isContractedAdditive(additive) && isNewAdditiveTaskLinked(taskIds, additive, composition),
          };
        }),
        excesses: rows.flatMap(({ composition, quantity }) => {
          if (composition.isNewService) return [];
          const links = [composition.baseTaskId, composition.taskId, composition.linkedTaskId];
          const serviceId = measurement?.services.find(service => links.includes(service.id)
            || (!!service.sourceTaskId && links.includes(service.sourceTaskId))
            || (!!composition.baseBudgetItemId && service.sourceBudgetId === composition.baseBudgetItemId))?.id;
          const executed = accumulated.get(serviceId ?? links.find(link => !!link && accumulated.has(link)) ?? '') ?? 0;
          return executed - quantity > 1e-8 ? [{
            id: composition.id, code: composition.itemNumber || composition.item, executed, quantity, unit: composition.unit,
          }] : [];
        }),
      };
    });
  }, [additives, execution, measurement, project]);

  const chapters = new Map<string, NonNullable<typeof execution>['rows']>();
  for (const row of execution?.rows ?? []) {
    if (!chapters.has(row.chapter)) chapters.set(row.chapter, []);
    chapters.get(row.chapter)!.push(row);
  }

  return <div className="min-w-0">
    <div role="group" aria-label="Visualização do cronograma" className="flex flex-wrap gap-2 border-b bg-card px-4 py-3">
      <Button type="button" variant={view === 'monthly' ? 'default' : 'outline'} aria-pressed={view === 'monthly'} onClick={() => setView('monthly')}>Cronograma físico-financeiro</Button>
      <Button type="button" variant={view === 'gantt' ? 'default' : 'outline'} aria-pressed={view === 'gantt'} onClick={() => setView('gantt')}>Gantt</Button>
      <Button type="button" variant="ghost" onClick={() => { setData({}); setRead(current => current + 1); }}>Conferir na nuvem</Button>
    </div>
    {(additiveError || measurementError) && <p role="alert" className="px-4 py-3 text-sm text-destructive">
      Não foi possível confirmar {additiveError && measurementError && view === 'monthly' ? 'a Medição e o Aditivo' : additiveError ? 'o Aditivo' : 'a Medição'} na nuvem. Use “Conferir na nuvem” para tentar novamente.
    </p>}
    {view === 'gantt' ? (userId && (measurement === undefined || measurementError) ? <p role="status" className="p-4">Confirme a Medição na nuvem antes de revisar o Gantt.</p> : renderGantt(additiveError ? [] : additives ?? [], measurement)) : <div className="space-y-6 p-4">
      <section aria-label="Execução medida">
        <h2 className="font-semibold">1ª e 2ª medições</h2>
        {!execution && !measurementError && <p role="status" className="py-3 text-sm text-muted-foreground">Conferindo a Medição na nuvem…</p>}
        {execution && [1, 2].filter(number => !execution.loadedPeriods.includes(number)).map(number => <p key={number} role="status" className="py-2 text-sm text-muted-foreground">
          {number}ª medição {execution.invalidPeriods.includes(number) ? 'com período inválido.' : 'ainda não disponível.'}
        </p>)}
        {execution && execution.rows.length === 0 && <p className="py-3 text-sm text-muted-foreground">Nenhum serviço medido nos períodos disponíveis.</p>}
        {!!execution?.rows.length && <>
          <p className="my-2 text-sm text-muted-foreground">Os valores sem registro mensal usam a competência da medição.</p>
          <div className="overflow-x-auto rounded-md border" tabIndex={0} role="region" aria-label="Quantidades por serviço e mês">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left"><tr>
                <th scope="col" className="p-2">Item</th><th scope="col" className="min-w-56 p-2">Serviço</th><th scope="col" className="p-2">Un.</th>
                <th scope="col" className="p-2 text-right">Contratado</th>
                {execution.months.map(month => <th key={month} scope="col" className="min-w-24 p-2 text-right">{formatMonth(month)}</th>)}
                <th scope="col" className="p-2 text-right">Acumulado</th><th scope="col" className="p-2 text-right">Saldo</th><th scope="col" className="p-2">Situação</th>
              </tr></thead>
              {[...chapters].map(([chapter, rows]) => <tbody key={chapter}>
                <tr className="border-t bg-muted/50"><th scope="rowgroup" colSpan={7 + execution.months.length} className="p-2 text-left">{chapter || 'Sem etapa'}</th></tr>
                {rows.map(row => <tr key={row.id} className="border-t align-top">
                  <td className="p-2">{row.code}</td><th scope="row" className="p-2 text-left font-medium">{row.description}</th><td className="p-2">{row.unit}</td>
                  <td className="p-2 text-right tabular-nums">{formatQuantity(row.contracted)}</td>
                  {execution.months.map(month => {
                    const cell = row.months[month];
                    return <td key={month} className="p-2 text-right tabular-nums">{cell ? <>
                      {formatQuantity(cell.quantity)}
                      {(cell.competence > 0 || cell.discrepancy) && <div className="text-xs text-muted-foreground">Competência da medição{cell.competence < cell.quantity - 1e-8 ? ` · ${formatQuantity(cell.competence)}` : ''}</div>}
                      {cell.discrepancy && <div className="text-xs text-destructive">Conferir detalhe</div>}
                    </> : '—'}</td>;
                  })}
                  <td className="p-2 text-right tabular-nums">{formatQuantity(row.accumulated)}</td><td className="p-2 text-right tabular-nums">{formatQuantity(row.balance)}</td>
                  <td className="p-2">{row.balance > 1e-8 ? 'Parcial' : 'Concluído pelo quantitativo medido'}</td>
                </tr>)}
              </tbody>)}
            </table>
          </div>
        </>}
      </section>
      <section aria-label="Aditivo a partir da 3ª medição">
        <h2 className="font-semibold">Aditivo — a partir da 3ª medição</h2>
        {!additives && !additiveError && <p role="status" className="py-3 text-sm text-muted-foreground">Conferindo o Aditivo na nuvem…</p>}
        {additives && !additiveRows.some(group => group.services.length || group.excesses.length) && <p className="py-3 text-sm text-muted-foreground">Nenhum serviço novo aprovado ou excedente identificado.</p>}
        {additiveRows.some(group => group.services.length > 0) && <div className="my-2 flex flex-wrap gap-2">
          {openMeasurement && <Button type="button" variant="outline" onClick={openMeasurement}>Abrir Medição</Button>}
          {openAdditive && <Button type="button" variant="outline" onClick={openAdditive}>Abrir Aditivo</Button>}
        </div>}
        {additiveRows.map(group => <Fragment key={group.id}>
          {!!group.services.length && <div className="mb-4 overflow-x-auto rounded-md border" tabIndex={0} role="region" aria-label={group.name}>
            <table className="w-full text-sm">
              <caption className="bg-muted/50 p-2 text-left font-medium">{group.name}</caption>
              <thead className="border-t text-left"><tr>{['Item', 'Serviço', 'Quantidade', '1ª medição', '2ª medição', 'Medição', 'Gantt'].map(label => <th key={label} scope="col" className="p-2">{label}</th>)}</tr></thead>
              <tbody>{group.services.map(service => <tr key={service.id} className="border-t align-top">
                <td className="p-2">{service.code}</td><th scope="row" className="min-w-56 p-2 text-left font-medium">{service.description}</th>
                <td className="p-2">{formatQuantity(service.quantity)} {service.unit}</td><td className="p-2" /><td className="p-2" />
                <td className="p-2">{measurement === undefined || measurementError ? 'A confirmar'
                  : service.measurementStart ? `Incorporado · ${service.measurementStart}ª medição` : 'Pendente · Incorporar na Medição'}</td>
                <td className="p-2">{service.scheduled ? 'Integrado' : service.contracted
                  ? 'Vínculo a conferir no Cronograma do Aditivo' : 'Pendente de integração · Integrar ao Projeto em Aditivo'}</td>
              </tr>)}</tbody>
            </table>
          </div>}
          {!!group.excesses.length && <ul className="my-2 space-y-1 text-sm text-destructive">
            {group.excesses.map(item => <li key={item.id}>Item {item.code} · {formatQuantity(item.executed)} {item.unit} já medidos de {formatQuantity(item.quantity)} {item.unit} após o aditivo. Revisão fiscal necessária.</li>)}
          </ul>}
        </Fragment>)}
      </section>
    </div>}
  </div>;
}
