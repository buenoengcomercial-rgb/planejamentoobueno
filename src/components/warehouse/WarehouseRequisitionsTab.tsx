import { Fragment, useEffect, useMemo, useRef, useState, type TouchEvent, type WheelEvent } from 'react';
import type { Project, WarehouseAuditActor, WarehouseMovement, WarehouseRequisition, WarehouseRequisitionItem, WarehouseRequisitionSupplement } from '@/types/project';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Camera, Check, CheckCircle2, ChevronDown, ChevronsUpDown, CloudUpload, FileDown, HardHat, History, ImagePlus, Loader2, PackageOpen, Pencil, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react';
import {
  computeWarehouseRows,
  addRequisitionSupplement,
  correctDeliveredRequisition,
  correctRequisitionSupplement,
  cancelDeliveredRequisition,
  createAndDeliverRequisition,
  ensureWarehouse,
  hardDeleteRequisition,
  getReturnableRequisitionItems,
  getRequisitionMaterialSummaries,
  makeAttachments,
  normalizeWarehouseReceiverName,
  registerMaterialReturn,
  uidWarehouse,
  warehouseOperationalDate,
  warehouseActorName,
} from '@/lib/warehouse';
import { deleteWarehouseAttachments } from '@/lib/warehouseAttachments';
import {
  commitWarehouseOperation,
  type WarehouseCloudCommitResult,
  type WarehouseCloudOperation,
} from '@/lib/warehouseCloudCommit';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { flattenPhasesByChapter, getChapterNumbering } from '@/lib/chapters';
import SignaturePad from './SignaturePad';
import WarehouseAuditIdentity from './WarehouseAuditIdentity';
import WarehouseCustodyTab from './WarehouseCustodyTab';
import {
  WarehouseEmptyState,
  WarehouseField,
  WarehouseSectionHeader,
  WarehouseStatusBadge,
} from './WarehouseVisual';
import { toast } from 'sonner';
import type { WarehouseScopedDomain } from '@/lib/warehouseScopedCommit';

interface Props {
  project: Project;
  onProjectChange: (next: Project) => void;
  /** Aplica a resposta já confirmada sem acionar o autosave completo da obra. */
  onCloudOperationConfirmed?: (confirmation: WarehouseCloudCommitResult) => void | Promise<void>;
  /** Finaliza qualquer autosave anterior antes de iniciar a transação crítica. */
  onPrepareCloudOperation?: () => void | Promise<void>;
  /** Mantém preparação, RPC e aplicação local sob uma única trava de navegação. */
  onCommitCloudOperation?: (
    before: Project,
    after: Project,
    operation: WarehouseCloudOperation,
  ) => Promise<WarehouseCloudCommitResult>;
  /** Mantém upload, transação e confirmação sob a mesma trava de navegação. */
  onRunCriticalCloudOperation?: <T>(operation: () => Promise<T>) => Promise<T>;
  onCommitWarehouseScoped?: (next: Project, domain: WarehouseScopedDomain) => Promise<Project>;
  auditActor?: WarehouseAuditActor;
  canDelete?: boolean;
  /** Correção auditada da retirada original; exclusão física continua separada. */
  canEdit?: boolean;
  canSupplement?: boolean;
  /** Cancelamento por estorno e arquivamento, disponível a operadores do Almoxarifado. */
  canCancel?: boolean;
}

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
type WithdrawalSaveStage = 'idle' | 'uploading' | 'committing' | 'confirmed';

const WITHDRAWAL_CONFIRMATION_DELAY_MS = 700;

const initialForm = (): WithdrawalForm => ({
  date: warehouseOperationalDate(),
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

/** Nome exibido nos seletores do formulário de ações, sem repetir o código fiscal. */
function materialDisplayName(code?: string, description?: string) {
  const value = (description ?? '').trim();
  const normalizedCode = (code ?? '').trim();
  if (!value || !normalizedCode) return value;
  const escapedCode = normalizedCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`^${escapedCode}\\s*(?:[-–—·:|]\\s*)?`, 'i'), '').trim() || value;
}

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
  dateGroups: RequisitionDateGroup[];
};

