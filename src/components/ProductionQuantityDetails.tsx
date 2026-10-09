import type { ProductionQuantityDetail } from '@/types/project';
import { canChangeDetailFormula, detailFormula, detailPartial, detailTotal, formulasForUnit, formulaFields, isBlankDetailRow, measureMatchesDetailCell, withDetailFormula, withDetailValue, type DetailField, type DetailFormula } from '@/lib/productionQuantityDetails';
import { MEASURE_KINDS } from '@/lib/planTakeoff';
import type { QuantityClipboard, QuantityClipboardMode } from '@/lib/productionQuantityReferences';
import { useState } from 'react';
import { ClipboardPaste, Copy, FileSearch2, Link2, Scissors, Trash2 } from 'lucide-react';

interface Props {
  rows: ProductionQuantityDetail[];
  unit: string;
  dailyQuantity: number;
  applied: boolean;
  readOnly: boolean;
  periodMode?: boolean;
  onCreate: (changes: Partial<ProductionQuantityDetail>) => string | null;
  onEdit: (id: string, changes: Partial<ProductionQuantityDetail>) => boolean;
  onDelete: (id: string) => void;
  onOpenPlan: (id: string, field: DetailField) => void;
  onApply: () => void;
  canOpenPlan?: boolean;
  clipboard?: QuantityClipboard | null;
  onCopy?: (mode: QuantityClipboardMode, row: ProductionQuantityDetail) => void;
  onPaste?: (afterRowId?: string) => void;
  sharedTaskNames?: (recordId: string) => string[];
  onOpenHistory?: (recordId: string) => void;
}

const fmt = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const formulaLabel: Record<DetailFormula, string> = { STANDARD: 'Padrão', 'A*B': 'A × B', 'A*B*C': 'A × B × C', 'A*B*C*D': 'A × B × C × D' };
const blankRow: ProductionQuantityDetail = { id: '__new__', location: '', comment: '', formula: 'STANDARD', multiplier: 0, measuredQuantity: 0, dimensionC: 0, dimensionD: 0 };

function formulaMeaning(formula: DetailFormula, unit: string): string {
  if (formula === 'STANDARD') return 'Standard: multiplica os valores informados em A, B, C e D; campos zerados não entram no parcial';
  if (formula === 'A*B*C') return 'A uds. · B comprimento (m) · C largura (m)';
  if (formula === 'A*B*C*D') return 'A uds. · B comprimento (m) · C largura (m) · D altura (m)';
  const normalized = unit.trim().toLowerCase().replace(/²/g, '2').replace(/³/g, '3');
  const measure = normalized === 'm2' ? 'área' : normalized === 'm3' ? 'volume' : normalized === 'm' || normalized === 'ml' ? 'comprimento' : 'quantidade';
  return `A uds. · B ${measure} (${unit})`;
}

