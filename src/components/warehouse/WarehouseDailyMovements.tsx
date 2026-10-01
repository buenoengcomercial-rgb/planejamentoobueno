import { useMemo, useState } from 'react';
import type { Project, WarehouseMovement, WarehouseRequisition, WarehouseRequisitionItem } from '@/types/project';
import { ensureWarehouse, warehouseOperationalDate } from '@/lib/warehouse';
import { getChapterNumbering } from '@/lib/chapters';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChevronDown, CalendarDays } from 'lucide-react';
import { WarehouseEmptyState } from './WarehouseVisual';

type DailyKind = 'withdrawal' | 'supplement' | 'return';
type DailyItem = Pick<WarehouseRequisitionItem, 'itemKey' | 'code' | 'description' | 'unit' | 'quantity'>;

type DailyActivity = {
  id: string;
  kind: DailyKind;
  requisitionNumber: string;
  receiverName: string;
  returnNumber?: string;
  returnerName?: string;
  status?: string;
  at: string;
  items: DailyItem[];
};

type DailyBuilding = { key: string; label: string; missing: boolean; activities: DailyActivity[] };

/** Projeção de leitura: cada entrega e cada devolução usa sua própria data operacional. */
function dailyMaterialMovements(project: Project, date: string): DailyBuilding[] {
  if (!date) return [];
  const warehouse = ensureWarehouse(project).warehouse!;
  const requisitions = new Map(warehouse.requisitions.map(requisition => [requisition.id, requisition]));
  const phases = new Map(project.phases.map(phase => [phase.id, phase]));
  const numbering = getChapterNumbering(project);
  const buildings = new Map<string, DailyBuilding>();
  const buildingFor = (chapterId?: string) => {
    const visited = new Set<string>();
    let root = chapterId ? phases.get(chapterId) : undefined;
    while (root?.parentId && !visited.has(root.id)) {
      visited.add(root.id);
      root = phases.get(root.parentId);
    }
    if (!root) return { key: 'missing-building', label: 'Prédio não informado', missing: true };
    const number = numbering.get(root.id);
    return { key: root.id, label: `${number ? `${number} · ` : ''}${root.name}`, missing: false };
  };
  const add = (requisition: WarehouseRequisition | undefined, fallbackChapterId: string | undefined, activity: DailyActivity) => {
    const building = buildingFor(requisition?.chapterId ?? fallbackChapterId);
    const group = buildings.get(building.key) ?? { ...building, activities: [] };
    group.activities.push(activity);
    buildings.set(building.key, group);
  };

  for (const requisition of warehouse.requisitions) {
    if (requisition.date === date && requisition.status !== 'rascunho') add(requisition, undefined, {
      id: `withdrawal:${requisition.id}`, kind: 'withdrawal', requisitionNumber: requisition.number,
      receiverName: requisition.receiverName || requisition.requesterName || 'Não informado',
      status: requisition.status === 'cancelada' ? 'Cancelada' : undefined,
      at: requisition.createdAt || requisition.date, items: requisition.items,
    });
    for (const supplement of requisition.supplements ?? []) {
      if (supplement.date !== date) continue;
      add(requisition, undefined, {
        id: `supplement:${requisition.id}:${supplement.id}`, kind: 'supplement', requisitionNumber: requisition.number,
        receiverName: supplement.receiverName || requisition.receiverName || 'Não informado',
        status: supplement.status === 'cancelled' ? 'Estornado' : undefined,
        at: supplement.createdAt || supplement.date,
        items: supplement.status === 'cancelled' && !supplement.items.length
          ? supplement.cancelledItems ?? []
          : supplement.items,
      });
    }
  }

  const returns = new Map<string, { requisition: WarehouseRequisition | undefined; movement: WarehouseMovement; activity: DailyActivity }>();
  for (const movement of warehouse.movements) {
    if (movement.type !== 'devolucao' || movement.originType !== 'return' || movement.date !== date) continue;
    const requisition = requisitions.get(movement.requisitionId ?? '');
    const key = `${movement.requisitionId ?? 'orphan'}:${movement.originId || movement.returnNumber || movement.id}`;
    const existing = returns.get(key);
    const item = {
      itemKey: movement.itemKey, code: movement.itemCode, description: movement.itemDescription,
      unit: movement.itemUnit, quantity: movement.quantity,
    };
    if (existing) {
      existing.activity.items.push(item);
      if (movement.reversedById) existing.activity.status = 'Estornada';
    } else {
      returns.set(key, {
        requisition, movement,
        activity: {
          id: `return:${key}`, kind: 'return', requisitionNumber: requisition?.number || 'Requisição não localizada',
          receiverName: requisition?.receiverName || requisition?.requesterName || 'Não informado',
          returnNumber: movement.returnNumber, returnerName: movement.returnerName || 'Não informado',
          status: movement.reversedById ? 'Estornada' : undefined,
          at: movement.createdAt || movement.date, items: [item],
        },
      });
    }
  }
  for (const { requisition, movement, activity } of returns.values()) add(requisition, movement.chapterId, activity);

  return Array.from(buildings.values()).map(group => ({
    ...group,
    activities: group.activities.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id)),
  })).sort((left, right) => Number(left.missing) - Number(right.missing) || left.label.localeCompare(right.label, 'pt-BR', { numeric: true }));
}

