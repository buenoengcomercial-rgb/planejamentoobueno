import { PackageCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Project } from '@/types/project';
import { formatBR } from '@/components/dailyReport/dailyReportFormat';
import { warehouseWithdrawalsForDate } from '@/lib/dailyReportWarehouse';

export function DailyReportWarehouseSection({ project, selectedDate }: { project: Project; selectedDate: string }) {
  const withdrawals = warehouseWithdrawalsForDate(project, selectedDate);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <PackageCheck className="h-4 w-4 text-success" />
          Materiais retirados no dia ({formatBR(selectedDate)})
        </CardTitle>
        <p className="text-xs text-muted-foreground">Leitura automática do Almoxarifado confirmado; editar o Diário não altera estas baixas.</p>
      </CardHeader>
      <CardContent>
        {withdrawals.length === 0 ? (
          <p className="py-3 text-sm italic text-muted-foreground">Nenhuma retirada confirmada nesta data.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="p-2">Requisição</th><th className="p-2">Recebedor</th><th className="p-2">Destino</th><th className="p-2">Material</th><th className="p-2 text-right">Quantidade</th></tr></thead>
              <tbody>{withdrawals.map(row => <tr key={row.movementId} className="border-b last:border-0"><td className="p-2 font-mono font-semibold">{row.requisitionNumber}</td><td className="p-2">{row.receiverName}</td><td className="p-2">{row.destination}</td><td className="p-2">{row.description}</td><td className="p-2 text-right font-mono font-semibold">{row.quantity.toLocaleString('pt-BR')} {row.unit}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
