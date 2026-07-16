import { ListChecks } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { formatBR } from '@/components/dailyReport/dailyReportFormat';
import { ProductionTable } from '@/components/dailyReport/ProductionTable';
import type { ProductionGroup } from '@/hooks/useDailyReportProduction';

interface DailyReportProductionSectionProps {
  selectedDate: string;
  grouped: ProductionGroup[];
  photosByTask: Map<string, number>;
  setPhotoFilter: (v: string) => void;
}

export function DailyReportProductionSection({
  selectedDate,
  grouped,
  photosByTask,
  setPhotoFilter,
}: DailyReportProductionSectionProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-primary" />
          Produção executada no dia ({formatBR(selectedDate)})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {grouped.length === 0 ? (
          <p className="text-sm text-muted-foreground italic py-3">
            Nenhum apontamento de produção lançado nesta data.
          </p>
        ) : (
          <div className="space-y-4">
            {grouped.map(ch => (
              <div key={ch.chapterNumber + ch.chapterName} className="space-y-2">
                <div className="font-semibold text-base text-foreground">
                  {ch.chapterNumber} — {ch.chapterName}
                </div>
                {ch.direct.length > 0 && (
                  <ProductionTable entries={ch.direct} photosByTask={photosByTask} onShowPhotos={(taskId) => setPhotoFilter(taskId)} />
                )}
                {Array.from(ch.subs.values()).map(sub => (
                  <div key={sub.number + sub.name} className="ml-4 space-y-1">
                    <div className="text-sm font-medium text-muted-foreground">
                      {sub.number} — {sub.name}
                    </div>
                    <ProductionTable entries={sub.entries} photosByTask={photosByTask} onShowPhotos={(taskId) => setPhotoFilter(taskId)} />
                  </div>
                ))}
                <Separator />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
