import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import type { ElementType, ReactNode } from 'react';
import type { Project, MaterialComparison } from '@/types/project';
import * as MC from '@/lib/materialComparisons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { AlertTriangle, Link2, Loader2, Check, Search, Plus, BrickWall, HardHat, Truck, CircleSlash, ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { toast } from 'sonner';
import { parseBR, trunc2, formatBRL, formatQty } from './numberInput';
import {
  extractBaseAnalyticCompositions,
  extractBaseAnalyticCompositionsFromAnalyticFile,
} from '@/lib/additiveImport';
import type { MaterialCostClass } from '@/types/project';

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
  if (sourceType === 'task_material') return { label: 'Material manual', cls: 'bg-muted text-muted-foreground border-border' };
  if (sourceType === 'analytic_input') return { label: 'Analítico do contrato', cls: 'bg-secondary text-secondary-foreground border-border' };
  return { label: 'Aditivo', cls: 'bg-muted text-muted-foreground border-border' };
}

const COST_CLASS_ICON: Record<MaterialCostClass, ElementType> = {
  material: BrickWall,
  labor: HardHat,
  equipment: Truck,
  unclassified: CircleSlash,
};

const COST_CLASS_BADGE: Record<MaterialCostClass, string> = {
  material: 'border-orange-300 bg-orange-50 text-orange-700',
  labor: 'border-red-300 bg-red-50 text-red-700',
  equipment: 'border-blue-300 bg-blue-50 text-blue-700',
  unclassified: 'border-slate-300 bg-slate-50 text-slate-600',
};

type SortColumn = 'unit' | 'description' | 'origin' | 'class' | 'quantity' | 'price' | 'group';
type SortState = { column: SortColumn; direction: 'asc' | 'desc' };

function CostClassIcon({ costClass, className = 'w-3.5 h-3.5' }: { costClass: MaterialCostClass; className?: string }) {
  const Icon = COST_CLASS_ICON[costClass];
  return <Icon className={className} />;
}

