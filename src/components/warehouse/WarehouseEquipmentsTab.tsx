import { useEffect, useMemo, useRef, useState } from 'react';
import type { CustodyTerm, CustodyTermStatus, Equipment, Project, WarehouseAttachment, WarehouseAuditActor } from '@/types/project';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Archive, Camera, FileDown, ImagePlus, Loader2, Plus, Printer, Sparkles, Undo2, X } from 'lucide-react';
import {
  addEquipment,
  ensureWarehouse,
  issueCustodyTerm,
  makeAttachment,
  readFileAsDataURL,
  removeEquipment,
  returnCustodyTerm,
} from '@/lib/warehouse';
import { loadWarehouseAttachmentBlob, openWarehouseAttachment, warehouseAttachmentErrorMessage } from '@/lib/warehouseAttachments';
import SignaturePad from './SignaturePad';
import { generateCustodyTermPdf } from './pdf';
import { supabase } from '@/integrations/supabase/client';
import QRCode from 'qrcode';
import { toast } from 'sonner';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { equipmentAiBackendError, equipmentAiErrorMessage } from '@/lib/equipmentAi';

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

const emptyEquipment = (): EquipmentForm => ({ description: '', brand: '', model: '', serial: '', patrimony: '', category: '', notes: '' });

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
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const equipments = wh.equipments.filter(equipment => showArchived || !equipment.archivedAt);

  const [showTerm, setShowTerm] = useState(false);
  const [term, setTerm] = useState({ equipmentId: '', workerName: '', dueDate: '', accessories: '', stateOnDelivery: '', sigRec: '' as string | undefined });
  const [returnFor, setReturnFor] = useState<CustodyTerm | null>(null);
  const [returnPhotos, setReturnPhotos] = useState<File[]>([]);
  const [returnData, setReturnData] = useState({ stateOnReturn: '', divergenceNotes: '', status: 'devolvido' as CustodyTermStatus });

  const addPhotos = (files: FileList | null) => {
    if (!files) return;
    const incoming = Array.from(files).filter(file => file.type.startsWith('image/'));
    setPhotos(current => [...current, ...incoming].slice(0, 3));
    if (photos.length + incoming.length > 3) toast.warning('Use no máximo três fotos por equipamento.');
    if (cameraRef.current) cameraRef.current.value = '';
    if (galleryRef.current) galleryRef.current.value = '';
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
    if (!form.description.trim()) return toast.error('Informe a descrição do equipamento.');
    if (!photos.length) return toast.error('Adicione ao menos uma foto do equipamento.');
    if (!form.serial.trim() && !form.notes.trim()) return toast.error('Sem série legível, informe uma justificativa nas observações.');
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
      toast.success('Equipamento cadastrado com identificação interna.');
    } catch (error) { toast.error((error as Error).message); } finally { setSaving(false); }
  };

  const submitTerm = () => {
    const equipment = wh.equipments.find(candidate => candidate.id === term.equipmentId);
    if (!equipment || !term.workerName.trim() || !term.sigRec) return toast.error('Selecione o equipamento, informe o recebedor e colete sua assinatura.');
    onProjectChange(issueCustodyTerm(project, {
      equipmentId: equipment.id,
      equipmentName: equipment.description || equipment.name,
      equipmentPatrimony: equipment.patrimony,
      equipmentInternalCode: equipment.internalCode,
      equipmentBrand: equipment.brand,
      equipmentModel: equipment.model,
      equipmentSerial: equipment.serial,
      equipmentPhoto: equipment.photos?.[0],
      issuedAt: new Date().toISOString().slice(0, 10),
      dueDate: term.dueDate || undefined,
      workerName: term.workerName.trim(),
      accessories: term.accessories || undefined,
      stateOnDelivery: term.stateOnDelivery || undefined,
      signatureReceiver: term.sigRec,
    }));
    setShowTerm(false);
    setTerm({ equipmentId: '', workerName: '', dueDate: '', accessories: '', stateOnDelivery: '', sigRec: undefined });
    toast.success('Termo emitido e equipamento marcado como Em uso.');
  };

  const submitReturn = async () => {
    if (!returnFor) return;
    try {
      const returnAttachments = await Promise.all(returnPhotos.map(file => makeAttachment(file, project.id, 'foto', 'equipment-returns')));
      onProjectChange(returnCustodyTerm(project, returnFor.id, { ...returnData, returnAttachments }));
      setReturnFor(null);
      setReturnPhotos([]);
      setReturnData({ stateOnReturn: '', divergenceNotes: '', status: 'devolvido' });
      toast.success('Devolução registrada.');
    } catch (error) { toast.error((error as Error).message); }
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

  const openPhoto = async (equipment: Equipment) => {
    if (!equipment.photos?.[0]) return toast.error('Equipamento sem foto registrada.');
    try { await openWarehouseAttachment(equipment.photos[0]); } catch (error) { toast.error(warehouseAttachmentErrorMessage(error)); }
  };

  return (
    <div className="space-y-4">
      <input ref={cameraRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={event => addPhotos(event.target.files)} />
      <input ref={galleryRef} className="hidden" type="file" accept="image/*" multiple onChange={event => addPhotos(event.target.files)} />
      <section className="rounded-md border bg-card p-3">
        <div className="mb-3"><h3 className="font-semibold">Cadastrar equipamento da empresa</h3><p className="text-sm text-muted-foreground">Fotografe o equipamento, a etiqueta e a série. A IA apenas sugere; o operador confirma.</p></div>
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <div className="space-y-2"><div className="grid grid-cols-3 gap-2">{photos.map((photo, index) => <EquipmentPhoto key={`${photo.name}-${index}`} file={photo} onRemove={() => setPhotos(current => current.filter((_, photoIndex) => photoIndex !== index))} />)}</div><div className="grid grid-cols-2 gap-2"><Button variant="outline" className="min-h-11" disabled={photos.length >= 3} onClick={() => cameraRef.current?.click()}><Camera className="mr-2 h-4 w-4" />Câmera</Button><Button variant="outline" className="min-h-11" disabled={photos.length >= 3} onClick={() => galleryRef.current?.click()}><ImagePlus className="mr-2 h-4 w-4" />Galeria</Button></div><Button className="min-h-11 w-full" variant="secondary" disabled={reading || !photos.length} onClick={() => void readEquipment()}>{reading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}Ler etiqueta e equipamento com IA</Button></div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><EquipmentField label="Descrição" value={form.description} confidence={form.confidence?.description} onChange={description => setForm({ ...form, description })} /><EquipmentField label="Marca" value={form.brand} confidence={form.confidence?.brand} onChange={brand => setForm({ ...form, brand })} /><EquipmentField label="Modelo" value={form.model} confidence={form.confidence?.model} onChange={model => setForm({ ...form, model })} /><EquipmentField label="Nº de série" value={form.serial} confidence={form.confidence?.serial} onChange={serial => setForm({ ...form, serial })} /><EquipmentField label="Patrimônio existente" value={form.patrimony} onChange={patrimony => setForm({ ...form, patrimony })} /><EquipmentField label="Categoria" value={form.category} confidence={form.confidence?.category} onChange={category => setForm({ ...form, category })} /><div className="sm:col-span-2 lg:col-span-3"><EquipmentField label="Observações / justificativa se a série estiver ilegível" value={form.notes} onChange={notes => setForm({ ...form, notes })} /></div><Button className="min-h-11 sm:col-span-2 lg:col-span-3" disabled={saving} onClick={() => void submitEquipment()}><Plus className="mr-2 h-4 w-4" />{saving ? 'Salvando...' : 'Confirmar cadastro'}</Button></div>
        </div>
      </section>

      <section className="overflow-hidden rounded-md border bg-card"><div className="flex items-center border-b bg-muted/40 p-3"><div><h3 className="font-semibold">Patrimônio identificado</h3><p className="text-xs text-muted-foreground">Cada equipamento tem código interno, foto e histórico.</p></div><Button className="ml-auto" variant="outline" onClick={() => setShowArchived(value => !value)}>{showArchived ? 'Ocultar arquivados' : 'Exibir arquivados'}</Button></div><div data-testid="equipment-gallery" className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2 lg:grid-cols-3">{equipments.map(equipment => { const title = equipment.description || equipment.name; return <article key={equipment.id} className="min-w-0 overflow-hidden rounded-md border"><button type="button" className="block aspect-video w-full overflow-hidden bg-muted" aria-label={`Abrir foto de ${title}`} onClick={() => void openPhoto(equipment)}><EquipmentThumbnail attachment={equipment.photos?.[0]} alt={title} /></button><div className="space-y-2 p-3"><div className="flex justify-between gap-2"><div className="min-w-0"><div className="text-xs font-bold text-primary">{equipment.internalCode || 'Código legado'}</div><h4 className="break-words font-semibold">{title}</h4></div><span className="h-fit shrink-0 rounded-full bg-muted px-2 py-1 text-xs">{(equipment.status || 'disponivel').replace('_', ' ')}</span></div><div className="break-words text-sm text-muted-foreground">{[equipment.brand, equipment.model, equipment.serial].filter(Boolean).join(' · ') || 'Identificação pendente'}</div><div className="grid grid-cols-2 gap-2"><Button variant="outline" className="min-h-11" onClick={() => void printLabel(equipment)}><Printer className="mr-2 h-4 w-4" />Etiqueta QR</Button>{!equipment.archivedAt && <Button variant="outline" className="min-h-11 text-destructive" onClick={() => confirm({ title: 'Arquivar equipamento?', description: 'O equipamento e seus termos continuarão no histórico.', confirmLabel: 'Arquivar' }, () => onProjectChange(removeEquipment(project, equipment.id, auditActor)))}><Archive className="mr-2 h-4 w-4" />Arquivar</Button>}</div></div></article>; })}{!equipments.length && <div className="col-span-full p-8 text-center text-sm text-muted-foreground">Nenhum equipamento cadastrado.</div>}</div></section>

      <section className="overflow-hidden rounded-md border bg-card"><div className="flex items-center border-b bg-muted/40 p-3"><div><h3 className="font-semibold">Termos de cautela</h3><p className="text-xs text-muted-foreground">Entrega e devolução dos equipamentos da empresa.</p></div><Button className="ml-auto min-h-11" onClick={() => setShowTerm(value => !value)}><Plus className="mr-2 h-4 w-4" />Novo termo</Button></div>{showTerm && <div className="grid gap-3 border-b p-3 md:grid-cols-2"><select aria-label="Equipamento disponível" className="min-h-11 rounded-md border bg-background px-3" value={term.equipmentId} onChange={event => setTerm({ ...term, equipmentId: event.target.value })}><option value="">Escolher equipamento disponível</option>{wh.equipments.filter(equipment => !equipment.archivedAt && (equipment.status ?? 'disponivel') === 'disponivel').map(equipment => <option key={equipment.id} value={equipment.id}>{equipment.internalCode} · {equipment.description || equipment.name}</option>)}</select><Input aria-label="Colaborador que recebeu" className="min-h-11" value={term.workerName} onChange={event => setTerm({ ...term, workerName: event.target.value })} placeholder="Colaborador que recebeu" /><Input aria-label="Data prevista para devolução" className="min-h-11" type="date" value={term.dueDate} onChange={event => setTerm({ ...term, dueDate: event.target.value })} /><Input aria-label="Estado na entrega" className="min-h-11" value={term.stateOnDelivery} onChange={event => setTerm({ ...term, stateOnDelivery: event.target.value })} placeholder="Estado na entrega" /><Input aria-label="Acessórios" className="min-h-11 md:col-span-2" value={term.accessories} onChange={event => setTerm({ ...term, accessories: event.target.value })} placeholder="Acessórios" /><div className="md:col-span-2"><SignaturePad label="Assinatura do recebedor" value={term.sigRec} onChange={sigRec => setTerm({ ...term, sigRec })} /></div><div className="flex justify-end gap-2 md:col-span-2"><Button variant="outline" onClick={() => setShowTerm(false)}>Cancelar</Button><Button onClick={submitTerm}>Emitir termo</Button></div></div>}
        <div className="space-y-2 p-3 md:hidden">{wh.custodyTerms.slice().reverse().map(custody => <article key={custody.id} className="space-y-2 rounded-md border p-3"><div className="flex items-start justify-between gap-2"><div><div className="font-mono text-xs text-primary">{custody.number}</div><div className="font-semibold">{custody.equipmentInternalCode || ''} {custody.equipmentName}</div></div><span className="rounded-full bg-muted px-2 py-1 text-xs">{custody.status.replace('_', ' ')}</span></div><div className="text-sm text-muted-foreground">Recebedor: {custody.workerName}</div><div className="grid grid-cols-2 gap-2"><Button className="min-h-11" variant="outline" onClick={() => generateCustodyTermPdf(project, custody)}><FileDown className="mr-1 h-4 w-4" />PDF</Button>{custody.status === 'em_uso' && <Button className="min-h-11" variant="outline" onClick={() => setReturnFor(custody)}><Undo2 className="mr-1 h-4 w-4" />Devolver</Button>}</div></article>)}{!wh.custodyTerms.length && <div className="p-5 text-center text-sm text-muted-foreground">Nenhum termo emitido.</div>}</div>
        <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[760px] text-sm"><thead className="bg-muted"><tr><th className="p-2 text-left">Nº</th><th className="p-2 text-left">Equipamento</th><th className="p-2 text-left">Recebedor</th><th className="p-2 text-left">Status</th><th className="p-2 text-right">Ações</th></tr></thead><tbody>{wh.custodyTerms.slice().reverse().map(custody => <tr key={custody.id} className="border-t"><td className="p-2 font-mono">{custody.number}</td><td className="p-2">{custody.equipmentInternalCode || ''} {custody.equipmentName}</td><td className="p-2">{custody.workerName}</td><td className="p-2">{custody.status}</td><td className="p-2"><div className="flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => generateCustodyTermPdf(project, custody)}><FileDown className="mr-1 h-4 w-4" />PDF</Button>{custody.status === 'em_uso' && <Button size="sm" variant="outline" onClick={() => setReturnFor(custody)}><Undo2 className="mr-1 h-4 w-4" />Devolver</Button>}</div></td></tr>)}{!wh.custodyTerms.length && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">Nenhum termo emitido.</td></tr>}</tbody></table></div>
      </section>

      {returnFor && <section className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><div className="w-full max-w-xl space-y-3 rounded-lg bg-background p-4"><h3 className="font-semibold">Devolução · {returnFor.number}</h3><Input className="min-h-11" value={returnData.stateOnReturn} onChange={event => setReturnData({ ...returnData, stateOnReturn: event.target.value })} placeholder="Estado na devolução" /><select className="min-h-11 w-full rounded-md border bg-background px-3" value={returnData.status} onChange={event => setReturnData({ ...returnData, status: event.target.value as CustodyTermStatus })}><option value="devolvido">Devolvido OK</option><option value="divergencia">Com divergência</option><option value="danificado">Danificado</option><option value="perdido">Perdido</option></select>{returnData.status !== 'devolvido' && <Input className="min-h-11" value={returnData.divergenceNotes} onChange={event => setReturnData({ ...returnData, divergenceNotes: event.target.value })} placeholder="Descreva a divergência" />}<div><label className="mb-1 block text-xs font-semibold">Foto na devolução</label><Input type="file" accept="image/*" capture="environment" onChange={event => setReturnPhotos(Array.from(event.target.files ?? []).slice(0, 3))} /></div><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setReturnFor(null)}>Cancelar</Button><Button onClick={() => void submitReturn()}>Confirmar devolução</Button></div></div></section>}
      {confirmDialog}
    </div>
  );
}

