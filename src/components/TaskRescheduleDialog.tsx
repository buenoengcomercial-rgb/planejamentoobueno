import { useEffect, useMemo, useState } from 'react';
import type { Project, Task } from '@/types/project';
import type { AuditUserInfo } from '@/lib/audit';
import { createRescheduleRequest, reschedulePreview } from '@/lib/taskRescheduling';
import type { ObraConfig } from '@/components/ConfiguracaoObra';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  task?: Task;
  config: ObraConfig;
  actor: AuditUserInfo;
  canRequest: boolean;
  canApprove: boolean;
  onSubmit: (request: ReturnType<typeof createRescheduleRequest>, approveNow: boolean) => void;
  onApprove: (requestId: string) => void;
  onReject: (requestId: string, reason: string) => void;
}

export default function TaskRescheduleDialog({ open, onOpenChange, project, task, config, actor, canRequest, canApprove, onSubmit, onApprove, onReject }: Props) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [decisionReason, setDecisionReason] = useState('');
  useEffect(() => {
    if (!open) return;
    setDate(task?.operationalReschedule?.startDate ?? task?.startDate ?? '');
    setReason('');
    setDecisionReason('');
  }, [open, task?.id, task?.startDate, task?.operationalReschedule?.startDate]);

  const pending = useMemo(() => (project.rescheduleRequests ?? []).find(item => item.taskId === task?.id && item.status === 'pending'), [project.rescheduleRequests, task?.id]);
  const preview = useMemo(() => task && date ? reschedulePreview(task, date, config) : undefined, [config, date, task]);
  if (!task) return null;

  const submit = () => {
    if (!date || !reason.trim()) return;
    const request = createRescheduleRequest(task, date, reason, config, actor);
    onSubmit(request, canApprove);
    onOpenChange(false);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Reprogramar atividade</DialogTitle>
        <DialogDescription className="line-clamp-2">{task.name}</DialogDescription>
      </DialogHeader>
      {pending ? <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
        <p><strong>Aguardando aprovação.</strong> Nova programação: {pending.proposedStartDate} a {pending.proposedEndDate}.</p>
        <p>Motivo: {pending.reason}</p>
        {canApprove && <>
          <Label htmlFor="reschedule-rejection">Motivo da rejeição (opcional)</Label>
          <Textarea id="reschedule-rejection" value={decisionReason} onChange={event => setDecisionReason(event.target.value)} placeholder="Informe caso rejeite a solicitação" />
          <DialogFooter>
            <Button variant="outline" onClick={() => { onReject(pending.id, decisionReason); onOpenChange(false); }}>Rejeitar</Button>
            <Button onClick={() => { onApprove(pending.id); onOpenChange(false); }}>Aprovar reprogramação</Button>
          </DialogFooter>
        </>}
      </div> : <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/50 p-3 text-sm">
          <div><span className="block text-muted-foreground">Plano original</span>{task.baseline?.startDate ?? task.startDate} • {task.baseline?.duration ?? task.duration} dia(s)</div>
          <div><span className="block text-muted-foreground">Produção real</span>{preview?.executed ?? 0} de {task.quantity ?? 0} {task.unit ?? ''}</div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="reschedule-date">{preview?.scope === 'remaining_work' ? 'Retomada do saldo' : 'Novo início'}</Label>
          <Input id="reschedule-date" type="date" value={date} onChange={event => setDate(event.target.value)} disabled={!canRequest} />
        </div>
        {preview && <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-sm">
          <strong>Prévia:</strong> {preview.scope === 'remaining_work' ? 'saldo restante' : 'atividade completa'} de {preview.quantity} {task.unit ?? ''}, {preview.duration} dia(s) úteis, término em <strong>{preview.endDate}</strong>. Acréscimo de {preview.delayDuration.toLocaleString('pt-BR')} dia(s) útil(eis) conforme a nova data escolhida.
        </div>}
        <div className="space-y-2">
          <Label htmlFor="reschedule-reason">Motivo</Label>
          <Textarea id="reschedule-reason" value={reason} onChange={event => setReason(event.target.value)} placeholder="Ex.: frente liberada posteriormente" disabled={!canRequest} />
        </div>
        {canRequest && <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={submit} disabled={!date || !reason.trim()}>{canApprove ? 'Confirmar reprogramação' : 'Solicitar aprovação'}</Button>
        </DialogFooter>}
      </div>}
    </DialogContent>
  </Dialog>;
}
