import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, WarehouseAuditActor, WarehouseMovement, WarehouseRequisition, WarehouseRequisitionItem } from '@/types/project';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Camera, Check, ChevronDown, FileDown, HardHat, History, ImagePlus, PackageOpen, Pencil, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react';
import {
  computeWarehouseRows,
  correctDeliveredRequisition,
  createAndDeliverRequisition,
  ensureWarehouse,
  hardDeleteRequisition,
  getReturnableRequisitionItems,
  makeAttachment,
  registerMaterialReturn,
  uidWarehouse,
  warehouseActorName,
} from '@/lib/warehouse';
import { deleteWarehouseAttachments } from '@/lib/warehouseAttachments';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { flattenPhasesByChapter, getChapterNumbering } from '@/lib/chapters';
import SignaturePad from './SignaturePad';
import { generateRequisitionReceipt } from './pdf';
import WarehouseAuditIdentity from './WarehouseAuditIdentity';
import WarehouseCustodyTab from './WarehouseCustodyTab';
import {
  WarehouseActionBar,
  WarehouseEmptyState,
  WarehouseField,
  WarehouseSectionHeader,
  WarehouseStatusBadge,
} from './WarehouseVisual';
import { toast } from 'sonner';

interface Props { project: Project; onProjectChange: (next: Project) => void; auditActor?: WarehouseAuditActor; canDelete?: boolean; canEdit?: boolean; }

interface WithdrawalForm {
  date: string;
  chapterId: string;
  receiverName: string;
  notes: string;
  items: WarehouseRequisitionItem[];
  signatureReceiver?: string;
  deliveryIdempotencyKey: string;
}

type WithdrawalErrors = Partial<Record<'chapterId' | 'receiverName' | 'items' | 'signatureReceiver', string>>;

const initialForm = (): WithdrawalForm => ({
  date: new Date().toISOString().slice(0, 10),
  chapterId: '',
  receiverName: '',
  notes: '',
  items: [],
  deliveryIdempotencyKey: uidWarehouse(),
});

const normalizeSearch = (value?: string) => (value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('pt-BR')
  .trim();

type TimestampedWarehouseRecord = { createdAt?: string; updatedAt?: string };

const hasRecordedTime = (value?: string) => !!value && /^\d{4}-\d{2}-\d{2}T/.test(value);

function formatOperationalDate(value?: string) {
  if (!value) return 'Data operacional não informada';
  const [year, month, day] = value.slice(0, 10).split('-');
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function recordTimestamp(record: TimestampedWarehouseRecord, fallbackDate?: string) {
  return record.updatedAt || record.createdAt || fallbackDate || '';
}

function formatRecordedAt(record: TimestampedWarehouseRecord, fallbackDate?: string) {
  const timestamp = recordTimestamp(record, fallbackDate);
  if (!hasRecordedTime(timestamp)) return `Registro legado: ${formatOperationalDate(timestamp || fallbackDate)} (horário não informado)`;
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(timestamp));
}

function chapterPathLabel(project: Project, chapterId?: string, fallback?: string) {
  if (!chapterId) return fallback || 'Registro legado';
  const phaseById = new Map(project.phases.map(phase => [phase.id, phase]));
  const numbering = getChapterNumbering(project);
  const path: string[] = [];
  const visited = new Set<string>();
  let current = phaseById.get(chapterId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current.name);
    current = current.parentId ? phaseById.get(current.parentId) : undefined;
  }
  if (!path.length) return fallback || 'Destino não encontrado';
  const number = numbering.get(chapterId);
  return `${number ? `${number} · ` : ''}${path.join(' > ')}`;
}

function latestRequisitionActivity(requisition: WarehouseRequisition, movements: WarehouseMovement[]) {
  return movements
    .filter(movement => movement.type === 'devolucao' && movement.originType === 'return' && movement.requisitionId === requisition.id && !movement.reversedById)
    .reduce((latest, movement) => {
      const candidate = recordTimestamp(movement, movement.date);
      return candidate > latest ? candidate : latest;
    }, recordTimestamp(requisition, requisition.date));
}

type RequisitionBuildingGroup = {
  key: string;
  label: string;
  requisitions: WarehouseRequisition[];
  itemCount: number;
  isMissingBuilding: boolean;
};

function buildingLabel(project: Project, chapterId?: string) {
  if (!chapterId) return { key: 'missing-building', label: 'Prédio não informado', isMissingBuilding: true };
  const phaseById = new Map(project.phases.map(phase => [phase.id, phase]));
  const visited = new Set<string>();
  let building = phaseById.get(chapterId);
  while (building?.parentId && !visited.has(building.id)) {
    visited.add(building.id);
    building = phaseById.get(building.parentId);
  }
  if (!building) return { key: 'missing-building', label: 'Prédio não informado', isMissingBuilding: true };
  const number = getChapterNumbering(project).get(building.id);
  return { key: building.id, label: `${number ? `${number} · ` : ''}${building.name}`, isMissingBuilding: false };
}

function rootChapterId(project: Project, chapterId?: string) {
  if (!chapterId) return undefined;
  const phaseById = new Map(project.phases.map(phase => [phase.id, phase]));
  const visited = new Set<string>();
  let chapter = phaseById.get(chapterId);
  while (chapter?.parentId && !visited.has(chapter.id)) {
    visited.add(chapter.id);
    chapter = phaseById.get(chapter.parentId);
  }
  return chapter?.id;
}

