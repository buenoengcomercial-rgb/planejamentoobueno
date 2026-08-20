import { useEffect, useMemo, useRef, useState } from 'react';
import type { Equipment, Project, WarehouseAttachment, WarehouseAuditActor, WarehouseEquipmentGroup } from '@/types/project';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Archive, Camera, CheckSquare, ChevronDown, FolderPlus, HardHat, ImagePlus, Loader2, Pencil, Plus, Printer, Sparkles, Users, X } from 'lucide-react';
import {
  addEquipment,
  createEquipmentGroup,
  deleteEquipmentGroup,
  ensureWarehouse,
  hardDeleteEquipment,
  makeAttachment,
  readFileAsDataURL,
  removeEquipment,
  updateEquipmentGroup,
} from '@/lib/warehouse';
import { loadWarehouseAttachmentBlob, openWarehouseAttachment, warehouseAttachmentErrorMessage } from '@/lib/warehouseAttachments';
import { supabase } from '@/integrations/supabase/client';
import QRCode from 'qrcode';
import { toast } from 'sonner';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { equipmentAiBackendError, equipmentAiErrorMessage } from '@/lib/equipmentAi';
import { optimizeEquipmentPhoto } from '@/lib/equipmentPhotoOptimization';
import { WarehouseEmptyState, WarehouseField, WarehouseSectionHeader, WarehouseStatusBadge, type WarehouseTone } from './WarehouseVisual';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface Props { project: Project; onProjectChange: (next: Project) => void; auditActor?: WarehouseAuditActor; canArchive?: boolean; canDelete?: boolean; canManageGroups?: boolean; }

interface EquipmentForm {
  description: string;
  brand: string;
  model: string;
  serial: string;
  patrimony: string;
  category: string;
  notes: string;
  confidence?: Equipment['extractionConfidence'];
}

type EquipmentErrors = Partial<Record<'description' | 'photos' | 'serialNotes', string>>;
type EquipmentSort = 'description' | 'code' | 'status';

const equipmentCollator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
const statusSortOrder: Record<NonNullable<Equipment['status']>, number> = {
  em_uso: 0,
  em_manutencao: 1,
  disponivel: 2,
  arquivado: 3,
};

const emptyEquipment = (): EquipmentForm => ({ description: '', brand: '', model: '', serial: '', patrimony: '', category: '', notes: '' });

const equipmentStatus = (status?: Equipment['status']): { label: string; tone: WarehouseTone } => {
  if (status === 'em_uso') return { label: 'Em uso', tone: 'info' };
  if (status === 'em_manutencao') return { label: 'Em manutenção', tone: 'warning' };
  if (status === 'arquivado') return { label: 'Arquivado', tone: 'danger' };
  return { label: 'Disponível', tone: 'success' };
};

const equipmentTitle = (equipment: Equipment) => equipment.description || equipment.name;
const equipmentCode = (equipment: Equipment) => equipment.internalCode || equipment.id;

function compareEquipments(left: Equipment, right: Equipment, order: EquipmentSort) {
  const byDescription = equipmentCollator.compare(equipmentTitle(left), equipmentTitle(right));
  const byCode = equipmentCollator.compare(equipmentCode(left), equipmentCode(right));
  if (order === 'code') return byCode || byDescription;
  if (order === 'status') {
    const byStatus = statusSortOrder[left.status ?? 'disponivel'] - statusSortOrder[right.status ?? 'disponivel'];
    return byStatus || byDescription || byCode;
  }
  return byDescription || byCode;
}

function escapeLabelHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[character] || character));
}

