import { useMemo, useRef, useState } from 'react';
import type { Project, WarehouseFiscalNote, WarehouseFiscalNoteItem, WarehouseFiscalNoteStatus } from '@/types/project';
import {
  approveFiscalNote,
  computeWarehouseRows,
  createManualWarehouseItem,
  deleteFiscalNote,
  findFiscalNoteDuplicate,
  findMaterialMatch,
  isValidCnpj,
  makeAttachment,
  nowWarehouseISO,
  readFileAsDataURL,
  uidWarehouse,
  upsertFiscalNote,
} from '@/lib/warehouse';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Eye,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Save,
  Search,
  Sparkles,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

interface Props {
  project: Project;
  onProjectChange: (next: Project) => void;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp'];
const MAX_PDF_AI_PAGES = 4;
const MATCH_SCORE_THRESHOLD = 0.45;

const STATUS_LABEL: Record<WarehouseFiscalNoteStatus, string> = {
  em_processamento: 'Em processamento',
  a_conferir: 'A conferir',
  aprovada: 'Aprovadas',
  rejeitada: 'Rejeitadas',
};

const STATUS_CLASS: Record<WarehouseFiscalNoteStatus, string> = {
  em_processamento: 'bg-warning/20 text-warning border-warning/30',
  a_conferir: 'bg-primary/10 text-primary border-primary/20',
  aprovada: 'bg-success/15 text-success border-success/25',
  rejeitada: 'bg-destructive/15 text-destructive border-destructive/25',
};

function moneyBR(value: number) {
  return (Number(value) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function parseMoney(raw?: string) {
  if (!raw) return 0;
  const cleaned = raw.replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : 0;
}

function parseNumber(raw?: string) {
  if (!raw) return 0;
  const value = Number(raw.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : 0;
}

function normalizeCnpj(value?: string) {
  const digits = (value ?? '').replace(/\D/g, '');
  if (digits.length !== 14) return value ?? '';
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function parseFiscalNoteText(text: string): Pick<WarehouseFiscalNote, 'supplierName' | 'supplierCnpj' | 'invoiceNumber' | 'issueDate' | 'totalAmount' | 'items' | 'notes'> {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const cnpj = text.match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/)?.[0];
  const invoiceNumber =
    text.match(/(?:NF-e|NFe|Nota Fiscal|N[ºo]\.?|Numero|Número)\s*(?:n[ºo]\.?)?\s*[:\-]?\s*(\d{3,})/i)?.[1] ??
    text.match(/\bNFC?e?\s*(\d{3,})\b/i)?.[1];
  const issueDateRaw =
    text.match(/(?:emissao|emissão|data)\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1] ??
    text.match(/\b(\d{2}\/\d{2}\/\d{4})\b/)?.[1];
  const issueDate = issueDateRaw ? issueDateRaw.split('/').reverse().join('-') : undefined;
  const totalRaw =
    text.match(/(?:valor total|total da nota|total)\s*(?:R\$)?\s*[:\-]?\s*([\d.]+,\d{2})/i)?.[1] ??
    [...text.matchAll(/R\$\s*([\d.]+,\d{2})/gi)].pop()?.[1];
  const supplierName =
    lines.find(line => /LTDA|EIRELI|S\/A|COMERC|MATERIA|CONSTRU|FERRAGEM|ELETRIC|ELÉTRIC/i.test(line) && !/NOTA|DANFE|CNPJ/i.test(line)) ??
    lines.slice(0, 8).find(line => line.length > 8 && !/\d{2}\/\d{2}\/\d{4}|DANFE|NOTA|CNPJ/i.test(line));
  const itemPattern = /^(.{4,}?)\s+(\d+(?:[.,]\d+)?)\s*(UN|UND|UNID|M|M2|M3|KG|L|PC|PÇ|CX|RL)?\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})$/i;
  const items: WarehouseFiscalNoteItem[] = [];

  for (const line of lines) {
    const match = line.match(itemPattern);
    if (!match) continue;
    const description = match[1].trim();
    if (/subtotal|desconto|total/i.test(description)) continue;
    const quantity = parseNumber(match[2]);
    const unitPrice = parseMoney(match[4]);
    const totalPrice = parseMoney(match[5]);
    if (!description || (!quantity && !totalPrice)) continue;
    items.push({
      id: uidWarehouse(),
      description,
      quantity: quantity || 1,
      unit: match[3]?.toUpperCase() || 'UN',
      unitPrice,
      totalPrice: totalPrice || unitPrice * (quantity || 1),
    });
  }

  return {
    supplierName,
    supplierCnpj: normalizeCnpj(cnpj),
    invoiceNumber,
    issueDate,
    totalAmount: parseMoney(totalRaw) || items.reduce((sum, item) => sum + item.totalPrice, 0),
    items,
    notes: items.length ? undefined : 'PDF lido, mas os itens não ficaram claros. Confira e complete manualmente.',
  };
}

type ParsedFiscalNote = Pick<WarehouseFiscalNote, 'supplierName' | 'supplierCnpj' | 'invoiceNumber' | 'issueDate' | 'totalAmount' | 'items' | 'notes' | 'aiConfidence'>;

type AiFiscalNoteResponse = {
  ok?: boolean;
  error?: string;
  note?: {
    supplierName?: string | null;
    supplierCnpj?: string | null;
    invoiceNumber?: string | null;
    issueDate?: string | null;
    totalAmount?: number | null;
    notes?: string | null;
    confidence?: number | null;
    items?: Array<{
      description?: string;
      quantity?: number;
      unit?: string | null;
      unitPrice?: number;
      totalPrice?: number;
      category?: string | null;
      confidence?: number | null;
    }>;
  };
};

async function readWithAi(input: { fileName: string; fileType?: string; fileDataUrls?: string[]; extractedText?: string }): Promise<ParsedFiscalNote> {
  const { data, error } = await supabase.functions.invoke<AiFiscalNoteResponse>('read-fiscal-note', {
    body: {
      fileName: input.fileName,
      fileType: input.fileType,
      fileDataUrl: input.fileDataUrls?.[0],
      fileDataUrls: input.fileDataUrls,
      extractedText: input.extractedText,
    },
  });

  if (error) {
    const message = error.message || 'Falha ao chamar a leitura da nota.';
    if (/failed to send a request/i.test(message)) {
      throw new Error('Nao foi possivel conectar a funcao de leitura da nota. Confira se a Edge Function read-fiscal-note foi implantada no Supabase.');
    }
    throw new Error(message);
  }
  if (!data?.ok || !data.note) throw new Error(data?.error ?? 'A IA não conseguiu ler a nota fiscal.');

  return {
    supplierName: data.note.supplierName ?? '',
    supplierCnpj: normalizeCnpj(data.note.supplierCnpj ?? ''),
    invoiceNumber: data.note.invoiceNumber ?? '',
    issueDate: data.note.issueDate ?? '',
    totalAmount: Number(data.note.totalAmount ?? 0),
    notes: data.note.notes ?? undefined,
    aiConfidence: data.note.confidence != null ? Number(data.note.confidence) : undefined,
    items: (data.note.items ?? []).map(item => ({
      id: uidWarehouse(),
      description: item.description ?? '',
      quantity: Number(item.quantity ?? 1) || 1,
      unit: item.unit ?? 'UN',
      unitPrice: Number(item.unitPrice ?? 0),
      totalPrice: Number(item.totalPrice ?? 0),
      category: item.category ?? undefined,
      confidence: item.confidence != null ? Number(item.confidence) : undefined,
    })).filter(item => item.description.trim()),
  };
}

async function readImageWithAi(file: File): Promise<ParsedFiscalNote> {
  return readWithAi({
    fileName: file.name,
    fileType: file.type,
    fileDataUrls: [await readFileAsDataURL(file)],
  });
}

async function extractPdfText(file: File) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => ('str' in item ? String(item.str) : '')).join(' '));
  }
  return pages.join('\n');
}

