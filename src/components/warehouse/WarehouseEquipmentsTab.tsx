import { useEffect, useMemo, useRef, useState } from 'react';
import type { Equipment, Project, WarehouseAttachment, WarehouseAuditActor } from '@/types/project';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Archive, Camera, HardHat, ImagePlus, Loader2, Plus, Printer, Sparkles, X } from 'lucide-react';
import {
  addEquipment,
  ensureWarehouse,
  makeAttachment,
  readFileAsDataURL,
  removeEquipment,
} from '@/lib/warehouse';
import { loadWarehouseAttachmentBlob, openWarehouseAttachment, warehouseAttachmentErrorMessage } from '@/lib/warehouseAttachments';
import { supabase } from '@/integrations/supabase/client';
import QRCode from 'qrcode';
import { toast } from 'sonner';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { equipmentAiBackendError, equipmentAiErrorMessage } from '@/lib/equipmentAi';
import { optimizeEquipmentPhoto } from '@/lib/equipmentPhotoOptimization';
import { WarehouseEmptyState, WarehouseField, WarehouseSectionHeader, WarehouseStatusBadge, type WarehouseTone } from './WarehouseVisual';

interface Props { project: Project; onProjectChange: (next: Project) => void; auditActor?: WarehouseAuditActor; }

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

const emptyEquipment = (): EquipmentForm => ({ description: '', brand: '', model: '', serial: '', patrimony: '', category: '', notes: '' });

const equipmentStatus = (status?: Equipment['status']): { label: string; tone: WarehouseTone } => {
  if (status === 'em_uso') return { label: 'Em uso', tone: 'info' };
  if (status === 'em_manutencao') return { label: 'Em manutenção', tone: 'warning' };
  if (status === 'arquivado') return { label: 'Arquivado', tone: 'danger' };
  return { label: 'Disponível', tone: 'success' };
};

function escapeLabelHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[character] || character));
}

