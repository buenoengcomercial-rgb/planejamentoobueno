import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Lock } from 'lucide-react';
import type { Row, GroupNode, GroupTotals } from '@/components/measurement/types';
import { fmtBRL } from '@/components/measurement/measurementFormat';
import MeasurementGroupRow from './MeasurementGroupRow';
import type { MeasurementItemRowProps } from './MeasurementItemRow';

type RowHandlers = Omit<MeasurementItemRowProps, 'row' | 'indentPx' | 'G_BG' | 'BORDER_L'>;

interface MeasurementTableProps extends RowHandlers {
  filteredRows: Row[];
  groupTree: GroupNode[];
  totals: GroupTotals;
  collapsed: Set<string>;
  setCollapsed: React.Dispatch<React.SetStateAction<Set<string>>>;
  isLocked: boolean;
}

const COLSPAN = 18;

// Cores por grupo (tokens semânticos)
const G_BG = {
  id: 'bg-muted/40',                 // Identificação
  contract: 'bg-info/10',            // Contrato
  period: 'bg-success/10',           // Medição atual
  forecast: 'bg-accent/20',          // Previsão (Gantt)
  accum: 'bg-warning/10',            // Acumulado
  balance: 'bg-destructive/10',      // Saldo
};
const G_HEAD = {
  id: 'bg-muted text-foreground',
  contract: 'bg-info/20 text-foreground',
  period: 'bg-success/20 text-foreground',
  forecast: 'bg-accent/40 text-foreground',
  accum: 'bg-warning/20 text-foreground',
  balance: 'bg-destructive/15 text-foreground',
};
const BORDER_L = 'border-l-2 border-border';

const headerStyleByDepth = (depth: number) => {
  if (depth === 0) return 'bg-primary/10 text-foreground font-bold border-y-2 border-primary/40';
  if (depth === 1) return 'bg-muted/70 text-foreground font-semibold border-y border-border';
  return 'bg-muted/40 text-foreground font-semibold border-y border-border';
};
const subtotalStyleByDepth = (depth: number) => {
  if (depth === 0) return 'bg-primary/5 border-y border-primary/30 font-bold';
  if (depth === 1) return 'bg-muted/50 border-y border-border font-semibold';
  return 'bg-muted/30 border-y border-border font-semibold';
};

