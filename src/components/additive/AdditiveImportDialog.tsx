import { useEffect, useMemo, useState } from 'react';
import { FileSpreadsheet, Table2, Upload, ArrowLeft, CheckCircle2, AlertTriangle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import type { Additive } from '@/types/project';
import {
  inspectAnalyticWorkbook,
  inspectSyntheticWorkbook,
  parseAnalyticWorkbookFlexible,
  parseSyntheticWorkbookFlexible,
  buildAdditiveAnalyticImportPreview,
  computeAdditiveRow,
  type AnalyticBlock,
  type AnalyticColumnMap,
  type SyntheticColumnMap,
  type AdditiveAnalyticImportPreview,
} from '@/lib/additiveImport';

type ImportKind = 'synthetic' | 'analytic';
type Step = 'kind' | 'configure' | 'preview';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  active: Additive | null;
  isLocked: boolean;
  bdi: number;
  globalDiscount: number;
  eligiblePhaseIds: string[];
  onConfirmSynthetic: (file: File, additive: Additive, metadata: Record<string, unknown>) => Promise<void>;
  onConfirmAnalytic: (
    file: File,
    blocks: AnalyticBlock[],
    preview: AdditiveAnalyticImportPreview,
    metadata: Record<string, unknown>,
  ) => Promise<void>;
}

const ROLE_LABELS: Array<[keyof AnalyticColumnMap, string]> = [
  ['kindOrItem', 'Tipo / Marcador'],
  ['code', 'Código'],
  ['bank', 'Banco'],
  ['description', 'Descrição'],
  ['unit', 'Unidade'],
  ['coefficient', 'Coeficiente / Quantidade'],
  ['unitPrice', 'Valor unitário'],
  ['total', 'Total'],
];

const DEFAULT_COLUMNS: AnalyticColumnMap = {
  kindOrItem: 0, code: 1, bank: 2, description: 3,
  unit: 4, coefficient: 5, unitPrice: 6, total: 7,
};

const SYNTHETIC_ROLE_LABELS: Array<[keyof SyntheticColumnMap, string]> = [
  ['item', 'Item'], ['code', 'Código'], ['bank', 'Banco'], ['description', 'Descrição'],
  ['quantity', 'Quantidade'], ['unit', 'Unidade'], ['unitPriceNoBDI', 'Valor unit. s/ BDI'],
  ['totalNoBDI', 'Total s/ BDI'], ['unitPriceWithBDI', 'Valor unit. c/ BDI'], ['totalWithBDI', 'Total c/ BDI'],
];
const DEFAULT_SYNTHETIC_COLUMNS: SyntheticColumnMap = {
  item: 0, code: 1, bank: 2, description: 3, quantity: 4, unit: 5,
  unitPriceNoBDI: 6, totalNoBDI: 7, unitPriceWithBDI: 8, totalWithBDI: 9,
};

