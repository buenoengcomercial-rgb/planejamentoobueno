import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Project,
  WarehouseFiscalDocumentType,
  WarehouseAttachment,
  WarehouseFiscalNote,
  WarehouseFiscalNoteItem,
} from '@/types/project';
import {
  approveFiscalNote,
  archiveFiscalNote,
  cancelFiscalNote,
  checkFiscalNoteCancellation,
  classifyFiscalDocumentText,
  findFiscalNoteDuplicate,
  fiscalNoteViewGroup,
  isStockFiscalDocument,
  isValidCnpj,
  makeAttachment,
  nowWarehouseISO,
  readFileAsDataURL,
  suggestFiscalNoteItemLinks,
  uidWarehouse,
  upsertFiscalNote,
} from '@/lib/warehouse';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertTriangle,
  Archive,
  Camera,
  CheckCircle2,
  ChevronDown,
  FileText,
  Loader2,
  MoreVertical,
  Paperclip,
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

type ViewGroup = 'review' | 'posted' | 'archived';
type ParsedNote = Partial<Pick<WarehouseFiscalNote,
  'supplierName' | 'supplierCnpj' | 'invoiceNumber' | 'issueDate' | 'totalAmount' | 'notes' |
  'items' | 'invoices' | 'aiConfidence' | 'documentType' | 'documentTypeConfidence'>>;

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_IMAGES = 4;
const ACCEPTED = ['pdf', 'png', 'jpg', 'jpeg', 'webp'];

const GROUP_LABEL: Record<ViewGroup, string> = {
  review: 'Para conferir',
  posted: 'Lançadas no estoque',
  archived: 'Arquivadas',
};

const DOC_LABEL: Record<WarehouseFiscalDocumentType, string> = {
  nfe: 'NF-e',
  nfce: 'NFC-e',
  cupom_fiscal: 'Cupom fiscal',
  pedido_venda: 'Pedido de venda',
  orcamento: 'Orçamento',
  recibo: 'Recibo',
  outro: 'Outro documento',
};

