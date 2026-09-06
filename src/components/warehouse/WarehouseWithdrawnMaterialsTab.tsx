import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Boxes, PackageSearch, Search, Users } from 'lucide-react';
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
  const withdrawnTotal = rows.reduce((total, row) => total + row.withdrawnQuantity, 0);

  if (!chapters.length) return <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground"><PackageSearch className="mx-auto mb-2 h-6 w-6" />Não há materiais retirados em requisições entregues.</div>;
  return <section className="max-w-6xl space-y-4">
    <header className="rounded-2xl border border-primary/15 bg-gradient-to-r from-primary/[0.09] via-primary/[0.04] to-transparent p-4 shadow-sm">
      <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-primary/15 bg-background text-primary shadow-sm"><Boxes className="h-5 w-5" /></span><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Controle de campo</p><h3 className="mt-0.5 text-lg font-semibold tracking-tight">Materiais retirados</h3><p className="mt-1 max-w-3xl text-sm text-muted-foreground">Materiais efetivamente em campo, organizados por capítulo e recebedor. O saldo retirado já desconta as devoluções vinculadas.</p></div></div>
    </header>
    <div className="rounded-xl border bg-card p-3 shadow-sm"><div className="grid gap-3 md:grid-cols-3">
      <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Capítulo<select aria-label="Capítulo" className="mt-1.5 min-h-11 w-full rounded-md border bg-background px-3 text-sm font-medium text-foreground" value={selected?.id ?? ''} onChange={event => { setChapterId(event.target.value); setReceiverName(''); }}>{chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.number ? `${chapter.number} — ` : ''}{chapter.name}</option>)}</select></label>
      <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recebedor<select aria-label="Recebedor" className="mt-1.5 min-h-11 w-full rounded-md border bg-background px-3 text-sm font-medium text-foreground" value={receiverName} onChange={event => setReceiverName(event.target.value)}><option value="">Todos os recebedores</option>{receivers.map(receiver => <option key={receiver} value={receiver}>{receiver}</option>)}</select></label>
      <label className="relative text-xs font-semibold uppercase tracking-wide text-muted-foreground">Buscar material<Search className="absolute bottom-3.5 left-3 h-4 w-4 text-muted-foreground" /><Input className="mt-1.5 min-h-11 border-input bg-background pl-9 text-sm" placeholder="Código ou descrição" value={search} onChange={event => setSearch(event.target.value)} /></label>
    </div></div>
    <div className="grid gap-2 sm:grid-cols-3"><div className="rounded-xl border bg-card px-3 py-2.5"><p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Capítulo consultado</p><p className="mt-1 text-sm font-semibold">{selected?.number ? `${selected.number} — ` : ''}{selected?.name}</p></div><div className="rounded-xl border bg-card px-3 py-2.5"><p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Materiais visíveis</p><p className="mt-1 text-lg font-semibold tabular-nums">{rows.length}</p></div><div className="rounded-xl border border-primary/20 bg-primary/[0.04] px-3 py-2.5"><p className="text-[11px] font-semibold uppercase tracking-wide text-primary">Em campo · líquido</p><p className="mt-1 text-lg font-semibold tabular-nums text-primary">{qty(withdrawnTotal)} <span className="text-xs font-medium">unidades</span></p></div></div>
    <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" />Ordem hierárquica: maior quantidade líquida retirada primeiro. Ordene pelo cabeçalho para comparar materiais, recebedores e volume em campo.</div>
    <div className="space-y-2 md:hidden">{rows.map(row => <article key={row.key} className="border-l-4 border-l-primary rounded-xl border bg-card p-3 shadow-sm"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-semibold leading-snug">{row.description}</p>{row.code && <p className="mt-1 text-xs text-muted-foreground">Código: {row.code}</p>}</div><span className="shrink-0 rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">{row.unit}</span></div><dl className="mt-3 grid grid-cols-2 gap-2 border-t pt-3 text-xs"><div><dt className="text-muted-foreground">Recebedor</dt><dd className="mt-0.5 font-semibold">{row.receiverName}</dd></div><div className="text-right"><dt className="text-muted-foreground">Retirado líquido</dt><dd className="mt-0.5 font-semibold tabular-nums text-primary">{qty(row.withdrawnQuantity)} {row.unit}</dd></div></dl></article>)}</div>
    <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm md:block"><table className="w-full min-w-[720px] table-fixed text-sm"><thead className="border-b bg-muted/75 text-xs text-muted-foreground"><tr><SortableHeader className="w-[56%]" label="Material" sortKey="description" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader className="w-[25%]" label="Recebedor" sortKey="receiverName" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /><SortableHeader className="w-[19%] bg-primary/[0.06]" label="Retirado líquido" align="right" sortKey="withdrawnQuantity" currentKey={sort.key} direction={sort.direction} onSort={toggleSort} /></tr></thead><tbody>{rows.map((row, index) => <tr key={row.key} className={`border-t transition-colors hover:bg-muted/45 ${index % 2 === 0 ? 'bg-background' : 'bg-muted/[0.18]'}`}><td className="p-3.5"><div className="font-semibold leading-snug">{row.description}</div>{row.code && <div className="mt-1 text-xs text-muted-foreground">Código: {row.code}</div>}</td><td className="p-3.5"><span className="inline-flex max-w-full rounded-md border bg-background px-2 py-1 text-xs font-medium">{row.receiverName}</span></td><td className="bg-primary/[0.045] p-3.5 text-right font-semibold tabular-nums text-primary"><span className="text-base">{qty(row.withdrawnQuantity)}</span><span className="ml-1 text-xs font-medium text-foreground">{row.unit}</span></td></tr>)}</tbody></table></div>
    {rows.length === 0 && <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Nenhum material encontrado neste capítulo e recebedor.</div>}
  </section>;
}
