import { useMemo, useState } from 'react';
import type { Project } from '@/types/project';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { HardDriveDownload, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { collectUnoptimizedAttachments, deletePreviousAttachment, migrateAttachment, type MigratableAttachment } from '@/lib/attachmentMigration';

interface Props { project: Project; onProjectChange: (project: Project) => void; onCommitProject?: (project: Project) => Promise<void>; }
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} MB`;

export default function AttachmentOptimizationPanel({ project, onProjectChange, onCommitProject }: Props) {
  const attachments = useMemo(() => collectUnoptimizedAttachments(project), [project]);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState(0);
  const [saved, setSaved] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);

  const run = async () => {
    if (!onCommitProject) return;
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
          await onCommitProject(result.project);
          onProjectChange(result.project);
        } catch (error) {
          await deletePreviousAttachment(result.newPath).catch(() => undefined);
          throw error;
        }
        next = result.project;
        savedTotal += Math.max(0, result.originalBytes - result.storedBytes);
        setSaved(savedTotal);
        try { await deletePreviousAttachment(result.oldPath); } catch { errors.push(`${attachment.name || attachment.fileName}: a cópia antiga ficou pendente de limpeza.`); }
      } catch (error) {
        errors.push(`${attachment.name || attachment.fileName}: ${error instanceof Error ? error.message : 'falha não identificada'}`);
      }
    }
    setFailed(errors); setRunning(false);
    if (errors.length) toast.warning(`Otimização finalizada com ${errors.length} pendência(s). Você pode executar novamente para retomar.`);
    else toast.success(`Arquivos otimizados. Economia estimada: ${mb(savedTotal)}.`);
  };

  if (!attachments.length) return null;
  return <><Button variant="outline" className="min-h-11" onClick={() => setOpen(true)}><HardDriveDownload className="mr-2 h-4 w-4" />Otimizar arquivos</Button>
    <Dialog open={open} onOpenChange={value => !running && setOpen(value)}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>Otimizar arquivos já armazenados</DialogTitle><DialogDescription>{attachments.length} anexo(s) histórico(s) serão processados nesta obra. A referência nova é salva e conferida antes de a cópia antiga ser removida.</DialogDescription></DialogHeader>
      {running && <div className="space-y-2"><div className="flex justify-between text-sm"><span>Processando {current} de {attachments.length}</span><span>{mb(saved)} economizados</span></div><Progress value={attachments.length ? current / attachments.length * 100 : 0} /></div>}
      {failed.length > 0 && <div className="max-h-36 overflow-auto rounded-md border border-warning/30 bg-warning/5 p-2 text-xs">{failed.map(message => <div key={message}>{message}</div>)}</div>}
      <DialogFooter><Button variant="outline" disabled={running} onClick={() => setOpen(false)}>Fechar</Button><Button disabled={running || !onCommitProject} onClick={() => void run()}>{running ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Processando</> : 'Iniciar otimização'}</Button></DialogFooter>
    </DialogContent></Dialog></>;
}
