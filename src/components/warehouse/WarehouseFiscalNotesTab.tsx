import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Project,
  WarehouseAttachment,
  WarehouseFiscalDocumentType,
  WarehouseFiscalNote,
  WarehouseFiscalNoteItem,
} from '@/types/project';
import {
  approveFiscalNote,
  cancelFiscalNote,
  checkFiscalNoteCancellation,
  classifyFiscalDocumentText,
  findFiscalNoteDuplicate,
  fiscalItemGlobalTotal,
  fiscalItemGlobalUnitPrice,
  fiscalNoteViewGroup,
  makeAttachment,
  nowWarehouseISO,
  readFileAsDataURL,
  reconcileFiscalNoteDrafts,
  suggestFiscalNoteItemLinks,
  uidWarehouse,
  updateFiscalItemPurchaseGroup,
  upsertFiscalNote,
} from '@/lib/warehouse';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertTriangle,
  Ban,
  Camera,
  Eye,
  FileText,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

interface Props {
  project: Project;
  onProjectChange: (next: Project) => void;
  canManage?: boolean;
  actorName?: string;
}

type ViewGroup = 'posted' | 'archived';
type ParsedNote = Partial<Pick<WarehouseFiscalNote,
  'supplierName' | 'supplierCnpj' | 'invoiceNumber' | 'issueDate' | 'totalAmount' | 'notes' |
  'items' | 'invoices' | 'aiConfidence' | 'documentType' | 'documentTypeConfidence'>>;

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_IMAGES = 4;
const ACCEPTED = ['pdf', 'png', 'jpg', 'jpeg', 'webp'];

function money(value?: number) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function normalizeCnpj(value?: string) {
  const digits = (value ?? '').replace(/\D/g, '');
  if (digits.length !== 14) return value ?? '';
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function validItems(note: Pick<WarehouseFiscalNote, 'items'>) {
  return note.items.filter(item => item.description.trim() && Number(item.quantity || 0) > 0);
}

function validateFiles(files: File[]) {
  if (!files.length) throw new Error('Escolha ao menos um arquivo.');
  const pdfs = files.filter(file => file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf');
  if (pdfs.length && files.length > 1) throw new Error('Envie um PDF por vez ou até quatro fotos.');
  if (!pdfs.length && files.length > MAX_IMAGES) throw new Error('Envie no máximo quatro fotos.');
  files.forEach(file => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ACCEPTED.includes(ext)) throw new Error('Envie PDF, PNG, JPG, JPEG ou WEBP.');
    if (file.size > MAX_FILE_SIZE) throw new Error(`${file.name}: o limite é 10 MB.`);
  });
}

function newItem(): WarehouseFiscalNoteItem {
  return { id: uidWarehouse(), description: '', quantity: 1, unit: 'UN', unitPrice: 0, totalPrice: 0 };
}

async function extractPdf(file: File) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const text: string[] = [];
  const images: string[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    text.push(content.items.map(item => ('str' in item ? String(item.str) : '')).join(' '));
    if (number <= MAX_IMAGES) {
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (context) {
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvas, canvasContext: context, viewport } as Parameters<typeof page.render>[0]).promise;
        images.push(canvas.toDataURL('image/jpeg', 0.82));
      }
    }
  }
  return { text: text.join('\n'), images };
}

async function readWithAi(input: { name: string; type?: string; urls: string[]; text?: string }): Promise<ParsedNote> {
  const { data, error } = await supabase.functions.invoke<{
    ok?: boolean;
    error?: string;
    note?: ParsedNote & { confidence?: number };
  }>('read-fiscal-note', {
    body: { fileName: input.name, fileType: input.type, fileDataUrl: input.urls[0], fileDataUrls: input.urls, extractedText: input.text },
  });
  if (error) throw new Error(error.message || 'Falha ao executar a leitura automática.');
  if (!data?.ok || !data.note) throw new Error(data?.error || 'Não foi possível ler o documento.');
  return {
    ...data.note,
    supplierCnpj: normalizeCnpj(data.note.supplierCnpj),
    totalAmount: Number(data.note.totalAmount || 0),
    aiConfidence: data.note.confidence == null ? undefined : Number(data.note.confidence),
    documentTypeConfidence: data.note.documentTypeConfidence == null ? undefined : Number(data.note.documentTypeConfidence),
    items: (data.note.items ?? []).map(item => ({
      ...newItem(), ...item, id: item.id || uidWarehouse(),
      quantity: Number(item.quantity || 0),
      unit: item.unit?.trim() || 'UN',
      unitPrice: Number(item.unitPrice || 0),
      totalPrice: Number(item.totalPrice || (Number(item.quantity || 0) * Number(item.unitPrice || 0))),
    })).filter(item => item.description?.trim()),
  };
}