export default function MaterialsListTab({ project, comparison, onApply, onProjectChange }: Props) {
  const [selectedKeys, setSelectedKeys] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortState | null>(null);
  const [sortOrderKeys, setSortOrderKeys] = useState<string[] | null>(null);
  const [classDrafts, setClassDrafts] = useState<Record<string, MaterialCostClass>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const latestProjectRef = useRef(project);
  const pendingCostClassesRef = useRef<Record<string, MaterialCostClass>>({});
  const classFlushTimerRef = useRef<number | null>(null);
  const [linkingAnalytic, setLinkingAnalytic] = useState(false);
  const [linkMsg, setLinkMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);

  const [showManual, setShowManual] = useState(false);
  const [manual, setManual] = useState({ description: '', unit: 'un', quantity: '1', referencePrice: '', code: '' });

  const allComparisons = project.materialComparisons ?? [];
  const visibleProject = useMemo(
    () => ({
      ...project,
      materialCostClasses: {
        ...(project.materialCostClasses ?? {}),
        ...classDrafts,
      },
    }),
    [classDrafts, project],
  );

  useEffect(() => {
    latestProjectRef.current = project;
  }, [project]);

  useEffect(() => {
    setClassDrafts({});
    pendingCostClassesRef.current = {};
  }, [project.id]);

  const flushCostClassChanges = useCallback(() => {
    if (classFlushTimerRef.current) {
      window.clearTimeout(classFlushTimerRef.current);
      classFlushTimerRef.current = null;
    }
    const pending = pendingCostClassesRef.current;
    if (Object.keys(pending).length === 0) return;
    pendingCostClassesRef.current = {};
    const base = latestProjectRef.current;
    onProjectChange({
      ...base,
      materialCostClasses: {
        ...(base.materialCostClasses ?? {}),
        ...pending,
      },
    });
  }, [onProjectChange]);

  useEffect(() => () => flushCostClassChanges(), [flushCostClassChanges]);

  const diagnostics = useMemo(
    () => MC.suggestMaterialsWithDiagnostics(project).diagnostics,
    [project],
  );
  const suggestions = useMemo(() => MC.suggestMaterialsFromProject(project), [project]);

  const needsAnalyticLink =
    diagnostics.additiveAnalyticInputs === 0 &&
    diagnostics.baseCompositionsWithAnalytic === 0 &&
    diagnostics.baseAnalyticInputs === 0 &&
    diagnostics.syntheticCompositionsIgnored > 0;

  // Map linkKey → comparisonId where this insumo is linked.
  const linkedByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of allComparisons) {
      for (const it of c.items) {
        map.set(MC.linkKeyOf(it), c.id);
      }
    }
    return map;
  }, [allComparisons]);

  const realSuggestions = useMemo(
    () => suggestions.filter(s => !s.warning),
    [suggestions],
  );
  const costClassTotals = useMemo(
    () => MC.computeMaterialCostClassTotals(visibleProject, realSuggestions),
    [realSuggestions, visibleProject],
  );
  const filtered = useMemo(() => {
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
  const getSortValue = useCallback((s: MC.MaterialSuggestion, column: SortColumn) => {
    const text = (value: unknown) => String(value ?? '').toLowerCase();
    const number = (value: unknown) => Number(value ?? 0) || 0;
    const comparisonName = (s: MC.MaterialSuggestion) => {
      const linkedTo = linkedByKey.get(MC.linkKeyOf(s)) ?? '';
      return allComparisons.find(c => c.id === linkedTo)?.name ?? '';
    };
    if (column === 'unit') return text(s.unit);
    if (column === 'description') return text(s.description);
    if (column === 'origin') return text(originBadge(s.sourceType, s.sourceDetail).label);
    if (column === 'class') return text(MC.MATERIAL_COST_CLASS_LABEL[MC.resolveMaterialCostClass(visibleProject, s)]);
    if (column === 'quantity') return number(s.quantity);
    if (column === 'price') return number(s.referencePrice);
    return text(comparisonName(s));
  }, [allComparisons, linkedByKey, visibleProject]);

  const buildSortOrder = useCallback((column: SortColumn, direction: 'asc' | 'desc') => {
    return [...filtered].sort((a, b) => {
      const av = getSortValue(a, column);
      const bv = getSortValue(b, column);
      const base = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), 'pt-BR', { numeric: true, sensitivity: 'base' });
      return direction === 'asc' ? base : -base;
    }).map(s => s.key);
  }, [filtered, getSortValue]);

  const sortedFiltered = useMemo(() => {
    if (!sort || !sortOrderKeys) return filtered;
    const order = new Map(sortOrderKeys.map((key, index) => [key, index]));
    return [...filtered].sort((a, b) => {
      const av = order.get(a.key) ?? Number.MAX_SAFE_INTEGER;
      const bv = order.get(b.key) ?? Number.MAX_SAFE_INTEGER;
      if (av !== bv) return av - bv;
      return a.key.localeCompare(b.key, 'pt-BR', { numeric: true, sensitivity: 'base' });
    });
  }, [filtered, sort, sortOrderKeys]);

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

  const suggestionToPayload = (s: MC.MaterialSuggestion) => ({
    description: s.description,
    unit: s.unit,
    quantity: trunc2(s.quantity),
    referencePrice: s.referencePrice,
    code: s.code,
    sourceType: s.sourceType,
    sourceDetail: s.sourceDetail,
    sourceId: s.sourceId,
  });

  const changeGroup = (s: MC.MaterialSuggestion, targetCompId: string | null) => {
    flushCostClassChanges();
    onProjectChange(MC.setSuggestionLink(project, suggestionToPayload(s), targetCompId));
  };

  const changeCostClass = (s: MC.MaterialSuggestion, costClass: MaterialCostClass) => {
    const key = MC.linkKeyOf(s);
    setClassDrafts(prev => ({ ...prev, [key]: costClass }));
    pendingCostClassesRef.current = {
      ...pendingCostClassesRef.current,
      [key]: costClass,
    };
    if (classFlushTimerRef.current) window.clearTimeout(classFlushTimerRef.current);
    classFlushTimerRef.current = window.setTimeout(flushCostClassChanges, 900);
  };

  const linkSelectedToActive = () => {
    flushCostClassChanges();
    if (!comparison) {
      toast.error('Selecione ou crie um comparativo antes de vincular insumos.');
      return;
    }
    const picked = realSuggestions.filter(s => selectedKeys[s.key]);
    if (picked.length === 0) return;
    let next = project;
    for (const s of picked) {
      next = MC.setSuggestionLink(next, suggestionToPayload(s), comparison.id);
    }
    onProjectChange(next);
    setSelectedKeys({});
  };

  const addManual = () => {
    flushCostClassChanges();
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

  const selectedCount = Object.values(selectedKeys).filter(Boolean).length;
  const allVisibleSelected = filtered.length > 0 && filtered.every(s => selectedKeys[s.key]);
  const toggleAllVisible = (v: boolean) => {
    setSelectedKeys(prev => {
      const next = { ...prev };
      filtered.forEach(s => { next[s.key] = v; });
      return next;
    });
  };
  const toggleSort = (column: SortColumn) => {
    const direction = sort?.column === column && sort.direction === 'asc' ? 'desc' : 'asc';
    setSort({ column, direction });
    setSortOrderKeys(buildSortOrder(column, direction));
  };
  const SortButton = ({
    column,
    children,
    className = '',
  }: {
    column: SortColumn;
    children: ReactNode;
    className?: string;
  }) => {
    const active = sort?.column === column;
    const Icon = !active ? ArrowUpDown : sort.direction === 'asc' ? ArrowUp : ArrowDown;
    return (
      <button
        type="button"
        className={`inline-flex w-full items-center gap-1 rounded px-1 py-0.5 text-[11px] font-semibold hover:bg-background ${className}`}
        onClick={() => toggleSort(column)}
        title="Clique para ordenar esta coluna"
      >
        <span>{children}</span>
        <Icon className={`h-3 w-3 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
      </button>
    );
  };

  const linkedCount = useMemo(
    () => realSuggestions.filter(s => linkedByKey.has(MC.linkKeyOf(s))).length,
    [realSuggestions, linkedByKey],
  );
  const activeLinkedCount = comparison?.items.length ?? 0;

  return (
    <div className="space-y-2">
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
        <div className="bg-warning/10 border border-warning/40 rounded-lg px-3 py-2 flex flex-wrap items-center gap-2 text-xs">
          <AlertTriangle className="w-4 h-4 text-warning" />
          <span className="flex-1 min-w-[200px] text-muted-foreground">
            {diagnostics.syntheticCompositionsIgnored} composições sintéticas sem analítico. Vincule a Analítica para listar os insumos.
          </span>
          <Button size="sm" className="h-7 text-[11px]" onClick={() => fileRef.current?.click()} disabled={linkingAnalytic}>
            {linkingAnalytic ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Link2 className="w-3 h-3 mr-1" />}
            Vincular Analítica
          </Button>
        </div>
      )}
      {linkMsg && (
        <div className={`text-[11px] rounded px-2 py-1.5 border flex items-start gap-2 ${
          linkMsg.kind === 'ok' ? 'bg-success/10 border-success/40 text-success-foreground'
          : linkMsg.kind === 'err' ? 'bg-destructive/10 border-destructive/40 text-destructive'
          : 'bg-muted border-border text-muted-foreground'
        }`}>
          {linkMsg.kind === 'ok' ? <Check className="w-3 h-3 mt-0.5" /> : <AlertTriangle className="w-3 h-3 mt-0.5" />}
          <span>{linkMsg.text}</span>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 bg-card border border-border rounded-lg px-2 py-1.5">
        <div className="relative flex-1 min-w-[260px]">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por código, descrição, banco ou origem..."
            className="h-8 pl-7 text-xs"
          />
        </div>
        <span className="text-[11px] text-muted-foreground whitespace-nowrap">
          <strong className="text-foreground">{filtered.length}</strong> de {realSuggestions.length} insumos disponíveis
          <span className="mx-1.5">·</span>
          <strong className="text-foreground">{linkedCount}</strong> vinculados no projeto
          {comparison && (
            <>
              <span className="mx-1.5">·</span>
              <strong className="text-foreground">{activeLinkedCount}</strong> em "{comparison.name}"
            </>
          )}
        </span>
        <Button size="sm" className="h-8 text-xs" onClick={linkSelectedToActive} disabled={selectedCount === 0}>
          <Link2 className="w-3.5 h-3.5 mr-1" /> Vincular selecionados {selectedCount > 0 && `(${selectedCount})`}
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setShowManual(s => !s)}>
          <Plus className="w-3.5 h-3.5 mr-1" /> Item manual
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
        {costClassTotals.map(row => (
          <div key={row.costClass} className={`rounded-lg border px-3 py-2 ${COST_CLASS_BADGE[row.costClass]}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                <CostClassIcon costClass={row.costClass} />
                {row.label}
              </span>
              <span className="text-[10px] opacity-75">{row.itemsCount} item{row.itemsCount === 1 ? '' : 's'}</span>
            </div>
            <div className="mt-1 text-sm font-bold tabular-nums">{formatBRL(row.total)}</div>
            {row.missingPriceCount > 0 && (
              <div className="mt-0.5 text-[10px] opacity-75">{row.missingPriceCount} sem preço ref.</div>
            )}
          </div>
        ))}
      </div>

      {showManual && (
        <div className="bg-card border border-border rounded-lg px-2 py-2 grid grid-cols-12 gap-1.5">
          <Input className="col-span-2 h-8 text-xs" placeholder="Código" value={manual.code} onChange={e => setManual({ ...manual, code: e.target.value })} />
          <Input className="col-span-5 h-8 text-xs" placeholder="Descrição" value={manual.description} onChange={e => setManual({ ...manual, description: e.target.value })} />
          <Input className="col-span-1 h-8 text-xs" placeholder="Un." value={manual.unit} onChange={e => setManual({ ...manual, unit: e.target.value })} />
          <Input className="col-span-1 h-8 text-xs text-right" placeholder="Qtd." value={manual.quantity} onChange={e => setManual({ ...manual, quantity: e.target.value })} />
          <Input className="col-span-2 h-8 text-xs text-right" placeholder="Preço" value={manual.referencePrice} onChange={e => setManual({ ...manual, referencePrice: e.target.value })} />
          <Button className="col-span-1 h-8" size="sm" onClick={addManual}><Plus className="w-3.5 h-3.5" /></Button>
        </div>
      )}

      {/* Dominant table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="max-h-[calc(100vh-260px)] overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted sticky top-0 z-10">
              <tr className="border-b border-border">
                <th className="p-2 w-8">
                  <Checkbox checked={allVisibleSelected} onCheckedChange={v => toggleAllVisible(!!v)} />
                </th>
                <th className="p-2 text-left w-28">Código</th>
                <th className="p-2 text-left w-20">Banco</th>
                <th className="p-2 text-center w-12"><SortButton column="unit" className="justify-center">Un</SortButton></th>
                <th className="p-2 text-left"><SortButton column="description">Descricao</SortButton></th>
                <th className="p-2 text-left w-40"><SortButton column="origin">Origem</SortButton></th>
                <th className="p-2 text-left w-36"><SortButton column="class">Classe</SortButton></th>
                <th className="p-2 text-right w-20"><SortButton column="quantity" className="justify-end">Qtd</SortButton></th>
                <th className="p-2 text-right w-24"><SortButton column="price" className="justify-end">Preco ref.</SortButton></th>
                <th className="p-2 text-left w-44"><SortButton column="group">Grupo de compra</SortButton></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={10} className="p-6 text-center text-muted-foreground text-xs">
                    {realSuggestions.length === 0
                      ? (diagnostics.additivesRead > 0
                          ? 'Nenhum insumo analítico encontrado no Aditivo atual.'
                          : needsAnalyticLink
                            ? 'Vincule primeiro a Analítica do contrato.'
                            : 'Nenhum insumo analítico encontrado.')
                      : 'Nenhum insumo bate com a busca.'}
                  </td>
                </tr>
              )}
              {sortedFiltered.map(s => {
                const badge = originBadge(s.sourceType, s.sourceDetail);
                const checked = !!selectedKeys[s.key];
                const linkedTo = linkedByKey.get(MC.linkKeyOf(s)) ?? '';
                const costClass = MC.resolveMaterialCostClass(visibleProject, s);
                return (
                  <tr key={s.key} className={`border-t border-border hover:bg-muted/30 ${linkedTo ? 'bg-primary/5' : ''}`}>
                    <td className="p-1.5 align-middle">
                      <Checkbox checked={checked} onCheckedChange={v => setSelectedKeys(prev => ({ ...prev, [s.key]: !!v }))} />
                    </td>
                    <td className="p-1.5 align-middle font-mono text-[10px]">{s.code || '—'}</td>
                    <td className="p-1.5 align-middle text-[10px] text-muted-foreground">{s.bank || '—'}</td>
                    <td className="p-1.5 align-middle text-center text-muted-foreground">{s.unit}</td>
                    <td className="p-1.5 align-middle">{s.description}</td>
                    <td className="p-1.5 align-middle">
                      <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${badge.cls}`}>
                        {badge.label}
                      </span>
                    </td>
                    <td className="p-1.5 align-middle">
                      <div className={`h-7 rounded border px-1.5 flex items-center gap-1 ${COST_CLASS_BADGE[costClass]}`}>
                        <CostClassIcon costClass={costClass} />
                        <select
                          value={costClass}
                          onChange={e => changeCostClass(s, e.target.value as MaterialCostClass)}
                          className="min-w-0 flex-1 bg-transparent text-[11px] font-medium outline-none"
                        >
                          {MC.MATERIAL_COST_CLASS_ORDER.map(c => (
                            <option key={c} value={c}>{MC.MATERIAL_COST_CLASS_LABEL[c]}</option>
                          ))}
                        </select>
                      </div>
                    </td>
                    <td className="p-1.5 align-middle text-right font-mono">{formatQty(s.quantity)}</td>
                    <td className="p-1.5 align-middle text-right font-mono">{s.referencePrice ? formatBRL(s.referencePrice) : '—'}</td>
                    <td className="p-1.5 align-middle">
                      <select
                        value={linkedTo}
                        onChange={e => changeGroup(s, e.target.value || null)}
                        className="h-7 w-full text-[11px] border border-border rounded px-1.5 bg-background"
                      >
                        <option value="">— sem grupo —</option>
                        {allComparisons.map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-2 py-1.5 border-t border-border bg-muted/30 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{selectedCount} selecionado{selectedCount === 1 ? '' : 's'}{comparison ? ` · vincular ao comparativo "${comparison.name}"` : ''}</span>
          <Button size="sm" className="h-7 text-[11px]" onClick={linkSelectedToActive} disabled={selectedCount === 0}>
            <Link2 className="w-3 h-3 mr-1" /> Vincular selecionados
          </Button>
        </div>
      </div>
    </div>
  );
}
