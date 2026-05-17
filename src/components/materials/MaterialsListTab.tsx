import { useMemo, useRef, useState, useCallback } from 'react';
import type { Project, MaterialComparison } from '@/types/project';
import * as MC from '@/lib/materialComparisons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Plus, Sparkles, Trash2, AlertTriangle, Link2, Loader2, Check, Search, Lock } from 'lucide-react';
import { parseBR, NumberInput, CurrencyInput, trunc2, formatBRL, formatQty } from './numberInput';
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

const DETAIL_LABEL: Record<string, string> = {
  contracted_item: 'Item contratado',
  additive_existing_changed: 'Item contratado alterado',
  additive_new_service: 'Novo serviço aditivado',
};
const DETAIL_BADGE: Record<string, string> = {
  contracted_item: 'bg-muted text-muted-foreground border-border',
  additive_existing_changed: 'bg-warning/15 text-warning border-warning/40',
  additive_new_service: 'bg-primary/15 text-primary border-primary/40',
};

function originBadge(sourceType: MC.MaterialSuggestionSource, detail?: MC.MaterialSuggestionDetail) {
  if (sourceType === 'additive_input' && detail) {
    return { label: DETAIL_LABEL[detail], cls: DETAIL_BADGE[detail] };
  }
  if (sourceType === 'task_material') {
    return { label: 'Material manual', cls: 'bg-muted text-muted-foreground border-border' };
  }
  if (sourceType === 'analytic_input') {
    return { label: 'Analítico do contrato', cls: 'bg-secondary text-secondary-foreground border-border' };
  }
  return { label: 'Aditivo', cls: 'bg-muted text-muted-foreground border-border' };
}