async function attachmentFile(attachment: WarehouseAttachment): Promise<File> {
  let blob: Blob;
  if (attachment.dataUrl) {
    blob = await (await fetch(attachment.dataUrl)).blob();
  } else if (attachment.storagePath) {
    const { data, error } = await supabase.storage.from('daily-report-photos').download(attachment.storagePath);
    if (error || !data) throw new Error(`Não foi possível abrir ${attachment.name}.`);
    blob = data;
  } else {
    throw new Error(`Anexo ${attachment.name} indisponível.`);
  }
  return new File([blob], attachment.name, { type: attachment.mimeType || blob.type });
}

export default function WarehouseFiscalNotesTab({ project, onProjectChange, canManage = true, actorName }: Props) {
  const [group, setGroup] = useState<ViewGroup>('posted');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<WarehouseFiscalNote | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const notes = useMemo(() => project.warehouse?.fiscalNotes ?? [], [project.warehouse?.fiscalNotes]);
  const purchaseGroups = useMemo(() => (project.materialComparisons ?? [])
    .map(comparison => ({ id: comparison.id, name: comparison.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')), [project.materialComparisons]);

  const counts = useMemo(() => ({
    posted: notes.filter(note => fiscalNoteViewGroup(note) === 'posted').length,
    archived: notes.filter(note => fiscalNoteViewGroup(note) === 'archived').length,
  }), [notes]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return notes.filter(note => fiscalNoteViewGroup(note) === group).filter(note => !q ||
      [note.supplierName, note.supplierCnpj, note.invoiceNumber].some(value => value?.toLowerCase().includes(q)));
  }, [group, notes, search]);
  const duplicate = selected?.status === 'a_conferir' ? findFiscalNoteDuplicate(project, selected) : undefined;
  const isDraft = selected?.status === 'a_conferir' || selected?.status === 'em_processamento';
  const isPosted = selected?.status === 'aprovada';
  const isArchived = selected?.status === 'rejeitada' || selected?.status === 'cancelada';
  const cancelCheck = isPosted && selected ? checkFiscalNoteCancellation(project, selected.id) : null;

  useEffect(() => {
    if (!canManage || processing || selected) return;
    const reconciliation = reconcileFiscalNoteDrafts(project, actorName);
    if (reconciliation.postedIds.length) {
      onProjectChange(reconciliation.project);
      setGroup('posted');
      toast.success(`${reconciliation.postedIds.length} documento(s) pendente(s) lançado(s) automaticamente.`);
      return;
    }
    const unresolvedId = reconciliation.incompleteIds[0] ?? reconciliation.duplicateIds[0];
    if (!unresolvedId) return;
    const draft = reconciliation.project.warehouse?.fiscalNotes.find(note => note.id === unresolvedId);
    if (draft) setSelected(draft);
  }, [actorName, canManage, notes, onProjectChange, processing, project, selected]);

  const chooseFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    try {
      const next = [...files, ...Array.from(incoming)];
      validateFiles(next);
      setFiles(next);
      setUploadOpen(true);
    } catch (error) {
      toast.error((error as Error).message);
    }
    if (cameraRef.current) cameraRef.current.value = '';
    if (fileRef.current) fileRef.current.value = '';
  };

  const finishDraft = (baseProject: Project, note: WarehouseFiscalNote, allowDuplicate = false) => {
    const saved = upsertFiscalNote(baseProject, note);
    const existing = findFiscalNoteDuplicate(saved, note);
    if (existing && !allowDuplicate) {
      onProjectChange(saved);
      setSelected(note);
      return false;
    }
    const posted = approveFiscalNote(saved, note.id, actorName);
    onProjectChange(posted);
    setSelected(null);
    setGroup('posted');
    toast.success('Documento lançado automaticamente no estoque.');
    return true;
  };

  const processFiles = async () => {
    const selectedFiles = [...files];
    try {
      validateFiles(selectedFiles);
      setProcessing(true);
      const createdAt = nowWarehouseISO();
      const attachments = await Promise.all(selectedFiles.map(file => makeAttachment(file, project.id, 'nf')));
      const draft: WarehouseFiscalNote = {
        id: uidWarehouse(), createdAt, updatedAt: createdAt, status: 'a_conferir', origin: 'upload',
        sourceFileName: selectedFiles.length === 1 ? selectedFiles[0].name : `${selectedFiles[0].name} + ${selectedFiles.length - 1} foto(s)`,
        sourceMimeType: selectedFiles[0].type, attachment: attachments[0], attachments,
        totalAmount: 0, items: [], extractionStatus: 'reading', extractionStartedAt: createdAt,
        documentType: 'outro', documentTypeConfidence: 0,
      };
      let nextProject = upsertFiscalNote(project, draft);
      onProjectChange(nextProject);
      setUploadOpen(false);
      setFiles([]);

      let urls: string[] = [];
      let extractedText = '';
      if (selectedFiles[0].type === 'application/pdf' || selectedFiles[0].name.toLowerCase().endsWith('.pdf')) {
        const extracted = await extractPdf(selectedFiles[0]);
        urls = extracted.images;
        extractedText = extracted.text;
      } else {
        urls = await Promise.all(selectedFiles.map(readFileAsDataURL));
      }

      let parsed: ParsedNote = { totalAmount: 0, items: [] };
      let processingError: string | undefined;
      try {
        parsed = await readWithAi({ name: draft.sourceFileName, type: draft.sourceMimeType, urls, text: extractedText });
      } catch (error) {
        processingError = (error as Error).message;
      }
      const deterministicType = classifyFiscalDocumentText(`${extractedText}\n${draft.sourceFileName}`);
      const completedAt = nowWarehouseISO();
      const finalNote: WarehouseFiscalNote = {
        ...draft, ...parsed,
        supplierCnpj: normalizeCnpj(parsed.supplierCnpj),
        items: suggestFiscalNoteItemLinks(nextProject, parsed.items ?? [], parsed.supplierCnpj),
        extractedText,
        documentType: deterministicType !== 'outro' ? deterministicType : (parsed.documentType || 'outro'),
        documentTypeConfidence: deterministicType !== 'outro' ? 1 : Number(parsed.documentTypeConfidence || 0),
        extractionStatus: processingError ? 'failed' : 'ready', processingError,
        extractionCompletedAt: completedAt, updatedAt: completedAt,
      };
      nextProject = upsertFiscalNote(nextProject, finalNote);
      if (!validItems(finalNote).length) {
        onProjectChange(nextProject);
        setSelected(finalNote);
        toast.warning('A leitura não encontrou itens. Inclua ao menos um item para concluir o lançamento.');
        return;
      }
      finishDraft(nextProject, finalNote);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setProcessing(false);
    }
  };

  const retryExtraction = async () => {
    if (!selected || !isDraft) return;
    const attachments = selected.attachments?.length ? selected.attachments : (selected.attachment ? [selected.attachment] : []);
    if (!attachments.length) return toast.error('Nenhum anexo disponível para repetir a leitura.');
    try {
      setProcessing(true);
      const localFiles = await Promise.all(attachments.map(attachmentFile));
      let urls: string[] = [];
      let extractedText = '';
      if (localFiles[0].type === 'application/pdf' || localFiles[0].name.toLowerCase().endsWith('.pdf')) {
        const extracted = await extractPdf(localFiles[0]);
        urls = extracted.images;
        extractedText = extracted.text;
      } else {
        urls = await Promise.all(localFiles.map(readFileAsDataURL));
      }
      const parsed = await readWithAi({ name: selected.sourceFileName, type: selected.sourceMimeType, urls, text: extractedText });
      const deterministicType = classifyFiscalDocumentText(`${extractedText}\n${selected.sourceFileName}`);
      const updated: WarehouseFiscalNote = {
        ...selected, ...parsed,
        items: suggestFiscalNoteItemLinks(project, parsed.items ?? [], parsed.supplierCnpj),
        extractedText,
        documentType: deterministicType !== 'outro' ? deterministicType : (parsed.documentType || 'outro'),
        documentTypeConfidence: deterministicType !== 'outro' ? 1 : Number(parsed.documentTypeConfidence || 0),
        extractionStatus: 'ready', processingError: undefined, extractionCompletedAt: nowWarehouseISO(),
      };
      if (validItems(updated).length) finishDraft(project, updated);
      else {
        onProjectChange(upsertFiscalNote(project, updated));
        setSelected(updated);
        toast.warning('A leitura ainda não encontrou itens. Preencha um item manualmente.');
      }
    } catch (error) {
      const failed = { ...selected, extractionStatus: 'failed' as const, processingError: (error as Error).message };
      onProjectChange(upsertFiscalNote(project, failed));
      setSelected(failed);
      toast.error('A leitura falhou novamente. Preencha o item manualmente.');
    } finally {
      setProcessing(false);
    }
  };

  const postSelectedDraft = (allowDuplicate = false) => {
    if (!selected || !isDraft) return;
    if (!validItems(selected).length) return toast.error('Inclua ao menos um item com descrição e quantidade maior que zero.');
    const normalized: WarehouseFiscalNote = {
      ...selected,
      items: selected.items.map(item => ({
        ...item,
        unit: item.unit?.trim() || 'UN',
        quantity: Number(item.quantity || 0),
        unitPrice: Number(item.unitPrice || 0),
        totalPrice: Number(item.quantity || 0) * Number(item.unitPrice || 0),
      })),
    };
    try {
      finishDraft(project, normalized, allowDuplicate);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const updateItem = (index: number, patch: Partial<WarehouseFiscalNoteItem>) => {
    if (!selected || !isDraft) return;
    const items = selected.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
    setSelected({ ...selected, items });
  };

  const updatePurchaseGroup = (note: WarehouseFiscalNote, item: WarehouseFiscalNoteItem, value: string) => {
    if (!canManage || isArchived) return;
    if (isDraft) {
      const itemIndex = selected?.items.findIndex(entry => entry.id === item.id) ?? -1;
      if (itemIndex >= 0) updateItem(itemIndex, { purchaseGroupId: value === '__none__' ? undefined : value });
      return;
    }
    try {
      const next = updateFiscalItemPurchaseGroup(project, note.id, item.id, value === '__none__' ? undefined : value);
      onProjectChange(next);
      setSelected(next.warehouse?.fiscalNotes.find(entry => entry.id === note.id) ?? note);
      toast.success('Grupo de compra atualizado sem alterar o estoque.');
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const confirmCancel = () => {
    if (!selected) return;
    const result = cancelFiscalNote(project, selected.id, { reason: cancelReason, actor: actorName });
    if (!result.canceled) return toast.error(result.blockers.join(' '));
    onProjectChange(result.project);
    setCancelOpen(false);
    setCancelReason('');
    setSelected(null);
    setGroup('archived');
    toast.success('Lançamento cancelado definitivamente.');
  };

  const openOriginalDocument = async (note: WarehouseFiscalNote, attachmentIndex = 0) => {
    const attachments = note.attachments?.length ? note.attachments : (note.attachment ? [note.attachment] : []);
    const attachment = attachments[attachmentIndex];
    if (!attachment) return toast.error('O documento original não está disponível.');
    if (attachment.dataUrl) {
      window.open(attachment.dataUrl, '_blank', 'noopener');
      return;
    }
    if (!attachment.storagePath) return toast.error('O documento original não está disponível.');
    const { data, error } = await supabase.storage.from('daily-report-photos').createSignedUrl(attachment.storagePath, 300);
    if (error || !data?.signedUrl) return toast.error('Não foi possível abrir o documento original.');
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  const requestCloseSelected = () => {
    if (isDraft) {
      toast.error('Conclua o lançamento informando ao menos um item. O rascunho continuará preservado.');
      return;
    }
    setSelected(null);
  };

  return (
    <div className="space-y-3">
      <input ref={cameraRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={event => chooseFiles(event.target.files)} />
      <input ref={fileRef} className="hidden" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" multiple onChange={event => chooseFiles(event.target.files)} />

      <div className="rounded-lg border bg-card p-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="min-h-11 pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar por fornecedor, CNPJ ou número" />
          </div>
          {canManage && <div className="grid grid-cols-2 gap-2 md:flex">
            <Button className="min-h-11 md:hidden" variant="outline" onClick={() => cameraRef.current?.click()}><Camera className="mr-2 h-4 w-4" />Tirar fotos</Button>
            <Button className="min-h-11" onClick={() => fileRef.current?.click()} disabled={processing}><Upload className="mr-2 h-4 w-4" />Escolher arquivo/PDF</Button>
          </div>}
        </div>
        {!canManage && <p className="mt-2 text-sm text-muted-foreground">Seu perfil possui acesso somente para consulta.</p>}
        {processing && <div className="mt-3 flex items-center rounded-md border border-primary/30 bg-primary/5 p-3 text-sm"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Lendo o documento e preparando a entrada automática no estoque.</div>}
      </div>

      <Tabs value={group} onValueChange={value => setGroup(value as ViewGroup)}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto p-1">
          <TabsTrigger value="posted" className="min-h-10 whitespace-nowrap">Lançadas no estoque ({counts.posted})</TabsTrigger>
          <TabsTrigger value="archived" className="min-h-10 whitespace-nowrap">Arquivadas ({counts.archived})</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="space-y-2 md:hidden">
        {visible.map((note, index) => <NoteCard key={note.id} note={note} sequence={visible.length - index} onOpen={() => setSelected(note)} onOpenAttachment={() => void openOriginalDocument(note)} />)}
      </div>
      <div className="hidden overflow-hidden rounded-lg border bg-card md:block">
        <table className="w-full text-xs">
          <thead className="bg-muted text-muted-foreground"><tr><th className="p-2 text-left">Fornecedor</th><th className="w-14 p-2 text-center">Nº</th><th className="p-2 text-left">CNPJ</th><th className="p-2 text-left">Nota</th><th className="p-2 text-left">Data</th><th className="p-2 text-center">Itens</th><th className="p-2 text-right">Valor</th><th className="p-2 text-left">Status</th><th className="p-2 text-center">Ações</th></tr></thead>
          <tbody>{visible.map((note, index) => <tr key={note.id} className="border-t hover:bg-muted/30"><td className="p-2 font-medium">{note.supplierName || '—'}</td><td className="p-2 text-center font-mono font-semibold text-primary">{visible.length - index}</td><td className="p-2 font-mono text-muted-foreground">{note.supplierCnpj || '—'}</td><td className="p-2">{note.invoiceNumber || '—'}</td><td className="p-2">{note.issueDate ? note.issueDate.split('-').reverse().join('/') : '—'}</td><td className="p-2 text-center tabular-nums">{note.items.length}</td><td className="p-2 text-right font-semibold">{money(note.totalAmount)}</td><td className="p-2"><StatusBadge note={note} /></td><td className="p-2"><div className="flex items-center justify-center gap-1"><Button size="icon" variant="ghost" className="h-8 w-8" title="Abrir documento original" aria-label="Abrir documento original" onClick={() => void openOriginalDocument(note)}><Eye className="h-4 w-4" /></Button><Button size="icon" variant="ghost" className="h-8 w-8" title="Visualizar dados e grupos" aria-label="Visualizar dados e grupos" onClick={() => setSelected(note)}><Pencil className="h-4 w-4" /></Button>{canManage && note.status === 'aprovada' && <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" title="Cancelar lançamento" aria-label="Cancelar lançamento" onClick={() => { setSelected(note); setCancelOpen(true); }}><Ban className="h-4 w-4" /></Button>}</div></td></tr>)}</tbody>
        </table>
      </div>
      {!visible.length && <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground"><FileText className="mx-auto mb-3 h-8 w-8" />Nenhum documento nesta área.</div>}

      <Dialog open={uploadOpen} onOpenChange={open => !processing && setUploadOpen(open)}>
        <DialogContent className="max-w-xl"><DialogHeader><DialogTitle>Enviar documento</DialogTitle><DialogDescription>Envie um PDF ou até quatro fotos. Se a leitura encontrar itens, a entrada será lançada automaticamente.</DialogDescription></DialogHeader>
          <div className="space-y-2">{files.map((file, index) => <div key={`${file.name}-${index}`} className="flex min-h-16 items-center gap-3 rounded-md border p-2"><FilePreview file={file} /><span className="min-w-0 flex-1 truncate text-sm">{index + 1}. {file.name}</span><div className="flex gap-1"><Button size="icon" variant="ghost" disabled={index === 0} onClick={() => setFiles(list => list.map((entry, i) => i === index - 1 ? file : i === index ? list[index - 1] : entry))} aria-label="Mover para cima">↑</Button><Button size="icon" variant="ghost" onClick={() => setFiles(list => list.filter((_, i) => i !== index))} aria-label="Remover foto"><X className="h-4 w-4" /></Button></div></div>)}</div>
          {!files.some(file => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) && files.length < MAX_IMAGES && <div className="grid grid-cols-2 gap-2"><Button variant="outline" className="min-h-11" onClick={() => cameraRef.current?.click()}><Camera className="mr-2 h-4 w-4" />Nova captura</Button><Button variant="outline" className="min-h-11" onClick={() => fileRef.current?.click()}><Plus className="mr-2 h-4 w-4" />Adicionar foto</Button></div>}
          <DialogFooter><Button variant="outline" onClick={() => { setUploadOpen(false); setFiles([]); }}>Cancelar</Button><Button onClick={processFiles} disabled={!files.length || processing}>{processing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}Enviar e lançar</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selected} onOpenChange={open => !open && requestCloseSelected()}>
        <DialogContent className="flex max-h-[95dvh] max-w-7xl flex-col overflow-hidden p-0">
          {selected && <>
            <DialogHeader className="border-b p-4 pr-12"><div className="flex flex-wrap items-center gap-2"><DialogTitle>{isDraft ? 'Concluir lançamento' : 'Dados do lançamento'}</DialogTitle><StatusBadge note={selected} />{selected.extractionStatus === 'failed' && <Badge variant="destructive">Leitura incompleta</Badge>}</div><DialogDescription>{selected.attachments?.length || (selected.attachment ? 1 : 0)} documento(s) original(is) preservado(s) para auditoria</DialogDescription></DialogHeader>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-24">
              {duplicate && <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"><AlertTriangle className="mr-2 inline h-4 w-4" /><strong>Possível duplicidade:</strong> já existe o lançamento {duplicate.invoiceNumber || duplicate.id} de {duplicate.supplierName || 'fornecedor não identificado'}. O novo saldo somente será criado após confirmação explícita.</div>}
              {selected.processingError && <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"><AlertTriangle className="mr-2 inline h-4 w-4" />{selected.processingError} {isDraft && <Button className="ml-2" size="sm" variant="outline" disabled={processing} onClick={retryExtraction}>{processing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}Tentar leitura novamente</Button>}</div>}
              {(selected.attachments?.length || selected.attachment) && <div className="flex flex-wrap items-center gap-2 rounded-md border p-3"><span className="mr-auto text-sm font-medium">Documento original</span>{(selected.attachments?.length ? selected.attachments : selected.attachment ? [selected.attachment] : []).map((attachment, index) => <Button key={attachment.id} type="button" variant="outline" className="min-h-11" onClick={() => void openOriginalDocument(selected, index)}><Eye className="mr-2 h-4 w-4" />{index === 0 && (selected.attachments?.length || 0) <= 1 ? 'Visualizar documento' : `Visualizar anexo ${index + 1}`}</Button>)}</div>}

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <Field label="Fornecedor" value={selected.supplierName} readOnly={!isDraft} onChange={value => setSelected({ ...selected, supplierName: value })} />
                <Field label="CNPJ" value={selected.supplierCnpj} readOnly={!isDraft} onChange={value => setSelected({ ...selected, supplierCnpj: normalizeCnpj(value) })} />
                <Field label="Número da nota" value={selected.invoiceNumber} readOnly={!isDraft} onChange={value => setSelected({ ...selected, invoiceNumber: value })} />
                <Field label="Data de emissão" type="date" value={selected.issueDate} readOnly={!isDraft} onChange={value => setSelected({ ...selected, issueDate: value })} />
                <Field label="Valor total" type="number" value={String(selected.totalAmount || '')} readOnly={!isDraft} onChange={value => setSelected({ ...selected, totalAmount: Number(value) })} />
              </div>

              <section>
                <div className="mb-2 flex items-center justify-between"><h3 className="font-semibold">Itens do documento ({selected.items.length})</h3>{isDraft && <Button size="sm" variant="outline" onClick={() => setSelected({ ...selected, items: [...selected.items, newItem()] })}><Plus className="mr-1 h-4 w-4" />Adicionar item</Button>}</div>
                <div className="hidden overflow-x-auto rounded-md border md:block">
                  <table className="w-full table-fixed text-xs">
                    <colgroup><col className="w-28" /><col /><col className="w-20" /><col className="w-20" /><col className="w-32" /><col className="w-32" /><col className="w-32" /><col className="w-56" />{isDraft && <col className="w-12" />}</colgroup>
                    <thead className="bg-muted text-muted-foreground"><tr><th className="h-11 p-2 text-left align-middle">Cód. prod.</th><th className="h-11 p-2 text-left align-middle">Descrição</th><th className="h-11 p-2 text-center align-middle">Qtd</th><th className="h-11 p-2 text-center align-middle">Un</th><th className="h-11 p-2 text-center align-middle">V. unit. NF</th><th className="h-11 p-2 text-center align-middle">V. unit. global</th><th className="h-11 p-2 text-center align-middle">V. total</th><th className="h-11 p-2 text-left align-middle">Grupo de compra</th>{isDraft && <th className="h-11 p-2" />}</tr></thead>
                    <tbody>{selected.items.map((item, index) => <ItemTableRow key={item.id} note={selected} item={item} index={index} editable={!!isDraft} groupEditable={canManage && !isArchived} purchaseGroups={purchaseGroups} onUpdate={updateItem} onGroupChange={value => updatePurchaseGroup(selected, item, value)} onRemove={() => setSelected({ ...selected, items: selected.items.filter((_, itemIndex) => itemIndex !== index) })} />)}</tbody>
                  </table>
                </div>
                <div className="space-y-3 md:hidden">{selected.items.map((item, index) => <ItemMobileCard key={item.id} note={selected} item={item} index={index} editable={!!isDraft} groupEditable={canManage && !isArchived} purchaseGroups={purchaseGroups} onUpdate={updateItem} onGroupChange={value => updatePurchaseGroup(selected, item, value)} onRemove={() => setSelected({ ...selected, items: selected.items.filter((_, itemIndex) => itemIndex !== index) })} />)}</div>
                {!selected.items.length && <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">Nenhum item identificado. Adicione um item para concluir o lançamento.</div>}
              </section>

              <details className="rounded-md border p-3"><summary className="cursor-pointer font-medium">Mais detalhes</summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><Field label="Frete" type="number" value={String(selected.freightAmount || '')} readOnly={!isDraft} onChange={value => setSelected({ ...selected, freightAmount: Number(value) })} /><Field label="ICMS adicional" type="number" value={String(selected.icmsAmount || '')} readOnly={!isDraft} onChange={value => setSelected({ ...selected, icmsAmount: Number(value) })} /><div className="sm:col-span-2"><label className="mb-1 block text-sm font-medium">Observações</label><Textarea value={selected.notes || ''} readOnly={!isDraft} onChange={event => setSelected({ ...selected, notes: event.target.value })} /></div><div className="text-sm text-muted-foreground sm:col-span-2">Faturas: {selected.invoices?.length || 0}. Total adicional: {money(Number(selected.freightAmount || 0) + Number(selected.icmsAmount || 0))}.</div></div></details>
              {selected.status === 'cancelada' && <div className="rounded-md border p-3 text-sm"><strong>Cancelamento definitivo</strong><br /><strong>Responsável:</strong> {selected.canceledBy || '—'}<br /><strong>Motivo:</strong> {selected.cancellationReason}</div>}
            </div>
            <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t bg-background p-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)]">
              {!isDraft && <Button variant="outline" onClick={() => setSelected(null)}>Fechar</Button>}
              {isDraft && <Button onClick={() => postSelectedDraft(!!duplicate)} disabled={!validItems(selected).length}>{duplicate ? 'Confirmar lançamento duplicado' : 'Concluir lançamento no estoque'}</Button>}
              {canManage && isPosted && <Button variant="destructive" onClick={() => setCancelOpen(true)}>Cancelar lançamento</Button>}
            </div>
          </>}
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}><DialogContent><DialogHeader><DialogTitle>Cancelar lançamento definitivamente</DialogTitle><DialogDescription>A entrada original não será apagada. O sistema criará movimentos de estorno, preservará o documento e impedirá qualquer relançamento deste registro.</DialogDescription></DialogHeader>{cancelCheck && !cancelCheck.allowed && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"><strong>Cancelamento bloqueado:</strong><ul className="mt-2 list-disc pl-5">{cancelCheck.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul></div>}<div><label className="mb-1 block text-sm font-medium">Motivo obrigatório</label><Textarea value={cancelReason} onChange={event => setCancelReason(event.target.value)} placeholder="Explique por que o lançamento deve ser cancelado" /></div><DialogFooter><Button variant="outline" onClick={() => setCancelOpen(false)}>Voltar</Button><Button variant="destructive" disabled={!cancelCheck?.allowed || !cancelReason.trim()} onClick={confirmCancel}>Confirmar estorno definitivo</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}

function Field({ label, value, readOnly, onChange, type = 'text' }: { label: string; value?: string; readOnly: boolean; onChange: (value: string) => void; type?: string }) {
  return <div><label className="mb-1 block text-sm font-medium">{label}</label><Input className="min-h-11" type={type} value={value ?? ''} readOnly={readOnly} onChange={event => onChange(event.target.value)} /></div>;
}

function StatusBadge({ note }: { note: WarehouseFiscalNote }) {
  if (note.status === 'aprovada') return <Badge variant="outline" className="border-success/30 bg-success/15 text-success">Lançada</Badge>;
  if (note.status === 'cancelada') return <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">Cancelada</Badge>;
  if (note.status === 'rejeitada') return <Badge variant="outline">Arquivada</Badge>;
  return <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning">Envio incompleto</Badge>;
}

interface ItemEditorProps {
  note: WarehouseFiscalNote;
  item: WarehouseFiscalNoteItem;
  index: number;
  editable: boolean;
  groupEditable: boolean;
  purchaseGroups: Array<{ id: string; name: string }>;
  onUpdate: (index: number, patch: Partial<WarehouseFiscalNoteItem>) => void;
  onGroupChange: (value: string) => void;
  onRemove: () => void;
}

function ItemTableRow({ note, item, index, editable, groupEditable, purchaseGroups, onUpdate, onGroupChange, onRemove }: ItemEditorProps) {
  return <tr className="border-t"><td className="p-1 align-middle"><Input className="min-h-11 text-center" value={item.productCode || ''} readOnly={!editable} onChange={event => onUpdate(index, { productCode: event.target.value })} /></td><td className="p-1 align-middle"><Input className="min-h-11" value={item.description} readOnly={!editable} onChange={event => onUpdate(index, { description: event.target.value })} /></td><td className="p-1 align-middle"><Input className="min-h-11 text-center" type="number" value={item.quantity} readOnly={!editable} onChange={event => onUpdate(index, { quantity: Number(event.target.value) })} /></td><td className="p-1 align-middle"><Input className="min-h-11 text-center" value={item.unit || 'UN'} readOnly={!editable} onChange={event => onUpdate(index, { unit: event.target.value })} /></td><td className="p-1 align-middle"><Input className="min-h-11 text-center" type="number" value={item.unitPrice} readOnly={!editable} onChange={event => onUpdate(index, { unitPrice: Number(event.target.value) })} /></td><td className="h-11 p-2 text-center align-middle font-mono tabular-nums">{money(fiscalItemGlobalUnitPrice(item, note))}</td><td className="h-11 p-2 text-center align-middle font-mono font-semibold tabular-nums">{money(fiscalItemGlobalTotal(item, note))}</td><td className="p-1 align-middle"><PurchaseGroupSelect value={item.purchaseGroupId} disabled={!groupEditable} groups={purchaseGroups} onChange={onGroupChange} /></td>{editable && <td className="p-1 text-center align-middle"><Button size="icon" variant="ghost" className="min-h-11 text-destructive" onClick={onRemove} aria-label="Remover item"><Trash2 className="h-4 w-4" /></Button></td>}</tr>;
}

function ItemMobileCard({ note, item, index, editable, groupEditable, purchaseGroups, onUpdate, onGroupChange, onRemove }: ItemEditorProps) {
  return <div className="space-y-3 rounded-md border p-3"><div className="grid gap-3 sm:grid-cols-2"><MobileField label="Cód. prod."><Input className="min-h-11 text-center" value={item.productCode || ''} readOnly={!editable} onChange={event => onUpdate(index, { productCode: event.target.value })} /></MobileField><MobileField label="Descrição"><Input className="min-h-11" value={item.description} readOnly={!editable} onChange={event => onUpdate(index, { description: event.target.value })} /></MobileField><MobileField label="Qtd"><Input className="min-h-11 text-center" type="number" value={item.quantity} readOnly={!editable} onChange={event => onUpdate(index, { quantity: Number(event.target.value) })} /></MobileField><MobileField label="Un"><Input className="min-h-11 text-center" value={item.unit || 'UN'} readOnly={!editable} onChange={event => onUpdate(index, { unit: event.target.value })} /></MobileField><MobileValue label="V. unit. NF" value={money(item.unitPrice)} /><MobileValue label="V. unit. global" value={money(fiscalItemGlobalUnitPrice(item, note))} /><MobileValue label="V. total" value={money(fiscalItemGlobalTotal(item, note))} /><MobileField label="Grupo de compra"><PurchaseGroupSelect value={item.purchaseGroupId} disabled={!groupEditable} groups={purchaseGroups} onChange={onGroupChange} /></MobileField></div>{editable && <Button variant="outline" className="min-h-11 w-full text-destructive" onClick={onRemove}><Trash2 className="mr-2 h-4 w-4" />Remover item</Button>}</div>;
}

function PurchaseGroupSelect({ value, disabled, groups, onChange }: { value?: string; disabled: boolean; groups: Array<{ id: string; name: string }>; onChange: (value: string) => void }) {
  return <Select value={value || '__none__'} disabled={disabled} onValueChange={onChange}><SelectTrigger className="min-h-11"><SelectValue placeholder="Sem grupo" /></SelectTrigger><SelectContent><SelectItem value="__none__">Sem grupo</SelectItem>{groups.map(group => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}</SelectContent></Select>;
}

function MobileField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="mb-1 text-xs font-semibold text-muted-foreground">{label}</div>{children}</div>;
}

function MobileValue({ label, value }: { label: string; value: string }) {
  return <div><div className="mb-1 text-xs font-semibold text-muted-foreground">{label}</div><div className="flex min-h-11 items-center justify-center rounded-md border bg-muted/30 px-3 text-center font-mono text-sm tabular-nums">{value}</div></div>;
}

function NoteCard({ note, sequence, onOpen, onOpenAttachment }: { note: WarehouseFiscalNote; sequence: number; onOpen: () => void; onOpenAttachment: () => void }) {
  return <div className="rounded-lg border bg-card p-4"><div className="flex items-start justify-between gap-2"><div><div className="font-semibold">{note.supplierName || 'Fornecedor não identificado'}</div><div className="mt-1 text-sm text-muted-foreground">Nº {sequence} · Nota {note.invoiceNumber || '—'}</div></div><StatusBadge note={note} /></div><dl className="mt-3 grid grid-cols-2 gap-2 text-sm"><div><dt className="text-xs text-muted-foreground">CNPJ</dt><dd>{note.supplierCnpj || '—'}</dd></div><div><dt className="text-xs text-muted-foreground">Data</dt><dd>{note.issueDate ? note.issueDate.split('-').reverse().join('/') : '—'}</dd></div><div><dt className="text-xs text-muted-foreground">Itens</dt><dd>{note.items.length}</dd></div><div><dt className="text-xs text-muted-foreground">Valor</dt><dd className="font-semibold">{money(note.totalAmount)}</dd></div></dl><div className="mt-3 grid grid-cols-[44px_1fr] gap-2"><Button size="icon" variant="outline" className="min-h-11 min-w-11" aria-label="Abrir documento original" onClick={onOpenAttachment}><Eye className="h-4 w-4" /></Button><Button className="min-h-11" variant="outline" onClick={onOpen}>Visualizar dados e grupos</Button></div></div>;
}

function FilePreview({ file }: { file: File }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return src ? <img src={src} alt="Miniatura do anexo" className="h-12 w-12 rounded object-cover" /> : <div className="flex h-12 w-12 items-center justify-center rounded bg-muted"><Paperclip className="h-5 w-5" /></div>;
}
