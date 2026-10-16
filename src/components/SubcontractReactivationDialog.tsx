import { useEffect, useState } from 'react';
import type { Project, Subcontract } from '@/types/project';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { fmtBRL } from '@/components/measurement/measurementFormat';
import { logToProject, type AuditUserInfo } from '@/lib/audit';
import { reactivateSubcontract, reactivationAvailability, type ReactivationCatalogItem } from '@/lib/subcontractReactivation';
import { registerPendingForm } from '@/lib/pendingFormNavigation';
import { subcontractPaidValue } from '@/lib/subcontracts';

export function SubcontractReactivationDialog({ project, contract, catalog, actor, onCommit, onClose }: {
  project: Project; contract: Subcontract; catalog: ReactivationCatalogItem[]; actor?: AuditUserInfo;
  onCommit: (next: Project, base: Project) => Promise<void>; onClose: () => void;
}) {
  const availability = reactivationAvailability(contract, project.subcontracts ?? [], catalog);
  const [selected, setSelected] = useState(() => availability.filter(x => x.free).map(x => x.item.id));
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => registerPendingForm(`reactivation:${project.id}:${contract.id}`, 'Reativação de contrato', () => true), [project.id, contract.id]);
  const amount = Number(value.replace(',', '.'));
  const valid = selected.length > 0 && selected.every(id => availability.some(x => x.item.id === id && x.free))
    && value.trim() !== '' && Number.isFinite(amount) && amount > 0 && Math.round(amount * 100) / 100 === amount
    && amount >= subcontractPaidValue(contract) && reason.trim() !== '';
  async function confirm() {
    if (saving || !valid) return;
    setSaving(true); setError('');
    try {
      const next = reactivateSubcontract(contract, project.subcontracts ?? [], catalog, selected, amount, reason, new Date().toISOString(), actor?.userId);
      const candidate = logToProject({ ...project, subcontracts: (project.subcontracts ?? []).map(c => c.id === contract.id ? next : c) }, {
        ...actor, entityType: 'subcontract', entityId: contract.id, action: 'updated', title: 'Contrato terceirizado reativado', description: reason.trim(),
      });
      await onCommit(candidate, project);
      onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível confirmar. Revise e tente novamente.'); }
    finally { setSaving(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" onInteractOutside={e => { if (saving) e.preventDefault(); }}>
      <DialogHeader><DialogTitle>Reativar contrato: {contract.name}</DialogTitle><DialogDescription>Revise as atividades livres e informe o novo total. Pagamentos e histórico anteriores serão preservados.</DialogDescription></DialogHeader>
      <h3 className="font-medium">Atividades livres</h3>
      {!availability.some(x => x.free) && <p role="status">Nenhuma atividade está livre para reativação.</p>}
      {availability.filter(x => x.free).map(({item}) => <label key={item.id} className="flex min-h-11 items-center gap-3 rounded border p-3 text-sm">
        <input type="checkbox" disabled={saving} checked={selected.includes(item.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))} />
        <span className="min-w-0 break-words">{item.item} · {item.description}</span>
      </label>)}
      {availability.some(x => !x.free) && <section className="space-y-2"><h3 className="font-medium">Ocupadas ou com vínculo a revisar</h3>{availability.filter(x => !x.free).map(({item, owners, issue}) => <div key={item.id} className="rounded border bg-muted p-3 text-sm"><p>{item.item} · {item.description}</p><p className="text-muted-foreground">{issue || `Vinculada a: ${owners.map(c => `${c.name} (${c.status === 'draft' ? 'rascunho' : 'contratado'})`).join(', ')}`}</p></div>)}</section>}
      <label className="space-y-1 text-sm">Novo valor total do contrato<Input aria-label="Novo valor total do contrato" inputMode="decimal" value={value} disabled={saving} onChange={e => setValue(e.target.value)} /></label>
      <p className="text-sm text-muted-foreground">Total revisado, incluindo os pagamentos anteriores. Valor líquido já pago: {fmtBRL(subcontractPaidValue(contract))}.</p>
      <label className="space-y-1 text-sm">Motivo da reativação<Textarea aria-label="Motivo da reativação" value={reason} disabled={saving} onChange={e => setReason(e.target.value)} /></label>
      <p className="text-sm">{selected.length} atividade(s) selecionada(s). As demais permanecem no histórico.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={saving} onClick={onClose}>Voltar</Button><Button disabled={!valid || saving} onClick={() => void confirm()}>{saving ? 'Confirmando na nuvem…' : 'Confirmar reativação'}</Button></div>
    </DialogContent>
  </Dialog>;
}