export default function MeasurementTable(props: MeasurementTableProps) {
  const {
    filteredRows, groupTree, totals,
    collapsed, setCollapsed, isLocked,
    ...rowHandlers
  } = props;

  const toggleCollapsed = (id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3 print:hidden">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          Planilha de medição ({filteredRows.length} itens)
          {isLocked && (
            <span className="text-[10px] font-normal text-muted-foreground flex items-center gap-1">
              <Lock className="w-3 h-3" /> somente leitura
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 overflow-hidden">
        <div className="overflow-x-auto max-w-full print:overflow-visible">
          <table className="measurement-table w-full text-[11px] border-collapse print:min-w-0">
            <colgroup>
              <col className="col-item" />
              <col className="col-code" />
              <col className="col-bank" />
              <col className="col-desc" />
              <col className="col-und" />
              <col className="col-qty" />
              <col className="col-val" />
              <col className="col-val" />
              <col className="col-val" />
              <col className="col-qty" />
              <col className="col-val" />
              <col className="col-qty" />
              <col className="col-val" />
              <col className="col-val" />
              <col className="col-qty" />
              <col className="col-val" />
              <col className="col-qty" />
              <col className="col-val" />
            </colgroup>
            <thead className="sticky top-0 z-10">
              {/* Linha de grupos coloridos */}
              <tr>
                <th colSpan={5} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold ${G_HEAD.id}`}>
                  Identificação
                </th>
                <th colSpan={4} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold ${G_HEAD.contract} ${BORDER_L}`}>
                  Contrato
                </th>
                <th colSpan={2} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold ${G_HEAD.period} ${BORDER_L}`}>
                  Medição Atual
                </th>
                <th colSpan={3} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold ${G_HEAD.forecast} ${BORDER_L}`}>
                  Previsão (Gantt)
                </th>
                <th colSpan={2} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold ${G_HEAD.accum} ${BORDER_L}`}>
                  Acumulado
                </th>
                <th colSpan={2} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold ${G_HEAD.balance} ${BORDER_L}`}>
                  Saldo
                </th>
              </tr>
              <tr className="bg-foreground text-background">
                {/* Identificação */}
                <th className="px-2 py-2 text-left font-semibold">Item</th>
                <th className="px-2 py-2 text-center font-semibold">Código</th>
                <th className="px-2 py-2 text-center font-semibold">Banco</th>
                <th className="px-2 py-2 text-left font-semibold">Descrição</th>
                <th className="px-2 py-2 text-center font-semibold cell-und">Und.</th>
                {/* Contrato */}
                <th className={`px-2 py-2 text-right font-semibold ${BORDER_L}`}>Quant. Contrat.</th>
                <th className="px-2 py-2 text-right font-semibold">V. Unit. s/ BDI</th>
                <th className="px-2 py-2 text-right font-semibold">V. Unit. c/ BDI</th>
                <th className="px-2 py-2 text-right font-semibold">Total Contratado</th>
                {/* Medição atual */}
                <th className={`px-2 py-2 text-right font-semibold ${BORDER_L}`}>Quant. Medição</th>
                <th className="px-2 py-2 text-right font-semibold">Subtotal Medição</th>
                {/* Previsão */}
                <th className={`px-2 py-2 text-right font-semibold ${BORDER_L}`}>Quant. Prevista</th>
                <th className="px-2 py-2 text-right font-semibold">Subtotal Previsto</th>
                <th className="px-2 py-2 text-right font-semibold">Dif. Real x Prev.</th>
                {/* Acumulado */}
                <th className={`px-2 py-2 text-right font-semibold ${BORDER_L}`}>Quant. Acum.</th>
                <th className="px-2 py-2 text-right font-semibold">Subtotal Acumulado</th>
                {/* Saldo */}
                <th className={`px-2 py-2 text-right font-semibold ${BORDER_L}`}>Quant. a Executar</th>
                <th className="px-2 py-2 text-right font-semibold">Subtotal a Executar</th>
              </tr>
            </thead>
            <tbody>
              {groupTree.length === 0 ? (
                <tr>
                  <td colSpan={COLSPAN} className="text-center py-8 text-muted-foreground">
                    Nenhum item encontrado para os filtros selecionados.
                  </td>
                </tr>
              ) : (
                groupTree.map(g => (
                  <MeasurementGroupRow
                    key={g.phaseId}
                    group={g}
                    collapsed={collapsed}
                    toggleCollapsed={toggleCollapsed}
                    COLSPAN={COLSPAN}
                    G_BG={G_BG}
                    BORDER_L={BORDER_L}
                    headerStyleByDepth={headerStyleByDepth}
                    subtotalStyleByDepth={subtotalStyleByDepth}
                    isLocked={isLocked}
                    {...rowHandlers}
                  />
                ))
              )}
            </tbody>
            {groupTree.length > 0 && (
              <tfoot>
                <tr className="bg-foreground text-background border-t-2 border-foreground font-bold">
                  <td colSpan={8} className="px-2 py-2 text-right uppercase tracking-wide">Total Geral</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtBRL(totals.contracted)}</td>
                  <td className={`px-2 py-2 text-right ${BORDER_L}`}>—</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtBRL(totals.period)}</td>
                  <td className={`px-2 py-2 text-right ${BORDER_L}`}>—</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtBRL(totals.forecast)}</td>
                  <td className={`px-2 py-2 text-right tabular-nums ${totals.diffForecast > 0 ? 'text-success' : totals.diffForecast < 0 ? 'text-destructive' : ''}`}>{fmtBRL(totals.diffForecast)}</td>
                  <td className={`px-2 py-2 text-right ${BORDER_L}`}>—</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtBRL(totals.accum)}</td>
                  <td className={`px-2 py-2 text-right ${BORDER_L}`}>—</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtBRL(totals.balance)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
