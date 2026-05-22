import { Button } from '@/components/ui/button';
import { ClipboardList, FileSpreadsheet, Printer, History, RefreshCw, ChevronRight } from 'lucide-react';

interface MeasurementHeaderProps {
  undoButton?: React.ReactNode;
  onExportXLSX: () => void;
  onPrint: () => void;
  showHistory: boolean;
  onOpenHistory: () => void;
  onSyncWithGantt?: () => void;
}

export default function MeasurementHeader({
  undoButton,
  onExportXLSX,
  onPrint,
  showHistory,
  onOpenHistory,
  onSyncWithGantt,
}: MeasurementHeaderProps) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-[var(--shadow-sm)] print:hidden">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center ring-1 ring-primary/15">
          <ClipboardList className="w-[18px] h-[18px] text-primary" />
        </div>
        <div className="min-w-0">
          <nav aria-label="breadcrumb" className="flex items-center gap-1 text-[11px] text-muted-foreground font-medium">
            <span>Obra</span>
            <ChevronRight className="w-3 h-3 opacity-60" />
            <span>Financeiro</span>
            <ChevronRight className="w-3 h-3 opacity-60" />
            <span className="text-foreground">Medição</span>
          </nav>
          <h1 className="text-[20px] font-semibold leading-tight tracking-tight text-foreground mt-0.5">Medição</h1>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {undoButton}
        {onSyncWithGantt && (
          <Button className="h-9 rounded-lg" variant="ghost" size="sm" onClick={onSyncWithGantt} title="Recalcular as datas das medições a partir da data inicial do Cronograma/Gantt">
            <RefreshCw className="w-4 h-4 mr-1.5" /> Sincronizar
          </Button>
        )}
        <Button className="h-9 rounded-lg" variant="ghost" size="sm" onClick={onExportXLSX}>
          <FileSpreadsheet className="w-4 h-4 mr-1.5" /> Excel
        </Button>
        <Button className="h-9 rounded-lg" variant="ghost" size="sm" onClick={onPrint}>
          <Printer className="w-4 h-4 mr-1.5" /> PDF
        </Button>
        {showHistory && (
          <Button className="h-9 rounded-lg" variant="ghost" size="sm" onClick={onOpenHistory}>
            <History className="w-4 h-4 mr-1.5" /> Histórico
          </Button>
        )}
      </div>
    </div>
  );
}
