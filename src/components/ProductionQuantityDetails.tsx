import type { ProductionQuantityDetail } from '@/types/project';
import { canChangeDetailFormula, detailFormula, detailPartial, detailTotal, formulasForUnit, formulaFields, measureMatchesDetailCell, withDetailFormula, withDetailValue, type DetailField, type DetailFormula } from '@/lib/productionQuantityDetails';
import { FileSearch2, Plus, Trash2 } from 'lucide-react';

interface Props {
  rows: ProductionQuantityDetail[];
  unit: string;
  dailyQuantity: number;
  applied: boolean;
  readOnly: boolean;
  onAdd: () => void;
  onEdit: (id: string, changes: Partial<ProductionQuantityDetail>) => boolean;
  onDelete: (id: string) => void;
  onOpenPlan: (id: string, field: DetailField) => void;
  onApply: () => void;
}

const fmt = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const formulaLabel: Record<DetailFormula, string> = { 'A*B': 'A × B', 'A*B*C': 'A × B × C', 'A*B*C*D': 'A × B × C × D' };

function formulaMeaning(formula: DetailFormula, unit: string): string {
  if (formula === 'A*B*C') return 'A uds. · B comprimento (m) · C largura (m)';
  if (formula === 'A*B*C*D') return 'A uds. · B comprimento (m) · C largura (m) · D altura (m)';
  const normalized = unit.trim().toLowerCase().replace(/²/g, '2').replace(/³/g, '3');
  const measure = normalized === 'm2' ? 'área' : normalized === 'm3' ? 'volume' : normalized === 'm' || normalized === 'ml' ? 'comprimento' : 'quantidade';
  return `A uds. · B ${measure} (${unit})`;
}

