import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Project,
  WarehouseAttachment,
  WarehouseAuditActor,
  WarehouseFiscalDocumentType,
  WarehouseFiscalNote,
  WarehouseFiscalNoteItem,
} from '@/types/project';
import {
  approveFiscalNote,
  archiveLegacyFiscalNoteDrafts,
  cancelFiscalNote,
  checkFiscalNoteCancellation,
  classifyFiscalDocumentText,
  findFiscalNoteDuplicate,
  fiscalItemConversionFactor,
  fiscalItemGlobalTotal,
  fiscalItemGlobalUnitPrice,
  fiscalItemStockQuantity,
  fiscalItemStockUnit,
  fiscalNoteCostReviewStatus,
  fiscalNoteViewGroup,
  makeAttachment,
  nowWarehouseISO,
  readFileAsDataURL,
  reconcileArchivedFiscalNoteStock,
  reviewArchivedFiscalNoteStock,
  reviewPostedFiscalNoteCosts,
  suggestFiscalNoteItemLinks,
  uidWarehouse,
  updateFiscalItemPurchaseGroup,
  upsertFiscalNote,
} from '@/lib/warehouse';
import {
  downloadWarehouseAttachment,
  loadWarehouseAttachmentBlob,
  warehouseAttachmentErrorMessage,
} from '@/lib/warehouseAttachments';
import { inferSupplierState } from '@/lib/fiscalSupplierState';
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
  ChevronDown,
  ChevronUp,
  Download,
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
  Wrench,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { ESTADOS_BRASIL } from '@/lib/feriados';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import WarehouseAuditIdentity from './WarehouseAuditIdentity';
import { WarehouseEmptyState, WarehouseSectionHeader, WarehouseStatusBadge } from './WarehouseVisual';

interface Props {
  project: Project;
  onProjectChange: (next: Project) => void;
  onCommitProject?: (next: Project) => Promise<void>;
  canManage?: boolean;
  canReviewCosts?: boolean;
  auditActor?: WarehouseAuditActor;
}

type ViewGroup = 'posted' | 'archived';
type ParsedNote = Partial<Pick<WarehouseFiscalNote,
  'supplierName' | 'supplierCnpj' | 'supplierState' | 'invoiceNumber' | 'issueDate' | 'totalAmount' | 'notes' |
  'items' | 'invoices' | 'aiConfidence' | 'documentType' | 'documentTypeConfidence'>>;

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_IMAGES = 4;
const DESTINATION_STATE = 'RO';
const ACCEPTED = ['pdf', 'png', 'jpg', 'jpeg', 'webp'];

