import type { DailyReport as DailyReportEntry } from '@/types/project';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CommitOnBlurTextarea } from '@/components/dailyReport/CommitOnBlurField';

type DailyTextField = 'occurrences' | 'impediments' | 'observations';

interface DailyReportTextAreasProps {
  currentReport: DailyReportEntry;
  updateField: <K extends keyof DailyReportEntry>(key: K, value: DailyReportEntry[K]) => void;
}

interface DeferredTextareaProps {
  field: DailyTextField;
  value: string;
  placeholder: string;
  updateField: DailyReportTextAreasProps['updateField'];
}

function DeferredTextarea({ field, value, placeholder, updateField }: DeferredTextareaProps) {
  return <CommitOnBlurTextarea rows={4} value={value} placeholder={placeholder} onCommit={next => updateField(field, next)} />;
}

export function DailyReportTextAreas({ currentReport, updateField }: DailyReportTextAreasProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Ocorrências</CardTitle></CardHeader>
        <CardContent>
          <DeferredTextarea key={`occurrences:${currentReport.id}`} field="occurrences" value={currentReport.occurrences || ''}
            updateField={updateField} placeholder="Fatos importantes do dia..." />
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Impedimentos</CardTitle></CardHeader>
        <CardContent>
          <DeferredTextarea key={`impediments:${currentReport.id}`} field="impediments" value={currentReport.impediments || ''}
            updateField={updateField} placeholder="Problemas que afetaram a produção..." />
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Observações gerais</CardTitle></CardHeader>
        <CardContent>
          <DeferredTextarea key={`observations:${currentReport.id}`} field="observations" value={currentReport.observations || ''}
            updateField={updateField} placeholder="Notas adicionais..." />
        </CardContent>
      </Card>
    </div>
  );
}

