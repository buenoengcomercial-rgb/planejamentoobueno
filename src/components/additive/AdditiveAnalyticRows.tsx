import { Plus, Trash2, Copy } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { AdditiveComposition, AdditiveInput } from '@/types/project';
import { sumAnalyticTotalNoBDI, money2, truncar2 } from '@/lib/additiveImport';
import { fmtBRL } from './types';

interface Props {
  c: AdditiveComposition;
  bdi: number;
  globalDiscount: number;
  isLocked?: boolean;
  /** Resultado de computeCompositionWithBDI(c, bdi) — passado para evitar recálculo. */
  cb: { totalAnalyticWithBDI: number; diff: number };
  onUpdateComposition?: (id: string, patch: Partial<AdditiveComposition>) => void;
}

const newInput = (): AdditiveInput => ({
  id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `ins-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  code: '',
  bank: '',
  description: '',
  unit: '',
  coefficient: 0,
  unitPrice: 0,
  total: 0,
});

export default function AdditiveAnalyticRows({ c, bdi, globalDiscount, isLocked, cb, onUpdateComposition }: Props) {
  const isNew = !!c.isNewService;
  const editable = isNew && !isLocked && !!onUpdateComposition;
  const showDiscount = isNew && globalDiscount > 0;
  const discFactor = showDiscount ? (1 - globalDiscount / 100) : 1;
  const sumNoBDI = sumAnalyticTotalNoBDI(c);
  const sumNoBDIDisc = money2(sumNoBDI * discFactor);
  const qty = c.addedQuantity ?? c.quantity ?? 0;
  const fator = 1 + bdi / 100;
  const totalAnalyticWithBDI = showDiscount
    ? truncar2(truncar2(sumNoBDIDisc * fator) * qty)
    : cb.totalAnalyticWithBDI;

  const updateInputs = (next: AdditiveInput[]) => {
    if (!onUpdateComposition) return;
    onUpdateComposition(c.id, { inputs: next });
  };
  const patchInput = (id: string, patch: Partial<AdditiveInput>) => {
    updateInputs(c.inputs.map(i => {
      if (i.id !== id) return i;
      const merged = { ...i, ...patch };
      merged.total = money2((merged.coefficient || 0) * (merged.unitPrice || 0));
      return merged;
    }));
  };
  const addInput = () => updateInputs([...c.inputs, newInput()]);
  const removeInput = (id: string) => updateInputs(c.inputs.filter(i => i.id !== id));
  const duplicateInput = (id: string) => {
    const base = c.inputs.find(i => i.id === id);
    if (!base) return;
    const copy = { ...base, id: newInput().id };
    const idx = c.inputs.findIndex(i => i.id === id);
    const next = [...c.inputs];
    next.splice(idx + 1, 0, copy);
    updateInputs(next);
  };

  const colCount = (showDiscount ? 9 : 7) + (editable ? 1 : 0);

  return (
    <div className="space-y-2">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left px-1.5 py-1 font-medium">Código</th>
            <th className="text-left px-1.5 py-1 font-medium">Banco</th>
            <th className="text-left px-1.5 py-1 font-medium">Descrição</th>
            <th className="text-left px-1.5 py-1 font-medium">Un</th>
            <th className="text-right px-1.5 py-1 font-medium">Coef.</th>
            <th className="text-right px-1.5 py-1 font-medium">V. Unit s/ BDI</th>
            {showDiscount && (
              <th className="text-right px-1.5 py-1 font-medium text-sky-700">V. Unit s/ BDI c/ Desc.</th>
            )}
            <th className="text-right px-1.5 py-1 font-medium">Total s/ BDI</th>
            {showDiscount && (
              <th className="text-right px-1.5 py-1 font-medium text-sky-700">Total s/ BDI c/ Desc.</th>
            )}
            {editable && <th className="px-1.5 py-1" />}
          </tr>
        </thead>
        <tbody>
          {c.inputs.length === 0 && (
            <tr>
              <td colSpan={colCount} className="px-1.5 py-2 text-center text-muted-foreground italic">
                {editable ? 'Sem insumos analíticos. Clique em "+ Adicionar insumo" para incluir.' : 'Sem insumos analíticos.'}
              </td>
            </tr>
          )}
          {c.inputs.map(i => {
            const unitDisc = money2(i.unitPrice * discFactor);
            const totalDisc = money2(i.coefficient * unitDisc);
            return (
              <tr key={i.id} className="border-t border-border/50">
                <td className="px-1.5 py-1 font-mono">
                  {editable ? (
                    <Input value={i.code} onChange={e => patchInput(i.id, { code: e.target.value })} className="h-6 w-24 text-[11px] font-mono px-1" />
                  ) : i.code}
                </td>
                <td className="px-1.5 py-1">
                  {editable ? (
                    <Input value={i.bank} onChange={e => patchInput(i.id, { bank: e.target.value })} className="h-6 w-20 text-[11px] px-1" />
                  ) : i.bank}
                </td>
                <td className="px-1.5 py-1">
                  {editable ? (
                    <Input value={i.description} onChange={e => patchInput(i.id, { description: e.target.value })} className="h-6 text-[11px] px-1 min-w-[200px]" />
                  ) : i.description}
                </td>
                <td className="px-1.5 py-1">
                  {editable ? (
                    <Input value={i.unit} onChange={e => patchInput(i.id, { unit: e.target.value })} className="h-6 w-14 text-[11px] px-1" />
                  ) : i.unit}
                </td>
                <td className="px-1.5 py-1 text-right">
                  {editable ? (
                    <Input
                      type="number" step="0.0001" min={0}
                      value={i.coefficient || ''}
                      onChange={e => patchInput(i.id, { coefficient: Number(e.target.value) || 0 })}
                      className="h-6 w-20 text-[11px] text-right px-1"
                    />
                  ) : i.coefficient.toLocaleString('pt-BR')}
                </td>
                <td className="px-1.5 py-1 text-right">
                  {editable ? (
                    <Input
                      type="number" step="0.01" min={0}
                      value={i.unitPrice || ''}
                      onChange={e => patchInput(i.id, { unitPrice: Number(e.target.value) || 0 })}
                      className="h-6 w-24 text-[11px] text-right px-1"
                    />
                  ) : fmtBRL(i.unitPrice)}
                </td>
                {showDiscount && (
                  <td className="px-1.5 py-1 text-right text-sky-700">{fmtBRL(unitDisc)}</td>
                )}
                <td className="px-1.5 py-1 text-right">{fmtBRL(i.total)}</td>
                {showDiscount && (
                  <td className="px-1.5 py-1 text-right text-sky-700">{fmtBRL(totalDisc)}</td>
                )}
                {editable && (
                  <td className="px-1.5 py-1 text-right whitespace-nowrap">
                    <button
                      onClick={() => duplicateInput(i.id)}
                      className="p-1 rounded hover:bg-muted text-muted-foreground"
                      title="Duplicar insumo"
                      type="button"
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => removeInput(i.id)}
                      className="p-1 rounded hover:bg-muted text-rose-600"
                      title="Excluir insumo"
                      type="button"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
          <tr className="border-t font-medium">
            <td colSpan={6} className="px-1.5 py-1 text-right">Soma analítica s/ BDI:</td>
            {showDiscount && <td />}
            <td className="px-1.5 py-1 text-right">{fmtBRL(sumNoBDI)}</td>
            {showDiscount && <td />}
            {editable && <td />}
          </tr>
          {showDiscount && (
            <tr className="font-medium text-sky-700">
              <td colSpan={6} className="px-1.5 py-1 text-right">Soma analítica s/ BDI c/ desconto ({globalDiscount}%):</td>
              <td />
              <td />
              <td className="px-1.5 py-1 text-right">{fmtBRL(sumNoBDIDisc)}</td>
              {editable && <td />}
            </tr>
          )}
          <tr className="font-medium text-primary">
            <td colSpan={showDiscount ? 8 : 6} className="px-1.5 py-1 text-right">Valor analítico c/ BDI calculado (× qtd):</td>
            <td className="px-1.5 py-1 text-right">{fmtBRL(totalAnalyticWithBDI)}</td>
            {editable && <td />}
          </tr>
        </tbody>
      </table>
      {editable && (
        <div className="flex justify-start">
          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={addInput} type="button">
            <Plus className="w-3 h-3 mr-1" /> Adicionar insumo
          </Button>
        </div>
      )}
    </div>
  );
}