function groupRequisitionsByBuilding(project: Project, requisitions: WarehouseRequisition[], movements: WarehouseMovement[]): RequisitionBuildingGroup[] {
  const byBuilding = new Map<string, WarehouseRequisition[]>();
  for (const requisition of requisitions) {
    const building = buildingLabel(project, requisition.chapterId);
    byBuilding.set(building.key, [...(byBuilding.get(building.key) ?? []), requisition]);
  }

  return Array.from(byBuilding.entries()).map(([key, buildingRequisitions]) => {
    const building = buildingLabel(project, buildingRequisitions[0].chapterId);
    return {
      key,
      label: building.label,
      isMissingBuilding: building.isMissingBuilding,
      requisitions: buildingRequisitions.slice().sort((left, right) => {
      const rightTimestamp = latestRequisitionActivity(right, movements);
      const leftTimestamp = latestRequisitionActivity(left, movements);
      return rightTimestamp.localeCompare(leftTimestamp) || right.number.localeCompare(left.number, 'pt-BR', { numeric: true });
      }),
      itemCount: buildingRequisitions.reduce((total, requisition) => total + requisition.items.length, 0),
    };
  }).sort((left, right) => Number(left.isMissingBuilding) - Number(right.isMissingBuilding) || left.label.localeCompare(right.label, 'pt-BR', { numeric: true }));
}

export default function WarehouseRequisitionsTab(props: Props) {
  return (
    <Tabs defaultValue="materiais" className="space-y-3">
      <TabsList className="grid h-auto min-h-12 w-full grid-cols-2 rounded-xl border bg-muted/70 p-1 shadow-sm sm:w-fit sm:min-w-[400px]">
        <TabsTrigger value="materiais" className="min-h-11 rounded-lg font-bold data-[state=active]:bg-card data-[state=active]:text-primary"><PackageOpen className="mr-2 h-4 w-4" />Materiais</TabsTrigger>
        <TabsTrigger value="equipamentos" className="min-h-11 rounded-lg font-bold data-[state=active]:bg-card data-[state=active]:text-primary"><HardHat className="mr-2 h-4 w-4" />Equipamentos / Cautelas</TabsTrigger>
      </TabsList>
      <TabsContent value="materiais" className="mt-0"><WarehouseMaterialWithdrawalsTab {...props} /></TabsContent>
      <TabsContent value="equipamentos" className="mt-0"><WarehouseCustodyTab {...props} /></TabsContent>
    </Tabs>
  );
}

