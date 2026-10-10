import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { deleteMeasuredPeriod, periodDeletionBlock, restoreMeasuredPeriod } from '@/lib/measurementLifecycle';
import { approveMeasuredPeriod, type MeasurementActor, type MeasurementWorkspace } from '@/lib/measurementWorkspace';
export interface LifecycleSelection { kind: 'delete' | 'approve' | 'restore'; id: string }
const names = { delete: 'Excluir medição', approve: 'Aprovado pela fiscalização', restore: 'Restaurar medição' };
export default function MeasurementLifecycleDialog({ selection, workspace, actor, busy, error, hasDraft, onClose, onConfirm }: {
  selection: LifecycleSelection; workspace: MeasurementWorkspace; actor: MeasurementActor; busy: boolean; error: string; hasDraft: boolean;
  onClose: () => void; onConfirm: (edit: (w: MeasurementWorkspace) => MeasurementWorkspace, selectedId: string) => void;
}) {
  const [reason, setReason] = useState('');
  const source = selection.kind === 'restore' ? workspace.audit.find(a => a.id === selection.id) : null;
  const id = source?.lifecycle?.measurementId ?? selection.id;
  const period = selection.kind === 'restore' ? source?.beforePeriods?.find(p => p.id === id) : workspace.periods.find(p => p.id === id);
  const blocked = !period ? 'Medição não encontrada.' : hasDraft ? 'Há rascunhos deste período. Finalize ou recupere os campos antes de continuar.' : selection.kind === 'delete' ? periodDeletionBlock(workspace, period) : selection.kind === 'approve' ? period.status !== 'in_review' ? 'Envie a medição para análise antes de registrar a aprovação.' : null : null;
  const count = workspace.entries.filter(e => e.measurementId === id).length;
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent>
    <DialogTitle>{names[selection.kind]} · {period?.number}ª medição</DialogTitle>
    <DialogDescription>{selection.kind === 'delete' ? `A medição sairá da sequência ativa. Seus ${count} registros e dados do boletim ficarão preservados e poderão ser recuperados pelo botão Restaurar medição excluída. Plantas e arquivos serão preservados.` : selection.kind === 'approve' ? 'Confirme somente após o aceite do fiscal e o ajuste dos quantitativos ao que ele aprovou. Esta ação torna a medição e seu boletim imutáveis. O quantitativo aprovado e o boletim ficam preservados.' : 'Recupera o período e seus quantitativos com os mesmos identificadores. A sequência e os vínculos serão conferidos antes de salvar.'}</DialogDescription>
    {selection.kind !== 'approve' && <label className="text-sm">Motivo<input aria-label="Motivo da operação" className="mt-1 w-full rounded border p-2" value={reason} onChange={e => setReason(e.target.value)} disabled={busy}/></label>}
    {blocked && <p role="alert" className="text-sm text-amber-800">{blocked}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <div className="flex justify-end gap-2"><button className="rounded border px-3 py-2 text-sm" disabled={busy} onClick={onClose}>Cancelar</button>
      <button className="rounded border bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40" disabled={busy || !!blocked || selection.kind !== 'approve' && reason.trim().length < 3 || !actor.canEdit || selection.kind === 'approve' && !actor.canReview} onClick={() => onConfirm(w => selection.kind === 'delete' ? deleteMeasuredPeriod(w, actor, id, reason) : selection.kind === 'approve' ? approveMeasuredPeriod(w, actor, id) : restoreMeasuredPeriod(w, actor, selection.id, reason), id)}>{names[selection.kind]}</button>
    </div>
  </DialogContent></Dialog>;
}
