import { Fragment, useMemo, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import type { Additive, Project } from '@/types/project';
import type { MeasurementWorkspace } from '@/lib/measurementWorkspace';
import { buildPhysicalFinancialSchedule, isValidMonthlyAllocation, roundQuantity, type MonthlyAllocations } from '@/lib/physicalFinancialSchedule';

type Result = ReturnType<typeof buildPhysicalFinancialSchedule>;
type Row = Result['rows'][number];
type Edit = { id: string; month: string; targetMonth: string; amount: string; mode: 'quantity' | 'percent'; original: string };
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format;
const quantity = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 8 }).format;
const percentage = (part: number, total: number) => total ? `${quantity(roundQuantity(100 * part / total))}%` : '—';
const monthLabel = (month: string) => `${month.slice(5)}/${month.slice(0, 4)}`;

interface Props {
  project: Project;
  measurement: MeasurementWorkspace | null;
  additives: readonly Additive[];
  onSave?: (id: string, allocations: MonthlyAllocations | null) => void;
}

function totals(rows: Row[], months: string[]) {
  return {
    contracted: rows.reduce((sum, row) => sum + row.contractedValue, 0),
    months: months.map(month => rows.reduce((sum, row) => ({
      actual: sum.actual + (row.measured[month]?.value ?? 0),
      planned: sum.planned + (row.planned[month]?.value ?? 0),
    }), { actual: 0, planned: 0 })),
  };
}

