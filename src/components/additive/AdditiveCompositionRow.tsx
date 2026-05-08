import { Fragment, memo, useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ChevronRight, ChevronDown, Trash2, Calculator } from 'lucide-react';
import type { AdditiveComposition, AdditiveCalculationMemoryRow } from '@/types/project';
import { computeAdditiveRow, computeCompositionWithBDI } from '@/lib/additiveImport';
import { memoryTotals } from '@/lib/calculationMemory';
import { fmtBRL, fmtNum, fmtQty2, fmtPct, COL_COUNT, G_BG, BORDER_L } from './types';
import AdditiveAnalyticRows from './AdditiveAnalyticRows';
import AdditiveCalculationMemory from './AdditiveCalculationMemory';
import { handleGridKeyDown } from '@/lib/gridKeyboardNavigation';
import { requestMemoryFocus, type AdditiveMemoryQtyType } from '@/lib/additiveMemoryFocus';

const MAIN_GRID = 'additive-main-table';

/** Parse pt-BR/EN decimal string -> number. Empty => null. */
const parseDec = (s: string): number | null => {
  const t = String(s ?? '').trim().replace(/\./g, '').replace(',', '.');
  if (t === '' || t === '-' || t === '.') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** Célula numérica com estado local. Mostra vazio quando valor=0 e allowEmptyZero. */
function QtyCell({
  value, disabled, onCommit, className, allowEmptyZero, gridId, rowIndex, colIndex, onFocusCell,
}: {
  value: number;
  disabled?: boolean;
  onCommit: (n: number) => void;
  className?: string;
  allowEmptyZero?: boolean;
  gridId?: string;
  rowIndex?: number;
  colIndex?: number;
  onFocusCell?: () => void;
}) {
  const fmtView = (n: number) =>
    n === 0 && allowEmptyZero ? '' : fmtQty2(n);
  const [local, setLocal] = useState<string>(() => fmtView(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setLocal(fmtView(value)); }, [value, focused, allowEmptyZero]);
  return (
    <Input
      type="text"
      inputMode="decimal"
      value={local}
      disabled={disabled}
      data-grid-id={gridId}
      data-row-index={rowIndex}
      data-col-index={colIndex}
      onFocus={e => { setFocused(true); e.currentTarget.select(); onFocusCell?.(); }}
      onChange={e => {
        const v = e.target.value;
        if (/^-?[0-9.,]*$/.test(v)) setLocal(v);
      }}
      onBlur={() => {
        setFocused(false);
        const n = parseDec(local);
        const final = n == null ? 0 : n;
        setLocal(fmtView(final));
        if (final !== value) onCommit(final);
      }}
      onKeyDown={e => {
        handleGridKeyDown(e);
        if (e.defaultPrevented) return;
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
      }}
      className={`no-spinner ${className ?? ''}`}
    />
  );
}

/** Célula numérica (R$) com estado local — sem formatação especial. */
function MoneyCell({
  value, disabled, onCommit, className, title, gridId, rowIndex, colIndex,
}: {
  value: number;
  disabled?: boolean;
  onCommit: (n: number) => void;
  className?: string;
  title?: string;
  gridId?: string;
  rowIndex?: number;
  colIndex?: number;
}) {
  const fmtView = (n: number) => (n ? String(n).replace('.', ',') : '');
  const [local, setLocal] = useState<string>(() => fmtView(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setLocal(fmtView(value)); }, [value, focused]);
  return (
    <Input
      type="text"
      inputMode="decimal"
      value={local}
      disabled={disabled}
      title={title}
      data-grid-id={gridId}
      data-row-index={rowIndex}
      data-col-index={colIndex}
      onFocus={e => { setFocused(true); e.currentTarget.select(); }}
      onChange={e => {
        const v = e.target.value;
        if (/^-?[0-9.,]*$/.test(v)) setLocal(v);
      }}
      onBlur={() => {
        setFocused(false);
        const n = parseDec(local);
        const final = n == null ? 0 : n;
        if (final !== value) onCommit(final);
      }}
      onKeyDown={e => {
        handleGridKeyDown(e);
        if (e.defaultPrevented) return;
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
      }}
      className={`no-spinner ${className ?? ''}`}
    />
  );
}

interface Props {
  c: AdditiveComposition;
  bdi: number;
  globalDiscount: number;
  isLocked: boolean;
  isOpen: boolean;
  isMemoryOpen: boolean;
  showAnalytic: boolean;
  rowIndex?: number;
  onToggleExpand: (id: string) => void;
  onToggleMemory: (id: string) => void;
  onUpdateComposition: (id: string, patch: Partial<AdditiveComposition>) => void;
  onUpdateQuantity: (id: string, field: 'addedQuantity' | 'suppressedQuantity', v: number) => void;
  onRemoveComposition: (id: string) => void;
  onChangeMemory: (id: string, rows: AdditiveCalculationMemoryRow[]) => void;
}

function AdditiveCompositionRowImpl({
  c, bdi, globalDiscount, isLocked, isOpen, isMemoryOpen, showAnalytic, rowIndex = 0,
  onToggleExpand, onToggleMemory, onUpdateComposition, onUpdateQuantity,
  onRemoveComposition, onChangeMemory,
}: Props) {
  const r = computeAdditiveRow(c, bdi, globalDiscount);
  const cb = computeCompositionWithBDI(c, bdi);
  const hasInputs = c.inputs.length > 0;
  const diff = hasInputs ? cb.diff : 0;
  const hasDiff = hasInputs && Math.abs(diff) > 0.05;
  const noAnalytic = !hasInputs && !c.isNewService;
  const isNew = !!c.isNewService;
  const memTotals = memoryTotals(c);
  const hasMemory = memTotals.hasMemory;
  const canOpenAnalytic = hasInputs || isNew;
  const shouldShowAnalyticRows = isOpen && (showAnalytic || isNew) && canOpenAnalytic;

  const openMemoryFor = (type: AdditiveMemoryQtyType) => {
    if (isLocked) return;
    requestMemoryFocus(c.id, type);
    if (!isMemoryOpen) onToggleMemory(c.id);
  };

  return (
    <Fragment>
      <tr className={`border-b align-top hover:bg-slate-100/60 ${isNew ? 'bg-sky-50/30' : (rowIndex % 2 === 1 ? 'bg-slate-50/50' : 'bg-white')}`}>
        <td className="px-1 py-2 text-center">
          <button
            onClick={() => onToggleExpand(c.id)}
            className="p-1 rounded hover:bg-muted"
            disabled={!canOpenAnalytic}
            title={!canOpenAnalytic ? 'Sem analítico' : 'Expandir analítica'}
          >
            {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        </td>
        {/* Identificação */}
        <td className={`px-1 py-1 ${G_BG.id}`}>{c.itemNumber || c.item}</td>
        <td className={`px-1 py-1 font-mono text-[11px] break-words whitespace-normal ${G_BG.id}`}>
          {isNew && !isLocked ? (
            <Input
              value={c.code}
              data-grid-id={MAIN_GRID}
              data-row-index={rowIndex}
              data-col-index={0}
              onKeyDown={handleGridKeyDown}
              onChange={e => onUpdateComposition(c.id, { code: e.target.value })}
              className="h-7 w-full text-[11px] font-mono"
              placeholder="Código"
            />
          ) : c.code}
        </td>
        <td className={`px-1 py-1 break-words whitespace-normal ${G_BG.id}`}>
          {isNew && !isLocked ? (
            <Input
              value={c.bank}
              data-grid-id={MAIN_GRID}
              data-row-index={rowIndex}
              data-col-index={1}
              onKeyDown={handleGridKeyDown}
              onChange={e => onUpdateComposition(c.id, { bank: e.target.value })}
              className="h-7 w-full text-xs"
              placeholder="Banco"
            />
          ) : c.bank}
        </td>
        <td className={`px-1 py-1 ${G_BG.id}`}>
          {isNew && !isLocked ? (
            <textarea
              value={c.description}
              data-grid-id={MAIN_GRID}
              data-row-index={rowIndex}
              data-col-index={2}
              onKeyDown={handleGridKeyDown}
              onChange={e => onUpdateComposition(c.id, { description: e.target.value })}
              className="w-full text-xs rounded-md border border-input bg-background px-2 py-1.5 leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y min-h-[40px]"
              rows={2}
              placeholder="Descrição do novo serviço"
            />
          ) : (
            <div className="whitespace-normal break-words leading-snug">{c.description}</div>
          )}
          <div className="flex flex-wrap gap-1 mt-1 items-center">
            {isNew && (
              <Badge variant="outline" className="text-[9px] text-sky-700 border-sky-400 bg-sky-50">
                Novo serviço
              </Badge>
            )}
            {noAnalytic && <Badge variant="outline" className="text-[9px] text-amber-700 border-amber-400">Sem analítico</Badge>}
            {hasDiff && (
              <Badge variant="outline" className="text-[9px] text-rose-700 border-rose-400">
                Dif. analítica c/ BDI: {fmtBRL(diff)}
              </Badge>
            )}
            {hasMemory && (
              <Badge variant="outline" className="text-[9px] text-violet-700 border-violet-400 bg-violet-50">
                Calculado pela memória
              </Badge>
            )}
            {isNew && (
              <button
                onClick={() => onToggleExpand(c.id)}
                className={`text-[10px] inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border ${isOpen ? 'bg-primary/10 border-primary/30 text-primary' : 'border-border text-muted-foreground hover:bg-muted'}`}
                title="Abrir insumos analíticos"
                type="button"
              >
                {hasInputs ? 'Analítica' : '+ Insumos'}
              </button>
            )}
            <button
              onClick={() => onToggleMemory(c.id)}
              className={`text-[10px] inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border ${isMemoryOpen ? 'bg-violet-100 border-violet-300 text-violet-800' : 'border-border text-muted-foreground hover:bg-muted'}`}
              title="Memória de cálculo"
              type="button"
            >
              <Calculator className="w-3 h-3" />
              Memória {hasMemory ? `(${(c.calculationMemory ?? []).length})` : ''}
            </button>
            {isNew && !isLocked && (
              <button
                onClick={() => onRemoveComposition(c.id)}
                className="text-[10px] text-rose-600 hover:underline ml-1"
                title="Remover novo serviço"
              >
                <Trash2 className="w-3 h-3 inline" />
              </button>
            )}
          </div>
        </td>
        <td className={`px-1 py-1 ${G_BG.id}`}>
          {isNew && !isLocked ? (
            <Input
              value={c.unit}
              data-grid-id={MAIN_GRID}
              data-row-index={rowIndex}
              data-col-index={3}
              onKeyDown={handleGridKeyDown}
              onChange={e => onUpdateComposition(c.id, { unit: e.target.value })}
              className="h-7 w-full text-xs"
              placeholder="Un"
            />
          ) : c.unit}
        </td>
        {/* Quantidades */}
        <td className={`px-1 py-1 text-right ${G_BG.qty} ${BORDER_L}`}>
          <QtyCell
            value={c.originalQuantity ?? 0}
            disabled={isLocked || isNew}
            onCommit={n => onUpdateComposition(c.id, { originalQuantity: n })}
            className="h-7 w-full text-xs text-right px-1"
            gridId={MAIN_GRID} rowIndex={rowIndex} colIndex={4}
          />
        </td>
        <td
          className={`px-1 py-1 text-right ${G_BG.suppressed} text-rose-700`}
          onClick={isLocked ? undefined : () => openMemoryFor('suprimida')}
        >
          <QtyCell
            value={c.suppressedQuantity ?? 0}
            disabled={isLocked || hasMemory}
            allowEmptyZero={isNew}
            onCommit={n => { onUpdateComposition(c.id, { suppressedQuantity: n }); onUpdateQuantity(c.id, 'suppressedQuantity', n); }}
            className="h-7 w-full text-xs text-right px-1 border-rose-200 text-rose-700"
            gridId={MAIN_GRID} rowIndex={rowIndex} colIndex={5}
            onFocusCell={isLocked ? undefined : () => openMemoryFor('suprimida')}
          />
        </td>
        <td
          className={`px-1 py-1 text-right ${G_BG.added} text-emerald-700`}
          onClick={isLocked ? undefined : () => openMemoryFor('acrescida')}
        >
          <QtyCell
            value={c.addedQuantity ?? 0}
            disabled={isLocked || hasMemory}
            allowEmptyZero={isNew}
            onCommit={n => { onUpdateComposition(c.id, { addedQuantity: n }); onUpdateQuantity(c.id, 'addedQuantity', n); }}
            className="h-7 w-full text-xs text-right px-1 border-emerald-200 text-emerald-700"
            gridId={MAIN_GRID} rowIndex={rowIndex} colIndex={6}
            onFocusCell={isLocked ? undefined : () => openMemoryFor('acrescida')}
          />
        </td>
        <td className={`px-1 py-1 text-right font-medium ${G_BG.qty}`}>{fmtQty2(r.qtdFinal)}</td>
        {/* Valores */}
        <td className={`px-1 py-1 text-right ${G_BG.val} ${BORDER_L}`}>
          {isNew && !isLocked && c.inputs.length === 0 ? (
            <MoneyCell
              value={c.unitPriceNoBDIInformed ?? 0}
              onCommit={n => onUpdateComposition(c.id, { unitPriceNoBDIInformed: n })}
              className="h-7 w-full text-xs text-right px-1"
              title={globalDiscount > 0 ? `Informe a referência s/ BDI. Desconto licit. ${globalDiscount}% será aplicado.` : 'Valor s/ BDI'}
              gridId={MAIN_GRID} rowIndex={rowIndex} colIndex={7}
            />
          ) : (
            <span title={isNew && globalDiscount > 0 ? `Já com desconto de ${globalDiscount}% (referência: ${fmtBRL(r.referenceUnitNoBDI)})` : undefined}>
              {fmtBRL(isNew ? r.unitPriceNoBDIWithDiscount : r.unitPriceNoBDI)}
            </span>
          )}
        </td>
        <td className={`px-1 py-1 text-right ${G_BG.val}`}>{fmtBRL(r.unitPriceWithBDI)}</td>
        <td className={`px-1 py-1 text-right text-muted-foreground ${G_BG.val}`}>{fmtBRL(r.totalFonte)}</td>
        <td className={`px-1 py-1 text-right ${G_BG.val}`}>{fmtBRL(r.valorContratadoCalc)}</td>
        {/* Impacto */}
        <td className={`px-1 py-1 text-right text-rose-700 font-medium ${G_BG.suppressed} ${BORDER_L}`}>
          {r.valorSuprimido > 0 ? fmtBRL(-r.valorSuprimido) : fmtBRL(0)}
        </td>
        <td className={`px-1 py-1 text-right text-emerald-700 font-medium ${G_BG.added}`}>{fmtBRL(r.valorAcrescido)}</td>
        <td className={`px-1 py-1 text-right font-medium ${G_BG.impact}`}>{fmtBRL(r.valorFinal)}</td>
        <td className={`px-1 py-1 text-right font-medium ${r.diferenca < 0 ? 'text-rose-700' : r.diferenca > 0 ? 'text-emerald-700' : 'text-foreground'}`}>
          {fmtBRL(r.diferenca)}
        </td>
        <td className={`px-1 py-1 text-right ${r.percentVar < 0 ? 'text-rose-700' : r.percentVar > 0 ? 'text-emerald-700' : 'text-foreground'}`}>
          {fmtPct(r.percentVar)}
        </td>
      </tr>
      {shouldShowAnalyticRows && (
        <tr className="bg-muted/20 border-b">
          <td />
          <td colSpan={COL_COUNT - 1} className="px-3 py-2">
            <AdditiveAnalyticRows
              c={c}
              bdi={bdi}
              globalDiscount={globalDiscount}
              isLocked={isLocked}
              cb={cb}
              onUpdateComposition={onUpdateComposition}
            />
          </td>
        </tr>
      )}
      {isMemoryOpen && (
        <tr className="bg-violet-50/30 border-b">
          <td />
          <td colSpan={COL_COUNT - 1} className="px-3 py-2">
            <AdditiveCalculationMemory
              c={c}
              isLocked={isLocked}
              onChange={rows => onChangeMemory(c.id, rows)}
              onChangeColumns={cols => onUpdateComposition(c.id, { calculationMemoryColumns: cols })}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export default memo(AdditiveCompositionRowImpl);
