import { Fragment, useMemo, useState } from 'react';
import type { ElementType } from 'react';
import type { MaterialCostClass, Project, WarehouseAuditActor } from '@/types/project';
import {
  computeWarehouseRows,
  createManualWarehouseItem,
  getMaterialPurchaseHistory,
  hardDeleteWarehouseItem,
  removeWarehouseItem,
  unlinkWarehouseProjectMaterial,
  upsertItemConfig,
  upsertWarehouseProjectMaterialLink,
} from '@/lib/warehouse';
import { MATERIAL_COST_CLASS_LABEL, setMaterialCostClass, suggestMaterialsFromProject } from '@/lib/materialComparisons';
import { computeWarehouseStockOverviewRows, type WarehouseStockOverviewRow } from '@/lib/warehouseStockOverview';
import { downloadWarehouseAttachment, openWarehouseAttachment, warehouseAttachmentErrorMessage } from '@/lib/warehouseAttachments';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Archive, ArrowDown, ArrowDownUp, ArrowUp, Boxes, BrickWall, Check, ChevronDown, ChevronsUpDown, CircleSlash, Download, Eye, HardHat, History, Link2, Plus, Search, Truck, Unlink, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { WarehouseSectionHeader, WarehouseStatusBadge } from './WarehouseVisual';

interface Props { project: Project; onProjectChange: (next: Project) => void; auditActor?: WarehouseAuditActor; canArchive?: boolean; canDelete?: boolean; }

const stockClassLabel: Record<MaterialCostClass, string> = { ...MATERIAL_COST_CLASS_LABEL, unclassified: 'Diversos' };
const stockClassIcon: Record<MaterialCostClass, ElementType> = { material: BrickWall, labor: HardHat, equipment: Truck, unclassified: CircleSlash };
const stockClassStyle: Record<MaterialCostClass, string> = {
  material: 'border-orange-300 bg-orange-50 text-orange-700',
  labor: 'border-red-300 bg-red-50 text-red-700',
  equipment: 'border-blue-300 bg-blue-50 text-blue-700',
  unclassified: 'border-slate-300 bg-slate-50 text-slate-600',
};
const stockClassOrder: MaterialCostClass[] = ['material', 'labor', 'equipment', 'unclassified'];
type StockSortKey = 'code' | 'description' | 'costClass' | 'unit' | 'planned' | 'additive' | 'purchased' | 'received' | 'withdrawn' | 'returned' | 'losses' | 'balance' | 'effectiveMinStock' | 'lastMovementDate' | 'averageUnitCost' | 'linkStatus';
type StockSort = { key: StockSortKey; direction: 'asc' | 'desc' };
const stockSortLabel: Record<StockSortKey, string> = { code: 'código', description: 'descrição', costClass: 'classificação', unit: 'unidade', planned: 'planejado', additive: 'aditivo', purchased: 'comprado', received: 'recebido', withdrawn: 'retirado', returned: 'devolvido', losses: 'perdas', balance: 'saldo', effectiveMinStock: 'estoque baixo', lastMovementDate: 'último movimento', averageUnitCost: 'custo médio', linkStatus: 'vínculo' };
const numericStockSortKeys: StockSortKey[] = ['planned', 'additive', 'purchased', 'received', 'withdrawn', 'returned', 'losses', 'balance', 'effectiveMinStock', 'averageUnitCost'];