export default function MaterialsListTab({ project, comparison, onApply, onProjectChange }: Props) {
  const [showSuggest, setShowSuggest] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [manual, setManual] = useState({ description: '', unit: 'un', quantity: '1', referencePrice: '', code: '' });
  const fileRef = useRef<HTMLInputElement>(null);
  const [linkingAnalytic, setLinkingAnalytic] = useState(false);
  const [linkMsg, setLinkMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);

  const diagnostics = useMemo(
    () => MC.suggestMaterialsWithDiagnostics(project).diagnostics,
    [project],
  );
  const needsAnalyticLink =
    diagnostics.additiveAnalyticInputs === 0 &&
    diagnostics.baseCompositionsWithAnalytic === 0 &&
    diagnostics.baseAnalyticInputs === 0 &&
    diagnostics.syntheticCompositionsIgnored > 0;

  const handleAnalyticFile = useCallback(async (file: File) => {
    setLinkingAnalytic(true);
    setLinkMsg(null);
    try {
      const buf = await file.arrayBuffer();
      const baseItems = (project.budgetItems ?? []).filter(b => b.source === 'sintetica');
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

  const filteredSuggestions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return realSuggestions;
    return realSuggestions.filter(s => {
      const origin = originBadge(s.sourceType, s.sourceDetail).label.toLowerCase();
      return (
        (s.code ?? '').toLowerCase().includes(q) ||
        (s.bank ?? '').toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.unit.toLowerCase().includes(q) ||
        origin.includes(q)
      );
    });
  }, [realSuggestions, search]);

  const addManual = () => {
    if (!manual.description.trim()) return;
    const next = MC.addItem(comparison, {
      description: manual.description.trim(),
      unit: manual.unit || 'un',
      quantity: trunc2(parseBR(manual.quantity) ?? 0),
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
        quantity: trunc2(p.quantity),
        referencePrice: p.referencePrice,
        code: p.code,
        sourceType: p.sourceType,
        sourceDetail: p.sourceDetail,
        sourceId: p.sourceId,
        status: 'pendente' as const,
      })),
    );
    onApply(next);
    setSelectedKeys({});
    setShowSuggest(false);
  };

  const selectedCount = Object.values(selectedKeys).filter(Boolean).length;

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
          <div className="border border-border rounded-lg overflow-hidden mt-2">
            <div className="px-3 py-2 bg-muted/40 border-b border-border flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Buscar por código, banco, descrição ou origem..."
                  className="h-8 pl-7 text-xs"
                />
              </div>
              <div className="text-[11px] text-muted-foreground">
                {filteredSuggestions.length}/{realSuggestions.length} insumos
              </div>
              <Button size="sm" onClick={importSelected} disabled={selectedCount === 0}>
                Importar selecionados {selectedCount > 0 && `(${selectedCount})`}
              </Button>
            </div>
            <div className="px-3 py-1.5 bg-muted/30 border-b border-border text-[10px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-0.5">
              <span><strong>{diagnostics.additiveCompositionsWithAnalytic}</strong> composições do Aditivo c/ analítico</span>
              <span><strong>{diagnostics.additiveAnalyticInputs}</strong> insumos lidos</span>
              <span><strong>{diagnostics.groupedInputs}</strong> agrupados</span>
            </div>
            {warnings.length > 0 && (
              <div className="px-3 py-2 bg-warning/10 border-b border-border text-[11px] text-warning-foreground flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <div>
                  <strong>{warnings.length}</strong> composição(ões) sem analítico vinculado foram ignoradas.
                </div>
              </div>
            )}
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted sticky top-0 z-10">
                  <tr>
                    <th className="p-2 w-8"></th>
                    <th className="p-2 text-left">Código / Banco</th>
                    <th className="p-2 text-left">Descrição</th>
                    <th className="p-2 text-left">Origem</th>
                    <th className="p-2">Un</th>
                    <th className="p-2 text-right">Qtd</th>
                    <th className="p-2 text-right">Preço ref.</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSuggestions.length === 0 && (
                    <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">
                      {realSuggestions.length === 0
                        ? (diagnostics.additivesRead > 0
                            ? 'Nenhum insumo analítico encontrado no Aditivo atual.'
                            : needsAnalyticLink
                              ? 'Vincule primeiro a Analítica do contrato (botão acima).'
                              : 'Nenhum insumo analítico encontrado.')
                        : 'Nenhum insumo bate com a busca.'}
                    </td></tr>
                  )}
                  {filteredSuggestions.map(s => {
                    const badge = originBadge(s.sourceType, s.sourceDetail);
                    return (
                      <tr key={s.key} className="border-t border-border hover:bg-muted/30">
                        <td className="p-2 align-top">
                          <Checkbox checked={!!selectedKeys[s.key]} onCheckedChange={v => setSelectedKeys(prev => ({ ...prev, [s.key]: !!v }))} />
                        </td>
                        <td className="p-2 align-top">
                          <div className="font-mono text-[10px] text-foreground">{s.code || '—'}</div>
                          <div className="text-[10px] text-muted-foreground">{s.bank || ''}</div>
                        </td>
                        <td className="p-2 align-top">{s.description}</td>
                        <td className="p-2 align-top">
                          <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${badge.cls}`}>
                            {badge.label}
                          </span>
                        </td>
                        <td className="p-2 text-center align-top">{s.unit}</td>
                        <td className="p-2 text-right align-top">{formatQty(s.quantity)}</td>
                        <td className="p-2 text-right align-top">{s.referencePrice ? formatBRL(s.referencePrice) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="p-2 border-t border-border bg-muted/30 flex justify-end">
              <Button size="sm" onClick={importSelected} disabled={selectedCount === 0}>
                Importar selecionados {selectedCount > 0 && `(${selectedCount})`}
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
                <th className="p-2 text-left">Origem</th>
                <th className="p-2 text-center">Status</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {comparison.items.map(it => {
                const isManual = (it.sourceType ?? 'manual') === 'manual';
                const badge = originBadge(
                  (it.sourceType ?? 'manual') as MC.MaterialSuggestionSource,
                  it.sourceDetail as MC.MaterialSuggestionDetail | undefined,
                );
                return (
                  <tr key={it.id} className="border-t border-border hover:bg-muted/30">
                    <td className="p-2">
                      {isManual ? (
                        <Input value={it.code ?? ''} onChange={e => onApply(MC.updateItem(comparison, it.id, { code: e.target.value }))} className="h-7 text-xs" />
                      ) : (
                        <span className="font-mono text-[11px] text-foreground">{it.code || '—'}</span>
                      )}
                    </td>
                    <td className="p-2 min-w-[200px]">
                      {isManual ? (
                        <Input value={it.description} onChange={e => onApply(MC.updateItem(comparison, it.id, { description: e.target.value }))} className="h-7 text-xs" />
                      ) : (
                        <span className="text-foreground">{it.description}</span>
                      )}
                    </td>
                    <td className="p-2 w-16 text-center">
                      {isManual ? (
                        <Input value={it.unit} onChange={e => onApply(MC.updateItem(comparison, it.id, { unit: e.target.value }))} className="h-7 text-xs" />
                      ) : (
                        <span className="text-muted-foreground">{it.unit}</span>
                      )}
                    </td>
                    <td className="p-2 w-24 text-right">
                      {isManual ? (
                        <NumberInput
                          value={String(it.quantity ?? '')}
                          onChange={v => onApply(MC.updateItem(comparison, it.id, { quantity: trunc2(parseBR(v) ?? 0) }))}
                          className="h-7 text-xs text-right"
                        />
                      ) : (
                        <span className="font-mono">{formatQty(it.quantity)}</span>
                      )}
                    </td>
                    <td className="p-2 w-32 text-right">
                      {isManual ? (
                        <CurrencyInput
                          value={it.referencePrice ?? undefined}
                          onChange={v => onApply(MC.updateItem(comparison, it.id, { referencePrice: v }))}
                          className="h-7 text-xs text-right"
                        />
                      ) : (
                        <span className="font-mono">{it.referencePrice != null ? formatBRL(it.referencePrice) : '—'}</span>
                      )}
                    </td>
                    <td className="p-2">
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${badge.cls}`}>
                        {!isManual && <Lock className="w-2.5 h-2.5" />}
                        {badge.label}
                      </span>
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
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