function EquipmentField({ label, value, confidence, onChange }: { label: string; value: string; confidence?: number; onChange: (value: string) => void }) {
  return <div><label className="mb-1 flex items-center justify-between text-xs font-semibold"><span>{label}</span>{confidence != null && <span className={confidence < 0.6 ? 'text-warning' : 'text-success'}>IA {Math.round(confidence * 100)}%</span>}</label><Input aria-label={label} className="min-h-11" value={value} onChange={event => onChange(event.target.value)} /></div>;
}

function EquipmentThumbnail({ attachment, alt }: { attachment?: WarehouseAttachment; alt: string }) {
  const [source, setSource] = useState(attachment?.dataUrl);
  const [status, setStatus] = useState<'empty' | 'loading' | 'ready' | 'error'>(
    attachment?.dataUrl ? 'ready' : attachment ? 'loading' : 'empty',
  );

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    if (!attachment) {
      setSource(undefined);
      setStatus('empty');
      return () => { active = false; };
    }
    if (attachment.dataUrl) {
      setSource(attachment.dataUrl);
      setStatus('ready');
      return () => { active = false; };
    }
    setSource(undefined);
    setStatus('loading');
    void loadWarehouseAttachmentBlob(attachment)
      .then(blob => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
        setStatus('ready');
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment]);

  if (status === 'ready' && source) return <img src={source} alt={alt} className="h-full w-full object-cover" loading="lazy" decoding="async" />;
  if (status === 'loading') return <span className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Carregando foto</span>;
  return <span className="flex h-full items-center justify-center px-3 text-center text-sm text-muted-foreground">{status === 'error' ? 'Foto indisponível' : 'Equipamento sem foto'}</span>;
}

function EquipmentPhoto({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  return <div className="relative aspect-square overflow-hidden rounded-md border"><img src={url} alt={file.name} className="h-full w-full object-cover" onLoad={() => URL.revokeObjectURL(url)} /><Button size="icon" variant="destructive" className="absolute right-1 top-1 h-8 w-8" onClick={onRemove} aria-label={`Remover ${file.name}`}><X className="h-4 w-4" /></Button></div>;
}