function StockClassBadge({ costClass }: { costClass: MaterialCostClass }) {
  const Icon = stockClassIcon[costClass];
  return <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${stockClassStyle[costClass]}`}><Icon className="h-3.5 w-3.5" />{stockClassLabel[costClass]}</span>;
}

function StockClassSelect({ row, onChange, mobile = false }: { row: WarehouseStockOverviewRow; onChange: (row: WarehouseStockOverviewRow, costClass: MaterialCostClass) => void; mobile?: boolean }) {
  const Icon = stockClassIcon[row.costClass];
  const size = mobile ? 'min-h-11 pl-9 pr-9 text-base' : 'h-7 pl-6 pr-6 text-[10px]';
  const iconPosition = mobile ? 'left-3 h-4 w-4' : 'left-1.5 h-3 w-3';
  const arrowPosition = mobile ? 'right-3 h-4 w-4' : 'right-1.5 h-3 w-3';

  return <span className="relative block min-w-0"><Icon aria-hidden="true" className={`pointer-events-none absolute top-1/2 z-10 -translate-y-1/2 ${iconPosition}`} /><select aria-label={`Classificação de ${row.description}`} className={`w-full appearance-none rounded border py-0 font-semibold ${size} ${stockClassStyle[row.costClass]}`} value={row.costClass} onChange={event => onChange(row, event.target.value as MaterialCostClass)}>{stockClassOrder.map(costClass => <option key={costClass} value={costClass}>{stockClassLabel[costClass]}</option>)}</select><ChevronDown aria-hidden="true" className={`pointer-events-none absolute top-1/2 -translate-y-1/2 ${arrowPosition}`} /></span>;
}

function StockSortableHeader({ label, sortKey, sort, onSort, align = 'left', className = '', icon: Icon }: { label: string; sortKey: StockSortKey; sort: StockSort; onSort: (key: StockSortKey) => void; align?: 'left' | 'center' | 'right'; className?: string; icon?: ElementType }) {
  const active = sort.key === sortKey;
  const SortIcon = active ? (sort.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowDownUp;
  const justification = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';
  return <th aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'} className={`p-2 font-semibold ${className}`}><button type="button" className={`inline-flex w-full items-center gap-1 rounded text-inherit hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${justification}`} onClick={() => onSort(sortKey)} aria-label={`Ordenar por ${label}${active ? `, ${sort.direction === 'asc' ? 'crescente' : 'decrescente'}` : ''}`}><>{Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}{label}</><SortIcon aria-hidden="true" className={`h-3 w-3 shrink-0 ${active ? 'text-foreground' : 'opacity-50'}`} /></button></th>;
}

function StockLinkButton({ row, onClick, mobile = false }: { row: WarehouseStockOverviewRow; onClick: () => void; mobile?: boolean }) {
  const linked = row.linkStatus === 'linked';
  const label = linked ? `Revisar vínculos (${row.projectLinks.length})` : row.linkStatus === 'unplanned' ? 'Revisar vínculo' : 'Vincular material';
  const tone = linked ? 'border-success/35 bg-success/5 text-success hover:bg-success/10' : row.linkStatus === 'unplanned' ? 'border-warning/35 bg-warning/5 text-warning hover:bg-warning/10' : 'border-primary/35 bg-primary/5 text-primary hover:bg-primary/10';
  return <Button size="sm" variant="outline" title={label} className={`${mobile ? 'min-h-11 w-full text-sm' : 'h-8 min-h-8 w-full px-2 text-xs'} justify-center gap-1.5 ${tone}`} onClick={onClick} aria-label={label}><Link2 className="h-3.5 w-3.5 shrink-0" /><span>{linked ? `Vínculos (${row.projectLinks.length})` : 'Vincular'}</span></Button>;
}

function StockMinimumInput({ row, onCommit }: { row: WarehouseStockOverviewRow; onCommit: (value: number) => void }) {
  const effective = row.effectiveMinStock ?? 0;
  const automatic = row.automaticMinStock ?? 0;
  const manualWins = row.minStock != null && row.minStock >= automatic;
  return <div className="space-y-1 text-center">
    <input key={`${effective}:${row.minStock}`} type="number" min="0" step="any" defaultValue={effective}
      aria-label={`Estoque mínimo de ${row.description}`}
      title="Limite do alerta. Usa o maior entre 30% do planejado e o mínimo manual. Apague para voltar ao automático."
      className="h-8 w-full rounded border border-border bg-background px-1 text-center text-xs tabular-nums"
      onBlur={event => {
        const raw = event.currentTarget.value;
        if (raw !== '' && Number(raw) === effective) return;
        const value = raw === '' ? NaN : Number(raw);
        if (Number.isFinite(value) && value < 0) { event.currentTarget.value = String(effective); return; }
        onCommit(value);
        event.currentTarget.value = String(Math.max(Number.isFinite(value) ? value : 0, automatic));
        if (Number.isFinite(value) && value < automatic) toast.info('O alerta mantém o mínimo automático de 30% do planejado.');
      }} />
    <span className="block whitespace-nowrap text-[10px] text-muted-foreground">{manualWins ? 'Manual' : automatic > 0 ? 'Auto · 30%' : 'Sem mínimo'}</span>
  </div>;
}

export default function WarehouseStockTab({ project, onProjectChange, auditActor, canArchive = true, canDelete = false }: Props) {
  const { confirm, dialog: confirmDialog } = useConfirmDelete();
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [showAllColumns, setShowAllColumns] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);
  const [linkFilter, setLinkFilter] = useState<'all' | 'linked' | 'pending' | 'unplanned'>('all');
  const [classFilter, setClassFilter] = useState<'all' | MaterialCostClass>('all');
  const [purchaseGroupFilter, setPurchaseGroupFilter] = useState('all');
  const [lowOnly, setLowOnly] = useState(false);
  const [zeroOnly, setZeroOnly] = useState(false);
  const [sort, setSort] = useState<StockSort>({ key: 'withdrawn', direction: 'desc' });
  const [manualForm, setManualForm] = useState({ code: '', description: '', unit: '' });
  const [historyFor, setHistoryFor] = useState<{ key: string; description: string } | null>(null);
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const rows = useMemo(
    () => computeWarehouseStockOverviewRows(project, showArchived),
    [project, showArchived],
  );
  const archivedCount = project.warehouse?.items.filter(item => !!item.archivedAt).length ?? 0;
  const purchaseGroups = useMemo(() => (project.materialComparisons ?? [])
    .map(comparison => ({ id: comparison.id, name: comparison.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')), [project.materialComparisons]);
  const projectMaterials = useMemo(() => suggestMaterialsFromProject(project).filter(material => material.quantity > 0), [project]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matchingRows = rows.filter(r => (!q || r.description.toLowerCase().includes(q) || (r.code ?? '').toLowerCase().includes(q))
      && (linkFilter === 'all' || r.linkStatus === linkFilter)
      && (classFilter === 'all' || r.costClass === classFilter)
      && (purchaseGroupFilter === 'all' || r.purchaseGroupId === purchaseGroupFilter)
      && (!lowOnly || r.underMin)
      && (!zeroOnly || r.balance === 0));
    return matchingRows.sort((a, b) => {
      const classOrder = stockClassOrder.indexOf(a.costClass) - stockClassOrder.indexOf(b.costClass);
      if (sort.key === 'costClass' && classOrder) return sort.direction === 'asc' ? classOrder : -classOrder;
      if (sort.key !== 'costClass' && classOrder) return classOrder;
      const aValue = a[sort.key];
      const bValue = b[sort.key];
      const comparison = typeof aValue === 'number' && typeof bValue === 'number'
        ? aValue - bValue
        : String(aValue ?? '').localeCompare(String(bValue ?? ''), 'pt-BR', { numeric: true });
      return (sort.direction === 'asc' ? comparison : -comparison)
        || a.description.localeCompare(b.description, 'pt-BR');
    });
  }, [classFilter, linkFilter, lowOnly, purchaseGroupFilter, rows, search, sort, zeroOnly]);

  const sortBy = (key: StockSortKey) => setSort(current => current.key === key
    ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: numericStockSortKeys.includes(key) ? 'desc' : 'asc' });
  const orderedClasses = sort.key === 'costClass' && sort.direction === 'desc' ? [...stockClassOrder].reverse() : stockClassOrder;

  const setMin = (key: string, code: string | undefined, description: string, unit: string, min: number) => {
    onProjectChange(upsertItemConfig(project, { key, code, description, unit, minStock: Number.isFinite(min) ? min : undefined }));
  };

  const createManual = () => {
    if (!manualForm.description.trim() || !manualForm.unit.trim()) return;
    onProjectChange(createManualWarehouseItem(project, manualForm));
    setManualForm({ code: '', description: '', unit: '' });
    setShowManualForm(false);
  };

  const handleArchiveItem = (key: string, description: string) => {
    confirm(
      {
        title: 'Arquivar e ocultar material?',
        description: (
          <div className="space-y-2">
            <p>O material <strong>{description}</strong> será ocultado das operações correntes.</p>
            <p className="font-medium">Saldo, notas, retiradas, vínculos e histórico permanecerão preservados para auditoria.</p>
          </div>
        ),
        confirmLabel: 'Arquivar e ocultar',
      },
      () => onProjectChange(removeWarehouseItem(project, key)),
    );
  };
  const setClassification = (row: WarehouseStockOverviewRow, costClass: MaterialCostClass) => {
    onProjectChange(setMaterialCostClass(project, row.classificationSubject, costClass));
  };
  const handleDeleteItem = (key: string, description: string) => confirm(
    { title: 'Excluir material definitivamente?', description: `O material ${description} será removido. Materiais com histórico exigem primeiro a correção do registro de origem.`, confirmLabel: 'Excluir definitivamente' },
    () => {
      try { onProjectChange(hardDeleteWarehouseItem(project, key)); toast.success('Material excluído definitivamente.'); }
      catch (error) { toast.error((error as Error).message); }
    },
  );

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <WarehouseSectionHeader icon={Boxes} title="Materiais em estoque" description="Busque, filtre e confira os saldos." help="A posição reúne materiais recebidos, retirados, perdas, custo médio, estoque mínimo e vínculos com o orçamento." />
      <div className="border-b border-border bg-muted/40 p-3">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(200px,1fr)_165px_minmax(180px,1fr)_190px]">
        <div className="relative min-w-0">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar insumo por descrição ou código..." className="min-h-11 pl-8 text-sm" />
        </div>
        <select className="min-h-11 min-w-0 rounded border bg-background px-2 text-sm" value={linkFilter} onChange={event => setLinkFilter(event.target.value as typeof linkFilter)} aria-label="Filtrar por vínculo"><option value="all">Todos os vínculos</option><option value="linked">Vinculados</option><option value="pending">Vínculo pendente</option><option value="unplanned">Não previstos</option></select>
        <select className="min-h-11 min-w-0 rounded border bg-background px-2 text-sm" value={purchaseGroupFilter} onChange={event => setPurchaseGroupFilter(event.target.value)} aria-label="Filtrar por grupo de compra"><option value="all">Todos os grupos</option>{purchaseGroups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
        <select className="min-h-11 min-w-0 rounded border bg-background px-2 text-sm" value={classFilter} onChange={event => setClassFilter(event.target.value as typeof classFilter)} aria-label="Filtrar por classificação"><option value="all">Todas as classificações</option>{stockClassOrder.map(costClass => <option key={costClass} value={costClass}>{stockClassLabel[costClass]}</option>)}</select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
        <Button size="sm" variant={lowOnly ? 'secondary' : 'outline'} aria-pressed={lowOnly} className="min-h-11 text-xs" onClick={() => setLowOnly(value => !value)}>Estoque baixo</Button>
        <Button size="sm" variant={zeroOnly ? 'secondary' : 'outline'} aria-pressed={zeroOnly} className="min-h-11 text-xs" onClick={() => setZeroOnly(value => !value)}>Saldo zerado</Button>
          <span className="mr-auto text-xs text-muted-foreground">Ordenado por <strong className="font-semibold text-foreground">{stockSortLabel[sort.key]}</strong> · {filtered.length} item(ns)</span>
        <Button size="sm" variant={showAllColumns ? 'secondary' : 'outline'} className="hidden min-h-11 text-xs md:inline-flex" aria-pressed={showAllColumns} onClick={() => setShowAllColumns(value => !value)}>{showAllColumns ? 'Visão resumida' : 'Todas as colunas'}</Button>
        <Button size="sm" variant="outline" className="min-h-11 text-xs" onClick={() => setShowManualForm(value => !value)}>
          {showManualForm ? <X className="w-3.5 h-3.5 mr-1" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
          Novo item avulso
        </Button>
        {archivedCount > 0 && (
          <Button size="sm" variant={showArchived ? 'secondary' : 'outline'} className="min-h-11 text-xs" onClick={() => setShowArchived(value => !value)}>
            <Archive className="mr-1 h-3.5 w-3.5" />
            {showArchived ? 'Ocultar arquivados' : `Exibir arquivados (${archivedCount})`}
          </Button>
        )}
        </div>
      </div>
      {showManualForm && (
        <div className="grid grid-cols-1 gap-3 border-b border-primary/20 bg-primary/5 p-3 md:grid-cols-12">
          <Input
            value={manualForm.code}
            onChange={e => setManualForm({ ...manualForm, code: e.target.value })}
            placeholder="Código opcional"
            className="min-h-11 text-base md:col-span-2 md:h-8 md:min-h-8 md:text-xs"
          />
          <Input
            value={manualForm.description}
            onChange={e => setManualForm({ ...manualForm, description: e.target.value })}
            placeholder="Descrição do material avulso"
            className="min-h-11 text-base md:col-span-7 md:h-8 md:min-h-8 md:text-xs"
          />
          <Input
            value={manualForm.unit}
            onChange={e => setManualForm({ ...manualForm, unit: e.target.value })}
            placeholder="Un."
            className="min-h-11 text-base md:col-span-1 md:h-8 md:min-h-8 md:text-xs"
            onKeyDown={e => {
              if (e.key === 'Enter') createManual();
            }}
          />
          <Button className="min-h-11 text-sm md:col-span-2 md:h-8 md:min-h-8 md:text-xs" onClick={createManual} disabled={!manualForm.description.trim() || !manualForm.unit.trim()}>
            Criar material
          </Button>
        </div>
      )}
      <div className="max-h-[calc(100dvh-300px)] overflow-auto">
        <div className="space-y-4 p-2 md:hidden">{orderedClasses.map(costClass => {
          const classRows = filtered.filter(row => row.costClass === costClass);
          return classRows.length > 0 && <section key={costClass} className="space-y-2"><div className="flex items-center gap-2 px-1 text-sm font-bold"><StockClassBadge costClass={costClass} /><span>{classRows.length} item(ns)</span></div>{classRows.map(row => <StockMobileCard key={row.key} row={row} canArchive={canArchive} onClassChange={setClassification} onLink={() => setLinkFor(row.key)} onHistory={() => setHistoryFor({ key: row.key, description: row.description })} onArchive={() => handleArchiveItem(row.key, row.description)} />)}</section>;
        })}</div>
        <table className={`warehouse-stock-table hidden w-full table-fixed text-sm md:table ${showAllColumns ? 'min-w-[1900px]' : 'warehouse-stock-summary'}`}>
          <colgroup>
            <col className="w-24" />
            <col className="w-80" />
            <col className="w-36" />
            <col className="w-12" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-24" />
            <col className="w-24" />
            <col className="w-24" />
            <col className="w-28" />
            <col className="w-36" />
            {canArchive && <col className="w-12" />}
            {canDelete && <col className="w-12" />}
          </colgroup>
            <thead className="bg-muted sticky top-0 z-10">
            <tr className="text-muted-foreground">
              <StockSortableHeader label="Código" sortKey="code" sort={sort} onSort={sortBy} />
              <StockSortableHeader label="Descrição" sortKey="description" sort={sort} onSort={sortBy} />
              <StockSortableHeader label="Classificação" sortKey="costClass" sort={sort} onSort={sortBy} icon={Boxes} />
              <StockSortableHeader label="Un" sortKey="unit" sort={sort} onSort={sortBy} align="center" />
              <StockSortableHeader label="Planej." sortKey="planned" sort={sort} onSort={sortBy} align="right" />
              <StockSortableHeader label="Aditivo" sortKey="additive" sort={sort} onSort={sortBy} align="right" className="text-primary" />
              <StockSortableHeader label="Comprado" sortKey="purchased" sort={sort} onSort={sortBy} align="right" />
              <StockSortableHeader label="Receb." sortKey="received" sort={sort} onSort={sortBy} align="right" />
              <StockSortableHeader label="Já retirado" sortKey="withdrawn" sort={sort} onSort={sortBy} align="right" className="bg-primary/10 text-primary" />
              <StockSortableHeader label="Devolvido" sortKey="returned" sort={sort} onSort={sortBy} align="right" className="text-success" />
              <StockSortableHeader label="Perdas" sortKey="losses" sort={sort} onSort={sortBy} align="right" />
              <StockSortableHeader label="Saldo" sortKey="balance" sort={sort} onSort={sortBy} align="right" className="bg-primary/5" />
              <StockSortableHeader label="Mínimo" sortKey="effectiveMinStock" sort={sort} onSort={sortBy} align="center" className="bg-warning/5" />
              <StockSortableHeader label="Último mov." sortKey="lastMovementDate" sort={sort} onSort={sortBy} />
              <StockSortableHeader label="Custo médio" sortKey="averageUnitCost" sort={sort} onSort={sortBy} align="right" />
              <StockSortableHeader label="Vínculo" sortKey="linkStatus" sort={sort} onSort={sortBy} />
              <th className="p-2 text-center font-semibold">Hist.</th>
              {canArchive && <th className="p-2 text-center font-semibold">Arquivar</th>}
              {canDelete && <th className="p-2 text-center font-semibold"><span className="sr-only">Excluir</span></th>}
            </tr>
          </thead>
          <tbody>
            {orderedClasses.map(costClass => {
              const classRows = filtered.filter(row => row.costClass === costClass);
              return <Fragment key={costClass}>{classRows.length > 0 && <tr data-testid="stock-class-group" className="border-t bg-muted/70"><td colSpan={17 + Number(canArchive) + Number(canDelete)} className="p-2"><div className="flex items-center gap-2"><StockClassBadge costClass={costClass} /><span className="text-xs font-semibold text-muted-foreground">{classRows.length} item(ns)</span></div></td></tr>}{classRows.map(r => (
              <tr key={r.key} data-testid="stock-material-row" className={`border-t border-border hover:bg-muted/30 ${r.withdrawn > 0 ? 'bg-primary/5' : ''} ${r.underMin ? 'bg-destructive/5' : ''} ${!r.isPhysicalStock ? 'bg-muted/20' : ''}`}>
                <td className="p-1.5 font-mono text-[10px] text-muted-foreground truncate">{r.code || '—'}</td>
                <td className="p-1.5 leading-snug break-words" title={r.description}><span className="block font-semibold">{r.description}</span></td>
                <td className="p-1.5"><StockClassSelect row={r} onChange={setClassification} /></td>
                <td className="p-1.5 text-center text-muted-foreground">{r.unit}</td>
                <td className="p-1.5 text-right font-mono tabular-nums">{r.planned.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono tabular-nums text-primary">{r.additive.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono tabular-nums">{r.purchased.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono tabular-nums text-success">{r.received.toLocaleString('pt-BR')}</td>
                <td className="bg-primary/5 p-1.5 text-right font-mono font-semibold tabular-nums text-primary">{r.withdrawn.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono tabular-nums text-success">{r.returned.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono tabular-nums text-destructive">{r.losses.toLocaleString('pt-BR')}</td>
                <td className={`p-1.5 text-right font-mono tabular-nums font-bold bg-primary/5 ${r.balance < 0 ? 'text-destructive' : r.underMin ? 'text-warning' : 'text-primary'}`}>{r.balance.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 bg-warning/5">
                  {r.isPhysicalStock && r.costClass === 'material' ? <StockMinimumInput row={r} onCommit={value => setMin(r.key, r.code, r.description, r.unit, value)} /> : <span className="text-[10px] text-muted-foreground">Não se aplica</span>}
                </td>
                <td className="p-1.5 text-[10px] text-muted-foreground">{r.lastMovementDate ?? '—'}</td>
                <td className="p-1.5 text-right font-mono text-[11px]">{r.valuationIncomplete || r.averageUnitCost == null ? 'Cálculo incompleto' : r.averageUnitCost.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
                <td className="p-1.5">{r.isPhysicalStock ? <StockLinkButton row={r} onClick={() => setLinkFor(r.key)} /> : <span className="block rounded border border-dashed px-2 py-1.5 text-center text-[10px] text-muted-foreground">Sem estoque físico</span>}</td>
                <td className="p-1.5 text-center">
                  {r.isPhysicalStock && <Button size="icon" variant="ghost" className="h-7 w-7" title="Histórico de compras"
                    onClick={() => setHistoryFor({ key: r.key, description: r.description })}>
                    <History className="w-3.5 h-3.5" />
                  </Button>}
                </td>
                {canArchive && <td className="p-1.5 text-center">{r.isPhysicalStock &&
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    title="Arquivar e ocultar material"
                    onClick={() => handleArchiveItem(r.key, r.description)}
                  >
                    <Archive className="w-3.5 h-3.5" />
                  </Button>
                }</td>}
                {canDelete && <td className="p-1.5 text-center">{r.isPhysicalStock &&
                  <Button size="icon" variant="destructive" className="h-7 w-7" title="Excluir material definitivamente" onClick={() => handleDeleteItem(r.key, r.description)}>
                    <X className="w-3.5 h-3.5" />
                  </Button>
                }</td>}
              </tr>
            ))}</Fragment>;
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={17 + Number(canArchive) + Number(canDelete)} className="p-8 text-center text-muted-foreground italic">Nenhum item encontrado.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <MaterialLinkDialog
        key={linkFor ?? 'closed'}
        project={project}
        itemKey={linkFor}
        projectMaterials={projectMaterials}
        auditActor={auditActor}
        canUnlink={canArchive}
        onProjectChange={onProjectChange}
        onClose={() => setLinkFor(null)}
      />
      <PurchaseHistoryDialog project={project} target={historyFor} onClose={() => setHistoryFor(null)} />
      {confirmDialog}
    </div>
  );
}

function StockMobileCard({ row, canArchive, onClassChange, onLink, onHistory, onArchive }: {
  row: WarehouseStockOverviewRow;
  canArchive: boolean;
  onClassChange: (row: WarehouseStockOverviewRow, costClass: MaterialCostClass) => void;
  onLink: () => void;
  onHistory: () => void;
  onArchive: () => void;
}) {
  return <article className={`space-y-3 rounded-xl border p-3 shadow-sm ${row.underMin ? 'border-destructive/50 bg-destructive/5' : row.isPhysicalStock ? 'border-primary/25 bg-primary/5' : 'bg-muted/25'}`}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="text-xs font-medium text-muted-foreground">{row.code || 'Sem código'} · {row.unit}</div><div className="font-bold leading-snug">{row.description}</div></div><WarehouseStatusBadge label={row.isPhysicalStock ? (row.underMin ? 'Estoque baixo' : 'Estoque físico') : 'Planejamento'} tone={row.underMin ? 'danger' : row.isPhysicalStock ? 'success' : 'neutral'} /></div><label className="block"><span className="mb-1 block text-xs font-semibold text-muted-foreground">Classificação</span><StockClassSelect row={row} onChange={onClassChange} mobile /></label><dl className="grid grid-cols-2 gap-2 text-sm"><div><dt className="text-xs text-muted-foreground">Contratado</dt><dd className="font-semibold">{row.contracted.toLocaleString('pt-BR')} {row.unit}</dd></div><div><dt className="text-xs text-muted-foreground">Aditivo</dt><dd className="font-semibold text-primary">{row.additive.toLocaleString('pt-BR')} {row.unit}</dd></div><div><dt className="text-xs text-muted-foreground">Planejado</dt><dd className="font-semibold">{row.planned.toLocaleString('pt-BR')} {row.unit}</dd></div>{row.isPhysicalStock ? <><div><dt className="text-xs text-muted-foreground">Saldo disponível</dt><dd className={`font-bold ${row.underMin ? 'text-destructive' : 'text-primary'}`}>{row.balance.toLocaleString('pt-BR')} {row.unit}</dd></div><div><dt className="text-xs text-muted-foreground">Já retirado</dt><dd>{row.withdrawn.toLocaleString('pt-BR')} {row.unit}</dd></div>{row.costClass === 'material' && <div><dt className="text-xs text-muted-foreground">Estoque baixo</dt><dd className={row.underMin ? 'font-bold text-destructive' : ''}>{row.effectiveMinStock?.toLocaleString('pt-BR') ?? '—'} {row.unit}</dd></div>}</> : <div className="col-span-2 rounded-lg bg-muted/60 p-2 text-xs text-muted-foreground">Sem estoque físico: aguarda compra, nota fiscal ou cadastro no almoxarifado.</div>}</dl>{row.isPhysicalStock && <div className={`grid gap-2 ${canArchive ? 'grid-cols-3' : 'grid-cols-2'}`}><StockLinkButton row={row} onClick={onLink} mobile /><Button variant="outline" className="min-h-11" onClick={onHistory}><History className="h-4 w-4" /><span>Histórico</span></Button>{canArchive && <Button variant="outline" className="min-h-11 text-destructive" onClick={onArchive}><Archive className="h-4 w-4" /><span>Arquivar</span></Button>}</div>}</article>;
}

function MaterialLinkDialog({ project, itemKey, projectMaterials, auditActor, canUnlink, onProjectChange, onClose }: {
  project: Project;
  itemKey: string | null;
  projectMaterials: ReturnType<typeof suggestMaterialsFromProject>;
  auditActor?: WarehouseAuditActor;
  canUnlink: boolean;
  onProjectChange: (project: Project) => void;
  onClose: () => void;
}) {
  const row = useMemo(() => itemKey ? computeWarehouseRows(project, { includeManual: true, includeArchived: true }).find(candidate => candidate.key === itemKey) : undefined, [itemKey, project]);
  const [projectMaterialKey, setProjectMaterialKey] = useState('');
  const [projectMaterialOpen, setProjectMaterialOpen] = useState(false);
  const [conversionFactor, setConversionFactor] = useState('1');
  const [unplannedReason, setUnplannedReason] = useState(row?.unplannedReason || '');
  const selectedMaterial = projectMaterials.find(material => material.key === projectMaterialKey);

  const addLink = () => {
    if (!row || !selectedMaterial) return toast.error('Selecione um insumo previsto.');
    const factor = Number(conversionFactor.replace(',', '.'));
    try {
      onProjectChange(upsertWarehouseProjectMaterialLink(project, {
        warehouseItemKey: row.key,
        projectMaterialKey: selectedMaterial.key,
        projectMaterialCode: selectedMaterial.code,
        projectMaterialDescription: selectedMaterial.description,
        projectMaterialUnit: selectedMaterial.unit,
        conversionFactor: factor,
        source: 'manual',
      }, auditActor));
      setProjectMaterialKey('');
      setProjectMaterialOpen(false);
      setConversionFactor('1');
      toast.success('Vínculo confirmado. O previsto foi incorporado ao material canônico.');
    } catch (error) { toast.error((error as Error).message); }
  };

  const markUnplanned = () => {
    if (!row || !unplannedReason.trim()) return toast.error('Informe a justificativa do material não previsto.');
    onProjectChange(upsertItemConfig(project, {
      key: row.key,
      code: row.code,
      description: row.description,
      unit: row.unit,
      manualItem: row.manualItem,
      minStock: row.minStock,
      purchaseGroupId: row.purchaseGroupId,
      unplannedReason: unplannedReason.trim(),
    }));
    toast.success('Material classificado como não previsto.');
  };

  return <Dialog open={!!itemKey} onOpenChange={open => !open && onClose()}><DialogContent className="warehouse-ui max-w-3xl"><DialogHeader><DialogTitle>Revisar vínculos do material</DialogTitle><DialogDescription>{row?.description} · Um material físico pode representar mais de um insumo previsto.</DialogDescription></DialogHeader>{row && <div className="space-y-4"><div className="grid gap-3 rounded-md border p-3 md:grid-cols-[1fr_130px_auto]"><div className="min-w-0"><label className="mb-1 block text-xs font-semibold">Insumo previsto</label><Popover open={projectMaterialOpen} onOpenChange={setProjectMaterialOpen}><PopoverTrigger asChild><Button variant="outline" role="combobox" aria-expanded={projectMaterialOpen} aria-label="Selecionar insumo previsto" className="min-h-11 w-full justify-between px-3 font-normal"><span className={cn('truncate text-left', !selectedMaterial && 'text-muted-foreground')}>{selectedMaterial?.description || 'Pesquisar insumo previsto'}</span><ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" /></Button></PopoverTrigger><PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0"><Command><CommandInput placeholder="Digite uma palavra-chave..." /><CommandList><CommandEmpty>Nenhum insumo previsto encontrado.</CommandEmpty><CommandGroup>{projectMaterials.map(material => <CommandItem key={material.key} value={`${material.description} ${material.unit}`} onSelect={() => { setProjectMaterialKey(material.key); setConversionFactor(material.unit.trim().toLowerCase() === row.unit.trim().toLowerCase() ? '1' : ''); setProjectMaterialOpen(false); }} className="min-h-11 gap-2"><Check className={cn('h-4 w-4 shrink-0', projectMaterialKey === material.key ? 'opacity-100' : 'opacity-0')} /><span className="min-w-0 flex-1"><span className="block whitespace-normal leading-snug">{material.description}</span><span className="block text-xs text-muted-foreground">Previsto: {material.quantity.toLocaleString('pt-BR')} {material.unit}</span></span></CommandItem>)}</CommandGroup></CommandList></Command></PopoverContent></Popover></div><div><label className="mb-1 block text-xs font-semibold">Conversão</label><Input className="min-h-11 text-center" value={conversionFactor} onChange={event => setConversionFactor(event.target.value)} placeholder="Fator" /></div><Button className="min-h-11 self-end" onClick={addLink}><Link2 className="mr-2 h-4 w-4" />Vincular</Button></div><div><h4 className="mb-2 text-sm font-semibold">Vínculos confirmados</h4>{row.projectLinks.map(link => <div key={link.id} className="flex min-h-11 items-center gap-2 border-t py-2"><span className="min-w-0 flex-1 text-sm">{link.projectMaterialDescription} ({link.projectMaterialUnit})</span><span className="text-xs text-muted-foreground">fator {link.conversionFactor}</span>{canUnlink && <Button size="icon" variant="ghost" className="min-h-11 min-w-11 text-destructive" onClick={() => onProjectChange(unlinkWarehouseProjectMaterial(project, link.id, auditActor))} aria-label={`Desvincular ${link.projectMaterialDescription}`}><Unlink className="h-4 w-4" /></Button>}</div>)}{!row.projectLinks.length && <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">Nenhum vínculo confirmado.</div>}</div>{!row.projectLinks.length && <div className="rounded-md border border-warning/30 bg-warning/5 p-3"><label className="mb-1 block text-xs font-semibold">Ou classifique como material não previsto</label><div className="flex gap-2"><Input className="min-h-11" value={unplannedReason} onChange={event => setUnplannedReason(event.target.value)} placeholder="Justificativa obrigatória" /><Button variant="outline" className="min-h-11" onClick={markUnplanned}>Confirmar</Button></div></div>}</div>}<div className="flex justify-end"><Button variant="outline" onClick={onClose}>Fechar</Button></div></DialogContent></Dialog>;
}

function moneyBR(value?: number) {
  if (value == null) return '—';
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function PurchaseHistoryDialog({ project, target, onClose }: { project: Project; target: { key: string; description: string } | null; onClose: () => void }) {
  const history = useMemo(() => (target ? getMaterialPurchaseHistory(project, target.key) : []), [project, target]);

  const openAttachment = async (att: NonNullable<ReturnType<typeof getMaterialPurchaseHistory>[number]['attachment']>) => {
    try {
      await openWarehouseAttachment(att);
    } catch (error) {
      toast.error(warehouseAttachmentErrorMessage(error));
    }
  };

  const downloadAttachment = async (att: NonNullable<ReturnType<typeof getMaterialPurchaseHistory>[number]['attachment']>) => {
    try {
      await downloadWarehouseAttachment(att);
    } catch (error) {
      toast.error(warehouseAttachmentErrorMessage(error));
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={open => !open && onClose()}>
      <DialogContent className="warehouse-ui max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Histórico de compras</DialogTitle>
          <DialogDescription>{target?.description}</DialogDescription>
        </DialogHeader>
        <div className="bg-card border border-border rounded-md overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="p-2 text-left">Data</th>
                <th className="p-2 text-left">Nota</th>
                <th className="p-2 text-left">Fornecedor</th>
                <th className="p-2 text-right">Qtd</th>
                <th className="p-2 text-right">V. Unit</th>
                <th className="p-2 text-right">Total</th>
                <th className="p-2 text-center">Arquivo</th>
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h.movementId} className="border-t border-border">
                  <td className="p-2">{h.date ? h.date.split('-').reverse().join('/') : '—'}</td>
                  <td className="p-2 font-mono">{h.invoiceNumber || '—'}</td>
                  <td className="p-2">{h.supplierName || '—'}</td>
                  <td className="p-2 text-right tabular-nums">{h.quantity.toLocaleString('pt-BR')} {h.unit ?? ''}</td>
                  <td className="p-2 text-right tabular-nums">{moneyBR(h.unitPrice)}</td>
                  <td className="p-2 text-right tabular-nums font-semibold">{moneyBR(h.totalPrice)}</td>
                  <td className="p-2 text-center">
                    {h.attachment ? (
                      <div className="flex items-center justify-center gap-1">
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void openAttachment(h.attachment!)} title="Visualizar NF" aria-label="Visualizar NF">
                          <Eye className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void downloadAttachment(h.attachment!)} title="Baixar NF" aria-label="Baixar NF">
                          <Download className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground italic">Sem compras registradas para este material.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
