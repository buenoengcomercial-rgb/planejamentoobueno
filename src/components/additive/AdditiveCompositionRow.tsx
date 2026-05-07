import { Fragment, memo } from 'react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ChevronRight, ChevronDown, Trash2, Calculator } from 'lucide-react';
import type { AdditiveComposition, AdditiveCalculationMemoryRow } from '@/types/project';
import { computeAdditiveRow, computeCompositionWithBDI } from '@/lib/additiveImport';
import { memoryTotals } from '@/lib/calculationMemory';
import { fmtBRL, fmtNum, fmtPct, COL_COUNT } from './types';
import AdditiveAnalyticRows from './AdditiveAnalyticRows';
import AdditiveCalculationMemory from './AdditiveCalculationMemory';

interface Props {
  c: AdditiveComposition;
  bdi: number;
  globalDiscount: number;
  isLocked: boolean;
  isOpen: boolean;
  isMemoryOpen: boolean;
  showAnalytic: boolean;
  onToggleExpand: (id: string) => void;
  onToggleMemory: (id: string) => void;
  onUpdateComposition: (id: string, patch: Partial<AdditiveComposition>) => void;
  onUpdateQuantity: (id: string, field: 'addedQuantity' | 'suppressedQuantity', v: number) => void;
  onRemoveComposition: (id: string) => void;
  onChangeMemory: (id: string, rows: AdditiveCalculationMemoryRow[]) => void;
}

function AdditiveCompositionRowImpl({
  c, bdi, globalDiscount, isLocked, isOpen, isMemoryOpen, showAnalytic,
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

  return (
    <Fragment>
      <tr className={`border-b hover:bg-muted/30 align-top ${isNew ? 'bg-sky-50/40' : ''}`}>
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
        <td className="px-2 py-2">{c.itemNumber || c.item}</td>
        <td className="px-2 py-2 font-mono text-[11px]">
          {isNew && !isLocked ? (
            <Input
              value={c.code}
              onChange={e => onUpdateComposition(c.id, { code: e.target.value })}
              className="h-7 w-20 text-[11px] font-mono"
            />
          ) : c.code}
        </td>
        <td className="px-2 py-2">
          {isNew && !isLocked ? (
            <Input
              value={c.bank}
              onChange={e => onUpdateComposition(c.id, { bank: e.target.value })}
              className="h-7 w-20 text-xs"
            />
          ) : c.bank}
        </td>
        <td className="px-2 py-2 max-w-[320px]">
          {isNew && !isLocked ? (
            <Input
              value={c.description}
              onChange={e => onUpdateComposition(c.id, { description: e.target.value })}
              className="h-7 text-xs"
            />
          ) : (
            <div>{c.description}</div>
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
        <td className="px-2 py-2">
          {isNew && !isLocked ? (
            <Input
              value={c.unit}
              onChange={e => onUpdateComposition(c.id, { unit: e.target.value })}
              className="h-7 w-14 text-xs"
            />
          ) : c.unit}
        </td>
        {/* F — Qtd Contratada */}
        <td className="px-2 py-2 text-right">
          <Input
            type="number" step="0.0001" min={0}
            value={c.originalQuantity ?? 0}
            disabled={isLocked || isNew}
            onChange={e => onUpdateComposition(c.id, { originalQuantity: Number(e.target.value) || 0 })}
            className="h-7 w-20 text-xs text-right"
          />
        </td>
        {/* G — Qtd Suprimida */}
        <td className="px-2 py-2 text-right">
          <Input
            type="number" step="0.0001" min={0}
            value={c.suppressedQuantity ?? 0}
            disabled={isLocked || isNew || hasMemory}
            onChange={e => onUpdateComposition(c.id, { suppressedQuantity: Number(e.target.value) || 0 })}
            onBlur={e => onUpdateQuantity(c.id, 'suppressedQuantity', Number(e.target.value) || 0)}
            className="h-7 w-20 text-xs text-right border-rose-200"
            title={hasMemory ? 'Calculado pela memória de cálculo' : undefined}
          />
        </td>
        {/* H — Qtd Acrescida */}
        <td className="px-2 py-2 text-right">
          <Input
            type="number" step="0.0001" min={0}
            value={c.addedQuantity ?? 0}
            disabled={isLocked || hasMemory}
            onChange={e => onUpdateComposition(c.id, { addedQuantity: Number(e.target.value) || 0 })}
            onBlur={e => onUpdateQuantity(c.id, 'addedQuantity', Number(e.target.value) || 0)}
            className="h-7 w-20 text-xs text-right border-emerald-200"
            title={hasMemory ? 'Calculado pela memória de cálculo' : undefined}
          />
        </td>
        {/* I — Qtd Final */}
        <td className="px-2 py-2 text-right font-medium">{fmtNum(r.qtdFinal)}</td>
        {/* J — Valor Unit (s/ BDI). Para novos serviços, exibe valor JÁ COM desconto. */}
        <td className="px-2 py-2 text-right">
          {isNew && !isLocked && c.inputs.length === 0 ? (
            <Input
              type="number" step="0.01" min={0}
              value={c.unitPriceNoBDIInformed ?? 0}
              onChange={e => onUpdateComposition(c.id, { unitPriceNoBDIInformed: Number(e.target.value) || 0 })}
              className="h-7 w-24 text-xs text-right"
              title={globalDiscount > 0 ? `Informe a referência s/ BDI. Desconto licit. ${globalDiscount}% será aplicado.` : 'Valor s/ BDI'}
            />
          ) : (
            <span title={isNew && globalDiscount > 0 ? `Já com desconto de ${globalDiscount}% (referência: ${fmtBRL(r.referenceUnitNoBDI)})` : undefined}>
              {fmtBRL(isNew ? r.unitPriceNoBDIWithDiscount : r.unitPriceNoBDI)}
            </span>
          )}
        </td>
        {/* K — Valor Unit c/ BDI */}
        <td className="px-2 py-2 text-right">{fmtBRL(r.unitPriceWithBDI)}</td>
        {/* L — Total Fonte */}
        <td className="px-2 py-2 text-right text-muted-foreground">{fmtBRL(r.totalFonte)}</td>
        {/* M — Valor Contratado Calc. */}
        <td className="px-2 py-2 text-right">{fmtBRL(r.valorContratadoCalc)}</td>
        {/* N — Valor Suprimido */}
        <td className="px-2 py-2 text-right text-rose-700">
          {r.valorSuprimido > 0 ? fmtBRL(-r.valorSuprimido) : fmtBRL(0)}
        </td>
        {/* O — Valor Acrescido */}
        <td className="px-2 py-2 text-right text-emerald-700">{fmtBRL(r.valorAcrescido)}</td>
        {/* P — Valor Final */}
        <td className="px-2 py-2 text-right font-medium">{fmtBRL(r.valorFinal)}</td>
        {/* Q — Diferença */}
        <td className={`px-2 py-2 text-right font-medium ${r.diferenca < 0 ? 'text-rose-700' : r.diferenca > 0 ? 'text-emerald-700' : ''}`}>
          {fmtBRL(r.diferenca)}
        </td>
        {/* R — % Var. */}
        <td className={`px-2 py-2 text-right ${r.percentVar < 0 ? 'text-rose-700' : r.percentVar > 0 ? 'text-emerald-700' : ''}`}>
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