type RequisitionDateGroup = {
  key: string;
  date: string;
  requisitions: WarehouseRequisition[];
  itemCount: number;
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
    const sortedRequisitions = buildingRequisitions.slice().sort((left, right) => {
      const rightTimestamp = latestRequisitionActivity(right, movements);
      const leftTimestamp = latestRequisitionActivity(left, movements);
      return rightTimestamp.localeCompare(leftTimestamp) || right.number.localeCompare(left.number, 'pt-BR', { numeric: true });
    });
    const byDate = new Map<string, WarehouseRequisition[]>();
    for (const requisition of sortedRequisitions) {
      const date = requisition.date || 'data-nao-informada';
      byDate.set(date, [...(byDate.get(date) ?? []), requisition]);
    }
    return {
      key,
      label: building.label,
      isMissingBuilding: building.isMissingBuilding,
      requisitions: sortedRequisitions,
      itemCount: buildingRequisitions.reduce((total, requisition) => total + getRequisitionMaterialSummaries(project, requisition.id).length, 0),
      dateGroups: Array.from(byDate.entries()).map(([date, dateRequisitions]) => ({
        key: `${key}:${date}`,
        date,
        requisitions: dateRequisitions,
        itemCount: dateRequisitions.reduce((total, requisition) => total + getRequisitionMaterialSummaries(project, requisition.id).length, 0),
      })).sort((left, right) => right.date.localeCompare(left.date)),
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

function WarehouseMaterialWithdrawalsTab({ project, onProjectChange, onCloudOperationConfirmed, onPrepareCloudOperation, onCommitCloudOperation, onRunCriticalCloudOperation, auditActor, canDelete = false, canEdit = false, canSupplement = false, canCancel = false }: Props) {
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
  const [dateExpansionOverrides, setDateExpansionOverrides] = useState<Map<string, boolean>>(() => new Map());
  const [form, setForm] = useState<WithdrawalForm>(initialForm);
  const [receiverOpen, setReceiverOpen] = useState(false);
  const [receiverSearch, setReceiverSearch] = useState('');
  const [materialSearch, setMaterialSearch] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [saveStage, setSaveStage] = useState<WithdrawalSaveStage>('idle');
  const [confirmedNumber, setConfirmedNumber] = useState('');
  const saving = saveStage !== 'idle';
  const [errors, setErrors] = useState<WithdrawalErrors>({});
  const [returnTarget, setReturnTarget] = useState<WarehouseRequisition | null>(null);
  const [actionTarget, setActionTarget] = useState<WarehouseRequisition | null>(null);
  const [cancelTarget, setCancelTarget] = useState<WarehouseRequisition | null>(null);
  const [historyView, setHistoryView] = useState<'active' | 'cancelled'>('active');
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const withdrawalFormScrollRef = useRef<HTMLFieldSetElement>(null);
  const materialListTouchStartY = useRef<number | null>(null);
  const visibleRequisitions = useMemo(() => wh.requisitions.filter(requisition => (
    historyView === 'cancelled' ? requisition.status === 'cancelada' : requisition.status !== 'cancelada'
  )), [historyView, wh.requisitions]);
  const buildingGroups = useMemo(
    () => groupRequisitionsByBuilding(project, visibleRequisitions, wh.movements),
    [project, visibleRequisitions, wh.movements],
  );
  const currentOperationalDate = warehouseOperationalDate();
  const executeConfirmedOperation = (after: Project, operation: WarehouseCloudOperation) => executeCloudOperation(
    project,
    after,
    operation,
    { onCommitCloudOperation, onPrepareCloudOperation, onCloudOperationConfirmed, onProjectChange },
  );
  const runCriticalOperation = <T,>(operation: () => Promise<T>) => (
    onRunCriticalCloudOperation ? onRunCriticalCloudOperation(operation) : operation()
  );
  const isDateGroupExpanded = (dateGroup: RequisitionDateGroup) => dateExpansionOverrides.get(dateGroup.key) ?? dateGroup.date === currentOperationalDate;
  const toggleDateGroup = (dateGroup: RequisitionDateGroup) => setDateExpansionOverrides(current => {
    const next = new Map(current);
    next.set(dateGroup.key, !isDateGroupExpanded(dateGroup));
    return next;
  });
  const generateDailyConfirmations = async (building: RequisitionBuildingGroup, dateGroup: RequisitionDateGroup) => {
    const { generateDailyWithdrawalConfirmationPdfs } = await import('./pdf');
    const generated = await generateDailyWithdrawalConfirmationPdfs(project, {
      date: dateGroup.date,
      buildingLabel: building.label,
      requisitions: dateGroup.requisitions,
    });
    if (generated) toast.success(`${generated} PDF(s) de confirmação gerado(s).`);
    else toast.error('Não há retiradas entregues nesta data para gerar a confirmação.');
  };

  const availableMaterials = useMemo(() => {
    const tokens = normalizeSearch(materialSearch).split(/\s+/).filter(Boolean);
    return rows.filter(row => row.balance > 0 && !form.items.some(item => item.itemKey === row.key))
      .filter(row => {
        const haystack = normalizeSearch([row.code, row.description, row.unit].filter(Boolean).join(' '));
        return tokens.every(token => haystack.includes(token));
      });
  }, [form.items, materialSearch, rows]);
  const visibleAvailableMaterials = useMemo(() => availableMaterials.slice(0, 60), [availableMaterials]);
  const receiverNames = useMemo(() => (wh.receivers ?? []).map(receiver => receiver.name), [wh.receivers]);
  const normalizedReceiverSearch = normalizeWarehouseReceiverName(receiverSearch);
  const receiverExists = receiverNames.some(receiver => normalizeSearch(receiver) === normalizeSearch(normalizedReceiverSearch));
  const selectReceiver = (receiverName: string) => {
    setForm(current => ({ ...current, receiverName: normalizeWarehouseReceiverName(receiverName) }));
    setErrors(current => ({ ...current, receiverName: undefined }));
    setReceiverSearch('');
    setReceiverOpen(false);
  };

  const shouldHandoffMaterialScroll = (materialList: HTMLDivElement, deltaY: number) => {
    if (!deltaY) return false;
    const isAtTop = materialList.scrollTop <= 0;
    const isAtBottom = materialList.scrollTop + materialList.clientHeight >= materialList.scrollHeight - 1;
    return (deltaY < 0 && isAtTop) || (deltaY > 0 && isAtBottom);
  };

  const scrollWithdrawalForm = (deltaY: number) => {
    const formScroll = withdrawalFormScrollRef.current;
    if (!formScroll || !deltaY) return;
    if (typeof formScroll.scrollBy === 'function') formScroll.scrollBy({ top: deltaY, behavior: 'auto' });
    else formScroll.scrollTop += deltaY;
  };

  const handleMaterialListWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!shouldHandoffMaterialScroll(event.currentTarget, event.deltaY)) return;
    event.preventDefault();
    scrollWithdrawalForm(event.deltaY);
  };

  const handleMaterialListTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    materialListTouchStartY.current = event.touches[0]?.clientY ?? null;
  };

  const handleMaterialListTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const currentY = event.touches[0]?.clientY;
    const previousY = materialListTouchStartY.current;
    if (currentY === undefined || previousY === null) return;
    const deltaY = previousY - currentY;
    materialListTouchStartY.current = currentY;
    if (!shouldHandoffMaterialScroll(event.currentTarget, deltaY)) return;
    event.preventDefault();
    scrollWithdrawalForm(deltaY);
  };

  const reset = () => {
    setForm(initialForm());
    setPhotos([]);
    setReceiverOpen(false);
    setReceiverSearch('');
    setMaterialSearch('');
    setErrors({});
    setSaveStage('idle');
    setConfirmedNumber('');
    setOpen(false);
  };
  const hasWithdrawalDraft = Boolean(
    form.chapterId || form.receiverName.trim() || form.notes.trim() || form.items.length || form.signatureReceiver || photos.length,
  );
  const requestCloseWithdrawal = () => {
    if (saving) return;
    if (!hasWithdrawalDraft) return reset();
    confirm(
      { title: 'Descartar retirada em preenchimento?', description: 'Os materiais, assinatura, fotos e demais dados ainda não foram registrados.', confirmLabel: 'Descartar preenchimento' },
      reset,
    );
  };

  useEffect(() => {
    if (!saving) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => {
      window.removeEventListener('beforeunload', preventUnload);
    };
  }, [saving]);

  const deleteRequisition = (requisition: WarehouseRequisition) => confirm(
    { title: 'Excluir retirada definitivamente?', description: 'A retirada, as devoluções vinculadas, seus comprovantes, movimentos e o bloco gerado no Diário de Obra serão removidos.', confirmLabel: 'Excluir definitivamente' },
    async () => {
      try {
        const next = hardDeleteRequisition(project, requisition.id, auditActor);
        await executeConfirmedOperation(next, {
          type: 'hard_delete',
          requisitionId: requisition.id,
          operationKey: `hard-delete:${requisition.id}`,
        });
        try { await deleteWarehouseAttachments(requisition.deliveryAttachments); } catch { toast.warning('A retirada foi excluída, mas houve falha ao remover um anexo do Storage.'); }
        setExpandedRequisitionIds(current => {
          const expanded = new Set(current);
          expanded.delete(requisition.id);
          return expanded;
        });
        toast.success('Retirada excluída na nuvem e saldo recalculado.');
      } catch (error) {
        toast.error((error as Error).message);
      }
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
    const receiverName = normalizeWarehouseReceiverName(form.receiverName);
    if (!chapter) nextErrors.chapterId = 'Selecione o destino.';
    if (!receiverName) nextErrors.receiverName = 'Informe quem recebeu.';
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
      await runCriticalOperation(async () => {
        setSaveStage(photos.length ? 'uploading' : 'committing');
        const deliveryAttachments = await makeAttachments(photos, project.id, 'foto', 'withdrawals');
        setSaveStage('committing');
        const result = createAndDeliverRequisition(project, {
          date: form.date,
          chapterId: chapter.id,
          chapterName: chapter.name,
          receiverName,
          requesterName: receiverName,
          notes: form.notes.trim() || undefined,
          items: form.items,
          signatureReceiver: form.signatureReceiver,
          deliveryAttachments,
          deliveryIdempotencyKey: form.deliveryIdempotencyKey,
        }, { publishToDailyReport: false, actor: auditActor });
        const confirmation = await executeConfirmedOperation(result.project, {
          type: 'delivery',
          requisitionId: result.requisitionId,
          operationKey: form.deliveryIdempotencyKey,
        });
        const confirmed = confirmation.project;
        setExpandedRequisitionIds(current => new Set([...current, result.requisitionId]));
        const canonicalRequisition = confirmed.warehouse?.requisitions.find(row => row.id === result.requisitionId);
        if (canonicalRequisition) {
          const confirmedDateKey = `${buildingLabel(confirmed, canonicalRequisition.chapterId).key}:${canonicalRequisition.date || 'data-nao-informada'}`;
          setDateExpansionOverrides(current => new Map(current).set(confirmedDateKey, true));
        }
        setConfirmedNumber(canonicalRequisition?.number ?? '');
        setSaveStage('confirmed');
        toast.success('Retirada confirmada na nuvem e estoque baixado.');
        await new Promise(resolve => window.setTimeout(resolve, WITHDRAWAL_CONFIRMATION_DELAY_MS));
        reset();
      });
    } catch (error) {
      setSaveStage('idle');
      setConfirmedNumber('');
      toast.error((error as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      <input ref={cameraRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={event => addPhotos(event.target.files)} />
      <input ref={galleryRef} className="hidden" type="file" accept="image/*" multiple onChange={event => addPhotos(event.target.files)} />

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3 shadow-sm">
        <Button className="min-h-11" onClick={() => setOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />Nova retirada
        </Button>
        <span className="text-sm font-medium text-muted-foreground">Preencha os dados e escolha os materiais.</span>
        <span className="ml-auto text-xs text-muted-foreground">{wh.requisitions.length} registro(s)</span>
      </div>

      <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) requestCloseWithdrawal(); }}>
        <DialogContent
          aria-busy={saving}
          onEscapeKeyDown={event => { if (saving) event.preventDefault(); }}
          onPointerDownOutside={event => { if (saving) event.preventDefault(); }}
          onInteractOutside={event => { if (saving) event.preventDefault(); }}
          className={`warehouse-ui flex h-[95dvh] max-h-[95dvh] w-[calc(100vw-1rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0 [&>button]:h-11 [&>button]:w-11 ${saving ? '[&>button]:pointer-events-none [&>button]:opacity-30' : ''}`}
        >
          <DialogHeader className="border-b p-4 pr-16">
            <DialogTitle>Nova retirada de materiais</DialogTitle>
            <DialogDescription>Preencha os dados, escolha os materiais e registre a assinatura antes de entregar.</DialogDescription>
          </DialogHeader>
          <fieldset ref={withdrawalFormScrollRef} data-testid="withdrawal-form-scroll" disabled={saving} className="min-h-0 min-w-0 flex-1 overflow-y-scroll overscroll-y-contain border-0 p-4 disabled:cursor-wait disabled:opacity-70">
            <section className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <WarehouseField label="Data">
              <Input id="withdrawal-date" className="min-h-11 text-base" type="date" value={form.date} onChange={event => setForm({ ...form, date: event.target.value })} />
            </WarehouseField>
            <WarehouseField label="Prédio / capítulo" error={errors.chapterId}>
              <select id="withdrawal-chapter" className="min-h-11 w-full rounded-md border bg-background px-3 text-base" value={form.chapterId} onChange={event => { setForm({ ...form, chapterId: event.target.value }); setErrors(current => ({ ...current, chapterId: undefined })); }}>
                <option value="">Selecione</option>
                {chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.name}</option>)}
              </select>
            </WarehouseField>
            <WarehouseField label="Quem recebeu" error={errors.receiverName}>
              <Popover open={receiverOpen} onOpenChange={setReceiverOpen}>
                <PopoverTrigger asChild>
                  <Button id="withdrawal-receiver" type="button" variant="outline" role="combobox" aria-expanded={receiverOpen} aria-label="Quem recebeu" className="min-h-11 w-full justify-between px-3 text-base font-normal">
                    <span className={form.receiverName ? '' : 'text-muted-foreground'}>{form.receiverName || 'Selecione ou crie o recebedor'}</span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0">
                  <Command shouldFilter>
                    <CommandInput value={receiverSearch} onValueChange={setReceiverSearch} placeholder="Buscar ou criar recebedor..." />
                    <CommandList>
                      <CommandEmpty>Nenhum recebedor cadastrado.</CommandEmpty>
                      <CommandGroup heading="Cadastrar novo recebedor">
                        {normalizedReceiverSearch && !receiverExists ? (
                          <CommandItem value={`criar ${normalizedReceiverSearch}`} onSelect={() => selectReceiver(normalizedReceiverSearch)} className="min-h-11">
                            <Plus className="mr-2 h-4 w-4" />Criar “{normalizedReceiverSearch}”
                          </CommandItem>
                        ) : (
                          <div className="px-2 py-2 text-xs text-muted-foreground">Digite o nome acima para cadastrar um novo recebedor.</div>
                        )}
                      </CommandGroup>
                      <CommandGroup heading="Recebedores cadastrados">
                        {receiverNames.map(receiver => (
                          <CommandItem key={receiver} value={receiver} onSelect={() => selectReceiver(receiver)} className="min-h-11">
                            <Check className={`mr-2 h-4 w-4 ${form.receiverName === receiver ? 'opacity-100' : 'opacity-0'}`} />
                            {receiver}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </WarehouseField>
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
              <div data-testid="available-materials-scroll" className="mt-2 max-h-64 touch-pan-y overflow-y-auto rounded-lg border bg-background" aria-label="Materiais disponíveis" onWheel={handleMaterialListWheel} onTouchStart={handleMaterialListTouchStart} onTouchMove={handleMaterialListTouchMove} onTouchEnd={() => { materialListTouchStartY.current = null; }} onTouchCancel={() => { materialListTouchStartY.current = null; }}>{visibleAvailableMaterials.map((row, index) => <button key={row.key} type="button" className={`flex min-h-16 w-full items-center gap-3 border-b px-3 text-left last:border-0 hover:bg-primary/10 ${index % 2 ? 'bg-muted/25' : ''}`} onClick={() => addMaterial(row.key)}><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><PackageOpen className="h-5 w-5" /></span><span className="min-w-0 flex-1"><span className="block text-sm font-bold leading-snug">{row.description}</span><span className="mt-1 block text-xs font-medium text-muted-foreground">{row.code || 'Sem código'} · {row.unit}</span></span><WarehouseStatusBadge label={`Saldo ${row.balance.toLocaleString('pt-BR')}`} tone="info" /><Plus className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" /></button>)}{availableMaterials.length > visibleAvailableMaterials.length && <div className="border-t bg-muted/40 px-3 py-2 text-center text-xs font-medium text-muted-foreground" role="status">Mostrando {visibleAvailableMaterials.length} de {availableMaterials.length} materiais. Refine a busca para localizar os demais.</div>}{!availableMaterials.length && <WarehouseEmptyState message="Nenhum material encontrado" hint="Tente outra palavra na busca." className="m-2" />}</div>
              {errors.items && <div role="alert" className="mt-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm font-semibold text-destructive">{errors.items}</div>}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className={`rounded-lg border bg-muted/30 p-3 ${errors.signatureReceiver ? 'border-destructive bg-destructive/5' : ''}`}><SignaturePad label="Assinatura de quem recebeu" value={form.signatureReceiver} onChange={signatureReceiver => { setForm(current => ({ ...current, signatureReceiver })); setErrors(current => ({ ...current, signatureReceiver: undefined })); }} />{errors.signatureReceiver && <div role="alert" className="mt-2 text-sm font-semibold text-destructive">{errors.signatureReceiver}</div>}</div>
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3"><div className="flex items-center gap-2 text-sm font-bold">Fotos da entrega <span className="rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">Opcional · até 3</span></div><div className="grid grid-cols-3 gap-2">{photos.map((photo, index) => <PhotoPreview key={`${photo.name}-${index}`} file={photo} onRemove={() => setPhotos(current => current.filter((_, photoIndex) => photoIndex !== index))} />)}</div><div className="grid grid-cols-2 gap-2"><Button type="button" variant="outline" className="min-h-11 bg-background" disabled={photos.length >= 3} onClick={() => cameraRef.current?.click()}><Camera className="mr-2 h-4 w-4" />Tirar foto</Button><Button type="button" variant="outline" className="min-h-11 bg-background" disabled={photos.length >= 3} onClick={() => galleryRef.current?.click()}><ImagePlus className="mr-2 h-4 w-4" />Galeria</Button></div></div>
          </div>
          <WarehouseField label="Observação" optional><Input id="withdrawal-notes" className="min-h-11" value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} placeholder="Ex.: local de aplicação" /></WarehouseField>
            </section>
          </fieldset>
          {saveStage !== 'idle' && <div role="status" aria-live="polite" className={`flex items-center gap-3 border-t px-4 py-3 text-sm font-semibold ${saveStage === 'confirmed' ? 'border-success/30 bg-success/10 text-success' : 'border-primary/25 bg-primary/5 text-primary'}`}>
            {saveStage === 'confirmed' ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : saveStage === 'uploading' ? <CloudUpload className="h-5 w-5 shrink-0" /> : <Loader2 className="h-5 w-5 shrink-0 animate-spin" />}
            <span>{saveStage === 'uploading' ? 'Enviando fotos...' : saveStage === 'committing' ? 'Salvando retirada na nuvem...' : `Salvo na nuvem${confirmedNumber ? ` · ${confirmedNumber}` : ''}`}</span>
          </div>}
          <DialogFooter className="gap-2 border-t bg-background p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] sm:space-x-0">
            <Button variant="outline" className="min-h-11 sm:min-w-28" disabled={saving} onClick={requestCloseWithdrawal}>Cancelar</Button>
            <Button className="min-h-11 font-bold sm:min-w-52" disabled={saving} onClick={() => void submit()}>{saveStage === 'confirmed' ? <CheckCircle2 className="mr-2 h-4 w-4" /> : saveStage === 'idle' ? <Check className="mr-2 h-4 w-4" /> : <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{saveStage === 'uploading' ? 'Enviando fotos...' : saveStage === 'committing' ? 'Salvando na nuvem...' : saveStage === 'confirmed' ? 'Salvo na nuvem' : 'Entregar e baixar estoque'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <section className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-3 py-2 sm:px-4">
            <WarehouseSectionHeader icon={History} title="Histórico de retiradas e devoluções" description={`${visibleRequisitions.length} ${historyView === 'cancelled' ? 'cancelada(s)' : 'retirada(s)'}`} tone="neutral" />
            <div className="flex rounded-lg border bg-background p-1" role="tablist" aria-label="Situação das retiradas">
              <Button type="button" size="sm" variant={historyView === 'active' ? 'default' : 'ghost'} onClick={() => setHistoryView('active')}>Ativas</Button>
              <Button type="button" size="sm" variant={historyView === 'cancelled' ? 'default' : 'ghost'} onClick={() => setHistoryView('cancelled')}>Canceladas</Button>
            </div>
          </div>
          <div className="withdrawal-tree space-y-4 p-2 sm:p-3">
            {buildingGroups.map(building => (
              <section key={building.key} data-testid="withdrawal-building-group" className="withdrawal-building min-w-0">
                <div className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-3">
                  <HistoryGroupHeader title={building.label} requisitionCount={building.requisitions.length} itemCount={building.itemCount} />
                </div>
                <div className="withdrawal-branch space-y-3 pt-3">
                  {building.dateGroups.map(dateGroup => (
                    <section key={dateGroup.key} data-testid="withdrawal-date-group" data-expanded={isDateGroupExpanded(dateGroup)} className="withdrawal-date min-w-0">
                      <div className="rounded-lg border border-border bg-muted px-3 py-2">
                        <WithdrawalDateGroupHeader dateGroup={dateGroup} expanded={isDateGroupExpanded(dateGroup)} onToggle={() => toggleDateGroup(dateGroup)} onGenerate={() => generateDailyConfirmations(building, dateGroup)} />
                      </div>
                      {isDateGroupExpanded(dateGroup) && <div className="withdrawal-branch min-w-0 pt-3">
                        <div className="space-y-3 md:hidden">{dateGroup.requisitions.map(requisition => (
                          <WithdrawalHistoryCard key={requisition.id} project={project} requisition={requisition} movements={wh.movements} active={expandedRequisitionIds.has(requisition.id)} canDelete={canDelete} canEdit={canEdit} canSupplement={canSupplement} canCancel={canCancel}
                            onToggle={() => setExpandedRequisitionIds(current => { const next = new Set(current); if (next.has(requisition.id)) next.delete(requisition.id); else next.add(requisition.id); return next; })}
                            onDelete={() => deleteRequisition(requisition)} onReturn={() => setReturnTarget(requisition)} onAction={() => setActionTarget(requisition)} onCancel={() => setCancelTarget(requisition)} />
                        ))}</div>
                        <div className="hidden min-w-0 overflow-x-auto md:block">
                          <table className="withdrawal-records w-full table-fixed text-xs">
                            <colgroup><col className="w-10" /><col className="w-[16%]" /><col className="w-[13%]" /><col className="w-[17%]" /><col className="w-[15%]" /><col className="w-12" /><col className="w-24" /><col /></colgroup>
                            <thead><tr><th><span className="sr-only">Detalhes</span></th><th className="p-2 text-left">Nº</th><th className="p-2 text-left">Data da operação</th><th className="p-2 text-left">Último registro</th><th className="p-2 text-left">Recebedor</th><th className="p-2 text-center">Itens</th><th className="p-2 text-left">Status</th><th className="p-2 text-left">Incluído / alterado por</th></tr></thead>
                            <tbody>{dateGroup.requisitions.map(requisition => (
                              <WithdrawalHistoryRow key={requisition.id} project={project} requisition={requisition} movements={wh.movements} active={expandedRequisitionIds.has(requisition.id)} canDelete={canDelete} canEdit={canEdit} canSupplement={canSupplement} canCancel={canCancel}
                                onToggle={() => setExpandedRequisitionIds(current => { const next = new Set(current); if (next.has(requisition.id)) next.delete(requisition.id); else next.add(requisition.id); return next; })}
                                onDelete={() => deleteRequisition(requisition)} onReturn={() => setReturnTarget(requisition)} onAction={() => setActionTarget(requisition)} onCancel={() => setCancelTarget(requisition)} />
                            ))}</tbody>
                          </table>
                        </div>
                      </div>}
                    </section>
                  ))}
                </div>
              </section>
            ))}
            {!visibleRequisitions.length && <WarehouseEmptyState message={historyView === 'cancelled' ? 'Nenhuma retirada cancelada' : 'Nenhuma retirada registrada'} hint={historyView === 'cancelled' ? 'Cancelamentos auditados aparecerão aqui.' : 'Use Nova retirada para começar.'} />}
          </div>
      </section>
      <MaterialReturnDialog project={project} requisition={returnTarget} auditActor={auditActor} onProjectChange={onProjectChange} onCloudOperationConfirmed={onCloudOperationConfirmed} onPrepareCloudOperation={onPrepareCloudOperation} onCommitCloudOperation={onCommitCloudOperation} onClose={() => setReturnTarget(null)} />
      <CancelRequisitionDialog project={project} requisition={cancelTarget} auditActor={auditActor} onProjectChange={onProjectChange} onCloudOperationConfirmed={onCloudOperationConfirmed} onPrepareCloudOperation={onPrepareCloudOperation} onCommitCloudOperation={onCommitCloudOperation} onRunCriticalCloudOperation={onRunCriticalCloudOperation} onClose={() => setCancelTarget(null)} />
      <RequisitionActionDialog project={project} requisition={actionTarget} auditActor={auditActor} canEditOriginal={canEdit} canEditSupplements={canSupplement} onProjectChange={onProjectChange} onCloudOperationConfirmed={onCloudOperationConfirmed} onPrepareCloudOperation={onPrepareCloudOperation} onCommitCloudOperation={onCommitCloudOperation} onRunCriticalCloudOperation={onRunCriticalCloudOperation} onClose={() => setActionTarget(null)} />
      {confirmDialog}
    </div>
  );
}

function HistoryGroupHeader({ title, requisitionCount, itemCount, compact = false }: { title: string; requisitionCount: number; itemCount: number; compact?: boolean }) {
  return <div className={`flex flex-wrap items-center justify-between gap-2 ${compact ? 'text-xs' : 'text-sm'}`}><strong className="min-w-0 break-words">{title}</strong><span className="text-muted-foreground">{requisitionCount} requisição(ões) · {itemCount} item(ns)</span></div>;
}

function WithdrawalDateGroupHeader({ dateGroup, expanded, onToggle, onGenerate }: { dateGroup: RequisitionDateGroup; expanded: boolean; onToggle: () => void; onGenerate: () => void }) {
  const deliveredCount = dateGroup.requisitions.filter(requisition => requisition.status === 'entregue').length;
  return <div className="flex flex-wrap items-center justify-between gap-2"><button type="button" className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left" onClick={onToggle} aria-expanded={expanded} aria-label={`${formatOperationalDate(dateGroup.date)}: ${expanded ? 'recolher' : 'expandir'} requisições`}><ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${expanded ? 'rotate-180 text-primary' : ''}`} /><span className="min-w-0"><strong className="block">{formatOperationalDate(dateGroup.date)}</strong><span className="text-xs text-muted-foreground">{dateGroup.requisitions.length} requisição(ões) · {dateGroup.itemCount} item(ns)</span></span></button><Button type="button" size="sm" variant="outline" className="min-h-11" disabled={!deliveredCount} onClick={onGenerate} title={deliveredCount ? 'Gera um PDF por recebedor para esta data e prédio.' : 'Não há retiradas entregues nesta data.'}><FileDown className="mr-1 h-4 w-4" />Gerar PDFs</Button></div>;
}

interface WithdrawalHistoryEntryProps {
  project: Project;
  requisition: WarehouseRequisition;
  movements: WarehouseMovement[];
  active: boolean;
  canDelete: boolean;
  canEdit: boolean;
  canSupplement: boolean;
  canCancel: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onReturn: () => void;
  onAction: () => void;
  onCancel: () => void;
}

function WithdrawalHistoryCard({ project, requisition, movements, active, canDelete, canEdit, canSupplement, canCancel, onToggle, onDelete, onReturn, onAction, onCancel }: WithdrawalHistoryEntryProps) {
  const latest = latestRequisitionActivity(requisition, movements);
  const materialCount = getRequisitionMaterialSummaries(project, requisition.id).length;
  return <article data-expanded={active} className={`withdrawal-record overflow-hidden rounded-lg border bg-card ${active ? 'border-primary/60' : 'border-border'}`}>
    <button type="button" className="min-h-11 w-full p-3 text-left hover:bg-muted/30" onClick={onToggle} aria-expanded={active}>
      <div className="flex items-center justify-between gap-2"><strong>{requisition.number}</strong><ChevronDown className={`h-4 w-4 shrink-0 ${active ? 'rotate-180 text-primary' : ''}`} /></div>
      <div className="mt-1 break-words font-semibold">{requisition.receiverName || requisition.requesterName || '—'}</div>
      <div className="mt-1 text-xs text-muted-foreground">{materialCount} item(ns) · Operação: {formatOperationalDate(requisition.date)}</div>
      <div className="text-xs text-muted-foreground">Último registro: {formatRecordedAt({ createdAt: latest }, requisition.date)}</div>
    </button>
    {active && <div data-testid="withdrawal-history-details" className="withdrawal-detail withdrawal-branch mb-3 mr-2 rounded-r-lg bg-muted/40 p-3"><WithdrawalDetails project={project} requisition={requisition} canDelete={canDelete} canEdit={canEdit} canSupplement={canSupplement} canCancel={canCancel} onDelete={onDelete} onReturn={onReturn} onAction={onAction} onCancel={onCancel} /></div>}
  </article>;
}

function WithdrawalHistoryRow({ project, requisition, movements, active, canDelete, canEdit, canSupplement, canCancel, onToggle, onDelete, onReturn, onAction, onCancel }: WithdrawalHistoryEntryProps) {
  const latest = latestRequisitionActivity(requisition, movements);
  const materialCount = getRequisitionMaterialSummaries(project, requisition.id).length;
  return <Fragment>
    <tr data-testid="withdrawal-history-row" aria-expanded={active} tabIndex={0} aria-label={`Retirada ${requisition.number}`} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(); } }} className={`withdrawal-record cursor-pointer border-y bg-card ${active ? 'border-primary/60' : 'border-border'}`} onClick={onToggle}>
      <td className="p-2"><ChevronDown className={`h-4 w-4 ${active ? 'rotate-180 text-primary' : ''}`} /></td>
      <td className="p-2 font-mono font-semibold">{requisition.number}</td>
      <td className="p-2">{formatOperationalDate(requisition.date)}</td>
      <td className="p-2">{formatRecordedAt({ createdAt: latest }, requisition.date)}</td>
      <td className="p-2 font-semibold">{requisition.receiverName || requisition.requesterName || '—'}</td>
      <td className="p-2 text-center">{materialCount}</td>
      <td className="p-2"><WarehouseStatusBadge label={requisition.status === 'cancelada' ? 'Cancelada' : requisition.status === 'rascunho' ? 'Pendente legado' : 'Entregue'} tone={requisition.status === 'cancelada' ? 'neutral' : requisition.status === 'rascunho' ? 'warning' : 'success'} /></td>
      <td className="p-2"><WarehouseAuditIdentity createdBy={requisition.createdBy} updatedBy={requisition.updatedBy} createdAt={requisition.createdAt} updatedAt={requisition.updatedAt} className="space-y-0.5" /></td>
    </tr>
    {active && <tr data-testid="withdrawal-history-details" className="withdrawal-detail-row"><td colSpan={8} className="!px-0 py-3"><div className="withdrawal-detail withdrawal-branch rounded-r-lg bg-muted/40 p-3"><WithdrawalDetails project={project} requisition={requisition} canDelete={canDelete} canEdit={canEdit} canSupplement={canSupplement} canCancel={canCancel} onDelete={onDelete} onReturn={onReturn} onAction={onAction} onCancel={onCancel} /></div></td></tr>}
  </Fragment>;
}

function PhotoPreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  return <div className="relative aspect-square overflow-hidden rounded-md border"><img src={url} alt={file.name} className="h-full w-full object-cover" onLoad={() => URL.revokeObjectURL(url)} /><Button type="button" size="icon" variant="destructive" className="absolute right-1 top-1 h-8 w-8" onClick={onRemove} aria-label={`Remover ${file.name}`}><X className="h-4 w-4" /></Button></div>;
}

function WithdrawalDetails({ project, requisition, canDelete, canEdit, canSupplement, canCancel, onDelete, onReturn, onAction, onCancel }: { project: Project; requisition: WarehouseRequisition; canDelete: boolean; canEdit: boolean; canSupplement: boolean; canCancel: boolean; onDelete: () => void; onReturn: () => void; onAction: () => void; onCancel: () => void }) {
  const [expandedMaterialKeys, setExpandedMaterialKeys] = useState<Set<string>>(new Set());
  const returns = ensureWarehouse(project).warehouse!.movements
    .filter(movement => movement.type === 'devolucao' && movement.originType === 'return' && movement.requisitionId === requisition.id && !movement.reversedById)
    .slice()
    .sort((left, right) => recordTimestamp(right, right.date).localeCompare(recordTimestamp(left, left.date)));
  const returnable = requisition.status === 'entregue' ? getReturnableRequisitionItems(project, requisition.id) : [];
  const materialSummaries = getRequisitionMaterialSummaries(project, requisition.id);
  const hasReturnable = requisition.status === 'entregue' && returnable.some(item => item.availableQuantity > 0);
  const canCorrect = canEdit || canSupplement;
  const notes = requisition.notes?.trim();
  const history = [
    ...(requisition.supplements ?? []).map(supplement => ({ at: supplement.createdAt, title: 'Complemento adicionado', description: `${supplement.status === 'cancelled' ? 'Complemento posteriormente estornado' : supplement.items.map(item => `${item.description} (${item.quantity.toLocaleString('pt-BR')} ${item.unit})`).join(', ')}${supplement.notes ? ` · ${supplement.notes}` : ''}`, actor: supplement.createdBy })),
    ...(project.auditLogs ?? []).filter(log => log.entityType === 'warehouse_requisition' && log.entityId === requisition.id && !log.title.startsWith('Complemento registrado')).map(log => ({ at: log.at, title: log.title, description: log.description, actor: { userId: log.userId, userName: log.userName, userEmail: log.userEmail } })),
  ].sort((left, right) => left.at.localeCompare(right.at));
  const actions = <div className="withdrawal-detail-actions flex flex-wrap justify-end gap-1">
    <Button size="sm" variant="outline" className="h-8 px-2 text-[11px]" onClick={() => void import('./pdf').then(({ generateRequisitionReceipt }) => generateRequisitionReceipt(project, requisition))}><FileDown className="mr-1 h-3.5 w-3.5" />PDF</Button>
    {canCorrect && requisition.status === 'entregue' && <Button size="sm" variant="outline" className="h-8 px-2 text-[11px]" onClick={event => { event.stopPropagation(); onAction(); }} onPointerDown={event => event.stopPropagation()}><Pencil className="mr-1 h-3.5 w-3.5" />Ações da retirada</Button>}
    {hasReturnable && <Button size="sm" className="h-8 px-2 text-[11px]" onClick={onReturn}><RotateCcw className="mr-1 h-3.5 w-3.5" />Registrar devolução</Button>}
    {canCancel && requisition.status === 'entregue' && <Button size="sm" variant="outline" className="h-8 px-2 text-[11px] text-destructive hover:text-destructive" onClick={onCancel}><RotateCcw className="mr-1 h-3.5 w-3.5" />Cancelar retirada</Button>}
    {canDelete && <Button size="sm" variant="destructive" className="h-8 px-2 text-[11px]" onClick={onDelete}><Trash2 className="mr-1 h-3.5 w-3.5" />Excluir</Button>}
  </div>;
  return <div className="space-y-2">
    {canCorrect && returns.length > 0 && <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">Esta retirada possui devolução registrada. Para preservar o histórico, a correção de material ou quantidade está bloqueada.</div>}
    {notes && <div className="rounded-md border border-muted-foreground/20 bg-background/70 px-3 py-2 text-sm"><span className="mr-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Observação:</span>{notes}</div>}
    <div className="overflow-x-auto">
      <table className="withdrawal-materials w-full min-w-[1020px] table-fixed text-xs">
        <colgroup><col className="w-[8%]" /><col /><col className="w-[5%]" /><col className="w-[7%]" /><col className="w-[7%]" /><col className="w-[8%]" /><col className="w-[37%]" /></colgroup>
        <thead><tr><th className="p-1.5 text-left">Código</th><th className="p-1.5 text-left">Material</th><th className="p-1.5 text-left">Un.</th><th className="p-1.5 text-right">Retirado</th><th className="p-1.5 text-right text-success">Devolvido</th><th className="p-1.5 text-right text-primary">Em campo</th><th className="p-1 text-right align-middle">{actions}</th></tr></thead>
        <tbody>{materialSummaries.map(summary => {
          const expanded = expandedMaterialKeys.has(summary.itemKey);
          return <Fragment key={summary.itemKey}>
            <tr className="border-t">
              <td className="p-1.5">{summary.code || '—'}</td>
              <td className="p-1.5">
                <button type="button" className="flex w-full items-center gap-1.5 text-left font-medium hover:text-primary" aria-expanded={expanded} onClick={() => setExpandedMaterialKeys(current => { const next = new Set(current); if (next.has(summary.itemKey)) next.delete(summary.itemKey); else next.add(summary.itemKey); return next; })}>
                  <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-180 text-primary' : ''}`} />
                  <span className="truncate" title={summary.description}>{summary.description}</span>
                  {summary.deliveries.some(delivery => delivery.sourceType === 'supplement') && <span className="shrink-0 rounded-full border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10px] font-semibold text-primary">Com complemento</span>}
                </button>
              </td>
              <td className="p-1.5">{summary.unit}</td>
              <td className="p-1.5 text-right font-mono">{summary.withdrawnQuantity.toLocaleString('pt-BR')}</td>
              <td className="p-1.5 text-right font-mono text-success">{summary.returnedQuantity.toLocaleString('pt-BR')}</td>
              <td className="p-1.5 text-right font-mono font-bold text-primary">{summary.availableQuantity.toLocaleString('pt-BR')}</td>
              <td aria-hidden="true" className="p-0" />
            </tr>
            {expanded && <tr className="border-t border-primary/15 bg-primary/[0.03]"><td colSpan={7} className="p-2 pl-10"><div className="grid gap-1 sm:grid-cols-2 xl:grid-cols-3">{summary.deliveries.map(delivery => <div key={delivery.id} className="rounded-md border bg-background/80 px-2.5 py-2"><div className="flex items-center justify-between gap-2"><strong>{delivery.sourceType === 'original' ? 'Retirada original' : 'Complemento'}</strong><span className="font-mono font-bold">{delivery.quantity.toLocaleString('pt-BR')} {delivery.unit}</span></div><div className="mt-1 text-muted-foreground">{formatOperationalDate(delivery.date)} · {delivery.receiverName || 'Recebedor não informado'}</div></div>)}</div></td></tr>}
          </Fragment>;
        })}</tbody>
      </table>
    </div>
    {returns.length > 0 && <div className="rounded-lg border border-success/30 bg-success/5 p-3"><div className="mb-2 text-sm font-bold text-success">Devoluções registradas</div><div className="space-y-2 text-sm">{returns.map(movement => <div key={movement.id} className="rounded-md border border-success/20 bg-background/70 p-2"><strong>{movement.returnNumber || 'Devolução'}</strong> · operação: {formatOperationalDate(movement.date)} · registro: {formatRecordedAt(movement, movement.date)} · devolvido por {movement.returnerName || 'Não informado'}<div className="mt-1 font-medium text-success">{movement.itemDescription}: {movement.quantity.toLocaleString('pt-BR')} {movement.itemUnit}</div></div>)}</div></div>}
    {history.length > 0 && <div className="rounded-lg border border-primary/25 bg-primary/5 p-3"><div className="mb-2 text-sm font-bold text-primary">Histórico de alterações</div><div className="space-y-2">{history.map((entry, index) => <div key={`${entry.at}-${index}`} className="rounded-md border bg-background/80 p-2 text-sm"><div className="font-semibold">{entry.title}</div><div className="text-xs text-muted-foreground">{entry.actor?.userName || entry.actor?.userEmail || 'Usuário não identificado'} · {formatRecordedAt({ createdAt: entry.at }, requisition.date)}</div>{entry.description && <div className="mt-1 break-words text-xs">{entry.description}</div>}</div>)}</div></div>}
  </div>;
}

type CommitCloudOperation = NonNullable<Props['onCommitCloudOperation']>;

async function executeCloudOperation(
  before: Project,
  after: Project,
  operation: WarehouseCloudOperation,
  handlers: {
    onCommitCloudOperation?: CommitCloudOperation;
    onPrepareCloudOperation?: Props['onPrepareCloudOperation'];
    onCloudOperationConfirmed?: Props['onCloudOperationConfirmed'];
    onProjectChange: Props['onProjectChange'];
  },
): Promise<WarehouseCloudCommitResult> {
  if (handlers.onCommitCloudOperation) {
    return handlers.onCommitCloudOperation(before, after, operation);
  }
  await handlers.onPrepareCloudOperation?.();
  const confirmation = await commitWarehouseOperation(before, after, operation);
  if (handlers.onCloudOperationConfirmed) await handlers.onCloudOperationConfirmed(confirmation);
  else handlers.onProjectChange(confirmation.project);
  return confirmation;
}

function SupplementDeliveryEditor({ project, requisition, supplement, auditActor, onProjectChange, onCloudOperationConfirmed, onPrepareCloudOperation, onCommitCloudOperation, onRunCriticalCloudOperation, onSavingChange, onClose }: {
  project: Project;
  requisition: WarehouseRequisition;
  supplement: WarehouseRequisitionSupplement;
  auditActor?: WarehouseAuditActor;
  onProjectChange: (project: Project) => void;
  onCloudOperationConfirmed?: (confirmation: WarehouseCloudCommitResult) => void | Promise<void>;
  onPrepareCloudOperation?: () => void | Promise<void>;
  onCommitCloudOperation?: CommitCloudOperation;
  onRunCriticalCloudOperation?: Props['onRunCriticalCloudOperation'];
  onSavingChange: (saving: boolean) => void;
  onClose: () => void;
}) {
  const rows = useMemo(() => computeWarehouseRows(project, { includeManual: true }), [project]);
  const [editing, setEditing] = useState(false);
  const [items, setItems] = useState<WarehouseRequisitionItem[]>([]);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [operationKey, setOperationKey] = useState(() => uidWarehouse());
  const hasReturns = ensureWarehouse(project).warehouse!.movements.some(movement => (
    movement.type === 'devolucao'
    && movement.originType === 'return'
    && movement.requisitionId === requisition.id
    && !movement.reversedById
  ));

  const reset = () => {
    setItems(supplement.items.map(item => ({ ...item, description: materialDisplayName(item.code, item.description) })));
    setReason('');
    setOperationKey(uidWarehouse());
  };
  useEffect(() => {
    reset();
    setEditing(false);
  // O identificador/versionamento do complemento controla a reabertura limpa do formulário.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplement.id, supplement.updatedAt]);

  const updateMaterial = (index: number, itemKey: string) => {
    const row = rows.find(candidate => candidate.key === itemKey);
    if (!row) return;
    setItems(current => current.map((item, itemIndex) => itemIndex === index ? {
      itemKey: row.key,
      code: row.code,
      description: materialDisplayName(row.code, row.description),
      unit: row.unit,
      quantity: item.quantity || 1,
    } : item));
  };
  const submit = async () => {
    if (saving) return;
    if (!reason.trim()) return void toast.error('Informe o motivo da correção ou do estorno.');
    if (items.some(item => !item.itemKey || !(item.quantity > 0))) return void toast.error('Revise os materiais e as quantidades do complemento.');
    setSaving(true);
    onSavingChange(true);
    try {
      const operation = async () => {
        const result = correctRequisitionSupplement(project, {
          requisitionId: requisition.id,
          supplementId: supplement.id,
          items,
          reason: reason.trim(),
          idempotencyKey: operationKey,
        }, auditActor);
        await executeCloudOperation(project, result.project, {
          type: 'supplement_correction',
          requisitionId: requisition.id,
          supplementId: supplement.id,
          operationKey,
        }, { onCommitCloudOperation, onPrepareCloudOperation, onCloudOperationConfirmed, onProjectChange });
      };
      await (onRunCriticalCloudOperation ? onRunCriticalCloudOperation(operation) : operation());
      toast.success(items.length ? 'Complemento corrigido e estoque atualizado.' : 'Complemento estornado e estoque recomposto.');
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
      onSavingChange(false);
    }
  };

  const cancelled = supplement.status === 'cancelled';
  const visibleItems = cancelled ? (supplement.cancelledItems ?? supplement.items) : supplement.items;
  return <section className={`rounded-xl border ${cancelled ? 'border-muted bg-muted/20' : 'border-primary/20'}`}>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 p-3">
      <div>
        <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-bold">Complemento de {formatOperationalDate(supplement.date)}</h4><WarehouseStatusBadge label={cancelled ? 'Estornado' : 'Confirmado'} tone={cancelled ? 'neutral' : 'success'} /></div>
        <p className="text-xs text-muted-foreground">Recebedor: {supplement.receiverName || 'Não informado'} · {visibleItems.length} item(ns)</p>
      </div>
      {!cancelled && !editing && <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="min-h-11" disabled={hasReturns} onClick={() => { reset(); setEditing(true); }}><Pencil className="mr-2 h-4 w-4" />Editar complemento</Button>
        <Button type="button" variant="outline" className="min-h-11 text-destructive hover:text-destructive" disabled={hasReturns} onClick={() => { reset(); setItems([]); setEditing(true); }}><RotateCcw className="mr-2 h-4 w-4" />Estornar complemento</Button>
      </div>}
    </div>
    <div className="space-y-3 p-3">
      {!editing && visibleItems.map(item => <div key={item.movementId ?? item.itemKey} className="grid gap-2 rounded-lg border bg-background p-3 sm:grid-cols-[1fr_130px]"><div><div className="font-bold">{materialDisplayName(item.code, item.description)}</div><div className="text-xs text-muted-foreground">{item.code || 'Sem código'} · {item.unit}</div></div><div className={`text-right font-mono font-bold ${cancelled ? 'line-through text-muted-foreground' : ''}`}>{item.quantity.toLocaleString('pt-BR')} {item.unit}</div></div>)}
      {!editing && cancelled && <div className="text-sm text-muted-foreground">Os materiais permanecem no histórico, mas não compõem mais o saldo retirado.</div>}
      {editing && <>
        {items.map((item, index) => <div key={`${item.movementId ?? item.itemKey}-${index}`} className="grid gap-2 rounded-lg border bg-background p-3 sm:grid-cols-[1fr_130px_44px]">
          <select className="min-h-11 w-full rounded-md border bg-background px-3 text-base" value={item.itemKey} onChange={event => updateMaterial(index, event.target.value)} aria-label={`Material corrigido do complemento ${index + 1}`}>{rows.map(row => <option key={row.key} value={row.key}>{row.code ? `${row.code} · ` : ''}{materialDisplayName(row.code, row.description)} · saldo {row.balance.toLocaleString('pt-BR')} {row.unit}</option>)}</select>
          <Input className="min-h-11 text-center text-base" type="number" min="0" step="any" value={item.quantity || ''} onChange={event => setItems(current => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, quantity: Number(event.target.value) } : entry))} aria-label={`Quantidade corrigida de ${item.description}`} />
          <Button type="button" size="icon" variant="ghost" className="min-h-11 min-w-11 text-destructive" onClick={() => setItems(current => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Estornar ${item.description}`}><Trash2 className="h-4 w-4" /></Button>
        </div>)}
        <Button type="button" variant="outline" className="min-h-11" onClick={() => setItems(current => [...current, { itemKey: '', description: '', unit: '', quantity: 1 }])}><Plus className="mr-2 h-4 w-4" />Adicionar material</Button>
        {!items.length && <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm font-medium">Ao confirmar, todo este complemento será estornado e o estoque será recomposto.</div>}
        <WarehouseField label="Motivo da correção ou estorno"><Input className="min-h-11 text-base" value={reason} onChange={event => setReason(event.target.value)} placeholder="Descreva por que o complemento está sendo ajustado" /></WarehouseField>
        <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={() => { reset(); setEditing(false); }}>Cancelar</Button><Button type="button" variant={items.length ? 'default' : 'destructive'} className="min-h-11" disabled={saving} onClick={() => void submit()}><Check className="mr-2 h-4 w-4" />{saving ? 'Salvando na nuvem...' : items.length ? 'Salvar correção' : 'Confirmar estorno'}</Button></div>
      </>}
      {hasReturns && !cancelled && <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">Há devolução vinculada à requisição; este complemento está bloqueado para correção.</div>}
    </div>
  </section>;
}

interface RequisitionActionDialogProps {
  project: Project;
  requisition: WarehouseRequisition | null;
  auditActor?: WarehouseAuditActor;
  canEditOriginal: boolean;
  canEditSupplements: boolean;
  onProjectChange: (project: Project) => void;
  onCloudOperationConfirmed?: (confirmation: WarehouseCloudCommitResult) => void | Promise<void>;
  onPrepareCloudOperation?: () => void | Promise<void>;
  onCommitCloudOperation?: CommitCloudOperation;
  onRunCriticalCloudOperation?: Props['onRunCriticalCloudOperation'];
  onClose: () => void;
}

/** Formulário único: retirada original, complementos confirmados e nova entrega. */
function RequisitionActionDialog({ project, requisition, auditActor, canEditOriginal, canEditSupplements, onProjectChange, onCloudOperationConfirmed, onPrepareCloudOperation, onCommitCloudOperation, onRunCriticalCloudOperation, onClose }: RequisitionActionDialogProps) {
  const rows = useMemo(() => computeWarehouseRows(project, { includeManual: true }), [project]);
  const numbering = useMemo(() => getChapterNumbering(project), [project]);
  const chapters = useMemo(() => flattenPhasesByChapter(project)
    .filter(phase => !phase.parentId)
    .map(phase => ({ id: phase.id, name: `${numbering.get(phase.id) ?? phase.customNumber ?? ''} · ${phase.name}`.replace(/^\s*·\s*/, '') })), [numbering, project]);
  const [editingOriginal, setEditingOriginal] = useState(false);
  const [correctionItems, setCorrectionItems] = useState<WarehouseRequisitionItem[]>([]);
  const [correctionChapterId, setCorrectionChapterId] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [complementDate, setComplementDate] = useState(warehouseOperationalDate());
  const [complementReceiver, setComplementReceiver] = useState('');
  const [complementNotes, setComplementNotes] = useState('');
  const [complementItems, setComplementItems] = useState<WarehouseRequisitionItem[]>([]);
  const [signatureReceiver, setSignatureReceiver] = useState<string>();
  const [photos, setPhotos] = useState<File[]>([]);
  const [materialSearch, setMaterialSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [supplementSaving, setSupplementSaving] = useState(false);
  const [correctionIdempotencyKey, setCorrectionIdempotencyKey] = useState(() => uidWarehouse());
  const [complementIdempotencyKey, setComplementIdempotencyKey] = useState(() => uidWarehouse());
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!requisition) return;
    setEditingOriginal(false);
    setCorrectionItems(requisition.items.map(item => ({ ...item, description: materialDisplayName(item.code, item.description) })));
    setCorrectionChapterId(rootChapterId(project, requisition.chapterId) ?? requisition.chapterId ?? '');
    setCorrectionReason('');
    setComplementDate(warehouseOperationalDate());
    setComplementReceiver(requisition.receiverName || requisition.requesterName || '');
    setComplementNotes('');
    setComplementItems([]);
    setSignatureReceiver(undefined);
    setPhotos([]);
    setMaterialSearch('');
    setCorrectionIdempotencyKey(uidWarehouse());
    setComplementIdempotencyKey(uidWarehouse());
  }, [project, requisition]);

  const correctionBlocked = !!requisition && ensureWarehouse(project).warehouse!.movements.some(movement => (
    movement.type === 'devolucao'
    && movement.originType === 'return'
    && movement.requisitionId === requisition.id
    && !movement.reversedById
  ));
  const selectedComplementKeys = useMemo(() => new Set(complementItems.map(item => item.itemKey)), [complementItems]);
  const availableMaterials = useMemo(() => {
    const tokens = normalizeSearch(materialSearch).split(/\s+/).filter(Boolean);
    return rows.filter(row => row.balance > 0 && !selectedComplementKeys.has(row.key)).filter(row => {
      const haystack = normalizeSearch([row.code, row.description, row.unit].filter(Boolean).join(' '));
      return tokens.every(token => haystack.includes(token));
    }).map(row => ({ ...row, description: materialDisplayName(row.code, row.description) }));
  }, [materialSearch, rows, selectedComplementKeys]);

  const addComplementMaterial = (key: string) => {
    const row = availableMaterials.find(candidate => candidate.key === key);
    if (!row) return;
    setComplementItems(current => [...current, { itemKey: row.key, code: row.code, description: row.description, unit: row.unit, quantity: 1 }]);
    setMaterialSearch('');
  };
  const addCorrectionMaterial = (key: string) => {
    const row = rows.find(candidate => candidate.key === key);
    if (!row || correctionItems.some(item => item.itemKey === row.key)) return;
    setCorrectionItems(current => [...current, { itemKey: row.key, code: row.code, description: materialDisplayName(row.code, row.description), unit: row.unit, quantity: 1 }]);
  };
  const addPhotos = (files: FileList | null) => {
    if (!files) return;
    const incoming = Array.from(files).filter(file => file.type.startsWith('image/'));
    const accepted = incoming.slice(0, Math.max(0, 3 - photos.length));
    if (incoming.length > accepted.length) toast.warning('A operação aceita no máximo três fotos.');
    setPhotos(current => [...current, ...accepted]);
    if (cameraRef.current) cameraRef.current.value = '';
    if (galleryRef.current) galleryRef.current.value = '';
  };

  const saveCorrection = async () => {
    if (!requisition || saving) return;
    if (!correctionItems.length || correctionItems.some(item => !(item.quantity > 0))) return void toast.error('Adicione materiais com quantidade positiva.');
    if (!correctionChapterId) return void toast.error('Selecione o prédio ou destino.');
    if (!correctionReason.trim()) return void toast.error('Informe o motivo da correção.');
    if (correctionBlocked) return void toast.error('Esta retirada possui devolução e não pode ser corrigida.');
    setSaving(true);
    try {
      const chapter = chapters.find(candidate => candidate.id === correctionChapterId);
      const operation = async () => {
        const next = correctDeliveredRequisition(project, requisition.id, { items: correctionItems, chapterId: correctionChapterId, chapterName: chapter?.name, reason: correctionReason.trim(), idempotencyKey: correctionIdempotencyKey }, auditActor);
        await executeCloudOperation(project, next, { type: 'correction', requisitionId: requisition.id, operationKey: correctionIdempotencyKey }, {
          onCommitCloudOperation, onPrepareCloudOperation, onCloudOperationConfirmed, onProjectChange,
        });
      };
      await (onRunCriticalCloudOperation ? onRunCriticalCloudOperation(operation) : operation());
      toast.success('Retirada corrigida e histórico registrado.');
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const saveComplement = async () => {
    if (!requisition || saving) return;
    if (!complementItems.length || complementItems.some(item => !(item.quantity > 0))) return void toast.error('Adicione materiais com quantidade positiva.');
    if (!signatureReceiver?.trim()) return void toast.error('Colete a assinatura de quem recebeu o complemento.');
    setSaving(true);
    try {
      const operation = async () => {
        const attachments = await makeAttachments(photos, project.id, 'foto', 'withdrawals');
        const result = addRequisitionSupplement(project, { requisitionId: requisition.id, date: complementDate, receiverName: complementReceiver, signatureReceiver, notes: complementNotes.trim() || undefined, attachments, idempotencyKey: complementIdempotencyKey, items: complementItems }, auditActor, { publishToDailyReport: false });
        await executeCloudOperation(project, result.project, { type: 'supplement', requisitionId: requisition.id, operationKey: complementIdempotencyKey }, {
          onCommitCloudOperation, onPrepareCloudOperation, onCloudOperationConfirmed, onProjectChange,
        });
        toast.success('Complemento registrado, exibido na requisição e estoque baixado.');
        onClose();
      };
      await (onRunCriticalCloudOperation ? onRunCriticalCloudOperation(operation) : operation());
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const busy = saving || supplementSaving;
  return <Dialog open={!!requisition} onOpenChange={open => !open && !busy && onClose()}>
    <DialogContent className="warehouse-ui flex max-h-[95dvh] w-[calc(100vw-1rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0 [&>button]:h-11 [&>button]:w-11">
      <DialogHeader className="border-b p-4 pr-16"><DialogTitle>Ações da retirada</DialogTitle><DialogDescription>Consulte todas as entregas desta requisição, corrija quando permitido ou acrescente materiais.</DialogDescription></DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {requisition && <div className="space-y-4">
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm"><strong>{requisition.number}</strong><span className="text-muted-foreground"> · requisição com histórico preservado</span><div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3"><span>Data: <strong className="text-foreground">{formatOperationalDate(requisition.date)}</strong></span><span>Destino: <strong className="text-foreground">{requisition.chapterName || 'Não informado'}</strong></span><span>Recebedor: <strong className="text-foreground">{requisition.receiverName || requisition.requesterName || '—'}</strong></span></div></div>

          <section className="rounded-xl border">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 p-3"><div><h3 className="text-sm font-bold">Materiais da retirada original</h3><p className="text-xs text-muted-foreground">A retirada original permanece separada dos complementos.</p></div>{canEditOriginal && !editingOriginal && <Button type="button" variant="outline" className="min-h-11" disabled={correctionBlocked} onClick={() => { setCorrectionIdempotencyKey(uidWarehouse()); setEditingOriginal(true); }}><Pencil className="mr-2 h-4 w-4" />Editar retirada</Button>}</div>
            <div className="space-y-2 p-3">{(editingOriginal ? correctionItems : requisition.items).map((item, index) => <div key={`${item.itemKey}-${index}`} className="grid gap-2 rounded-lg border bg-background p-3 sm:grid-cols-[1fr_120px_120px_44px]"><div className="min-w-0"><div className="break-words text-sm font-bold">{materialDisplayName(item.code, item.description)}</div><div className="text-xs text-muted-foreground">{item.code || 'Sem código'} · {item.unit}</div></div>{editingOriginal ? <><Input className="min-h-11 text-center text-base" type="number" min="0" step="any" value={item.quantity || ''} onChange={event => setCorrectionItems(current => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, quantity: Number(event.target.value) } : entry))} aria-label={`Quantidade corrigida de ${materialDisplayName(item.code, item.description)}`} /><span className="text-center text-xs text-muted-foreground">Saldo {rows.find(row => row.key === item.itemKey)?.balance.toLocaleString('pt-BR') ?? '0'}</span><Button type="button" size="icon" variant="ghost" className="min-h-11 min-w-11 text-destructive" disabled={correctionItems.length === 1} onClick={() => setCorrectionItems(current => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remover ${materialDisplayName(item.code, item.description)}`}><Trash2 className="h-4 w-4" /></Button></> : <><span className="text-right font-mono font-bold sm:col-span-3">{item.quantity.toLocaleString('pt-BR')} {item.unit}</span></>}</div>)}
              {editingOriginal && <><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input className="min-h-11 pl-9 text-base" value={materialSearch} onChange={event => setMaterialSearch(event.target.value)} placeholder="Buscar material para a correção" /></div><div className="max-h-44 overflow-y-auto rounded-lg border">{rows.filter(row => row.balance > 0 && !correctionItems.some(item => item.itemKey === row.key)).filter(row => normalizeSearch([row.code, row.description, row.unit].join(' ')).includes(normalizeSearch(materialSearch))).map(row => <button type="button" key={row.key} className="flex min-h-14 w-full items-center gap-3 border-b px-3 text-left last:border-0 hover:bg-primary/10" onClick={() => addCorrectionMaterial(row.key)}><span className="min-w-0 flex-1"><span className="block break-words text-sm font-bold">{materialDisplayName(row.code, row.description)}</span><span className="text-xs text-muted-foreground">{row.unit} · saldo {row.balance.toLocaleString('pt-BR')}</span></span><Plus className="h-4 w-4 text-primary" /></button>)}</div><WarehouseField label="Prédio / destino"><select className="min-h-11 w-full rounded-md border bg-background px-3 text-base" value={correctionChapterId} onChange={event => setCorrectionChapterId(event.target.value)} aria-label="Prédio / destino da correção"><option value="">Selecione</option>{chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.name}</option>)}</select></WarehouseField><WarehouseField label="Motivo da correção"><Input className="min-h-11 text-base" value={correctionReason} onChange={event => setCorrectionReason(event.target.value)} placeholder="Explique o que foi ajustado" required /></WarehouseField><div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={() => { setEditingOriginal(false); setCorrectionItems(requisition.items.map(item => ({ ...item, description: materialDisplayName(item.code, item.description) }))); setCorrectionReason(''); setCorrectionIdempotencyKey(uidWarehouse()); }}>Cancelar edição</Button><Button type="button" className="min-h-11" disabled={saving || correctionBlocked} onClick={() => void saveCorrection()}><Check className="mr-2 h-4 w-4" />{saving ? 'Salvando correção na nuvem...' : 'Salvar edição'}</Button></div></>}
            </div>
            {correctionBlocked && canEditOriginal && <div className="border-t bg-warning/10 p-3 text-sm">Esta retirada possui devolução registrada; a edição original está bloqueada.</div>}
          </section>

          {!!requisition.supplements?.length && <section className="space-y-3"><div><h3 className="text-sm font-bold">Complementos confirmados</h3><p className="text-xs text-muted-foreground">Cada entrega permanece identificada, embora a lista principal some materiais iguais.</p></div>{requisition.supplements.map(supplement => canEditSupplements ? <SupplementDeliveryEditor key={supplement.id} project={project} requisition={requisition} supplement={supplement} auditActor={auditActor} onProjectChange={onProjectChange} onCloudOperationConfirmed={onCloudOperationConfirmed} onPrepareCloudOperation={onPrepareCloudOperation} onCommitCloudOperation={onCommitCloudOperation} onRunCriticalCloudOperation={onRunCriticalCloudOperation} onSavingChange={setSupplementSaving} onClose={onClose} /> : <section key={supplement.id} className="rounded-xl border bg-muted/20 p-3"><div className="flex items-center justify-between gap-2"><strong>Complemento de {formatOperationalDate(supplement.date)}</strong><WarehouseStatusBadge label={supplement.status === 'cancelled' ? 'Estornado' : 'Confirmado'} tone={supplement.status === 'cancelled' ? 'neutral' : 'success'} /></div><div className="mt-2 space-y-1 text-sm">{(supplement.status === 'cancelled' ? supplement.cancelledItems ?? supplement.items : supplement.items).map(item => <div key={item.movementId ?? item.itemKey} className={supplement.status === 'cancelled' ? 'line-through text-muted-foreground' : ''}>{materialDisplayName(item.code, item.description)} · {item.quantity.toLocaleString('pt-BR')} {item.unit}</div>)}</div></section>)}</section>}

          {canEditSupplements && <section className="rounded-xl border border-primary/25">
            <div className="border-b bg-primary/5 p-3"><h3 className="text-sm font-bold text-primary">Adicionar complemento</h3><p className="text-xs text-muted-foreground">Acrescente materiais na mesma requisição sem alterar as entregas anteriores.</p></div>
            <div className="space-y-3 p-3"><div className="grid gap-3 sm:grid-cols-2"><WarehouseField label="Data da entrega"><Input className="min-h-11 text-base" type="date" value={complementDate} onChange={event => setComplementDate(event.target.value)} /></WarehouseField><WarehouseField label="Quem recebeu"><Input className="min-h-11 text-base" value={complementReceiver} onChange={event => setComplementReceiver(event.target.value)} /></WarehouseField></div>{complementItems.map((item, index) => <div key={`${item.itemKey}-${index}`} className="grid min-h-16 items-center gap-2 rounded-lg border bg-background p-3 sm:grid-cols-[1fr_120px_100px_44px]"><div className="min-w-0"><div className="break-words text-sm font-bold">{item.description}</div><div className="text-xs text-muted-foreground">{item.unit}</div></div><Input className="min-h-11 text-center text-base" type="number" min="0" step="any" value={item.quantity || ''} onChange={event => setComplementItems(current => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, quantity: Number(event.target.value) } : entry))} aria-label={`Quantidade complementar de ${item.description}`} /><span className="text-center text-xs text-muted-foreground">Saldo {rows.find(row => row.key === item.itemKey)?.balance.toLocaleString('pt-BR') ?? '0'}</span><Button type="button" size="icon" variant="ghost" className="min-h-11 min-w-11 text-destructive" onClick={() => setComplementItems(current => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remover complemento ${item.description}`}><Trash2 className="h-4 w-4" /></Button></div>)}<label htmlFor="requisition-action-material-search" className="sr-only">Buscar material para complemento</label><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input id="requisition-action-material-search" className="min-h-11 pl-9 text-base" value={materialSearch} onChange={event => setMaterialSearch(event.target.value)} placeholder="Buscar material por código, descrição ou unidade" /></div><div className="max-h-56 overflow-y-auto rounded-lg border bg-background" aria-label="Materiais disponíveis para complemento">{availableMaterials.map((row, index) => <button key={row.key} type="button" className={`flex min-h-16 w-full items-center gap-3 border-b px-3 text-left last:border-0 hover:bg-primary/10 ${index % 2 ? 'bg-muted/25' : ''}`} onClick={() => addComplementMaterial(row.key)}><span className="min-w-0 flex-1"><span className="block break-words text-sm font-bold">{row.description}</span><span className="mt-1 block text-xs font-medium text-muted-foreground">{row.unit}</span></span><WarehouseStatusBadge label={`Saldo ${row.balance.toLocaleString('pt-BR')}`} tone="info" /><Plus className="h-5 w-5 shrink-0 text-primary" /></button>)}</div><WarehouseField label="Observação" optional><Input className="min-h-11 text-base" value={complementNotes} onChange={event => setComplementNotes(event.target.value)} placeholder="Motivo do complemento" /></WarehouseField><div className="rounded-lg border bg-muted/30 p-3"><SignaturePad label="Assinatura de quem recebeu o complemento" value={signatureReceiver} onChange={setSignatureReceiver} /></div><div className="space-y-3 rounded-lg border bg-muted/30 p-3"><div className="flex items-center gap-2 text-sm font-bold">Fotos da entrega <span className="rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">Opcional · até 3</span></div><div className="grid grid-cols-3 gap-2">{photos.map((photo, index) => <PhotoPreview key={`${photo.name}-${index}`} file={photo} onRemove={() => setPhotos(current => current.filter((_, photoIndex) => photoIndex !== index))} />)}</div><input ref={cameraRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={event => addPhotos(event.target.files)} /><input ref={galleryRef} className="hidden" type="file" accept="image/*" multiple onChange={event => addPhotos(event.target.files)} /><div className="grid grid-cols-2 gap-2"><Button type="button" variant="outline" className="min-h-11 bg-background" disabled={photos.length >= 3} onClick={() => cameraRef.current?.click()}><Camera className="mr-2 h-4 w-4" />Tirar foto</Button><Button type="button" variant="outline" className="min-h-11 bg-background" disabled={photos.length >= 3} onClick={() => galleryRef.current?.click()}><ImagePlus className="mr-2 h-4 w-4" />Galeria</Button></div></div><div className="flex justify-end"><Button type="button" className="min-h-11" disabled={saving} onClick={() => void saveComplement()}><Check className="mr-2 h-4 w-4" />{saving ? 'Salvando na nuvem...' : 'Confirmar complemento'}</Button></div></div>
          </section>}
        </div>}
      </div>
      <DialogFooter className="gap-2 border-t bg-background p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] sm:space-x-0"><Button variant="outline" className="min-h-11 sm:min-w-28" disabled={busy} onClick={onClose}>Fechar</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
function CancelRequisitionDialog({ project, requisition, auditActor, onProjectChange, onCloudOperationConfirmed, onPrepareCloudOperation, onCommitCloudOperation, onRunCriticalCloudOperation, onClose }: {
  project: Project;
  requisition: WarehouseRequisition | null;
  auditActor?: WarehouseAuditActor;
  onProjectChange: (project: Project) => void;
  onCloudOperationConfirmed?: (confirmation: WarehouseCloudCommitResult) => void | Promise<void>;
  onPrepareCloudOperation?: () => void | Promise<void>;
  onCommitCloudOperation?: CommitCloudOperation;
  onRunCriticalCloudOperation?: Props['onRunCriticalCloudOperation'];
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [materialsConfirmedInWarehouse, setMaterialsConfirmedInWarehouse] = useState(false);
  const [saving, setSaving] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => uidWarehouse());
  const requisitionId = requisition?.id;
  const returnable = useMemo(() => requisition ? getRequisitionMaterialSummaries(project, requisition.id)
    .filter(item => item.availableQuantity > 0) : [], [project, requisition]);

  useEffect(() => {
    if (!requisitionId) return;
    setReason('');
    setMaterialsConfirmedInWarehouse(false);
    setSaving(false);
    setIdempotencyKey(uidWarehouse());
  }, [requisitionId]);

  const submit = async () => {
    if (!requisition || saving) return;
    if (!reason.trim()) return void toast.error('Informe o motivo do cancelamento.');
    if (!materialsConfirmedInWarehouse) return void toast.error('Confirme a situação física dos materiais antes de cancelar.');
    setSaving(true);
    try {
      const operation = async () => {
        const next = cancelDeliveredRequisition(project, requisition.id, {
          reason,
          materialsConfirmedInWarehouse,
          idempotencyKey,
        }, auditActor);
        await executeCloudOperation(project, next, {
          type: 'cancellation', requisitionId: requisition.id, operationKey: idempotencyKey,
        }, { onCommitCloudOperation, onPrepareCloudOperation, onCloudOperationConfirmed, onProjectChange });
      };
      await (onRunCriticalCloudOperation ? onRunCriticalCloudOperation(operation) : operation());
      toast.success('Retirada cancelada, saldo recomposto e histórico preservado.');
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return <Dialog open={!!requisition} onOpenChange={open => !open && !saving && onClose()}>
    <DialogContent className="warehouse-ui max-w-2xl">
      <DialogHeader>
        <DialogTitle>Cancelar retirada e retirar da lista ativa</DialogTitle>
        <DialogDescription>A requisição, assinatura e movimentos permanecem no histórico. Somente o saldo ainda em campo será recomposto.</DialogDescription>
      </DialogHeader>
      {requisition && <div className="space-y-4">
        <div className="rounded-lg border bg-muted/30 p-3 text-sm"><strong>{requisition.number}</strong><div className="mt-1 text-muted-foreground">{returnable.length ? `${returnable.length} material(is) ainda serão devolvidos ao saldo.` : 'Não há saldo pendente em campo; somente o status será cancelado.'}</div></div>
        <WarehouseField label="Motivo do cancelamento"><textarea className="min-h-24 w-full rounded-md border bg-background p-3 text-base" value={reason} disabled={saving} onChange={event => setReason(event.target.value)} placeholder="Ex.: retirada lançada por engano; materiais não saíram do Almoxarifado." /></WarehouseField>
        <label className="flex min-h-11 items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm"><input className="mt-1 h-5 w-5 accent-primary" type="checkbox" checked={materialsConfirmedInWarehouse} disabled={saving} onChange={event => setMaterialsConfirmedInWarehouse(event.target.checked)} /><span><strong>Confirmo a situação física</strong><br /><span className="text-muted-foreground">Os materiais ainda em campo não foram aplicados e estão disponíveis para retornar ao Almoxarifado.</span></span></label>
      </div>}
      <DialogFooter><Button variant="outline" disabled={saving} onClick={onClose}>Voltar</Button><Button variant="destructive" disabled={saving || !reason.trim() || !materialsConfirmedInWarehouse} onClick={() => void submit()}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}{saving ? 'Cancelando na nuvem...' : 'Confirmar cancelamento'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function MaterialReturnDialog({ project, requisition, auditActor, onProjectChange, onCloudOperationConfirmed, onPrepareCloudOperation, onCommitCloudOperation, onClose }: {
  project: Project;
  requisition: WarehouseRequisition | null;
  auditActor?: WarehouseAuditActor;
  onProjectChange: (project: Project) => void;
  onCloudOperationConfirmed?: (confirmation: WarehouseCloudCommitResult) => void | Promise<void>;
  onPrepareCloudOperation?: () => void | Promise<void>;
  onCommitCloudOperation?: CommitCloudOperation;
  onClose: () => void;
}) {
  const returnable = useMemo(() => requisition ? getReturnableRequisitionItems(project, requisition.id) : [], [project, requisition]);
  const [date, setDate] = useState(() => warehouseOperationalDate());
  const [returnerName, setReturnerName] = useState('');
  const [signature, setSignature] = useState<string | undefined>();
  const [notes, setNotes] = useState('');
  const [conditionConfirmed, setConditionConfirmed] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => uidWarehouse());

  const reset = () => {
    setDate(warehouseOperationalDate());
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

  const submit = async () => {
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
      await executeCloudOperation(project, result.project, {
        type: 'return', requisitionId: requisition.id, operationKey: idempotencyKey,
      }, { onCommitCloudOperation, onPrepareCloudOperation, onCloudOperationConfirmed, onProjectChange });
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
