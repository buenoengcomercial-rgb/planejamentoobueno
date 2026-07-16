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
          <div key={e.id} className="grid grid-cols-[1fr_70px_1fr_auto] gap-2 items-center">
            <Input placeholder="Equipamento" value={e.name}
              onChange={ev => updateEqRow(e.id, { name: ev.target.value })} />
            <Input type="number" min={0} placeholder="Qtd" value={e.count ?? ''}
              onChange={ev => updateEqRow(e.id, { count: Number(ev.target.value) })} />
            <Input placeholder="Observação" value={e.notes || ''}
              onChange={ev => updateEqRow(e.id, { notes: ev.target.value })} />
            <Button size="icon" variant="ghost" onClick={() => removeEqRow(e.id)}>
              <Trash2 className="w-4 h-4 text-destructive" />
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