function money(value?: number) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function normalizeCnpj(value?: string) {
  const digits = (value ?? '').replace(/\D/g, '');
  if (digits.length !== 14) return value ?? '';
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function normalizeState(value?: string) {
  const normalized = value?.trim().toUpperCase();
  return normalized && /^[A-Z]{2}$/.test(normalized) ? normalized : undefined;
}

function validItems(note: Pick<WarehouseFiscalNote, 'items'>) {
  return note.items.filter(item => item.description.trim() && Number(item.quantity || 0) > 0 && fiscalItemStockQuantity(item) > 0);
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
  return {
    id: uidWarehouse(), description: '', quantity: 1, unit: 'UN', stockQuantity: 1, stockUnit: 'UN', conversionFactor: 1,
    unitPrice: 0, totalPrice: 0,
  };
}

async function makeTransientAttachment(file: File): Promise<WarehouseAttachment> {
  return {
    id: uidWarehouse(),
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    kind: 'nf',
    uploadedAt: nowWarehouseISO(),
    dataUrl: await readFileAsDataURL(file),
  };
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

async function renderPdfPreview(blob: Blob): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const pdf = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  const pages: string[] = [];
  try {
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const naturalViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(2, Math.max(1.25, 1800 / naturalViewport.width));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas indisponível para renderizar o PDF.');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, canvasContext: context, viewport } as Parameters<typeof page.render>[0]).promise;
      pages.push(canvas.toDataURL('image/png'));
    }
    if (!pages.length) throw new Error('O PDF não possui páginas para visualizar.');
    return pages;
  } finally {
    await pdf.destroy();
  }
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
    supplierState: inferSupplierState(input.text, data.note.supplierName, data.note.supplierCnpj)
      ?? normalizeState(data.note.supplierState),
    totalAmount: Number(data.note.totalAmount || 0),
    aiConfidence: data.note.confidence == null ? undefined : Number(data.note.confidence),
    documentTypeConfidence: data.note.documentTypeConfidence == null ? undefined : Number(data.note.documentTypeConfidence),
    items: (data.note.items ?? []).map(item => {
      const quantity = Number(item.quantity || 0);
      const unit = item.unit?.trim() || 'UN';
      return ({
      ...newItem(), ...item, id: item.id || uidWarehouse(),
      quantity,
      unit,
      stockQuantity: quantity,
      stockUnit: unit,
      conversionFactor: 1,
      unitPrice: Number(item.unitPrice || 0),
      totalPrice: Number(item.totalPrice || (Number(item.quantity || 0) * Number(item.unitPrice || 0))),
    }); }).filter(item => item.description?.trim()),
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

async function uploadFiscalAttachmentsStrict(files: File[], projectId: string): Promise<WarehouseAttachment[]> {
  const uploaded: WarehouseAttachment[] = [];
  try {
    for (const file of files) {
      uploaded.push(await makeAttachment(file, projectId, 'nf', 'documents'));
    }
    return uploaded;
  } catch (error) {
    const paths = uploaded.flatMap(attachment => attachment.storagePath ? [attachment.storagePath] : []);
    if (paths.length) {
      try {
        await supabase.storage.from('daily-report-photos').remove(paths);
      } catch {
        // A limpeza e complementar; o erro original do envio deve continuar visivel.
      }
    }
    throw error;
  }
}

async function removeUploadedAttachments(attachments: WarehouseAttachment[] | null): Promise<void> {
  const paths = attachments?.flatMap(attachment => attachment.storagePath ? [attachment.storagePath] : []) ?? [];
  if (!paths.length) return;
  const { error } = await supabase.storage.from('daily-report-photos').remove(paths);
  if (error) console.warn('Não foi possível remover uploads provisórios.', error);
}

export default function WarehouseFiscalNotesTab({ project, onProjectChange, onCommitProject, canManage = true, canReviewCosts = true, auditActor }: Props) {
  const [group, setGroup] = useState<ViewGroup>('posted');
  const [search, setSearch] = useState('');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [selected, setSelected] = useState<WarehouseFiscalNote | null>(null);
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadedAttachments, setUploadedAttachments] = useState<WarehouseAttachment[] | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<WarehouseAttachment | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const archivedLegacyDraftIdsRef = useRef(new Set<string>());
  const destinationState = DESTINATION_STATE;
  const notes = useMemo(() => project.warehouse?.fiscalNotes ?? [], [project.warehouse?.fiscalNotes]);
  const purchaseGroups = useMemo(() => (project.materialComparisons ?? [])
    .map(comparison => ({ id: comparison.id, name: comparison.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')), [project.materialComparisons]);
  const archivedStockReview = useMemo(() => reviewArchivedFiscalNoteStock(project), [project]);

  const counts = useMemo(() => ({
    posted: notes.filter(note => fiscalNoteViewGroup(note) === 'posted').length,
    archived: notes.filter(note => fiscalNoteViewGroup(note) === 'archived').length,
  }), [notes]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return notes.filter(note => fiscalNoteViewGroup(note) === group)
      .filter(note => !pendingOnly || ['pending', 'unknown_origin'].includes(fiscalNoteCostReviewStatus(note)))
      .filter(note => !q || [note.supplierName, note.supplierCnpj, note.invoiceNumber].some(value => value?.toLowerCase().includes(q)));
  }, [group, notes, pendingOnly, search]);
  const pendingCostCount = useMemo(() => notes.filter(note => note.status === 'aprovada' &&
    ['pending', 'unknown_origin'].includes(fiscalNoteCostReviewStatus(note))).length, [notes]);
  const duplicate = selected?.status === 'a_conferir' ? findFiscalNoteDuplicate(project, selected) : undefined;
  const isDraft = selected?.status === 'a_conferir' || selected?.status === 'em_processamento';
  const isPosted = selected?.status === 'aprovada';
  const isArchived = selected?.status === 'rejeitada' || selected?.status === 'cancelada';
  const canEditSelectedCosts = !!selected && (!!isDraft || (!!isPosted && canReviewCosts));
  const selectedItemsSubtotal = selected?.items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0) ?? 0;
  const selectedGlobalCost = Number(selected?.totalAmount || selectedItemsSubtotal) + Number(selected?.freightAmount || 0) + Number(selected?.icmsAmount || 0);
  const cancelCheck = isPosted && selected ? checkFiscalNoteCancellation(project, selected.id) : null;
  useEffect(() => {
    if (!canManage) return;
    const archival = archiveLegacyFiscalNoteDrafts(project, auditActor, archivedLegacyDraftIdsRef.current);
    if (!archival.archivedIds.length) return;
    archival.archivedIds.forEach(noteId => archivedLegacyDraftIdsRef.current.add(noteId));
    onProjectChange(archival.project);
    toast.message(`${archival.archivedIds.length} envio(s) antigo(s) arquivado(s) sem alterar o estoque.`);
  }, [auditActor, canManage, notes, onProjectChange, project]);

  const chooseFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    try {
      const next = [...files, ...Array.from(incoming)];
      validateFiles(next);
      setFiles(next);
      void removeUploadedAttachments(uploadedAttachments);
      setUploadedAttachments(null);
      setUploadOpen(true);
    } catch (error) {
      toast.error((error as Error).message);
    }
    if (cameraRef.current) cameraRef.current.value = '';
    if (fileRef.current) fileRef.current.value = '';
  };

  const processFiles = async () => {
    const selectedFiles = [...files];
    try {
      validateFiles(selectedFiles);
      setProcessing(true);
      const createdAt = nowWarehouseISO();
      const attachments = await Promise.all(selectedFiles.map(makeTransientAttachment));
      const draft: WarehouseFiscalNote = {
        id: uidWarehouse(), createdAt, updatedAt: createdAt, status: 'a_conferir', origin: 'upload',
        sourceFileName: selectedFiles.length === 1 ? selectedFiles[0].name : `${selectedFiles[0].name} + ${selectedFiles.length - 1} foto(s)`,
        sourceMimeType: selectedFiles[0].type, attachment: attachments[0], attachments,
        totalAmount: 0, items: [], extractionStatus: 'reading', extractionStartedAt: createdAt,
        destinationState,
        documentType: 'outro', documentTypeConfidence: 0,
      };

      let urls: string[] = [];
      let extractedText = '';
      let parsed: ParsedNote = { totalAmount: 0, items: [] };
      let processingError: string | undefined;
      try {
        if (selectedFiles[0].type === 'application/pdf' || selectedFiles[0].name.toLowerCase().endsWith('.pdf')) {
          const extracted = await extractPdf(selectedFiles[0]);
          urls = extracted.images;
          extractedText = extracted.text;
        } else {
          urls = attachments.map(attachment => attachment.dataUrl || '').filter(Boolean);
        }
        parsed = await readWithAi({ name: draft.sourceFileName, type: draft.sourceMimeType, urls, text: extractedText });
      } catch (error) {
        processingError = (error as Error).message;
      }
      const deterministicType = classifyFiscalDocumentText(`${extractedText}\n${draft.sourceFileName}`);
      const completedAt = nowWarehouseISO();
      const finalNote: WarehouseFiscalNote = {
        ...draft, ...parsed,
        supplierCnpj: normalizeCnpj(parsed.supplierCnpj),
        items: suggestFiscalNoteItemLinks(project, parsed.items ?? [], parsed.supplierCnpj),
        extractedText,
        documentType: deterministicType !== 'outro' ? deterministicType : (parsed.documentType || 'outro'),
        documentTypeConfidence: deterministicType !== 'outro' ? 1 : Number(parsed.documentTypeConfidence || 0),
        extractionStatus: processingError ? 'failed' : 'ready', processingError,
        extractionCompletedAt: completedAt, updatedAt: completedAt,
      };
      finalNote.costReviewStatus = fiscalNoteCostReviewStatus(finalNote);
      setSelected(finalNote);
      if (processingError) {
        toast.warning('A leitura automática falhou. Tente novamente ou preencha os dados manualmente.');
        return;
      }
      if (!validItems(finalNote).length) {
        toast.warning('A leitura não encontrou itens. Inclua ao menos um item antes de confirmar o lançamento.');
        return;
      }
      toast.success('Leitura concluída. Confira os dados antes de confirmar o lançamento.');
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
      setSelected(updated);
      if (validItems(updated).length) toast.success('Leitura concluída. Confira os dados antes de confirmar o lançamento.');
      else toast.warning('A leitura ainda não encontrou itens. Preencha um item manualmente.');
    } catch (error) {
      const failed = { ...selected, extractionStatus: 'failed' as const, processingError: (error as Error).message };
      setSelected(failed);
      toast.error('A leitura falhou novamente. Preencha o item manualmente.');
    } finally {
      setProcessing(false);
    }
  };

  const postSelectedDraft = async () => {
    if (!selected || !isDraft) return;
    if (duplicate) return toast.error('Esta nota já foi lançada. Cancele o envio ou abra o lançamento existente.');
    if (!validItems(selected).length) return toast.error('Inclua ao menos um item com descrição e quantidade maior que zero.');
    const normalized: WarehouseFiscalNote = {
      ...selected,
      items: selected.items.map(item => ({
        ...item,
        unit: item.unit?.trim() || 'UN',
        stockUnit: fiscalItemStockUnit(item),
        quantity: Number(item.quantity || 0),
        stockQuantity: fiscalItemStockQuantity(item),
        conversionFactor: fiscalItemConversionFactor(item),
        unitPrice: Number(item.unitPrice || 0),
        totalPrice: Number(item.totalPrice || (Number(item.quantity || 0) * Number(item.unitPrice || 0))),
      })),
    };
    try {
      setProcessing(true);
      const sourceFiles = files.length
        ? files
        : await Promise.all((normalized.attachments?.length ? normalized.attachments : normalized.attachment ? [normalized.attachment] : []).map(attachmentFile));
      const attachments = uploadedAttachments ?? await uploadFiscalAttachmentsStrict(sourceFiles, project.id);
      setUploadedAttachments(attachments);
      const persistentNote: WarehouseFiscalNote = {
        ...normalized,
        attachment: attachments[0],
        attachments,
      };
      const saved = upsertFiscalNote(project, persistentNote, auditActor);
      const posted = approveFiscalNote(saved, persistentNote.id, auditActor);
      if (onCommitProject) await onCommitProject(posted);
      else onProjectChange(posted);
      setSelected(null);
      setUploadOpen(false);
      setExpandedItemId(null);
      setFiles([]);
      setUploadedAttachments(null);
      setGroup('posted');
      toast.success(`Nota ${persistentNote.invoiceNumber || ''} salva e conferida na nuvem.`.replace(/\s+/g, ' ').trim());
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setProcessing(false);
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
      const next = updateFiscalItemPurchaseGroup(project, note.id, item.id, value === '__none__' ? undefined : value, auditActor);
      onProjectChange(next);
      setSelected(next.warehouse?.fiscalNotes.find(entry => entry.id === note.id) ?? note);
      toast.success('Grupo de compra atualizado sem alterar o estoque.');
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const confirmCancel = () => {
    if (!selected) return;
    const result = cancelFiscalNote(project, selected.id, { reason: cancelReason, actor: auditActor });
    if (!result.canceled) return toast.error(result.blockers.join(' '));
    onProjectChange(result.project);
    setCancelOpen(false);
    setCancelReason('');
    setSelected(null);
    setGroup('archived');
    toast.success('Lançamento cancelado definitivamente.');
  };

  const openOriginalDocument = (note: WarehouseFiscalNote, attachmentIndex = 0) => {
    const attachments = note.attachments?.length ? note.attachments : (note.attachment ? [note.attachment] : []);
    const attachment = attachments[attachmentIndex];
    if (!attachment) return toast.error('O documento original não está disponível.');
    setPreviewAttachment(attachment);
  };

  const downloadOriginalDocument = async (note: WarehouseFiscalNote, attachmentIndex = 0) => {
    const attachments = note.attachments?.length ? note.attachments : (note.attachment ? [note.attachment] : []);
    const attachment = attachments[attachmentIndex];
    if (!attachment) return toast.error('O documento original não está disponível.');
    try {
      await downloadWarehouseAttachment(attachment);
    } catch (error) {
      toast.error(warehouseAttachmentErrorMessage(error));
    }
  };

  const confirmArchivedStockReconciliation = () => {
    const safeIds = archivedStockReview.issues.filter(issue => issue.canReconcile).map(issue => issue.noteId);
    if (!safeIds.length) return;
    const result = reconcileArchivedFiscalNoteStock(project, safeIds, auditActor);
    if (!result.reconciledNoteIds.length) return toast.error('Nenhum lançamento pôde ser reconciliado.');
    onProjectChange(result.project);
    setReconciliationOpen(false);
    toast.success(`${result.reconciledNoteIds.length} documento(s) reconciliado(s) com estorno auditável.`);
  };

  const requestCloseSelected = () => {
    if (isDraft) {
      void removeUploadedAttachments(uploadedAttachments);
      setSelected(null);
      setUploadOpen(false);
      setExpandedItemId(null);
      setFiles([]);
      setUploadedAttachments(null);
      return;
    }
    setSelected(null);
    setUploadOpen(false);
    setExpandedItemId(null);
  };

  const openDuplicate = () => {
    if (!duplicate) return;
    void removeUploadedAttachments(uploadedAttachments);
    setFiles([]);
    setUploadedAttachments(null);
    setUploadOpen(false);
    setSelected({ ...duplicate, destinationState: DESTINATION_STATE });
  };

  const savePostedCosts = async () => {
    if (!selected || !isPosted || !canReviewCosts) return;
    try {
      setProcessing(true);
      const next = reviewPostedFiscalNoteCosts(project, selected.id, {
        supplierState: selected.supplierState,
        destinationState: DESTINATION_STATE,
        freightAmount: selected.freightAmount,
        icmsAmount: selected.icmsAmount,
        confirmCosts: true,
        actor: auditActor,
      });
      if (onCommitProject) await onCommitProject(next);
      else onProjectChange(next);
      setSelected(next.warehouse?.fiscalNotes?.find(note => note.id === selected.id) ?? selected);
      toast.success('Custos conferidos e movimentos reavaliados sem alterar quantidades.');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-3">
      <input ref={cameraRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={event => chooseFiles(event.target.files)} />
      <input ref={fileRef} className="hidden" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" multiple onChange={event => chooseFiles(event.target.files)} />

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <WarehouseSectionHeader icon={FileText} title="Entradas por nota fiscal" description="Registre e acompanhe as entradas de materiais." help="Tire fotos ou envie um PDF, confira os dados extraídos e somente depois confirme o lançamento no estoque." />
        <div className="flex flex-col gap-3 p-3 md:flex-row md:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="min-h-11 pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar por fornecedor, CNPJ ou número" />
          </div>
          {canManage && <Button className="min-h-11" onClick={() => { setFiles([]); setSelected(null); setExpandedItemId(null); setUploadOpen(true); }} disabled={processing}><Plus className="mr-2 h-4 w-4" />Registrar entrada</Button>}
        </div>
        {!canManage && <p className="mx-3 mb-3 text-sm font-medium text-muted-foreground">Seu perfil possui acesso somente para consulta.</p>}
      </div>

      <Tabs value={group} onValueChange={value => setGroup(value as ViewGroup)}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto rounded-xl border bg-muted/70 p-1">
          <TabsTrigger value="posted" className="min-h-11 whitespace-nowrap rounded-lg font-bold data-[state=active]:bg-card data-[state=active]:text-primary">Lançadas no estoque ({counts.posted})</TabsTrigger>
          <TabsTrigger value="archived" className="min-h-11 whitespace-nowrap rounded-lg font-bold data-[state=active]:bg-card data-[state=active]:text-primary">Arquivadas ({counts.archived})</TabsTrigger>
        </TabsList>
      </Tabs>

      {group === 'posted' && pendingCostCount > 0 && <Button
        variant={pendingOnly ? 'default' : 'outline'}
        className="min-h-11"
        onClick={() => setPendingOnly(value => !value)}
      ><AlertTriangle className="mr-2 h-4 w-4" />Pendências fiscais ({pendingCostCount})</Button>}

      {group === 'archived' && archivedStockReview.issues.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 sm:flex-row sm:items-center">
          <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-semibold">Estoque antigo precisa de revisão</div>
            <div className="text-muted-foreground">
              {archivedStockReview.safeCount} documento(s) podem ser corrigidos e {archivedStockReview.blockedCount} exigem análise manual.
            </div>
          </div>
          {canManage && <Button className="min-h-11" variant="outline" onClick={() => setReconciliationOpen(true)}><Wrench className="mr-2 h-4 w-4" />Revisar e corrigir estoque</Button>}
        </div>
      )}

      <div className="space-y-2 md:hidden">
        {visible.map((note, index) => <NoteCard key={note.id} note={note} sequence={visible.length - index} onOpen={() => { setExpandedItemId(null); setSelected({ ...note, destinationState: DESTINATION_STATE }); }} onOpenAttachment={() => void openOriginalDocument(note)} />)}
      </div>
      <div className="hidden overflow-hidden rounded-lg border bg-card md:block">
        <table className="w-full table-fixed text-xs">
          <colgroup><col className="w-[18%]" /><col className="w-[4%]" /><col className="w-[13%]" /><col className="w-[9%]" /><col className="w-[8%]" /><col className="w-[5%]" /><col className="w-[9%]" /><col className="w-[9%]" /><col className="w-[17%]" /><col className="w-[8%]" /></colgroup>
          <thead className="bg-muted text-muted-foreground"><tr><th className="p-2 text-left">Fornecedor</th><th className="w-14 p-2 text-center">Nº</th><th className="p-2 text-left">CNPJ</th><th className="p-2 text-left">Nota</th><th className="p-2 text-left">Data</th><th className="p-2 text-center">Itens</th><th className="p-2 text-right">Valor</th><th className="p-2 text-left">Status</th><th className="whitespace-normal p-2 text-left leading-tight">Incluído / alterado por</th><th className="p-2 text-center">Ações</th></tr></thead>
          <tbody>{visible.map((note, index) => <tr key={note.id} className="border-t hover:bg-muted/30"><td className="p-2 font-medium">{note.supplierName || '—'}</td><td className="p-2 text-center font-mono font-semibold text-primary">{visible.length - index}</td><td className="p-2 font-mono text-muted-foreground">{note.supplierCnpj || '—'}</td><td className="p-2">{note.invoiceNumber || '—'}</td><td className="p-2">{note.issueDate ? note.issueDate.split('-').reverse().join('/') : '—'}</td><td className="p-2 text-center tabular-nums">{note.items.length}</td><td className="p-2 text-right font-semibold">{money(note.totalAmount)}</td><td className="p-2"><div className="space-y-1"><StatusBadge note={note} /><CostReviewBadge note={note} /></div></td><td className="overflow-hidden p-2 align-top"><WarehouseAuditIdentity createdBy={note.createdBy} updatedBy={note.updatedBy} legacyCreatedBy={note.stockPostedBy} className="space-y-0.5 text-[11px]" /></td><td className="p-2"><div className="flex items-center justify-center gap-1"><Button size="icon" variant="ghost" className="h-8 w-8" title="Abrir documento original" aria-label="Abrir documento original" onClick={() => void openOriginalDocument(note)}><Eye className="h-4 w-4" /></Button><Button size="icon" variant="ghost" className="h-8 w-8" title="Visualizar dados e grupos" aria-label="Visualizar dados e grupos" onClick={() => { setExpandedItemId(null); setSelected({ ...note, destinationState: DESTINATION_STATE }); }}><Pencil className="h-4 w-4" /></Button>{canManage && note.status === 'aprovada' && <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" title="Cancelar lançamento" aria-label="Cancelar lançamento" onClick={() => { setSelected({ ...note, destinationState: DESTINATION_STATE }); setCancelOpen(true); }}><Ban className="h-4 w-4" /></Button>}</div></td></tr>)}</tbody>
        </table>
      </div>
      {!visible.length && <WarehouseEmptyState message="Nenhum documento nesta área" hint={group === 'posted' ? 'Envie um arquivo para começar.' : 'Documentos arquivados aparecerão aqui.'} icon={FileText} />}

      <Dialog open={uploadOpen || !!selected} onOpenChange={open => {
        if (open || processing) return;
        if (selected) requestCloseSelected();
        else { setUploadOpen(false); setFiles([]); setUploadedAttachments(null); }
      }}>
        <DialogContent className={`warehouse-ui flex max-h-[95dvh] flex-col overflow-hidden p-0 [&>button]:h-11 [&>button]:w-11 ${selected ? 'max-w-7xl' : 'max-w-xl'}`}>
          {!selected ? <>
            <DialogHeader className="border-b p-4 pr-12"><DialogTitle>Registrar entrada</DialogTitle><DialogDescription>Tire fotos ou envie um PDF. Esta janela permanecerá aberta durante a leitura e a conferência.</DialogDescription></DialogHeader>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              <div className="grid grid-cols-2 gap-2"><Button variant="outline" className="min-h-11" disabled={processing} onClick={() => cameraRef.current?.click()}><Camera className="mr-2 h-4 w-4" />Tirar foto</Button><Button variant="outline" className="min-h-11" disabled={processing} onClick={() => fileRef.current?.click()}><Upload className="mr-2 h-4 w-4" />Arquivo/PDF</Button></div>
              <div className="space-y-2">{files.map((file, index) => <div key={`${file.name}-${index}`} className="flex min-h-16 items-center gap-3 rounded-md border p-2"><FilePreview file={file} /><span className="min-w-0 flex-1 truncate text-sm">{index + 1}. {file.name}</span><div className="flex gap-1"><Button size="icon" variant="ghost" disabled={index === 0 || processing} onClick={() => { setUploadedAttachments(null); setFiles(list => list.map((entry, i) => i === index - 1 ? file : i === index ? list[index - 1] : entry)); }} aria-label="Mover para cima">↑</Button><Button size="icon" variant="ghost" disabled={processing} onClick={() => { setUploadedAttachments(null); setFiles(list => list.filter((_, i) => i !== index)); }} aria-label="Remover foto"><X className="h-4 w-4" /></Button></div></div>)}</div>
              {!files.some(file => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) && files.length > 0 && files.length < MAX_IMAGES && <div className="grid grid-cols-2 gap-2"><Button variant="outline" className="min-h-11" disabled={processing} onClick={() => cameraRef.current?.click()}><Camera className="mr-2 h-4 w-4" />Nova captura</Button><Button variant="outline" className="min-h-11" disabled={processing} onClick={() => fileRef.current?.click()}><Plus className="mr-2 h-4 w-4" />Adicionar foto</Button></div>}
              {processing && <div className="flex items-center rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm font-semibold"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Lendo o documento. Permaneça nesta janela.</div>}
            </div>
            <DialogFooter className="border-t p-3"><Button variant="outline" disabled={processing} onClick={() => { setUploadOpen(false); setFiles([]); setUploadedAttachments(null); }}>Cancelar</Button><Button onClick={processFiles} disabled={!files.length || processing}>{processing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}Ler documento</Button></DialogFooter>
          </> : <>
            <DialogHeader className="border-b p-4 pr-12"><div className="flex flex-wrap items-center gap-2"><DialogTitle>{isDraft ? 'Validar entrada antes do lançamento' : 'Dados da entrada'}</DialogTitle><StatusBadge note={selected} /><CostReviewBadge note={selected} />{selected.extractionStatus === 'failed' && <Badge variant="destructive">Leitura incompleta</Badge>}</div><DialogDescription>{isDraft ? 'Confira e corrija os dados. O estoque ainda não foi alterado.' : `${selected.attachments?.length || (selected.attachment ? 1 : 0)} documento(s) original(is) preservado(s) para auditoria`}</DialogDescription></DialogHeader>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-24">
              {duplicate && <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"><AlertTriangle className="mr-2 inline h-4 w-4" /><strong>Nota já lançada:</strong> {duplicate.supplierName || 'Fornecedor não identificado'} · CNPJ {duplicate.supplierCnpj || '—'} · Nota {duplicate.invoiceNumber || '—'} · Emissão {duplicate.issueDate ? duplicate.issueDate.split('-').reverse().join('/') : '—'} · Valor {money(duplicate.totalAmount)}. Este envio não pode gerar outra entrada no estoque.</div>}
              {selected.processingError && <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"><AlertTriangle className="mr-2 inline h-4 w-4" />{selected.processingError} {isDraft && <Button className="ml-2" size="sm" variant="outline" disabled={processing} onClick={retryExtraction}>{processing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}Tentar leitura novamente</Button>}</div>}
              {(selected.attachments?.length || selected.attachment) && <div className="flex flex-wrap items-center gap-2 rounded-md border p-3"><span className="mr-auto text-sm font-medium">Documento original</span>{(selected.attachments?.length ? selected.attachments : selected.attachment ? [selected.attachment] : []).map((attachment, index) => <div key={attachment.id} className="flex flex-wrap gap-2"><Button type="button" variant="outline" className="min-h-11" onClick={() => void openOriginalDocument(selected, index)}><Eye className="mr-2 h-4 w-4" />{index === 0 && (selected.attachments?.length || 0) <= 1 ? 'Visualizar documento' : `Visualizar anexo ${index + 1}`}</Button><Button type="button" variant="outline" className="min-h-11" onClick={() => void downloadOriginalDocument(selected, index)}><Download className="mr-2 h-4 w-4" />Baixar</Button></div>)}</div>}

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Fornecedor" value={selected.supplierName} readOnly={!isDraft} onChange={value => setSelected({ ...selected, supplierName: value })} />
                <Field label="CNPJ" value={selected.supplierCnpj} readOnly={!isDraft} onChange={value => setSelected({ ...selected, supplierCnpj: normalizeCnpj(value) })} />
                <Field label="Número da nota" value={selected.invoiceNumber} readOnly={!isDraft} onChange={value => setSelected({ ...selected, invoiceNumber: value })} />
                <Field label="Data de emissão" type="date" value={selected.issueDate} readOnly={!isDraft} onChange={value => setSelected({ ...selected, issueDate: value })} />
                <StateSelect label="UF do fornecedor" value={selected.supplierState} disabled={!canEditSelectedCosts} onChange={value => setSelected({ ...selected, supplierState: value })} />
                <StateSelect label="UF da obra" value={DESTINATION_STATE} disabled onChange={() => undefined} />
                <div className="sm:col-span-2"><MoneyInput label="Valor informado na NF" value={selected.totalAmount} readOnly={!isDraft} onChange={value => setSelected({ ...selected, totalAmount: value ?? 0 })} /></div>
              </div>

              <section>
                <div className="mb-2 flex items-center justify-between"><h3 className="font-semibold">Itens do documento ({selected.items.length})</h3>{isDraft && <Button size="sm" variant="outline" onClick={() => setSelected({ ...selected, items: [...selected.items, newItem()] })}><Plus className="mr-1 h-4 w-4" />Adicionar item</Button>}</div>
                <div className="hidden overflow-x-auto rounded-md border md:block">
                  <table className={`${isDraft ? 'min-w-[1480px]' : 'min-w-[1080px]'} w-full text-xs`}>
                    <thead className="bg-muted text-muted-foreground"><tr><th className="h-11 p-2 text-left align-middle">Cód. prod.</th><th className="h-11 min-w-64 p-2 text-left align-middle">Descrição</th><th className="h-11 p-2 text-center align-middle">Qtd. NF</th><th className="h-11 p-2 text-center align-middle">Un. NF</th><th className="h-11 p-2 text-center align-middle">V. unit. NF</th><th className="h-11 p-2 text-center align-middle">Total NF</th>{isDraft && <><th className="h-11 p-2 text-center align-middle">Qtd. estoque</th><th className="h-11 p-2 text-center align-middle">Un. estoque</th><th className="h-11 p-2 text-center align-middle">Fator</th></>}<th className="h-11 p-2 text-center align-middle">V. unit. global</th><th className="h-11 p-2 text-center align-middle">V. total global</th><th className="h-11 min-w-52 p-2 text-left align-middle">Grupo de compra</th>{isDraft && <th className="h-11 p-2" />}</tr></thead>
                    <tbody>{selected.items.map((item, index) => <ItemTableRow key={item.id} note={selected} item={item} index={index} editable={!!isDraft} groupEditable={canManage && !isArchived} purchaseGroups={purchaseGroups} onUpdate={updateItem} onGroupChange={value => updatePurchaseGroup(selected, item, value)} onRemove={() => setSelected({ ...selected, items: selected.items.filter((_, itemIndex) => itemIndex !== index) })} />)}</tbody>
                  </table>
                </div>
                <div className="space-y-2 md:hidden">{selected.items.map((item, index) => <ItemMobileCard key={item.id} note={selected} item={item} index={index} expanded={expandedItemId === item.id} onToggle={() => setExpandedItemId(current => current === item.id ? null : item.id)} editable={!!isDraft} groupEditable={canManage && !isArchived} purchaseGroups={purchaseGroups} onUpdate={updateItem} onGroupChange={value => updatePurchaseGroup(selected, item, value)} onRemove={() => setSelected({ ...selected, items: selected.items.filter((_, itemIndex) => itemIndex !== index) })} />)}</div>
                {!selected.items.length && <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">Nenhum item identificado. Adicione um item para concluir o lançamento.</div>}
              </section>

              <section className="space-y-3 rounded-md border p-3">
                <div><h3 className="font-semibold">Composição do custo global</h3><p className="text-xs text-muted-foreground">Custo global = valor informado na NF + frete adicional + ICMS/DIFAL adicional. O total é rateado proporcionalmente entre todos os materiais da nota.</p></div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <MoneyValue label="Subtotal dos itens" value={selectedItemsSubtotal} />
                  <MoneyInput label="Frete adicional" value={selected.freightAmount} readOnly={!canEditSelectedCosts} onChange={value => setSelected({ ...selected, freightAmount: value })} />
                  <MoneyInput label="ICMS/DIFAL adicional" value={selected.icmsAmount} readOnly={!canEditSelectedCosts} onChange={value => setSelected({ ...selected, icmsAmount: value })} />
                  <MoneyValue label="Valor informado na NF" value={selected.totalAmount} />
                  <MoneyValue label="Custo global calculado" value={selectedGlobalCost} strong />
                </div>
                {fiscalNoteCostReviewStatus(selected) === 'pending' && <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"><AlertTriangle className="mr-2 inline h-4 w-4" />Compra interestadual: frete e ICMS/DIFAL aguardam conferência da engenharia. A entrada pode ser lançada normalmente.</div>}
                {fiscalNoteCostReviewStatus(selected) === 'unknown_origin' && <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"><AlertTriangle className="mr-2 inline h-4 w-4" />Verifique a UF do fornecedor para identificar se a compra é interestadual.</div>}
              </section>
              <details className="rounded-md border p-3"><summary className="cursor-pointer font-medium">Mais detalhes</summary><div className="mt-3"><label className="mb-1 block text-sm font-medium">Observações</label><Textarea value={selected.notes || ''} readOnly={!isDraft} onChange={event => setSelected({ ...selected, notes: event.target.value })} /><div className="mt-2 text-sm text-muted-foreground">Faturas: {selected.invoices?.length || 0}.</div></div></details>
              {selected.status === 'cancelada' && <div className="rounded-md border p-3 text-sm"><strong>Cancelamento definitivo</strong><br /><strong>Responsável:</strong> {selected.canceledBy || '—'}<br /><strong>Motivo:</strong> {selected.cancellationReason}</div>}
            </div>
            <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t bg-background p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] shadow-[0_-4px_12px_rgba(0,0,0,0.08)] [&>button]:min-h-11">
              {!isDraft && <Button variant="outline" onClick={() => setSelected(null)}>Fechar</Button>}
              {isDraft && <Button variant="outline" onClick={requestCloseSelected}>Cancelar envio</Button>}
              {isDraft && duplicate && <Button onClick={openDuplicate}>Abrir lançamento existente</Button>}
              {isDraft && !duplicate && <Button onClick={() => void postSelectedDraft()} disabled={!validItems(selected).length || processing}>{processing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Confirmar lançamento</Button>}
              {canReviewCosts && isPosted && <Button onClick={() => void savePostedCosts()} disabled={processing}>{processing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Confirmar custos</Button>}
              {canManage && isPosted && <Button variant="destructive" onClick={() => setCancelOpen(true)}>Cancelar lançamento</Button>}
            </div>
          </>}
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}><DialogContent className="warehouse-ui"><DialogHeader><DialogTitle>Cancelar lançamento definitivamente</DialogTitle><DialogDescription>A entrada original não será apagada. O sistema criará movimentos de estorno, preservará o documento e impedirá qualquer relançamento deste registro.</DialogDescription></DialogHeader>{cancelCheck && !cancelCheck.allowed && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"><strong>Cancelamento bloqueado:</strong><ul className="mt-2 list-disc pl-5">{cancelCheck.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul></div>}<div><label className="mb-1 block text-sm font-medium">Motivo obrigatório</label><Textarea value={cancelReason} onChange={event => setCancelReason(event.target.value)} placeholder="Explique por que o lançamento deve ser cancelado" /></div><DialogFooter><Button variant="outline" onClick={() => setCancelOpen(false)}>Voltar</Button><Button variant="destructive" disabled={!cancelCheck?.allowed || !cancelReason.trim()} onClick={confirmCancel}>Confirmar estorno definitivo</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={reconciliationOpen} onOpenChange={setReconciliationOpen}>
        <DialogContent className="warehouse-ui max-h-[90dvh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Revisar estoque de documentos arquivados</DialogTitle>
            <DialogDescription>Confira o impacto antes de gerar os estornos. Entradas originais e documentos permanecerão preservados para auditoria.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {archivedStockReview.issues.map(issue => (
              <section key={issue.noteId} className={`rounded-md border p-3 ${issue.canReconcile ? 'border-warning/40' : 'border-destructive/40 bg-destructive/5'}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div><strong>{issue.supplierName || 'Fornecedor não identificado'}</strong><div className="text-sm text-muted-foreground">Nota {issue.invoiceNumber || '—'}</div></div>
                  <Badge variant="outline">{issue.canReconcile ? 'Pronta para corrigir' : 'Análise manual'}</Badge>
                </div>
                {issue.entries.length > 0 && <div className="mt-3 overflow-hidden rounded-md border"><table className="w-full text-sm"><thead className="bg-muted text-muted-foreground"><tr><th className="p-2 text-left">Material</th><th className="p-2 text-center">Quantidade a estornar</th></tr></thead><tbody>{issue.entries.map(entry => <tr key={entry.movementId} className="border-t"><td className="p-2">{entry.itemCode ? `${entry.itemCode} · ` : ''}{entry.description}</td><td className="p-2 text-center tabular-nums">{entry.quantity.toLocaleString('pt-BR')} {entry.unit}</td></tr>)}</tbody></table></div>}
                {issue.materialKeysToArchive.length > 0 && <p className="mt-2 text-sm text-muted-foreground">{issue.materialKeysToArchive.length} material(is) exclusivo(s) ficará(ão) oculto(s) após ficar sem saldo ou referência.</p>}
                {issue.blockers.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-destructive">{issue.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul>}
              </section>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReconciliationOpen(false)}>Voltar sem alterar</Button>
            <Button disabled={!archivedStockReview.safeCount} onClick={confirmArchivedStockReconciliation}><Wrench className="mr-2 h-4 w-4" />Confirmar {archivedStockReview.safeCount} correção(ões)</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FiscalAttachmentViewer attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />
    </div>
  );
}

function Field({ label, value, readOnly, onChange, type = 'text' }: { label: string; value?: string; readOnly: boolean; onChange: (value: string) => void; type?: string }) {
  return <div><label className="mb-1 block text-sm font-medium">{label}</label><Input className="min-h-11" type={type} value={value ?? ''} readOnly={readOnly} onChange={event => onChange(event.target.value)} /></div>;
}

function DecimalInput({ value, readOnly, onChange }: { value?: number; readOnly: boolean; onChange: (value: number) => void }) {
  return <Input className="min-h-11 min-w-24 text-center text-base" type="number" inputMode="decimal" min="0" step="any" value={Number.isFinite(value) ? value : ''} readOnly={readOnly} onChange={event => onChange(Math.max(0, Number(event.target.value || 0)))} />;
}

function MoneyInput({ label, value, readOnly, onChange, compact = false }: { label?: string; value?: number; readOnly: boolean; onChange: (value: number | undefined) => void; compact?: boolean }) {
  const control = <div className="relative"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted-foreground">R$</span><Input aria-label={label || 'Valor monetário'} className={`min-h-11 pl-10 text-right text-base tabular-nums ${compact ? 'min-w-32' : ''}`} type="number" inputMode="decimal" min="0" step="0.01" value={value == null ? '' : value} readOnly={readOnly} onChange={event => onChange(event.target.value === '' ? undefined : Math.max(0, Number(event.target.value)))} /></div>;
  return label ? <div><label className="mb-1 block text-sm font-medium">{label}</label>{control}</div> : control;
}

function MoneyValue({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return <div><div className="mb-1 text-sm font-medium">{label}</div><div className={`flex min-h-11 items-center justify-end rounded-md border bg-muted/30 px-3 font-mono tabular-nums ${strong ? 'font-bold text-primary' : ''}`}>{money(value)}</div></div>;
}

function StateSelect({ label, value, disabled, onChange }: { label: string; value?: string; disabled: boolean; onChange: (value?: string) => void }) {
  return <div><label className="mb-1 block text-sm font-medium">{label}</label><Select value={value || '__unknown__'} disabled={disabled} onValueChange={next => onChange(next === '__unknown__' ? undefined : next)}><SelectTrigger aria-label={label} className="min-h-11"><SelectValue placeholder="Selecione" /></SelectTrigger><SelectContent><SelectItem value="__unknown__">Não identificada</SelectItem>{ESTADOS_BRASIL.map(state => <SelectItem key={state.uf} value={state.uf}>{state.uf} — {state.nome}</SelectItem>)}</SelectContent></Select></div>;
}

function StatusBadge({ note }: { note: WarehouseFiscalNote }) {
  if (note.status === 'aprovada') return <WarehouseStatusBadge label="Lançada" tone="success" />;
  if (note.status === 'cancelada') return <WarehouseStatusBadge label="Cancelada" tone="danger" />;
  if (note.status === 'rejeitada') return <WarehouseStatusBadge label="Arquivada" tone="neutral" />;
  return <WarehouseStatusBadge label="Aguardando confirmação" tone="warning" />;
}

function FiscalAttachmentViewer({ attachment, onClose }: { attachment: WarehouseAttachment | null; onClose: () => void }) {
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; url?: string; pages?: string[]; mimeType?: string; error?: string }>({ status: 'idle' });

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    if (!attachment) {
      setState({ status: 'idle' });
      return () => { active = false; };
    }
    setState({ status: 'loading' });
    void loadWarehouseAttachmentBlob(attachment)
      .then(async blob => {
        if (!active) return;
        const mimeType = attachment.mimeType || blob.type;
        const isPdfAttachment = mimeType.toLowerCase() === 'application/pdf' || attachment.name.toLowerCase().endsWith('.pdf');
        if (isPdfAttachment) {
          const pages = await renderPdfPreview(blob);
          if (active) setState({ status: 'ready', pages, mimeType: 'application/pdf' });
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', url: objectUrl, mimeType });
      })
      .catch(error => {
        if (active) setState({ status: 'error', error: error instanceof Error && /PDF|Canvas/i.test(error.message)
          ? 'Não foi possível renderizar este PDF. Use Baixar para conferir o arquivo original.'
          : warehouseAttachmentErrorMessage(error) });
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment]);

  const download = async () => {
    if (!attachment) return;
    try {
      await downloadWarehouseAttachment(attachment);
    } catch (error) {
      toast.error(warehouseAttachmentErrorMessage(error));
    }
  };

  const mimeType = state.mimeType?.toLowerCase() || '';
  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf' || attachment?.name.toLowerCase().endsWith('.pdf');

  return (
    <Dialog open={!!attachment} onOpenChange={open => !open && onClose()}>
      <DialogContent className="warehouse-ui flex max-h-[95dvh] max-w-6xl flex-col overflow-hidden p-0 [&>button]:h-11 [&>button]:w-11">
        {attachment && <>
          <DialogHeader className="border-b p-4 pr-14">
            <DialogTitle>Documento original</DialogTitle>
            <DialogDescription>{attachment.name}</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-[55dvh] flex-1 items-center justify-center overflow-auto bg-muted/30 p-3 sm:min-h-[65dvh]">
            {state.status === 'loading' && <div className="flex items-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Carregando documento...</div>}
            {state.status === 'error' && <div className="max-w-md rounded-md border border-destructive/30 bg-background p-5 text-center text-sm text-destructive">{state.error}</div>}
            {state.status === 'ready' && state.url && isImage && <img src={state.url} alt={`Documento ${attachment.name}`} className="max-h-[72dvh] max-w-full object-contain" />}
            {state.status === 'ready' && isPdf && state.pages && <div aria-label={`Visualização de ${attachment.name}`} className="flex max-h-[72dvh] w-full flex-col gap-3 overflow-y-auto rounded-md border bg-muted/40 p-2">
              <div className="sticky top-0 z-10 self-center rounded-full border bg-background/95 px-3 py-1 text-xs font-medium shadow-sm">{state.pages.length} {state.pages.length === 1 ? 'página' : 'páginas'}</div>
              {state.pages.map((page, index) => <img key={index} src={page} alt={`Página ${index + 1} de ${attachment.name}`} className="mx-auto h-auto w-full max-w-5xl rounded-sm bg-white shadow-sm" />)}
            </div>}
            {state.status === 'ready' && state.url && !isImage && !isPdf && <div className="max-w-md text-center text-sm text-muted-foreground"><FileText className="mx-auto mb-3 h-8 w-8" />Este tipo de arquivo não possui visualização interna. Use Baixar.</div>}
          </div>
          <DialogFooter className="border-t p-3">
            <Button variant="outline" onClick={onClose}>Fechar</Button>
            <Button onClick={() => void download()}><Download className="mr-2 h-4 w-4" />Baixar</Button>
          </DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
  );
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
  expanded?: boolean;
  onToggle?: () => void;
}

function CostReviewBadge({ note }: { note: WarehouseFiscalNote }) {
  const status = fiscalNoteCostReviewStatus(note);
  if (status === 'pending') return <WarehouseStatusBadge label="Frete/ICMS pendentes" tone="warning" />;
  if (status === 'unknown_origin') return <WarehouseStatusBadge label="Verificar UF" tone="warning" />;
  if (status === 'confirmed') return <WarehouseStatusBadge label="Custos conferidos" tone="success" />;
  return null;
}

function ItemTableRow({ note, item, index, editable, groupEditable, purchaseGroups, onUpdate, onGroupChange, onRemove }: ItemEditorProps) {
  const factor = fiscalItemConversionFactor(item);
  const stockQuantity = fiscalItemStockQuantity(item);
  return <tr className="border-t">
    <td className="p-1 align-middle"><Input className="min-h-11 min-w-24 text-center" value={item.productCode || ''} readOnly={!editable} onChange={event => onUpdate(index, { productCode: event.target.value })} /></td>
    <td className="p-1 align-middle"><Input className="min-h-11 min-w-64" value={item.description} readOnly={!editable} onChange={event => onUpdate(index, { description: event.target.value })} /></td>
    <td className="p-1 align-middle"><DecimalInput value={item.quantity} readOnly={!editable} onChange={quantity => onUpdate(index, { quantity, totalPrice: quantity * Number(item.unitPrice || 0), stockQuantity: quantity * factor })} /></td>
    <td className="p-1 align-middle"><Input className="min-h-11 min-w-20 text-center text-base" value={item.unit || 'UN'} readOnly={!editable} onChange={event => onUpdate(index, { unit: event.target.value, stockUnit: fiscalItemStockUnit(item) === (item.unit || 'UN') ? event.target.value : item.stockUnit })} /></td>
    <td className="p-1 align-middle"><MoneyInput value={item.unitPrice} readOnly={!editable} onChange={unitPrice => onUpdate(index, { unitPrice: unitPrice ?? 0, totalPrice: Number(item.quantity || 0) * Number(unitPrice || 0) })} compact /></td>
    <td className="p-1 align-middle"><MoneyInput value={item.totalPrice} readOnly={!editable} onChange={totalPrice => onUpdate(index, { totalPrice: totalPrice ?? 0, unitPrice: Number(item.quantity || 0) > 0 ? Number(totalPrice || 0) / Number(item.quantity) : 0 })} compact /></td>
    {editable && <><td className="p-1 align-middle"><DecimalInput value={stockQuantity} readOnly={false} onChange={value => onUpdate(index, { stockQuantity: value, conversionFactor: Number(item.quantity || 0) > 0 ? value / Number(item.quantity) : 1 })} /></td>
    <td className="p-1 align-middle"><Input className="min-h-11 min-w-24 text-center text-base" value={fiscalItemStockUnit(item)} onChange={event => onUpdate(index, { stockUnit: event.target.value })} /></td>
    <td className="p-1 align-middle"><DecimalInput value={factor} readOnly={false} onChange={value => onUpdate(index, { conversionFactor: value, stockQuantity: Number(item.quantity || 0) * value })} /></td></>}
    <td className="h-11 p-2 text-center align-middle font-mono tabular-nums">{money(fiscalItemGlobalUnitPrice(item, note))}</td>
    <td className="h-11 p-2 text-center align-middle font-mono font-semibold tabular-nums">{money(fiscalItemGlobalTotal(item, note))}</td>
    <td className="p-1 align-middle"><PurchaseGroupSelect value={item.purchaseGroupId} disabled={!groupEditable} groups={purchaseGroups} onChange={onGroupChange} /></td>
    {editable && <td className="p-1 text-center align-middle"><Button size="icon" variant="ghost" className="min-h-11 text-destructive" onClick={onRemove} aria-label="Remover item"><Trash2 className="h-4 w-4" /></Button></td>}
  </tr>;
}

function ItemMobileCard({ note, item, index, expanded = false, onToggle, editable, groupEditable, purchaseGroups, onUpdate, onGroupChange, onRemove }: ItemEditorProps) {
  const factor = fiscalItemConversionFactor(item);
  const stockQuantity = fiscalItemStockQuantity(item);
  return <article className="overflow-hidden rounded-md border bg-card">
    <button type="button" className="flex min-h-16 w-full items-center gap-3 p-3 text-left" aria-expanded={expanded} onClick={onToggle}>
      <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{item.description || 'Item sem descrição'}</div><div className="mt-1 truncate text-xs text-muted-foreground">{item.productCode || 'Sem código'} · {(editable ? stockQuantity : Number(item.quantity || 0)).toLocaleString('pt-BR')} {editable ? fiscalItemStockUnit(item) : (item.unit || 'UN')}</div></div>
      <div className="shrink-0 text-right"><div className="text-xs text-muted-foreground">Custo global</div><div className="font-mono text-sm font-semibold">{money(fiscalItemGlobalTotal(item, note))}</div></div>
      {expanded ? <ChevronUp className="h-5 w-5 shrink-0" /> : <ChevronDown className="h-5 w-5 shrink-0" />}
    </button>
    {expanded && <div className="space-y-3 border-t p-3">
      <div className="grid grid-cols-2 gap-2"><div className="col-span-2"><MobileField label="Descrição"><Input className="min-h-11 text-base" value={item.description} readOnly={!editable} onChange={event => onUpdate(index, { description: event.target.value })} /></MobileField></div><MobileField label="Cód. prod."><Input className="min-h-11 text-center text-base" value={item.productCode || ''} readOnly={!editable} onChange={event => onUpdate(index, { productCode: event.target.value })} /></MobileField><MobileField label="Grupo de compra"><PurchaseGroupSelect value={item.purchaseGroupId} disabled={!groupEditable} groups={purchaseGroups} onChange={onGroupChange} /></MobileField></div>
      <fieldset className="rounded-md border p-2"><legend className="px-1 text-xs font-semibold text-muted-foreground">Dados da nota</legend><div className="grid grid-cols-2 gap-2"><MobileField label="Quantidade NF"><DecimalInput value={item.quantity} readOnly={!editable} onChange={quantity => onUpdate(index, { quantity, totalPrice: quantity * Number(item.unitPrice || 0), stockQuantity: quantity * factor })} /></MobileField><MobileField label="Unidade NF"><Input className="min-h-11 text-center text-base" value={item.unit || 'UN'} readOnly={!editable} onChange={event => onUpdate(index, { unit: event.target.value, stockUnit: fiscalItemStockUnit(item) === (item.unit || 'UN') ? event.target.value : item.stockUnit })} /></MobileField><MoneyInput label="Valor unitário NF" value={item.unitPrice} readOnly={!editable} onChange={unitPrice => onUpdate(index, { unitPrice: unitPrice ?? 0, totalPrice: Number(item.quantity || 0) * Number(unitPrice || 0) })} /><MoneyInput label="Total do item NF" value={item.totalPrice} readOnly={!editable} onChange={totalPrice => onUpdate(index, { totalPrice: totalPrice ?? 0, unitPrice: Number(item.quantity || 0) > 0 ? Number(totalPrice || 0) / Number(item.quantity) : 0 })} /></div></fieldset>
      {editable ? <fieldset className="rounded-md border p-2"><legend className="px-1 text-xs font-semibold text-muted-foreground">Entrada no estoque</legend><div className="grid grid-cols-2 gap-2"><MobileField label="Quantidade estoque"><DecimalInput value={stockQuantity} readOnly={false} onChange={value => onUpdate(index, { stockQuantity: value, conversionFactor: Number(item.quantity || 0) > 0 ? value / Number(item.quantity) : 1 })} /></MobileField><MobileField label="Unidade estoque"><Input className="min-h-11 text-center text-base" value={fiscalItemStockUnit(item)} onChange={event => onUpdate(index, { stockUnit: event.target.value })} /></MobileField><MobileField label="Fator de conversão"><DecimalInput value={factor} readOnly={false} onChange={value => onUpdate(index, { conversionFactor: value, stockQuantity: Number(item.quantity || 0) * value })} /></MobileField><MobileValue label="V. unit. global" value={money(fiscalItemGlobalUnitPrice(item, note))} /><div className="col-span-2"><MobileValue label="V. total global" value={money(fiscalItemGlobalTotal(item, note))} /></div></div></fieldset> : <fieldset className="rounded-md border p-2"><legend className="px-1 text-xs font-semibold text-muted-foreground">Custo real rateado</legend><div className="grid grid-cols-2 gap-2"><MobileValue label="V. unit. global" value={money(fiscalItemGlobalUnitPrice(item, note))} /><MobileValue label="V. total global" value={money(fiscalItemGlobalTotal(item, note))} /></div></fieldset>}
      {editable && <Button variant="outline" className="min-h-11 w-full text-destructive" onClick={onRemove}><Trash2 className="mr-2 h-4 w-4" />Remover item</Button>}
    </div>}
  </article>;
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
  return <div className="rounded-lg border bg-card p-4"><div className="flex items-start justify-between gap-2"><div><div className="font-semibold">{note.supplierName || 'Fornecedor não identificado'}</div><div className="mt-1 text-sm text-muted-foreground">Nº {sequence} · Nota {note.invoiceNumber || '—'}</div></div><div className="flex max-w-[55%] flex-col items-end gap-1"><StatusBadge note={note} /><CostReviewBadge note={note} /></div></div><dl className="mt-3 grid grid-cols-2 gap-2 text-sm"><div><dt className="text-xs text-muted-foreground">CNPJ</dt><dd>{note.supplierCnpj || '—'}</dd></div><div><dt className="text-xs text-muted-foreground">UF fornecedor/obra</dt><dd>{note.supplierState || '—'} / {note.destinationState || '—'}</dd></div><div><dt className="text-xs text-muted-foreground">Data</dt><dd>{note.issueDate ? note.issueDate.split('-').reverse().join('/') : '—'}</dd></div><div><dt className="text-xs text-muted-foreground">Itens</dt><dd>{note.items.length}</dd></div><div className="col-span-2"><dt className="text-xs text-muted-foreground">Valor informado na NF</dt><dd className="font-semibold">{money(note.totalAmount)}</dd></div></dl><WarehouseAuditIdentity createdBy={note.createdBy} updatedBy={note.updatedBy} legacyCreatedBy={note.stockPostedBy} className="mt-3 space-y-1 rounded-md bg-muted/40 p-2 text-xs" /><div className="mt-3 grid grid-cols-[44px_1fr] gap-2"><Button size="icon" variant="outline" className="min-h-11 min-w-11" aria-label="Abrir documento original" onClick={onOpenAttachment}><Eye className="h-4 w-4" /></Button><Button className="min-h-11" variant="outline" onClick={onOpen}>Visualizar dados e grupos</Button></div></div>;
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