function WarehouseMaterialWithdrawalsTab({ project, onProjectChange, auditActor, canDelete = false, canEdit = false }: Props) {
  const { confirm, dialog: confirmDialog } = useConfirmDelete();
  const wh = ensureWarehouse(project).warehouse!;
  const rows = useMemo(() => computeWarehouseRows(project, { includeManual: true }), [project]);
  const numbering = useMemo(() => getChapterNumbering(project), [project]);
  const chapters = useMemo(
    () => flattenPhasesByChapter(project).filter(phase => !phase.parentId).map(phase => ({
      id: phase.id,
      name: `${numbering.get(phase.id) ?? phase.customNumber ?? ''} · ${phase.name}`.replace(/^\s*·\s*/, ''),
    })),
    [numbering, project],
  );
  const [open, setOpen] = useState(false);
  const [expandedRequisitionIds, setExpandedRequisitionIds] = useState<Set<string>>(() => new Set());
  const [form, setForm] = useState<WithdrawalForm>(initialForm);
  const [materialSearch, setMaterialSearch] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<WithdrawalErrors>({});
  const [returnTarget, setReturnTarget] = useState<WarehouseRequisition | null>(null);
  const [correctionTarget, setCorrectionTarget] = useState<WarehouseRequisition | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const buildingGroups = useMemo(
    () => groupRequisitionsByBuilding(project, wh.requisitions, wh.movements),
    [project, wh.movements, wh.requisitions],
  );

  const availableMaterials = useMemo(() => {
    const tokens = normalizeSearch(materialSearch).split(/\s+/).filter(Boolean);
    return rows.filter(row => row.balance > 0 && !form.items.some(item => item.itemKey === row.key))
      .filter(row => {
        const haystack = normalizeSearch([row.code, row.description, row.unit].filter(Boolean).join(' '));
        return tokens.every(token => haystack.includes(token));
      });
  }, [form.items, materialSearch, rows]);

  const reset = () => {
    setForm(initialForm());
    setPhotos([]);
    setMaterialSearch('');
    setErrors({});
    setOpen(false);
  };

  const deleteRequisition = (requisition: WarehouseRequisition) => confirm(
    { title: 'Excluir retirada definitivamente?', description: 'A retirada, as devoluções vinculadas, seus comprovantes, movimentos e o bloco gerado no Diário de Obra serão removidos.', confirmLabel: 'Excluir definitivamente' },
    async () => {
      onProjectChange(hardDeleteRequisition(project, requisition.id));
      try { await deleteWarehouseAttachments(requisition.deliveryAttachments); } catch { toast.warning('A retirada foi excluída, mas houve falha ao remover um anexo do Storage.'); }
      setExpandedRequisitionIds(current => {
        const next = new Set(current);
        next.delete(requisition.id);
        return next;
      });
      toast.success('Retirada excluída e saldo recalculado.');
    },
  );

  const addMaterial = (key: string) => {
    const row = rows.find(candidate => candidate.key === key);
    if (!row || row.balance <= 0) return;
    setForm(current => ({
      ...current,
      items: [...current.items, {
        itemKey: row.key,
        code: row.code,
        description: row.description,
        unit: row.unit,
        quantity: 1,
      }],
    }));
    setMaterialSearch('');
    setErrors(current => ({ ...current, items: undefined }));
  };

  const updateQuantity = (index: number, quantity: number) => {
    setForm(current => ({
      ...current,
      items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, quantity } : item),
    }));
  };

  const addPhotos = (files: FileList | null) => {
    if (!files) return;
    const incoming = Array.from(files).filter(file => file.type.startsWith('image/'));
    const next = [...photos, ...incoming].slice(0, 3);
    setPhotos(next);
    if (cameraRef.current) cameraRef.current.value = '';
    if (galleryRef.current) galleryRef.current.value = '';
    if (photos.length + incoming.length > 3) toast.warning('A retirada aceita no máximo três fotos.');
  };

  const submit = async () => {
    const chapter = chapters.find(candidate => candidate.id === form.chapterId);
    const nextErrors: WithdrawalErrors = {};
    if (!chapter) nextErrors.chapterId = 'Selecione o destino.';
    if (!form.receiverName.trim()) nextErrors.receiverName = 'Informe quem recebeu.';
    if (!form.items.length) nextErrors.items = 'Adicione ao menos um material.';
    const invalid = form.items.find(item => !(item.quantity > 0));
    if (invalid) nextErrors.items = `Revise a quantidade de ${invalid.description}.`;
    const exceeds = form.items.find(item => item.quantity > (rows.find(row => row.key === item.itemKey)?.balance ?? 0));
    if (exceeds) nextErrors.items = `${exceeds.description}: quantidade maior que o saldo.`;
    if (!form.signatureReceiver) nextErrors.signatureReceiver = 'Colete a assinatura.';
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      const first = ['chapterId', 'receiverName', 'items', 'signatureReceiver'].find(key => nextErrors[key as keyof WithdrawalErrors]);
      const targets: Record<string, string> = { chapterId: 'withdrawal-chapter', receiverName: 'withdrawal-receiver', items: 'withdrawal-material-search' };
      const target = first === 'signatureReceiver'
        ? document.querySelector<HTMLElement>('[aria-label="Assinatura de quem recebeu"]')
        : document.getElementById(targets[first ?? ''] ?? '');
      target?.focus();
      toast.error(nextErrors[first as keyof WithdrawalErrors] ?? 'Revise os campos destacados.');
      return;
    }
    setErrors({});

    try {
      setSaving(true);
      const deliveryAttachments = await Promise.all(photos.map(file => makeAttachment(file, project.id, 'foto', 'withdrawals')));
      const result = createAndDeliverRequisition(project, {
        date: form.date,
        chapterId: chapter.id,
        chapterName: chapter.name,
        receiverName: form.receiverName.trim(),
        requesterName: form.receiverName.trim(),
        notes: form.notes.trim() || undefined,
        items: form.items,
        signatureReceiver: form.signatureReceiver,
        deliveryAttachments,
        deliveryIdempotencyKey: form.deliveryIdempotencyKey,
      }, { publishToDailyReport: true, actor: auditActor });
      onProjectChange(result.project);
      setExpandedRequisitionIds(current => new Set([...current, result.requisitionId]));
      reset();
      toast.success('Retirada registrada e estoque baixado.');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <input ref={cameraRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={event => addPhotos(event.target.files)} />
      <input ref={galleryRef} className="hidden" type="file" accept="image/*" multiple onChange={event => addPhotos(event.target.files)} />

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3 shadow-sm">
        <Button className="min-h-11" onClick={() => setOpen(value => !value)}>
          {open ? <X className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
          {open ? 'Fechar retirada' : 'Nova retirada'}
        </Button>
        <span className="text-sm font-medium text-muted-foreground">Preencha os dados e escolha os materiais.</span>
        <span className="ml-auto text-xs text-muted-foreground">{wh.requisitions.length} registro(s)</span>
      </div>

      {open && (
        <section className="space-y-4 rounded-xl border bg-card p-3 shadow-sm">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <WarehouseField label="Data"><Input id="withdrawal-date" className="min-h-11 text-base" type="date" value={form.date} onChange={event => setForm({ ...form, date: event.target.value })} /></WarehouseField>
            <WarehouseField label="Prédio / capítulo" error={errors.chapterId}><select id="withdrawal-chapter" className="min-h-11 w-full rounded-md border bg-background px-3 text-base" value={form.chapterId} onChange={event => { setForm({ ...form, chapterId: event.target.value }); setErrors(current => ({ ...current, chapterId: undefined })); }}><option value="">Selecione</option>{chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.name}</option>)}</select></WarehouseField>
            <WarehouseField label="Quem recebeu" error={errors.receiverName}><Input id="withdrawal-receiver" className="min-h-11 text-base" value={form.receiverName} onChange={event => { setForm({ ...form, receiverName: event.target.value }); setErrors(current => ({ ...current, receiverName: undefined })); }} placeholder="Nome do recebedor" /></WarehouseField>
          </div>
          <div className="text-xs text-muted-foreground">Almoxarife identificado pelo login: <strong className="text-foreground">{warehouseActorName(auditActor)}</strong></div>

          <div className="overflow-hidden rounded-xl border">
            <WarehouseSectionHeader icon={PackageOpen} title="Escolha os materiais" description="Toque no material para adicionar." help="A busca encontra código, descrição e unidade. Somente materiais com saldo disponível aparecem nesta lista." />
            <div className="p-3">
              <div className="mb-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><div className="text-sm font-bold text-primary">Materiais selecionados</div><WarehouseStatusBadge label={`${form.items.length} item(ns)`} tone={form.items.length ? 'info' : 'neutral'} /></div>
                <div className="grid gap-2">
                  {form.items.map((item, index) => {
                    const row = rows.find(candidate => candidate.key === item.itemKey);
                    const balance = row?.balance ?? 0;
                    const after = balance - Number(item.quantity || 0);
                    return <div key={item.itemKey} className="grid min-h-16 items-center gap-2 rounded-lg border border-primary/25 bg-background p-3 shadow-sm sm:grid-cols-[1fr_120px_180px_44px]"><div className="min-w-0"><div className="truncate text-sm font-bold">{item.description}</div><div className="text-xs text-muted-foreground">{item.code || 'Sem código'} · {item.unit}</div></div><Input className="min-h-11 text-center text-base" type="number" min="0" max={balance} step="any" value={item.quantity || ''} onChange={event => updateQuantity(index, Number(event.target.value))} aria-label={`Quantidade de ${item.description}`} /><div className="rounded-md bg-primary/5 p-2 text-center text-xs"><span>Saldo {balance.toLocaleString('pt-BR')}</span> − <strong>{Number(item.quantity || 0).toLocaleString('pt-BR')}</strong> = <span className={after < 0 ? 'text-destructive' : 'text-primary'}>{after.toLocaleString('pt-BR')} {item.unit}</span></div><Button size="icon" variant="ghost" className="min-h-11 min-w-11 text-destructive" onClick={() => setForm(current => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }))} aria-label={`Remover ${item.description}`}><Trash2 className="h-4 w-4" /></Button></div>;
                  })}
                  {!form.items.length && <div className="rounded-lg border border-dashed bg-background/60 p-3 text-sm text-muted-foreground">Nenhum material selecionado. Escolha abaixo os materiais da retirada.</div>}
                </div>
              </div>
              <label htmlFor="withdrawal-material-search" className="sr-only">Buscar material para adicionar</label><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input id="withdrawal-material-search" className="min-h-11 pl-9 text-base" value={materialSearch} onChange={event => setMaterialSearch(event.target.value)} placeholder="Buscar por código, descrição ou unidade" /></div>
              <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border bg-background" aria-label="Materiais disponíveis">{availableMaterials.map((row, index) => <button key={row.key} type="button" className={`flex min-h-16 w-full items-center gap-3 border-b px-3 text-left last:border-0 hover:bg-primary/10 ${index % 2 ? 'bg-muted/25' : ''}`} onClick={() => addMaterial(row.key)}><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><PackageOpen className="h-5 w-5" /></span><span className="min-w-0 flex-1"><span className="block text-sm font-bold leading-snug">{row.description}</span><span className="mt-1 block text-xs font-medium text-muted-foreground">{row.code || 'Sem código'} · {row.unit}</span></span><WarehouseStatusBadge label={`Saldo ${row.balance.toLocaleString('pt-BR')}`} tone="info" /><Plus className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" /></button>)}{!availableMaterials.length && <WarehouseEmptyState message="Nenhum material encontrado" hint="Tente outra palavra na busca." className="m-2" />}</div>
              {errors.items && <div role="alert" className="mt-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm font-semibold text-destructive">{errors.items}</div>}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className={`rounded-lg border bg-muted/30 p-3 ${errors.signatureReceiver ? 'border-destructive bg-destructive/5' : ''}`}><SignaturePad label="Assinatura de quem recebeu" value={form.signatureReceiver} onChange={signatureReceiver => { setForm(current => ({ ...current, signatureReceiver })); setErrors(current => ({ ...current, signatureReceiver: undefined })); }} />{errors.signatureReceiver && <div role="alert" className="mt-2 text-sm font-semibold text-destructive">{errors.signatureReceiver}</div>}</div>
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3"><div className="flex items-center gap-2 text-sm font-bold">Fotos da entrega <span className="rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">Opcional · até 3</span></div><div className="grid grid-cols-3 gap-2">{photos.map((photo, index) => <PhotoPreview key={`${photo.name}-${index}`} file={photo} onRemove={() => setPhotos(current => current.filter((_, photoIndex) => photoIndex !== index))} />)}</div><div className="grid grid-cols-2 gap-2"><Button type="button" variant="outline" className="min-h-11 bg-background" disabled={photos.length >= 3} onClick={() => cameraRef.current?.click()}><Camera className="mr-2 h-4 w-4" />Tirar foto</Button><Button type="button" variant="outline" className="min-h-11 bg-background" disabled={photos.length >= 3} onClick={() => galleryRef.current?.click()}><ImagePlus className="mr-2 h-4 w-4" />Galeria</Button></div></div>
          </div>
          <WarehouseField label="Observação" optional><Input id="withdrawal-notes" className="min-h-11" value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} placeholder="Ex.: local de aplicação" /></WarehouseField>
          <WarehouseActionBar><Button variant="outline" className="min-h-11 bg-background" disabled={saving} onClick={reset}>Cancelar</Button><Button className="min-h-11 font-bold" disabled={saving} onClick={() => void submit()}><Check className="mr-2 h-4 w-4" />{saving ? 'Registrando...' : 'Entregar e baixar estoque'}</Button></WarehouseActionBar>
        </section>
      )}

      <section className="overflow-hidden rounded-xl border bg-card">
          <WarehouseSectionHeader icon={History} title="Histórico de retiradas e devoluções" description={`${wh.requisitions.length} retirada(s)`} tone="neutral" />
          <div className="space-y-4 p-2 md:hidden">{buildingGroups.map(building => <section key={building.key} data-testid="withdrawal-building-group" className="space-y-3"><HistoryGroupHeader title={building.label} requisitionCount={building.requisitions.length} itemCount={building.itemCount} />{building.requisitions.map(requisition => <WithdrawalHistoryCard key={requisition.id} project={project} requisition={requisition} movements={wh.movements} active={expandedRequisitionIds.has(requisition.id)} canDelete={canDelete} canEdit={canEdit} onToggle={() => setExpandedRequisitionIds(current => { const next = new Set(current); if (next.has(requisition.id)) next.delete(requisition.id); else next.add(requisition.id); return next; })} onDelete={() => deleteRequisition(requisition)} onReturn={() => setReturnTarget(requisition)} onCorrect={() => setCorrectionTarget(requisition)} />)}</section>)}{!wh.requisitions.length && <WarehouseEmptyState message="Nenhuma retirada registrada" hint="Use Nova retirada para começar." />}</div>
          <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[1040px] text-xs"><thead className="bg-muted"><tr><th className="w-10 p-2"><span className="sr-only">Detalhes</span></th><th className="p-2 text-left">Nº</th><th className="p-2 text-left">Data da operação</th><th className="p-2 text-left">Último registro</th><th className="p-2 text-left">Recebedor</th><th className="p-2 text-left">Hierarquia / destino</th><th className="p-2 text-center">Itens</th><th className="p-2 text-left">Status</th><th className="p-2 text-left">Incluído / alterado por</th></tr></thead><tbody>{buildingGroups.map(building => <Fragment key={building.key}><tr data-testid="withdrawal-building-group"><td colSpan={9} className="border-t bg-primary/10 px-3 py-2"><HistoryGroupHeader title={building.label} requisitionCount={building.requisitions.length} itemCount={building.itemCount} /></td></tr>{building.requisitions.map(requisition => <WithdrawalHistoryRow key={requisition.id} project={project} requisition={requisition} movements={wh.movements} active={expandedRequisitionIds.has(requisition.id)} canDelete={canDelete} canEdit={canEdit} onToggle={() => setExpandedRequisitionIds(current => { const next = new Set(current); if (next.has(requisition.id)) next.delete(requisition.id); else next.add(requisition.id); return next; })} onDelete={() => deleteRequisition(requisition)} onReturn={() => setReturnTarget(requisition)} onCorrect={() => setCorrectionTarget(requisition)} />)}</Fragment>)}{!wh.requisitions.length && <tr><td colSpan={9} className="p-8 text-center text-muted-foreground">Nenhuma retirada registrada.</td></tr>}</tbody></table></div>
      </section>
      <MaterialReturnDialog project={project} requisition={returnTarget} auditActor={auditActor} onProjectChange={onProjectChange} onClose={() => setReturnTarget(null)} />
      <CorrectionDialog project={project} requisition={correctionTarget} auditActor={auditActor} onProjectChange={onProjectChange} onClose={() => setCorrectionTarget(null)} />
      {confirmDialog}
    </div>
  );
}

