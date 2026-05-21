import { useState } from 'react';
import type { Project } from '@/types/project';
import * as MC from '@/lib/materialComparisons';
import { Button } from '@/components/ui/button';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { Input } from '@/components/ui/input';
import { Plus, Trash2, Star } from 'lucide-react';
import { NumberInput, parseBR } from './numberInput';

interface Props {
  project: Project;
  onProjectChange: (next: Project | ((prev: Project) => Project)) => void;
}

export default function SuppliersTab({ project, onProjectChange }: Props) {
  const suppliers = MC.getProjectSuppliers(project);
  const { confirm, dialog: confirmDialog } = useConfirmDelete();
  const [form, setForm] = useState({ name: '', contact: '', deliveryDays: '', rating: '' });

  const add = () => {
    if (!form.name.trim()) return;
    onProjectChange(prev => MC.addProjectSupplier(prev, {
      name: form.name.trim(),
      contact: form.contact || undefined,
      deliveryDays: parseBR(form.deliveryDays),
      rating: parseBR(form.rating),
    }));
    setForm({ name: '', contact: '', deliveryDays: '', rating: '' });
  };

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-semibold">Adicionar fornecedor (global do projeto)</h3>
        <p className="text-[11px] text-muted-foreground">Fornecedores cadastrados aqui aparecem em todos os comparativos.</p>
        <div className="grid grid-cols-12 gap-2">
          <Input className="col-span-4" placeholder="Nome" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <Input className="col-span-4" placeholder="Contato (telefone/e-mail)" value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} />
          <NumberInput className="col-span-2" placeholder="Prazo (dias)" decimal={false} value={form.deliveryDays} onChange={v => setForm({ ...form, deliveryDays: v })} />
          <NumberInput className="col-span-1" placeholder="0-5" value={form.rating} onChange={v => setForm({ ...form, rating: v })} />
          <Button className="col-span-1" onClick={add}><Plus className="w-4 h-4" /></Button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-muted/30 text-xs uppercase font-semibold tracking-wide">
          Fornecedores ({suppliers.length})
        </div>
        {suppliers.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Nenhum fornecedor cadastrado ainda.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted">
              <tr>
                <th className="p-2 text-left">Nome</th>
                <th className="p-2 text-left">Contato</th>
                <th className="p-2 text-center">Prazo (dias)</th>
                <th className="p-2 text-center">Avaliação</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map(s => (
                <tr key={s.id} className="border-t border-border hover:bg-muted/20">
                  <td className="p-2"><Input value={s.name} onChange={e => onProjectChange(prev => MC.updateProjectSupplier(prev, s.id, { name: e.target.value }))} className="h-7 text-xs" /></td>
                  <td className="p-2"><Input value={s.contact ?? ''} onChange={e => onProjectChange(prev => MC.updateProjectSupplier(prev, s.id, { contact: e.target.value }))} className="h-7 text-xs" /></td>
                  <td className="p-2 w-24">
                    <NumberInput
                      decimal={false}
                      value={s.deliveryDays != null ? String(s.deliveryDays) : ''}
                      onChange={v => onProjectChange(prev => MC.updateProjectSupplier(prev, s.id, { deliveryDays: parseBR(v) }))}
                      className="h-7 text-xs text-center"
                    />
                  </td>
                  <td className="p-2 w-24 text-center">
                    <div className="inline-flex items-center gap-1">
                      <Star className="w-3 h-3 text-warning" />
                      <NumberInput
                        value={s.rating != null ? String(s.rating) : ''}
                        onChange={v => onProjectChange(prev => MC.updateProjectSupplier(prev, s.id, { rating: parseBR(v) }))}
                        className="h-7 text-xs text-center w-16"
                      />
                    </div>
                  </td>
                  <td className="p-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive h-7"
                      onClick={() => {
                        confirm(
                          {
                            title: `Remover o fornecedor "${s.name}"?`,
                            description: (
                              <p>
                                Os preços lançados por ele em todos os comparativos serão removidos.
                              </p>
                            ),
                            confirmLabel: 'Remover fornecedor',
                          },
                          () => onProjectChange(prev => MC.removeProjectSupplier(prev, s.id)),
                        );
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
      {confirmDialog}
    </div>
  );
}
