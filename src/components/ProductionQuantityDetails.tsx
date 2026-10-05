import type { ProductionQuantityDetail } from '@/types/project';
import { detailPartial, detailTotal } from '@/lib/productionQuantityDetails';
import { FileSearch2, Plus, Trash2 } from 'lucide-react';

interface Props {
  rows: ProductionQuantityDetail[];
  unit: string;
  dailyQuantity: number;
  applied: boolean;
  readOnly: boolean;
  onAdd: () => void;
  onEdit: (id: string, changes: Partial<ProductionQuantityDetail>) => void;
  onDelete: (id: string) => void;
  onOpenPlan: (id: string, field: 'multiplier' | 'measuredQuantity') => void;
  onApply: () => void;
}

const fmt = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 3 });

export default function ProductionQuantityDetails({ rows, unit, dailyQuantity, applied, readOnly, onAdd, onEdit, onDelete, onOpenPlan, onApply }: Props) {
  const total = detailTotal(rows);
  const field = (row: ProductionQuantityDetail, key: 'location' | 'comment', label: string) => (
    <input key={`${row.id}-${key}-${row[key]}`} aria-label={`${label} da linha ${rows.indexOf(row) + 1}`} defaultValue={row[key]}
      disabled={readOnly} onBlur={event => { if (event.target.value !== row[key]) onEdit(row.id, { [key]: event.target.value }); }}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      className="h-7 w-full min-w-24 border border-slate-300 bg-white px-1.5 text-xs focus:border-sky-500 focus:outline-none disabled:bg-slate-50" />
  );
  const numberField = (row: ProductionQuantityDetail, key: 'multiplier' | 'measuredQuantity', label: string, column: 'A' | 'B') => (
    <div className="flex items-center justify-end gap-0.5">
      <input key={`${row.id}-${key}-${row[key]}`} aria-label={`${label} da linha ${rows.indexOf(row) + 1}`} type="number" min="0" step="any" defaultValue={row[key]}
        disabled={readOnly} onBlur={event => { const value = Number(event.target.value.replace(',', '.')); if (event.target.value !== '' && Number.isFinite(value) && value >= 0 && value !== row[key]) onEdit(row.id, { [key]: value, [key === 'multiplier' ? 'multiplierSource' : 'source']: undefined }); else if (event.target.value === '' || !Number.isFinite(value) || value < 0) event.target.value = String(row[key]); }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
        className="h-7 w-16 border border-slate-300 bg-white px-1.5 text-right text-xs tabular-nums focus:border-sky-500 focus:outline-none disabled:bg-slate-50" />
      <button type="button" disabled={readOnly} onClick={() => onOpenPlan(row.id, key)} aria-label={`Levantar coluna ${column} da linha ${rows.indexOf(row) + 1} na planta`} title={`Preencher ${column} pela planta`} className="flex h-7 w-7 items-center justify-center border border-slate-300 bg-slate-50 hover:bg-sky-50 disabled:opacity-50"><FileSearch2 className="h-3.5 w-3.5" /></button>
    </div>
  );

  return <section aria-label="Detalhe de quantitativo" className="ml-2 overflow-hidden border border-slate-300 bg-white text-slate-800 sm:ml-8">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-300 bg-slate-100 px-2 py-1">
      <strong className="text-xs">Detalhe de quantitativo</strong>
      <span className="text-[11px] text-slate-600">Dia: {fmt(dailyQuantity)} {unit} · Detalhe: {fmt(total)} {unit} {rows.length > 0 && <strong className={applied ? 'text-green-700' : 'text-amber-700'}>· {applied ? 'Aplicado ao dia' : 'Pendente de aplicação'}</strong>}</span>
    </div>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[750px] border-collapse text-xs">
        <thead className="bg-slate-50 text-slate-600"><tr>
          <th className="border-b border-r px-2 py-1 text-left">Loc.</th><th className="border-b border-r px-2 py-1 text-left">Comentário</th>
          <th className="border-b border-r px-2 py-1 text-right">A · Uds.</th><th className="border-b border-r px-2 py-1 text-right">B · Medida ({unit})</th>
          <th className="border-b border-r px-2 py-1 text-right">Parcial ({unit})</th><th className="border-b px-2 py-1 text-left">Origem / ações</th>
        </tr></thead>
        <tbody>{rows.map((row, index) => <tr key={row.id} className="border-b border-slate-200">
          <td className="p-1">{field(row, 'location', 'Local')}</td><td className="p-1">{field(row, 'comment', 'Comentário')}</td>
          <td className="p-1 text-right">{numberField(row, 'multiplier', 'Unidades', 'A')}</td><td className="p-1 text-right">{numberField(row, 'measuredQuantity', 'Medida', 'B')}</td>
          <td className="px-2 text-right font-medium tabular-nums">{fmt(detailPartial(row))}</td>
          <td className="whitespace-nowrap px-1"><div className="flex items-center gap-1">
            {(['multiplierSource', 'source'] as const).map((key, sourceIndex) => row[key] && <span key={key} title={`${row[key]!.planName} · página ${row[key]!.page} · ${row[key]!.measureName} · ${row[key]!.points.length} ponto(s) registrados na coluna ${sourceIndex === 0 ? 'A' : 'B'}. O arquivo original fica neste navegador.`} className="max-w-36 truncate text-[10px] text-slate-500">{sourceIndex === 0 ? 'A' : 'B'}: {row[key]!.planName} · {row[key]!.points.length} pt.</span>)}
            {!readOnly && <button type="button" onClick={() => onDelete(row.id)} aria-label={`Excluir linha ${index + 1}`} title="Excluir linha" className="p-1 text-red-700 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" /></button>}
          </div></td>
        </tr>)}</tbody>
        <tfoot><tr className="bg-slate-100 font-semibold"><td colSpan={4} className="px-2 py-1 text-right">Total do detalhe</td><td className="px-2 py-1 text-right tabular-nums">{fmt(total)}</td><td className="px-2 py-1">{unit}</td></tr></tfoot>
      </table>
    </div>
    <div className="flex flex-wrap items-center gap-2 p-2">
      {!readOnly && <button type="button" onClick={onAdd} className="inline-flex h-8 items-center gap-1 border border-slate-300 bg-white px-2 text-xs hover:bg-slate-50"><Plus className="h-3.5 w-3.5" /> Linha</button>}
      {!readOnly && <button type="button" onClick={onApply} disabled={!rows.length} className="h-8 bg-sky-700 px-3 text-xs font-medium text-white hover:bg-sky-800 disabled:opacity-50">Usar total no realizado do dia</button>}
      <span className="text-[11px] text-slate-500">A × B = parcial. A quantidade do dia muda somente ao usar o total.</span>
    </div>
  </section>;
}
