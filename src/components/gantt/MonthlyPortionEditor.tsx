import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { monthlyPeriodLabel, roundQuantity, type MonthlyAllocations } from '@/lib/physicalFinancialSchedule';

export interface MonthlyPortionRow {
  id: string;
  name: string;
  code: string;
  quantity: number;
  balance: number;
  unit: string;
  allocations: MonthlyAllocations;
  manual: boolean;
}

export default function MonthlyPortionEditor({ row, months, onSave, onClose }: {
  row: MonthlyPortionRow;
  months: string[];
  onSave: (id: string, allocations: MonthlyAllocations | null) => void;
  onClose: () => void;
}) {
  const initial = Object.keys(row.allocations)[0] ?? months[0];
  const [from, setFrom] = useState(initial);
  const [to, setTo] = useState(initial);
  const [mode, setMode] = useState('quantity');
  const [amount, setAmount] = useState(String(row.allocations[initial] ?? 0));
  const [error, setError] = useState('');

  function save(allocations: MonthlyAllocations | null) {
    try { onSave(row.id, allocations); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível preparar a reprogramação.'); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = Number(amount.replace(',', '.'));
    if (!amount.trim() || !Number.isFinite(value) || value < 0) {
      setError('Informe uma quantidade ou percentual válido.');
      return;
    }
    const quantity = roundQuantity(mode === 'percent' ? row.quantity * value / 100 : value);
    const allocations = { ...row.allocations };
    delete allocations[from];
    if (quantity) allocations[to] = roundQuantity((allocations[to] ?? 0) + quantity);
    save(allocations);
  }

  const options = months.map(month => <option key={month} value={month}>{monthlyPeriodLabel(month)}</option>);
  return <form aria-label="Editar parcelas do Gantt" onSubmit={submit} className="mb-3 flex flex-wrap items-end gap-2 rounded-md border bg-card p-3 text-sm">
    <div className="w-full font-semibold">{row.code} {row.name} · saldo {row.balance.toLocaleString('pt-BR')} {row.unit}</div>
    <label className="grid gap-1">Parcela de
      <select className="rounded border bg-background p-2" value={from} onChange={event => {
        setFrom(event.target.value); setTo(event.target.value); setMode('quantity');
        setAmount(String(row.allocations[event.target.value] ?? 0));
      }}>{options}</select>
    </label>
    <label className="grid gap-1">Mês de execução<select className="rounded border bg-background p-2" value={to} onChange={event => setTo(event.target.value)}>{options}</select></label>
    <label className="grid gap-1">Unidade
      <select className="rounded border bg-background p-2" value={mode} onChange={event => {
        const next = event.target.value;
        const current = Number(amount.replace(',', '.'));
        setMode(next);
        setAmount(String(roundQuantity(next === 'percent' ? current / row.quantity * 100 : current * row.quantity / 100)));
      }}><option value="quantity">Quantidade</option><option value="percent">Percentual do contratado</option></select>
    </label>
    <label className="grid gap-1">{mode === 'percent' ? 'Percentual planejado' : 'Quantidade planejada'}
      <input autoFocus className="rounded border bg-background p-2" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} />
    </label>
    <Button type="submit">Prévia de reprogramação</Button>
    {row.balance > 0 && <Button type="button" variant="outline" onClick={() => save({ [to]: row.balance })}>Programar todo o saldo neste mês</Button>}
    {row.manual && <Button type="button" variant="outline" onClick={() => save(null)}>Voltar à sugestão do Gantt</Button>}
    <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
    {error && <span role="alert" className="w-full text-destructive">{error}</span>}
  </form>;
}
