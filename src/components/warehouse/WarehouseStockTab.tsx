import { useMemo, useState } from 'react';
import type { Project } from '@/types/project';
import { computeWarehouseRows, createManualWarehouseItem, getMaterialPurchaseHistory, removeWarehouseItem, upsertItemConfig } from '@/lib/warehouse';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ExternalLink, History, Plus, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';

interface Props { project: Project; onProjectChange: (next: Project) => void; }

export default function WarehouseStockTab({ project, onProjectChange }: Props) {
  const { confirm, dialog: confirmDialog } = useConfirmDelete();
  const [search, setSearch] = useState('');
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualForm, setManualForm] = useState({ code: '', description: '', unit: '' });
  const [historyFor, setHistoryFor] = useState<{ key: string; description: string } | null>(null);
  const rows = useMemo(
    () => computeWarehouseRows(project, { materialOnly: true, confirmedOnly: true, includeManual: true }),
    [project],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => r.description.toLowerCase().includes(q) || (r.code ?? '').toLowerCase().includes(q));
  }, [rows, search]);

  const setMin = (key: string, code: string | undefined, description: string, unit: string, min: number) => {
    onProjectChange(upsertItemConfig(project, { key, code, description, unit, minStock: Number.isFinite(min) ? min : undefined }));
  };

  const createManual = () => {
    if (!manualForm.description.trim() || !manualForm.unit.trim()) return;
    onProjectChange(createManualWarehouseItem(project, manualForm));
    setManualForm({ code: '', description: '', unit: '' });
    setShowManualForm(false);
  };

  const handleDeleteItem = (key: string, description: string) => {
    confirm(
      {
        title: 'Excluir material?',
        description: (
          <div className="space-y-2">
            <p>O material <strong>{description}</strong> será removido da aba Materiais.</p>
            <p className="font-medium">Também serão removidas movimentações e vínculos do almoxarifado ligados a este material.</p>
          </div>
        ),
        confirmLabel: 'Excluir material',
      },
      () => onProjectChange(removeWarehouseItem(project, key)),
    );
  };

  return (
    <div className="bg-card border border-border rounded-md overflow-hidden">
      <div className="p-2 border-b border-border bg-muted/30 relative flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar insumo por descrição ou código..." className="h-8 pl-7 text-xs" />
        </div>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setShowManualForm(value => !value)}>
          {showManualForm ? <X className="w-3.5 h-3.5 mr-1" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
          Novo item avulso
        </Button>
        <span className="text-[11px] text-muted-foreground ml-auto">{filtered.length} item(ns)</span>
      </div>
      {showManualForm && (
        <div className="grid grid-cols-12 gap-2 border-b border-border bg-muted/10 p-2">
          <Input
            value={manualForm.code}
            onChange={e => setManualForm({ ...manualForm, code: e.target.value })}
            placeholder="Código opcional"
            className="col-span-2 h-8 text-xs"
          />
          <Input
            value={manualForm.description}
            onChange={e => setManualForm({ ...manualForm, description: e.target.value })}
            placeholder="Descrição do material avulso"
            className="col-span-7 h-8 text-xs"
          />
          <Input
            value={manualForm.unit}
            onChange={e => setManualForm({ ...manualForm, unit: e.target.value })}
            placeholder="Un."
            className="col-span-1 h-8 text-xs"
            onKeyDown={e => {
              if (e.key === 'Enter') createManual();
            }}
          />
          <Button className="col-span-2 h-8 text-xs" onClick={createManual} disabled={!manualForm.description.trim() || !manualForm.unit.trim()}>
            Criar material
          </Button>
        </div>
      )}
      <div className="max-h-[calc(100vh-300px)] overflow-auto">
        <table className="w-full text-xs table-fixed">
          <colgroup>
            <col className="w-24" />
            <col />
            <col className="w-12" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-24" />
            <col className="w-24" />
            <col className="w-24" />
            <col className="w-12" />
            <col className="w-12" />
          </colgroup>
          <thead className="bg-muted sticky top-0 z-10">
            <tr className="text-muted-foreground">
              <th className="p-2 text-left font-semibold">Código</th>
              <th className="p-2 text-left font-semibold">Descrição</th>
              <th className="p-2 text-center font-semibold">Un</th>
              <th className="p-2 text-right font-semibold">Planej.</th>
              <th className="p-2 text-right font-semibold">Comprado</th>
              <th className="p-2 text-right font-semibold">Receb.</th>
              <th className="p-2 text-right font-semibold">Retirado</th>
              <th className="p-2 text-right font-semibold">Perdas</th>
              <th className="p-2 text-right font-semibold bg-primary/5">Saldo</th>
              <th className="p-2 text-right font-semibold bg-warning/5">Mínimo</th>
              <th className="p-2 text-left font-semibold">Último mov.</th>
              <th className="p-2 text-center font-semibold">Hist.</th>
              <th className="p-2 text-center font-semibold">Excluir</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.key} className={`border-t border-border hover:bg-muted/30 ${r.underMin ? 'bg-destructive/5' : ''}`}>
                <td className="p-1.5 font-mono text-[10px] text-muted-foreground truncate">{r.code || '—'}</td>
                <td className="p-1.5 leading-snug" title={r.description}>{r.description}</td>
                <td className="p-1.5 text-center text-muted-foreground">{r.unit}</td>
                <td className="p-1.5 text-right font-mono tabular-nums">{r.planned.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono tabular-nums">{r.purchased.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono tabular-nums text-success">{r.received.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono tabular-nums">{r.withdrawn.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono tabular-nums text-destructive">{r.losses.toLocaleString('pt-BR')}</td>
                <td className={`p-1.5 text-right font-mono tabular-nums font-bold bg-primary/5 ${r.balance < 0 ? 'text-destructive' : r.underMin ? 'text-warning' : 'text-primary'}`}>{r.balance.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 bg-warning/5">
                  <input
                    type="number"
                    step="any"
                    defaultValue={r.minStock ?? ''}
                    placeholder="—"
                    className="w-full h-7 text-xs border border-border rounded px-1 text-right bg-background font-mono"
                    onBlur={e => setMin(r.key, r.code, r.description, r.unit, parseFloat(e.target.value))}
                  />
                </td>
                <td className="p-1.5 text-[10px] text-muted-foreground">{r.lastMovementDate ?? '—'}</td>
                <td className="p-1.5 text-center">
                  <Button size="icon" variant="ghost" className="h-7 w-7" title="Histórico de compras"
                    onClick={() => setHistoryFor({ key: r.key, description: r.description })}>
                    <History className="w-3.5 h-3.5" />
                  </Button>
                </td>
                <td className="p-1.5 text-center">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    title="Excluir material"
                    onClick={() => handleDeleteItem(r.key, r.description)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={13} className="p-8 text-center text-muted-foreground italic">Nenhum item encontrado.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <PurchaseHistoryDialog project={project} target={historyFor} onClose={() => setHistoryFor(null)} />
      {confirmDialog}
    </div>
  );
}

function moneyBR(value?: number) {
  if (value == null) return '—';
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function PurchaseHistoryDialog({ project, target, onClose }: { project: Project; target: { key: string; description: string } | null; onClose: () => void }) {
  const history = useMemo(() => (target ? getMaterialPurchaseHistory(project, target.key) : []), [project, target]);

  const openAttachment = async (att: NonNullable<ReturnType<typeof getMaterialPurchaseHistory>[number]['attachment']>) => {
    if (att.dataUrl) {
      window.open(att.dataUrl, '_blank', 'noopener');
      return;
    }
    if (!att.storagePath) {
      toast.error('Arquivo indisponível.');
      return;
    }
    const { data, error } = await supabase.storage
      .from('daily-report-photos')
      .createSignedUrl(att.storagePath, 60);
    if (error || !data?.signedUrl) {
      toast.error('Falha ao abrir o arquivo.');
      return;
    }
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  return (
    <Dialog open={!!target} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Histórico de compras</DialogTitle>
          <DialogDescription>{target?.description}</DialogDescription>
        </DialogHeader>
        <div className="bg-card border border-border rounded-md overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="p-2 text-left">Data</th>
                <th className="p-2 text-left">Nota</th>
                <th className="p-2 text-left">Fornecedor</th>
                <th className="p-2 text-right">Qtd</th>
                <th className="p-2 text-right">V. Unit</th>
                <th className="p-2 text-right">Total</th>
                <th className="p-2 text-center">Arquivo</th>
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h.movementId} className="border-t border-border">
                  <td className="p-2">{h.date ? h.date.split('-').reverse().join('/') : '—'}</td>
                  <td className="p-2 font-mono">{h.invoiceNumber || '—'}</td>
                  <td className="p-2">{h.supplierName || '—'}</td>
                  <td className="p-2 text-right tabular-nums">{h.quantity.toLocaleString('pt-BR')} {h.unit ?? ''}</td>
                  <td className="p-2 text-right tabular-nums">{moneyBR(h.unitPrice)}</td>
                  <td className="p-2 text-right tabular-nums font-semibold">{moneyBR(h.totalPrice)}</td>
                  <td className="p-2 text-center">
                    {h.attachment ? (
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openAttachment(h.attachment!)} title="Abrir NF">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground italic">Sem compras registradas para este material.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
