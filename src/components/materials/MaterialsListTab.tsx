import { useMemo, useState } from 'react';
import type { Project, MaterialComparison } from '@/types/project';
import * as MC from '@/lib/materialComparisons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Plus, Sparkles, Trash2, AlertTriangle } from 'lucide-react';
import { parseBR, NumberInput } from './numberInput';

interface Props {
  project: Project;
  comparison: MaterialComparison;
  onApply: (next: MaterialComparison) => void;
}

export default function MaterialsListTab({ project, comparison, onApply }: Props) {
  const [showSuggest, setShowSuggest] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Record<string, boolean>>({});
  const [manual, setManual] = useState({ description: '', unit: 'un', quantity: '1', referencePrice: '', code: '' });

  const suggestions = useMemo(() => MC.suggestMaterialsFromProject(project), [project]);
  const realSuggestions = suggestions.filter(s => !s.warning);
  const warnings = suggestions.filter(s => s.warning);

  const addManual = () => {
    if (!manual.description.trim()) return;
    const next = MC.addItem(comparison, {
      description: manual.description.trim(),
      unit: manual.unit || 'un',
      quantity: parseBR(manual.quantity) ?? 0,
      referencePrice: parseBR(manual.referencePrice),
      code: manual.code || undefined,
      sourceType: 'manual',
    });
    onApply(next);
    setManual({ description: '', unit: 'un', quantity: '1', referencePrice: '', code: '' });
  };

  const importSelected = () => {
    const picked = realSuggestions.filter(s => selectedKeys[s.key]);
    if (picked.length === 0) return;
    const next = MC.addItemsBulk(
      comparison,
      picked.map(p => ({
        description: p.description,
        unit: p.unit,
        quantity: p.quantity,
        referencePrice: p.referencePrice,
        code: p.code,
        sourceType: p.sourceType,
        sourceId: p.sourceId,
        status: 'pendente' as const,
      })),
    );
    onApply(next);
    setSelectedKeys({});
    setShowSuggest(false);
  };

  const sourceLabel = (s: MC.MaterialSuggestionSource) =>
    s === 'task_material' ? 'Material de tarefa'
    : s === 'additive_input' ? 'Insumo de aditivo'
    : 'Insumo analítico';

  return (
    <div className="space-y-4">
      {/* Add manual */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Adicionar item</h3>
          <Button size="sm" variant="outline" onClick={() => setShowSuggest(s => !s)}>
            <Sparkles className="w-3.5 h-3.5 mr-1" />
            {showSuggest ? 'Ocultar sugestões' : 'Importar do projeto'}
          </Button>
        </div>
        <div className="grid grid-cols-12 gap-2">
          <Input className="col-span-2" placeholder="Código" value={manual.code} onChange={e => setManual({ ...manual, code: e.target.value })} />
          <Input className="col-span-5" placeholder="Descrição" value={manual.description} onChange={e => setManual({ ...manual, description: e.target.value })} />
          <Input className="col-span-1" placeholder="Un." value={manual.unit} onChange={e => setManual({ ...manual, unit: e.target.value })} />
          <NumberInput className="col-span-1" placeholder="Qtd." value={manual.quantity} onChange={v => setManual({ ...manual, quantity: v })} />
          <NumberInput className="col-span-2" placeholder="Preço ref." value={manual.referencePrice} onChange={v => setManual({ ...manual, referencePrice: v })} />
          <Button className="col-span-1" onClick={addManual}><Plus className="w-4 h-4" /></Button>
        </div>

        {showSuggest && (
          <div className="border border-border rounded-lg max-h-80 overflow-auto mt-2">
            {warnings.length > 0 && (
              <div className="px-3 py-2 bg-warning/10 border-b border-border text-[11px] text-warning-foreground flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <div>
                  <strong>{warnings.length}</strong> composição(ões) sem analítico vinculado foram ignoradas (composições sintéticas não viram material de compra).
                </div>
              </div>
            )}
            <table className="w-full text-xs">
              <thead className="bg-muted sticky top-0">
                <tr>
                  <th className="p-2 w-8"></th>
                  <th className="p-2 text-left">Descrição</th>
                  <th className="p-2">Origem</th>
                  <th className="p-2">Un</th>
                  <th className="p-2 text-right">Qtd</th>
                  <th className="p-2 text-right">Preço ref.</th>
                </tr>
              </thead>
              <tbody>
                {realSuggestions.length === 0 && (
                  <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">Sem insumos analíticos identificados nas tarefas ou em aditivos contratados.</td></tr>
                )}
                {realSuggestions.map(s => (
                  <tr key={s.key} className="border-t border-border hover:bg-muted/30">
                    <td className="p-2">
                      <Checkbox checked={!!selectedKeys[s.key]} onCheckedChange={v => setSelectedKeys(prev => ({ ...prev, [s.key]: !!v }))} />
                    </td>
                    <td className="p-2">{s.description}</td>
                    <td className="p-2 text-center text-[10px] text-muted-foreground">{sourceLabel(s.sourceType)}</td>
                    <td className="p-2 text-center">{s.unit}</td>
                    <td className="p-2 text-right">{s.quantity.toLocaleString('pt-BR', { maximumFractionDigits: 4 })}</td>
                    <td className="p-2 text-right">{s.referencePrice ? `R$ ${s.referencePrice.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="p-2 border-t border-border bg-muted/30 flex justify-end">
              <Button size="sm" onClick={importSelected} disabled={Object.values(selectedKeys).every(v => !v)}>
                Importar selecionados
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Current items */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-muted/30 text-xs uppercase font-semibold tracking-wide">
          Itens do comparativo ({comparison.items.length})
        </div>
        {comparison.items.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Nenhum item ainda. Adicione manualmente ou importe do projeto.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted">
              <tr>
                <th className="p-2 text-left">Código</th>
                <th className="p-2 text-left">Descrição</th>
                <th className="p-2">Un.</th>
                <th className="p-2 text-right">Qtd.</th>
                <th className="p-2 text-right">Preço ref.</th>
                <th className="p-2 text-center">Status</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {comparison.items.map(it => (
                <tr key={it.id} className="border-t border-border hover:bg-muted/30">
                  <td className="p-2">
                    <Input value={it.code ?? ''} onChange={e => onApply(MC.updateItem(comparison, it.id, { code: e.target.value }))} className="h-7 text-xs" />
                  </td>
                  <td className="p-2 min-w-[200px]">
                    <Input value={it.description} onChange={e => onApply(MC.updateItem(comparison, it.id, { description: e.target.value }))} className="h-7 text-xs" />
                  </td>
                  <td className="p-2 w-16">
                    <Input value={it.unit} onChange={e => onApply(MC.updateItem(comparison, it.id, { unit: e.target.value }))} className="h-7 text-xs" />
                  </td>
                  <td className="p-2 w-24">
                    <NumberInput
                      value={String(it.quantity ?? '')}
                      onChange={v => onApply(MC.updateItem(comparison, it.id, { quantity: parseBR(v) ?? 0 }))}
                      className="h-7 text-xs text-right"
                    />
                  </td>
                  <td className="p-2 w-28">
                    <NumberInput
                      value={it.referencePrice != null ? String(it.referencePrice) : ''}
                      onChange={v => onApply(MC.updateItem(comparison, it.id, { referencePrice: parseBR(v) }))}
                      className="h-7 text-xs text-right"
                    />
                  </td>
                  <td className="p-2 text-center">
                    <select
                      value={it.status ?? 'pendente'}
                      onChange={e => onApply(MC.setItemStatus(comparison, it.id, e.target.value as never))}
                      className="text-[11px] border border-border rounded px-1.5 py-1 bg-background"
                    >
                      <option value="pendente">Pendente</option>
                      <option value="orcado">Orçado</option>
                      <option value="comprado">Comprado</option>
                    </select>
                  </td>
                  <td className="p-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive h-7"
                      onClick={() => {
                        if (confirm(`Remover o item "${it.description}" do comparativo?`)) {
                          onApply(MC.removeItem(comparison, it.id));
                        }
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