function HistoryGroupHeader({ title, requisitionCount, itemCount, compact = false }: { title: string; requisitionCount: number; itemCount: number; compact?: boolean }) {
  return <div className={`flex flex-wrap items-center justify-between gap-2 ${compact ? 'text-xs' : 'text-sm'}`}><strong className="min-w-0 break-words">{title}</strong><span className="text-muted-foreground">{requisitionCount} requisição(ões) · {itemCount} item(ns)</span></div>;
}

interface WithdrawalHistoryEntryProps {
  project: Project;
  requisition: WarehouseRequisition;
  movements: WarehouseMovement[];
  active: boolean;
  canDelete: boolean;
  canEdit: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onReturn: () => void;
  onCorrect: () => void;
}

function WithdrawalHistoryCard({ project, requisition, movements, active, canDelete, canEdit, onToggle, onDelete, onReturn, onCorrect }: WithdrawalHistoryEntryProps) {
  const chapter = chapterPathLabel(project, requisition.chapterId, requisition.chapterName || requisition.taskName);
  const latest = latestRequisitionActivity(requisition, movements);
  return <article className={`overflow-hidden rounded-md border ${active ? 'border-primary/60 bg-primary/15 shadow-sm' : 'bg-background'}`}><button type="button" className={`w-full p-3 text-left ${active ? 'bg-primary/30 hover:bg-primary/30' : ''}`} onClick={onToggle} aria-expanded={active}><div className="flex justify-between gap-2"><strong>{requisition.number}</strong><ChevronDown className={`h-4 w-4 transition-transform ${active ? 'rotate-180 text-primary' : ''}`} /></div><div className="mt-1 text-sm">{requisition.receiverName || requisition.requesterName || '—'}</div><div className="text-xs text-muted-foreground">{chapter} · {requisition.items.length} item(ns)</div><div className="mt-1 text-xs text-muted-foreground">Operação: {formatOperationalDate(requisition.date)} · Último registro: {formatRecordedAt({ createdAt: latest }, requisition.date)}</div></button>{active && <div data-testid="withdrawal-history-details" className="border-t border-primary/40 bg-primary/15 p-3"><WithdrawalDetails project={project} requisition={requisition} canDelete={canDelete} canEdit={canEdit} onDelete={onDelete} onReturn={onReturn} onCorrect={onCorrect} /></div>}</article>;
}

