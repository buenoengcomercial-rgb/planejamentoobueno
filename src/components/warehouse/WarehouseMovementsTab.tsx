import { useMemo, useState } from 'react';
import type { Project, WarehouseAuditActor, WarehouseMovement, WarehouseMovementOriginType } from '@/types/project';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ArrowLeftRight, ChevronDown, FileDown, Paperclip, Search } from 'lucide-react';
import { ensureWarehouse, MOVEMENT_LABEL, movementSign } from '@/lib/warehouse';
import { getChapterNumbering } from '@/lib/chapters';
import { openWarehouseAttachment, warehouseAttachmentErrorMessage } from '@/lib/warehouseAttachments';
import { generateRequisitionReceipt } from './pdf';
import WarehouseAuditIdentity from './WarehouseAuditIdentity';
import { toast } from 'sonner';
import { WarehouseEmptyState, WarehouseField, WarehouseSectionHeader, WarehouseStatusBadge } from './WarehouseVisual';

interface Props { project: Project; onProjectChange: (next: Project) => void; auditActor?: WarehouseAuditActor; }

interface MovementGroup {
  key: string;
  originType: WarehouseMovementOriginType;
  originId?: string;
  label: string;
  date: string;
  movements: WarehouseMovement[];
}

function movementOrigin(movement: WarehouseMovement): { type: WarehouseMovementOriginType; id?: string } {
  if (movement.originType) return { type: movement.originType, id: movement.originId };
  if (movement.fiscalNoteId) return { type: 'fiscal_note', id: movement.fiscalNoteId };
  if (movement.requisitionId) return { type: 'withdrawal', id: movement.requisitionId };
  if (movement.inventorySessionId) return { type: 'inventory', id: movement.inventorySessionId };
  if (movement.reversesId) return { type: 'reversal', id: movement.reversesId };
  return { type: 'legacy', id: movement.id };
}

const ORIGIN_LABEL: Record<WarehouseMovementOriginType, string> = {
  fiscal_note: 'Nota fiscal',
  withdrawal: 'Retirada',
  inventory: 'Inventário',
  return: 'Devolução',
  loss: 'Perda / avaria',
  reversal: 'Estorno',
  legacy: 'Registro legado',
};

