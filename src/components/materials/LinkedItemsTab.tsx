import type { MaterialComparison } from '@/types/project';
import * as MC from '@/lib/materialComparisons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Trash2, Lock } from 'lucide-react';
import { formatBRL, formatQty } from './numberInput';

interface Props {
  comparison: MaterialComparison;
  onApply: (next: MaterialComparison) => void;
}

const DETAIL_LABEL: Record<string, string> = {
  contracted_item: 'Item contratado',
  additive_existing_changed: 'Item contratado alterado',
  additive_new_service: 'Novo serviço aditivado',
};
const DETAIL_BADGE: Record<string, string> = {
  contracted_item: 'bg-muted text-muted-foreground border-border',
  additive_existing_changed: 'bg-warning/15 text-warning border-warning/40',
  additive_new_service: 'bg-primary/15 text-primary border-primary/40',
};

function originBadge(sourceType?: string, detail?: string) {
  if (sourceType === 'additive_input' && detail) {
    return { label: DETAIL_LABEL[detail] ?? 'Aditivo', cls: DETAIL_BADGE[detail] ?? 'bg-muted text-muted-foreground border-border' };
  }
  if (sourceType === 'task_material') return { label: 'Material manual', cls: 'bg-muted text-muted-foreground border-border' };
  if (sourceType === 'analytic_input') return { label: 'Analítico do contrato', cls: 'bg-secondary text-secondary-foreground border-border' };
  if (sourceType === 'manual' || !sourceType) return { label: 'Manual', cls: 'bg-muted text-muted-foreground border-border' };
  return { label: 'Aditivo', cls: 'bg-muted text-muted-foreground border-border' };
}

export default function LinkedItemsTab({ comparison, onApply }: Props) {
  if (comparison.items.length === 0) {
    return (
      <div className="bg-card border border-dashed border-border rounded-lg p-10 text-center text-sm text-muted-foreground">
        Nenhum item vinculado. Vá em "Insumos do Projeto" para selecionar.
      </div>
    );
  }
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="max-h-[calc(100vh-260px)] overflow-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted sticky top-0 z-10">
            <tr>
              <th className="p-2 text-left">Código</th>
              <th className="p-2 text-left">Descrição</th>
              <th className="p-2">Un.</th>
              <th className="p-2 text-right">Qtd.</th>
              <th className="p-2 text-right">Preço ref.</th>
              <th className="p-2 text-left">Origem</th>
              <th className="p-2 text-left">Grupo de compra</th>
              <th className="p-2 text-center">Status</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {comparison.items.map(it => {
              const isManual = (it.sourceType ?? 'manual') === 'manual';
              const badge = originBadge(it.sourceType, it.sourceDetail);
              return (
                <tr key={it.id} className="border-t border-border hover:bg-muted/30">
                  <td className="p-2 font-mono text-[11px]">{it.code || '—'}</td>
                  <td className="p-2 min-w-[220px]">{it.description}</td>
                  <td className="p-2 text-center text-muted-foreground">{it.unit}</td>
                  <td className="p-2 text-right font-mono">{formatQty(it.quantity)}</td>
                  <td className="p-2 text-right font-mono">{it.referencePrice != null ? formatBRL(it.referencePrice) : '—'}</td>
                  <td className="p-2">
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${badge.cls}`}>
                      {!isManual && <Lock className="w-2.5 h-2.5" />}
                      {badge.label}
                    </span>
                  </td>
                  <td className="p-2 w-44">
                    <Input
                      value={it.purchaseGroup ?? ''}
                      onChange={e => onApply(MC.updateItem(comparison, it.id, { purchaseGroup: e.target.value }))}
                      placeholder="ex.: PVC CONEXÕES"
                      className="h-7 text-[11px]"
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
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
