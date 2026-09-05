import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, PackageSearch, Search } from 'lucide-react';
import type { Project } from '@/types/project';
import { warehouseWithdrawnMaterialsByChapter } from '@/lib/warehouseWithdrawnMaterials';
import { Input } from '@/components/ui/input';

const qty = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
type SortKey = 'description' | 'unit' | 'receiverName' | 'withdrawnQuantity';
type SortDirection = 'asc' | 'desc';

function SortableHeader({ label, align = 'left', className = '', sortKey, currentKey, direction, onSort }: {
  label: string; align?: 'left' | 'right'; className?: string; sortKey: SortKey; currentKey: SortKey; direction: SortDirection; onSort: (key: SortKey) => void;
}) {
  const active = currentKey === sortKey;
  const Icon = direction === 'asc' ? ArrowUp : ArrowDown;
  return <th aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'} className={`p-3 text-${align} ${className}`}><button type="button" onClick={() => onSort(sortKey)} className={`inline-flex items-center gap-1 font-semibold hover:text-foreground ${align === 'right' ? 'ml-auto' : ''}`}>{label}{active && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}</button></th>;
}

export default function WarehouseWithdrawnMaterialsTab({ project }: { project: Project }) {
  const chapters = useMemo(() => warehouseWithdrawnMaterialsByChapter(project), [project]);
  const [chapterId, setChapterId] = useState('');
  const [receiverName, setReceiverName] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: 'withdrawnQuantity', direction: 'desc' });
  const selected = chapters.find(chapter => chapter.id === chapterId) ?? chapters[0];
  const receivers = Array.from(new Set((selected?.rows ?? []).map(row => row.receiverName))).sort((left, right) => collator.compare(left, right));
  const normalizedSearch = search.trim().toLocaleLowerCase('pt-BR');
  const rows = (selected?.rows ?? [])
    .filter(row => !receiverName || row.receiverName === receiverName)
    .filter(row => !normalizedSearch || `${row.code ?? ''} ${row.description}`.toLocaleLowerCase('pt-BR').includes(normalizedSearch))
    .sort((left, right) => {
      const leftValue = left[sort.key];
      const rightValue = right[sort.key];
      const comparison = typeof leftValue === 'number' && typeof rightValue === 'number' ? leftValue - rightValue : collator.compare(String(leftValue), String(rightValue));
      const ordered = sort.direction === 'asc' ? comparison : -comparison;
      return ordered || left.description.localeCompare(right.description, 'pt-BR');
    });
  const toggleSort = (key: SortKey) => setSort(current => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));

  if (!chapters.length) return <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground"><PackageSearch className="mx-auto mb-2 h-6 w-6" />Não há materiais retirados em requisições entregues.</div>;
  return <section className="max-w-6xl space-y-3">
    <div className="rounded-xl border bg-card p-3"><h3 className="font-semibold">Materiais retirados</h3><p className="mt-1 text-xs text-muted-foreground">Consulta de materiais físicos efetivamente em campo por capítulo e recebedor. Retirado líquido desconta somente devoluções operacionais vinculadas à mesma requisição e material.</p></div>
    <div className="grid gap-2 md:grid-cols-3">
      <label className="text-sm font-medium">Capítulo<select aria-label="Capítulo" className="mt-1 min-h-11 w-full rounded-md border bg-background px-3 text-base" value={selected?.id ?? ''} onChange={event => { setChapterId(event.target.value); setReceiverName(''); }}>{chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.number ? `${chapter.number} — ` : ''}{chapter.name}</option>)}</select></label>
      <label className="text-sm font-medium">Recebedor<select aria-label="Recebedor" className="mt-1 min-h-11 w-full rounded-md border bg-background px-3 text-base" value={receiverName} onChange={event => setReceiverName(event.target.value)}><option value="">Todos os recebedores</option>{receivers.map(receiver => <option key={receiver} value={receiver}>{receiver}</option>)}</select></label>
      <label className="relative text-sm font-medium">Buscar material<Search className="absolute bottom-3 left-3 h-4 w-4 text-muted-foreground" /><Input className="mt-1 min-h-11 pl-9 text-base" placeholder="Código ou descrição" value={search} onChange={event => setSearch(event.target.value)} /></label>
    </div>
    <div className="text-xs text-muted-foreground">Ordem hierárquica: maior quantidade líquida retirada primeiro · {rows.length} material(is) no capítulo {selected?.number || selected?.name}.</div>
    <div className="space-y-2 md:hidden">{rows.map(row => <article key={row.key} className="rounded-lg border bg-card p-3"><div><p className="font-medium">{row.description}</p><p className="text-xs text-muted-foreground">{row.code ? `${row.code} · ` : ''}{row.unit}</p></div><dl className="mt-3 grid grid-cols-2 gap-2 text-xs"><div><dt className="text-muted-foreground">Recebedor</dt><dd className="font-semibold">{row.receiverName}</dd></div><div><dt className="text-muted-foreground">Retirado líquido</dt><dd className="font-semibold text-primary">{qty(row.withdrawnQuantity)}</dd></div></dl></article>)}</div>
    <div className="hidden overflow-x-auto rounded-xl border md:block"><table className="w-full table-fixed text-sm"><thead className="bg-muted/70 text-xs text-muted-foreground"><tr><SortableHeader className="w-[58%]" label="Material" sortKey="description" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader className="w-[22%]" label="Recebedor" sortKey="receiverName" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader className="w-[20%]" label="Retirado líquido" align="right" sortKey="withdrawnQuantity" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /></tr></thead><tbody>{rows.map(row => <tr key={row.key} className="border-t"><td className="p-3"><div className="font-medium">{row.description}</div>{row.code && <div className="text-xs text-muted-foreground">{row.code}</div>}</td><td className="p-3">{row.receiverName}</td><td className="bg-primary/5 p-3 text-right font-semibold tabular-nums text-primary"><span>{qty(row.withdrawnQuantity)}</span><span className="ml-1 text-xs font-medium text-foreground">{row.unit}</span></td></tr>)}</tbody></table></div>
    {rows.length === 0 && <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Nenhum material encontrado neste capítulo e recebedor.</div>}
  </section>;
}