const formatQuantity = (quantity: number) => quantity.toLocaleString('pt-BR');

export default function WarehouseDailyMovements({ project, date, onDateChange }: {
  project: Project;
  date: string;
  onDateChange: (date: string) => void;
}) {
  const buildings = useMemo(() => dailyMaterialMovements(project, date), [project, date]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return <section aria-label="Movimentações do dia" className="space-y-3">
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-end sm:justify-between sm:p-4">
      <div className="min-w-0"><h3 className="flex items-center gap-2 font-semibold"><CalendarDays className="h-4 w-4 text-primary" />Movimentações do dia</h3><p className="mt-1 text-sm text-muted-foreground">Retiradas, complementos e devoluções na data da operação.</p></div>
      <div className="flex flex-wrap items-end gap-2"><label className="min-w-[11rem] flex-1 text-sm font-medium sm:flex-none" htmlFor="daily-withdrawals-date">Data das movimentações<Input id="daily-withdrawals-date" type="date" className="mt-1 min-h-11 text-base" value={date} onChange={event => onDateChange(event.target.value)} /></label><Button type="button" variant="outline" className="min-h-11" onClick={() => onDateChange(warehouseOperationalDate())}>Hoje</Button></div>
    </div>
    {buildings.length ? buildings.map(building => <section key={building.key} data-testid="daily-building-group" className="min-w-0 overflow-hidden rounded-xl border bg-card">
      <button type="button" className="flex min-h-12 w-full items-center justify-between gap-3 bg-primary/10 px-3 py-3 text-left hover:bg-primary/15 sm:px-4" onClick={() => toggle(building.key)} aria-expanded={!collapsed.has(building.key)}>
        <span className="min-w-0 break-words font-semibold">{building.label}</span><span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">{building.activities.length} {building.activities.length === 1 ? 'movimentação' : 'movimentações'}<ChevronDown className={`h-4 w-4 text-primary transition-transform ${collapsed.has(building.key) ? '' : 'rotate-180'}`} /></span>
      </button>
      {!collapsed.has(building.key) && <div className="grid min-w-0 gap-3 border-l-2 border-primary/20 p-3 sm:p-4 lg:grid-cols-2">
        {building.activities.map(activity => <article key={activity.id} data-testid="daily-activity" className="min-w-0 rounded-lg border bg-background p-3 text-sm shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><span className={`font-semibold ${activity.kind === 'return' ? 'text-success' : 'text-primary'}`}>{activity.kind === 'withdrawal' ? 'Retirada' : activity.kind === 'supplement' ? 'Complemento' : 'Devolução'}</span>{activity.status && <span className="ml-2 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{activity.status}</span>}</div><strong className="break-all font-mono text-xs">{activity.requisitionNumber}</strong></div>
          {activity.returnNumber && <p className="mt-1 text-xs font-medium">{activity.returnNumber}</p>}
          <p className="mt-2 break-words text-muted-foreground">Recebedor: {activity.receiverName}</p>
          {activity.kind === 'return' && <p className="break-words text-muted-foreground">Devolvido por {activity.returnerName} · vinculado à retirada original</p>}
          <ul className="mt-3 space-y-1 border-t pt-2">{activity.items.map((item, index) => <li key={`${item.itemKey}:${index}`} className="flex min-w-0 items-start justify-between gap-3"><span className="min-w-0 break-words">{item.description}</span><span className="shrink-0 whitespace-nowrap font-mono font-semibold">{formatQuantity(item.quantity)} {item.unit}</span></li>)}</ul>
        </article>)}
      </div>}
    </section>) : <WarehouseEmptyState message="Nenhuma movimentação de materiais nesta data" hint="Escolha outra data para consultar retiradas, complementos e devoluções." />}
  </section>;
}