function WithdrawalHistoryRow({ project, requisition, movements, active, canDelete, canEdit, onToggle, onDelete, onReturn, onCorrect }: WithdrawalHistoryEntryProps) {
  const chapter = chapterPathLabel(project, requisition.chapterId, requisition.chapterName || requisition.taskName);
  const latest = latestRequisitionActivity(requisition, movements);
  return <Fragment><tr data-testid="withdrawal-history-row" className={`cursor-pointer border-t whitespace-nowrap hover:bg-muted/30 ${active ? 'border-primary/50 bg-primary/30 hover:bg-primary/30' : ''}`} onClick={onToggle}><td className="p-2"><ChevronDown className={`h-4 w-4 transition-transform ${active ? 'rotate-180 text-primary' : ''}`} /></td><td className="p-2 font-mono">{requisition.number}</td><td className="p-2">{formatOperationalDate(requisition.date)}</td><td className="p-2">{formatRecordedAt({ createdAt: latest }, requisition.date)}</td><td className="p-2">{requisition.receiverName || requisition.requesterName || '—'}</td><td className="max-w-80 truncate p-2" title={chapter}>{chapter}</td><td className="p-2 text-center">{requisition.items.length}</td><td className="p-2"><WarehouseStatusBadge label={requisition.status === 'rascunho' ? 'Pendente legado' : 'Entregue'} tone={requisition.status === 'rascunho' ? 'warning' : 'success'} /></td><td className="p-2"><WarehouseAuditIdentity createdBy={requisition.createdBy} updatedBy={requisition.updatedBy} createdAt={requisition.createdAt} updatedAt={requisition.updatedAt} className="space-y-0.5" /></td></tr>{active && <tr data-testid="withdrawal-history-details" className="border-t border-primary/50 bg-primary/15"><td colSpan={9} className="p-3"><WithdrawalDetails project={project} requisition={requisition} canDelete={canDelete} canEdit={canEdit} onDelete={onDelete} onReturn={onReturn} onCorrect={onCorrect} /></td></tr>}</Fragment>;
}

function PhotoPreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  return <div className="relative aspect-square overflow-hidden rounded-md border"><img src={url} alt={file.name} className="h-full w-full object-cover" onLoad={() => URL.revokeObjectURL(url)} /><Button type="button" size="icon" variant="destructive" className="absolute right-1 top-1 h-8 w-8" onClick={onRemove} aria-label={`Remover ${file.name}`}><X className="h-4 w-4" /></Button></div>;
}

function WithdrawalDetails({ project, requisition, canDelete, canEdit, onDelete, onReturn, onCorrect }: { project: Project; requisition: WarehouseRequisition; canDelete: boolean; canEdit: boolean; onDelete: () => void; onReturn: () => void; onCorrect: () => void }) {
  const returns = ensureWarehouse(project).warehouse!.movements
    .filter(movement => movement.type === 'devolucao' && movement.originType === 'return' && movement.requisitionId === requisition.id && !movement.reversedById)
    .slice()
    .sort((left, right) => recordTimestamp(right, right.date).localeCompare(recordTimestamp(left, left.date)));
  const returnable = requisition.status === 'entregue' ? getReturnableRequisitionItems(project, requisition.id) : [];
  const returnableByItem = new Map(returnable.map(item => [item.itemKey, item] as const));
  const hasReturnable = requisition.status === 'entregue' && returnable.some(item => item.availableQuantity > 0);
  return <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><div className="text-sm"><strong>{requisition.number}</strong> · {requisition.receiverName || requisition.requesterName || '—'} · {requisition.deliveryAttachments?.length || 0} foto(s)</div><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" className="min-h-11" onClick={() => generateRequisitionReceipt(project, requisition)}><FileDown className="mr-1 h-4 w-4" />PDF</Button>{canEdit && <Button size="sm" variant="outline" className="min-h-11" disabled={returns.length > 0 || requisition.status !== 'entregue'} title={returns.length ? 'A correção é bloqueada porque existe devolução vinculada.' : undefined} onClick={onCorrect}><Pencil className="mr-1 h-4 w-4" />Corrigir retirada</Button>}{hasReturnable && <Button size="sm" className="min-h-11" onClick={onReturn}><RotateCcw className="mr-1 h-4 w-4" />Registrar devolução</Button>}{canDelete && <Button size="sm" variant="destructive" className="min-h-11" onClick={onDelete}><Trash2 className="mr-1 h-4 w-4" />Excluir</Button>}</div></div>{canEdit && returns.length > 0 && <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">Esta retirada possui devolução registrada. Para preservar o histórico, a correção de material ou quantidade está bloqueada.</div>}<dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">Hierarquia / destino</dt><dd>{chapterPathLabel(project, requisition.chapterId, requisition.chapterName || requisition.taskName)}</dd></div><div><dt className="text-xs text-muted-foreground">Data da operação</dt><dd>{formatOperationalDate(requisition.date)}</dd></div><div><dt className="text-xs text-muted-foreground">Registro / atualização</dt><dd>{formatRecordedAt(requisition, requisition.date)}</dd></div><div><dt className="text-xs text-muted-foreground">Observação</dt><dd>{requisition.notes || '—'}</dd></div></dl><div className="overflow-x-auto"><table className="w-full min-w-[700px] text-xs"><thead><tr><th className="p-2 text-left">Código</th><th className="p-2 text-left">Material</th><th className="p-2 text-left">Un.</th><th className="p-2 text-right">Retirado</th><th className="p-2 text-right text-success">Devolvido</th><th className="p-2 text-right text-primary">Em campo</th></tr></thead><tbody>{requisition.items.map(item => { const summary = returnableByItem.get(item.itemKey); return <tr key={item.itemKey} className="border-t"><td className="p-2">{item.code || '—'}</td><td className="p-2">{item.description}</td><td className="p-2">{item.unit}</td><td className="p-2 text-right font-mono">{item.quantity.toLocaleString('pt-BR')}</td><td className="p-2 text-right font-mono text-success">{(summary?.returnedQuantity ?? 0).toLocaleString('pt-BR')}</td><td className="p-2 text-right font-mono font-bold text-primary">{(summary?.availableQuantity ?? item.quantity).toLocaleString('pt-BR')}</td></tr>; })}</tbody></table></div>{returns.length > 0 && <div className="rounded-lg border border-success/30 bg-success/5 p-3"><div className="mb-2 text-sm font-bold text-success">Devoluções registradas</div><div className="space-y-2 text-sm">{returns.map(movement => <div key={movement.id} className="rounded-md border border-success/20 bg-background/70 p-2"><strong>{movement.returnNumber || 'Devolução'}</strong> · operação: {formatOperationalDate(movement.date)} · registro: {formatRecordedAt(movement, movement.date)} · devolvido por {movement.returnerName || 'Não informado'}<div className="mt-1 font-medium text-success">{movement.itemDescription}: {movement.quantity.toLocaleString('pt-BR')} {movement.itemUnit}</div></div>)}</div></div>}<WarehouseAuditIdentity createdBy={requisition.createdBy} updatedBy={requisition.updatedBy} createdAt={requisition.createdAt} updatedAt={requisition.updatedAt} className="rounded-md bg-muted/40 p-2 text-xs" /></div>;
}

