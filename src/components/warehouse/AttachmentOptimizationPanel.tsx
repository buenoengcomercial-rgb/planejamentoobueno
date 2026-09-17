import { useMemo, useState } from 'react';
import type { Project } from '@/types/project';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { HardDriveDownload, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { collectUnoptimizedAttachments, deletePreviousAttachment, markAttachmentCleanupPending, migrateAttachment, type MigratableAttachment } from '@/lib/attachmentMigration';

interface Props {
  project: Project;
  /** Persiste somente a coleção proprietária do anexo, nunca a obra inteira. */
  onCommitAttachmentMigration?: (before: Project, after: Project) => Promise<Project>;
}
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} MB`;

export default function AttachmentOptimizationPanel({ project, onCommitAttachmentMigration }: Props) {
  const attachments = useMemo(() => collectUnoptimizedAttachments(project), [project]);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState(0);
  const [saved, setSaved] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);

  const run = async () => {
    if (!onCommitAttachmentMigration) return;
    setRunning(true); setCurrent(0); setSaved(0); setFailed([]);
    let next = project;
    let savedTotal = 0;
    const errors: string[] = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment: MigratableAttachment = attachments[index];
      setCurrent(index + 1);
      try {
        const result = await migrateAttachment(next, attachment);
        // A referência é salva antes de remover o original. Assim, queda de rede
        // nunca deixa o registro apontando para um arquivo inexistente.
        try {
          next = await onCommitAttachmentMigration(next, result.project);
        } catch (error) {
          await deletePreviousAttachment(result.newPath).catch(() => undefined);
          throw error;
        }
        savedTotal += Math.max(0, result.originalBytes - result.storedBytes);
        setSaved(savedTotal);
        try {
          await deletePreviousAttachment(result.oldPath);
        } catch {
          if (result.oldPath) {
            try {
              next = await onCommitAttachmentMigration(
                next,
                markAttachmentCleanupPending(next, attachment.id, result.newPath, result.oldPath),
              );
              errors.push(`${attachment.name || attachment.fileName}: a cópia antiga foi preservada e a pendência de limpeza foi registrada.`);
            } catch {
              errors.push(`${attachment.name || attachment.fileName}: a cópia antiga foi preservada, mas a pendência não pôde ser registrada. Tente novamente mais tarde.`);
            }
          }
        }
      } catch (error) {
        errors.push(`${attachment.name || attachment.fileName}: ${error instanceof Error ? error.message : 'falha não identificada'}`);
      }
    }
    setFailed(errors); setRunning(false);
    if (errors.length) toast.warning(`Otimização finalizada com ${errors.length} pendência(s). Você pode executar novamente para retomar.`);
    else toast.success(`Arquivos otimizados. Economia estimada: ${mb(savedTotal)}.`);
  };

  return <section className="rounded-xl border bg-card p-4 shadow-sm">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0"><div className="flex items-center gap-2 font-bold"><HardDriveDownload className="h-4 w-4 text-primary" />Anexos antigos desta obra</div><p className="mt-1 text-sm text-muted-foreground">{attachments.length ? `${attachments.length} anexo(s) ainda usam um perfil antigo ou não avaliado.` : 'Todos os anexos carregados nesta obra já foram avaliados.'}</p></div>
      {attachments.length > 0 && <Button className="min-h-11 shrink-0" onClick={() => setOpen(true)}><HardDriveDownload className="mr-2 h-4 w-4" />Reotimizar anexos</Button>}
    </div>
    <div className="mt-3 flex gap-2 rounded-md border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground"><ShieldCheck className="h-4 w-4 shrink-0 text-primary" /><span>A nova referência é confirmada na nuvem antes de qualquer limpeza. Estoque, requisições, movimentos e auditoria não são recalculados.</span></div>
    <Dialog open={open} onOpenChange={value => !running && setOpen(value)}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>Reotimizar anexos já armazenados</DialogTitle><DialogDescription>{attachments.length} anexo(s) histórico(s) serão processados nesta obra, um por vez. A referência nova é salva e conferida antes de a cópia anterior ser removida.</DialogDescription></DialogHeader>
      {running && <div className="space-y-2"><div className="flex justify-between text-sm"><span>Processando {current} de {attachments.length}</span><span>{mb(saved)} economizados</span></div><Progress value={attachments.length ? current / attachments.length * 100 : 0} /></div>}
      {failed.length > 0 && <div className="max-h-36 overflow-auto rounded-md border border-warning/30 bg-warning/5 p-2 text-xs">{failed.map(message => <div key={message}>{message}</div>)}</div>}
      <DialogFooter><Button variant="outline" disabled={running} onClick={() => setOpen(false)}>Fechar</Button><Button disabled={running || !onCommitAttachmentMigration} onClick={() => void run()}>{running ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Processando</> : 'Iniciar otimização'}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}
