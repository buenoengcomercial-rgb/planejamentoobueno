import { Wrench, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { DailyReport as DailyReportEntry, DailyReportEquipmentRow } from '@/types/project';

interface DailyReportEquipmentCardProps {
  currentReport: DailyReportEntry;
  addEqRow: () => void;
  updateEqRow: (id: string, patch: Partial<DailyReportEquipmentRow>) => void;
  removeEqRow: (id: string) => void;
}

export function DailyReportEquipmentCard({
  currentReport,
  addEqRow,
  updateEqRow,
  removeEqRow,
}: DailyReportEquipmentCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <Wrench className="w-4 h-4 text-info" /> Equipamentos
        </CardTitle>
        <Button size="sm" variant="ghost" onClick={addEqRow}>
          <Plus className="w-3.5 h-3.5 mr-1" /> Adicionar
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {(currentReport.equipment || []).length === 0 && (
          <p className="text-xs text-muted-foreground italic">Nenhum equipamento lançado.</p>
        )}
        {(currentReport.equipment || []).map(e => (
          <div key={e.id} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_70px_1fr_auto] sm:items-center sm:border-0 sm:p-0">
            <div className="space-y-1"><span className="text-xs text-muted-foreground sm:hidden">Equipamento</span><Input className="min-h-11 text-base sm:min-h-10 sm:text-sm" placeholder="Equipamento" value={e.name}
              onChange={ev => updateEqRow(e.id, { name: ev.target.value })} /></div>
            <div className="space-y-1"><span className="text-xs text-muted-foreground sm:hidden">Quantidade</span><Input className="min-h-11 text-base sm:min-h-10 sm:text-sm" type="number" min={0} placeholder="Qtd" value={e.count ?? ''}
              onChange={ev => updateEqRow(e.id, { count: Number(ev.target.value) })} /></div>
            <div className="space-y-1"><span className="text-xs text-muted-foreground sm:hidden">Observação</span><Input className="min-h-11 text-base sm:min-h-10 sm:text-sm" placeholder="Observação" value={e.notes || ''}
              onChange={ev => updateEqRow(e.id, { notes: ev.target.value })} /></div>
            <Button size="icon" variant="ghost" className="min-h-11 min-w-11 justify-self-end" onClick={() => removeEqRow(e.id)}>
              <Trash2 className="w-4 h-4 text-destructive" />
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
