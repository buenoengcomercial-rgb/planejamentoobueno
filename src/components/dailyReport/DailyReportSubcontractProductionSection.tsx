import { HandCoins } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface DailySubcontractProductionEntry {
  allocationId: string;
  contractName: string;
  item: string;
  description: string;
  unit: string;
  quantity: number;
  unitValue: number;
}

export function DailyReportSubcontractProductionSection({ entries }: { entries: DailySubcontractProductionEntry[] }) {
  const total = entries.reduce((sum, entry) => sum + entry.quantity * entry.unitValue, 0);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <HandCoins className="h-4 w-4 text-primary" /> Produção terceirizada do dia
        </CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? <p className="text-sm italic text-muted-foreground">Nenhuma composição terceirizada apontada nesta data.</p> : (
          <div className="space-y-2">
            {entries.map(entry => (
              <div key={`${entry.allocationId}-${entry.item}`} className="grid gap-1 rounded-md border p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-4">
                <div><p className="font-medium">{entry.item} — {entry.description}</p><p className="text-xs text-muted-foreground">Contrato: {entry.contractName}</p></div>
                <p className="tabular-nums text-sm">{entry.quantity.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} {entry.unit} × {entry.unitValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
                <p className="font-semibold tabular-nums text-primary sm:text-right">{(entry.quantity * entry.unitValue).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
              </div>
            ))}
            <div className="flex justify-end border-t pt-2 text-sm"><span className="mr-3 text-muted-foreground">Valor produzido no dia</span><strong className="tabular-nums">{total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</strong></div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
