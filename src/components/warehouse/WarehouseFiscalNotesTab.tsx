import { useMemo, useRef, useState } from 'react';
import type { Project, WarehouseFiscalNote, WarehouseFiscalNoteItem, WarehouseFiscalNoteStatus } from '@/types/project';
import { makeAttachment, nowWarehouseISO, uidWarehouse, upsertFiscalNote, deleteFiscalNote } from '@/lib/warehouse';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FileText, Loader2, Plus, Save, Search, Trash2, Upload, XCircle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

interface Props {
  project: Project;
  onProjectChange: (next: Project) => void;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'heic', 'heif'];

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

function validateFile(file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ACCEPTED_EXTENSIONS.includes(ext)) throw new Error('Envie PDF, PNG, JPG, JPEG ou HEIC.');
  if (file.size > MAX_FILE_SIZE) throw new Error('O arquivo deve ter no máximo 10 MB.');
}

function emptyItem(): WarehouseFiscalNoteItem {
  return { id: uidWarehouse(), description: '', quantity: 1, unit: 'UN', unitPrice: 0, totalPrice: 0 };
}

export default function WarehouseFiscalNotesTab({ project, onProjectChange }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [search, setSearch] = useState('');
  const [activeStatus, setActiveStatus] = useState<WarehouseFiscalNoteStatus>('a_conferir');
  const [processing, setProcessing] = useState(false);
  const [selected, setSelected] = useState<WarehouseFiscalNote | null>(null);
  const notes = project.warehouse?.fiscalNotes ?? [];

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

  const saveNote = (note: WarehouseFiscalNote) => {
    const normalized = {
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
      let parsed: ReturnType<typeof parseFiscalNoteText> = { totalAmount: 0, items: [] };
      let processingError: string | undefined;

      if (isPdf) {
        extractedText = await extractPdfText(file);
        parsed = parseFiscalNoteText(extractedText);
      } else {
        processingError = 'Imagem anexada. Conecte o OCR/IA real para extrair automaticamente os dados de imagens.';
      }

      const note: WarehouseFiscalNote = {
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
        items: parsed.items ?? [],
        notes: parsed.notes,
        processingError,
        extractedText,
      };
      onProjectChange(upsertFiscalNote(project, note));
      setActiveStatus('a_conferir');
      setSelected(note);
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

  const setStatus = (status: WarehouseFiscalNoteStatus) => {
    if (!selected) return;
    if (status === 'aprovada' && selected.items.length === 0) {
      toast.error('Inclua pelo menos um item antes de aprovar.');
      return;
    }
    const next = { ...selected, status, updatedAt: nowWarehouseISO() };
    saveNote(next);
    setActiveStatus(status);
    toast.success(status === 'aprovada' ? 'Nota aprovada.' : 'Nota rejeitada.');
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
          accept=".pdf,.png,.jpg,.jpeg,.heic,.heif,application/pdf,image/png,image/jpeg,image/heic,image/heif"
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
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(note => (
                    <tr key={note.id} className="border-t border-border hover:bg-muted/30 cursor-pointer" onClick={() => setSelected(note)}>
                      <td className="p-2 font-medium">{note.supplierName || '-'}</td>
                      <td className="p-2 font-mono text-[11px] text-muted-foreground">{note.supplierCnpj || '-'}</td>
                      <td className="p-2">{note.invoiceNumber || '-'}</td>
                      <td className="p-2">{note.issueDate ? note.issueDate.split('-').reverse().join('/') : '-'}</td>
                      <td className="p-2 max-w-48 truncate" title={note.sourceFileName}>{note.sourceFileName}</td>
                      <td className="p-2 text-center tabular-nums">{note.items.length}</td>
                      <td className="p-2 text-right font-semibold">{moneyBR(note.totalAmount)}</td>
                      <td className="p-2"><Badge variant="outline" className={STATUS_CLASS[note.status]}>{STATUS_LABEL[note.status]}</Badge></td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={8} className="p-8 text-center">
                        <FileText className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
                        <div className="font-medium">Nenhuma nota nessa caixa</div>
                        <div className="text-xs text-muted-foreground">Envie PDF ou imagem de uma nota fiscal. O PDF com texto já é lido e fica pronto para conferência.</div>
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
        <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>Conferência da nota fiscal</DialogTitle>
                <DialogDescription>Confira os dados extraídos antes de aprovar para uso gerencial no almoxarifado.</DialogDescription>
              </DialogHeader>

              {selected.processingError && <div className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">{selected.processingError}</div>}

              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1 col-span-2">
                  <span className="text-xs font-medium">Fornecedor</span>
                  <Input value={selected.supplierName ?? ''} onChange={e => updateSelected({ supplierName: e.target.value })} className="h-8 text-xs" />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium">CNPJ</span>
                  <Input value={selected.supplierCnpj ?? ''} onChange={e => updateSelected({ supplierCnpj: e.target.value })} className="h-8 text-xs" />
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
                  <span className="text-xs font-medium">Observações</span>
                  <Textarea value={selected.notes ?? ''} onChange={e => updateSelected({ notes: e.target.value })} className="min-h-16 text-xs" />
                </label>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Itens extraídos</h3>
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => updateSelected({ items: [...selected.items, emptyItem()] })}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> Adicionar item
                  </Button>
                </div>
                <div className="space-y-2">
                  {selected.items.map((item, idx) => (
                    <div key={item.id} className="grid grid-cols-12 gap-2 rounded-md border border-border p-2">
                      <Input className="col-span-5 h-8 text-xs" value={item.description} placeholder="Descrição" onChange={e => updateItem(idx, { description: e.target.value })} />
                      <Input className="col-span-1 h-8 text-xs" type="number" step="0.001" value={item.quantity} onChange={e => updateItem(idx, { quantity: Number(e.target.value) })} />
                      <Input className="col-span-1 h-8 text-xs" value={item.unit ?? ''} placeholder="Un" onChange={e => updateItem(idx, { unit: e.target.value })} />
                      <Input className="col-span-2 h-8 text-xs" type="number" step="0.01" value={item.unitPrice} onChange={e => updateItem(idx, { unitPrice: Number(e.target.value) })} />
                      <Input className="col-span-2 h-8 text-xs" type="number" step="0.01" value={item.totalPrice} onChange={e => updateItem(idx, { totalPrice: Number(e.target.value) })} />
                      <Button variant="ghost" size="icon" className="col-span-1 h-8 w-8" onClick={() => updateSelected({ items: selected.items.filter((_, i) => i !== idx) })}>
                        <Trash2 className="w-3.5 h-3.5 text-destructive" />
                      </Button>
                    </div>
                  ))}
                  {selected.items.length === 0 && <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">Nenhum item extraído. Adicione os materiais manualmente para aprovar.</div>}
                </div>
              </div>

              <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-3">
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    onProjectChange(deleteFiscalNote(project, selected.id));
                    setSelected(null);
                    toast.success('Nota removida.');
                  }}
                >
                  <Trash2 className="w-4 h-4 mr-2" /> Remover
                </Button>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => saveNote(selected)}><Save className="w-4 h-4 mr-2" /> Salvar alterações</Button>
                  <Button variant="destructive" onClick={() => setStatus('rejeitada')}><XCircle className="w-4 h-4 mr-2" /> Rejeitar</Button>
                  <Button onClick={() => setStatus('aprovada')}><CheckCircle2 className="w-4 h-4 mr-2" /> Aprovar nota</Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
