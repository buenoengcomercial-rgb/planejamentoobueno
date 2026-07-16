import { Camera } from 'lucide-react';
import type { ProductionEntry } from '@/components/dailyReport/types';

interface ProductionTableProps {
  entries: ProductionEntry[];
  photosByTask?: Map<string, number>;
  onShowPhotos?: (taskId: string) => void;
}

export function ProductionTable({ entries, photosByTask, onShowPhotos }: ProductionTableProps) {
  return (
    <div className="border border-border rounded-md overflow-hidden">
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
  );
}
