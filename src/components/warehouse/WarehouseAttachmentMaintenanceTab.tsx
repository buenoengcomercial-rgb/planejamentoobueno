import type { Project } from '@/types/project';
import { HardDriveDownload, ShieldCheck } from 'lucide-react';
import AttachmentOptimizationPanel from './AttachmentOptimizationPanel';
import GlobalStorageMaintenancePanel from './GlobalStorageMaintenancePanel';
import { WarehouseSectionHeader } from './WarehouseVisual';

interface Props {
  project: Project;
  organizationId?: string;
  onCommitAttachmentMigration?: (before: Project, after: Project) => Promise<Project>;
}

/** Área deliberadamente exclusiva do Proprietário, fora dos fluxos operacionais. */
export default function WarehouseAttachmentMaintenanceTab({ project, organizationId, onCommitAttachmentMigration }: Props) {
  return <div className="space-y-3">
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <WarehouseSectionHeader icon={HardDriveDownload} title="Manutenção de anexos antigos" description="Reduza apenas arquivos históricos sem regravar a obra ou o livro de estoque." help="Cada anexo é tratado individualmente: a nova cópia é confirmada na coleção que a possui antes de a anterior ser limpa." />
    </section>
    <div className="flex gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm text-muted-foreground"><ShieldCheck className="h-4 w-4 shrink-0 text-primary" /><span>Esta área não altera saldo, movimentos, requisições, assinaturas ou auditorias. Ela somente atualiza a referência de um arquivo vinculado por vez.</span></div>
    <AttachmentOptimizationPanel project={project} onCommitAttachmentMigration={onCommitAttachmentMigration} />
    {organizationId && <GlobalStorageMaintenancePanel organizationId={organizationId} />}
  </div>;
}
