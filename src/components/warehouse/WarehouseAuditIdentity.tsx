import type { WarehouseAuditActor } from '@/types/project';
import { warehouseActorName } from '@/lib/warehouse';

interface Props {
  createdBy?: WarehouseAuditActor;
  updatedBy?: WarehouseAuditActor;
  createdAt?: string;
  updatedAt?: string;
  legacyCreatedBy?: string;
  className?: string;
}

function formatWarehouseAuditTimestamp(value?: string) {
  if (!value || !value.includes('T')) return 'data/hora não informadas';

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return 'data/hora não informadas';

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Cuiaba',
  }).format(timestamp);
}

export default function WarehouseAuditIdentity({ createdBy, updatedBy, createdAt, updatedAt, legacyCreatedBy, className }: Props) {
  return (
    <div className={`min-w-0 break-words leading-tight [overflow-wrap:anywhere] ${className || ''}`}>
      <div className="min-w-0"><span className="text-muted-foreground">Incluído por:</span> {warehouseActorName(createdBy, legacyCreatedBy)} · {formatWarehouseAuditTimestamp(createdAt)}</div>
      <div className="min-w-0"><span className="text-muted-foreground">Alterado por:</span> {updatedBy ? `${warehouseActorName(updatedBy)} · ${formatWarehouseAuditTimestamp(updatedAt)}` : '—'}</div>
    </div>
  );
}
