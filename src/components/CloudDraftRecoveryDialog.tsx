import { useMemo, useState } from 'react';
import { AlertTriangle, Cloud, HardHat, Loader2, Smartphone } from 'lucide-react';
import type { Project } from '@/types/project';
import type { StoredProjectDraft } from '@/lib/cloudProjectDrafts';
import { summarizeWarehouseRecovery } from '@/lib/cloudProjectDrafts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Props {
  open: boolean;
  cloudProject: Project;
  draft: StoredProjectDraft;
  canRestore: boolean;
  onOpenChange: (open: boolean) => void;
  onUseCloud: () => Promise<void> | void;
  onRestoreWarehouse: () => Promise<void>;
}

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function VersionCard({ title, icon: Icon, project, recommended = false }: {
  title: string;
  icon: typeof Cloud;
  project: Project;
  recommended?: boolean;
}) {
  const summary = useMemo(() => summarizeWarehouseRecovery(project), [project]);
  return (
    <section className={`rounded-xl border-2 p-3 ${recommended ? 'border-primary/45 bg-primary/5' : 'border-border bg-muted/25'}`}>
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-5 w-5 text-primary" />
        <h3 className="font-extrabold">{title}</h3>
        {recommended && <Badge className="ml-auto">Conferir</Badge>}
      </div>
      <div className="grid grid-cols-3 gap-2 text-center text-sm">
        <div className="rounded-lg bg-background p-2"><strong className="block text-lg">{summary.postedNotes}</strong>Lançadas</div>
        <div className="rounded-lg bg-background p-2"><strong className="block text-lg">{summary.archivedNotes}</strong>Arquivadas</div>
        <div className="rounded-lg bg-background p-2"><strong className="block text-lg">{summary.materials}</strong>Materiais</div>
      </div>
      <div className="mt-3 max-h-44 space-y-2 overflow-y-auto">
        {summary.notes.map(note => (
          <div key={note.id} className="rounded-lg border bg-background p-2 text-sm">
            <div className="font-bold">{note.supplier}</div>
            <div className="text-muted-foreground">Nota {note.invoiceNumber} · {money(note.totalAmount)}</div>
            <div className="mt-1 text-xs">Incluído por: {note.createdBy || 'Não registrado'}</div>
          </div>
        ))}
        {!summary.notes.length && <p className="rounded-lg border border-dashed p-3 text-center text-sm text-muted-foreground">Nenhuma nota nesta versão.</p>}
      </div>
    </section>
  );
}

export default function CloudDraftRecoveryDialog({
  open,
  cloudProject,
  draft,
  canRestore,
  onOpenChange,
  onUseCloud,
  onRestoreWarehouse,
}: Props) {
  const [busy, setBusy] = useState<'cloud' | 'draft' | null>(null);
  const [error, setError] = useState('');

  const run = async (kind: 'cloud' | 'draft') => {
    if (busy) return;
    setBusy(kind);
    setError('');
    try {
      if (kind === 'cloud') await onUseCloud();
      else await onRestoreWarehouse();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível concluir a recuperação.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[94dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-warning" />Esta obra possui duas versões</DialogTitle>
          <DialogDescription>
            Compare antes de escolher. Nenhuma versão será enviada por cima da outra automaticamente.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 md:grid-cols-2">
          <VersionCard title="Dados atuais da nuvem" icon={Cloud} project={cloudProject} />
          <VersionCard title="Cópia deste aparelho" icon={Smartphone} project={draft.project} recommended />
        </div>

        <div className="rounded-lg border border-success/35 bg-success/10 p-3 text-sm">
          <div className="flex items-center gap-2 font-bold text-success"><HardHat className="h-5 w-5" />Equipamentos serão preservados</div>
          <p className="mt-1 text-muted-foreground">Restaurar a cópia deste aparelho altera somente o Almoxarifado. Patrimônios, fotos, equipamentos e os demais módulos da obra permanecerão como estão na nuvem.</p>
        </div>

        {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" disabled={!!busy} onClick={() => onOpenChange(false)}>Voltar e revisar</Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" disabled={!!busy} onClick={() => void run('cloud')}>
              {busy === 'cloud' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Usar dados da nuvem
            </Button>
            <Button disabled={!canRestore || !!busy} onClick={() => void run('draft')}>
              {busy === 'draft' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Restaurar Almoxarifado deste aparelho
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