async function renderPdfPagesAsImages(file: File) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const images: string[] = [];
  const totalPages = Math.min(pdf.numPages, MAX_PDF_AI_PAGES);

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.7 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) continue;
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, canvasContext: context, viewport } as Parameters<typeof page.render>[0]).promise;
    images.push(canvas.toDataURL('image/jpeg', 0.82));
  }

  return images;
}

function validateFile(file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ACCEPTED_EXTENSIONS.includes(ext)) throw new Error('Envie PDF, PNG, JPG, JPEG ou WEBP.');
  if (file.size > MAX_FILE_SIZE) throw new Error('O arquivo deve ter no máximo 10 MB.');
}

function emptyItem(): WarehouseFiscalNoteItem {
  return { id: uidWarehouse(), description: '', quantity: 1, unit: 'UN', unitPrice: 0, totalPrice: 0, linkStatus: 'pendente' };
}

function autoLinkItems(project: Project, items: WarehouseFiscalNoteItem[]): WarehouseFiscalNoteItem[] {
  return items.map(item => {
    if (item.itemKey) return item;
    const match = findMaterialMatch(project, item.description, item.unit);
    if (match && match.score >= MATCH_SCORE_THRESHOLD) {
      return { ...item, itemKey: match.key, linkStatus: 'auto' };
    }
    return { ...item, linkStatus: 'pendente' };
  });
}

