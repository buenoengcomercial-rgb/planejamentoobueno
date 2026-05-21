import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ChevronRight, ChevronDown, Trash2, Calculator, MoreVertical } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AdditiveComposition, AdditiveCalculationMemoryRow } from '@/types/project';
import { computeAdditiveRow, computeCompositionWithBDI } from '@/lib/additiveImport';
import { memoryTotals } from '@/lib/calculationMemory';
import { fmtBRL, fmtNum, fmtQty2, fmtPct, COL_COUNT, G_BG, BORDER_L } from './types';
import AdditiveAnalyticRows from './AdditiveAnalyticRows';
import { handleGridKeyDown } from '@/lib/gridKeyboardNavigation';
import { requestMemoryFocus, type AdditiveMemoryQtyType } from '@/lib/additiveMemoryFocus';
import type { AdditiveDetailMode, AdditiveDetailSelection } from './AdditiveDetailFooter';

const MAIN_GRID = 'additive-main-table';

/** Célula de texto (input) com estado local; commit em blur/Enter/Tab. */
function TextCommitCell({
  value, onCommit, className, placeholder, gridId, rowIndex, colIndex,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
  gridId?: string;
  rowIndex?: number;
  colIndex?: number;
}) {
  const [local, setLocal] = useState<string>(value ?? '');
  const [focused, setFocused] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Sincroniza com valor externo quando não focado, OU quando focado mas o
  // usuário ainda não editou (ex.: autofill por código atualiza Banco enquanto
  // o foco já se moveu para esse campo).
  useEffect(() => {
    if (!focused || !dirty) setLocal(value ?? '');
  }, [value, focused, dirty]);
  const commit = () => {
    if (!dirty) return;
    if ((local ?? '') !== (value ?? '')) onCommit(local);
  };
  return (
    <Input
      value={local}
      placeholder={placeholder}
      data-grid-id={gridId}
      data-row-index={rowIndex}
      data-col-index={colIndex}
      onFocus={() => { setFocused(true); setDirty(false); }}
      onChange={e => { setDirty(true); setLocal(e.target.value); }}
      onBlur={() => { setFocused(false); commit(); setDirty(false); }}
      onKeyDown={e => {
        handleGridKeyDown(e);
        if (e.defaultPrevented) return;
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
      }}
      className={className}
    />
  );
}

/** Célula de texto (textarea) com estado local; commit em blur. */
function TextareaCommitCell({
  value, onCommit, className, placeholder, rows, gridId, rowIndex, colIndex,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
  rows?: number;
  gridId?: string;
  rowIndex?: number;
  colIndex?: number;
}) {
  const [local, setLocal] = useState<string>(value ?? '');
  const [focused, setFocused] = useState(false);
  const [dirty, setDirty] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const autoResize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => {
    if (!focused || !dirty) setLocal(value ?? '');
  }, [value, focused, dirty]);
  useLayoutEffect(() => { autoResize(); }, [local]);
  const commit = () => {
    if (!dirty) return;
    if ((local ?? '') !== (value ?? '')) onCommit(local);
  };
  return (
    <textarea
      ref={ref}
      value={local}
      placeholder={placeholder}
      rows={rows ?? 1}
      data-grid-id={gridId}
      data-row-index={rowIndex}
      data-col-index={colIndex}
      onFocus={() => { setFocused(true); setDirty(false); }}
      onChange={e => { setDirty(true); setLocal(e.target.value); autoResize(); }}
      onBlur={() => { setFocused(false); commit(); setDirty(false); }}
      onKeyDown={e => {
        handleGridKeyDown(e);
        if (e.defaultPrevented) return;
      }}
      className={className}
      style={{ resize: 'none', overflow: 'hidden' }}
    />
  );
}

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
  selectedDetail?: AdditiveDetailSelection | null;
  onSelectDetail?: (selection: AdditiveDetailSelection) => void;
}

