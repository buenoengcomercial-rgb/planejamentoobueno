import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertTriangle, DatabaseZap, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { auditStorageMaintenance, deleteStorageOrphans, type StorageMaintenanceReport } from '@/lib/storageMaintenance';

interface Props { organizationId: string; }
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} MB`;

/**
 * Auditoria de órfãos deliberadamente separada da reotimização de anexos.
 * Não há exclusão automática: cada objeto precisa ser selecionado e confirmado
 * pelo Proprietário após uma nova conferência no servidor.
 */
export default function GlobalStorageMaintenancePanel({ organizationId }: Props) {
  const [auditing, setAuditing] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<StorageMaintenanceReport | null>(null);
  const [confirmOrphanDeletion, setConfirmOrphanDeletion] = useState(false);
  const [selectedOrphans, setSelectedOrphans] = useState<string[]>([]);
  const orphans = useMemo(
    () => (report?.groups ?? []).flatMap(entry => entry.orphans.map(object => ({ ...object, projectName: entry.projectName, state: entry.state }))),
    [report],
  );
  const selectedSet = useMemo(() => new Set(selectedOrphans), [selectedOrphans]);
  const selectedBytes = useMemo(
    () => orphans.filter(object => selectedSet.has(object.path)).reduce((sum, object) => sum + object.bytes, 0),
    [orphans, selectedSet],
  );
  const totals = useMemo(() => ({
    files: report?.totalFiles ?? 0,
    bytes: report?.totalBytes ?? 0,
    orphaned: orphans.length,
    orphanedBytes: orphans.reduce((sum, object) => sum + object.bytes, 0),
  }), [report, orphans]);

  const scan = async () => {
    setAuditing(true);
    try {
      setReport(await auditStorageMaintenance(organizationId));
      setSelectedOrphans([]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível auditar o armazenamento.');
    } finally {
      setAuditing(false);
    }
  };

  const deleteOrphans = async () => {
    const paths = selectedOrphans;
    if (!paths.length) return;
    setConfirmOrphanDeletion(false);
    setRunning(true);
    try {
      const result = await deleteStorageOrphans(organizationId, paths);
      toast.success(`${result.deleted} arquivo(s) órfão(s) removido(s).`);
      await scan();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível remover todos os órfãos.');
    } finally {
      setRunning(false);
    }
  };

  const toggleOrphan = (path: string) => setSelectedOrphans(current => (
    current.includes(path) ? current.filter(item => item !== path) : [...current, path]
  ));

  return <section className="rounded-xl border bg-card p-4 shadow-sm">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div><div className="flex items-center gap-2 font-bold"><DatabaseZap className="h-4 w-4 text-primary" />Auditoria de arquivos órfãos</div><p className="mt-1 text-sm text-muted-foreground">A análise não modifica anexos vinculados. A exclusão exige seleção e confirmação individual.</p></div>
      <Button variant="outline" className="min-h-11 shrink-0" disabled={auditing || running} onClick={() => void scan()}>{auditing ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Analisando</> : 'Auditar armazenamento'}</Button>
    </div>
    {auditing && <div className="mt-3 flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Lendo obras e arquivos armazenados...</div>}
    {report && <div className="mt-3 space-y-3">
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3"><Stat label="Arquivos" value={String(totals.files)} /><Stat label="Uso total" value={mb(totals.bytes)} /><Stat label="Órfãos" value={`${totals.orphaned} · ${mb(totals.orphanedBytes)}`} /></div>
      <div className="max-h-40 overflow-auto rounded-md border text-xs">{report.groups.map(entry => <div key={`${entry.state}-${entry.projectId}`} className="flex justify-between gap-3 border-b p-2 last:border-0"><span className="min-w-0 truncate font-medium">{entry.projectName}{entry.state === 'obra_excluida' ? ' · excluída' : ''}</span><span>{entry.files} arquivo(s) · {entry.orphans.length} órfão(s)</span></div>)}</div>
      {orphans.length > 0 && <div className="space-y-2"><div className="flex items-center justify-between text-xs"><strong>Arquivos órfãos ({orphans.length})</strong><Button variant="ghost" size="sm" disabled={running || !selectedOrphans.length} onClick={() => setSelectedOrphans([])}>Limpar seleção</Button></div>
        <div className="max-h-56 overflow-auto rounded-md border">{orphans.map(object => <label key={object.path} className="flex items-start gap-2 border-b p-2 text-xs last:border-0"><Checkbox checked={selectedSet.has(object.path)} disabled={running} onCheckedChange={() => toggleOrphan(object.path)} className="mt-0.5" /><span className="min-w-0 flex-1"><span className="block break-all font-medium">{object.path}</span><span className="text-muted-foreground">{mb(object.bytes)} · {object.reason} · {object.projectName}</span></span></label>)}</div>
        <div className="text-xs text-muted-foreground">{selectedOrphans.length} selecionado(s) · {mb(selectedBytes)}</div>
      </div>}
      <div className="flex justify-end">{totals.orphaned > 0 && <Button variant="destructive" disabled={running || !selectedOrphans.length} onClick={() => setConfirmOrphanDeletion(true)}><Trash2 className="mr-2 h-4 w-4" />Excluir selecionados</Button>}</div>
    </div>}
    <Dialog open={confirmOrphanDeletion} onOpenChange={setConfirmOrphanDeletion}><DialogContent><DialogHeader><DialogTitle>Excluir arquivos selecionados?</DialogTitle><DialogDescription>Serão removidos somente os {selectedOrphans.length} arquivo(s) selecionados, equivalentes a {mb(selectedBytes)}. A função conferirá novamente cada vínculo antes da exclusão. Esta ação não pode ser desfeita.</DialogDescription></DialogHeader><div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />Nenhum arquivo não selecionado será removido.</div><DialogFooter><Button variant="outline" onClick={() => setConfirmOrphanDeletion(false)}>Cancelar</Button><Button variant="destructive" disabled={!selectedOrphans.length} onClick={() => void deleteOrphans()}>Excluir definitivamente</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}

function Stat({ label, value }: { label: string; value: string }) { return <div className="rounded-md border bg-muted/30 p-2"><div className="text-muted-foreground">{label}</div><strong>{value}</strong></div>; }