export default function PhysicalFinancialGrid({ project, measurement, additives, onSave }: Props) {
  const { rows, months, phases } = useMemo(() => buildPhysicalFinancialSchedule(project, measurement, additives), [project, measurement, additives]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<Edit | null>(null);
  const [drag, setDrag] = useState<{ id: string; month: string; original: string } | null>(null);
  const [error, setError] = useState('');
  const selected = rows.find(row => row.id === edit?.id);
  const summary = useMemo(() => totals(rows, months), [rows, months]);
  const groups = useMemo(() => {
    const nested = new Map(phases.map(phase => [phase.id, phases.filter(child => child.parentId === phase.id)]));
    function visit(phase: Result['phases'][number], depth: number, ancestors: string[] = []): Array<{
      phase: Result['phases'][number]; depth: number; ancestors: string[]; own: Row[]; all: Row[];
    }> {
      if (ancestors.includes(phase.id)) return [];
      const children = (nested.get(phase.id) ?? []).flatMap(child => visit(child, depth + 1, [...ancestors, phase.id]));
      const own = rows.filter(row => row.phaseId === phase.id);
      const all = [...own, ...children.flatMap(child => child.own)];
      return all.length ? [{ phase, depth, ancestors, own, all }, ...children] : [];
    }
    return phases.filter(phase => !phase.parentId || !nested.has(phase.parentId)).flatMap(phase => visit(phase, 0));
  }, [phases, rows]);

  function save(row: Row, next: MonthlyAllocations, original: string) {
    if (!onSave) return false;
    if (original !== JSON.stringify(row.allocations)) {
      setError('A distribuição mudou. Abra a célula novamente para conferir o valor atual.');
      return false;
    }
    if (!isValidMonthlyAllocation(next, row.balance)) {
      setError('A soma das parcelas planejadas deve caber no saldo do serviço.');
      return false;
    }
    try {
      onSave(row.id, next);
      setError('');
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível salvar a distribuição.');
      return false;
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!edit || !selected) return;
    const value = Number(edit.amount.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || !edit.amount.trim()) {
      setError('Informe um valor igual ou maior que zero.');
      return;
    }
    const amount = roundQuantity(edit.mode === 'percent' ? selected.quantity * value / 100 : value);
    const next = { ...selected.allocations };
    delete next[edit.month];
    if (amount) next[edit.targetMonth] = roundQuantity((next[edit.targetMonth] ?? 0) + amount);
    if (save(selected, next, edit.original)) setEdit(null);
  }

  let measuredAccumulated = 0;
  let plannedAccumulated = 0;
  const accumulated = summary.months.map(cell => {
    measuredAccumulated += cell.actual;
    plannedAccumulated += cell.planned;
    return { actual: measuredAccumulated, planned: plannedAccumulated };
  });

  return <section className="min-w-0 space-y-3 p-4" aria-label="Cronograma Físico-Financeiro">
    <h1 className="text-xl font-semibold">Cronograma Físico-Financeiro</h1>
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      <span className="text-emerald-800 dark:text-emerald-400">■ Execução medida</span>
      <span className="text-blue-800 dark:text-blue-400">■ Saldo planejado</span>
      {onSave && <span className="text-muted-foreground">Selecione uma célula para editar ou arraste uma parcela para outro mês.</span>}
    </div>
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    {edit && selected && <form onSubmit={submit} className="flex flex-wrap items-end gap-3 rounded-md border bg-card p-3" aria-label="Editar parcela mensal">
      <div className="w-full text-sm font-medium">{selected.code} {selected.name} · {monthLabel(edit.month)} · saldo {quantity(selected.balance)} {selected.unit}</div>
      <label className="grid gap-1 text-sm">Mês da parcela
        <select className="rounded border bg-background p-2" value={edit.targetMonth} onChange={event => setEdit({ ...edit, targetMonth: event.target.value })}>
          {months.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">Unidade do lançamento
        <select className="rounded border bg-background p-2" value={edit.mode} onChange={event => {
          const mode = event.target.value as Edit['mode'];
          const current = Number(edit.amount.replace(',', '.'));
          const value = mode === 'percent' ? selected.quantity ? 100 * current / selected.quantity : 0 : selected.quantity * current / 100;
          setEdit({ ...edit, mode, amount: String(roundQuantity(value)) });
        }}>
          <option value="quantity">Quantidade ({selected.unit || 'un.'})</option>
          <option value="percent">Percentual do contratado</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm">{edit.mode === 'percent' ? 'Percentual planejado' : 'Quantidade planejada'}
        <input autoFocus inputMode="decimal" className="rounded border bg-background p-2" value={edit.amount} onChange={event => setEdit({ ...edit, amount: event.target.value })} />
      </label>
      <Button type="submit">Salvar parcela</Button>
      {selected.manual && onSave && <Button type="button" variant="outline" onClick={() => {
        if (edit.original !== JSON.stringify(selected.allocations)) {
          setError('A distribuição mudou. Abra a célula novamente para conferir o valor atual.');
          return;
        }
        onSave(selected.id, null);
        setEdit(null);
        setError('');
      }}>Voltar à sugestão do Gantt</Button>}
      <Button type="button" variant="outline" onClick={() => { setEdit(null); setError(''); }}>Cancelar</Button>
    </form>}
    <div className="max-h-[70vh] overflow-auto rounded-md border" tabIndex={0} role="region" aria-label="Grade de distribuição mensal">
      <table className="w-full border-separate border-spacing-0 text-sm tabular-nums">
        <thead className="sticky top-0 z-20 bg-muted text-left"><tr>
          <th className="sticky left-0 min-w-24 bg-muted p-2" scope="col">Item</th>
          <th className="min-w-64 p-2" scope="col">Descrição</th><th className="p-2" scope="col">Un.</th>
          <th className="whitespace-nowrap p-2 text-right" scope="col">Total contratado</th><th className="p-2 text-right" scope="col">Saldo</th>
          {months.map(month => <th className="min-w-28 p-2 text-right" key={month} scope="col">{monthLabel(month)}</th>)}
        </tr></thead>
        <tbody>
          {groups.filter(group => group.ancestors.every(id => !collapsed.has(id))).map(({ phase, depth, all, own }) => {
            const group = totals(all, months);
            return <Fragment key={phase.id}>
              <tr className="bg-muted/70 font-semibold">
                <th colSpan={3} className="border-t p-2 text-left">
                  <button type="button" aria-expanded={!collapsed.has(phase.id)} style={{ paddingLeft: depth * 16 }} onClick={() => setCollapsed(current => {
                    const next = new Set(current);
                    if (next.has(phase.id)) next.delete(phase.id); else next.add(phase.id);
                    return next;
                  })}>{collapsed.has(phase.id) ? '▸' : '▾'} {phase.name}</button>
                </th>
                <td className="whitespace-nowrap border-t p-2 text-right">{currency(group.contracted)}</td><td className="border-t" />
                {group.months.map((cell, index) => <td key={months[index]} className="whitespace-nowrap border-t p-1 text-right">
                  {!!cell.actual && <div className="text-emerald-800 dark:text-emerald-400">{percentage(cell.actual, group.contracted)} · {currency(cell.actual)}</div>}
                  {!!cell.planned && <div className="text-blue-800 dark:text-blue-400">{percentage(cell.planned, group.contracted)} · {currency(cell.planned)}</div>}
                </td>)}
              </tr>
              {!collapsed.has(phase.id) && own.map(row => <tr key={row.id} className="align-top">
                <td className="sticky left-0 z-10 border-t bg-background p-2">{row.code}</td>
                <th scope="row" className="border-t p-2 text-left font-normal">
                  {row.name}
                  {row.exceeds && <div className="text-destructive">Planejamento acima do saldo. Revise as parcelas.</div>}
                  {!!row.discrepancy && <div className="text-amber-700 dark:text-amber-400">Execução a conciliar: {quantity(row.discrepancy)} {row.unit}</div>}
                  {row.excessMeasured && <div className="text-amber-700 dark:text-amber-400">Execução medida acima do contratado.</div>}
                  {!!row.unallocated && <div className="text-muted-foreground">A distribuir: {quantity(row.unallocated)} {row.unit}</div>}
                </th>
                <td className="border-t p-2">{row.unit}</td>
                <td className="whitespace-nowrap border-t p-2 text-right">{currency(row.contractedValue)}</td>
                <td className="whitespace-nowrap border-t p-2 text-right">{quantity(row.balance)}</td>
                {months.map(month => {
                  const actual = row.measured[month], planned = row.planned[month];
                  const editable = !!onSave && (row.balance > 0 || !!planned);
                  const text = planned ? `${percentage(planned.quantity, row.quantity)} · ${currency(planned.value)}` : '—';
                  return <td key={month} className="border-l border-t p-1 text-right" onDragOver={event => {
                    if (editable && drag?.id === row.id && drag.month !== month) event.preventDefault();
                  }} onDrop={event => {
                    event.preventDefault();
                    if (!editable || !drag || drag.id !== row.id || drag.month === month) return;
                    const next = { ...row.allocations };
                    next[month] = roundQuantity((next[month] ?? 0) + (next[drag.month] ?? 0));
                    delete next[drag.month];
                    save(row, next, drag.original);
                    setDrag(null);
                  }}>
                    {actual && <div title={`Medido: ${quantity(actual.quantity)} ${row.unit}`} className="whitespace-nowrap rounded bg-emerald-100 px-1 text-emerald-900">{percentage(actual.quantity, row.quantity)} · {currency(actual.value)}</div>}
                    {editable ? <button type="button" className={`w-full whitespace-nowrap rounded px-1 text-right hover:ring-1 hover:ring-blue-400 ${planned ? 'bg-blue-100 text-blue-900' : 'text-muted-foreground'}`}
                      aria-label={`Editar ${row.code || row.name} em ${monthLabel(month)}`}
                      draggable={!!planned} onDragStart={event => {
                        event.dataTransfer.setData('text/plain', month);
                        setDrag({ id: row.id, month, original: JSON.stringify(row.allocations) });
                      }} onDragEnd={() => setDrag(null)} onClick={() => {
                        setError('');
                        setEdit({ id: row.id, month, targetMonth: month, amount: String(planned?.quantity ?? 0), mode: 'quantity', original: JSON.stringify(row.allocations) });
                      }}>{text}</button> : <span>{planned ? text : ''}</span>}
                  </td>;
                })}
              </tr>)}
            </Fragment>;
          })}
        </tbody>
        <tfoot className="bg-muted font-semibold">
          <Summary label="Medido no mês" values={summary.months.map(cell => cell.actual)} total={summary.contracted} />
          <Summary label="Planejado no mês" values={summary.months.map(cell => cell.planned)} total={summary.contracted} />
          <Summary label="Medido acumulado" values={accumulated.map(cell => cell.actual)} total={summary.contracted} />
          <Summary label="Planejado acumulado" values={accumulated.map(cell => cell.planned)} total={summary.contracted} />
        </tfoot>
      </table>
    </div>
    {!rows.length && <p className="text-sm text-muted-foreground">Nenhum serviço contratual disponível nesta obra.</p>}
  </section>;
}

function Summary({ label, values, total }: { label: string; values: number[]; total: number }) {
  return <tr>
    <th colSpan={3} scope="row" className="border-t p-2 text-left">{label}</th>
    <td className="whitespace-nowrap border-t p-2 text-right">{currency(total)}</td><td className="border-t" />
    {values.map((value, index) => <td key={index} className="whitespace-nowrap border-t p-1 text-right">{percentage(value, total)}<br />{currency(value)}</td>)}
  </tr>;
}