function AdditiveCompositionRowImpl({
  c, bdi, globalDiscount, isLocked, isOpen, isMemoryOpen, showAnalytic, rowIndex = 0,
  onToggleExpand, onToggleMemory, onUpdateComposition, onUpdateQuantity,
  onRemoveComposition, onChangeMemory, selectedDetail, onSelectDetail,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
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
  const isAlteredContracted = !isNew && (
    (c.addedQuantity ?? 0) > 0 ||
    (c.suppressedQuantity ?? 0) > 0 ||
    r.valorAcrescido > 0 ||
    r.valorSuprimido > 0 ||
    Math.abs(r.diferenca) > 0.005
  );

  const isSelected = selectedDetail?.compositionId === c.id;
  const selectDetail = (mode: AdditiveDetailMode, qtyType?: AdditiveMemoryQtyType) => {
    onSelectDetail?.({ compositionId: c.id, mode, qtyType });
  };

  const openMemoryFor = (type: AdditiveMemoryQtyType) => {
    if (isLocked) return;
    requestMemoryFocus(c.id, type);
    selectDetail('memory', type);
  };

  return (
    <Fragment>
      <tr className={`border-b align-top ${isSelected ? 'ring-2 ring-primary/40 ring-inset' : ''} ${
        isNew
          ? 'bg-sky-50 hover:bg-sky-100/70 border-l-4 border-l-sky-500'
          : isAlteredContracted
            ? 'bg-amber-50 hover:bg-amber-100/60 border-l-4 border-l-amber-500'
            : `hover:bg-slate-100/60 ${rowIndex % 2 === 1 ? 'bg-slate-50/50' : 'bg-white'}`
      }`}>
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
            <TextCommitCell
              value={c.code}
              gridId={MAIN_GRID} rowIndex={rowIndex} colIndex={0}
              onCommit={v => onUpdateComposition(c.id, { code: v })}
              className="h-7 w-full text-[11px] font-mono"
              placeholder="Código"
            />
          ) : c.code}
        </td>
        <td className={`px-1 py-1 break-words whitespace-normal ${G_BG.id}`}>
          {isNew && !isLocked ? (
            <TextCommitCell
              value={c.bank}
              gridId={MAIN_GRID} rowIndex={rowIndex} colIndex={1}
              onCommit={v => onUpdateComposition(c.id, { bank: v })}
              className="h-7 w-full text-xs"
              placeholder="Banco"
            />
          ) : c.bank}
        </td>
        <td className={`px-1 py-1 ${G_BG.id}`}>
          {isNew && !isLocked ? (
            <TextareaCommitCell
              value={c.description}
              gridId={MAIN_GRID} rowIndex={rowIndex} colIndex={2}
              onCommit={v => onUpdateComposition(c.id, { description: v })}
              className="w-full text-xs rounded-md border border-input bg-background px-2 py-1.5 leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-[40px] whitespace-pre-wrap break-words"
              rows={1}
              placeholder="Descrição do novo serviço"
            />
          ) : (
            <div className="whitespace-normal break-words leading-snug">{c.description}</div>
          )}
          <div className="flex flex-wrap gap-1 mt-1 items-center">
            {isNew && (
              <Badge variant="outline" className="text-[10px] font-semibold text-sky-800 border-sky-500 bg-sky-100 px-2">
                Novo serviço aditivado
              </Badge>
            )}
            {isAlteredContracted && (
              <Badge variant="outline" className="text-[10px] font-semibold text-amber-800 border-amber-500 bg-amber-100 px-2">
                Item contratado alterado
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
              onClick={() => selectDetail('memory')}
              data-detail-cell="true"
              className={`text-[10px] inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border ${isMemoryOpen ? 'bg-violet-100 border-violet-300 text-violet-800' : 'border-border text-muted-foreground hover:bg-muted'}`}
              title="Memória de cálculo"
              type="button"
            >
              <Calculator className="w-3 h-3" />
              Memória {hasMemory ? `(${(c.calculationMemory ?? []).length})` : ''}
            </button>
            {isNew && !isLocked && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="text-[10px] inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:bg-muted ml-1"
                    title="Ações do novo serviço"
                  >
                    <MoreVertical className="w-3 h-3" />
                    Ações
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem
                    onSelect={(e) => { e.preventDefault(); setConfirmDelete(true); }}
                    className="text-rose-700 focus:text-rose-700 focus:bg-rose-50"
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-2" />
                    Excluir serviço
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {isNew && !isLocked && (
            <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Excluir novo serviço aditivado?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Esta ação removerá a composição, seus insumos analíticos e sua memória de cálculo. Essa ação não pode ser desfeita.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1">
                  <div><span className="font-medium">Item:</span> {c.itemNumber || c.item || '—'}</div>
                  <div><span className="font-medium">Código:</span> <span className="font-mono">{c.code || '—'}</span></div>
                  <div><span className="font-medium">Descrição:</span> {c.description || '—'}</div>
                </div>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    className={buttonVariants({ variant: 'destructive' })}
                    onClick={() => { onRemoveComposition(c.id); setConfirmDelete(false); }}
                  >
                    Excluir serviço
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </td>
        <td className={`px-1 py-1 ${G_BG.id}`}>
          {isNew && !isLocked ? (
            <TextCommitCell
              value={c.unit}
              gridId={MAIN_GRID} rowIndex={rowIndex} colIndex={3}
              onCommit={v => onUpdateComposition(c.id, { unit: v })}
              className="h-7 w-full text-xs"
              placeholder="Un"
            />
          ) : c.unit}
        </td>
        {/* Quantidades */}
        <td className={`px-1 py-1 text-right ${G_BG.qty} ${BORDER_L}`}>
          <span
            className="block w-full text-right px-1 text-xs text-muted-foreground select-text"
            title="Quantidade contratada (somente leitura — vem do contrato original)"
          >
            {fmtQty2(c.originalQuantity ?? 0)}
          </span>
        </td>
        <td
          data-detail-cell="true"
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
          data-detail-cell="true"
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
        <td className={`px-1 py-1 text-right ${G_BG.val}`}>
          <button type="button" data-detail-cell="true" className="rounded px-1 hover:bg-primary/10" onClick={() => selectDetail('analytic')}>
            {fmtBRL(r.unitPriceWithBDI)}
          </button>
        </td>
        <td className={`px-1 py-1 text-right text-muted-foreground ${G_BG.val}`}>
          <button type="button" data-detail-cell="true" className="rounded px-1 hover:bg-primary/10" onClick={() => selectDetail('classification')}>
            {fmtBRL(r.totalFonte)}
          </button>
        </td>
        <td className={`px-1 py-1 text-right ${G_BG.val}`}>
          <button type="button" data-detail-cell="true" className="rounded px-1 hover:bg-primary/10" onClick={() => selectDetail('classification')}>
            {fmtBRL(isNew ? 0 : r.valorContratadoOriginalPreservado)}
          </button>
        </td>
        {/* Impacto */}
        <td className={`px-1 py-1 text-right text-rose-700 font-medium ${G_BG.suppressed} ${BORDER_L}`}>
          {r.valorSuprimido > 0 ? fmtBRL(-r.valorSuprimido) : fmtBRL(0)}
        </td>
        <td className={`px-1 py-1 text-right text-emerald-700 font-medium ${G_BG.added}`}>{fmtBRL(r.valorAcrescido)}</td>
        <td className={`px-1 py-1 text-right font-medium ${G_BG.impact}`}>
          <button type="button" data-detail-cell="true" className="rounded px-1 hover:bg-primary/10" onClick={() => selectDetail('classification')}>
            {fmtBRL(r.valorFinal)}
          </button>
        </td>
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
    </Fragment>
  );
}

export default memo(AdditiveCompositionRowImpl);