export default function ProductionQuantityDetails({ rows, unit, dailyQuantity, applied, readOnly, onAdd, onEdit, onDelete, onOpenPlan, onApply }: Props) {
  const total = detailTotal(rows);
  const formulas = formulasForUnit(unit);
  const sameFormula = rows.length === 0 ? 'A*B' : rows.every(row => detailFormula(row) === detailFormula(rows[0])) ? detailFormula(rows[0]) : null;
  const normalizedUnit = unit.trim().toLowerCase().replace(/²/g, '2').replace(/³/g, '3');
  const bHeading = sameFormula === 'A*B*C' || sameFormula === 'A*B*C*D' ? 'B · Compr. (m)'
    : sameFormula === 'A*B' && normalizedUnit === 'm2' ? 'B · Área (m²)'
      : sameFormula === 'A*B' && normalizedUnit === 'm3' ? 'B · Volume (m³)'
        : sameFormula === 'A*B' && ['m', 'ml'].includes(normalizedUnit) ? 'B · Compr. (m)'
          : sameFormula === 'A*B' ? `B · Quant. (${unit})` : 'B · Medida';
  const hasC = rows.some(row => formulaFields(detailFormula(row)).includes('dimensionC'));
  const hasD = rows.some(row => formulaFields(detailFormula(row)).includes('dimensionD'));
  let running = 0;
  const subtotals = rows.map(row => (running += detailPartial(row)));

  const textField = (row: ProductionQuantityDetail, index: number, key: 'location' | 'comment', label: string) => (
    <input key={`${row.id}-${key}-${row[key]}`} aria-label={`${label} da linha ${index + 1}`} defaultValue={row[key]}
      disabled={readOnly} onBlur={event => { if (event.target.value !== row[key] && !onEdit(row.id, { [key]: event.target.value })) event.target.value = row[key]; }}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      className="h-7 w-full min-w-0 border border-slate-300 bg-white px-1.5 text-xs focus:border-sky-500 focus:outline-none disabled:bg-slate-50" />
  );

  const numberField = (row: ProductionQuantityDetail, index: number, key: DetailField) => {
    if (!formulaFields(detailFormula(row)).includes(key)) return <span title="Fora da fórmula desta linha" className="px-2 text-slate-400">—</span>;
    const column = key === 'multiplier' ? 'A' : key === 'measuredQuantity' ? 'B' : key === 'dimensionC' ? 'C' : 'D';
    const label = key === 'multiplier' ? 'Unidades' : key === 'measuredQuantity' ? 'Medida' : key === 'dimensionC' ? 'Largura' : 'Altura';
    const neutral = row.neutralFactors?.includes(key) || row.neutralFactor === key;
    return <div className="flex items-center justify-end gap-0.5">
      <input key={`${row.id}-${key}-${row[key] ?? 0}`} aria-label={`${label} da linha ${index + 1}`} type="number" min="0" step="any" defaultValue={row[key] ?? 0}
        disabled={readOnly} onBlur={event => {
          const value = Number(event.target.value.replace(',', '.'));
          if (event.target.value !== '' && Number.isFinite(value) && value >= 0 && value !== (row[key] ?? 0)) {
            const edited = withDetailValue(row, key, value);
            const sourceField = key === 'multiplier' ? 'multiplierSource' : key === 'measuredQuantity' ? 'source' : key === 'dimensionC' ? 'dimensionCSource' : 'dimensionDSource';
            if (!onEdit(row.id, { ...edited, [sourceField]: undefined })) event.target.value = String(row[key] ?? 0);
          } else if (event.target.value === '' || !Number.isFinite(value) || value < 0) event.target.value = String(row[key] ?? 0);
        }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
        className="h-7 w-16 border border-slate-300 bg-white px-1.5 text-right text-xs tabular-nums focus:border-sky-500 focus:outline-none disabled:bg-slate-50" />
      <button type="button" disabled={readOnly || !(['count', 'length', 'area'] as const).some(kind => measureMatchesDetailCell(kind, key, row, unit))} onClick={() => onOpenPlan(row.id, key)} aria-label={`Levantar coluna ${column} da linha ${index + 1} na planta`} title={`Preencher ${column} pela planta`} className="flex h-7 w-7 items-center justify-center border border-slate-300 bg-slate-50 hover:bg-sky-50 disabled:opacity-50"><FileSearch2 className="h-3.5 w-3.5" /></button>
      {neutral && <span title="Fator neutro inserido automaticamente; pode ser editado" className="whitespace-nowrap text-[9px] text-slate-500">1 neutro</span>}
    </div>;
  };

  return <section aria-label="Detalhe de quantitativo" className="ml-2 overflow-hidden border border-slate-300 bg-white text-slate-800 sm:ml-8">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-300 bg-slate-100 px-2 py-1">
      <strong className="text-xs">Detalhe de quantitativo</strong>
      <span className="text-[11px] text-slate-600">Dia: {fmt(dailyQuantity)} {unit} · Subtotal: {fmt(total)} {unit} {rows.length > 0 && <strong className={applied ? 'text-green-700' : 'text-amber-700'}>· {applied ? 'Aplicado ao dia' : 'Pendente de aplicação'}</strong>}</span>
    </div>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1000px] border-collapse text-xs">
        <thead className="bg-slate-50 text-slate-600"><tr>
          <th className="border-b border-r px-2 py-1 text-left">Loc.</th><th className="border-b border-r px-2 py-1 text-left">Comentário</th><th className="border-b border-r px-2 py-1 text-left">Fórmula</th>
          <th className="border-b border-r px-2 py-1 text-right">A · Uds.</th><th className="border-b border-r px-2 py-1 text-right">{bHeading}</th>
          <th className="border-b border-r px-2 py-1 text-right">{hasC ? 'C · Largura (m)' : 'C'}</th><th className="border-b border-r px-2 py-1 text-right">{hasD ? 'D · Altura (m)' : 'D'}</th>
          <th className="border-b border-r px-2 py-1 text-right">Parcial ({unit})</th><th className="border-b px-2 py-1 text-right">Subtotal ({unit})</th>
        </tr></thead>
        <tbody>{rows.map((row, index) => { const rowFormulas = formulas.includes(detailFormula(row)) ? formulas : [detailFormula(row), ...formulas]; return <tr key={row.id} className="border-b border-slate-200 align-top">
          <td className="w-28 p-1"><div className="flex items-center gap-0.5">{textField(row, index, 'location', 'Local')}{!readOnly && <button type="button" onClick={() => onDelete(row.id)} aria-label={`Excluir linha ${index + 1}`} title="Excluir linha" className="p-1 text-red-700 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" /></button>}</div></td>
          <td className="min-w-44 p-1">{textField(row, index, 'comment', 'Comentário')}{(['multiplierSource', 'source', 'dimensionCSource', 'dimensionDSource'] as const).map((key, sourceIndex) => row[key] && <span key={key} title={`${row[key]!.planName} · página ${row[key]!.page} · ${row[key]!.measureName} · ${row[key]!.points.length} ponto(s) registrados na coluna ${'ABCD'[sourceIndex]}. O arquivo original fica neste navegador.`} className="mr-1 block max-w-48 truncate text-[9px] text-slate-500">{'ABCD'[sourceIndex]}: {row[key]!.planName} · {row[key]!.points.length} pt.</span>)}</td>
          <td className="w-36 p-1"><select aria-label={`Fórmula da linha ${index + 1}`} value={detailFormula(row)} disabled={readOnly || rowFormulas.length === 1} onChange={event => { if (!onEdit(row.id, withDetailFormula(row, event.target.value as DetailFormula))) event.target.value = detailFormula(row); }} className="h-7 w-full border border-slate-300 bg-white px-1 text-xs disabled:bg-slate-50">{rowFormulas.map(formula => <option key={formula} value={formula} disabled={!canChangeDetailFormula(row, formula, unit)}>{formulaLabel[formula]}</option>)}</select><span className="block max-w-36 text-[9px] leading-tight text-slate-500">{formulaMeaning(detailFormula(row), unit)}</span></td>
          <td className="p-1 text-right">{numberField(row, index, 'multiplier')}</td><td className="p-1 text-right">{numberField(row, index, 'measuredQuantity')}</td>
          <td className="p-1 text-right">{numberField(row, index, 'dimensionC')}</td><td className="p-1 text-right">{numberField(row, index, 'dimensionD')}</td>
          <td className="px-2 py-2 text-right font-medium tabular-nums">{fmt(detailPartial(row))}</td><td className="px-2 py-2 text-right font-semibold tabular-nums">{fmt(subtotals[index])}</td>
        </tr>; })}</tbody>
        <tfoot><tr className="bg-slate-100 font-semibold"><td colSpan={8} className="px-2 py-1 text-right">Total do detalhe</td><td className="px-2 py-1 text-right tabular-nums">{fmt(total)} {unit}</td></tr></tfoot>
      </table>
    </div>
    <div className="flex flex-wrap items-center gap-2 p-2">
      {!readOnly && <button type="button" onClick={onAdd} className="inline-flex h-8 items-center gap-1 border border-slate-300 bg-white px-2 text-xs hover:bg-slate-50"><Plus className="h-3.5 w-3.5" /> Linha</button>}
      {!readOnly && total > 0 && !applied && <button type="button" onClick={onApply} className="h-8 bg-sky-700 px-3 text-xs font-medium text-white hover:bg-sky-800">Atualizar realizado pelo detalhe</button>}
      <span className="text-[11px] text-slate-500">O parcial segue a fórmula da linha; os parciais formam o subtotal do dia. Fatores neutros aparecem como 1.</span>
    </div>
  </section>;
}
