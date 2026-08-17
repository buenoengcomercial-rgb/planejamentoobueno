import type { WarehouseAuditActor } from '@/types/project';
import { warehouseActorName } from '@/lib/warehouse';

interface Props {
  createdBy?: WarehouseAuditActor;
  updatedBy?: WarehouseAuditActor;
  legacyCreatedBy?: string;
  className?: string;
}

export default function WarehouseAuditIdentity({ createdBy, updatedBy, legacyCreatedBy, className }: Props) {
  return (
    <div className={className}>
      <div><span className="text-muted-foreground">Incluído por:</span> {warehouseActorName(createdBy, legacyCreatedBy)}</div>
      <div><span className="text-muted-foreground">Alterado por:</span> {updatedBy ? warehouseActorName(updatedBy) : '—'}</div>
    </div>
  );
}
