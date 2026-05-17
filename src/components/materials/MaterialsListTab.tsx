import { useMemo, useRef, useState, useCallback } from 'react';
import type { Project, MaterialComparison } from '@/types/project';
import * as MC from '@/lib/materialComparisons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Plus, Sparkles, Trash2, AlertTriangle, Link2, Loader2, Check } from 'lucide-react';
import { parseBR, NumberInput } from './numberInput';
import {
  extractBaseAnalyticCompositions,
  extractBaseAnalyticCompositionsFromAnalyticFile,
} from '@/lib/additiveImport';

interface Props {
  project: Project;
  comparison: MaterialComparison;
  onApply: (next: MaterialComparison) => void;
  onProjectChange: (next: Project) => void;
}

export default function MaterialsListTab({ project, comparison, onApply, onProjectChange }: Props) {
  const [showSuggest, setShowSuggest] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Record<string, boolean>>({});
  const [manual, setManual] = useState({ description: '', unit: 'un', quantity: '1', referencePrice: '', code: '' });
  const fileRef = useRef<HTMLInputElement>(null);
  const [linkingAnalytic, setLinkingAnalytic] = useState(false);
  const [linkMsg, setLinkMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);

  const diagnostics = useMemo(
    () => MC.suggestMaterialsWithDiagnostics(project).diagnostics,
    [project],
  );
  const needsAnalyticLink =
    diagnostics.baseCompositionsWithAnalytic === 0 &&
    diagnostics.baseAnalyticInputs === 0 &&
    diagnostics.syntheticCompositionsIgnored > 0;

  const handleAnalyticFile = useCallback(async (file: File) => {
    setLinkingAnalytic(true);
    setLinkMsg(null);
    try {
      const buf = await file.arrayBuffer();
      const baseItems = (project.budgetItems ?? []).filter(b => b.source === 'sintetica');
      // Tenta primeiro como arquivo combinado (Sintética + Analítica).
      let compositions: any[] = [];
      let info = '';
      const combined = await extractBaseAnalyticCompositions(buf);
      if (combined.hasAnalyticSheet && combined.compositions.length > 0) {
        compositions = combined.compositions;
        info = combined.message;
      } else {
        const only = await extractBaseAnalyticCompositionsFromAnalyticFile(buf, baseItems);
        if (!only.hasAnalyticSheet) {
          setLinkMsg({ kind: 'err', text: 'Aba Analítica não encontrada no arquivo.' });
          setLinkingAnalytic(false);
          return;
        }
        if (only.compositions.length === 0) {
          setLinkMsg({ kind: 'err', text: only.message || 'Analítica lida, mas nenhum bloco vinculou à Sintética.' });
          setLinkingAnalytic(false);
          return;
        }
        compositions = only.compositions;
        info = only.message;
      }
      onProjectChange({ ...project, analyticCompositions: compositions });
      setLinkMsg({ kind: 'ok', text: info });
    } catch (err: any) {
      setLinkMsg({ kind: 'err', text: `Falha ao ler Analítica: ${err?.message ?? 'erro desconhecido'}.` });
    }
    setLinkingAnalytic(false);
  }, [project, onProjectChange]);

  const suggestions = useMemo(() => MC.suggestMaterialsFromProject(project), [project]);
  const realSuggestions = suggestions.filter(s => !s.warning);
  const warnings = suggestions.filter(s => s.warning);

  const addManual = () => {
    if (!manual.description.trim()) return;
    const next = MC.addItem(comparison, {
      description: manual.description.trim(),
      unit: manual.unit || 'un',
      quantity: parseBR(manual.quantity) ?? 0,
      referencePrice: parseBR(manual.referencePrice),
      code: manual.code || undefined,
      sourceType: 'manual',
    });
    onApply(next);
    setManual({ description: '', unit: 'un', quantity: '1', referencePrice: '', code: '' });
  };

  const importSelected = () => {
    const picked = realSuggestions.filter(s => selectedKeys[s.key]);
    if (picked.length === 0) return;
    const next = MC.addItemsBulk(
      comparison,
      picked.map(p => ({
        description: p.description,
        unit: p.unit,
        quantity: p.quantity,
        referencePrice: p.referencePrice,
        code: p.code,
        sourceType: p.sourceType,
        sourceId: p.sourceId,
        status: 'pendente' as const,
      })),
    );
    onApply(next);
    setSelectedKeys({});
    setShowSuggest(false);
  };

  const sourceLabel = (s: MC.MaterialSuggestionSource) =>
    s === 'task_material' ? 'Material manual'
    : s === 'additive_input' ? 'Aditivo contratado'
    : 'Analítico do contrato';

  return (
    <div className="space-y-4">
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) handleAnalyticFile(f);
          e.target.value = '';
        }}
      />

      {needsAnalyticLink && (
        <div className="bg-warning/10 border border-warning/40 rounded-xl p-4 flex flex-wrap items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-warning" />
          <div className="flex-1 min-w-[200px]">
            <div className="text-sm font-semibold text-foreground">Analítica do contrato não vinculada</div>
            <div className="text-xs text-muted-foreground">
              Existem {diagnostics.syntheticCompositionsIgnored} composições sintéticas sem analítico. Vincule a planilha Analítica para listar os insumos reais (mão de obra, materiais, equipamentos).
            </div>
          </div>
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={linkingAnalytic}>
            {linkingAnalytic ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Link2 className="w-3.5 h-3.5 mr-1" />}
            Vincular Analítica do contrato
          </Button>
        </div>
      )}
      {linkMsg && (
        <div className={`text-xs rounded-lg px-3 py-2 border flex items-start gap-2 ${
          linkMsg.kind === 'ok' ? 'bg-success/10 border-success/40 text-success-foreground'
          : linkMsg.kind === 'err' ? 'bg-destructive/10 border-destructive/40 text-destructive'
          : 'bg-muted border-border text-muted-foreground'
        }`}>
          {linkMsg.kind === 'ok' ? <Check className="w-3.5 h-3.5 mt-0.5" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5" />}
          <span>{linkMsg.text}</span>
        </div>
      )}

      {/* Add manual */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Adicionar item</h3>
          <Button size="sm" variant="outline" onClick={() => setShowSuggest(s => !s)}>
            <Sparkles className="w-3.5 h-3.5 mr-1" />
            {showSuggest ? 'Ocultar sugestões' : 'Importar do projeto'}
          </Button>
        </div>
        <div className="grid grid-cols-12 gap-2">
          <Input className="col-span-2" placeholder="Código" value={manual.code} onChange={e => setManual({ ...manual, code: e.target.value })} />
          <Input className="col-span-5" placeholder="Descrição" value={manual.description} onChange={e => setManual({ ...manual, description: e.target.value })} />
          <Input className="col-span-1" placeholder="Un." value={manual.unit} onChange={e => setManual({ ...manual, unit: e.target.value })} />
          <NumberInput className="col-span-1" placeholder="Qtd." value={manual.quantity} onChange={v => setManual({ ...manual, quantity: v })} />
          <NumberInput className="col-span-2" placeholder="Preço ref." value={manual.referencePrice} onChange={v => setManual({ ...manual, referencePrice: v })} />
          <Button className="col-span-1" onClick={addManual}><Plus className="w-4 h-4" /></Button>
        </div>

        {showSuggest && (
          <div className="border border-border rounded-lg max-h-80 overflow-auto mt-2">
            {warnings.length > 0 && (
              <div className="px-3 py-2 bg-warning/10 border-b border-border text-[11px] text-warning-foreground flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <div>
                  <strong>{warnings.length}</strong> composição(ões) sem analítico vinculado foram ignoradas (composições sintéticas não viram material de compra).
                </div>
              </div>
            )}
            <table className="w-full text-xs">
              <thead className="bg-muted sticky top-0">
                <tr>
                  <th className="p-2 w-8"></th>
                  <th className="p-2 text-left">Descrição</th>
                  <th className="p-2">Origem</th>
                  <th className="p-2">Un</th>
                  <th className="p-2 text-right">Qtd</th>
                  <th className="p-2 text-right">Preço ref.</th>
                </tr>
              </thead>
              <tbody>
                {realSuggestions.length === 0 && (
                  <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">Nenhum insumo analítico encontrado. Importe/vincule a planilha Analítica do contrato ou integre um aditivo com analítica.</td></tr>
                )}
                {realSuggestions.map(s => (
                  <tr key={s.key} className="border-t border-border hover:bg-muted/30">
                    <td className="p-2">
                      <Checkbox checked={!!selectedKeys[s.key]} onCheckedChange={v => setSelectedKeys(prev => ({ ...prev, [s.key]: !!v }))} />
                    </td>
                    <td className="p-2">{s.description}</td>
                    <td className="p-2 text-center text-[10px] text-muted-foreground">{sourceLabel(s.sourceType)}</td>
                    <td className="p-2 text-center">{s.unit}</td>
                    <td className="p-2 text-right">{s.quantity.toLocaleString('pt-BR', { maximumFractionDigits: 4 })}</td>
                    <td className="p-2 text-right">{s.referencePrice ? `R$ ${s.referencePrice.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="p-2 border-t border-border bg-muted/30 flex justify-end">
              <Button size="sm" onClick={importSelected} disabled={Object.values(selectedKeys).every(v => !v)}>
                Importar selecionados
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Current items */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-muted/30 text-xs uppercase font-semibold tracking-wide">
          Itens do comparativo ({comparison.items.length})
        </div>
        {comparison.items.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Nenhum item ainda. Adicione manualmente ou importe do projeto.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted">
              <tr>
                <th className="p-2 text-left">Código</th>
                <th className="p-2 text-left">Descrição</th>
                <th className="p-2">Un.</th>
                <th className="p-2 text-right">Qtd.</th>
                <th className="p-2 text-right">Preço ref.</th>
                <th className="p-2 text-center">Status</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {comparison.items.map(it => (
                <tr key={it.id} className="border-t border-border hover:bg-muted/30">
                  <td className="p-2">
                    <Input value={it.code ?? ''} onChange={e => onApply(MC.updateItem(comparison, it.id, { code: e.target.value }))} className="h-7 text-xs" />
                  </td>
                  <td className="p-2 min-w-[200px]">
                    <Input value={it.description} onChange={e => onApply(MC.updateItem(comparison, it.id, { description: e.target.value }))} className="h-7 text-xs" />
                  </td>
                  <td className="p-2 w-16">
                    <Input value={it.unit} onChange={e => onApply(MC.updateItem(comparison, it.id, { unit: e.target.value }))} className="h-7 text-xs" />
                  </td>
                  <td className="p-2 w-24">
                    <NumberInput
                      value={String(it.quantity ?? '')}
                      onChange={v => onApply(MC.updateItem(comparison, it.id, { quantity: parseBR(v) ?? 0 }))}
                      className="h-7 text-xs text-right"
                    />
                  </td>
                  <td className="p-2 w-28">
                    <NumberInput
                      value={it.referencePrice != null ? String(it.referencePrice) : ''}
                      onChange={v => onApply(MC.updateItem(comparison, it.id, { referencePrice: parseBR(v) }))}
                      className="h-7 text-xs text-right"
                    />
                  </td>
                  <td className="p-2 text-center">
                    <select
                      value={it.status ?? 'pendente'}
                      onChange={e => onApply(MC.setItemStatus(comparison, it.id, e.target.value as never))}
                      className="text-[11px] border border-border rounded px-1.5 py-1 bg-background"
                    >
                      <option value="pendente">Pendente</option>
                      <option value="orcado">Orçado</option>
                      <option value="comprado">Comprado</option>
                    </select>
                  </td>
                  <td className="p-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive h-7"
                      onClick={() => {
                        if (confirm(`Remover o item "${it.description}" do comparativo?`)) {
                          onApply(MC.removeItem(comparison, it.id));
                        }
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