function money(value?: number) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function normalizeCnpj(value?: string) {
  const digits = (value ?? '').replace(/\D/g, '');
  if (digits.length !== 14) return value ?? '';
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
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
      ...newItem(),
      ...item,
      id: item.id || uidWarehouse(),
      quantity: Number(item.quantity || 0),
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

function linkSummary(note: WarehouseFiscalNote) {
  const linked = note.items.filter(item => !!item.itemKey && Number(item.linkConfidence ?? 1) >= 0.85).length;
  const attention = note.items.filter(item => !item.description.trim() || item.quantity <= 0 || (!!item.itemKey && Number(item.linkConfidence ?? 1) < 0.85)).length;
  return { linked, created: note.items.length - linked, attention };
}

export default function WarehouseFiscalNotesTab({ project, onProjectChange, canManage = true, actorName }: Props) {
  const [group, setGroup] = useState<ViewGroup>('review');
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

  const counts = useMemo(() => ({
    review: notes.filter(note => fiscalNoteViewGroup(note) === 'review').length,
    posted: notes.filter(note => fiscalNoteViewGroup(note) === 'posted').length,
    archived: notes.filter(note => fiscalNoteViewGroup(note) === 'archived').length,
  }), [notes]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return notes.filter(note => fiscalNoteViewGroup(note) === group).filter(note => !q ||
      [note.supplierName, note.supplierCnpj, note.invoiceNumber, note.sourceFileName].some(value => value?.toLowerCase().includes(q)));
  }, [group, notes, search]);
  const summary = selected ? linkSummary(selected) : { linked: 0, created: 0, attention: 0 };
  const readOnly = !canManage || selected?.status === 'aprovada' || selected?.status === 'rejeitada' || selected?.status === 'cancelada';
  const cancelCheck = selected?.status === 'aprovada' ? checkFiscalNoteCancellation(project, selected.id) : null;

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

  const processFiles = async () => {
    try {
      validateFiles(files);
      setProcessing(true);
      const createdAt = nowWarehouseISO();
      const attachments = await Promise.all(files.map(file => makeAttachment(file, project.id, 'nf')));
      const draft: WarehouseFiscalNote = {
        id: uidWarehouse(), createdAt, updatedAt: createdAt, status: 'a_conferir', origin: 'upload',
        sourceFileName: files.length === 1 ? files[0].name : `${files[0].name} + ${files.length - 1} foto(s)`,
        sourceMimeType: files[0].type, attachment: attachments[0], attachments,
        totalAmount: 0, items: [], extractionStatus: 'reading', extractionStartedAt: createdAt,
        documentType: 'outro', documentTypeConfidence: 0,
      };
      let nextProject = upsertFiscalNote(project, draft);
      onProjectChange(nextProject);
      setUploadOpen(false);
      setFiles([]);

      let urls: string[] = [];
      let extractedText = '';
      if (files[0].type === 'application/pdf' || files[0].name.toLowerCase().endsWith('.pdf')) {
        const extracted = await extractPdf(files[0]);
        urls = extracted.images;
        extractedText = extracted.text;
      } else {
        urls = await Promise.all(files.map(readFileAsDataURL));
      }

      let parsed: ParsedNote = { totalAmount: 0, items: [] };
      let processingError: string | undefined;
      try {
        parsed = await readWithAi({ name: draft.sourceFileName, type: draft.sourceMimeType, urls, text: extractedText });
      } catch (error) {
        processingError = (error as Error).message;
      }
      const deterministicType = classifyFiscalDocumentText(`${extractedText}\n${draft.sourceFileName}`);
      const documentType = deterministicType !== 'outro' ? deterministicType : (parsed.documentType || 'outro');
      const completedAt = nowWarehouseISO();
      const finalNote: WarehouseFiscalNote = {
        ...draft, ...parsed,
        supplierCnpj: normalizeCnpj(parsed.supplierCnpj),
        items: suggestFiscalNoteItemLinks(nextProject, parsed.items ?? [], parsed.supplierCnpj),
        extractedText, documentType,
        documentTypeConfidence: deterministicType !== 'outro' ? 1 : Number(parsed.documentTypeConfidence || 0),
        extractionStatus: processingError ? 'failed' : 'ready', processingError,
        extractionCompletedAt: completedAt, updatedAt: completedAt,
      };
      nextProject = upsertFiscalNote(nextProject, finalNote);
      onProjectChange(nextProject);
      setGroup('review');
      setSelected(finalNote);
      toast[processingError ? 'warning' : 'success'](processingError ? 'Documento salvo. Preencha ou tente a leitura novamente.' : 'Documento pronto para conferência.');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setProcessing(false);
    }
  };

  const retryExtraction = async () => {
    if (!selected) return;
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
      onProjectChange(upsertFiscalNote(project, updated));
      setSelected(updated);
      toast.success('Leitura concluída. Revise os dados antes de continuar.');
    } catch (error) {
      const failed = { ...selected, extractionStatus: 'failed' as const, processingError: (error as Error).message };
      onProjectChange(upsertFiscalNote(project, failed));
      setSelected(failed);
      toast.error('A leitura falhou novamente. O preenchimento manual continua disponível.');
    } finally {
      setProcessing(false);
    }
  };

  const persist = (note: WarehouseFiscalNote, close = false) => {
    const normalized = { ...note, items: note.items.map(item => ({ ...item, totalPrice: Number(item.quantity || 0) * Number(item.unitPrice || 0) })) };
    onProjectChange(upsertFiscalNote(project, normalized));
    if (close) setSelected(null); else setSelected(normalized);
  };

  const postStock = () => {
    if (!selected) return;
    if (!isStockFiscalDocument(selected.documentType)) return toast.error('Este tipo de documento só pode ser arquivado como comprovante.');
    if (!selected.supplierName?.trim()) return toast.error('Informe o fornecedor.');
    if (!isValidCnpj(selected.supplierCnpj)) return toast.error('Informe um CNPJ válido.');
    if (!selected.invoiceNumber?.trim()) return toast.error('Informe o número da nota.');
    if (!selected.items.length || selected.items.some(item => !item.description.trim() || item.quantity <= 0)) return toast.error('Revise descrição e quantidade dos itens.');
    const duplicate = findFiscalNoteDuplicate(project, selected);
    if (duplicate && duplicate.id !== selected.id) return toast.error(`Possível duplicidade com a nota ${duplicate.invoiceNumber}. Revise antes de lançar.`);
    try {
      const saved = upsertFiscalNote(project, selected);
      onProjectChange(approveFiscalNote(saved, selected.id, actorName));
      setSelected(null);
      setGroup('posted');
      toast.success('Nota lançada no estoque uma única vez.');
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const archive = (reason: 'comprovante' | 'descartada') => {
    if (!selected) return;
    onProjectChange(archiveFiscalNote(upsertFiscalNote(project, selected), selected.id, reason, actorName));
    setSelected(null);
    setGroup('archived');
    toast.success(reason === 'comprovante' ? 'Documento arquivado sem alterar o estoque.' : 'Documento descartado sem criar materiais.');
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
    toast.success('Lançamento cancelado com movimentos de estorno preservados.');
  };

  const updateItem = (index: number, patch: Partial<WarehouseFiscalNoteItem>) => {
    if (!selected) return;
    const items = selected.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
    setSelected({ ...selected, items });
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
        {processing && <div className="mt-3 flex items-center rounded-md border border-primary/30 bg-primary/5 p-3 text-sm"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Salvando anexos e lendo o documento. Você pode acompanhar o rascunho em “Para conferir”.</div>}
      </div>

      <Tabs value={group} onValueChange={value => setGroup(value as ViewGroup)}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto p-1">
          {(Object.keys(GROUP_LABEL) as ViewGroup[]).map(value => <TabsTrigger key={value} value={value} className="min-h-10 whitespace-nowrap">{GROUP_LABEL[value]} ({counts[value]})</TabsTrigger>)}
        </TabsList>
      </Tabs>

      <div className="space-y-2 md:hidden">
        {visible.map(note => <NoteCard key={note.id} note={note} onOpen={() => setSelected(note)} />)}
      </div>
      <div className="hidden overflow-hidden rounded-lg border bg-card md:block">
        <table className="w-full text-sm">
          <thead className="bg-muted/70 text-left text-muted-foreground"><tr><th className="p-3">Documento</th><th className="p-3">Fornecedor</th><th className="p-3">Emissão</th><th className="p-3 text-right">Itens</th><th className="p-3 text-right">Total</th><th className="p-3 text-right">Ação</th></tr></thead>
          <tbody>{visible.map(note => <tr key={note.id} className="border-t"><td className="p-3"><div className="font-medium">{DOC_LABEL[note.documentType || 'outro']} {note.invoiceNumber ? `nº ${note.invoiceNumber}` : ''}</div><div className="text-xs text-muted-foreground">{note.sourceFileName}</div></td><td className="p-3">{note.supplierName || 'Não identificado'}<div className="text-xs text-muted-foreground">{note.supplierCnpj}</div></td><td className="p-3">{note.issueDate ? note.issueDate.split('-').reverse().join('/') : '—'}</td><td className="p-3 text-right">{note.items.length}</td><td className="p-3 text-right font-semibold">{money(note.totalAmount)}</td><td className="p-3 text-right"><Button variant="outline" onClick={() => setSelected(note)}>{fiscalNoteViewGroup(note) === 'review' ? 'Conferir' : 'Visualizar'}</Button></td></tr>)}</tbody>
        </table>
      </div>
      {!visible.length && <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground"><FileText className="mx-auto mb-3 h-8 w-8" />Nenhum documento nesta área.</div>}

      <Dialog open={uploadOpen} onOpenChange={open => !processing && setUploadOpen(open)}>
        <DialogContent className="max-w-xl"><DialogHeader><DialogTitle>Preparar documento</DialogTitle><DialogDescription>Envie um PDF ou até quatro fotos. O rascunho será salvo antes da leitura automática.</DialogDescription></DialogHeader>
          <div className="space-y-2">{files.map((file, index) => <div key={`${file.name}-${index}`} className="flex min-h-16 items-center gap-3 rounded-md border p-2"><FilePreview file={file} /><span className="min-w-0 flex-1 truncate text-sm">{index + 1}. {file.name}</span><div className="flex gap-1"><Button size="icon" variant="ghost" disabled={index === 0} onClick={() => setFiles(list => list.map((entry, i) => i === index - 1 ? file : i === index ? list[index - 1] : entry))} aria-label="Mover para cima">↑</Button><Button size="icon" variant="ghost" onClick={() => setFiles(list => list.filter((_, i) => i !== index))} aria-label="Remover foto"><X className="h-4 w-4" /></Button></div></div>)}</div>
          {!files.some(file => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) && files.length < MAX_IMAGES && <div className="grid grid-cols-2 gap-2"><Button variant="outline" className="min-h-11" onClick={() => cameraRef.current?.click()}><Camera className="mr-2 h-4 w-4" />Nova captura</Button><Button variant="outline" className="min-h-11" onClick={() => fileRef.current?.click()}><Plus className="mr-2 h-4 w-4" />Adicionar foto</Button></div>}
          <DialogFooter><Button variant="outline" onClick={() => { setUploadOpen(false); setFiles([]); }}>Cancelar</Button><Button onClick={processFiles} disabled={!files.length || processing}>{processing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}Salvar e ler</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selected} onOpenChange={open => !open && setSelected(null)}>
        <DialogContent className="flex max-h-[95dvh] max-w-5xl flex-col overflow-hidden p-0">
          {selected && <>
            <DialogHeader className="border-b p-4 pr-12"><div className="flex flex-wrap items-center gap-2"><DialogTitle>{readOnly ? 'Documento' : 'Conferir documento'}</DialogTitle><Badge variant="outline">{DOC_LABEL[selected.documentType || 'outro']}</Badge>{selected.extractionStatus === 'failed' && <Badge variant="destructive">Leitura incompleta</Badge>}</div><DialogDescription>{selected.sourceFileName} · {selected.attachments?.length || (selected.attachment ? 1 : 0)} anexo(s)</DialogDescription></DialogHeader>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-24">
              {selected.processingError && <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"><AlertTriangle className="mr-2 inline h-4 w-4" />{selected.processingError} {canManage && selected.status === 'a_conferir' && <Button className="ml-2" size="sm" variant="outline" disabled={processing} onClick={retryExtraction}>{processing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}Tentar leitura novamente</Button>}</div>}
              {!isStockFiscalDocument(selected.documentType) && <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm"><Archive className="mr-2 inline h-4 w-4" />Documento não fiscal: pode ser guardado como comprovante, mas nunca altera o estoque.</div>}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Fornecedor" value={selected.supplierName} readOnly={readOnly} onChange={value => setSelected({ ...selected, supplierName: value })} />
                <Field label="CNPJ" value={selected.supplierCnpj} readOnly={readOnly} onChange={value => setSelected({ ...selected, supplierCnpj: normalizeCnpj(value) })} />
                <Field label="Número" value={selected.invoiceNumber} readOnly={readOnly} onChange={value => setSelected({ ...selected, invoiceNumber: value })} />
                <Field label="Emissão" type="date" value={selected.issueDate} readOnly={readOnly} onChange={value => setSelected({ ...selected, issueDate: value })} />
                <Field label="Total" type="number" value={String(selected.totalAmount || '')} readOnly={readOnly} onChange={value => setSelected({ ...selected, totalAmount: Number(value) })} />
                <div><label className="mb-1 block text-sm font-medium">Classificação</label>{readOnly ? <div className="flex min-h-11 items-center rounded-md border bg-muted/30 px-3 text-sm">{DOC_LABEL[selected.documentType || 'outro']} ({Math.round(Number(selected.documentTypeConfidence || 0) * 100)}%)</div> : <select className="min-h-11 w-full rounded-md border bg-background px-3 text-sm" value={selected.documentType || 'outro'} onChange={event => setSelected({ ...selected, documentType: event.target.value as WarehouseFiscalDocumentType, documentTypeConfidence: 1 })}>{(Object.keys(DOC_LABEL) as WarehouseFiscalDocumentType[]).map(type => <option key={type} value={type}>{DOC_LABEL[type]}</option>)}</select>}</div>
              </div>
              <div className="grid grid-cols-3 gap-2 rounded-lg border p-3 text-center text-sm"><div><strong className="block text-lg">{summary.linked}</strong>itens vinculados</div><div><strong className="block text-lg">{summary.created}</strong>novos materiais</div><div className={summary.attention ? 'text-warning' : ''}><strong className="block text-lg">{summary.attention}</strong>exigem atenção</div></div>
              <section><div className="mb-2 flex items-center justify-between"><h3 className="font-semibold">Itens ({selected.items.length})</h3>{!readOnly && <Button size="sm" variant="outline" onClick={() => setSelected({ ...selected, items: [...selected.items, newItem()] })}><Plus className="mr-1 h-4 w-4" />Adicionar</Button>}</div><div className="space-y-2">{selected.items.map((item, index) => <div key={item.id} className="grid gap-2 rounded-md border p-3 sm:grid-cols-12"><Input className="min-h-11 sm:col-span-5" value={item.description} readOnly={readOnly} placeholder="Descrição" onChange={event => updateItem(index, { description: event.target.value })} /><Input className="min-h-11 sm:col-span-2" type="number" value={item.quantity} readOnly={readOnly} aria-label="Quantidade" onChange={event => updateItem(index, { quantity: Number(event.target.value) })} /><Input className="min-h-11 sm:col-span-1" value={item.unit || ''} readOnly={readOnly} aria-label="Unidade" onChange={event => updateItem(index, { unit: event.target.value })} /><Input className="min-h-11 sm:col-span-2" type="number" value={item.unitPrice} readOnly={readOnly} aria-label="Valor unitário" onChange={event => updateItem(index, { unitPrice: Number(event.target.value) })} /><div className="flex min-h-11 items-center justify-end font-semibold sm:col-span-1">{money(item.quantity * item.unitPrice)}</div>{!readOnly && <Button size="icon" variant="ghost" className="min-h-11 text-destructive sm:col-span-1" onClick={() => setSelected({ ...selected, items: selected.items.filter((_, i) => i !== index) })} aria-label="Remover item"><Trash2 className="h-4 w-4" /></Button>}</div>)}</div></section>
              <details className="rounded-md border p-3"><summary className="cursor-pointer font-medium">Mais detalhes</summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><Field label="Frete" type="number" value={String(selected.freightAmount || '')} readOnly={readOnly} onChange={value => setSelected({ ...selected, freightAmount: Number(value) })} /><Field label="ICMS adicional" type="number" value={String(selected.icmsAmount || '')} readOnly={readOnly} onChange={value => setSelected({ ...selected, icmsAmount: Number(value) })} /><div className="sm:col-span-2"><label className="mb-1 block text-sm font-medium">Observações</label><Textarea value={selected.notes || ''} readOnly={readOnly} onChange={event => setSelected({ ...selected, notes: event.target.value })} /></div><div className="text-sm text-muted-foreground sm:col-span-2">Faturas: {selected.invoices?.length || 0}. Total de frete e tributos adicionais: {money(Number(selected.freightAmount || 0) + Number(selected.icmsAmount || 0))}.</div></div></details>
              {selected.status === 'cancelada' && <div className="rounded-md border p-3 text-sm"><strong>Cancelado por:</strong> {selected.canceledBy || '—'}<br /><strong>Motivo:</strong> {selected.cancellationReason}</div>}
            </div>
            <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t bg-background p-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)]">
              <Button variant="outline" onClick={() => setSelected(null)}>Fechar</Button>
              {!readOnly && <>
                <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline"><MoreVertical className="mr-1 h-4 w-4" />Opções<ChevronDown className="ml-1 h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem className="text-destructive" onSelect={() => archive('descartada')}><Trash2 className="mr-2 h-4 w-4" />Descartar documento</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
                <Button variant="outline" onClick={() => persist(selected, true)}>Salvar para depois</Button>
                {isStockFiscalDocument(selected.documentType) ? <Button onClick={postStock}><CheckCircle2 className="mr-2 h-4 w-4" />Lançar no estoque</Button> : <Button onClick={() => archive('comprovante')}><Archive className="mr-2 h-4 w-4" />Arquivar como comprovante</Button>}
              </>}
              {canManage && selected.status === 'aprovada' && <Button variant="destructive" onClick={() => setCancelOpen(true)}>Cancelar lançamento</Button>}
            </div>
          </>}
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}><DialogContent><DialogHeader><DialogTitle>Cancelar lançamento</DialogTitle><DialogDescription>A entrada original não será apagada. O sistema criará movimentos de estorno e registrará responsável e motivo.</DialogDescription></DialogHeader>{cancelCheck && !cancelCheck.allowed && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"><strong>Cancelamento bloqueado:</strong><ul className="mt-2 list-disc pl-5">{cancelCheck.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul></div>}<div><label className="mb-1 block text-sm font-medium">Motivo obrigatório</label><Textarea value={cancelReason} onChange={event => setCancelReason(event.target.value)} placeholder="Explique por que o lançamento deve ser cancelado" /></div><DialogFooter><Button variant="outline" onClick={() => setCancelOpen(false)}>Voltar</Button><Button variant="destructive" disabled={!cancelCheck?.allowed || !cancelReason.trim()} onClick={confirmCancel}>Confirmar estorno</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}

function Field({ label, value, readOnly, onChange, type = 'text' }: { label: string; value?: string; readOnly: boolean; onChange: (value: string) => void; type?: string }) {
  return <div><label className="mb-1 block text-sm font-medium">{label}</label><Input className="min-h-11" type={type} value={value ?? ''} readOnly={readOnly} onChange={event => onChange(event.target.value)} /></div>;
}

function NoteCard({ note, onOpen }: { note: WarehouseFiscalNote; onOpen: () => void }) {
  return <button type="button" onClick={onOpen} className="w-full rounded-lg border bg-card p-4 text-left"><div className="flex items-start justify-between gap-2"><div><div className="font-semibold">{note.supplierName || 'Fornecedor não identificado'}</div><div className="mt-1 text-sm text-muted-foreground">{DOC_LABEL[note.documentType || 'outro']} {note.invoiceNumber ? `nº ${note.invoiceNumber}` : ''}</div></div><Badge variant="outline">{note.items.length} itens</Badge></div><div className="mt-3 flex items-end justify-between"><span className="text-xs text-muted-foreground">{note.issueDate ? note.issueDate.split('-').reverse().join('/') : note.sourceFileName}</span><strong>{money(note.totalAmount)}</strong></div></button>;
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
