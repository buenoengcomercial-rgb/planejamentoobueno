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
  const orphans = useMemo(() => (report?.groups ?? []).flatMap(entry => entry.orphans.map(object => ({ ...object, projectName: entry.projectName, state: entry.state }))), [report]);
  const selectedSet = useMemo(() => new Set(selectedOrphans), [selectedOrphans]);
  const selectedBytes = useMemo(() => orphans.filter(object => selectedSet.has(object.path)).reduce((sum, object) => sum + object.bytes, 0), [orphans, selectedSet]);
  const totals = useMemo(() => ({
    files: report?.totalFiles ?? 0,
    bytes: report?.totalBytes ?? 0,
    candidates: report?.groups.reduce((sum, entry) => sum + entry.pending, 0) ?? 0,
    orphaned: orphans.length,
    orphanedBytes: orphans.reduce((sum, object) => sum + object.bytes, 0),
  }), [report, orphans]);

  const scan = async () => {
    setAuditing(true);
    try { setReport(await auditStorageMaintenance(organizationId)); setSelectedOrphans([]); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Não foi possível auditar o armazenamento.'); }
    finally { setAuditing(false); }
  };

  const toggleOrphan = (path: string) => setSelectedOrphans(current => current.includes(path) ? current.filter(item => item !== path) : [...current, path]);

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
    <Dialog open={open} onOpenChange={value => !running && setOpen(value)}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>Manutenção global do armazenamento</DialogTitle><DialogDescription>Auditoria de todas as obras da organização. Arquivos vinculados são reotimizados; órfãos só são apagados mediante seleção e confirmação.</DialogDescription></DialogHeader>
      {auditing && <div className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Lendo obras e arquivos armazenados...</div>}
      {report && <div className="space-y-3"><div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4"><Stat label="Arquivos" value={String(totals.files)} /><Stat label="Uso total" value={mb(totals.bytes)} /><Stat label="A reotimizar" value={String(totals.candidates)} /><Stat label="Órfãos" value={`${totals.orphaned} · ${mb(totals.orphanedBytes)}`} /></div><div className="max-h-40 overflow-auto rounded-md border text-xs">{report.groups.map(entry => <div key={`${entry.state}-${entry.projectId}`} className="flex justify-between gap-3 border-b p-2 last:border-0"><span className="min-w-0 truncate font-medium">{entry.projectName}{entry.state === 'obra_excluida' ? ' · excluída' : ''}</span><span>{entry.files} arquivo(s) · {entry.pending} pendente(s) · {entry.orphans.length} órfão(s)</span></div>)}</div>
        {orphans.length > 0 && <div className="space-y-2"><div className="flex items-center justify-between text-xs"><strong>Arquivos órfãos ({orphans.length})</strong><div className="flex gap-2"><Button variant="ghost" size="sm" disabled={running} onClick={() => setSelectedOrphans(orphans.map(object => object.path))}>Selecionar todos</Button><Button variant="ghost" size="sm" disabled={running || !selectedOrphans.length} onClick={() => setSelectedOrphans([])}>Limpar</Button></div></div>
          <div className="max-h-56 overflow-auto rounded-md border">{orphans.map(object => <label key={object.path} className="flex items-start gap-2 border-b p-2 text-xs last:border-0">
            <Checkbox checked={selectedSet.has(object.path)} disabled={running} onCheckedChange={() => toggleOrphan(object.path)} className="mt-0.5" />
            <span className="min-w-0 flex-1"><span className="block break-all font-medium">{object.path}</span><span className="text-muted-foreground">{mb(object.bytes)} · {object.reason} · {object.projectName}</span></span>
          </label>)}</div>
          <div className="text-xs text-muted-foreground">{selectedOrphans.length} selecionado(s) · {mb(selectedBytes)}</div></div>}
      </div>}
      {running && <div className="space-y-2"><div className="flex justify-between text-sm"><span>{progress.total ? `Processando ${progress.current}/${progress.total}` : 'Removendo órfãos'}</span><span>{mb(progress.saved)} economizados</span></div>{progress.total > 0 && <Progress value={progress.current / progress.total * 100} />}</div>}
      <DialogFooter className="gap-2 sm:gap-0"><Button variant="outline" disabled={running || auditing} onClick={() => void scan()}>Atualizar análise</Button>{report && totals.orphaned > 0 && <Button variant="destructive" disabled={running || !selectedOrphans.length} onClick={() => setConfirmOrphanDeletion(true)}><Trash2 className="mr-2 h-4 w-4" />Excluir selecionados</Button>}<Button disabled={running || auditing || !totals.candidates} onClick={() => void optimizeAll()}>{running ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Processando</> : 'Reotimizar vinculados'}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={confirmOrphanDeletion} onOpenChange={setConfirmOrphanDeletion}><DialogContent><DialogHeader><DialogTitle>Excluir arquivos selecionados?</DialogTitle><DialogDescription>Serão removidos {selectedOrphans.length} arquivo(s), equivalentes a {mb(selectedBytes)}, sem vínculo com qualquer diário, movimentação ou registro de almoxarifado. Esta ação não pode ser desfeita.</DialogDescription></DialogHeader><div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />A exclusão só alcança arquivos da sua organização e é feita após esta confirmação.</div><DialogFooter><Button variant="outline" onClick={() => setConfirmOrphanDeletion(false)}>Cancelar</Button><Button variant="destructive" disabled={!selectedOrphans.length} onClick={() => void deleteOrphans()}>Excluir definitivamente</Button></DialogFooter></DialogContent></Dialog></>;
}

function Stat({ label, value }: { label: string; value: string }) { return <div className="rounded-md border bg-muted/30 p-2"><div className="text-muted-foreground">{label}</div><strong>{value}</strong></div>; }