export default function ProductionQuantityDetails({ rows, unit, dailyQuantity, applied, readOnly, periodMode = false, onCreate, onEdit, onDelete, onOpenPlan, onApply, canOpenPlan = false, clipboard, onCopy, onPaste, sharedTaskNames, onOpenHistory }: Props) {
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [selectedField, setSelectedField] = useState<DetailField | null>(null);
  const [linkedInfo, setLinkedInfo] = useState<string | null>(null);
  const total = detailTotal(rows);
  const displayRows = !readOnly && (rows.length === 0 || !isBlankDetailRow(rows[rows.length - 1])) ? [...rows, blankRow] : rows;
  const formulas = formulasForUnit(unit);
  const sameFormula = rows.length === 0 ? 'STANDARD' : rows.every(row => detailFormula(row) === detailFormula(rows[0])) ? detailFormula(rows[0]) : null;
  const normalizedUnit = unit.trim().toLowerCase().replace(/²/g, '2').replace(/³/g, '3');
  const bHeading = sameFormula === 'STANDARD' && ['un', 'und', 'unid', 'unidade', 'unidades', 'pç', 'pc'].includes(normalizedUnit) ? `Quant. (${unit})`
    : sameFormula === 'STANDARD' || sameFormula === 'A*B*C' || sameFormula === 'A*B*C*D' ? 'Compr. (m)'
    : sameFormula === 'A*B' && normalizedUnit === 'm2' ? 'Área (m²)'
      : sameFormula === 'A*B' && normalizedUnit === 'm3' ? 'Volume (m³)'
        : sameFormula === 'A*B' && ['m', 'ml'].includes(normalizedUnit) ? 'Compr. (m)'
          : sameFormula === 'A*B' ? `Quant. (${unit})` : 'Medida';
  const hasC = displayRows.some(row => formulaFields(detailFormula(row)).includes('dimensionC'));
  const hasD = displayRows.some(row => formulaFields(detailFormula(row)).includes('dimensionD'));
  const hasNeutralFactor = rows.some(row => (row.neutralFactors?.length ?? 0) > 0 || !!row.neutralFactor);
  let running = 0;
  const subtotals = rows.map(row => (running += detailPartial(row)));
  const selectedRow = displayRows.find(row => row.id === selectedRowId);
  const selectedExisting = selectedRow && selectedRow.id !== blankRow.id ? selectedRow : null;
  const buttonStyle = 'relative flex h-5 w-6 shrink-0 items-center justify-center border border-transparent text-slate-700 hover:border-slate-300 hover:bg-white disabled:cursor-not-allowed disabled:opacity-35';

  const openSelectedPlan = () => {
    if (!selectedRow || !selectedField || !canOpenPlan || readOnly) return;
    const id = selectedRow.id === blankRow.id ? onCreate({}) : selectedRow.id;
    if (id) { setSelectedRowId(id); onOpenPlan(id, selectedField); }
  };

  const saveRow = (row: ProductionQuantityDetail, changes: Partial<ProductionQuantityDetail>): boolean => {
    if (row.id !== blankRow.id) return onEdit(row.id, changes);
    const id = onCreate(changes);
    if (id) setSelectedRowId(id);
    return id !== null;
  };

  const textField = (row: ProductionQuantityDetail, index: number) => (
    <input key={`${row.id}-comment-${row.comment}`} aria-label={`Comentário da linha ${index + 1}`} defaultValue={row.comment}
      disabled={readOnly} onFocus={() => setSelectedRowId(row.id)} onBlur={event => { if (event.target.value !== row.comment && !saveRow(row, { comment: event.target.value })) event.target.value = row.comment; }}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      className="h-5 w-full min-w-0 border border-slate-300 bg-white px-1 text-[11px] focus:border-sky-500 focus:outline-none disabled:bg-slate-50" />
  );

  const numberField = (row: ProductionQuantityDetail, index: number, key: DetailField) => {
    const activeInFormula = formulaFields(detailFormula(row)).includes(key);
    const column = key === 'multiplier' ? 'A' : key === 'measuredQuantity' ? 'B' : key === 'dimensionC' ? 'C' : 'D';
    const label = key === 'multiplier' ? 'Unidades' : key === 'measuredQuantity' ? 'Medida' : key === 'dimensionC' ? 'Largura' : 'Altura';
    const neutral = row.neutralFactors?.includes(key) || row.neutralFactor === key;
    const canUsePlan = MEASURE_KINDS.some(kind => measureMatchesDetailCell(kind, key, row, unit));
    const source = key === 'multiplier' ? row.multiplierSource : key === 'measuredQuantity' ? row.source : key === 'dimensionC' ? row.dimensionCSource : row.dimensionDSource;
    const drawingUnit = source?.resultUnit?.startsWith('u.d.') ? source.resultUnit : null;
    const shownValue = Number((row[key] ?? 0).toFixed(4));
    return <div className="flex items-center justify-end gap-0.5 whitespace-nowrap">
      <input key={`${row.id}-${key}-${row[key] ?? 0}`} aria-label={`${label} da linha ${index + 1}`} type="number" inputMode="decimal" min="0" step="any" defaultValue={shownValue}
        title={activeInFormula ? `Coluna ${column} participa de ${formulaLabel[detailFormula(row)]}` : `Coluna ${column} fora de ${formulaLabel[detailFormula(row)]}: o valor fica registrado, mas não altera o parcial`}
        disabled={readOnly} onFocus={() => { setSelectedRowId(row.id); setSelectedField(key); }} onBlur={event => {
          const value = Number(event.target.value.replace(',', '.'));
          if (event.target.value !== '' && Number.isFinite(value) && value >= 0 && value !== shownValue) {
            const edited = withDetailValue(row, key, value);
            const sourceField = key === 'multiplier' ? 'multiplierSource' : key === 'measuredQuantity' ? 'source' : key === 'dimensionC' ? 'dimensionCSource' : 'dimensionDSource';
            if (!saveRow(row, { ...edited, [sourceField]: undefined })) event.target.value = String(shownValue);
          } else if (event.target.value === '' || !Number.isFinite(value) || value < 0) event.target.value = String(shownValue);
        }}
        onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') event.preventDefault(); else if (event.key === 'Enter') event.currentTarget.blur(); }}
        onWheel={event => event.currentTarget.blur()}
        className={`no-spinner h-5 min-w-0 border border-slate-300 bg-white px-1 text-right text-[11px] tabular-nums focus:border-sky-500 focus:outline-none disabled:bg-slate-50 ${canUsePlan ? 'w-[50px]' : 'w-full'}`} />
      {canUsePlan && <button type="button" disabled={readOnly} onClick={() => {
        const rowId = row.id === blankRow.id ? onCreate({}) : row.id;
        if (rowId) { setSelectedRowId(rowId); setSelectedField(key); onOpenPlan(rowId, key); }
      }} aria-label={`Levantar coluna ${column} da linha ${index + 1} na planta`} title={`Preencher ${column} pela planta`} className="flex h-5 w-5 shrink-0 items-center justify-center border border-slate-300 bg-slate-50 hover:bg-sky-50 disabled:opacity-50"><FileSearch2 className="h-3 w-3" /></button>}
      {drawingUnit && <span title="Valor em unidades do desenho; a planta não tem escala em metros definida" className="text-[9px] font-medium text-amber-800">{drawingUnit}</span>}
      {neutral && <span title="Fator neutro inserido automaticamente; pode ser editado" className="text-[9px] text-slate-500">1 neutro</span>}
    </div>;
  };

  return <section aria-label="Detalhe de quantitativo" className="ml-2 overflow-hidden border border-slate-300 bg-white text-slate-800 sm:ml-8">
    <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-2 border-b border-slate-300 bg-slate-100 px-2 py-0.5">
      <strong className="text-[11px]">Detalhe de quantitativos</strong>
      <span className="text-[11px] text-slate-600">{periodMode ? `Total registrado no período: ${fmt(dailyQuantity)} ${unit}` : <>Dia: {fmt(dailyQuantity)} {unit} · Subtotal: {fmt(total)} {unit} {rows.length > 0 && <strong className={applied ? 'text-green-700' : 'text-amber-700'}>· {applied ? 'Aplicado ao dia' : 'Pendente de aplicação'}</strong>}</>}</span>
    </div>
    <div role="toolbar" aria-label="Ações do detalhe de quantitativos" className="flex min-h-7 flex-wrap items-center gap-0.5 border-b border-slate-300 bg-slate-50 px-1.5 py-0.5">
      <button type="button" className={buttonStyle} title="Planta DXF (PDF e imagem também aceitos; DWG indisponível)" aria-label="Planta DXF" disabled={readOnly || !canOpenPlan || !selectedRow || !selectedField} onClick={openSelectedPlan}><FileSearch2 className="h-3.5 w-3.5" /></button>
      <span aria-hidden="true" className="mx-1 h-4 border-l border-slate-300" />
      <button type="button" className={`${buttonStyle} ${clipboard?.mode === 'cut' && clipboard.source.rowId === selectedRowId ? 'border-sky-300 bg-sky-100' : ''}`} title="Recortar linha selecionada" aria-label="Recortar" aria-pressed={clipboard?.mode === 'cut' && clipboard.source.rowId === selectedRowId} disabled={readOnly || !selectedExisting || !onCopy} onClick={() => selectedExisting && onCopy?.('cut', selectedExisting)}><Scissors className="h-3.5 w-3.5" /></button>
      <button type="button" className={`${buttonStyle} ${clipboard?.mode === 'copy' && clipboard.source.rowId === selectedRowId ? 'border-sky-300 bg-sky-100' : ''}`} title="Copiar valores, comentário e fórmula sem vínculo" aria-label="Copiar" aria-pressed={clipboard?.mode === 'copy' && clipboard.source.rowId === selectedRowId} disabled={readOnly || !selectedExisting || !onCopy} onClick={() => selectedExisting && onCopy?.('copy', selectedExisting)}><Copy className="h-3.5 w-3.5" /></button>
      <button type="button" className={buttonStyle} title="Colar linha independente ou mover linha recortada" aria-label="Colar" disabled={readOnly || !onPaste || !clipboard || clipboard.mode === 'reference'} onClick={() => onPaste?.(selectedExisting?.id)}><ClipboardPaste className="h-3.5 w-3.5" /></button>
      <span aria-hidden="true" className="mx-1 h-4 border-l border-slate-300" />
      <button type="button" className={`${buttonStyle} ${clipboard?.mode === 'reference' && clipboard.source.rowId === selectedRowId ? 'border-sky-300 bg-sky-100' : ''}`} title="Copiar referência viva a este registro" aria-label="Copiar referência" aria-pressed={clipboard?.mode === 'reference' && clipboard.source.rowId === selectedRowId} disabled={readOnly || !selectedExisting || !onCopy} onClick={() => selectedExisting && onCopy?.('reference', selectedExisting)}><Copy className="h-3.5 w-3.5" /><Link2 className="absolute bottom-0 right-0 h-2 w-2 bg-slate-50" /></button>
      <button type="button" className={buttonStyle} title="Colar referência compartilhada nesta tarefa" aria-label="Colar referência" disabled={readOnly || !onPaste || clipboard?.mode !== 'reference'} onClick={() => onPaste?.(selectedExisting?.id)}><ClipboardPaste className="h-3.5 w-3.5" /><Link2 className="absolute bottom-0 right-0 h-2 w-2 bg-slate-50" /></button>
      {!readOnly && total > 0 && !applied && <button type="button" onClick={onApply} className="h-5 bg-sky-700 px-2 text-[11px] font-medium text-white hover:bg-sky-800">Atualizar realizado pelo detalhe</button>}
      <span className="ml-auto text-[10px] text-slate-500">{selectedRow ? `Linha ${selectedRow.id === blankRow.id ? 'nova' : rows.findIndex(row => row.id === selectedRow.id) + 1}${selectedField ? ` · ${selectedField === 'multiplier' ? 'A' : selectedField === 'measuredQuantity' ? 'B' : selectedField === 'dimensionC' ? 'C' : 'D'}` : ''}` : hasNeutralFactor ? 'Selecione uma linha · 1 neutro nas fórmulas explícitas' : 'Selecione uma linha e a célula da planta'}</span>
    </div>
    <div className="overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-[11px] leading-tight" style={{ minWidth: hasD ? 900 : hasC ? 880 : 860, fontFamily: 'Arial, Helvetica, sans-serif' }}>
        <colgroup><col style={{ width: 56 }} /><col /><col style={{ width: 85 }} /><col style={{ width: 118 }} /><col style={{ width: 92 }} /><col style={{ width: hasC ? 74 : 56 }} /><col style={{ width: hasD ? 74 : 56 }} /><col style={{ width: 78 }} /><col style={{ width: 78 }} /></colgroup>
        <thead className="font-normal text-slate-800">
          <tr className="bg-slate-200"><th className="border-b border-r border-slate-300 px-1 py-0.5 text-left font-normal">Loc.</th><th className="border-b border-r border-slate-300 px-1 py-0.5 text-left font-normal">Comentário</th><th className="border-b border-r border-slate-300 px-1 py-0.5 text-left font-normal">Fórmula</th><th className="border-b border-r border-slate-300 px-1 py-0.5 text-center font-normal">A</th><th className="border-b border-r border-slate-300 px-1 py-0.5 text-center font-normal">B</th><th className="border-b border-r border-slate-300 px-1 py-0.5 text-center font-normal">C</th><th className="border-b border-r border-slate-300 px-1 py-0.5 text-center font-normal">D</th><th className="border-b border-r border-slate-300 px-1 py-0.5 text-center font-normal">Parcial</th><th className="border-b border-slate-300 px-1 py-0.5 text-center font-normal">Subtotal</th></tr>
          <tr className="bg-green-100 text-[10px]"><th colSpan={3} className="border-b border-r border-slate-300" /><th className="border-b border-r border-slate-300 px-0.5 py-0.5 text-center font-normal">Uds.</th><th className="border-b border-r border-slate-300 px-0.5 py-0.5 text-center font-normal">{bHeading}</th><th className="border-b border-r border-slate-300 px-0.5 py-0.5 text-center font-normal">{hasC ? 'Largura (m)' : ''}</th><th className="border-b border-r border-slate-300 px-0.5 py-0.5 text-center font-normal">{hasD ? 'Altura (m)' : ''}</th><th colSpan={2} className="border-b border-slate-300" /></tr>
        </thead>
        <tbody>{displayRows.map((row, index) => { const rowFormulas = formulas.includes(detailFormula(row)) ? formulas : [detailFormula(row), ...formulas]; const blank = index === displayRows.length - 1 && isBlankDetailRow(row); const sources = (['multiplierSource', 'source', 'dimensionCSource', 'dimensionDSource'] as const).flatMap((key, sourceIndex) => row[key] ? [`${'ABCD'[sourceIndex]}: ${row[key]!.planName} · página ${row[key]!.page} · ${row[key]!.measureName} · ${row[key]!.points.length} ponto(s)`] : []); const peers = row.sharedRecordId ? sharedTaskNames?.(row.sharedRecordId) ?? [] : []; return <tr key={row.id === blankRow.id ? `new-${rows.length}` : row.id} onClick={() => setSelectedRowId(row.id)} className={`cursor-pointer border-b border-slate-200 align-top hover:bg-slate-50 ${selectedRowId === row.id ? 'bg-sky-50' : 'bg-white'}`}>
          <td className="border-r border-slate-200 px-0.5 py-0.5"><div className="flex items-center justify-between gap-0.5"><span title={row.location ? `Local registrado anteriormente: ${row.location}` : blank ? 'Nova linha' : `Linha ${index + 1}`} className="min-w-3 text-center tabular-nums text-slate-600">{blank ? '' : index + 1}</span>{!readOnly && row.id !== blankRow.id && !blank && <button type="button" onClick={() => onDelete(row.id)} aria-label={`Excluir linha ${index + 1}`} title="Excluir linha" className="flex h-5 w-4 shrink-0 items-center justify-center text-red-700 hover:bg-red-50"><Trash2 className="h-3 w-3" /></button>}</div></td>
          <td className="border-r border-slate-200 px-1 py-0.5"><div className="flex items-center gap-1">{textField(row, index)}{sources.length > 0 && <span role="img" aria-label={`Origem na planta da linha ${index + 1}`} title={sources.join('\n')} className="shrink-0 text-slate-500"><Link2 className="h-3 w-3" /></span>}{row.sharedRecordId && <button type="button" aria-label={`Vinculado: ${peers.join(', ')}`} title={`Vinculado a: ${peers.join(', ')}`} onClick={event => { event.stopPropagation(); setLinkedInfo(linkedInfo === row.sharedRecordId ? null : row.sharedRecordId!); }} className="shrink-0 border border-sky-300 bg-sky-50 px-1 text-[9px] text-sky-800">Vinculado</button>}</div>{row.sharedRecordId && linkedInfo === row.sharedRecordId && <div className="mt-0.5 text-[10px] text-slate-600">Tarefas: {peers.join(' · ')}{onOpenHistory && <button type="button" className="ml-2 text-sky-700 underline" onClick={event => { event.stopPropagation(); onOpenHistory(row.sharedRecordId!); }}>Histórico</button>}</div>}</td>
          <td className="border-r border-slate-200 px-0.5 py-0.5"><select aria-label={`Fórmula da linha ${index + 1}`} title={formulaMeaning(detailFormula(row), unit)} value={detailFormula(row)} disabled={readOnly || rowFormulas.length === 1} onChange={event => { if (!saveRow(row, withDetailFormula(row, event.target.value as DetailFormula))) event.target.value = detailFormula(row); }} className="h-5 w-full border border-slate-300 bg-white px-0.5 text-[11px] disabled:bg-slate-50">{rowFormulas.map(formula => <option key={formula} value={formula} disabled={!canChangeDetailFormula(row, formula, unit)}>{formulaLabel[formula]}</option>)}</select></td>
          <td className="border-r border-slate-200 px-0.5 py-0.5 text-right">{numberField(row, index, 'multiplier')}</td><td className="border-r border-slate-200 px-0.5 py-0.5 text-right">{numberField(row, index, 'measuredQuantity')}</td>
          <td className="border-r border-slate-200 px-0.5 py-0.5 text-right">{numberField(row, index, 'dimensionC')}</td><td className="border-r border-slate-200 px-0.5 py-0.5 text-right">{numberField(row, index, 'dimensionD')}</td>
          <td className="border-r border-slate-200 px-1 py-1 text-right tabular-nums">{fmt(detailPartial(row))}</td><td className="bg-slate-50 px-1 py-1 text-right tabular-nums">{fmt(subtotals[index] ?? total)}</td>
        </tr>; })}</tbody>
        <tfoot><tr className="border-t border-slate-300 bg-amber-100 font-semibold"><td colSpan={7} className="px-1 py-0.5 text-right">Total do detalhe</td><td className="border-r border-slate-300 px-1 py-0.5 text-right tabular-nums">{fmt(total)}</td><td className="px-1 py-0.5 text-right tabular-nums">{fmt(total)} {unit}</td></tr></tfoot>
      </table>
    </div>
  </section>;
}