export default function WarehouseMovementsTab({ project }: Props) {
  const wh = ensureWarehouse(project).warehouse!;
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [origin, setOrigin] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const numbering = useMemo(() => getChapterNumbering(project), [project]);
  const chapterNames = useMemo(() => new Map((project.phases ?? []).filter(phase => !phase.parentId).map(phase => [phase.id, `${numbering.get(phase.id) ?? ''} ${phase.name}`.trim()])), [numbering, project.phases]);

  const groups = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('pt-BR');
    const filtered = wh.movements.filter(movement => {
      const source = movementOrigin(movement);
      if (type !== 'all' && movement.type !== type) return false;
      if (origin !== 'all' && source.type !== origin) return false;
      if (dateFrom && movement.date < dateFrom) return false;
      if (dateTo && movement.date > dateTo) return false;
      if (query && ![movement.itemDescription, movement.itemCode, movement.invoiceNumber, movement.workerName, movement.returnNumber, movement.returnerName, movement.notes, movement.createdBy?.userName, movement.createdBy?.userEmail].some(value => value?.toLocaleLowerCase('pt-BR').includes(query))) return false;
      return true;
    });
    const map = new Map<string, MovementGroup>();
    for (const movement of filtered) {
      const source = movementOrigin(movement);
      const key = `${source.type}:${source.id || movement.id}`;
      let group = map.get(key);
      if (!group) {
        const note = source.type === 'fiscal_note' ? wh.fiscalNotes?.find(candidate => candidate.id === source.id) : undefined;
        const requisition = source.type === 'withdrawal' ? wh.requisitions.find(candidate => candidate.id === source.id) : undefined;
        const inventory = source.type === 'inventory' ? wh.inventorySessions?.find(candidate => candidate.id === source.id) : undefined;
        group = {
          key,
          originType: source.type,
          originId: source.id,
          label: note ? `Nota ${note.invoiceNumber || note.id}` : requisition?.number || inventory?.number || (source.type === 'return' ? movement.returnNumber : undefined) || `${ORIGIN_LABEL[source.type]} ${source.id?.slice(0, 8) || ''}`,
          date: movement.date,
          movements: [],
        };
        map.set(key, group);
      }
      group.movements.push(movement);
      if (movement.date > group.date) group.date = movement.date;
    }
    return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));
  }, [dateFrom, dateTo, origin, search, type, wh]);

  const openAttachments = async (group: MovementGroup) => {
    const attachment = group.movements.flatMap(movement => movement.attachments ?? [])[0];
    if (!attachment) return toast.error('Esta operação não possui anexos.');
    try { await openWarehouseAttachment(attachment); } catch (error) { toast.error(warehouseAttachmentErrorMessage(error)); }
  };

  const receipt = (group: MovementGroup) => {
    const requisition = group.originType === 'withdrawal' ? wh.requisitions.find(candidate => candidate.id === group.originId) : undefined;
    if (!requisition) return toast.error('Não há comprovante de retirada para esta origem.');
    generateRequisitionReceipt(project, requisition);
  };

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <WarehouseSectionHeader icon={ArrowLeftRight} title="Extrato do estoque" description="Extrato imutável do estoque" help="Consulte entradas, saídas e ajustes. Os movimentos aparecem automaticamente e não podem ser criados, editados ou excluídos nesta tela." />
        <div className="grid gap-3 p-3 md:grid-cols-6">
          <WarehouseField label="Buscar" className="md:col-span-2"><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input className="min-h-11 pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="Material, nota ou pessoa" /></div></WarehouseField>
          <WarehouseField label="Tipo"><select className="min-h-11 rounded-md border bg-background px-3 text-sm" value={type} onChange={event => setType(event.target.value)}><option value="all">Todos os tipos</option>{Object.entries(MOVEMENT_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></WarehouseField>
          <WarehouseField label="Origem"><select className="min-h-11 rounded-md border bg-background px-3 text-sm" value={origin} onChange={event => setOrigin(event.target.value)}><option value="all">Todas as origens</option>{Object.entries(ORIGIN_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></WarehouseField>
          <WarehouseField label="Data inicial" optional><Input className="min-h-11" type="date" value={dateFrom} onChange={event => setDateFrom(event.target.value)} aria-label="Período inicial" /></WarehouseField>
          <WarehouseField label="Data final" optional><Input className="min-h-11" type="date" value={dateTo} onChange={event => setDateTo(event.target.value)} aria-label="Período final" /></WarehouseField>
        </div>
      </div>

      <div className="space-y-2">
        {groups.map(group => {
          const quantity = group.movements.reduce((total, movement) => total + movementSign(movement) * movement.quantity, 0);
          const chapter = group.movements.find(movement => movement.chapterId)?.chapterId;
          const team = group.movements.find(movement => movement.teamId)?.teamId;
          const hasAttachments = group.movements.some(movement => movement.attachments?.length);
          return (
            <details key={group.key} className="group overflow-hidden rounded-xl border bg-card shadow-sm">
              <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 p-3 hover:bg-muted/30">
                <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
                <div className="min-w-0 flex-1"><div className="font-semibold">{group.label}</div><div className="text-xs text-muted-foreground">{ORIGIN_LABEL[group.originType]} · {group.date} · {group.movements.length} movimento(s){chapter ? ` · ${chapterNames.get(chapter) || chapter}` : ''}{team ? ` · Equipe ${team}` : ''}</div></div>
                <WarehouseStatusBadge label={`${quantity > 0 ? '+' : ''}${quantity.toLocaleString('pt-BR')}`} tone={quantity < 0 ? 'danger' : quantity > 0 ? 'success' : 'neutral'} />
              </summary>
              <div className="border-t p-3">
                <div className="mb-3 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:justify-end">{group.originType === 'withdrawal' && <Button size="sm" variant="outline" className="min-h-11" onClick={() => receipt(group)}><FileDown className="mr-2 h-4 w-4" />Ver comprovante</Button>}<Button size="sm" variant="outline" className="min-h-11" disabled={!hasAttachments} onClick={() => void openAttachments(group)}><Paperclip className="mr-2 h-4 w-4" />Ver anexos</Button></div>
                <div className="space-y-2">{group.movements.map(movement => { const sign = movementSign(movement); return <div key={movement.id} className={`grid gap-2 rounded-md border p-3 md:grid-cols-[120px_1fr_140px_220px] ${movement.reversedById ? 'opacity-60' : ''}`}><div><div className="text-xs text-muted-foreground">Tipo</div><div className="text-sm font-medium">{MOVEMENT_LABEL[movement.type]}{movement.reversedById ? ' (estornado)' : ''}</div>{movement.returnNumber && <div className="mt-1 font-mono text-xs text-success">{movement.returnNumber}</div>}</div><div><div className="text-xs text-muted-foreground">Material</div><div className="text-sm">{movement.itemCode ? `${movement.itemCode} · ` : ''}{movement.itemDescription}</div>{movement.returnerName && <div className="mt-1 text-xs text-muted-foreground">Devolvido por: {movement.returnerName}</div>}</div><div><div className="text-xs text-muted-foreground">Quantidade / custo</div><div className="font-mono text-sm">{sign > 0 ? '+' : sign < 0 ? '−' : ''}{movement.quantity.toLocaleString('pt-BR')} {movement.itemUnit}</div><div className="text-xs text-muted-foreground">{movement.costSnapshot != null ? `${movement.costSnapshot.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}/un` : 'Cálculo incompleto'}</div></div><WarehouseAuditIdentity createdBy={movement.createdBy} updatedBy={movement.updatedBy} className="space-y-0.5 text-xs" /></div>; })}</div>
              </div>
            </details>
          );
        })}
        {!groups.length && <WarehouseEmptyState message="Nenhum movimento encontrado" hint="Revise os filtros acima." icon={ArrowLeftRight} />}
      </div>
    </div>
  );
}
