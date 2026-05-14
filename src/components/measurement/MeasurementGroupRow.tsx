import { Fragment } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { GroupNode } from '@/components/measurement/types';
import { fmtBRL } from '@/components/measurement/measurementFormat';
import MeasurementItemRow, { type MeasurementItemRowProps } from './MeasurementItemRow';

type RowHandlers = Omit<MeasurementItemRowProps, 'row' | 'indentPx' | 'G_BG' | 'BORDER_L'>;

interface MeasurementGroupRowProps extends RowHandlers {
  group: GroupNode;
  collapsed: Set<string>;
  toggleCollapsed: (id: string) => void;
  COLSPAN: number;
  G_BG: MeasurementItemRowProps['G_BG'];
  BORDER_L: string;
  headerStyleByDepth: (depth: number) => string;
  subtotalStyleByDepth: (depth: number) => string;
}

export default function MeasurementGroupRow(props: MeasurementGroupRowProps) {
  const {
    group: g,
    collapsed,
    toggleCollapsed,
    COLSPAN,
    G_BG,
    BORDER_L,
    headerStyleByDepth,
    subtotalStyleByDepth,
    ...rowHandlers
  } = props;

  const indentPx = g.depth * 14;
  const isCollapsed = collapsed.has(g.phaseId);

  return (
    <Fragment>
      {/* Cabeçalho do grupo */}
      <tr className={headerStyleByDepth(g.depth)}>
        <td colSpan={COLSPAN} className="px-2 py-1.5">
          <button
            type="button"
            onClick={() => toggleCollapsed(g.phaseId)}
            className="inline-flex items-center gap-1 hover:opacity-80 print-hide"
            style={{ paddingLeft: indentPx }}
          >
            {isCollapsed
              ? <ChevronRight className="w-3.5 h-3.5" />
              : <ChevronDown className="w-3.5 h-3.5" />}
            <span className="font-mono tabular-nums">{g.number}</span>
            <span className="ml-1 uppercase tracking-wide">{g.name}</span>
          </button>
          <span className="hidden print:inline font-mono tabular-nums" style={{ paddingLeft: indentPx }}>
            {g.number} {g.name}
          </span>
        </td>
      </tr>

      {/* Filhos: itens + subgrupos (recursivo) */}
      {!isCollapsed && (
        <Fragment>
          {g.rows.map(r => (
            <MeasurementItemRow
              key={r.taskId}
              row={r}
              indentPx={indentPx}
              G_BG={G_BG}
              BORDER_L={BORDER_L}
              {...rowHandlers}
            />
          ))}
          {g.children.map(child => (
            <MeasurementGroupRow
              key={child.phaseId}
              group={child}
              collapsed={collapsed}
              toggleCollapsed={toggleCollapsed}
              COLSPAN={COLSPAN}
              G_BG={G_BG}
              BORDER_L={BORDER_L}
              headerStyleByDepth={headerStyleByDepth}
              subtotalStyleByDepth={subtotalStyleByDepth}
              {...rowHandlers}
            />
          ))}
        </Fragment>
      )}

      {/* Subtotal do grupo */}
      <tr className={subtotalStyleByDepth(g.depth)}>
        <td colSpan={8} className="px-2 py-1.5 text-right text-foreground border-t-2 border-border">
          <span style={{ paddingLeft: indentPx }}>
            Subtotal {g.number} — {g.name}
          </span>
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-foreground border-t-2 border-border">
          {fmtBRL(g.totals.contracted)}
        </td>
        <td className={`px-2 py-1.5 text-right tabular-nums text-foreground border-t-2 border-border ${BORDER_L}`}>—</td>
        <td className="px-2 py-1.5 text-right tabular-nums text-foreground border-t-2 border-border">
          {fmtBRL(g.totals.period)}
        </td>
        <td className={`px-2 py-1.5 text-right tabular-nums text-foreground border-t-2 border-border ${BORDER_L}`}>—</td>
        <td className="px-2 py-1.5 text-right tabular-nums text-foreground border-t-2 border-border">
          {fmtBRL(g.totals.forecast)}
        </td>
        <td className={`px-2 py-1.5 text-right tabular-nums border-t-2 border-border ${g.totals.diffForecast > 0 ? 'text-success' : g.totals.diffForecast < 0 ? 'text-destructive' : 'text-foreground'}`}>
          {fmtBRL(g.totals.diffForecast)}
        </td>
        <td className={`px-2 py-1.5 text-right tabular-nums text-foreground border-t-2 border-border ${BORDER_L}`}>—</td>
        <td className="px-2 py-1.5 text-right tabular-nums text-foreground border-t-2 border-border">
          {fmtBRL(g.totals.accum)}
        </td>
        <td className={`px-2 py-1.5 text-right tabular-nums text-foreground border-t-2 border-border ${BORDER_L}`}>—</td>
        <td className="px-2 py-1.5 text-right tabular-nums text-foreground border-t-2 border-border">
          {fmtBRL(g.totals.balance)}
        </td>
      </tr>
    </Fragment>
  );
}