function CorrectionDialog({ project, requisition, auditActor, onProjectChange, onClose }: { project: Project; requisition: WarehouseRequisition | null; auditActor?: WarehouseAuditActor; onProjectChange: (project: Project) => void; onClose: () => void }) {
  const [items, setItems] = useState<WarehouseRequisitionItem[]>([]);
  const [chapterId, setChapterId] = useState('');
  const [destinationChanged, setDestinationChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const rows = useMemo(() => computeWarehouseRows(project, { includeManual: true }), [project]);
  const numbering = useMemo(() => getChapterNumbering(project), [project]);
  const chapters = useMemo(() => flattenPhasesByChapter(project).filter(phase => !phase.parentId).map(phase => ({
    id: phase.id,
    name: `${numbering.get(phase.id) ?? phase.customNumber ?? ''} · ${phase.name}`.replace(/^\s*·\s*/, ''),
  })), [numbering, project]);
  const currentDestinationIsNested = !!requisition?.chapterId && rootChapterId(project, requisition.chapterId) !== requisition.chapterId;
  useEffect(() => { setItems(requisition?.items.map(item => ({ ...item })) ?? []); setChapterId(rootChapterId(project, requisition?.chapterId) ?? requisition?.chapterId ?? ''); setDestinationChanged(false); }, [project, requisition]);
  const update = (index: number, itemKey: string) => {
    const row = rows.find(candidate => candidate.key === itemKey);
    if (!row) return;
    setItems(current => current.map((item, itemIndex) => itemIndex === index ? { itemKey: row.key, code: row.code, description: row.description, unit: row.unit, quantity: item.quantity || 1 } : item));
  };
  const save = () => {
    if (!requisition) return;
    const chapter = chapters.find(candidate => candidate.id === chapterId);
    if (!chapter) return toast.error('Selecione o prédio / destino da retirada.');
    const preservedDestination = currentDestinationIsNested && !destinationChanged;
    try {
      setSaving(true);
      onProjectChange(correctDeliveredRequisition(project, requisition.id, {
        items,
        chapterId: preservedDestination ? requisition.chapterId : chapter.id,
        chapterName: preservedDestination ? requisition.chapterName : chapter.name,
      }, auditActor));
      toast.success('Retirada corrigida, estoque recalculado e histórico auditado.');
      onClose();
    } catch (error) { toast.error((error as Error).message); } finally { setSaving(false); }
  };
  return <Dialog open={!!requisition} onOpenChange={open => !open && !saving && onClose()}><DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto p-4 sm:p-6"><DialogHeader><DialogTitle>Corrigir retirada</DialogTitle><DialogDescription>Somente o Proprietário pode alterar destino, materiais e quantidades. A correção atualiza estoque, Diário de Obra e trilha de auditoria.</DialogDescription></DialogHeader><div className="space-y-3"><WarehouseField label="Prédio / destino"><select className="min-h-11 w-full rounded-md border bg-background px-3 text-base" value={chapterId} onChange={event => { setChapterId(event.target.value); setDestinationChanged(true); }} aria-label="Prédio ou destino corrigido"><option value="">Selecione</option>{chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.name}</option>)}</select>{currentDestinationIsNested && !destinationChanged && <p className="mt-1 text-xs text-muted-foreground">O destino atual está em um subcapítulo e será preservado enquanto outro capítulo não for escolhido.</p>}</WarehouseField>{items.map((item, index) => <div key={`${item.itemKey}-${index}`} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_130px_44px]"><select className="min-h-11 w-full rounded-md border bg-background px-3 text-base" value={item.itemKey} onChange={event => update(index, event.target.value)} aria-label={`Material corrigido ${index + 1}`}><option value="">Selecione o material</option>{rows.map(row => <option key={row.key} value={row.key}>{row.code ? `${row.code} · ` : ''}{row.description} · saldo {row.balance.toLocaleString('pt-BR')} {row.unit}</option>)}</select><Input className="min-h-11 text-base" type="number" min="0" step="any" value={item.quantity} onChange={event => setItems(current => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, quantity: Number(event.target.value) } : entry))} aria-label={`Quantidade corrigida de ${item.description}`} /><Button size="icon" variant="ghost" className="min-h-11 min-w-11 text-destructive" disabled={items.length === 1} onClick={() => setItems(current => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remover ${item.description}`}><Trash2 className="h-4 w-4" /></Button></div>)}<Button type="button" variant="outline" className="min-h-11" onClick={() => setItems(current => [...current, { itemKey: '', description: '', unit: '', quantity: 1 }])}><Plus className="mr-2 h-4 w-4" />Adicionar material</Button></div><DialogFooter className="gap-2 sm:gap-0"><Button variant="outline" className="min-h-11" disabled={saving} onClick={onClose}>Cancelar</Button><Button className="min-h-11" disabled={saving} onClick={save}><Check className="mr-2 h-4 w-4" />{saving ? 'Corrigindo...' : 'Salvar correção'}</Button></DialogFooter></DialogContent></Dialog>;
}

function MaterialReturnDialog({ project, requisition, auditActor, onProjectChange, onClose }: {
  project: Project;
  requisition: WarehouseRequisition | null;
  auditActor?: WarehouseAuditActor;
  onProjectChange: (project: Project) => void;
  onClose: () => void;
}) {
  const returnable = useMemo(() => requisition ? getReturnableRequisitionItems(project, requisition.id) : [], [project, requisition]);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [returnerName, setReturnerName] = useState('');
  const [signature, setSignature] = useState<string | undefined>();
  const [notes, setNotes] = useState('');
  const [conditionConfirmed, setConditionConfirmed] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => uidWarehouse());

  const reset = () => {
    setDate(new Date().toISOString().slice(0, 10));
    setReturnerName(requisition?.receiverName || requisition?.requesterName || '');
    setSignature(undefined);
    setNotes('');
    setConditionConfirmed(false);
    setQuantities({});
    setIdempotencyKey(uidWarehouse());
  };

  useEffect(() => {
    if (requisition) reset();
  // A abertura de outra retirada sempre inicia um novo formulário e chave de envio.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requisition?.id]);

  const handleOpenChange = (open: boolean) => {
    if (!open && !saving) { reset(); onClose(); }
  };

  const submit = () => {
    if (!requisition) return;
    const items = returnable.flatMap(item => {
      const quantity = Number((quantities[item.itemKey] ?? '').replace(',', '.'));
      return quantity > 0 ? [{ itemKey: item.itemKey, quantity }] : [];
    });
    try {
      setSaving(true);
      const result = registerMaterialReturn(project, {
        requisitionId: requisition.id,
        date,
        returnerName,
        returnSignature: signature,
        notes,
        conditionConfirmed,
        idempotencyKey,
        items,
      }, auditActor);
      onProjectChange(result.project);
      toast.success(`Devolução ${result.returnNumber} registrada e saldo recomposto.`);
      reset();
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return <Dialog open={!!requisition} onOpenChange={handleOpenChange}><DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto p-4 sm:p-6"><DialogHeader><DialogTitle>Registrar devolução de sobra</DialogTitle><DialogDescription>Retorno vinculado à retirada {requisition?.number}. Apenas materiais daquela retirada podem voltar ao almoxarifado.</DialogDescription></DialogHeader>{requisition && <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><WarehouseField label="Data da devolução"><Input className="min-h-11 text-base" type="date" value={date} onChange={event => setDate(event.target.value)} /></WarehouseField><WarehouseField label="Quem devolveu"><Input className="min-h-11 text-base" value={returnerName} onChange={event => setReturnerName(event.target.value)} placeholder="Nome de quem devolveu" /></WarehouseField></div><div className="rounded-lg border bg-muted/30 p-3"><div className="mb-2 text-sm font-bold">Materiais devolvíveis</div><div className="space-y-2">{returnable.map(item => <div key={item.itemKey} className="grid gap-2 rounded-lg border bg-background p-3 sm:grid-cols-[1fr_140px]"><div className="min-w-0"><div className="font-medium">{item.description}</div><div className="text-xs text-muted-foreground">{item.code || 'Sem código'} · {item.unit}</div><div className="mt-2 grid grid-cols-3 gap-2 text-xs"><span>Retirado<br /><strong>{item.withdrawnQuantity.toLocaleString('pt-BR')}</strong></span><span>Já devolvido<br /><strong>{item.returnedQuantity.toLocaleString('pt-BR')}</strong></span><span>Máx. devolvível<br /><strong className="text-primary">{item.availableQuantity.toLocaleString('pt-BR')}</strong></span></div></div><WarehouseField label={`Devolver (${item.unit})`}><Input className="min-h-11 text-base" type="number" min="0" max={item.availableQuantity} step="any" value={quantities[item.itemKey] ?? ''} onChange={event => setQuantities(current => ({ ...current, [item.itemKey]: event.target.value }))} aria-label={`Quantidade devolvida de ${item.description}`} /></WarehouseField></div>)}{!returnable.some(item => item.availableQuantity > 0) && <WarehouseEmptyState message="Não há saldo disponível para devolução" />}</div></div><label className="flex min-h-11 items-start gap-3 rounded-lg border border-success/30 bg-success/5 p-3 text-sm"><input className="mt-1 h-5 w-5 accent-primary" type="checkbox" checked={conditionConfirmed} onChange={event => setConditionConfirmed(event.target.checked)} /><span><strong>Material apto a retornar ao estoque</strong><br /><span className="text-muted-foreground">Não use este fluxo para material avariado, perdido ou descartado.</span></span></label><div className="rounded-lg border bg-muted/30 p-3"><SignaturePad label="Assinatura de quem devolveu (opcional)" value={signature} onChange={setSignature} /></div><WarehouseField label="Observação" optional><Input className="min-h-11 text-base" value={notes} onChange={event => setNotes(event.target.value)} placeholder="Ex.: sobra da execução no prédio A" /></WarehouseField></div>}<DialogFooter className="gap-2 sm:gap-0"><Button variant="outline" className="min-h-11" disabled={saving} onClick={() => handleOpenChange(false)}>Cancelar</Button><Button className="min-h-11" disabled={saving || !requisition || !returnable.some(item => item.availableQuantity > 0)} onClick={submit}><RotateCcw className="mr-2 h-4 w-4" />{saving ? 'Registrando...' : 'Confirmar devolução'}</Button></DialogFooter></DialogContent></Dialog>;
}
