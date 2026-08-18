import { useMemo, useState } from 'react';
import type { Project, WarehouseAuditActor } from '@/types/project';
import {
  computeWarehouseRows,
  createManualWarehouseItem,
  getMaterialPurchaseHistory,
  removeWarehouseItem,
  unlinkWarehouseProjectMaterial,
  upsertItemConfig,
  upsertWarehouseProjectMaterialLink,
} from '@/lib/warehouse';
import { suggestMaterialsFromProject } from '@/lib/materialComparisons';
import { downloadWarehouseAttachment, openWarehouseAttachment, warehouseAttachmentErrorMessage } from '@/lib/warehouseAttachments';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Archive, Download, Eye, History, Link2, Plus, Search, Unlink, X } from 'lucide-react';
import { toast } from 'sonner';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';

interface Props { project: Project; onProjectChange: (next: Project) => void; auditActor?: WarehouseAuditActor; }

export default function WarehouseStockTab({ project, onProjectChange, auditActor }: Props) {
  const { confirm, dialog: confirmDialog } = useConfirmDelete();
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);
  const [linkFilter, setLinkFilter] = useState<'all' | 'linked' | 'pending' | 'unplanned'>('all');
  const [purchaseGroupFilter, setPurchaseGroupFilter] = useState('all');
  const [lowOnly, setLowOnly] = useState(false);
  const [zeroOnly, setZeroOnly] = useState(false);
  const [manualForm, setManualForm] = useState({ code: '', description: '', unit: '' });
  const [historyFor, setHistoryFor] = useState<{ key: string; description: string } | null>(null);
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const rows = useMemo(
    () => computeWarehouseRows(project, { materialOnly: true, confirmedOnly: true, includeManual: true, includeArchived: showArchived }),
    [project, showArchived],
  );
  const archivedCount = project.warehouse?.items.filter(item => !!item.archivedAt).length ?? 0;
  const purchaseGroups = useMemo(() => (project.materialComparisons ?? [])
    .map(comparison => ({ id: comparison.id, name: comparison.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')), [project.materialComparisons]);
  const projectMaterials = useMemo(() => suggestMaterialsFromProject(project).filter(material => material.quantity > 0), [project]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => (!q || r.description.toLowerCase().includes(q) || (r.code ?? '').toLowerCase().includes(q))
      && (linkFilter === 'all' || r.linkStatus === linkFilter)
      && (purchaseGroupFilter === 'all' || r.purchaseGroupId === purchaseGroupFilter)
      && (!lowOnly || r.underMin)
      && (!zeroOnly || r.balance === 0));
  }, [linkFilter, lowOnly, purchaseGroupFilter, rows, search, zeroOnly]);

  const setMin = (key: string, code: string | undefined, description: string, unit: string, min: number) => {
    onProjectChange(upsertItemConfig(project, { key, code, description, unit, minStock: Number.isFinite(min) ? min : undefined }));
  };

  const createManual = () => {
    if (!manualForm.description.trim() || !manualForm.unit.trim()) return;
    onProjectChange(createManualWarehouseItem(project, manualForm));
    setManualForm({ code: '', description: '', unit: '' });
    setShowManualForm(false);
  };

  const handleArchiveItem = (key: string, description: string) => {
    confirm(
      {
        title: 'Arquivar e ocultar material?',
        description: (
          <div className="space-y-2">
            <p>O material <strong>{description}</strong> será ocultado das operações correntes.</p>
            <p className="font-medium">Saldo, notas, retiradas, vínculos e histórico permanecerão preservados para auditoria.</p>
          </div>
        ),
        confirmLabel: 'Arquivar e ocultar',
      },
      () => onProjectChange(removeWarehouseItem(project, key)),
    );
  };

  return (
    <div className="bg-card border border-border rounded-md overflow-hidden">
      <div className="relative flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 p-2">
        <div className="relative w-full sm:max-w-sm sm:flex-1">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar insumo por descrição ou código..." className="min-h-11 pl-8 text-sm" />
        </div>
        <select className="min-h-11 rounded border bg-background px-2 text-sm" value={linkFilter} onChange={event => setLinkFilter(event.target.value as typeof linkFilter)} aria-label="Filtrar por vínculo"><option value="all">Todos os vínculos</option><option value="linked">Vinculados</option><option value="pending">Vínculo pendente</option><option value="unplanned">Não previstos</option></select>
        <select className="min-h-11 max-w-full rounded border bg-background px-2 text-sm" value={purchaseGroupFilter} onChange={event => setPurchaseGroupFilter(event.target.value)} aria-label="Filtrar por grupo de compra"><option value="all">Todos os grupos</option>{purchaseGroups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
        <Button size="sm" variant={lowOnly ? 'secondary' : 'outline'} className="min-h-11 text-xs" onClick={() => setLowOnly(value => !value)}>Estoque baixo</Button>
        <Button size="sm" variant={zeroOnly ? 'secondary' : 'outline'} className="min-h-11 text-xs" onClick={() => setZeroOnly(value => !value)}>Saldo zerado</Button>
        <Button size="sm" variant="outline" className="min-h-11 text-xs" onClick={() => setShowManualForm(value => !value)}>
          {showManualForm ? <X className="w-3.5 h-3.5 mr-1" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
          Novo item avulso
        </Button>
        {archivedCount > 0 && (
          <Button size="sm" variant={showArchived ? 'secondary' : 'outline'} className="min-h-11 text-xs" onClick={() => setShowArchived(value => !value)}>
            <Archive className="mr-1 h-3.5 w-3.5" />
            {showArchived ? 'Ocultar arquivados' : `Exibir arquivados (${archivedCount})`}
          </Button>
        )}
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
        <div className="space-y-2 p-2 md:hidden">{filtered.map(row => <article key={row.key} className={`space-y-3 rounded-md border p-3 ${row.underMin ? 'border-warning/50 bg-warning/5' : ''}`}><div className="flex items-start justify-between gap-2"><div><div className="text-xs text-muted-foreground">{row.code || 'Sem código'} · {row.unit}</div><div className="font-semibold">{row.description}</div></div><Badge variant="outline" className={row.linkStatus === 'linked' ? 'text-success' : row.linkStatus === 'unplanned' ? 'text-warning' : ''}>{row.linkStatus === 'linked' ? 'Vinculado' : row.linkStatus === 'unplanned' ? 'Não previsto' : 'Vínculo pendente'}</Badge></div><dl className="grid grid-cols-2 gap-2 text-sm"><div><dt className="text-xs text-muted-foreground">Saldo disponível</dt><dd className="font-semibold text-primary">{row.balance.toLocaleString('pt-BR')} {row.unit}</dd></div><div><dt className="text-xs text-muted-foreground">Estoque mínimo</dt><dd>{row.minStock?.toLocaleString('pt-BR') ?? '—'}</dd></div><div><dt className="text-xs text-muted-foreground">Custo médio</dt><dd>{row.valuationIncomplete || row.averageUnitCost == null ? 'Cálculo incompleto' : row.averageUnitCost.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</dd></div><div><dt className="text-xs text-muted-foreground">Último movimento</dt><dd>{row.lastMovementDate || '—'}</dd></div></dl><div className="grid grid-cols-3 gap-2"><Button variant="outline" className="min-h-11" onClick={() => setLinkFor(row.key)}><Link2 className="h-4 w-4" /><span className="sr-only">Revisar vínculos</span></Button><Button variant="outline" className="min-h-11" onClick={() => setHistoryFor({ key: row.key, description: row.description })}><History className="h-4 w-4" /><span className="sr-only">Histórico</span></Button><Button variant="outline" className="min-h-11 text-destructive" onClick={() => handleArchiveItem(row.key, row.description)}><Archive className="h-4 w-4" /><span className="sr-only">Arquivar</span></Button></div></article>)}</div>
        <table className="hidden w-full table-fixed text-xs md:table">
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
            <col className="w-28" />
            <col className="w-36" />
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
              <th className="p-2 text-right font-semibold">Custo médio</th>
              <th className="p-2 text-left font-semibold">Vínculo</th>
              <th className="p-2 text-center font-semibold">Hist.</th>
              <th className="p-2 text-center font-semibold">Arquivar</th>
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
                <td className="p-1.5 text-right font-mono text-[11px]">{r.valuationIncomplete || r.averageUnitCost == null ? 'Cálculo incompleto' : r.averageUnitCost.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
                <td className="p-1.5"><Button size="sm" variant="ghost" className="h-auto min-h-8 justify-start gap-1 px-1" onClick={() => setLinkFor(r.key)}><Link2 className="h-3.5 w-3.5" /><Badge variant="outline" className={r.linkStatus === 'linked' ? 'border-success/30 text-success' : r.linkStatus === 'unplanned' ? 'border-warning/30 text-warning' : ''}>{r.linkStatus === 'linked' ? `${r.projectLinks.length} vinculado(s)` : r.linkStatus === 'unplanned' ? 'Não previsto' : 'Pendente'}</Badge></Button></td>
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
                    title="Arquivar e ocultar material"
                    onClick={() => handleArchiveItem(r.key, r.description)}
                  >
                    <Archive className="w-3.5 h-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={15} className="p-8 text-center text-muted-foreground italic">Nenhum item encontrado.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <MaterialLinkDialog
        key={linkFor ?? 'closed'}
        project={project}
        itemKey={linkFor}
        projectMaterials={projectMaterials}
        auditActor={auditActor}
        onProjectChange={onProjectChange}
        onClose={() => setLinkFor(null)}
      />
      <PurchaseHistoryDialog project={project} target={historyFor} onClose={() => setHistoryFor(null)} />
      {confirmDialog}
    </div>
  );
}

function MaterialLinkDialog({ project, itemKey, projectMaterials, auditActor, onProjectChange, onClose }: {
  project: Project;
  itemKey: string | null;
  projectMaterials: ReturnType<typeof suggestMaterialsFromProject>;
  auditActor?: WarehouseAuditActor;
  onProjectChange: (project: Project) => void;
  onClose: () => void;
}) {
  const row = useMemo(() => itemKey ? computeWarehouseRows(project, { includeManual: true, includeArchived: true }).find(candidate => candidate.key === itemKey) : undefined, [itemKey, project]);
  const [projectMaterialKey, setProjectMaterialKey] = useState('');
  const [conversionFactor, setConversionFactor] = useState('1');
  const [unplannedReason, setUnplannedReason] = useState(row?.unplannedReason || '');
  const selectedMaterial = projectMaterials.find(material => material.key === projectMaterialKey);

  const addLink = () => {
    if (!row || !selectedMaterial) return toast.error('Selecione um insumo previsto.');
    const factor = Number(conversionFactor.replace(',', '.'));
    try {
      onProjectChange(upsertWarehouseProjectMaterialLink(project, {
        warehouseItemKey: row.key,
        projectMaterialKey: selectedMaterial.key,
        projectMaterialCode: selectedMaterial.code,
        projectMaterialDescription: selectedMaterial.description,
        projectMaterialUnit: selectedMaterial.unit,
        conversionFactor: factor,
        source: 'manual',
      }, auditActor));
      setProjectMaterialKey('');
      setConversionFactor('1');
      toast.success('Vínculo confirmado. O previsto foi incorporado ao material canônico.');
    } catch (error) { toast.error((error as Error).message); }
  };

  const markUnplanned = () => {
    if (!row || !unplannedReason.trim()) return toast.error('Informe a justificativa do material não previsto.');
    onProjectChange(upsertItemConfig(project, {
      key: row.key,
      code: row.code,
      description: row.description,
      unit: row.unit,
      manualItem: row.manualItem,
      minStock: row.minStock,
      purchaseGroupId: row.purchaseGroupId,
      unplannedReason: unplannedReason.trim(),
    }));
    toast.success('Material classificado como não previsto.');
  };

  return <Dialog open={!!itemKey} onOpenChange={open => !open && onClose()}><DialogContent className="max-w-3xl"><DialogHeader><DialogTitle>Revisar vínculos do material</DialogTitle><DialogDescription>{row?.description} · Um material físico pode representar mais de um insumo previsto.</DialogDescription></DialogHeader>{row && <div className="space-y-4"><div className="grid gap-3 rounded-md border p-3 md:grid-cols-[1fr_130px_auto]"><div><label className="mb-1 block text-xs font-semibold">Insumo previsto</label><select className="min-h-11 w-full rounded-md border bg-background px-3 text-sm" value={projectMaterialKey} onChange={event => { const key = event.target.value; setProjectMaterialKey(key); const material = projectMaterials.find(candidate => candidate.key === key); setConversionFactor(material && material.unit.trim().toLowerCase() === row.unit.trim().toLowerCase() ? '1' : ''); }}><option value="">Selecionar no orçamento</option>{projectMaterials.map(material => <option key={material.key} value={material.key}>{material.code ? `${material.code} · ` : ''}{material.description} ({material.quantity} {material.unit})</option>)}</select></div><div><label className="mb-1 block text-xs font-semibold">Conversão</label><Input className="min-h-11 text-center" value={conversionFactor} onChange={event => setConversionFactor(event.target.value)} placeholder="Fator" /></div><Button className="min-h-11 self-end" onClick={addLink}><Link2 className="mr-2 h-4 w-4" />Vincular</Button></div><div><h4 className="mb-2 text-sm font-semibold">Vínculos confirmados</h4>{row.projectLinks.map(link => <div key={link.id} className="flex min-h-11 items-center gap-2 border-t py-2"><span className="min-w-0 flex-1 text-sm">{link.projectMaterialCode ? `${link.projectMaterialCode} · ` : ''}{link.projectMaterialDescription} ({link.projectMaterialUnit})</span><span className="text-xs text-muted-foreground">fator {link.conversionFactor}</span><Button size="icon" variant="ghost" className="min-h-11 min-w-11 text-destructive" onClick={() => onProjectChange(unlinkWarehouseProjectMaterial(project, link.id, auditActor))} aria-label={`Desvincular ${link.projectMaterialDescription}`}><Unlink className="h-4 w-4" /></Button></div>)}{!row.projectLinks.length && <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">Nenhum vínculo confirmado.</div>}</div>{!row.projectLinks.length && <div className="rounded-md border border-warning/30 bg-warning/5 p-3"><label className="mb-1 block text-xs font-semibold">Ou classifique como material não previsto</label><div className="flex gap-2"><Input className="min-h-11" value={unplannedReason} onChange={event => setUnplannedReason(event.target.value)} placeholder="Justificativa obrigatória" /><Button variant="outline" className="min-h-11" onClick={markUnplanned}>Confirmar</Button></div></div>}</div>}<div className="flex justify-end"><Button variant="outline" onClick={onClose}>Fechar</Button></div></DialogContent></Dialog>;
}

function moneyBR(value?: number) {
  if (value == null) return '—';
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function PurchaseHistoryDialog({ project, target, onClose }: { project: Project; target: { key: string; description: string } | null; onClose: () => void }) {
  const history = useMemo(() => (target ? getMaterialPurchaseHistory(project, target.key) : []), [project, target]);

  const openAttachment = async (att: NonNullable<ReturnType<typeof getMaterialPurchaseHistory>[number]['attachment']>) => {
    try {
      await openWarehouseAttachment(att);
    } catch (error) {
      toast.error(warehouseAttachmentErrorMessage(error));
    }
  };

  const downloadAttachment = async (att: NonNullable<ReturnType<typeof getMaterialPurchaseHistory>[number]['attachment']>) => {
    try {
      await downloadWarehouseAttachment(att);
    } catch (error) {
      toast.error(warehouseAttachmentErrorMessage(error));
    }
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
                      <div className="flex items-center justify-center gap-1">
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void openAttachment(h.attachment!)} title="Visualizar NF" aria-label="Visualizar NF">
                          <Eye className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void downloadAttachment(h.attachment!)} title="Baixar NF" aria-label="Baixar NF">
                          <Download className="w-3.5 h-3.5" />
                        </Button>
                      </div>
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
