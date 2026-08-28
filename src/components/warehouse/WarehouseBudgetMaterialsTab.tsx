import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Search, PackageSearch } from 'lucide-react';
import type { Project } from '@/types/project';
import type { WarehouseBudgetMaterialRow } from '@/lib/warehouseBudgetMaterials';
import { warehouseBudgetMaterialsByChapter } from '@/lib/warehouseBudgetMaterials';
import { Input } from '@/components/ui/input';

const qty = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
type SortKey = 'description' | 'unit' | 'contractedQuantity' | 'additiveQuantity' | 'totalQuantity' | 'situation';
type SortDirection = 'asc' | 'desc';

const situation = (row: WarehouseBudgetMaterialRow) => row.additiveQuantity > 0 ? 'Com aditivo' : 'Contratado';

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
  return <section className="space-y-3">
    <div className="rounded-xl border bg-card p-3"><h3 className="font-semibold">Materiais do orçamento</h3><p className="mt-1 text-xs text-muted-foreground">Consulta por capítulo principal. Subcapítulos são consolidados no respectivo capítulo; materiais totalmente suprimidos não aparecem.</p></div>
    <div className="grid gap-2 md:grid-cols-[minmax(16rem,0.45fr)_minmax(18rem,0.55fr)]">
      <label className="text-sm font-medium">Capítulo<select className="mt-1 min-h-11 w-full rounded-md border bg-background px-3 text-base" value={selected?.id ?? ''} onChange={event => setChapterId(event.target.value)}>{chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.number ? `${chapter.number} — ` : ''}{chapter.name}</option>)}</select></label>
      <label className="relative text-sm font-medium">Buscar material<Search className="absolute bottom-3 left-3 h-4 w-4 text-muted-foreground" /><Input className="mt-1 min-h-11 pl-9 text-base" placeholder="Código ou descrição" value={search} onChange={event => setSearch(event.target.value)} /></label>
    </div>
    <div className="text-xs text-muted-foreground">{rows.length} material(is) no capítulo {selected?.number || selected?.name}.</div>
    <div className="space-y-2 md:hidden">{rows.map(row => <article key={row.key} className="rounded-lg border bg-card p-3"><div className="flex items-start justify-between gap-2"><div><p className="font-medium">{row.description}</p><p className="text-xs text-muted-foreground">{row.code ? `${row.bank ? `${row.bank} ` : ''}${row.code} · ` : ''}{row.unit}</p></div>{row.additiveQuantity > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-900">Com aditivo</span>}</div><dl className="mt-3 grid grid-cols-3 gap-2 text-xs"><div><dt className="text-muted-foreground">Contratado</dt><dd className="font-semibold">{qty(row.contractedQuantity)}</dd></div><div><dt className="text-muted-foreground">Aditivo</dt><dd className="font-semibold">{row.additiveQuantity ? qty(row.additiveQuantity) : '—'}</dd></div><div><dt className="text-muted-foreground">Total</dt><dd className="font-semibold">{qty(row.totalQuantity)}</dd></div></dl>{row.additiveStatuses.length > 0 && <p className="mt-2 text-[11px] text-amber-800">Aditivo: {row.additiveStatuses.join(', ')}</p>}</article>)}</div>
    <div className="hidden overflow-x-auto rounded-xl border md:block"><table className="w-full min-w-[760px] text-sm"><thead className="bg-muted/70 text-xs text-muted-foreground"><tr><SortableHeader label="Material" sortKey="description" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader label="Un." sortKey="unit" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader label="Contratado" align="right" sortKey="contractedQuantity" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader label="Aditivo" align="right" sortKey="additiveQuantity" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader label="Total planejado" align="right" sortKey="totalQuantity" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader label="Situação" sortKey="situation" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /></tr></thead><tbody>{rows.map(row => <tr key={row.key} className="border-t"><td className="p-3"><div className="font-medium">{row.description}</div>{row.code && <div className="text-xs text-muted-foreground">{row.bank} {row.code}</div>}</td><td className="p-3">{row.unit}</td><td className="p-3 text-right tabular-nums">{qty(row.contractedQuantity)}</td><td className="p-3 text-right tabular-nums">{row.additiveQuantity ? qty(row.additiveQuantity) : '—'}</td><td className="p-3 text-right font-semibold tabular-nums">{qty(row.totalQuantity)}</td><td className="p-3">{row.additiveQuantity > 0 ? <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-900">Com aditivo · {row.additiveStatuses.join(', ')}</span> : <span className="text-muted-foreground">Contratado</span>}</td></tr>)}</tbody></table></div>
    {rows.length === 0 && <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Nenhum material encontrado neste capítulo.</div>}
  </section>;
}