export default function WarehouseEquipmentsTab({ project, onProjectChange, auditActor }: Props) {
  const wh = ensureWarehouse(project).warehouse!;
  const { confirm, dialog: confirmDialog } = useConfirmDelete();
  const [form, setForm] = useState<EquipmentForm>(emptyEquipment);
  const [photos, setPhotos] = useState<File[]>([]);
  const [optimizingPhotos, setOptimizingPhotos] = useState(0);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<EquipmentErrors>({});
  const [showArchived, setShowArchived] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const equipments = wh.equipments.filter(equipment => showArchived || !equipment.archivedAt);

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
      setForm(emptyEquipment());
      setPhotos([]);
      setErrors({});
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

  return (
    <div className="space-y-4">
      <input ref={cameraRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={event => void addPhotos(event.target.files)} />
      <input ref={galleryRef} className="hidden" type="file" accept="image/*" multiple onChange={event => void addPhotos(event.target.files)} />
      <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <WarehouseSectionHeader icon={HardHat} title="Cadastrar equipamento" description="Fotografe, confira os dados e salve." help="A leitura por IA apenas sugere marca, modelo, série, categoria e descrição. O operador deve revisar todos os campos antes do cadastro." />
        <div className="grid gap-4 p-3 lg:grid-cols-[320px_1fr]">
          <div className={`space-y-3 rounded-lg border bg-muted/30 p-3 ${errors.photos ? 'border-destructive bg-destructive/5' : ''}`}><div className="flex items-center gap-2 text-sm font-bold">Fotos do equipamento <span className="rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">Obrigatória</span></div><div className="grid grid-cols-3 gap-2">{photos.map((photo, index) => <EquipmentPhoto key={`${photo.name}-${index}`} file={photo} onRemove={() => setPhotos(current => current.filter((_, photoIndex) => photoIndex !== index))} />)}</div>{!photos.length && <WarehouseEmptyState message="Nenhuma foto" hint="Use Câmera ou Galeria." icon={Camera} className="min-h-24" />}{optimizingPhotos > 0 && <div className="flex items-center justify-center text-sm text-muted-foreground" role="status" aria-live="polite"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Otimizando fotos...</div>}{errors.photos && <div role="alert" className="text-sm font-semibold text-destructive">{errors.photos}</div>}<div className="grid grid-cols-2 gap-2"><Button id="equipment-camera" variant="outline" className="min-h-11 bg-background" disabled={photos.length >= 3 || optimizingPhotos > 0} onClick={() => cameraRef.current?.click()}><Camera className="mr-2 h-4 w-4" />Câmera</Button><Button variant="outline" className="min-h-11 bg-background" disabled={photos.length >= 3 || optimizingPhotos > 0} onClick={() => galleryRef.current?.click()}><ImagePlus className="mr-2 h-4 w-4" />Galeria</Button></div><Button className="min-h-11 w-full font-bold" variant="secondary" disabled={reading || optimizingPhotos > 0 || !photos.length} onClick={() => void readEquipment()}>{reading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}Ler etiqueta e equipamento com IA</Button></div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><EquipmentField id="equipment-description" label="Descrição" value={form.description} confidence={form.confidence?.description} error={errors.description} onChange={description => { setForm({ ...form, description }); setErrors(current => ({ ...current, description: undefined })); }} /><EquipmentField label="Marca" value={form.brand} confidence={form.confidence?.brand} onChange={brand => setForm({ ...form, brand })} /><EquipmentField label="Modelo" value={form.model} confidence={form.confidence?.model} onChange={model => setForm({ ...form, model })} /><EquipmentField label="Nº de série" value={form.serial} confidence={form.confidence?.serial} onChange={serial => { setForm({ ...form, serial }); setErrors(current => ({ ...current, serialNotes: undefined })); }} /><EquipmentField label="Patrimônio existente" value={form.patrimony} optional onChange={patrimony => setForm({ ...form, patrimony })} /><EquipmentField label="Categoria" value={form.category} confidence={form.confidence?.category} optional onChange={category => setForm({ ...form, category })} /><div className="sm:col-span-2 lg:col-span-3"><EquipmentField id="equipment-notes" label="Observações" value={form.notes} optional error={errors.serialNotes} onChange={notes => { setForm({ ...form, notes }); setErrors(current => ({ ...current, serialNotes: undefined })); }} /></div><Button className="min-h-12 font-bold sm:col-span-2 lg:col-span-3" disabled={saving || optimizingPhotos > 0} onClick={() => void submitEquipment()}><Plus className="mr-2 h-4 w-4" />{saving ? 'Salvando...' : 'Confirmar cadastro'}</Button></div>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border bg-card"><WarehouseSectionHeader icon={HardHat} title="Patrimônio identificado" description={`${equipments.length} equipamento(s)`} tone="neutral" actions={<Button className="ml-auto bg-background" variant="outline" onClick={() => setShowArchived(value => !value)}>{showArchived ? 'Ocultar arquivados' : 'Exibir arquivados'}</Button>} /><div data-testid="equipment-gallery" className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{equipments.map(equipment => { const title = equipment.description || equipment.name; const identification = [equipment.brand, equipment.model, equipment.serial].filter(Boolean).join(' · ') || 'Identificação pendente'; const visualStatus = equipmentStatus(equipment.status); return <article key={equipment.id} className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm transition-shadow hover:shadow-md"><EquipmentCardPhotos equipment={equipment} title={title} onOpen={attachment => void openPhoto(attachment)} /><div className="space-y-2 p-3"><div className="flex justify-between gap-2"><div className="min-w-0"><div className="text-xs font-extrabold text-primary">{equipment.internalCode || 'Código legado'}</div><h4 className="line-clamp-2 text-sm font-bold leading-5" title={title}>{title}</h4></div><WarehouseStatusBadge label={visualStatus.label} tone={visualStatus.tone} /></div><div className="truncate text-xs font-medium text-muted-foreground" title={identification}>{identification}</div><div className="grid grid-cols-2 gap-1.5"><Button variant="outline" className="min-h-11 px-2 text-xs" onClick={() => void printLabel(equipment)}><Printer className="mr-1.5 h-4 w-4" />Etiqueta QR</Button>{!equipment.archivedAt && <Button variant="outline" className="min-h-11 px-2 text-xs text-destructive" onClick={() => confirm({ title: 'Arquivar equipamento?', description: 'O equipamento e seus termos continuarão no histórico.', confirmLabel: 'Arquivar' }, () => onProjectChange(removeEquipment(project, equipment.id, auditActor)))}><Archive className="mr-1.5 h-4 w-4" />Arquivar</Button>}</div></div></article>; })}{!equipments.length && <div className="col-span-full"><WarehouseEmptyState message="Nenhum equipamento cadastrado" hint="Use o formulário acima para começar." icon={HardHat} /></div>}</div></section>

      {confirmDialog}
    </div>
  );
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
