import type { ReactNode } from 'react';
import { NotebookPen, CalendarDays, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatBR } from '@/components/dailyReport/dailyReportFormat';
import type { MeasurementPeriod } from '@/hooks/useDailyReportPeriods';

interface DailyReportHeaderProps {
  undoButton?: ReactNode;
  measurementFilter: string;
  setMeasurementFilter: (v: string) => void;
  measurementPeriods: MeasurementPeriod[];
  activePeriod: MeasurementPeriod | null;
  periodDates: string[];
  selectedDate: string;
  setSelectedDate: (d: string) => void;
  handlePrintDay: () => void;
  handlePrintPeriod: () => void;
}

export function DailyReportHeader({
  undoButton,
  measurementFilter,
  setMeasurementFilter,
  measurementPeriods,
  activePeriod,
  periodDates,
  selectedDate,
  setSelectedDate,
  handlePrintDay,
  handlePrintPeriod,
}: DailyReportHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-lg bg-primary/10 flex items-center justify-center">
          <NotebookPen className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-[22px] font-bold leading-tight text-foreground">Diário de Obra</h1>
          <p className="text-sm text-muted-foreground">
            Registro diário de equipes, ocorrências e produção da obra.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {undoButton}
        <Select value={measurementFilter} onValueChange={setMeasurementFilter}>
          <SelectTrigger className="h-10 w-[240px] text-sm">
            <SelectValue placeholder="Filtrar por medição" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as datas</SelectItem>
            {measurementPeriods.map(p => (
              <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {activePeriod && periodDates.length > 0 ? (
          <Select value={selectedDate} onValueChange={setSelectedDate}>
            <SelectTrigger className="h-10 w-[180px] text-sm">
              <SelectValue placeholder="Data" />
            </SelectTrigger>
            <SelectContent className="max-h-[260px]">
              {periodDates.map(d => (
                <SelectItem key={d} value={d}>{formatBR(d)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex h-10 items-center gap-2 bg-card border border-border rounded-lg px-3">
            <CalendarDays className="w-4 h-4 text-muted-foreground" />
            <input
              type="date"
              value={selectedDate}
              onChange={e => setSelectedDate(e.target.value)}
              className="bg-transparent text-sm focus:outline-none"
            />
          </div>
        )}
        <Button onClick={handlePrintDay} variant="outline" size="sm" className="h-10 text-sm" title="Exporta apenas a data selecionada">
          <Printer className="w-4 h-4 mr-1.5" /> PDF do dia
        </Button>
        {activePeriod && (
          <Button onClick={handlePrintPeriod} variant="default" size="sm" className="h-10 text-sm" title="Exporta todos os dias do período da medição">
            <Printer className="w-4 h-4 mr-1.5" /> PDF da medição
          </Button>
        )}
      </div>
    </div>
  );
}
