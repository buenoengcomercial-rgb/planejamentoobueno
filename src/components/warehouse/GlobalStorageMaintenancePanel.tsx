import { useMemo, useState } from 'react';
import type { Project } from '@/types/project';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { AlertTriangle, DatabaseZap, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { auditOrganizationStorage, deletePreviousAttachment, migrateAttachment } from '@/lib/attachmentMigration';
import { auditStorageMaintenance, deleteStorageOrphans, recordStorageOptimization, type StorageMaintenanceReport } from '@/lib/storageMaintenance';

interface Props {
  currentProject: Project;
  onCurrentProjectChange: (project: Project) => void;
  saveProject: (project: Project, expectedUpdatedAt: string) => Promise<string>;
  organizationId: string;
}
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} MB`;

export default function GlobalStorageMaintenancePanel({ currentProject, onCurrentProjectChange, saveProject, organizationId }: Props) {
  const [open, setOpen] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<StorageMaintenanceReport | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, saved: 0 });
  const [confirmOrphanDeletion, setConfirmOrphanDeletion] = useState(false);
  const [selectedOrphans, setSelectedOrphans] = useState<string[]>([]);
  const totals = useMemo(() => ({
    files: report?.totalFiles ?? 0,
    bytes: report?.totalBytes ?? 0,
    candidates: report?.groups.reduce((sum, entry) => sum + entry.pending, 0) ?? 0,
    orphaned: report?.groups.reduce((sum, entry) => sum + entry.orphans.length, 0) ?? 0,
    orphanedBytes: report?.groups.reduce((sum, entry) => sum + entry.orphans.reduce((subtotal, object) => subtotal + object.bytes, 0), 0) ?? 0,
  }), [report]);
  const selectedOrphanBytes = useMemo(() => {
    const selected = new Set(selectedOrphans);
    return report?.groups.reduce((sum, entry) => sum + entry.orphans.reduce((subtotal, object) => subtotal + (selected.has(object.path) ? object.bytes : 0), 0), 0) ?? 0;
  }, [report, selectedOrphans]);

  const scan = async () => {
    setAuditing(true);
    try {
      setReport(await auditStorageMaintenance(organizationId));
      setSelectedOrphans([]);
    }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Não foi possível auditar o armazenamento.'); }
    finally { setAuditing(false); }
  };

  const optimizeAll = async () => {
    if (!report) return;
    const localReport = await auditOrganizationStorage();
    const total = localReport.reduce((sum, entry) => sum + entry.candidates.length, 0);
    let current = 0; let saved = 0;
    setRunning(true); setProgress({ current: 0, total, saved: 0 });
    try {
      for (const entry of localReport) {
        let next = entry.project;
        let expectedUpdatedAt = entry.updatedAt;
        for (const attachment of entry.candidates) {
          current += 1; setProgress({ current, total, saved });
          const result = await migrateAttachment(next, attachment);
          const updatedAt = await saveProject(result.project, expectedUpdatedAt);
          if (next.id === currentProject.id) onCurrentProjectChange(result.project);
          next = result.project; expectedUpdatedAt = updatedAt;
          saved += Math.max(0, result.originalBytes - result.storedBytes);
          setProgress({ current, total, saved });
          await deletePreviousAttachment(result.oldPath).catch(() => undefined);
        }
        await recordStorageOptimization(organizationId, entry.meta.id, entry.candidates.length, saved).catch(() => undefined);
      }
      toast.success(`Reotimização global concluída. Economia: ${mb(saved)}.`);
      await scan();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'A reotimização global foi interrompida.'); }
    finally { setRunning(false); }
  };

  const deleteOrphans = async () => {
    const paths = selectedOrphans;
    if (!paths.length) return;
    setConfirmOrphanDeletion(false); setRunning(true);
    try {
      const result = await deleteStorageOrphans(organizationId, paths);
      toast.success(`${result.deleted} arquivo(s) órfão(s) removido(s).`);
      await scan();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Não foi possível remover todos os órfãos.'); }
    finally { setRunning(false); }
  };

  return <><Button variant="outline" className="min-h-11" onClick={() => { setOpen(true); if (!report) void scan(); }}><DatabaseZap className="mr-2 h-4 w-4" />Manutenção global</Button>
    <Dialog open={open} onOpenChange={value => !running && setOpen(value)}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>Manutenção global do armazenamento</DialogTitle><DialogDescription>Auditoria de todas as obras da organização. Arquivos vinculados são reotimizados; órfãos só são apagados mediante confirmação separada.</DialogDescription></DialogHeader>
      {auditing && <div className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Lendo obras e arquivos armazenados...</div>}
      {report && <div className="space-y-3"><div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4"><Stat label="Arquivos" value={String(totals.files)} /><Stat label="Uso total" value={mb(totals.bytes)} /><Stat label="A reotimizar" value={String(totals.candidates)} /><Stat label="Órfãos" value={`${totals.orphaned} · ${mb(totals.orphanedBytes)}`} /></div><div className="max-h-64 overflow-auto rounded-md border text-xs">{report.groups.map(entry => <div key={`${entry.state}-${entry.projectId}`} className="border-b p-2 last:border-0"><div className="flex justify-between gap-3"><span className="min-w-0 truncate font-medium">{entry.projectName}{entry.state === 'obra_excluida' ? ' · excluída' : ''}</span><span>{entry.files} arquivo(s) · {entry.pending} pendente(s) · {entry.orphans.length} órfão(s)</span></div>{entry.orphans.length > 0 && <div className="mt-2 space-y-1 border-t pt-2">{entry.orphans.map(object => <label key={object.path} className="flex cursor-pointer items-start gap-2 rounded p-1 hover:bg-muted/50"><input type="checkbox" className="mt-0.5 h-4 w-4" checked={selectedOrphans.includes(object.path)} onChange={event => setSelectedOrphans(current => event.target.checked ? [...current, object.path] : current.filter(path => path !== object.path))} /><span className="min-w-0"><span className="block break-all font-mono">{object.path}</span><span className="text-muted-foreground">{mb(object.bytes)} · {object.reason}</span></span></label>)}</div>}</div>)}</div></div>}
      {running && <div className="space-y-2"><div className="flex justify-between text-sm"><span>{progress.total ? `Processando ${progress.current}/${progress.total}` : 'Removendo órfãos'}</span><span>{mb(progress.saved)} economizados</span></div>{progress.total > 0 && <Progress value={progress.current / progress.total * 100} />}</div>}
      <DialogFooter className="gap-2 sm:gap-0"><Button variant="outline" disabled={running || auditing} onClick={() => void scan()}>Atualizar análise</Button>{report && totals.orphaned > 0 && <Button variant="destructive" disabled={running || selectedOrphans.length === 0} onClick={() => setConfirmOrphanDeletion(true)}><Trash2 className="mr-2 h-4 w-4" />Excluir selecionados ({selectedOrphans.length})</Button>}<Button disabled={running || auditing || !totals.candidates} onClick={() => void optimizeAll()}>{running ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Processando</> : 'Reotimizar vinculados'}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={confirmOrphanDeletion} onOpenChange={setConfirmOrphanDeletion}><DialogContent><DialogHeader><DialogTitle>Excluir arquivos selecionados?</DialogTitle><DialogDescription>Serão removidos somente os {selectedOrphans.length} arquivo(s) selecionados, equivalentes a {mb(selectedOrphanBytes)}. A função conferirá novamente cada vínculo antes da exclusão. Esta ação não pode ser desfeita.</DialogDescription></DialogHeader><div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />Nenhum arquivo não selecionado será removido.</div><DialogFooter><Button variant="outline" onClick={() => setConfirmOrphanDeletion(false)}>Cancelar</Button><Button variant="destructive" disabled={selectedOrphans.length === 0} onClick={() => void deleteOrphans()}>Excluir definitivamente</Button></DialogFooter></DialogContent></Dialog></>;
}

function Stat({ label, value }: { label: string; value: string }) { return <div className="rounded-md border bg-muted/30 p-2"><div className="text-muted-foreground">{label}</div><strong>{value}</strong></div>; }
