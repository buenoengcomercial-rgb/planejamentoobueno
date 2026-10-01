import type { ReactNode } from 'react';
import { CalendarDays, FileDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { warehouseOperationalDate } from '@/lib/warehouse';

/** Controles de leitura da consulta diária; as linhas usam a tabela do histórico. */
export default function WarehouseDailyMovements({ date, onDateChange, requisitionCount, deliveredCount, onGenerate, children }: {
  date: string;
  onDateChange: (date: string) => void;
  requisitionCount: number;
  deliveredCount: number;
  onGenerate: () => void;
  children: ReactNode;
}) {
  return <section aria-label="Movimentações do dia" className="min-w-0 space-y-3">
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-end sm:justify-between sm:p-4">
      <div className="min-w-0"><h3 className="flex items-center gap-2 font-semibold"><CalendarDays className="h-4 w-4 text-primary" />Movimentações do dia</h3><p className="mt-1 text-sm text-muted-foreground">{requisitionCount} requisição(ões) com operação nesta data.</p></div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[11rem] flex-1 text-sm font-medium sm:flex-none" htmlFor="daily-withdrawals-date">Data das movimentações<Input id="daily-withdrawals-date" type="date" className="mt-1 min-h-11 text-base" value={date} onChange={event => onDateChange(event.target.value)} /></label>
        <Button type="button" variant="outline" className="min-h-11" onClick={() => onDateChange(warehouseOperationalDate())}>Hoje</Button>
        <Button type="button" variant="outline" className="min-h-11" disabled={!deliveredCount} onClick={onGenerate} title={deliveredCount ? 'Gera PDFs das retiradas entregues nesta data.' : 'Não há retiradas entregues nesta data.'}><FileDown className="mr-1 h-4 w-4" />Gerar PDFs</Button>
      </div>
    </div>
    {requisitionCount > 0 && <p className="px-1 text-xs text-muted-foreground md:hidden">Deslize a tabela para ver todas as colunas. Toque em uma requisição para abrir os detalhes.</p>}
    {children}
  </section>;
}
