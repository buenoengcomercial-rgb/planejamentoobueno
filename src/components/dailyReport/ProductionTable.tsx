import { Camera } from 'lucide-react';
import type { ProductionEntry } from '@/components/dailyReport/types';

interface ProductionTableProps {
  entries: ProductionEntry[];
  photosByTask?: Map<string, number>;
  onShowPhotos?: (taskId: string) => void;
}

export function ProductionTable({ entries, photosByTask, onShowPhotos }: ProductionTableProps) {
  return (
    <>
    <div className="space-y-2 sm:hidden">
      {entries.map(e => {
        const count = photosByTask?.get(e.taskId) || 0;
        return (
          <article key={e.taskId + (e.notes || '')} className="rounded-lg border border-border bg-card p-3">
            <p className="text-sm font-semibold leading-snug text-foreground">{e.taskName}</p>
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              <div><dt className="text-xs text-muted-foreground">Unidade</dt><dd>{e.unit}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Qtd. executada</dt><dd className="font-semibold">{e.actualQuantity.toFixed(2)}</dd></div>
              <div className="col-span-2"><dt className="text-xs text-muted-foreground">Observação</dt><dd>{e.notes || '—'}</dd></div>
            </dl>
            {count > 0 && (
              <button type="button" onClick={() => onShowPhotos?.(e.taskId)} className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary">
                <Camera className="h-4 w-4" /> Ver {count} foto(s) vinculada(s)
              </button>
            )}
          </article>
        );
      })}
    </div>
    <div className="hidden overflow-hidden rounded-md border border-border sm:block">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 font-semibold">Tarefa</th>
            <th className="text-center px-3 py-2 font-semibold w-24">Unid.</th>
            <th className="text-right px-3 py-2 font-semibold w-32">Qtd. executada</th>
            <th className="text-left px-3 py-2 font-semibold">Observação</th>
            <th className="text-center px-3 py-2 font-semibold w-24">Fotos</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(e => {
            const count = photosByTask?.get(e.taskId) || 0;
            return (
              <tr key={e.taskId + (e.notes || '')} className="border-t border-border">
                <td className="px-3 py-2">{e.taskName}</td>
                <td className="px-3 py-2 text-center text-muted-foreground">{e.unit}</td>
                <td className="px-3 py-2 text-right font-semibold">{e.actualQuantity.toFixed(2)}</td>
                <td className="px-3 py-2 text-muted-foreground">{e.notes || '—'}</td>
                <td className="px-3 py-2 text-center">
                  {count > 0 ? (
                    <button
                      type="button"
                      onClick={() => onShowPhotos?.(e.taskId)}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      title="Ver fotos vinculadas"
                    >
                      <Camera className="w-3 h-3" /> {count}
                    </button>
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}