const columnName = (index: number) => String.fromCharCode(65 + index);
const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function AdditiveImportDialog({
  open, onOpenChange, active, isLocked, bdi, globalDiscount, eligiblePhaseIds,
  onConfirmSynthetic, onConfirmAnalytic,
}: Props) {
  const [step, setStep] = useState<Step>('kind');
  const [kind, setKind] = useState<ImportKind | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('Aditivo');
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [sheetName, setSheetName] = useState('');
  const [headerRow, setHeaderRow] = useState(2);
  const [firstDataRow, setFirstDataRow] = useState(3);
  const [columns, setColumns] = useState<AnalyticColumnMap>(DEFAULT_COLUMNS);
  const [syntheticColumns, setSyntheticColumns] = useState<SyntheticColumnMap>(DEFAULT_SYNTHETIC_COLUMNS);
  const [blocks, setBlocks] = useState<AnalyticBlock[]>([]);
  const [syntheticAdditive, setSyntheticAdditive] = useState<Additive | null>(null);
  const [preview, setPreview] = useState<AdditiveAnalyticImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reset = () => {
    setStep('kind'); setKind(null); setFile(null); setName('Aditivo');
    setSheetNames([]); setSheetName(''); setHeaderRow(2); setFirstDataRow(3);
    setColumns(DEFAULT_COLUMNS); setSyntheticColumns(DEFAULT_SYNTHETIC_COLUMNS);
    setBlocks([]); setSyntheticAdditive(null); setPreview(null); setError('');
  };
  useEffect(() => { if (!open) reset(); }, [open]);

  const selectKind = (next: ImportKind) => {
    setKind(next); setStep('configure'); setError('');
  };

  const loadFile = async (next: File | null) => {
    setFile(next); setPreview(null); setError('');
    if (!next) return;
    setName(next.name.replace(/\.(xlsx|xls)$/i, '') || 'Aditivo');
    try {
      setLoading(true);
      const buffer = await next.arrayBuffer();
      const inspected = kind === 'analytic'
        ? await inspectAnalyticWorkbook(buffer)
        : await inspectSyntheticWorkbook(buffer);
      setSheetNames(inspected.sheetNames);
      setSheetName(inspected.sheetName);
      setHeaderRow(inspected.suggestedHeaderRowIndex + 1);
      setFirstDataRow(inspected.suggestedFirstDataRowIndex + 1);
    } catch {
      setError('Não foi possível ler a planilha selecionada.');
    } finally { setLoading(false); }
  };

  const preparePreview = async () => {
    if (!file) return;
    if (kind === 'synthetic') {
      try {
        setLoading(true); setError('');
        const parsed = await parseSyntheticWorkbookFlexible(await file.arrayBuffer(), name.trim() || 'Aditivo', {
          sheetName,
          headerRowIndex: Math.max(0, headerRow - 1),
          firstDataRowIndex: Math.max(0, firstDataRow - 1),
          columns: syntheticColumns,
        });
        if (!parsed.additive.compositions.length) {
          setError('Nenhuma composição da Sintética foi encontrada com esse mapeamento.');
          return;
        }
        setSyntheticAdditive(parsed.additive); setStep('preview');
      } catch { setError('Falha ao analisar as colunas da Sintética.'); }
      finally { setLoading(false); }
      return;
    }
    if (!active || isLocked) {
      setError('Selecione um aditivo em rascunho e editável para importar a Analítica.');
      return;
    }
    try {
      setLoading(true); setError('');
      const parsed = await parseAnalyticWorkbookFlexible(await file.arrayBuffer(), {
        sheetName,
        headerRowIndex: Math.max(0, headerRow - 1),
        firstDataRowIndex: Math.max(0, firstDataRow - 1),
        columns,
        blockMode: 'composition_marker',
      });
      if (!parsed.blocks.length) {
        setError('Nenhuma linha marcada como “Composição” foi encontrada com esse mapeamento.');
        return;
      }
      const nextPreview = buildAdditiveAnalyticImportPreview(active, parsed.blocks, eligiblePhaseIds);
      setBlocks(parsed.blocks); setPreview(nextPreview); setStep('preview');
    } catch {
      setError('Falha ao analisar as colunas configuradas.');
    } finally { setLoading(false); }
  };

  const confirm = async () => {
    if (!file || !kind) return;
    setLoading(true);
    try {
      if (kind === 'synthetic' && syntheticAdditive) await onConfirmSynthetic(file, syntheticAdditive, {
        kind: 'synthetic', sheetName, columns: syntheticColumns, headerRow, firstDataRow,
      });
      else if (preview) await onConfirmAnalytic(file, blocks, preview, {
        kind: 'analytic', sheetName, blockMode: 'composition_marker', columns,
        headerRow, firstDataRow, bdiPercent: bdi, globalDiscountPercent: globalDiscount,
      });
      onOpenChange(false);
    } finally { setLoading(false); }
  };

  const summary = useMemo(() => preview ? [
    ['Vinculadas', preview.matched, 'text-emerald-700'],
    ['Insumos', preview.inputsToReplace, 'text-sky-700'],
    ['Sem vínculo', preview.unmatched, 'text-amber-700'],
    ['Conflitos', preview.conflicts, 'text-rose-700'],
    ['Preços divergentes', preview.priceDivergences, 'text-violet-700'],
  ] as const : [], [preview]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importar Excel no Aditivo</DialogTitle>
          <DialogDescription>Escolha o tipo, confira as colunas e revise as associações antes de gravar.</DialogDescription>
        </DialogHeader>

        {step === 'kind' && (
          <div className="grid gap-4 md:grid-cols-2 py-4">
            <button className="rounded-lg border p-6 text-left hover:border-primary hover:bg-primary/5" onClick={() => selectKind('synthetic')}>
              <FileSpreadsheet className="h-8 w-8 text-primary mb-3" />
              <strong className="block">Sintética</strong>
              <span className="text-sm text-muted-foreground">Cria ou acrescenta um novo aditivo em rascunho.</span>
            </button>
            <button className="rounded-lg border p-6 text-left hover:border-primary hover:bg-primary/5 disabled:opacity-50" onClick={() => selectKind('analytic')} disabled={!active || isLocked}>
              <Table2 className="h-8 w-8 text-primary mb-3" />
              <strong className="block">Analítica</strong>
              <span className="text-sm text-muted-foreground">Vincula insumos somente aos novos serviços do aditivo ativo.</span>
            </button>
          </div>
        )}

        {step === 'configure' && kind && (
          <div className="space-y-5 py-2">
            <div className="flex items-center gap-2"><Badge variant="outline">{kind === 'analytic' ? 'Analítica' : 'Sintética'}</Badge><span className="text-xs text-muted-foreground">Etapa 2 de 3</span></div>
            <div className="space-y-2">
              <Label>Arquivo Excel</Label>
              <Input type="file" accept=".xlsx,.xls" onChange={event => void loadFile(event.target.files?.[0] ?? null)} />
            </div>
            {kind === 'synthetic' && file && <div className="space-y-2"><Label>Nome do aditivo</Label><Input value={name} onChange={e => setName(e.target.value)} /></div>}
            {file && <div className="grid gap-3 md:grid-cols-3">
              <div><Label>Aba</Label><select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={sheetName} onChange={e => setSheetName(e.target.value)}>{sheetNames.map(sheet => <option key={sheet}>{sheet}</option>)}</select></div>
              <div><Label>Linha do cabeçalho</Label><Input type="number" min={1} value={headerRow} onChange={e => setHeaderRow(Number(e.target.value))} /></div>
              <div><Label>Primeira linha de dados</Label><Input type="number" min={1} value={firstDataRow} onChange={e => setFirstDataRow(Number(e.target.value))} /></div>
            </div>}
            {kind === 'synthetic' && file && <div><Label>O que cada coluna representa</Label><div className="mt-2 grid gap-2 md:grid-cols-2 lg:grid-cols-5">{SYNTHETIC_ROLE_LABELS.map(([role, label]) => <div key={role} className="rounded border p-2"><span className="block text-xs text-muted-foreground mb-1">{label}</span><select className="h-8 w-full rounded border bg-background px-2 text-sm" value={syntheticColumns[role] ?? -1} onChange={e => setSyntheticColumns(current => ({ ...current, [role]: Number(e.target.value) }))}>{Array.from({ length: 10 }, (_, index) => <option key={index} value={index}>Coluna {columnName(index)}</option>)}</select></div>)}</div></div>}
            {kind === 'analytic' && file && (
              <>
                <div>
                  <Label>O que cada coluna representa</Label>
                  <div className="mt-2 grid gap-2 md:grid-cols-2 lg:grid-cols-4">
                    {ROLE_LABELS.map(([role, label]) => <div key={role} className="rounded border p-2"><span className="block text-xs text-muted-foreground mb-1">{label}</span><select className="h-8 w-full rounded border bg-background px-2 text-sm" value={columns[role] ?? -1} onChange={e => setColumns(current => ({ ...current, [role]: Number(e.target.value) }))}>{Array.from({ length: 10 }, (_, index) => <option key={index} value={index}>Coluna {columnName(index)}</option>)}</select></div>)}
                  </div>
                </div>
                <p className="rounded border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800">Uma linha com “Composição” inicia o serviço. As linhas abaixo serão seus insumos até a próxima composição.</p>
              </>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {step === 'preview' && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2"><Badge variant="outline">Prévia</Badge><span className="text-xs text-muted-foreground">Etapa 3 de 3 — nada foi gravado ainda</span></div>
            {kind === 'synthetic' ? <p className="rounded border p-4 text-sm">O arquivo <strong>{file?.name}</strong> criará o aditivo <strong>{name}</strong> em rascunho, com <strong>{syntheticAdditive?.compositions.length ?? 0}</strong> composições.</p> : preview && <>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-5">{summary.map(([label, value, color]) => <div key={label} className="rounded border p-3"><span className="text-xs text-muted-foreground">{label}</span><strong className={`block text-xl ${color}`}>{value}</strong></div>)}</div>
              <p className="flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" />Composições contratadas afetadas: 0. Preços do contrato e catálogo não serão alterados.</p>
              <div className="max-h-80 overflow-auto rounded border"><table className="w-full text-xs"><thead className="sticky top-0 bg-muted"><tr><th className="p-2 text-left">Excel</th><th className="p-2 text-left">Destino</th><th className="p-2 text-right">Insumos</th><th className="p-2 text-right">Referência s/ BDI</th><th className="p-2 text-right">C/ BDI antes desconto</th><th className="p-2 text-right">C/ BDI e desconto</th><th className="p-2 text-right">Diverg.</th><th className="p-2">Situação</th></tr></thead><tbody>{preview.matches.map(match => { const row = computeAdditiveRow({ ...(active!.compositions.find(c => c.id === match.targetCompositionId) ?? active!.compositions[0]), isNewService: true, analyticReferenceUnitPriceNoBDI: match.referenceUnitPriceNoBDI }, bdi, globalDiscount); return <tr key={match.blockIndex} className="border-t"><td className="p-2"><strong>{match.code}</strong><div className="text-muted-foreground">{match.bank}</div></td><td className="p-2">{match.targetItem ?? '—'}</td><td className="p-2 text-right">{match.inputCount}</td><td className="p-2 text-right">{money(match.referenceUnitPriceNoBDI)}</td><td className="p-2 text-right">{money(row.unitPriceWithBDIBeforeDiscount)}</td><td className="p-2 text-right">{money(row.unitPriceWithBDI)}</td><td className="p-2 text-right">{match.priceDivergences}</td><td className="p-2 text-center"><Badge variant="outline" className={match.status === 'matched' ? 'text-emerald-700' : match.status === 'conflict' ? 'text-rose-700' : 'text-amber-700'}>{match.status === 'matched' ? 'Vinculada' : match.status === 'conflict' ? 'Conflito' : 'Sem vínculo'}</Badge>{match.reason && <span title={match.reason}><AlertTriangle className="inline ml-1 h-3 w-3" /></span>}</td></tr>; })}</tbody></table></div>
            </>}
          </div>
        )}

        <DialogFooter className="gap-2">
          {step !== 'kind' && <Button variant="outline" onClick={() => setStep(step === 'preview' ? 'configure' : 'kind')} disabled={loading}><ArrowLeft className="h-4 w-4 mr-1" />Voltar</Button>}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>Cancelar</Button>
          {step === 'configure' && <Button onClick={() => void preparePreview()} disabled={!file || loading}><Upload className="h-4 w-4 mr-1" />Analisar arquivo</Button>}
          {step === 'preview' && <Button onClick={() => void confirm()} disabled={loading || (kind === 'analytic' && (!preview || preview.matched === 0))}>Confirmar importação</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