export default function WarehouseEquipmentsTab({ project, onProjectChange, auditActor, canArchive = true, canDelete = false, canManageGroups = true }: Props) {
  const wh = ensureWarehouse(project).warehouse!;
  const { confirm, dialog: confirmDialog } = useConfirmDelete();
  const [form, setForm] = useState<EquipmentForm>(emptyEquipment);
  const [photos, setPhotos] = useState<File[]>([]);
  const [optimizingPhotos, setOptimizingPhotos] = useState(0);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<EquipmentErrors>({});
  const [showArchived, setShowArchived] = useState(false);
  const [sort, setSort] = useState<EquipmentSort>('description');
  const [groupMode, setGroupMode] = useState(false);
  const [selectedEquipmentIds, setSelectedEquipmentIds] = useState<string[]>([]);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupEquipmentIds, setGroupEquipmentIds] = useState<string[]>([]);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const equipments = useMemo(
    () => wh.equipments
      .filter(equipment => showArchived || !equipment.archivedAt)
      .sort((left, right) => compareEquipments(left, right, sort)),
    [showArchived, sort, wh.equipments],
  );
  const assignedEquipmentIds = useMemo(() => new Set(wh.equipmentGroups.flatMap(group => group.equipmentIds)), [wh.equipmentGroups]);
  const displayEntries = useMemo(() => {
    const visibleById = new Map(equipments.map(equipment => [equipment.id, equipment]));
    const groups = wh.equipmentGroups.flatMap(group => {
      const items = group.equipmentIds.map(id => visibleById.get(id)).filter((equipment): equipment is Equipment => !!equipment);
      return items.length ? [{ kind: 'group' as const, group, items }] : [];
    });
    const singles = equipments.filter(equipment => !assignedEquipmentIds.has(equipment.id)).map(equipment => ({ kind: 'equipment' as const, equipment }));
    return [...groups, ...singles].sort((left, right) => {
      const leftEquipment = left.kind === 'group' ? left.items[0] : left.equipment;
      const rightEquipment = right.kind === 'group' ? right.items[0] : right.equipment;
      return compareEquipments(leftEquipment, rightEquipment, sort);
    });
  }, [assignedEquipmentIds, equipments, sort, wh.equipmentGroups]);
  const groupCandidates = useMemo(() => {
    const editingMemberIds = new Set(wh.equipmentGroups.find(group => group.id === editingGroupId)?.equipmentIds ?? []);
    return [...wh.equipments]
      .filter(equipment => !assignedEquipmentIds.has(equipment.id) || editingMemberIds.has(equipment.id))
      .sort((left, right) => compareEquipments(left, right, 'description'));
  }, [assignedEquipmentIds, editingGroupId, wh.equipmentGroups, wh.equipments]);
  const registrationBusy = reading || saving || optimizingPhotos > 0;
  const hasRegistrationDraft = photos.length > 0 || [form.description, form.brand, form.model, form.serial, form.patrimony, form.category, form.notes]
    .some(value => value.trim().length > 0);

  const resetRegistration = () => {
    setForm(emptyEquipment());
    setPhotos([]);
    setErrors({});
  };

  const closeRegistration = () => {
    if (registrationBusy) return;
    if (!hasRegistrationDraft) {
      resetRegistration();
      setRegistrationOpen(false);
      return;
    }
    confirm({
      title: 'Descartar cadastro do equipamento?',
      description: 'As fotos e os dados preenchidos ainda não foram salvos.',
      confirmLabel: 'Descartar cadastro',
    }, () => {
      resetRegistration();
      setRegistrationOpen(false);
    });
  };

  const addPhotos = async (files: FileList | null) => {
    if (!files) return;
    const incoming = Array.from(files).filter(file => file.type.startsWith('image/'));
    if (photos.length + incoming.length > 3) toast.warning('Use no máximo três fotos por equipamento.');
    if (cameraRef.current) cameraRef.current.value = '';
    if (galleryRef.current) galleryRef.current.value = '';
    const accepted = incoming.slice(0, Math.max(0, 3 - photos.length));
    if (!accepted.length) return;
    setOptimizingPhotos(current => current + 1);
    try {
      const optimized = await Promise.all(accepted.map(optimizeEquipmentPhoto));
      setPhotos(current => [...current, ...optimized].slice(0, 3));
      setErrors(current => ({ ...current, photos: undefined }));
    } finally {
      setOptimizingPhotos(current => Math.max(0, current - 1));
    }
  };

  const readEquipment = async () => {
    if (!photos.length) return toast.error('Adicione ao menos uma foto para usar a leitura por IA.');
    try {
      setReading(true);
      const imageDataUrls = await Promise.all(photos.map(readFileAsDataURL));
      const { data, error } = await supabase.functions.invoke<{
        ok?: boolean;
        error?: string;
        equipment?: { brand?: string; model?: string; serial?: string; category?: string; description?: string; confidence?: Equipment['extractionConfidence'] };
      }>('read-equipment', { body: { imageDataUrls } });
      if (error) throw error;
      if (!data?.ok || !data.equipment) throw equipmentAiBackendError(data?.error);
      setForm(current => ({
        ...current,
        brand: data.equipment?.brand || current.brand,
        model: data.equipment?.model || current.model,
        serial: data.equipment?.serial || current.serial,
        category: data.equipment?.category || current.category,
        description: data.equipment?.description || current.description,
        confidence: data.equipment?.confidence,
      }));
      toast.success('Sugestões preenchidas. Revise todos os campos antes de cadastrar.');
    } catch (error) {
      toast.warning(await equipmentAiErrorMessage(error));
    } finally { setReading(false); }
  };

  const submitEquipment = async () => {
    const nextErrors: EquipmentErrors = {};
    if (!form.description.trim()) nextErrors.description = 'Informe a descrição.';
    if (!photos.length) nextErrors.photos = 'Adicione ao menos uma foto.';
    if (!form.serial.trim() && !form.notes.trim()) nextErrors.serialNotes = 'Informe a série ou uma justificativa.';
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      const target = nextErrors.description ? document.getElementById('equipment-description')
        : nextErrors.photos ? document.getElementById('equipment-camera')
          : document.getElementById('equipment-notes');
      target?.focus();
      toast.error(nextErrors.description || nextErrors.photos || nextErrors.serialNotes || 'Revise os campos destacados.');
      return;
    }
    setErrors({});
    try {
      setSaving(true);
      const attachments = await Promise.all(photos.map(file => makeAttachment(file, project.id, 'foto', 'equipment')));
      onProjectChange(addEquipment(project, {
        name: [form.brand, form.model].filter(Boolean).join(' ') || form.description,
        description: form.description.trim(),
        brand: form.brand.trim() || undefined,
        model: form.model.trim() || undefined,
        serial: form.serial.trim() || undefined,
        patrimony: form.patrimony.trim() || undefined,
        category: form.category.trim() || undefined,
        notes: form.notes.trim() || undefined,
        photos: attachments,
        status: 'disponivel',
        extractionStatus: form.confidence ? 'ready' : 'idle',
        extractionConfidence: form.confidence,
      }, auditActor));
      resetRegistration();
      setRegistrationOpen(false);
      toast.success('Equipamento cadastrado com identificação interna.');
    } catch (error) { toast.error((error as Error).message); } finally { setSaving(false); }
  };

  const printLabel = async (equipment: Equipment) => {
    const code = equipment.internalCode || equipment.id;
    const qr = await QRCode.toDataURL(code, { width: 220, margin: 1 });
    const popup = window.open('', '_blank', 'width=520,height=520');
    if (!popup) return toast.error('Autorize pop-ups para imprimir a etiqueta.');
    const safeCode = escapeLabelHtml(code);
    const safeDescription = escapeLabelHtml(equipment.description || equipment.name);
    const safeIdentification = escapeLabelHtml([equipment.brand, equipment.model, equipment.serial].filter(Boolean).join(' · '));
    popup.document.write(`<html><head><title>${safeCode}</title><style>body{font-family:Arial;padding:24px;text-align:center}.label{border:2px solid #111;padding:16px;display:inline-block;width:300px}img{width:180px;height:180px}h1{font-size:24px;margin:8px}p{margin:4px}</style></head><body><div class="label"><img src="${qr}" alt="QR Code"><h1>${safeCode}</h1><p>${safeDescription}</p><p>${safeIdentification}</p></div><script>window.onload=()=>window.print()</script></body></html>`);
    popup.document.close();
  };

  const openPhoto = async (attachment?: WarehouseAttachment) => {
    if (!attachment) return toast.error('Equipamento sem foto registrada.');
    try { await openWarehouseAttachment(attachment); } catch (error) { toast.error(warehouseAttachmentErrorMessage(error)); }
  };

  const deleteEquipment = async (equipment: Equipment) => {
    try {
      const next = hardDeleteEquipment(project, equipment.id);
      onProjectChange(next);
      const paths = (equipment.photos ?? []).map(photo => photo.storagePath).filter((path): path is string => !!path);
      if (paths.length) {
        const { error } = await supabase.storage.from('daily-report-photos').remove(paths);
        if (error) throw error;
      }
      toast.success('Equipamento, fotos e cautelas associadas removidos definitivamente.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível excluir o equipamento.');
    }
  };

  const toggleEquipmentSelection = (equipmentId: string) => {
    setSelectedEquipmentIds(current => current.includes(equipmentId)
      ? current.filter(id => id !== equipmentId)
      : [...current, equipmentId]);
  };

  const openCreateGroup = () => {
    const selected = equipments.filter(equipment => selectedEquipmentIds.includes(equipment.id));
    if (selected.length < 2) return toast.error('Selecione ao menos dois patrimônios para formar um grupo.');
    setEditingGroupId(null);
    setGroupEquipmentIds(selected.map(equipment => equipment.id));
    setGroupName(equipmentTitle(selected[0]));
    setGroupDialogOpen(true);
  };

  const openEditGroup = (group: WarehouseEquipmentGroup) => {
    setEditingGroupId(group.id);
    setGroupName(group.name);
    setGroupEquipmentIds(group.equipmentIds);
    setGroupDialogOpen(true);
  };

  const toggleGroupMember = (equipmentId: string) => {
    setGroupEquipmentIds(current => current.includes(equipmentId)
      ? current.filter(id => id !== equipmentId)
      : [...current, equipmentId]);
  };

  const saveGroup = () => {
    try {
      const next = editingGroupId
        ? updateEquipmentGroup(project, editingGroupId, { name: groupName, equipmentIds: groupEquipmentIds }, auditActor)
        : createEquipmentGroup(project, { name: groupName, equipmentIds: groupEquipmentIds }, auditActor);
      onProjectChange(next);
      setEditingGroupId(null);
      setGroupDialogOpen(false);
      setGroupName('');
      setGroupEquipmentIds([]);
      setSelectedEquipmentIds([]);
      setGroupMode(false);
      toast.success(editingGroupId ? 'Grupo de patrimônios atualizado.' : 'Grupo de patrimônios criado.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível salvar o grupo.');
    }
  };

  const closeGroupDialog = () => {
    setEditingGroupId(null);
    setGroupDialogOpen(false);
    setGroupName('');
    setGroupEquipmentIds([]);
  };

  const removeGroup = (group: WarehouseEquipmentGroup) => confirm({
    title: 'Desfazer grupo de patrimônios?',
    description: 'Os equipamentos continuarão cadastrados individualmente, com seus códigos, séries e cautelas preservados.',
    confirmLabel: 'Desfazer grupo',
  }, () => {
    onProjectChange(deleteEquipmentGroup(project, group.id));
    toast.success('Grupo desfeito. Os patrimônios permanecem individuais.');
  });

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-xl border bg-card">
        <WarehouseSectionHeader icon={HardHat} title="Patrimônio identificado" description={`${equipments.length} equipamento(s)`} tone="neutral" className="flex-wrap" actions={<div className="flex w-full flex-col gap-2 xl:w-auto"><div className="flex flex-col gap-2 sm:flex-row"><Button className="min-h-11" onClick={() => setRegistrationOpen(true)}><Plus className="mr-2 h-4 w-4" />Adicionar equipamento</Button><Button className="min-h-11 bg-background" variant="outline" onClick={() => setShowArchived(value => !value)}>{showArchived ? 'Ocultar arquivados' : 'Exibir arquivados'}</Button>{canManageGroups && <Button className="min-h-11" variant={groupMode ? 'secondary' : 'outline'} onClick={() => { setGroupMode(value => !value); setSelectedEquipmentIds([]); }}><CheckSquare className="mr-2 h-4 w-4" />{groupMode ? 'Cancelar organização' : 'Organizar grupos'}</Button>}</div><Select value={sort} onValueChange={value => setSort(value as EquipmentSort)}><SelectTrigger aria-label="Ordenar equipamentos" className="min-h-11 bg-background text-sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="description">Descrição A–Z</SelectItem><SelectItem value="code">Código do patrimônio</SelectItem><SelectItem value="status">Status</SelectItem></SelectContent></Select></div>} />
        {groupMode && <div className="border-b bg-primary/5 px-3 py-2 text-sm font-medium text-primary">Selecione patrimônios sem grupo para criar uma classificação permanente.</div>}
        <div data-testid="equipment-gallery" className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{displayEntries.map(entry => entry.kind === 'group' ? <EquipmentGroup key={entry.group.id} group={entry.group} equipments={entry.items} canArchive={canArchive} canDelete={canDelete} canManage={canManageGroups} onOpenPhoto={attachment => void openPhoto(attachment)} onPrintLabel={equipment => void printLabel(equipment)} onArchive={equipment => confirm({ title: 'Arquivar equipamento?', description: 'O equipamento e seus termos continuarão no histórico.', confirmLabel: 'Arquivar' }, () => onProjectChange(removeEquipment(project, equipment.id, auditActor)))} onDelete={equipment => void deleteEquipment(equipment)} onEdit={openEditGroup} onDeleteGroup={removeGroup} /> : <EquipmentCard key={entry.equipment.id} equipment={entry.equipment} canArchive={canArchive} canDelete={canDelete} onOpenPhoto={attachment => void openPhoto(attachment)} onPrintLabel={equipment => void printLabel(equipment)} onArchive={equipment => confirm({ title: 'Arquivar equipamento?', description: 'O equipamento e seus termos continuarão no histórico.', confirmLabel: 'Arquivar' }, () => onProjectChange(removeEquipment(project, equipment.id, auditActor)))} onDelete={equipment => void deleteEquipment(equipment)} selectable={groupMode && canManageGroups} selected={selectedEquipmentIds.includes(entry.equipment.id)} onToggleSelection={toggleEquipmentSelection} />)}{!equipments.length && <div className="col-span-full"><WarehouseEmptyState message="Nenhum equipamento cadastrado" hint="Use Adicionar equipamento para começar." icon={HardHat} /></div>}</div>
        {groupMode && <div className="sticky bottom-3 z-10 border-t bg-card/95 p-3 backdrop-blur"><div className="mx-auto flex max-w-xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><span className="text-sm font-semibold">{selectedEquipmentIds.length} patrimônio(s) selecionado(s)</span><div className="flex gap-2"><Button variant="outline" className="min-h-11 flex-1" onClick={() => setSelectedEquipmentIds([])}>Limpar</Button><Button className="min-h-11 flex-1" disabled={selectedEquipmentIds.length < 2} onClick={openCreateGroup}><FolderPlus className="mr-2 h-4 w-4" />Criar grupo</Button></div></div></div>}
      </section>

      <Dialog open={registrationOpen} onOpenChange={open => { if (open) setRegistrationOpen(true); else closeRegistration(); }}>
        <DialogContent className="warehouse-ui flex max-h-[95dvh] w-[calc(100vw-1rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0 [&>button]:h-11 [&>button]:w-11">
          <DialogHeader className="border-b p-4 pr-16">
            <DialogTitle>Cadastrar novo equipamento</DialogTitle>
            <DialogDescription>Adicione as fotos, use a leitura por IA e confira os dados antes de salvar.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
            <input ref={cameraRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={event => void addPhotos(event.target.files)} />
            <input ref={galleryRef} className="hidden" type="file" accept="image/*" multiple onChange={event => void addPhotos(event.target.files)} />
            <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
              <div className={`space-y-3 rounded-lg border bg-muted/30 p-3 ${errors.photos ? 'border-destructive bg-destructive/5' : ''}`}><div className="flex items-center gap-2 text-sm font-bold">Fotos do equipamento <span className="rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">Obrigatória</span></div><div className="grid grid-cols-3 gap-2">{photos.map((photo, index) => <EquipmentPhoto key={`${photo.name}-${index}`} file={photo} onRemove={() => setPhotos(current => current.filter((_, photoIndex) => photoIndex !== index))} />)}</div>{!photos.length && <WarehouseEmptyState message="Nenhuma foto" hint="Use Câmera ou Galeria." icon={Camera} className="min-h-24" />}{optimizingPhotos > 0 && <div className="flex items-center justify-center text-sm text-muted-foreground" role="status" aria-live="polite"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Otimizando fotos...</div>}{errors.photos && <div role="alert" className="text-sm font-semibold text-destructive">{errors.photos}</div>}<div className="grid grid-cols-2 gap-2"><Button id="equipment-camera" variant="outline" className="min-h-11 bg-background" disabled={photos.length >= 3 || optimizingPhotos > 0} onClick={() => cameraRef.current?.click()}><Camera className="mr-2 h-4 w-4" />Câmera</Button><Button variant="outline" className="min-h-11 bg-background" disabled={photos.length >= 3 || optimizingPhotos > 0} onClick={() => galleryRef.current?.click()}><ImagePlus className="mr-2 h-4 w-4" />Galeria</Button></div><Button className="min-h-11 w-full font-bold" variant="secondary" disabled={reading || optimizingPhotos > 0 || !photos.length} onClick={() => void readEquipment()}>{reading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}Ler etiqueta e equipamento com IA</Button></div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><EquipmentField id="equipment-description" label="Descrição" value={form.description} confidence={form.confidence?.description} error={errors.description} onChange={description => { setForm({ ...form, description }); setErrors(current => ({ ...current, description: undefined })); }} /><EquipmentField label="Marca" value={form.brand} confidence={form.confidence?.brand} onChange={brand => setForm({ ...form, brand })} /><EquipmentField label="Modelo" value={form.model} confidence={form.confidence?.model} onChange={model => setForm({ ...form, model })} /><EquipmentField label="Nº de série" value={form.serial} confidence={form.confidence?.serial} onChange={serial => { setForm({ ...form, serial }); setErrors(current => ({ ...current, serialNotes: undefined })); }} /><EquipmentField label="Patrimônio existente" value={form.patrimony} optional onChange={patrimony => setForm({ ...form, patrimony })} /><EquipmentField label="Categoria" value={form.category} confidence={form.confidence?.category} optional onChange={category => setForm({ ...form, category })} /><div className="sm:col-span-2 lg:col-span-3"><EquipmentField id="equipment-notes" label="Observações" value={form.notes} optional error={errors.serialNotes} onChange={notes => { setForm({ ...form, notes }); setErrors(current => ({ ...current, serialNotes: undefined })); }} /></div></div>
            </div>
          </div>
          <DialogFooter className="gap-2 border-t bg-background p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] sm:space-x-0">
            <Button variant="outline" className="min-h-11 sm:min-w-28" disabled={registrationBusy} onClick={closeRegistration}>Cancelar</Button>
            <Button className="min-h-11 sm:min-w-48" disabled={saving || optimizingPhotos > 0} onClick={() => void submitEquipment()}><Plus className="mr-2 h-4 w-4" />{saving ? 'Salvando...' : 'Cadastrar equipamento'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={groupDialogOpen} onOpenChange={open => { if (!open) closeGroupDialog(); }}>
        <DialogContent className="warehouse-ui flex max-h-[95dvh] w-[calc(100vw-1rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0 [&>button]:h-11 [&>button]:w-11">
          <DialogHeader className="border-b p-4 pr-16"><DialogTitle>{editingGroupId ? 'Editar grupo de patrimônios' : 'Criar grupo de patrimônios'}</DialogTitle><DialogDescription>O grupo apenas organiza a visualização. Código, série, fotos e cautelas continuam individuais.</DialogDescription></DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 sm:p-4">
            <WarehouseField label="Nome do grupo"><Input aria-label="Nome do grupo" className="min-h-11 text-base" value={groupName} onChange={event => setGroupName(event.target.value)} placeholder="Ex.: Adaptadores de mandril" /></WarehouseField>
            <div><div className="mb-2 flex items-center justify-between gap-2"><div className="text-sm font-bold">Patrimônios do grupo</div><span className="text-xs font-medium text-muted-foreground">{groupEquipmentIds.length} selecionado(s)</span></div><div className="max-h-[45dvh] space-y-2 overflow-y-auto rounded-lg border bg-muted/20 p-2">{groupCandidates.map(equipment => { const selected = groupEquipmentIds.includes(equipment.id); const title = equipmentTitle(equipment); const details = [equipment.internalCode || 'Código legado', equipment.brand, equipment.model, equipment.serial].filter(Boolean).join(' · '); return <label key={equipment.id} className={`flex min-h-16 cursor-pointer items-center gap-3 rounded-lg border p-2.5 ${selected ? 'border-primary bg-primary/5' : 'bg-background'}`}><input type="checkbox" className="h-5 w-5 accent-primary" checked={selected} onChange={() => toggleGroupMember(equipment.id)} /><span className="min-w-0 flex-1"><span className="block text-sm font-bold leading-snug">{title}</span><span className="block truncate text-xs text-muted-foreground" title={details}>{details}</span></span><WarehouseStatusBadge label={equipmentStatus(equipment.status).label} tone={equipmentStatus(equipment.status).tone} /></label>; })}{!groupCandidates.length && <WarehouseEmptyState message="Nenhum patrimônio disponível" hint="Remova unidades de outro grupo antes de incluí-las aqui." icon={Users} />}</div></div>
          </div>
          <DialogFooter className="gap-2 border-t bg-background p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] sm:space-x-0"><Button variant="outline" className="min-h-11 sm:min-w-28" onClick={closeGroupDialog}>Cancelar</Button><Button className="min-h-11 sm:min-w-44" disabled={!groupName.trim() || groupEquipmentIds.length < 2} onClick={saveGroup}>{editingGroupId ? 'Salvar grupo' : 'Criar grupo'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {confirmDialog}
    </div>
  );
}

interface EquipmentCardProps {
  equipment: Equipment;
  canArchive: boolean;
  canDelete: boolean;
  onOpenPhoto: (attachment?: WarehouseAttachment) => void;
  onPrintLabel: (equipment: Equipment) => void;
  onArchive: (equipment: Equipment) => void;
  onDelete: (equipment: Equipment) => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelection?: (equipmentId: string) => void;
}

function EquipmentCard({ equipment, canArchive, canDelete, onOpenPhoto, onPrintLabel, onArchive, onDelete, selectable = false, selected = false, onToggleSelection }: EquipmentCardProps) {
  const title = equipmentTitle(equipment);
  const identification = [equipment.brand, equipment.model, equipment.serial].filter(Boolean).join(' · ') || 'Identificação pendente';
  const visualStatus = equipmentStatus(equipment.status);
  return <article data-testid="equipment-card" className={`min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm transition-shadow hover:shadow-md ${selected ? 'border-primary ring-2 ring-primary/25' : ''}`}>
    <EquipmentCardPhotos equipment={equipment} title={title} onOpen={onOpenPhoto} />
    <div className="space-y-2 p-3">
      <div className="flex justify-between gap-2"><div className="min-w-0"><div className="text-xs font-extrabold text-primary">{equipment.internalCode || 'Código legado'}</div><h4 className="line-clamp-2 text-sm font-bold leading-5" title={title}>{title}</h4></div>{selectable ? <label className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border bg-background" title="Selecionar para grupo"><input type="checkbox" className="h-5 w-5 accent-primary" checked={selected} onChange={() => onToggleSelection?.(equipment.id)} aria-label={`Selecionar ${title}`} /></label> : <WarehouseStatusBadge label={visualStatus.label} tone={visualStatus.tone} />}</div>
      <div className="truncate text-xs font-medium text-muted-foreground" title={identification}>{identification}</div>
      {!selectable && <div className={`grid gap-1.5 ${canArchive || canDelete ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <Button variant="outline" className="min-h-11 px-2 text-xs" onClick={() => onPrintLabel(equipment)}><Printer className="mr-1.5 h-4 w-4" />Etiqueta QR</Button>
        {canArchive && !equipment.archivedAt && <Button variant="outline" className="min-h-11 px-2 text-xs text-destructive" onClick={() => onArchive(equipment)}><Archive className="mr-1.5 h-4 w-4" />Arquivar</Button>}
        {canDelete && <Button variant="destructive" className="col-span-full min-h-11 px-2 text-xs" onClick={() => onDelete(equipment)}>Excluir definitivamente</Button>}
      </div>
      }
    </div>
  </article>;
}

function EquipmentGroup({ group, equipments, canManage, onEdit, onDeleteGroup, ...cardProps }: Omit<EquipmentCardProps, 'equipment'> & { group: WarehouseEquipmentGroup; equipments: Equipment[]; canManage: boolean; onEdit: (group: WarehouseEquipmentGroup) => void; onDeleteGroup: (group: WarehouseEquipmentGroup) => void; }) {
  const statusSummary = Object.entries(equipments.reduce<Record<string, number>>((summary, equipment) => {
    const label = equipmentStatus(equipment.status).label;
    summary[label] = (summary[label] ?? 0) + 1;
    return summary;
  }, {})).map(([label, quantity]) => `${quantity} ${quantity > 1 && label === 'Disponível' ? 'disponíveis' : label.toLocaleLowerCase('pt-BR')}`).join(' · ');

  return <Collapsible className="col-span-full rounded-xl border bg-muted/20 p-3 shadow-sm">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0"><div className="text-xs font-extrabold text-primary">{equipments.length} patrimônio(s) no grupo</div><h4 className="text-sm font-bold leading-5">{group.name}</h4><p className="mt-1 text-xs text-muted-foreground">{statusSummary}</p></div>
      <div className="flex flex-wrap gap-2"><CollapsibleTrigger asChild><Button variant="outline" className="min-h-11 shrink-0"><ChevronDown className="mr-2 h-4 w-4" />Ver patrimônios</Button></CollapsibleTrigger>{canManage && <Button variant="outline" className="min-h-11" onClick={() => onEdit(group)}><Pencil className="mr-2 h-4 w-4" />Editar grupo</Button>}{canManage && <Button variant="outline" className="min-h-11 text-destructive" onClick={() => onDeleteGroup(group)}><X className="mr-2 h-4 w-4" />Desfazer</Button>}</div>
    </div>
    <CollapsibleContent className="pt-3">
      <div data-testid="equipment-group-items" className="grid grid-cols-1 gap-3 border-t pt-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {equipments.map(equipment => <EquipmentCard key={equipment.id} equipment={equipment} {...cardProps} />)}
      </div>
    </CollapsibleContent>
  </Collapsible>;
}

function EquipmentField({ id, label, value, confidence, optional, error, onChange }: { id?: string; label: string; value: string; confidence?: number; optional?: boolean; error?: string; onChange: (value: string) => void }) {
  return <WarehouseField label={label} optional={optional} error={error} meta={confidence != null ? <span className={`text-xs font-bold ${confidence < 0.6 ? 'text-warning' : 'text-success'}`}>IA {Math.round(confidence * 100)}%</span> : undefined}><Input id={id} aria-label={label} className="min-h-11" value={value} onChange={event => onChange(event.target.value)} /></WarehouseField>;
}

type EquipmentPhotoState = {
  source?: string;
  status: 'empty' | 'loading' | 'ready' | 'error';
};

function initialPhotoStates(attachments: WarehouseAttachment[]): EquipmentPhotoState[] {
  if (!attachments.length) return [{ status: 'empty' }];
  return attachments.map(attachment => attachment.dataUrl
    ? { source: attachment.dataUrl, status: 'ready' }
    : { status: 'loading' });
}

function EquipmentCardPhotos({ equipment, title, onOpen }: { equipment: Equipment; title: string; onOpen: (attachment?: WarehouseAttachment) => void }) {
  const attachments = useMemo(() => equipment.photos?.slice(0, 3) ?? [], [equipment.photos]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [photoStates, setPhotoStates] = useState<EquipmentPhotoState[]>(() => initialPhotoStates(attachments));

  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];
    setSelectedIndex(0);
    setPhotoStates(initialPhotoStates(attachments));

    const loadPhoto = async (attachment: WarehouseAttachment, index: number) => {
      if (attachment.dataUrl) return;
      try {
        const blob = await loadWarehouseAttachmentBlob(attachment);
        const objectUrl = URL.createObjectURL(blob);
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        objectUrls.push(objectUrl);
        setPhotoStates(current => current.map((state, stateIndex) => stateIndex === index
          ? { source: objectUrl, status: 'ready' }
          : state));
      } catch {
        if (active) setPhotoStates(current => current.map((state, stateIndex) => stateIndex === index
          ? { status: 'error' }
          : state));
      }
    };

    void (async () => {
      if (attachments[0]) await loadPhoto(attachments[0], 0);
      if (!active) return;
      await Promise.all(attachments.slice(1).map((attachment, index) => loadPhoto(attachment, index + 1)));
    })();

    return () => {
      active = false;
      objectUrls.forEach(objectUrl => URL.revokeObjectURL(objectUrl));
    };
  }, [attachments]);

  const selectedState = photoStates[selectedIndex] ?? { status: 'empty' as const };
  return <div className="bg-muted/30">
    <button type="button" className="relative block h-28 w-full overflow-hidden p-1 sm:h-32" aria-label={`Abrir foto ${selectedIndex + 1} de ${Math.max(attachments.length, 1)} de ${title}`} onClick={() => onOpen(attachments[selectedIndex])}>
      <EquipmentPhotoContent state={selectedState} alt={title} />
      {attachments.length > 1 && <span className="absolute bottom-1.5 right-1.5 rounded-full bg-background/90 px-2 py-0.5 text-[11px] font-medium shadow-sm">{selectedIndex + 1} de {attachments.length}</span>}
    </button>
    {attachments.length > 1 && <div className="flex min-h-14 items-center gap-1.5 border-t bg-background/70 px-2 py-1.5" aria-label={`Fotos de ${title}`}>
      {attachments.map((attachment, index) => <button key={attachment.id || `${attachment.name}-${index}`} type="button" className={`h-11 w-11 shrink-0 overflow-hidden rounded border bg-muted/30 p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedIndex === index ? 'border-primary ring-2 ring-primary/30' : 'border-border'}`} aria-label={`Selecionar foto ${index + 1} de ${attachments.length} de ${title}`} aria-pressed={selectedIndex === index} onClick={() => setSelectedIndex(index)}><EquipmentPhotoContent state={photoStates[index] ?? { status: 'loading' }} alt={`Miniatura ${index + 1} de ${title}`} compact /></button>)}
    </div>}
  </div>;
}

function EquipmentPhotoContent({ state, alt, compact = false }: { state: EquipmentPhotoState; alt: string; compact?: boolean }) {
  if (state.status === 'ready' && state.source) return <img src={state.source} alt={alt} className="h-full w-full object-contain" loading="lazy" decoding="async" />;
  if (state.status === 'loading') return <span className={`flex h-full items-center justify-center text-muted-foreground ${compact ? '' : 'text-sm'}`}><Loader2 className={`${compact ? 'h-3.5 w-3.5' : 'mr-2 h-4 w-4'} animate-spin`} />{!compact && 'Carregando foto'}</span>;
  return <span className={`flex h-full items-center justify-center text-center text-muted-foreground ${compact ? 'text-[10px] leading-none' : 'px-3 text-sm'}`}>{state.status === 'error' ? (compact ? 'Erro' : 'Foto indisponível') : (compact ? 'Sem foto' : 'Equipamento sem foto')}</span>;
}

function EquipmentPhoto({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  return <div className="relative aspect-square overflow-hidden rounded-md border"><img src={url} alt={file.name} className="h-full w-full object-cover" onLoad={() => URL.revokeObjectURL(url)} /><Button size="icon" variant="destructive" className="absolute right-1 top-1 h-8 w-8" onClick={onRemove} aria-label={`Remover ${file.name}`}><X className="h-4 w-4" /></Button></div>;
}