function openAttachment(note: WarehouseFiscalNote) {
  const url = note.attachment?.dataUrl;
  if (!url && !note.attachment?.storagePath) {
    toast.error('Nenhum arquivo anexo encontrado.');
    return;
  }
  if (url) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  // Storage path: gerar signed URL on demand
  void (async () => {
    const { data, error } = await supabase.storage
      .from('daily-report-photos')
      .createSignedUrl(note.attachment!.storagePath!, 60);
    if (error || !data?.signedUrl) {
      toast.error('Falha ao abrir o arquivo: ' + (error?.message ?? 'sem URL'));
      return;
    }
    window.open(data.signedUrl, '_blank', 'noopener');
  })();
}

interface MaterialOption {
  key: string;
  label: string;
  unit: string;
}

export default function WarehouseFiscalNotesTab({ project, onProjectChange }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [search, setSearch] = useState('');
  const [activeStatus, setActiveStatus] = useState<WarehouseFiscalNoteStatus>('a_conferir');
  const [processing, setProcessing] = useState(false);
  const [selected, setSelected] = useState<WarehouseFiscalNote | null>(null);
  const [creatingMaterialFor, setCreatingMaterialFor] = useState<number | null>(null);
  const [newMaterial, setNewMaterial] = useState<{ code: string; description: string; unit: string }>({ code: '', description: '', unit: 'UN' });
  const notes = project.warehouse?.fiscalNotes ?? [];

  const materialOptions: MaterialOption[] = useMemo(() => {
    return computeWarehouseRows(project, { materialOnly: true, confirmedOnly: true, includeManual: true })
      .map(r => ({ key: r.key, label: `${r.code ? r.code + ' · ' : ''}${r.description}`, unit: r.unit }))
      .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  }, [project]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return notes
      .filter(note => note.status === activeStatus)
      .filter(note => !q || [note.supplierName, note.supplierCnpj, note.invoiceNumber, note.sourceFileName].some(v => (v ?? '').toLowerCase().includes(q)));
  }, [activeStatus, notes, search]);

  const counts = useMemo(() => ({
    em_processamento: notes.filter(n => n.status === 'em_processamento').length,
    a_conferir: notes.filter(n => n.status === 'a_conferir').length,
    aprovada: notes.filter(n => n.status === 'aprovada').length,
    rejeitada: notes.filter(n => n.status === 'rejeitada').length,
  }), [notes]);

  const itemsSum = useMemo(() => {
    if (!selected) return 0;
    return selected.items.reduce((s, it) => s + Number(it.totalPrice || 0), 0);
  }, [selected]);

  const totalsDiff = selected ? Math.abs(Number(selected.totalAmount || 0) - itemsSum) : 0;
  const totalsMismatch = !!selected && totalsDiff > 0.01;
  const pendingLinks = selected ? selected.items.filter(it => !it.itemKey).length : 0;

  const saveNote = (note: WarehouseFiscalNote) => {
    const normalized: WarehouseFiscalNote = {
      ...note,
      totalAmount: Number(note.totalAmount || 0),
      items: note.items.map(item => ({
        ...item,
        quantity: Number(item.quantity || 0),
        unitPrice: Number(item.unitPrice || 0),
        totalPrice: Number(item.totalPrice || 0),
      })),
    };
    onProjectChange(upsertFiscalNote(project, normalized));
    setSelected(normalized);
  };

  const handleUpload = async (file: File) => {
    try {
      validateFile(file);
      setProcessing(true);
      const createdAt = nowWarehouseISO();
      const attachment = await makeAttachment(file, project.id, 'nf');
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      let extractedText = '';
      let parsed: ParsedFiscalNote = { totalAmount: 0, items: [] };
      let processingError: string | undefined;

      if (isPdf) {
        extractedText = await extractPdfText(file);
        const textParsed = extractedText.trim() ? parseFiscalNoteText(extractedText) : undefined;
        try {
          const pageImages = await renderPdfPagesAsImages(file);
          parsed = await readWithAi({
            fileName: file.name,
            fileType: file.type,
            fileDataUrls: pageImages,
            extractedText,
          });
        } catch (err) {
          if (textParsed) {
            parsed = textParsed;
            processingError = `A IA nao conseguiu revisar o PDF; usei a leitura textual: ${(err as Error).message}`;
          } else {
            processingError = `Nao foi possivel ler o PDF automaticamente: ${(err as Error).message}`;
          }
        }
      } else {
        try {
          parsed = await readImageWithAi(file);
        } catch (err) {
          if (/funcao de leitura da nota|Edge Function read-fiscal-note/i.test((err as Error).message)) {
            throw err;
          }
          processingError = `Não foi possível ler a imagem automaticamente: ${(err as Error).message}`;
        }
      }

      const items = autoLinkItems(project, parsed.items ?? []);

      const baseNote: WarehouseFiscalNote = {
        id: uidWarehouse(),
        createdAt,
        updatedAt: createdAt,
        status: 'a_conferir',
        origin: 'upload',
        sourceFileName: file.name,
        sourceMimeType: file.type,
        attachment,
        supplierName: parsed.supplierName ?? '',
        supplierCnpj: parsed.supplierCnpj ?? '',
        invoiceNumber: parsed.invoiceNumber ?? '',
        issueDate: parsed.issueDate ?? '',
        totalAmount: parsed.totalAmount ?? 0,
        items,
        notes: parsed.notes,
        aiConfidence: parsed.aiConfidence,
        processingError,
        extractedText,
      };

      const duplicate = findFiscalNoteDuplicate(project, baseNote);
      if (duplicate) {
        const proceed = window.confirm(
          `Esta nota fiscal aparentemente já foi cadastrada (NF ${duplicate.invoiceNumber} · ${duplicate.supplierName}). Deseja continuar mesmo assim?`,
        );
        if (!proceed) {
          toast.message('Upload cancelado. Nota duplicada identificada.');
          setProcessing(false);
          if (inputRef.current) inputRef.current.value = '';
          return;
        }
      }

      onProjectChange(upsertFiscalNote(project, baseNote));
      setActiveStatus('a_conferir');
      setSelected(baseNote);
      toast.success('Nota enviada para conferência.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setProcessing(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const updateSelected = (patch: Partial<WarehouseFiscalNote>) => {
    if (selected) setSelected({ ...selected, ...patch });
  };

  const updateItem = (idx: number, patch: Partial<WarehouseFiscalNoteItem>) => {
    if (!selected) return;
    const items = [...selected.items];
    const next = { ...items[idx], ...patch };
    if (patch.quantity !== undefined || patch.unitPrice !== undefined) {
      next.totalPrice = Number(next.quantity || 0) * Number(next.unitPrice || 0);
    }
    items[idx] = next;
    setSelected({ ...selected, items });
  };

  const linkItem = (idx: number, key: string) => {
    if (!selected) return;
    if (key === '__pending__') {
      updateItem(idx, { itemKey: undefined, linkStatus: 'pendente' });
      return;
    }
    if (key === '__new__') {
      setCreatingMaterialFor(idx);
      const it = selected.items[idx];
      setNewMaterial({ code: '', description: it.description, unit: it.unit || 'UN' });
      return;
    }
    updateItem(idx, { itemKey: key, linkStatus: 'vinculado' });
  };

  const confirmCreateMaterial = () => {
    if (creatingMaterialFor == null || !selected) return;
    if (!newMaterial.description.trim() || !newMaterial.unit.trim()) {
      toast.error('Descrição e unidade são obrigatórios.');
      return;
    }
    const nextProject = createManualWarehouseItem(project, newMaterial);
    // descobre a chave criada (último item adicionado em warehouse.items)
    const created = nextProject.warehouse?.items.find(i =>
      i.description === newMaterial.description.trim() && i.unit === newMaterial.unit.trim(),
    );
    onProjectChange(nextProject);
    if (created) updateItem(creatingMaterialFor, { itemKey: created.key, linkStatus: 'vinculado' });
    setCreatingMaterialFor(null);
    setNewMaterial({ code: '', description: '', unit: 'UN' });
    toast.success('Material criado e vinculado.');
  };

  const validateBeforeApprove = (): string | null => {
    if (!selected) return 'Nota não encontrada.';
    if (!selected.supplierName?.trim()) return 'Informe o fornecedor.';
    if (!isValidCnpj(selected.supplierCnpj)) return 'CNPJ inválido.';
    if (!selected.invoiceNumber?.trim()) return 'Informe o número da nota.';
    if (selected.items.length === 0) return 'Inclua pelo menos um item.';
    const badQty = selected.items.find(it => !(Number(it.quantity) > 0));
    if (badQty) return `Quantidade inválida no item: ${badQty.description || '(sem descrição)'}`;
    if (totalsMismatch && !selected.totalsJustification?.trim()) {
      return `Soma dos itens (${moneyBR(itemsSum)}) difere do total da nota. Preencha uma justificativa em Observações para aprovar.`;
    }
    return null;
  };

  const handleApprove = () => {
    if (!selected) return;
    const err = validateBeforeApprove();
    if (err) {
      toast.error(err);
      return;
    }
    const duplicate = findFiscalNoteDuplicate(project, selected);
    if (duplicate) {
      const proceed = window.confirm(
        `Esta nota fiscal aparentemente já foi cadastrada (NF ${duplicate.invoiceNumber} · ${duplicate.supplierName}). Deseja continuar mesmo assim?`,
      );
      if (!proceed) return;
    }
    const saved = upsertFiscalNote(project, { ...selected, updatedAt: nowWarehouseISO() });
    const approved = approveFiscalNote(saved, selected.id);
    onProjectChange(approved);
    const approvedNote = approved.warehouse?.fiscalNotes?.find(note => note.id === selected.id) ?? null;
    setSelected(approvedNote);
    setActiveStatus('aprovada');
    toast.success('Nota aprovada e entrada lançada nos materiais.');
  };

  const handleReject = () => {
    if (!selected) return;
    const next = { ...selected, status: 'rejeitada' as WarehouseFiscalNoteStatus, updatedAt: nowWarehouseISO() };
    saveNote(next);
    setActiveStatus('rejeitada');
    toast.success('Nota rejeitada.');
  };

  const handleDelete = (note: WarehouseFiscalNote) => {
    if (!window.confirm(`Excluir a nota ${note.invoiceNumber || note.sourceFileName}?`)) return;
    onProjectChange(deleteFiscalNote(project, note.id));
    if (selected?.id === note.id) setSelected(null);
    toast.success('Nota removida.');
  };

  const linkBadge = (item: WarehouseFiscalNoteItem) => {
    if (item.itemKey) {
      return <Badge variant="outline" className="bg-success/10 text-success border-success/25 text-[10px]">{item.linkStatus === 'auto' ? 'Auto' : 'Vinculado'}</Badge>;
    }
    return <Badge variant="outline" className="bg-warning/15 text-warning border-warning/25 text-[10px]">Pendente</Badge>;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2">
        <div className="relative min-w-56 flex-1 max-w-md">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por fornecedor, CNPJ ou número..." className="h-8 pl-7 text-xs" />
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) void handleUpload(file);
          }}
        />
        <Button size="sm" className="h-8 text-xs" onClick={() => inputRef.current?.click()} disabled={processing}>
          {processing ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Upload className="w-3.5 h-3.5 mr-1" />}
          Enviar nota fiscal
        </Button>
      </div>

      <Tabs value={activeStatus} onValueChange={value => setActiveStatus(value as WarehouseFiscalNoteStatus)}>
        <TabsList className="bg-muted h-9 flex-wrap">
          {(Object.keys(STATUS_LABEL) as WarehouseFiscalNoteStatus[]).map(status => (
            <TabsTrigger key={status} value={status} className="text-xs">
              {STATUS_LABEL[status]} ({counts[status]})
            </TabsTrigger>
          ))}
        </TabsList>

        {(Object.keys(STATUS_LABEL) as WarehouseFiscalNoteStatus[]).map(status => (
          <TabsContent key={status} value={status} className="mt-3">
            <div className="bg-card border border-border rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left">Fornecedor</th>
                    <th className="p-2 text-left">CNPJ</th>
                    <th className="p-2 text-left">Nota</th>
                    <th className="p-2 text-left">Data</th>
                    <th className="p-2 text-left">Arquivo</th>
                    <th className="p-2 text-center">Itens</th>
                    <th className="p-2 text-right">Valor</th>
                    <th className="p-2 text-left">Status</th>
                    <th className="p-2 text-center">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(note => {
                    const pending = note.items.filter(i => !i.itemKey).length;
                    return (
                      <tr key={note.id} className="border-t border-border hover:bg-muted/30">
                        <td className="p-2 font-medium">{note.supplierName || '-'}</td>
                        <td className="p-2 font-mono text-[11px] text-muted-foreground">{note.supplierCnpj || '-'}</td>
                        <td className="p-2">{note.invoiceNumber || '-'}</td>
                        <td className="p-2">{note.issueDate ? note.issueDate.split('-').reverse().join('/') : '-'}</td>
                        <td className="p-2 max-w-48 truncate" title={note.sourceFileName}>{note.sourceFileName}</td>
                        <td className="p-2 text-center tabular-nums">
                          {note.items.length}
                          {pending > 0 && note.status === 'aprovada' && (
                            <span className="ml-1 text-warning" title={`${pending} item(ns) sem vínculo`}>•</span>
                          )}
                        </td>
                        <td className="p-2 text-right font-semibold">{moneyBR(note.totalAmount)}</td>
                        <td className="p-2">
                          <div className="flex flex-col gap-1">
                            <Badge variant="outline" className={STATUS_CLASS[note.status]}>{STATUS_LABEL[note.status]}</Badge>
                            {pending > 0 && note.status === 'aprovada' && (
                              <span className="text-[10px] text-warning">Pendente vínculo</span>
                            )}
                          </div>
                        </td>
                        <td className="p-2">
                          <div className="flex items-center justify-center gap-1">
                            <Button size="icon" variant="ghost" className="h-7 w-7" title="Visualizar arquivo" onClick={() => openAttachment(note)}>
                              <Eye className="w-3.5 h-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7" title="Conferir / Editar" onClick={() => setSelected(note)}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            {note.status !== 'aprovada' && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 text-success hover:text-success"
                                title="Aprovar"
                                onClick={() => { setSelected(note); setTimeout(() => handleApprove(), 0); }}
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                              </Button>
                            )}
                            {note.status !== 'rejeitada' && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 text-destructive hover:text-destructive"
                                title="Rejeitar"
                                onClick={() => { setSelected(note); setTimeout(() => handleReject(), 0); }}
                              >
                                <XCircle className="w-3.5 h-3.5" />
                              </Button>
                            )}
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" title="Excluir" onClick={() => handleDelete(note)}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={9} className="p-8 text-center">
                        <FileText className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
                        <div className="font-medium">Nenhuma nota nessa caixa</div>
                        <div className="text-xs text-muted-foreground">Envie PDF, PNG, JPG ou WEBP de uma nota fiscal. A IA vai ler e preparar para conferência.</div>
                        <Button size="sm" className="mt-3 h-8 text-xs" onClick={() => inputRef.current?.click()}>
                          <Upload className="w-3.5 h-3.5 mr-1" /> Enviar primeira nota
                        </Button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </TabsContent>
        ))}
      </Tabs>

      <Dialog open={!!selected} onOpenChange={open => !open && setSelected(null)}>
        <DialogContent className="max-w-6xl max-h-[92vh] overflow-y-auto">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  Conferência da nota fiscal
                  {selected.aiConfidence != null && (
                    <Badge variant="outline" className="text-[10px] gap-1">
                      <Sparkles className="w-3 h-3" /> IA {Math.round(selected.aiConfidence * 100)}%
                    </Badge>
                  )}
                </DialogTitle>
                <DialogDescription>Confira e corrija os dados extraídos antes de aprovar. Materiais são vinculados ao almoxarifado da obra.</DialogDescription>
              </DialogHeader>

              {selected.processingError && <div className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">{selected.processingError}</div>}

              {totalsMismatch && (
                <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    Soma dos itens (<b>{moneyBR(itemsSum)}</b>) difere do valor total da nota (<b>{moneyBR(selected.totalAmount)}</b>).
                    Para aprovar, preencha uma justificativa abaixo no campo Observações.
                  </div>
                </div>
              )}

              {pendingLinks > 0 && (
                <div className="rounded-md border border-primary/30 bg-primary/5 p-2 text-xs">
                  {pendingLinks} item(ns) sem material vinculado. Vincule abaixo ou aprove para tratar depois.
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1 col-span-2">
                  <span className="text-xs font-medium">Fornecedor</span>
                  <Input value={selected.supplierName ?? ''} onChange={e => updateSelected({ supplierName: e.target.value })} className="h-8 text-xs" />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium">CNPJ</span>
                  <Input value={selected.supplierCnpj ?? ''} onChange={e => updateSelected({ supplierCnpj: e.target.value })} className={`h-8 text-xs ${selected.supplierCnpj && !isValidCnpj(selected.supplierCnpj) ? 'border-destructive' : ''}`} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium">Número da nota</span>
                  <Input value={selected.invoiceNumber ?? ''} onChange={e => updateSelected({ invoiceNumber: e.target.value })} className="h-8 text-xs" />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium">Data de emissão</span>
                  <Input type="date" value={selected.issueDate ?? ''} onChange={e => updateSelected({ issueDate: e.target.value })} className="h-8 text-xs" />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium">Valor total</span>
                  <Input type="number" step="0.01" value={selected.totalAmount} onChange={e => updateSelected({ totalAmount: Number(e.target.value) })} className="h-8 text-xs" />
                </label>
                <label className="space-y-1 col-span-2">
                  <span className="text-xs font-medium flex items-center gap-2">
                    Observações {totalsMismatch && <span className="text-warning">(justifique a diferença)</span>}
                  </span>
                  <Textarea
                    value={selected.notes ?? selected.totalsJustification ?? ''}
                    onChange={e => updateSelected({ notes: e.target.value, totalsJustification: totalsMismatch ? e.target.value : selected.totalsJustification })}
                    className="min-h-16 text-xs"
                  />
                </label>
                {selected.attachment && (
                  <div className="col-span-2 text-xs">
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openAttachment(selected)}>
                      <ExternalLink className="w-3.5 h-3.5 mr-1" /> Abrir arquivo anexo
                    </Button>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Itens da nota</h3>
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => updateSelected({ items: [...selected.items, emptyItem()] })}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> Adicionar item
                  </Button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted text-muted-foreground">
                      <tr>
                        <th className="p-1.5 text-left">Descrição</th>
                        <th className="p-1.5 text-right w-16">Qtd</th>
                        <th className="p-1.5 text-center w-16">Un</th>
                        <th className="p-1.5 text-right w-24">V. Unit</th>
                        <th className="p-1.5 text-right w-24">V. Total</th>
                        <th className="p-1.5 text-left w-72">Material vinculado</th>
                        <th className="p-1.5 w-8"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.items.map((item, idx) => (
                        <tr key={item.id} className="border-t border-border">
                          <td className="p-1">
                            <Input className="h-8 text-xs" value={item.description} placeholder="Descrição"
                              onChange={e => updateItem(idx, { description: e.target.value })} />
                            {item.confidence != null && (
                              <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
                                <Sparkles className="w-2.5 h-2.5" /> IA {Math.round(item.confidence * 100)}%
                              </div>
                            )}
                          </td>
                          <td className="p-1">
                            <Input className="h-8 text-xs text-right" type="number" step="0.001" value={item.quantity}
                              onChange={e => updateItem(idx, { quantity: Number(e.target.value) })} />
                          </td>
                          <td className="p-1">
                            <Input className="h-8 text-xs text-center" value={item.unit ?? ''} placeholder="Un"
                              onChange={e => updateItem(idx, { unit: e.target.value })} />
                          </td>
                          <td className="p-1">
                            <Input className="h-8 text-xs text-right" type="number" step="0.01" value={item.unitPrice}
                              onChange={e => updateItem(idx, { unitPrice: Number(e.target.value) })} />
                          </td>
                          <td className="p-1">
                            <Input className="h-8 text-xs text-right" type="number" step="0.01" value={item.totalPrice}
                              onChange={e => updateItem(idx, { totalPrice: Number(e.target.value) })} />
                          </td>
                          <td className="p-1">
                            <div className="flex items-center gap-1">
                              <Select value={item.itemKey ?? '__pending__'} onValueChange={v => linkItem(idx, v)}>
                                <SelectTrigger className="h-8 text-xs flex-1">
                                  <SelectValue placeholder="Vincular material" />
                                </SelectTrigger>
                                <SelectContent className="max-h-72 z-50 bg-popover">
                                  <SelectItem value="__pending__">Deixar pendente</SelectItem>
                                  <SelectItem value="__new__">+ Criar novo material</SelectItem>
                                  {materialOptions.map(opt => (
                                    <SelectItem key={opt.key} value={opt.key}>{opt.label} ({opt.unit})</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              {linkBadge(item)}
                            </div>
                          </td>
                          <td className="p-1">
                            <Button variant="ghost" size="icon" className="h-8 w-8"
                              onClick={() => updateSelected({ items: selected.items.filter((_, i) => i !== idx) })}>
                              <Trash2 className="w-3.5 h-3.5 text-destructive" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                      {selected.items.length === 0 && (
                        <tr><td colSpan={7} className="p-4 text-center text-xs text-muted-foreground">Nenhum item. Adicione manualmente para aprovar.</td></tr>
                      )}
                    </tbody>
                    {selected.items.length > 0 && (
                      <tfoot>
                        <tr className="border-t-2 border-border bg-muted/40 font-semibold">
                          <td className="p-1.5 text-right" colSpan={4}>Soma dos itens:</td>
                          <td className={`p-1.5 text-right tabular-nums ${totalsMismatch ? 'text-warning' : ''}`}>{moneyBR(itemsSum)}</td>
                          <td colSpan={2}></td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>

              <DialogFooter className="flex flex-wrap justify-between gap-2 border-t border-border pt-3">
                <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => handleDelete(selected)}>
                  <Trash2 className="w-4 h-4 mr-2" /> Remover
                </Button>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => saveNote(selected)}><Save className="w-4 h-4 mr-2" /> Salvar alterações</Button>
                  <Button variant="destructive" onClick={handleReject}><XCircle className="w-4 h-4 mr-2" /> Rejeitar</Button>
                  <Button onClick={handleApprove}><CheckCircle2 className="w-4 h-4 mr-2" /> Confirmar e salvar</Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={creatingMaterialFor != null} onOpenChange={open => !open && setCreatingMaterialFor(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Criar material no almoxarifado</DialogTitle>
            <DialogDescription>Este material será adicionado e vinculado ao item da nota.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="space-y-1 block">
              <span className="text-xs font-medium">Código (opcional)</span>
              <Input value={newMaterial.code} onChange={e => setNewMaterial({ ...newMaterial, code: e.target.value })} className="h-8 text-xs" />
            </label>
            <label className="space-y-1 block">
              <span className="text-xs font-medium">Descrição</span>
              <Input value={newMaterial.description} onChange={e => setNewMaterial({ ...newMaterial, description: e.target.value })} className="h-8 text-xs" />
            </label>
            <label className="space-y-1 block">
              <span className="text-xs font-medium">Unidade</span>
              <Input value={newMaterial.unit} onChange={e => setNewMaterial({ ...newMaterial, unit: e.target.value })} className="h-8 text-xs" />
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreatingMaterialFor(null)}>Cancelar</Button>
            <Button onClick={confirmCreateMaterial}>Criar e vincular</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
