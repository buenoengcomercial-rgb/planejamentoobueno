import type { DailyReport as DailyReportEntry } from '@/types/project';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';

interface DailyReportTextAreasProps {
  currentReport: DailyReportEntry;
  updateField: <K extends keyof DailyReportEntry>(key: K, value: DailyReportEntry[K]) => void;
}

export function DailyReportTextAreas({ currentReport, updateField }: DailyReportTextAreasProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Ocorrências</CardTitle></CardHeader>
        <CardContent>
          <Textarea rows={4} value={currentReport.occurrences || ''}
            onChange={e => updateField('occurrences', e.target.value)}
            placeholder="Fatos importantes do dia..." />
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Impedimentos</CardTitle></CardHeader>
        <CardContent>
          <Textarea rows={4} value={currentReport.impediments || ''}
            onChange={e => updateField('impediments', e.target.value)}
            placeholder="Problemas que afetaram a produção..." />
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Observações gerais</CardTitle></CardHeader>
        <CardContent>
          <Textarea rows={4} value={currentReport.observations || ''}
            onChange={e => updateField('observations', e.target.value)}
            placeholder="Notas adicionais..." />
        </CardContent>
      </Card>
    </div>
  );
}

