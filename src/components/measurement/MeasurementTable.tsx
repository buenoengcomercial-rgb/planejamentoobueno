import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Lock } from 'lucide-react';
import type { Project } from '@/types/project';
import type { Row, GroupNode, GroupTotals } from '@/components/measurement/types';
import { fmtBRL } from '@/components/measurement/measurementFormat';
import MeasurementGroupRow from './MeasurementGroupRow';
import type { MeasurementItemRowProps } from './MeasurementItemRow';
import type { MeasurementDetailSelection } from './MeasurementDetailFooter';

type RowHandlers = Omit<MeasurementItemRowProps, 'row' | 'indentPx' | 'G_BG' | 'BORDER_L'>;

interface MeasurementTableProps extends RowHandlers {
  filteredRows: Row[];
  groupTree: GroupNode[];
  totals: GroupTotals;
  collapsed: Set<string>;
  setCollapsed: React.Dispatch<React.SetStateAction<Set<string>>>;
  isLocked: boolean;
  selectedDetail?: MeasurementDetailSelection | null;
  onSelectDetail?: (selection: MeasurementDetailSelection | null) => void;
  project: Project;
  bdi: number;
}

const COLSPAN = 18;

const G_BG = {
  id: 'bg-background',
  contract: 'bg-sky-50/70',
  period: 'bg-emerald-50/70',
  forecast: 'bg-blue-50/70',
  accum: 'bg-amber-50/70',
  balance: 'bg-rose-50/70',
};

const G_HEAD = {
  id: 'bg-slate-100 text-slate-800',
  contract: 'bg-sky-100 text-sky-950',
  period: 'bg-emerald-100 text-emerald-950',
  forecast: 'bg-blue-100 text-blue-950',
  accum: 'bg-amber-100 text-amber-950',
  balance: 'bg-rose-100 text-rose-950',
};

const BORDER_L = 'border-l-2 border-border';

const headerStyleByDepth = (depth: number) => {
  if (depth === 0) return 'chapter-row bg-primary/10 text-foreground font-bold border-y border-primary/30';
  if (depth === 1) return 'chapter-row bg-slate-100/90 text-foreground font-semibold border-y border-border';
  return 'chapter-row bg-slate-50 text-foreground font-semibold border-y border-border';
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
    <Card className="overflow-hidden border border-border bg-card shadow-sm">
      <CardHeader className="border-b border-border bg-muted/20 px-3 py-2 print:hidden">
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
        <div className="max-w-full overflow-x-auto overflow-y-visible print:overflow-visible">
          <table className="measurement-table w-full text-[11px] border-separate border-spacing-0 print:min-w-0">
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
            <thead className="sticky top-0 z-20 shadow-sm">
              <tr>
                <th colSpan={5} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold text-center border-b border-border ${G_HEAD.id}`}>
                  Identificação
                </th>
                <th colSpan={4} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold text-center border-b border-border ${G_HEAD.contract} ${BORDER_L}`}>
                  Contrato
                </th>
                <th colSpan={2} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold text-center border-b border-border ${G_HEAD.period} ${BORDER_L}`}>
                  Medição Atual
                </th>
                <th colSpan={3} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold text-center border-b border-border ${G_HEAD.forecast} ${BORDER_L}`}>
                  Previsão (Gantt)
                </th>
                <th colSpan={2} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold text-center border-b border-border ${G_HEAD.accum} ${BORDER_L}`}>
                  Acumulado
                </th>
                <th colSpan={2} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold text-center border-b border-border ${G_HEAD.balance} ${BORDER_L}`}>
                  Saldo
                </th>
              </tr>
              <tr className="bg-muted/80 text-foreground">
                <th className="px-2 py-1.5 text-left font-semibold border-b border-border">Item</th>
                <th className="px-2 py-1.5 text-center font-semibold border-b border-border">Código</th>
                <th className="px-2 py-1.5 text-center font-semibold border-b border-border">Banco</th>
                <th className="px-2 py-1.5 text-left font-semibold border-b border-border">Descrição</th>
                <th className="px-2 py-1.5 text-center font-semibold border-b border-border cell-und">Und.</th>
                <th className={`px-2 py-1.5 text-right font-semibold border-b border-border ${BORDER_L}`}>Quant. Contrat.</th>
                <th className="px-2 py-1.5 text-right font-semibold border-b border-border">V. Unit. s/ BDI</th>
                <th className="px-2 py-1.5 text-right font-semibold border-b border-border">V. Unit. c/ BDI</th>
                <th className="px-2 py-1.5 text-right font-semibold border-b border-border">Total Contratado</th>
                <th className={`px-2 py-1.5 text-right font-semibold border-b border-border ${BORDER_L}`}>Quant. Medição</th>
                <th className="px-2 py-1.5 text-right font-semibold border-b border-border">Subtotal Medição</th>
                <th className={`px-2 py-1.5 text-right font-semibold border-b border-border ${BORDER_L}`}>Quant. Prevista</th>
                <th className="px-2 py-1.5 text-right font-semibold border-b border-border">Subtotal Previsto</th>
                <th className="px-2 py-1.5 text-right font-semibold border-b border-border">Dif. Real x Prev.</th>
                <th className={`px-2 py-1.5 text-right font-semibold border-b border-border ${BORDER_L}`}>Quant. Acum.</th>
                <th className="px-2 py-1.5 text-right font-semibold border-b border-border">Subtotal Acumulado</th>
                <th className={`px-2 py-1.5 text-right font-semibold border-b border-border ${BORDER_L}`}>Quant. a Executar</th>
                <th className="px-2 py-1.5 text-right font-semibold border-b border-border">Subtotal a Executar</th>
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
                    G_BG={G_BG}
                    BORDER_L={BORDER_L}
                    headerStyleByDepth={headerStyleByDepth}
                    isLocked={isLocked}
                    {...rowHandlers}
                  />
                ))
              )}
            </tbody>
            {groupTree.length > 0 && (
              <tfoot className="sticky bottom-0 z-10">
                <tr className="bg-slate-900 text-white border-t-2 border-slate-900 font-bold">
                  <td colSpan={8} className="px-2 py-2 text-right uppercase tracking-wide">Total Geral</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtBRL(totals.contracted)}</td>
                  <td className={`px-2 py-2 text-right ${BORDER_L}`}>—</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtBRL(totals.period)}</td>
                  <td className={`px-2 py-2 text-right ${BORDER_L}`}>—</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtBRL(totals.forecast)}</td>
                  <td className={`px-2 py-2 text-right tabular-nums ${totals.diffForecast > 0 ? 'text-emerald-300' : totals.diffForecast < 0 ? 'text-rose-300' : ''}`}>{fmtBRL(totals.diffForecast)}</td>
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
