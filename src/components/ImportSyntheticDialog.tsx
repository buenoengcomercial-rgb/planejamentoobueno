import { useCallback, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Project, BudgetItem, AdditiveComposition } from '@/types/project';
import { parseSyntheticBudget, ParsedSynthetic } from '@/lib/importParser';
import { extractBaseAnalyticCompositions } from '@/lib/additiveImport';
import {
  Upload, FileSpreadsheet, AlertTriangle, Loader2, Check, Info, DollarSign,
} from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  project: Project;
  onProjectChange: (project: Project) => void;
}

const fmtBRL = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function ImportSyntheticDialog({ open, onClose, project, onProjectChange }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedSynthetic | null>(null);
  const [analyticCompositions, setAnalyticCompositions] = useState<AdditiveComposition[]>([]);
  const [analyticInfo, setAnalyticInfo] = useState<string>('');

  const reset = () => {
    setLoading(false);
    setError('');
    setFileName('');
    setParsed(null);
  };
  const handleClose = () => { reset(); onClose(); };

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setError('');
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const result = parseSyntheticBudget(buf);
      if (result.items.length === 0) {
        setError('Nenhum item financeiro encontrado na planilha Sintética.');
        setLoading(false);
        return;
      }
      setParsed(result);
    } catch (e: any) {
      setError(`Erro ao ler a Sintética: ${e?.message ?? 'formato não reconhecido'}`);
    }
    setLoading(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const confirmImport = () => {
    if (!parsed) return;
    // Mantém apenas itens de aditivo (source==='aditivo'), substitui os de Sintética
    const keep = (project.budgetItems ?? []).filter(b => b.source !== 'sintetica');
    const next: BudgetItem[] = [...keep, ...parsed.items];
    onProjectChange({
      ...project,
      budgetItems: next,
      syntheticBdiPercent: parsed.bdiPercent,
      syntheticImportedAt: new Date().toISOString(),
    });
    handleClose();
  };

  const totalNoBDI = parsed?.items.reduce((s, i) => s + i.totalNoBDI, 0) ?? 0;
  const totalWithBDI = parsed?.items.reduce((s, i) => s + i.totalWithBDI, 0) ?? 0;

  return (
    <Dialog open={open} onOpenChange={v => !v && handleClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <DollarSign className="w-5 h-5 text-primary" />
            Importar Sintética (Orçamento)
          </DialogTitle>
          <DialogDescription>
            Planilha financeira do orçamento. Layout fixo:
            A=Item · B=Código · C=Banco · D=Descrição · E=Quant · F=Und · G=V.unit s/BDI · H=Total s/BDI · I=V.unit c/BDI · J=Total c/BDI.
            <br />BDI lido de <strong>J8</strong> quando presente. Esta importação alimenta apenas a aba <strong>Medição</strong>.
          </DialogDescription>
        </DialogHeader>

        {!parsed && (
          <div className="flex-1 flex flex-col items-center justify-center py-8">
            <div
              onDrop={handleDrop}
              onDragOver={e => e.preventDefault()}
              className="w-full border-2 border-dashed border-border rounded-xl p-12 flex flex-col items-center gap-4 hover:border-primary/50 hover:bg-primary/5 transition-colors cursor-pointer"
              onClick={() => document.getElementById('synthetic-file-input')?.click()}
            >
              {loading ? (
                <Loader2 className="w-10 h-10 text-primary animate-spin" />
              ) : (
                <>
                  <FileSpreadsheet className="w-10 h-10 text-success/70" />
                  <p className="text-sm font-medium text-foreground">Arraste e solte ou clique para selecionar</p>
                  <p className="text-xs text-muted-foreground">.xlsx · .xls</p>
                </>
              )}
            </div>
            <input
              id="synthetic-file-input"
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
            />
            {error && (
              <div className="mt-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-2 w-full">
                <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                <p className="text-xs text-destructive">{error}</p>
              </div>
            )}
          </div>
        )}

        {parsed && (
          <div className="flex-1 overflow-y-auto space-y-3 pr-1">
            <div className="flex items-center justify-between flex-wrap gap-2 px-1">
              <span className="text-xs text-muted-foreground">📄 {fileName}</span>
              <div className="flex items-center gap-2 text-xs">
                <span className="px-2 py-0.5 rounded-full bg-primary/15 text-primary font-bold">
                  {parsed.items.length} itens
                </span>
                <span className="px-2 py-0.5 rounded-full bg-info/15 text-info font-medium flex items-center gap-1">
                  <Info className="w-3 h-3" /> BDI: {parsed.bdiPercent ? `${parsed.bdiPercent.toFixed(2)}%` : 'não detectado'}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border bg-card p-3">
                <p className="text-[10px] uppercase text-muted-foreground font-semibold">Total s/ BDI</p>
                <p className="text-sm font-bold text-foreground mt-0.5">{fmtBRL(totalNoBDI)}</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <p className="text-[10px] uppercase text-muted-foreground font-semibold">Total c/ BDI</p>
                <p className="text-sm font-bold text-success mt-0.5">{fmtBRL(totalWithBDI)}</p>
              </div>
            </div>

            {parsed.warnings.length > 0 && (
              <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 max-h-32 overflow-y-auto">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="w-4 h-4 text-warning" />
                  <span className="text-xs font-bold text-warning">{parsed.warnings.length} avisos</span>
                </div>
                <ul className="text-[10px] text-muted-foreground space-y-0.5">
                  {parsed.warnings.slice(0, 8).map((w, i) => <li key={i}>• {w}</li>)}
                  {parsed.warnings.length > 8 && <li>... e mais {parsed.warnings.length - 8}</li>}
                </ul>
              </div>
            )}

            <div className="rounded-lg border border-border overflow-hidden">
              <div className="overflow-x-auto max-h-72">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-semibold">Item</th>
                      <th className="px-2 py-1.5 text-left font-semibold">Código</th>
                      <th className="px-2 py-1.5 text-left font-semibold">Descrição</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Quant.</th>
                      <th className="px-2 py-1.5 text-left font-semibold">Und</th>
                      <th className="px-2 py-1.5 text-right font-semibold">V.unit c/BDI</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Total c/BDI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.items.slice(0, 50).map(it => (
                      <tr key={it.id} className="border-t border-border">
                        <td className="px-2 py-1">{it.item}</td>
                        <td className="px-2 py-1 font-mono">{it.code}</td>
                        <td className="px-2 py-1 truncate max-w-xs" title={it.description}>{it.description}</td>
                        <td className="px-2 py-1 text-right">{it.quantity.toLocaleString('pt-BR')}</td>
                        <td className="px-2 py-1">{it.unit}</td>
                        <td className="px-2 py-1 text-right">{fmtBRL(it.unitPriceWithBDI)}</td>
                        <td className="px-2 py-1 text-right font-medium">{fmtBRL(it.totalWithBDI)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsed.items.length > 50 && (
                  <p className="text-[10px] text-muted-foreground text-center py-2">
                    Mostrando 50 de {parsed.items.length} itens.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>Cancelar</Button>
          {parsed && (
            <Button onClick={confirmImport}>
              <Check className="w-4 h-4 mr-1" /> Importar para Medição
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
