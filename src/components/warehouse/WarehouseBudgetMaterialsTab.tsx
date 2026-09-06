import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ClipboardCheck, PackageSearch, Search } from 'lucide-react';
import type { Project } from '@/types/project';
import type { WarehouseBudgetMaterialRow } from '@/lib/warehouseBudgetMaterials';
import { warehouseBudgetMaterialsByChapter } from '@/lib/warehouseBudgetMaterials';
import { Input } from '@/components/ui/input';

const qty = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
type SortKey = 'description' | 'unit' | 'contractedQuantity' | 'additiveQuantity' | 'totalQuantity' | 'withdrawnQuantity' | 'suppressedQuantity' | 'situation';
type SortDirection = 'asc' | 'desc';

const situation = (row: WarehouseBudgetMaterialRow) => row.totalQuantity <= 0 && row.suppressedQuantity > 0 ? '100% suprimido' : row.additiveQuantity > 0 ? 'Com aditivo' : 'Contratado';

function SortableHeader({ label, align = 'left', sortKey, currentKey, direction, onSort }: {
  label: string; align?: 'left' | 'right'; sortKey: SortKey; currentKey: SortKey; direction: SortDirection; onSort: (key: SortKey) => void;
}) {
  const active = currentKey === sortKey;
  const Icon = direction === 'asc' ? ArrowUp : ArrowDown;
  return <th aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'} className={`p-3 text-${align}`}>
    <button type="button" onClick={() => onSort(sortKey)} className={`inline-flex items-center gap-1 font-semibold hover:text-foreground ${align === 'right' ? 'ml-auto' : ''}`}>
      {label}{active && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
    </button>
  </th>;
}

export default function WarehouseBudgetMaterialsTab({ project }: { project: Project }) {
  const chapters = useMemo(() => warehouseBudgetMaterialsByChapter(project), [project]);
  const [chapterId, setChapterId] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: 'description', direction: 'asc' });
  const selected = chapters.find(chapter => chapter.id === chapterId) ?? chapters[0];
  const normalizedSearch = search.trim().toLocaleLowerCase('pt-BR');
  const rows = (selected?.rows ?? [])
    .filter(row => !normalizedSearch || `${row.code ?? ''} ${row.description}`.toLocaleLowerCase('pt-BR').includes(normalizedSearch))
    .sort((left, right) => {
      const leftValue = sort.key === 'situation' ? situation(left) : left[sort.key];
      const rightValue = sort.key === 'situation' ? situation(right) : right[sort.key];
      const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
        ? leftValue - rightValue
        : collator.compare(String(leftValue), String(rightValue));
      return sort.direction === 'asc' ? comparison : -comparison;
    });
  const toggleSort = (key: SortKey) => setSort(current => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));

  if (!chapters.length) return <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground"><PackageSearch className="mx-auto mb-2 h-6 w-6" />Não há materiais analíticos vinculados ao orçamento.</div>;
  return <section className="space-y-4">
    <header className="rounded-2xl border border-primary/15 bg-gradient-to-r from-primary/[0.09] via-primary/[0.04] to-transparent p-4 shadow-sm"><div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-primary/15 bg-background text-primary shadow-sm"><ClipboardCheck className="h-5 w-5" /></span><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Planejamento e consumo</p><h3 className="mt-0.5 text-lg font-semibold tracking-tight">Materiais do orçamento</h3><p className="mt-1 max-w-4xl text-sm text-muted-foreground">Compare o planejado com o que já está em campo. Acréscimos e supressões de aditivos permanecem visíveis sem misturar as quantidades.</p></div></div></header>
    <div className="rounded-xl border bg-card p-3 shadow-sm"><div className="grid gap-3 md:grid-cols-[minmax(16rem,0.45fr)_minmax(18rem,0.55fr)]"><label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Capítulo<select aria-label="Capítulo" className="mt-1.5 min-h-11 w-full rounded-md border bg-background px-3 text-sm font-medium text-foreground" value={selected?.id ?? ''} onChange={event => setChapterId(event.target.value)}>{chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.number ? `${chapter.number} — ` : ''}{chapter.name}</option>)}</select></label><label className="relative text-xs font-semibold uppercase tracking-wide text-muted-foreground">Buscar material<Search className="absolute bottom-3.5 left-3 h-4 w-4 text-muted-foreground" /><Input className="mt-1.5 min-h-11 border-input bg-background pl-9 text-sm" placeholder="Código ou descrição" value={search} onChange={event => setSearch(event.target.value)} /></label></div></div>
    <div className="space-y-2 md:hidden">{rows.map(row => <article key={row.key} className={`rounded-xl border border-l-4 bg-card p-3 shadow-sm ${row.totalQuantity <= 0 ? 'border-l-destructive border-destructive/40 bg-destructive/[0.035]' : row.additiveQuantity > 0 ? 'border-l-amber-500' : 'border-l-primary'}`}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="font-semibold leading-snug">{row.description}</p></div>{row.totalQuantity <= 0 ? <span className="shrink-0 rounded-md bg-destructive/10 px-2 py-1 text-[11px] font-semibold text-destructive">Suprimido</span> : row.additiveQuantity > 0 && <span className="shrink-0 rounded-md bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-900">Aditivo</span>}</div><dl className="mt-3 grid grid-cols-2 gap-2 border-t pt-3 text-xs"><div><dt className="text-muted-foreground">Planejado</dt><dd className="mt-0.5 font-semibold tabular-nums">{qty(row.totalQuantity)} {row.unit}</dd></div><div className="text-right"><dt className="text-muted-foreground">Em campo</dt><dd className="mt-0.5 font-semibold tabular-nums text-primary">{qty(row.withdrawnQuantity)} {row.unit}</dd></div><div><dt className="text-muted-foreground">Aditivo</dt><dd className="mt-0.5 font-semibold tabular-nums text-amber-800">{row.additiveQuantity ? `+${qty(row.additiveQuantity)}` : '—'}</dd></div><div className="text-right"><dt className="text-muted-foreground">Suprimido</dt><dd className="mt-0.5 font-semibold tabular-nums text-destructive">{row.suppressedQuantity ? `-${qty(row.suppressedQuantity)}` : '—'}</dd></div></dl>{row.additiveStatuses.length > 0 && <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-900">Aditivo: {row.additiveStatuses.join(', ')}</p>}</article>)}</div>
    <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm md:block"><table className="w-full min-w-[1080px] text-sm"><thead className="border-b bg-muted/75 text-xs text-muted-foreground"><tr><SortableHeader label="Material" sortKey="description" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader label="Un." sortKey="unit" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader label="Contratado" align="right" sortKey="contractedQuantity" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader label="Aditivo" align="right" sortKey="additiveQuantity" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader label="Total planejado" align="right" sortKey="totalQuantity" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader label="Retirado líquido" align="right" sortKey="withdrawnQuantity" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader label="Suprimido" align="right" sortKey="suppressedQuantity" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader label="Situação" sortKey="situation" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /></tr></thead><tbody>{rows.map((row, index) => <tr key={row.key} className={`border-t transition-colors hover:bg-muted/45 ${row.totalQuantity <= 0 ? 'bg-destructive/[0.035]' : index % 2 === 0 ? 'bg-background' : 'bg-muted/[0.18]'}`}><td className="min-w-[340px] p-3.5"><div className="font-semibold leading-snug">{row.description}</div></td><td className="p-3.5 text-center font-medium">{row.unit}</td><td className="p-3.5 text-right tabular-nums">{qty(row.contractedQuantity)}</td><td className="bg-amber-50/50 p-3.5 text-right font-semibold tabular-nums text-amber-800">{row.additiveQuantity ? `+${qty(row.additiveQuantity)}` : '—'}</td><td className="p-3.5 text-right font-semibold tabular-nums">{qty(row.totalQuantity)}</td><td className="bg-primary/[0.045] p-3.5 text-right font-semibold tabular-nums text-primary">{qty(row.withdrawnQuantity)}</td><td className="p-3.5 text-right font-semibold tabular-nums text-destructive">{row.suppressedQuantity ? `-${qty(row.suppressedQuantity)}` : '—'}</td><td className="p-3.5">{row.totalQuantity <= 0 ? <span className="inline-flex rounded-md bg-destructive/10 px-2 py-1 text-xs font-semibold text-destructive">100% suprimido</span> : row.additiveQuantity > 0 ? <span className="inline-flex rounded-md bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-900">Aditivo{row.additiveStatuses.length ? ` · ${row.additiveStatuses.join(', ')}` : ''}</span> : <span className="inline-flex rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">Contratado</span>}</td></tr>)}</tbody></table></div>
    {rows.length === 0 && <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Nenhum material encontrado neste capítulo.</div>}
  </section>;
}
